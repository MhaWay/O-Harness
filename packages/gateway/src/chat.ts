// Chat: conversational interface bound to a persistent session, with a bounded tool loop.
// History = session entries of kind 'chat' (user/assistant); memory injected as context.
// Tools: local exec/fs/memory + device-offered tools ("<deviceId>:<tool>", may prompt owner).
import { chatOnce, chatOnceStream, type SettingsStore } from "./models.ts";
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
  /** Connected devices (live): environment map + per-device tool defs. */
  devices?: () => { id: string; name: string; kind: string; status?: string; capabilities?: string[]; meta?: Record<string, unknown> }[];
  host?: () => { platform: string; arch: string; hostname: string };
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
  {
    name: "edit_file",
    description: "Replace an exact string in a file on the gateway host (read+write atomically). Fails if old is missing or appears more than once unless all=true. Args: {path, old, new, all?}",
    parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["path", "old", "new"] },
  },
  {
    name: "process",
    description: "Background command lifecycle on the gateway host. op=start {command, cwd?} returns {pid, log}; op=status {pid} returns {running, code, tail}; op=kill {pid}; op=list {} lists pids. Prefer this over exec for anything longer than a few seconds.",
    parameters: { type: "object", properties: { op: { type: "string", enum: ["start", "status", "kill", "list"] }, command: { type: "string" }, cwd: { type: "string" }, pid: { type: "number" } }, required: ["op"] },
  },
  {
    name: "memory_update",
    description: "Correct or replace durable memory: adds a new memory and supersedes the one with the given id. Find ids with memory_search first. Args: {text, subject?, id?}",
    parameters: { type: "object", properties: { text: { type: "string" }, subject: { type: "string" }, id: { type: "string" } }, required: ["text"] },
  },
];

export interface ChatToolStep { tool: string; args: unknown; result: string }

