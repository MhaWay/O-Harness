import { randomUUID } from "node:crypto";
import { chatOnce } from "./models.ts";
import type { SettingsStore, Effort } from "./models.ts";
import type { SessionsStore } from "@o-harness/core";
import type { MemoryStore } from "@o-harness/core";

/** Minions: sub-agent sessions that act as employees. The main dispatches a task,
 *  the minion runs a tool-calling loop (exec / fs / memory) until it finishes or gives up. */

export interface MinionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any, ctx: MinionCtx) => Promise<unknown>;
}

export interface MinionCtx {
  minion: Minion;
  api: {
    callDevice: (deviceId: string, method: string, params?: unknown) => Promise<unknown>;
    memorySearch: (p: { query?: string; subject?: string; limit?: number }) => unknown[];
    memoryAdd: (p: { text: string; subject?: string; tags?: string[] }) => unknown;
    sessionsAppend: (id: string, entry: { ts: number; from: string; kind: string; data: unknown }) => unknown;
  };
  log: (kind: string, data: unknown) => void;
  signal?: AbortSignal;
}

export interface Minion {
  id: string;
  title: string;
  task: string;
  status: "queued" | "running" | "done" | "error" | "killed";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId: string;
  model?: string;
  effort?: Effort;
  maxTurns: number;
  turnsUsed: number;
  result?: string;
  error?: string;
}

export interface AgentsOptions {
  settings: SettingsStore;
  sessions: SessionsStore;
  memory: MemoryStore;
  callDevice: (deviceId: string, method: string, params?: unknown) => Promise<unknown>;
  onChange: (m: Minion) => void;
  concurrency?: number;
}

const SYSTEM_PROMPT = "You are an O-Harness minion: an autonomous sub-agent working one delegated task. " +
  "Use tools to investigate and act; prefer minimal safe commands. When the task is complete, write a short final answer " +
  "as plain text (this becomes your result). If you need user memory/facts, search memory first. Do not ask questions; decide and act.";

