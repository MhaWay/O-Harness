// Chat: conversational interface bound to a persistent session.
// History = session entries of kind 'chat' (user/assistant), memory is injected as context.
import { chatOnce, type SettingsStore } from "./models.ts";
import type { SessionsStore, MemoryStore } from "@o-harness/core";

export interface ChatOptions {
  settings: SettingsStore;
  sessions: SessionsStore;
  memory: MemoryStore;
  broadcast?: (topic: string, data: unknown) => void;
}

const CHAT_SYSTEM = "You are O-Harness, a personal assistant running on the user's own hardware (gateway + devices + minions). " +
  "Answer directly and concisely. Facts about the user may appear in CONTEXT below; if something important was just decided or told, " +
  "consider whether it is a durable fact worth remembering (the user can always ask you to remember).";

export class ChatRuntime {
  #opts: ChatOptions;
  constructor(opts: ChatOptions) { this.#opts = opts; }

  /** Send a user message into a session and get the assistant reply (appends both to the session log). */
  async chat(sessionId: string, message: string, opts: { effort?: "none" | "low" | "medium" | "xhigh"; model?: string } = {}): Promise<{ text: string; entries: number }> {
    const s = this.#opts.sessions.get(sessionId);
    if (!s) throw new Error("unknown session: " + sessionId);
    const resolved = this.#opts.settings.resolveDefault();
    if (!resolved) throw new Error("no default model configured (settings.default)");

    const userEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "user", kind: "chat", data: { role: "user", text: message } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: userEntry });

    // history: chat entries of this session as messages
    const history = s.entries
      .filter((e) => e.kind === "chat" && (e.data as any)?.role)
      .map((e) => ({ role: (e.data as any).role, content: String((e.data as any).text ?? "") }));

    // memory context: recall relevant durable facts for the latest message
    let memLine = "";
    try {
      const hits = this.#opts.memory.search({ query: message, limit: 6 });
      if (hits.length) memLine = hits.map((h) => "- " + String((h as any).memory?.text ?? (h as any).text)).join("\n");
    } catch { /* memory optional */ }
    const contextBlock = (memLine ? "CONTEXT (durable user memory):\n" + memLine + "\n\n" : "") +
      "Current time: " + new Date().toISOString();
    const messages: unknown[] = [
      { role: "system", content: CHAT_SYSTEM + "\n\n" + contextBlock },
      ...history,
    ];

    const out = await chatOnce({
      baseUrl: resolved.baseUrl, apiKey: resolved.apiKey,
      model: opts.model ?? resolved.model.id,
      effort: opts.effort ?? resolved.effort,
      messages,
    });
    const text = String(out?.choices?.[0]?.message?.content ?? "").trim() || "(empty reply)";
    const asEntry = this.#opts.sessions.append(sessionId, { ts: Date.now(), from: "assistant", kind: "chat", data: { role: "assistant", text } });
    this.#opts.broadcast?.("chat.message", { sessionId, entry: asEntry });
    return { text, entries: s.entries.length };
  }
}