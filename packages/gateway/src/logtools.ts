import type { LogStore } from "./log.ts";
import type { ModelCache } from "./cache.ts";

/** Log tools usable by chat/minion tool loops. */
export function logToolDefs(store: LogStore) {
  return {
    tailTool: {
      name: "logs.tail",
      description: "Read the newest structured gateway log entries. Args: {limit?, level? (debug|info|warn|error), module?, q?}. Returns entries newest-first.",
      run: async (a: { limit?: number; level?: "debug" | "info" | "warn" | "error"; module?: string; q?: string }) =>
        store.tail({ limit: a?.limit ?? 80, level: a?.level, module: a?.module, q: a?.q }),
    },
    statsTool: {
      name: "logs.stats",
      description: "Summarize the last 24h of logs: error/warn counts, last error, file count.",
      run: async () => store.stats(),
    },
  };
}

const RESOLVE_PROMPT = "You are the O-Harness error resolver. You receive recent gateway log entries and a request. "
  + "Explain in plain language (same language as the request) what went wrong, the root cause, and the concrete fix. "
  + "You may read files to confirm. Do NOT edit any files. End with a short checklist to apply the fix.";

/** Ask the default model to analyze an error context (read-only, no edits). */
export async function resolveLogs(
  store: LogStore,
  chatOnceFn: (p: { baseUrl: string; apiKey?: string; model: string; effort?: string; messages: { role: string; content: string }[] }) => Promise<any>,
  settings: { resolveDefault(): { baseUrl: string; apiKey?: string; model: { id: string } } | undefined },
  opts?: { q?: string; level?: "debug" | "info" | "warn" | "error" },
  cache?: ModelCache,
): Promise<{ analysis: string; entryCount: number }> {
  const def = settings.resolveDefault();
  if (!def) throw new Error("no default model configured");
  const { entries, total } = store.tail({ limit: 120, level: opts?.level ?? "warn", q: opts?.q });
  const digest = entries.slice(0, 80).map((e) => JSON.stringify(e)).join("\n");
  const messages = [
    { role: "system", content: RESOLVE_PROMPT },
    { role: "user", content: (opts?.q ? "Focus: " + opts.q + "\n" : "") + "Recent errors/warnings (" + total + " matched, " + entries.length + " shown newest-first):\n" + digest },
  ];
  const call = () => chatOnceFn({ baseUrl: def.baseUrl, apiKey: def.apiKey, model: def.model.id, effort: "low", messages });
  const bust = String(total) + ":" + (entries[0] ? String(entries[0].ts) : "");
  const out = cache ? await cache.wrap({ model: def.model.id, messages, effort: "low", cacheBust: bust }, call) : await call();
  const analysis = String(out?.choices?.[0]?.message?.content ?? "").trim();
  return { analysis, entryCount: entries.length };
}