const BASE_TOOLS: MinionTool[] = [
  {
    name: "exec",
    description: "Run a shell command on the target device (local unless deviceId given). Returns {code, stdout, stderr}.",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, deviceId: { type: "string" } }, required: ["command"] },
    run: async (a, ctx) => await ctx.api.callDevice(a.deviceId ?? "local", "exec", { command: a.command, cwd: a.cwd }),
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file from the target device.",
    parameters: { type: "object", properties: { path: { type: "string" }, deviceId: { type: "string" } }, required: ["path"] },
    run: async (a, ctx) => await ctx.api.callDevice(a.deviceId ?? "local", "fs.read", { path: a.path }),
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file on the target device (creates parent dirs).",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, deviceId: { type: "string" } }, required: ["path", "content"] },
    run: async (a, ctx) => await ctx.api.callDevice(a.deviceId ?? "local", "fs.write", { path: a.path, content: a.content }),
  },
  {
    name: "memory_search",
    description: "Search project/user memory for relevant durable facts. Returns list with id/subject/text/score.",
    parameters: { type: "object", properties: { query: { type: "string" }, subject: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    run: async (a, ctx) => ctx.api.memorySearch({ query: a.query, subject: a.subject, limit: a.limit ?? 5 }),
  },
  {
    name: "memory_add",
    description: "Store a durable fact learned during this task (what you did, decisions, findings) into memory.",
    parameters: { type: "object", properties: { text: { type: "string" }, subject: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["text"] },
    run: async (a, ctx) => ctx.api.memoryAdd({ text: a.text, subject: a.subject ?? "project:O-Harness", tags: a.tags }),
  },
];

export class AgentRuntime {
  #opts: Required<Omit<AgentsOptions, "concurrency">> & { concurrency: number };
  #minions = new Map<string, Minion>();
  #queue: Minion[] = [];
  #running = 0;
  #ac = new Map<string, AbortController>();
  #maxIdleMs = 5 * 60_000; // keep memory of finished minions, prune via list filter

  constructor(opts: AgentsOptions) {
    this.#opts = { concurrency: 2, ...opts } as any;
  }

  spawn(task: string, opts: { title?: string; model?: string; effort?: Effort; maxTurns?: number } = {}): Minion {
    const id = randomUUID().slice(0, 8);
    const session = this.#opts.sessions.create(opts.title || task.slice(0, 60) || "minion", id);
    const m: Minion = {
      id, title: opts.title || task.slice(0, 60) || "minion", task,
      status: "queued", createdAt: Date.now(), sessionId: id,
      model: opts.model, effort: opts.effort, maxTurns: opts.maxTurns ?? 12, turnsUsed: 0,
    };
    this.#minions.set(id, m);
    this.#queue.push(m);
    this.#pump();
    return m;
  }

  list() {
    return [...this.#minions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, title, task, status, createdAt, startedAt, finishedAt, sessionId, model, effort, maxTurns, turnsUsed, result, error }) =>
        ({ id, title, task, status, createdAt, startedAt, finishedAt, sessionId, model, effort, maxTurns, turnsUsed, result, error }));
  }

  get(id: string): Minion | undefined { return this.#minions.get(id); }

  kill(id: string): boolean {
    const m = this.#minions.get(id);
    if (!m) return false;
    if (m.status === "queued") {
      this.#queue = this.#queue.filter((q) => q !== m);
      m.status = "killed"; m.finishedAt = Date.now();
      this.#opts.onChange(m);
      return true;
    }
    if (m.status === "running") {
      this.#ac.get(id)?.abort();
      m.status = "killed"; m.finishedAt = Date.now();
      this.#opts.onChange(m);
      return true;
    }
    return false;
  }

  #pump() {
    while (this.#running < this.#opts.concurrency && this.#queue.length) {
      const m = this.#queue.shift()!;
      this.#running++;
      void this.#run(m).finally(() => { this.#running--; this.#pump(); });
    }
  }

  async #run(m: Minion) {
    const ac = new AbortController();
    this.#ac.set(m.id, ac);
    m.status = "running";
    m.startedAt = Date.now();
    this.#opts.onChange(m);
    this.#log(m, "note", { role: "system", content: SYSTEM_PROMPT });
    this.#log(m, "cmd", { role: "user", content: "TASK: " + m.task });
    const messages: any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "TASK: " + m.task },
    ];
    try {
      const resolved = this.#opts.settings.resolveDefault();
      if (!resolved) throw new Error("no default model configured (settings.default)");
      const model = m.model ?? resolved.model.id;
      const effort = m.effort ?? resolved.effort;
      const toolDefs = BASE_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      while (m.turnsUsed < m.maxTurns && ac.signal.aborted !== true) {
        if (ac.signal.aborted) break;
        const out = await chatOnce({
          baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model, effort,
          messages, tools: toolDefs,
        });
        const msg = out?.choices?.[0]?.message ?? {};
        m.turnsUsed++;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
          const toolResults: any[] = [];
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name;
            let args: any = {};
            try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* bad args -> {} */ }
            const tool = BASE_TOOLS.find((t) => t.name === name);
            let content: unknown;
            if (!tool) content = "unknown tool: " + String(name);
            else {
              try {
                content = await tool.run(args, {
                  minion: m,
                  api: {
                    callDevice: (dev, method, params) => this.#opts.callDevice(dev, method, params),
                    memorySearch: (p) => this.#opts.memory.search(p),
                    memoryAdd: (p) => this.#opts.memory.add(p),
                    sessionsAppend: (id, e) => this.#opts.sessions.append(id, e),
                  },
                  log: (kind, data) => this.#log(m, kind, data),
                  signal: ac.signal,
                });
              } catch (err) { content = "tool error: " + String(err); }
            }
            const contentStr = typeof content === "string" ? content : JSON.stringify(content);
            this.#log(m, "result", { tool: name, args, result: contentStr.slice(0, 2000) });
            toolResults.push({ tool_call_id: tc.id, role: "tool", content: contentStr });
          }
          messages.push(...toolResults);
          continue;
        }
        // no tool calls -> final answer
        const text = String(msg.content ?? "").trim();
        m.result = text || "(empty final answer)";
        m.status = "done";
        m.finishedAt = Date.now();
        this.#log(m, "note", { role: "assistant", content: m.result });
        this.#ac.delete(m.id);
        this.#opts.onChange(m);
        return;
      }
      if (ac.signal.aborted) { m.status = "killed"; }
      else { m.status = "error"; m.error = "maxTurns exceeded (" + m.maxTurns + ")"; }
      m.finishedAt = Date.now();
    } catch (err) {
      m.status = "error";
      m.error = err instanceof Error ? err.message : String(err);
      m.finishedAt = Date.now();
    }
    this.#ac.delete(m.id);
    this.#opts.onChange(m);
  }

  #log(m: Minion, kind: string, data: unknown) {
    try { this.#opts.sessions.append(m.sessionId, { ts: Date.now(), from: "minion:" + m.id, kind, data }); } catch { /* session gone */ }
  }

  activeCount() { return this.#running; }
}
