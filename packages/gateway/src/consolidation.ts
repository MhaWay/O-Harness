// Memory consolidation: cluster active memories by subject+lexical overlap, ask the model
// to merge/correct each cluster, then ADD the merged memory with supersede links (Mem0 rule:
// never mutate text, stamp supersededBy + validUntil on the older ones).
import type { MemoryStore } from "@o-harness/core";
import type { SettingsStore } from "./models.ts";
import { chatOnce } from "./models.ts";

export interface ConsolidateOptions { subject?: string; dryRun?: boolean; maxClusters?: number }
export interface ClusterReport { subject: string; ids: string[]; texts: string[]; merged?: string; addedId?: string }
export interface ConsolidateReport { clusters: ClusterReport[]; memoriesChecked: number }

const SIM_THRESHOLD = 0.25;

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

/** Greedy single-pass clustering: each memory joins the best-matching cluster with enough overlap. */
export function clusterMemories(mems: { id: string; subject: string; text: string }[]): Map<string, { id: string; subject: string; text: string }[]> {
  const clusters = new Map<string, { id: string; subject: string; text: string }[]>();
  const tok = new Map<string, Set<string>>();
  for (const m of mems) {
    const t = tokens((m.subject + " " + m.text).toLowerCase());
    let bestKey: string | undefined;
    let bestSim = 0;
    for (const [key, list] of clusters) {
      const rep = list[0];
      const rt = tok.get(rep.id);
      if (!rt) continue;
      const sim = jaccard(t, rt);
      if (sim > bestSim) { bestSim = sim; bestKey = key; }
    }
    if (bestKey && bestSim >= SIM_THRESHOLD) clusters.get(bestKey)!.push(m);
    else { clusters.set(m.id, [m]); tok.set(m.id, t); }
  }
  return clusters;
}

const MERGE_SYSTEM = "You consolidate agent memories. Given a list of similar memories (id + text + date), output strict JSON: {merge: bool, text: string}. If the memories contradict, keep only the newer/corrected fact. If they are about different things (false positives), merge=false. If they add detail to each other, merge=true and write ONE concise updated memory that preserves every distinct fact. No markdown, no explanation. Output keys merge (boolean) and text (string).";

export class MemoryConsolidator {
  memory: MemoryStore;
  settings: SettingsStore;
  constructor(memory: MemoryStore, settings: SettingsStore) { this.memory = memory; this.settings = settings; }

  async consolidate(opts: ConsolidateOptions = {}): Promise<ConsolidateReport> {
    const active = this.memory.list({ subject: opts.subject, validity: "now" });
    const clusters = [...clusterMemories(active).values()].filter((c) => c.length >= 2).slice(0, opts.maxClusters ?? 20);
    const resolved = this.settings.resolveDefault();
    const report: ConsolidateReport = { clusters: [], memoriesChecked: active.length };
    for (const cluster of clusters) {
      const item: ClusterReport = { subject: cluster[0].subject, ids: cluster.map((m) => m.id), texts: cluster.map((m) => m.text) };
      report.clusters.push(item);
      if (!resolved) continue;
      const list = cluster.map((m) => "- " + m.id + " " + m.text + " | " + new Date(m.createdAt ?? Date.now()).toISOString().slice(0, 10)).join(String.fromCharCode(10));
      try {
        const out = await chatOnce({
          baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model.id, effort: "low",
          messages: [{ role: "system", content: MERGE_SYSTEM }, { role: "user", content: "Memories:" + String.fromCharCode(10) + list }],
        });
        const raw = String(out.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
        const j = JSON.parse(raw) as { merge?: boolean; text?: string };
        if (j.merge && j.text) {
          item.merged = j.text;
          if (!opts.dryRun) {
            const added = this.memory.add(
              { text: j.text, subject: cluster[0].subject, layer: "knowledge", importance: Math.max(...cluster.map((m) => m.importance ?? 0.5)), tags: ["consolidated"], provenance: "consolidator" },
              { supersedeIds: cluster.map((m) => m.id) },
            );
            item.addedId = added.id;
          }
        }
      } catch { /* model hiccup: report cluster without merge */ }
    }
    return report;
  }
}
