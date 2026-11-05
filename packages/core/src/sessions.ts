import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { atomicWrite } from "./jsonfile.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionEntry {
  seq: number;
  ts: number;
  from: string;
  kind: string; // note | cmd | result | status
  data: unknown;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  entries: SessionEntry[];
}

export class SessionsStore {
  #dir: string;
  #sessions = new Map<string, Session>();

  constructor(dir: string) {
    this.#dir = join(dir, "sessions");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.#dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.#dir, f), "utf-8")) as Session;
        if (s && typeof s.id === "string" && Array.isArray(s.entries)) this.#sessions.set(s.id, s);
      } catch { /* skip corrupt */ }
    }
  }

  #path(id: string) { return join(this.#dir, id + ".json"); }

  #persist(id: string) {
    const s = this.#sessions.get(id);
    if (s) atomicWrite(this.#path(id), JSON.stringify(s), 0o600);
  }

  create(title: string, id?: string): Session {
    const s: Session = { id: id ?? randomUUID().slice(0, 8), title: title || "session", createdAt: Date.now(), entries: [] };
    this.#sessions.set(s.id, s);
    this.#persist(s.id);
    return s;
  }

  get(id: string): Session | undefined { return this.#sessions.get(id); }

  list() {
    return [...this.#sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        count: s.entries.length,
        lastEntry: s.entries.length ? s.entries[s.entries.length - 1] : undefined,
      }));
  }

  append(id: string, partial: Omit<SessionEntry, "seq">): SessionEntry {
    const s = this.#sessions.get(id);
    if (!s) throw new Error("unknown session: " + id);
    const entry: SessionEntry = { seq: s.entries.length + 1, ...partial };
    s.entries.push(entry);
    this.#persist(id);
    return entry;
  }

  /** Full-text search across session titles and entry text (case-insensitive substring).
   * kind filters entry kinds (e.g. "chat"); q matches title OR at least one entry's text/data. */
  search(q: string, opts?: { kind?: string; limit?: number }): Array<{
    id: string; title: string; lastTs: number; hits: number; matchTs: number; matchSeq: number; snippet: string;
  }> {
    const needle = String(q ?? "").trim().toLowerCase();
    if (!needle) return [];
    const kind = opts?.kind;
    const limit = opts?.limit ?? 50;
    const out: Array<{ id: string; title: string; lastTs: number; hits: number; matchTs: number; matchSeq: number; snippet: string }> = [];
    for (const s of this.#sessions.values()) {
      const titleHit = s.title.toLowerCase().includes(needle);
      const texts: Array<{ seq: number; ts: number; text: string }> = [];
      for (const e of s.entries) {
        if (kind && e.kind !== kind) continue;
        const d = e.data as { text?: unknown } | undefined;
        const text = typeof d?.text === "string" ? d.text : JSON.stringify(e.data ?? "");
        if (text.toLowerCase().includes(needle)) texts.push({ seq: e.seq, ts: e.ts, text });
      }
      if (!titleHit && !texts.length) continue;
      const first = texts[0];
      const snip = first ? first.text.replace(/\s+/g, " ").slice(0, 180) : "";
      out.push({
        id: s.id, title: s.title, lastTs: s.entries.length ? s.entries[s.entries.length - 1].ts : s.createdAt,
        hits: texts.length + (titleHit ? 1 : 0), matchTs: first ? first.ts : s.createdAt, matchSeq: first ? first.seq : 0, snippet: snip,
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => b.matchTs - a.matchTs);
  }

  /** Remove a session and its file. The id "main" is refused — it is the chat default. */
  remove(id: string): boolean {
    if (id === "main" || !this.#sessions.has(id)) return false;
    this.#sessions.delete(id);
    try { rmSync(this.#path(id)); } catch { /* already gone */ }
    return true;
  }

  /** Remove the last entry of a session (used by chat regenerate). Returns it, or null when empty. */
  removeLast(id: string): SessionEntry | null {
    const s = this.#sessions.get(id);
    if (!s || !s.entries.length) return null;
    const e = s.entries.pop() as SessionEntry;
    this.#persist(id);
    return e;
  }

  /** Rename a session; empty title keeps the current one. Returns false if unknown. */
  rename(id: string, title: string): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    const t = String(title ?? "").trim().slice(0, 80);
    if (t) s.title = t;
    this.#persist(id);
    return true;
  }
}