export class ChatRuntime {
  #opts: ChatOptions;
  constructor(opts: ChatOptions) { this.#opts = opts; }

  /** Send a user message into a session and get the assistant reply (runs a bounded tool loop; appends both roles to the session log). */
  async chat(sessionId: string, message: string, opts: { effort?: "none" | "low" | "medium" | "xhigh"; model?: string; signal?: AbortSignal; sourceDevice?: string } = {}): Promise<{ text: string; entries: number; toolSteps?: ChatToolStep[] }> {
    const s = this.#opts.sessions.get(sessionId);
    if (!s) throw new Error("unknown session: " + sessionId);
    const resolved = this.#opts.settings.resolveDefault();
    if (!resolved) throw new Error("no default model configured (settings.default)");

    const firstChat = !s.entries.some((e2) => e2.kind === "chat" && (e2.data as any)?.role === "user");
    const userEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "user", kind: "chat", data: { role: "user", text: message } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: userEntry });
    if (firstChat) {
      // auto-title placeholder sessions from the first message (dsh-style)
      const placeholder = /^(main|session|chat( \d.*| \d*)?)$/.test((s.title ?? "").trim());
      if (placeholder) {
        const t = message.replace(/\s+/g, " ").trim().slice(0, 60) || "chat";
        if (this.#opts.sessions.rename(sessionId, t)) this.#opts.broadcast?.("sessions.changed", { sessionId, title: t });
      }
    }

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
    // environment: where the assistant runs, which devices exist, where the user is writing from
    const envLines: string[] = [];
    try {
      const h = this.#opts.host?.();
      if (h) envLines.push("Gateway host: " + h.hostname + " (" + h.platform + "/" + h.arch + "). Tools without a device prefix (exec, read_file, write_file, edit_file, process) run there on the gateway.");
    } catch { /* host unknown */ }
    try {
      const devs = (this.#opts.devices?.() ?? []).filter((d) => d.status !== "offline");
      if (devs.length) {
        envLines.push("Connected devices:");
        for (const d of devs) {
          const m = (d.meta ?? {}) as Record<string, unknown>;
          const bits = [d.kind + (m.platform ? "/" + String(m.platform) : ""), m.hostname ? "host=" + String(m.hostname) : "", (d.capabilities ?? []).length ? "caps=" + (d.capabilities ?? []).join(",") : ""].filter(Boolean).join(" ");
          envLines.push("- " + d.id + " (name: " + d.name + ") " + bits);
        }
        envLines.push("To act on another device, call <deviceId>:exec / <deviceId>:read_file / <deviceId>:write_file / <deviceId>:<offered-tool>. Device calls reach the device over its connection (LAN direct or gateway channel).");
      }
    } catch { /* devices optional */ }
    const src = opts.sourceDevice ? (this.#opts.devices?.() ?? []).find((d) => d.id === opts.sourceDevice) : undefined;
    if (src) {
      const sm = (src.meta ?? {}) as Record<string, unknown>;
      envLines.push("The user is writing THIS message from device id=" + src.id + " (name: " + src.name + ", kind: " + src.kind + (sm.platform ? ", platform " + String(sm.platform) : "") + (sm.hostname ? ", host " + String(sm.hostname) : "") + "). For personal questions (calendar, notes, what they are doing on that device) prefer that device's tools, and use <deviceId>:notify to get their attention there.");
    }
    const environment = envLines.length ? "ENVIRONMENT (where you and the user are):" + "\n" + envLines.join("\n") + "\n\n" : "";
    const messages: any[] = [
      { role: "system", content: CHAT_SYSTEM + "\n\n" + environment + contextBlock },
      ...history,
    ];

    // tool defs: local + device-offered
    const toolDefs = LOCAL_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const deviceToolNames = new Map<string, { deviceId: string; tool: string; method?: string }>();
    const offered = this.#opts.listDeviceTools?.() ?? {};
    for (const [deviceId, tools] of Object.entries(offered)) {
      for (const t of tools) {
        const full = deviceId + ":" + t.name;
        deviceToolNames.set(full, { deviceId, tool: t.name });
        toolDefs.push({ type: "function", function: { name: full, description: "Device-offered tool (may prompt the device owner for approval): " + (t.description ?? t.name), parameters: t.parameters ?? { type: "object", properties: {} } } });
      }
    }

    // per-device exec/fs tool defs: every connected node exposing exec can be driven remotely
    for (const d of (this.#opts.devices?.() ?? []).filter((x) => x.status !== "offline" && x.id !== "local" && (x.capabilities ?? []).includes("exec"))) {
      const mk = (suffix: string, desc: string, method: string, props: Record<string, unknown>, req: string[]) => {
        deviceToolNames.set(d.id + ":" + suffix, { deviceId: d.id, tool: suffix, method });
        toolDefs.push({ type: "function", function: { name: d.id + ":" + suffix, description: desc + " Runs remotely on device " + d.id + " (" + d.name + ", " + d.kind + ").", parameters: { type: "object", properties: props, required: req } } });
      };
      mk("exec", "Run a shell command remotely.", "exec", { command: { type: "string" }, cwd: { type: "string" } }, ["command"]);
      mk("read_file", "Read a UTF-8 file remotely.", "fs.read", { path: { type: "string" } }, ["path"]);
      mk("write_file", "Write a UTF-8 file remotely.", "fs.write", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]);
    }
    // Unlimited by default: the model decides when it is finished.
    // Guards: 30-min wall-clock deadline and a death-loop detector (same call 4x).
    // dsh-style per-turn system reminder keeps it pushing until done or clearly blocked.
    const maxTurns = this.#opts.maxTurns ?? (Number.POSITIVE_INFINITY as number);
    const deadline = Date.now() + 30 * 60000;
    const callCounts = new Map<string, number>();
    let stopReason = "";
    const REMINDER = `<system-reminder>You are mid-task. Keep calling tools until the task is complete — do not stop, summarize early, or offer to continue unless genuinely blocked. If blocked, state exactly what blocks you and what remains.</system-reminder>`;
    let remIdx = -1;
    const steps: ChatToolStep[] = [];
    let text = "";
    let thinkAll = "";
    let live = "";
    let liveMark = 0;
    const aborted = () => opts.signal?.aborted === true;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (aborted()) { stopReason = "user-abort"; break; }
        if (turn > 0) {
          if (Date.now() > deadline) { stopReason = "wall-clock"; break; }
          if (remIdx >= 0) (messages[remIdx] as any).content = REMINDER;
          else { messages.push({ role: "user", content: REMINDER }); remIdx = messages.length - 1; }
        }
        let out: any;
        liveMark = live.length;
        try {
          out = await chatOnceStream({
            baseUrl: resolved.baseUrl, apiKey: resolved.apiKey,
            model: opts.model ?? resolved.model.id,
            effort: opts.effort ?? resolved.effort,
            messages, tools: toolDefs,
            ...(opts.signal ? { signal: opts.signal } : {}),
          }, (tok, reasoning) => {
            if (reasoning) thinkAll += tok; else live += tok;
            this.#opts.broadcast?.("chat.stream", { sessionId, turn, tok: tok || undefined, reasoning: reasoning ? true : undefined });
          });
        } catch (err) {
          if (aborted()) { text = text || live.slice(liveMark).trim(); stopReason = "user-abort"; break; }
          throw err;
        }
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
              try { content = devRef.method ? await this.#opts.callDevice(devRef.deviceId, devRef.method, args) : await this.#opts.callTool!(devRef.deviceId, devRef.tool, args, "chat"); }
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
            } else if (name === "edit_file") {
              try {
                const r0: any = await this.#opts.callDevice(args.deviceId ?? "local", "fs.read", { path: args.path });
                const cur = String(r0?.content ?? "");
                const hits = cur.split(String(args.old)).length - 1;
                if (hits === 0) throw new Error("edit_file: old string not found in " + String(args.path));
                if (hits > 1 && args.all !== true) throw new Error("edit_file: old appears " + hits + " times; pass all=true to replace all");
                await this.#opts.callDevice(args.deviceId ?? "local", "fs.write", { path: args.path, content: cur.split(String(args.old)).join(String(args.new)) });
                content = { ok: true, replaced: hits, path: String(args.path) };
              } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "process") {
              try { content = await this.#runProcess(args); } catch (err) { content = "tool error: " + String(err); }
            } else if (name === "memory_update") {
              try { content = this.#opts.memory.add({ text: String(args.text), subject: args.subject ?? "user" }, { supersedeIds: args.id ? [String(args.id)] : [] }); } catch (err) { content = "tool error: " + String(err); }
            } else {
              content = "unknown tool: " + name;
            }
            const contentStr = typeof content === "string" ? content : JSON.stringify(content);
            this.#opts.broadcast?.("chat.tool", { sessionId, turn, tool: name, status: "done", args, result: contentStr.slice(0, 500) });
            steps.push({ tool: name, args, result: contentStr.slice(0, 500) });
            const sig = name + "|" + JSON.stringify(args ?? {});
            const n = (callCounts.get(sig) ?? 0) + 1; callCounts.set(sig, n);
            messages.push({ tool_call_id: tc.id, role: "tool", content: contentStr.slice(0, 8000) });
            if (n >= 4) { stopReason = "death-loop"; break; }
          }
          continue;
        }
        text = String(msg.content ?? "").trim();
        break;
      }
      if (!text && steps.length && !aborted()) {
        // stopped without a final answer (deadline / death-loop): wrap up instead of stopping cold
        try {
          const clean = messages.filter((_m, i) => i !== remIdx);
          const wrap = await chatOnce({
            baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: opts.model ?? resolved.model.id, effort: "low",
            messages: [...clean, { role: "user", content: "Stop the tool loop. Summarize what you completed and exactly what remains to continue." }],
          });
          text = String(wrap?.choices?.[0]?.message?.content ?? "").trim() || "(stopped early: " + (stopReason || "unknown") + ")";
        } catch { text = "(stopped early: " + (stopReason || "unknown") + ")"; }
      }
    } catch (err) {
      // model/loop failure mid-way: surface partial progress
      text = text || "error: " + String(err);
    }
    if (!text) text = aborted() ? "(stopped)" : "(empty reply)";
    const asEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "assistant", kind: "chat", data: { role: "assistant", text, tools: steps.length ? steps.map((x) => x.tool) : undefined, steps: steps.length ? steps.map((x) => ({ tool: x.tool, args: Object.fromEntries(Object.entries(x.args ?? {}).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 300) : v])) })) : undefined, reasoning: thinkAll ? thinkAll.slice(0, 6000) : undefined } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: asEntry });
    return { text, entries: s.entries.length, toolSteps: steps.length ? steps : undefined };
  }

  #procs = new Map<number, { child: import("node:child_process").ChildProcess; log: string }>();

  async #runProcess(args: any): Promise<unknown> {
    const op = String(args?.op ?? "");
    if (op === "start") {
      if (typeof args.command !== "string") throw new Error("process.start: command required");
      const { openSync } = await import("node:fs");
      const { spawn } = await import("node:child_process");
      const { tmpdir } = await import("node:os");
      const log = tmpdir() + "/oh-proc.log";
      const fd = openSync(log, "a");
      const child = spawn("/bin/sh", ["-c", String(args.command)], { cwd: args.cwd ? String(args.cwd) : undefined, detached: true, stdio: ["ignore", fd, fd] });
      const pid = child.pid ?? -1;
      child.on("error", () => { /* surfaced via status */ });
      this.#procs.set(pid, { child, log: String(log) });
      return { pid, log: String(log), started: true };
    }
    if (op === "status") {
      const p = this.#procs.get(Number(args.pid));
      if (!p) return { running: false, unknown: true, reason: "unknown pid (list known, or start)" };
      const { readFile } = await import("node:fs/promises");
      let tail = "";
      try { tail = (await readFile(p.log, "utf-8")).slice(-2000); } catch { tail = "(no output yet)"; }
      return { running: p.child.exitCode === null, code: p.child.exitCode ?? undefined, tail };
    }
    if (op === "kill") {
      const p = this.#procs.get(Number(args.pid));
      if (!p) return { ok: false, reason: "unknown pid" };
      try { p.child.kill("SIGTERM"); } catch { /* already dead */ }
      return { ok: true };
    }
    if (op === "list") {
      return [...this.#procs.entries()].map(([pid, p]) => ({ pid, running: p.child.exitCode === null }));
    }
    throw new Error("process: unknown op " + op);
  }

  /**
   * Regenerate the last answer: pop back to just before the last user message
   * (it is re-sent through chat(), so the user turn is re-appended once), then run again.
   * Returns null when the session has no user message. `dropped` = entries removed.
   */
  async regenerate(sessionId: string, opts: { effort?: "none" | "low" | "medium" | "xhigh"; model?: string; signal?: AbortSignal; sourceDevice?: string } = {}): Promise<{ text: string; dropped: number } | null> {
    const s = this.#opts.sessions.get(sessionId);
    if (!s) throw new Error("unknown session: " + sessionId);
    let idx = -1;
    for (let i = s.entries.length - 1; i >= 0; i--) {
      const e = s.entries[i] as any;
      if (e.kind === "chat" && e.data?.role === "user") { idx = i; break; }
    }
    if (idx < 0) return null;
    const message = String(s.entries[idx].data?.text ?? "");
    const dropped = s.entries.length - idx - 1; // entries removed besides the re-sent user message
    while (s.entries.length > idx) this.#opts.sessions.removeLast(sessionId);
    this.#opts.broadcast?.("sessions.changed", { sessionId, regenerated: true, dropped });
    const res = await this.chat(sessionId, message, opts);
    return { text: res.text, dropped };
  }
}
