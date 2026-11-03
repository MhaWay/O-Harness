// Chat: conversational interface bound to a persistent session, with a bounded tool loop.
// History = session entries of kind 'chat' (user/assistant); memory injected as context.
// Tools: local exec/fs/memory + device-offered tools ("<deviceId>:<tool>", may prompt owner).
import { chatOnceStream, type SettingsStore } from "./models.ts";
import type { SessionsStore, MemoryStore } from "@o-harness/core";

export interface ChatOptions {
  settings: SettingsStore;
  sessions: SessionsStore;
  memory: MemoryStore;
  callDevice: (deviceId: string, method: string, params?: unknown) => Promise<unknown>;
  /** Offered device tools (e.g. phone calendar). Map deviceId -> tools. May require per-call approval. */
  listDeviceTools?: () => Record<string, { name: string; description?: string; parameters?: Record<string, unknown> }[]>;
  callTool?: (deviceId: string, tool: string, args: unknown, requester: string) => Promise<unknown>;
  broadcast?: (topic: string, data: unknown) => void;
  maxTurns?: number;
}

const CHAT_SYSTEM = "You are O-Harness, a personal assistant running on the user's own hardware (gateway + devices + minions). " +
  "You can act: use tools to check things (exec, read_file, write_file), consult memory (memory_search), save durable facts (memory_add), " +
  "or call device tools named <deviceId>:<tool> (the device owner may be asked to approve). Prefer action over speculation; when something " +
  "durable is learned or decided, offer to remember it (or use memory_add for clear facts). Answer concisely.";

// context window management: keep this many recent chat entries verbatim; fold older into a rolling summary
// once more than SUMMARIZE_AT entries sit above the last summary.
const KEEP_VERBATIM = 12;
const SUMMARIZE_AT = 20;

