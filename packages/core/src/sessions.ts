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
  pinned?: boolean;
  /** Soft-hidden: kept out of list() unless includeArchived (sessions stay fully readable/usable). */
  archived?: boolean;
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

  list(filter: { includeArchived?: boolean } = {}) {
    const act = (s: Session): number => (s.entries.length ? (s.entries[s.entries.length - 1].ts as number) || s.createdAt : s.createdAt);
    return [...this.#sessions.values()]
      .filter((s) => filter.includeArchived || !s.archived)
      .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (act(b) - act(a)))
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        lastActiveAt: act(s),
        pinned: !!s.pinned,
        archived: !!s.archived,
        count: s.entries.length,
        lastEntry: s.entries.length ? s.entries[s.entries.length - 1] : undefined,
      }));
  }

  /** Soft-archive a session (out of default lists; get/append/chat keep working). Returns false if unknown. */
  archive(id: string, archived = true): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    if (archived) s.archived = true; else delete s.archived;
    this.#persist(id);
    return true;
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

  /** Pin/unpin a session (pinned sessions sort first in list()). Returns false if unknown. */
  pin(id: string, pinned = true): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    s.pinned = !!pinned;
    this.#persist(id);
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

/** Render a session transcript as Markdown: chat entries as blocks, others as metadata lists. */
export function sessionToMarkdown(s: Session): string {
  const out: string[] = [
    "# " + (s.title || s.id),
    "",
    "- session: `" + s.id + "`",
    "- created: " + new Date(s.createdAt).toISOString(),
    "- entries: " + s.entries.length,
    "- exported: " + new Date().toISOString(),
    "",
  ];
  for (const e of s.entries) {
    const d = e.data as { role?: unknown; text?: unknown } | undefined;
    const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
    if (e.kind === "chat" && typeof d?.text === "string") {
      out.push("### " + when + " — " + String(d.role ?? ""), "", d.text, "");
    } else {
      out.push("- `" + when + "` **" + e.kind + "** (" + e.from + ")");
      if (typeof d === "string" || typeof d === "number" || typeof d === "boolean") out.push("  > " + String(d).replace(/\n/g, "\n  > "));
      else if (d?.text !== undefined) out.push("  > " + String(d.text).replace(/\n/g, "\n  > "));
      else if (d !== undefined) out.push("  ```json\n  " + JSON.stringify(d).slice(0, 2000) + "\n  ```");
    }
  }
  return out.join("\n") + "\n";
}
