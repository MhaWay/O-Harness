import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "./jsonfile.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * O-Harness memory layer.
 *
 * Design, modeled on the most popular memory plugins (researched 2026-11):
 * - Mem0 (2026 algorithm): ADD-only accumulation — facts are never overwritten or deleted;
 *   staleness is handled by temporal validity + retrieval ranking, not mutation.
 * - Zep: bitemporal records — validFrom / validUntil; a query "now" or at any past instant returns
 *   the valid instance, past events return superseded ones.
 * - Letta (MemGPT): memory "slots" — an agent-editable core block (persona/task) alongside the
 *   searchable pool.
 * Retrieval is BM25 (deterministic, zero-dependency) fused with exact-phrase, recency and importance
 * signals; embeddings can plug into the same interface later (score is a weighted sum).
 */

export interface Memory {
  id: string;
  /** Stable subject the fact is about: user, project, repo, a person, a component… */
  subject: string;
  /** The fact itself (one concise sentence). */
  text: string;
  /** Tags for routing / capability suggestions, e.g. "decision", "user:pref", "cap:deploy". */
  tags: string[];
  /** Free-text entity names extracted for linking (names, paths, tools). */
  entities: string[];
  /** Layer for coarse routing: anchor | structural | knowledge | contextual | self. */
  layer: string;
  /** 0..1 */
  importance: number;
  /** Bitemporal validity (Zep-style). validUntil undefined = open-ended. */
  validFrom: number;
  validUntil?: number;
  createdAt: number;
  /** Source of truth, e.g. "agent:main", "user", "session:main#12". */
  provenance: string;
  /** True if a later memory superseded it (kept for history, excluded from "now" reads). */
  supersededBy?: string;
}

export interface MemorySearchOptions {
  query?: string;
  subject?: string;
  tags?: string[];
  layer?: string;
  /** Only memories whose validity overlaps this instant. Default: now. */
  at?: number;
  /** "now" (default) = exclude superseded + expired; "history" = include them (read-only). */
  validity?: "now" | "history";
  limit?: number;
}

export interface MemoryHit {
  memory: Memory;
  score: number;
  signals: { lexical: number; recency: number; importance: number; exactPhrase: number };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

/** BM25 over an in-memory corpus (k1=1.2, b=0.75) — same lexical signal Mem0 fuses with vectors. */
function bm25(queryTokens: string[], docs: string[][]): number[] {
  const k1 = 1.2, b = 0.75;
  const n = docs.length;
  const avgLen = n ? docs.reduce((s, d) => s + d.length, 0) / n : 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.length / avgLen)));
    }
    return score;
  });
}

const RECENCY_HALF_LIFE_MS = 30 * 24 * 3600_000;

export class MemoryStore {
  #dir: string;
  #mems = new Map<string, Memory>();

  constructor(dir: string) {
    this.#dir = join(dir, "memory");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.#dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(this.#dir, f), "utf-8")) as Memory;
        if (m && typeof m.id === "string" && typeof m.text === "string") this.#mems.set(m.id, m);
      } catch { /* skip corrupt */ }
    }
  }

  #persist(m: Memory) {
    atomicWrite(join(this.#dir, m.id + ".json"), JSON.stringify(m, null, 2), 0o600);
  }

  /**
   * ADD-only write (Mem0 rule): nothing is mutated or overwritten on conflict.
   * Pass supersedeIds to link older memories this new one replaces — they stay readable with
   * validity:"history", get supersededBy + validUntil stamped.
   */
  add(
    partial: Partial<Omit<Memory, "id" | "createdAt">> & Pick<Memory, "text">,
    opts: { supersedeIds?: string[] } = {},
  ): Memory {
    const now = Date.now();
    const m: Memory = {
      id: partial.id ?? randomUUID().slice(0, 12),
      subject: partial.subject ?? "general",
      text: partial.text,
      tags: partial.tags ?? [],
      entities: partial.entities ?? [],
      layer: partial.layer ?? "knowledge",
      importance: Math.max(0, Math.min(1, partial.importance ?? 0.5)),
      validFrom: partial.validFrom ?? now,
      ...(partial.validUntil ? { validUntil: partial.validUntil } : {}),
      createdAt: now,
      provenance: partial.provenance ?? "unknown",
    };
    this.#mems.set(m.id, m);
    this.#persist(m);
    for (const id of opts.supersedeIds ?? []) {
      const old = this.#mems.get(id);
      if (old && !old.supersededBy) {
        old.supersededBy = m.id;
        if (old.validUntil === undefined) old.validUntil = now;
        this.#persist(old);
      }
    }
    return m;
  }

  get(id: string): Memory | undefined { return this.#mems.get(id); }

  list(filter: { subject?: string; layer?: string; validity?: "now" | "history" } = {}): Memory[] {
    const now = Date.now();
    const hist = filter.validity === "history";
    return [...this.#mems.values()]
      .filter((m) => !filter.subject || m.subject === filter.subject)
      .filter((m) => !filter.layer || m.layer === filter.layer)
      .filter((m) => hist || (m.validFrom <= now && (m.validUntil === undefined || m.validUntil > now)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Hybrid retrieval: BM25 lex + exact-phrase bonus + recency + importance, validity-filtered. */
  search(opts: MemorySearchOptions): MemoryHit[] {
    const at = opts.at ?? Date.now();
    const hist = opts.validity === "history";
    let pool = [...this.#mems.values()];
    if (opts.subject) pool = pool.filter((m) => m.subject === opts.subject);
    if (opts.layer) pool = pool.filter((m) => m.layer === opts.layer);
    if (opts.tags?.length) pool = pool.filter((m) => m.tags.some((t) => opts.tags!.includes(t)));
    // temporal window: visible iff validity covers at. Superseded records carry validUntil =
    // the supersession time, so invisible 'now' but visible at a past instant.
    pool = pool.filter((m) => (hist ? m.validFrom <= at : m.validFrom <= at && (m.validUntil === undefined || m.validUntil > at)));
    if (!pool.length) return [];
    const limit = opts.limit ?? 10;

    let lexical: number[];
    let exact: number[];
    if (opts.query) {
      const q = tokenize(opts.query);
      const docs = pool.map((m) => [...tokenize(m.text), ...tokenize(m.subject + " " + m.tags.join(" ") + " " + m.entities.join(" "))]);
      lexical = bm25(q, docs);
      const ql = opts.query.toLowerCase();
      exact = pool.map((m) => (m.text.toLowerCase().includes(ql) ? 1 : 0));
    } else {
      lexical = pool.map(() => 0);
      exact = pool.map(() => 0);
    }
    const maxLex = Math.max(1, ...lexical);
    const hits = pool.map((m, i) => {
      const ageMs = Math.max(0, at - m.createdAt);
      const recency = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
      const lex = lexical[i] / maxLex;
      const score = 0.55 * lex + 0.2 * recency + 0.15 * m.importance + 0.1 * exact[i];
      return { memory: m, score, signals: { lexical: lex, recency, importance: m.importance, exactPhrase: exact[i] } };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