const LOCAL_TOOLS = [
  {
    name: "exec",
    description: "Run a shell command on the user's machine (local). Returns {code, stdout, stderr}.",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file from the local machine.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file on the local machine (creates parent dirs). Use sparingly; ask before destructive writes.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "memory_search",
    description: "Search durable memory for relevant facts. Returns list with id/subject/text/score.",
    parameters: { type: "object", properties: { query: { type: "string" }, subject: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_add",
    description: "Remember a durable fact about the user or project. Use only for clear, stable facts (preferences, decisions, configs).",
    parameters: { type: "object", properties: { text: { type: "string" }, subject: { type: "string" } }, required: ["text"] },
  },
];

export interface ChatToolStep { tool: string; args: unknown; result: string }

export class ChatRuntime {
  #opts: ChatOptions;
  constructor(opts: ChatOptions) { this.#opts = opts; }

  /** Send a user message into a session and get the assistant reply (runs a bounded tool loop; appends both roles to the session log). */
  async chat(sessionId: string, message: string, opts: { effort?: "none" | "low" | "medium" | "xhigh"; model?: string } = {}): Promise<{ text: string; entries: number; toolSteps?: ChatToolStep[] }> {
    const s = this.#opts.sessions.get(sessionId);
    if (!s) throw new Error("unknown session: " + sessionId);
    const resolved = this.#opts.settings.resolveDefault();
    if (!resolved) throw new Error("no default model configured (settings.default)");

    const userEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "user", kind: "chat", data: { role: "user", text: message } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: userEntry });

    // context management: bounded verbatim tail + rolling summary (Letta/dsh-style)
    const chatEntries = s.entries.filter((e) => e.kind === "chat" && (e.data as any)?.role);
    const ls = [...s.entries].reverse().find((e) => e.kind === "summary");
    let summaryText = ls ? String((ls.data as any).text ?? "") : "";
    let verbatim = chatEntries.filter((e) => (e as any).seq > (ls ? (ls as any).seq : -1));
    if (verbatim.length > SUMMARIZE_AT) {
      // fold everything but the last KEEP_VERBATIM entries into the rolling summary
      const old = verbatim.slice(0, verbatim.length - KEEP_VERBATIM);
      const convo = old.map((e) => (e.data as any).role + ": " + String((e.data as any).text ?? "").slice(0, 600)).join("\n");
      try {
        const r = await chatOnce({
          baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model.id, effort: "low",
          messages: [
            { role: "system", content: "Summarize the conversation excerpt into at most 6 dense bullet points. Merge with the previous summary if given (keep all durable facts, decisions, numbers, open questions). Reply with bullets only." },
            ...(summaryText ? [{ role: "user", content: "PREVIOUS SUMMARY:\n" + summaryText }] : []),
            { role: "user", content: "EXCERPT:\n" + convo },
          ],
        });
        summaryText = String(r?.choices?.[0]?.message?.content ?? "").trim() || summaryText || "(summary unavailable)";
      } catch { /* keep previous summary */ }
      const sEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "assistant", kind: "summary", data: { text: summaryText } });
      this.#opts.broadcast?.("chat.summary", { sessionId, entry: sEntry });
      verbatim = chatEntries.filter((e) => (e as any).seq > (sEntry as any).seq);
      // the user message that triggered this call is always kept verbatim (it may predate the new summary)
      if (!verbatim.some((e) => (e as any).seq === (userEntry as any).seq)) verbatim.push(userEntry);
    }
    const history = verbatim.map((e) => ({ role: (e.data as any).role, content: String((e.data as any).text ?? "").slice(0, 4000) }));

    // memory context: recall relevant durable facts for the latest message
    let memLine = "";
    try {
      const hits = this.#opts.memory.search({ query: message, limit: 6 });
      if (hits.length) memLine = hits.map((h) => "- " + String((h as any).memory?.text ?? (h as any).text)).join("\n");
    } catch { /* memory optional */ }
    const contextBlock = (summaryText ? "SUMMARY OF EARLIER TURNS:\n" + summaryText + "\n\n" : "") +
      (memLine ? "CONTEXT (durable user memory):\n" + memLine + "\n\n" : "") +
      "Current time: " + new Date().toISOString();
    const messages: any[] = [
      { role: "system", content: CHAT_SYSTEM + "\n\n" + contextBlock },
      ...history,
    ];

    // tool defs: local + device-offered
    const toolDefs = LOCAL_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const deviceToolNames = new Map<string, { deviceId: string; tool: string }>();
    const offered = this.#opts.listDeviceTools?.() ?? {};
    for (const [deviceId, tools] of Object.entries(offered)) {
      for (const t of tools) {
        const full = deviceId + ":" + t.name;
        deviceToolNames.set(full, { deviceId, tool: t.name });
        toolDefs.push({ type: "function", function: { name: full, description: "Device-offered tool (may prompt the device owner for approval): " + (t.description ?? t.name), parameters: t.parameters ?? { type: "object", properties: {} } } });
      }
    }

    const maxTurns = this.#opts.maxTurns ?? 30;
    const steps: ChatToolStep[] = [];
    let text = "";
    let thinkAll = "";
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const out = await chatOnceStream({
          baseUrl: resolved.baseUrl, apiKey: resolved.apiKey,
          model: opts.model ?? resolved.model.id,
          effort: opts.effort ?? resolved.effort,
          messages, tools: toolDefs,
        }, (tok, reasoning) => {
          if (reasoning) thinkAll += tok;
          this.#opts.broadcast?.("chat.stream", { sessionId, turn, tok: tok || undefined, reasoning: reasoning ? true : undefined });
        });
        const msg = out?.choices?.[0]?.message ?? {};
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            const name = String(tc.function?.name);
            let args: any = {};
            try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* bad args -> {} */ }
            this.#opts.broadcast?.("chat.tool", { sessionId, turn, tool: name, status: "running", args });
            let content: unknown;
            const devRef = deviceToolNames.get(name);
            if (devRef) {
              try { content = await this.#opts.callTool!(devRef.deviceId, devRef.tool, args, "chat"); }
              catch (err) { content = "tool error: " + String(err); }
            } else if (name === "exec") {
              try { content = await this.#opts.callDevice("local", "exec", { command: args.command, cwd: args.cwd }); } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "read_file") {
              try { content = await this.#opts.callDevice("local", "fs.read", { path: args.path }); } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "write_file") {
              try { content = await this.#opts.callDevice("local", "fs.write", { path: args.path, content: args.content }); } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "memory_search") {
              try { content = this.#opts.memory.search({ query: args.query, subject: args.subject, limit: args.limit ?? 5 }); } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "memory_add") {
              try { content = this.#opts.memory.add({ text: String(args.text), subject: args.subject ?? "user" }); } catch (err) { content = "tool error: " + String(err); }
            } else {
              content = "unknown tool: " + name;
            }
            const contentStr = typeof content === "string" ? content : JSON.stringify(content);
            this.#opts.broadcast?.("chat.tool", { sessionId, turn, tool: name, status: "done", args, result: contentStr.slice(0, 500) });
            steps.push({ tool: name, args, result: contentStr.slice(0, 500) });
            messages.push({ tool_call_id: tc.id, role: "tool", content: contentStr.slice(0, 8000) });
          }
          continue;
        }
        text = String(msg.content ?? "").trim();
        break;
      }
      if (!text && steps.length) {
        // tool-loop limit reached mid-task: ask for a progress wrap-up instead of stopping cold
        try {
          const wrap = await chatOnce({
            baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: opts.model ?? resolved.model.id, effort: "low",
            messages: [...messages, { role: "user", content: "You reached the tool-loop limit. Summarize what you completed and exactly what remains to continue." }],
          });
          text = String(wrap?.choices?.[0]?.message?.content ?? "").trim() || "(loop limit reached)";
        } catch { text = "(loop limit reached)"; }
      }
    } catch (err) {
      // model/loop failure mid-way: surface partial progress
      text = text || "error: " + String(err);
    }
    if (!text) text = "(empty reply)";
    const asEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "assistant", kind: "chat", data: { role: "assistant", text, tools: steps.length ? steps.map((x) => x.tool) : undefined, steps: steps.length ? steps.map((x) => ({ tool: x.tool, args: Object.fromEntries(Object.entries(x.args ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 300) : v])) })) : undefined, reasoning: thinkAll ? thinkAll.slice(0, 6000) : undefined } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: asEntry });
    return { text, entries: s.entries.length, toolSteps: steps.length ? steps : undefined };
  }
}
