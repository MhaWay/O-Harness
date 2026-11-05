import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { atomicWrite } from "@o-harness/core";
import { join } from "node:path";

export type Effort = "none" | "low" | "medium" | "xhigh";
export const EFFORTS: Effort[] = ["none", "low", "medium", "xhigh"];

export interface ModelEntry {
  id: string;
  label?: string;
  reasoningEfforts?: Effort[];
  extra?: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ModelEntry[];
  extra?: Record<string, unknown>;
}

export interface Settings {
  providers: ProviderConfig[];
  default?: { providerId: string; modelId: string; effort?: Effort };
  allowSelfUpdate?: boolean;
  repoDir?: string;
}

export function defaultRepoDir(): string {
  try {
    const here = new URL("../src/agent.ts", import.meta.url); // not used, kept for docs
  } catch { /* noop */ }
  return process.env.OHARNESS_HOME ?? "/root/Projects/O-Harness";
}

function seed(): Settings {
  // The model I currently run on: qwen3.8-flash-next-a5b, vllm OpenAI-compatible API on this machine.
  return {
    providers: [{
      id: "spark-local",
      name: "Spark (local vllm)",
      baseUrl: "http://127.0.0.1:8000/v1",
      models: [{ id: "qwen3.8-flash-next-a5b", reasoningEfforts: [...EFFORTS] }],
      extra: {},
    }],
    default: { providerId: "spark-local", modelId: "qwen3.8-flash-next-a5b", effort: "none" },
    allowSelfUpdate: true,
    repoDir: defaultRepoDir(),
  };
}

export class SettingsStore {
  #path: string;
  #settings: Settings;
  constructor(dir: string) {
    this.#path = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#settings = this.#load();
  }
  #load(): Settings {
    try {
      const j = JSON.parse(readFileSync(this.#path, "utf-8"));
      if (Array.isArray(j.providers)) return { ...seed(), ...j };
    } catch { /* first run */ }
    const s = seed();
    this.#persist(s);
    return s;
  }
  #persist(s: Settings) {
    atomicWrite(this.#path, JSON.stringify(s, null, 2), 0o600);
  }
  get(): Settings { return this.#settings; }
  save(s: Settings) { this.#settings = s; this.#persist(s); }
  upsertProvider(p: ProviderConfig) {
    const s = this.#settings;
    const i = s.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) s.providers[i] = p; else s.providers.push(p);
    this.save(s);
  }
  removeProvider(id: string) {
    const s = this.#settings;
    s.providers = s.providers.filter((x) => x.id !== id);
    if (s.default?.providerId === id) delete s.default;
    this.save(s);
  }
  resolveDefault(): { provider: ProviderConfig; model: ModelEntry; baseUrl: string; apiKey?: string; effort: Effort } | undefined {
    const s = this.#settings;
    if (!s.default) return undefined;
    const provider = s.providers.find((p) => p.id === s.default!.providerId);
    const model = provider?.models.find((m) => m.id === s.default!.modelId);
    if (!provider || !model) return undefined;
    return { provider, model, baseUrl: provider.baseUrl, apiKey: provider.apiKey, effort: s.default.effort ?? "none" };
  }
  resolveRef(providerId: string, modelId: string) {
    const provider = this.#settings.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    return provider && model ? { provider, model } : undefined;
  }
}

/** Fetch model ids from an OpenAI-compatible endpoint (also handles routers that expose /api/... paths). */
export async function fetchProviderModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const candidates: string[] = [];
  if (/\/(v1|api)$/i.test(base)) candidates.push(base + "/models");
  else { candidates.push(base + "/models"); candidates.push(base + "/v1/models"); }
  const seen = new Set<string>();
  let lastErr = "";
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { ...(apiKey ? { authorization: "Bearer " + apiKey } : {}) }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) { lastErr = url + " -> HTTP " + res.status; continue; }
      const j: any = await res.json();
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
      for (const m of arr) { const id = typeof m === "string" ? m : m?.id; if (id) seen.add(String(id)); }
      if (seen.size) return [...seen];
      lastErr = url + " -> no model ids in response";
    } catch (e) {
      lastErr = url + " -> " + String(e);
    }
  }
  throw new Error("no models fetched: " + lastErr);
}

/** Minimal one-shot chat request (validation/test), returns assistant text. */
export async function chatOnce(opts: { baseUrl: string; apiKey?: string; model: string; messages: unknown[]; effort?: Effort; extra?: Record<string, unknown>; tools?: unknown[] }): Promise<any> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    ...(opts.effort && opts.effort !== "none" ? { reasoning_effort: opts.effort } : {}),
    ...opts.extra,
    ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
  };
  const base = opts.baseUrl.replace(/\/+$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: "Bearer " + opts.apiKey } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error("chat/completions HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  return await res.json();
}


/** Streaming chatOnce: consumes SSE chunks, calls onToken for each content delta, returns the same shape as chatOnce. */
export async function chatOnceStream(opts: { baseUrl: string; apiKey?: string; model: string; messages: unknown[]; effort?: Effort; extra?: Record<string, unknown>; tools?: unknown[]; signal?: AbortSignal }, onToken?: (tok: string, reasoning?: boolean) => void): Promise<any> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.effort && opts.effort !== "none" ? { reasoning_effort: opts.effort } : {}),
    ...opts.extra,
    ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
  };
  const base = opts.baseUrl.replace(/\/+$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: "Bearer " + opts.apiKey } : {}) },
    body: JSON.stringify(body),
    signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(180_000), opts.signal]) : AbortSignal.timeout(180_000),
  });
  if (!res.ok || !res.body) throw new Error("chat/completions HTTP " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolAcc: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
  for await (const chunk of res.body as ReadableStream<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: any;
      try { j = JSON.parse(data); } catch { continue; }
      const d = j?.choices?.[0]?.delta ?? {};
      if (typeof d.content === "string" && d.content) { content += d.content; onToken?.(d.content, false); }
      else {
        const rtext = typeof d.reasoning === "string" ? d.reasoning : typeof d.reasoning_content === "string" ? d.reasoning_content : "";
        if (rtext) onToken?.(rtext, true);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = Number(tc.index ?? 0);
          if (!toolAcc[idx]) toolAcc[idx] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolAcc[idx].id = tc.id;
          if (tc.function?.name) toolAcc[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolAcc[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  const toolCalls = toolAcc.filter(Boolean);
  return { choices: [{ message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
}

