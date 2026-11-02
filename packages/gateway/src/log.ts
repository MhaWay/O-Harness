import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  ts: number;
  level: LogLevel;
  module: string;
  msg: string;
  meta?: Record<string, unknown>;
}

const RING_CAP = 800;

/** Structured logging: ring buffer + daily JSONL files under dataDir/logs. */
export class LogStore {
  dir: string;
  #ring: LogEntry[] = [];
  #loaded: string | null = null;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  #today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  add(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>): LogEntry {
    const e: LogEntry = { ts: Date.now(), level, module, msg, ...(meta ? { meta } : {}) };
    this.#ring.push(e);
    if (this.#ring.length > RING_CAP) this.#ring.splice(0, this.#ring.length - RING_CAP);
    try {
      appendFileSync(join(this.dir, this.#today() + ".jsonl"), JSON.stringify(e) + "\n");
    } catch {
      /* logging must never throw */
    }
    return e;
  }

  debug(m: string, msg: string, meta?: Record<string, unknown>) { return this.add("debug", m, msg, meta); }
  info(m: string, msg: string, meta?: Record<string, unknown>) { return this.add("info", m, msg, meta); }
  warn(m: string, msg: string, meta?: Record<string, unknown>) { return this.add("warn", m, msg, meta); }
  error(m: string, msg: string, meta?: Record<string, unknown>) { return this.add("error", m, msg, meta); }

  /** Newest-first, filtered, capped. Reads ring first; falls back to files when empty. */
  tail(opts?: { limit?: number; level?: LogLevel; module?: string; q?: string; since?: number }): { entries: LogEntry[]; total: number } {
    const limit = opts?.limit ?? 100;
    const src: LogEntry[] = [];
    const seen = new Set<string>();
    const push = (e: LogEntry) => {
      const key = e.ts + "|" + e.level + "|" + e.module + "|" + e.msg;
      if (!seen.has(key)) { seen.add(key); src.push(e); }
    };
    for (const e of this.#ring) push(e);
    const days = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    for (const d of days) {
      const lines = readFileSync(join(this.dir, d), "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { push(JSON.parse(lines[i]) as LogEntry); } catch { /* skip corrupt */ }
      }
      if (src.length > 5000) break;
    }
    const lvlRank = { debug: 0, info: 1, warn: 2, error: 3 };
    const minRank = opts?.level ? lvlRank[opts.level] : 0;
    const q = (opts?.q ?? "").toLowerCase();
    const flt = src.filter((e) => {
      if (lvlRank[e.level] < minRank) return false;
      if (opts?.module && !e.module.includes(opts.module)) return false;
      if (e.ts < (opts?.since ?? 0)) return false;
      if (q && !(e.module + " " + e.msg + " " + JSON.stringify(e.meta ?? "")).toLowerCase().includes(q)) return false;
      return true;
    });
    const total = flt.length;
    const indexed = flt.map((e, i) => ({ e, i }));
    indexed.sort((x, y) => y.e.ts - x.e.ts || y.i - x.i);
    const sorted = indexed.map((z) => z.e);
    return { entries: sorted.slice(0, limit), total };
  }

  stats(): { errors24h: number; warns24h: number; lastError: LogEntry | null; files: number } {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    let errors = 0, warns = 0, lastError: LogEntry | null = null;
    const t = this.tail({ limit: 2000 });
    for (const e of t.entries) {
      if (e.ts < dayAgo) continue;
      if (e.level === "error") { errors++; if (!lastError) lastError = e; }
      else if (e.level === "warn") warns++;
    }
    let files = 0;
    try { files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).length; } catch { /* dir gone */ }
    return { errors24h: errors, warns24h: warns, lastError, files };
  }

  /** Drop files older than keepDays (0 = keep all). */
  prune(keepDays: number): number {
    if (keepDays <= 0) return 0;
    const cut = Date.now() - keepDays * 3600 * 24 * 1000;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const name = f.replace(".jsonl", "");
      const t = Date.parse(name);
      if (!isNaN(t) && t < cut) { try { rmSync(join(this.dir, f)); n++; } catch { /* ignore */ } }
    }
    return n;
  }
}
