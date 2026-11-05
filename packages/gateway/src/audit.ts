import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AuditEvent {
  at: number;
  event: string;
  actor?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}

const MAX_BYTES = 1_000_000; // rotate past ~1MB, keep newest half

/** Append-only audit trail for authz-relevant events (login, pair, scope deny, revoke, restore). */
export class AuditStore {
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "audit.jsonl");
  }
  note(event: string, meta: { actor?: string; ip?: string; [k: string]: unknown } = {}): void {
    const { actor, ip, ...rest } = meta;
    const line = JSON.stringify({ at: Date.now(), event, actor, ip, meta: Object.keys(rest).length ? rest : undefined });
    try {
      appendFileSync(this.file, line + "\n");
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) this.#rotate();
    } catch { /* audit must never break the request path */ }
  }
  #rotate(): void {
    const lines = readFileSync(this.file, "utf-8").split("\n").filter(Boolean);
    writeFileSync(this.file, lines.slice(Math.floor(lines.length / 2)).join("\n"), { mode: 0o600 });
  }
  tail(opts: { limit?: number; q?: string } = {}): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    const q = (opts.q ?? "").toLowerCase();
    let lines = readFileSync(this.file, "utf-8").split("\n").filter(Boolean);
    const evts: AuditEvent[] = [];
    for (const l of lines) {
      if (q && !l.toLowerCase().includes(q)) continue;
      try { evts.push(JSON.parse(l) as AuditEvent); } catch { /* skip corrupt line */ }
    }
    return evts.slice(-(opts.limit ?? 100));
  }
  stats(): { lines: number; bytes: number } {
    if (!existsSync(this.file)) return { lines: 0, bytes: 0 };
    return { lines: readFileSync(this.file, "utf-8").split("\n").filter(Boolean).length, bytes: statSync(this.file).size };
  }
}
