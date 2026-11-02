// Scheduler: time-triggered runs. A job is "every N minutes" | "daily HH:mm" | "once <ISO>",
// firing a chat message in a session or spawning a minion. Jobs persist across restarts.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "@o-harness/core";
import { dirname, join } from "node:path";

export type JobCadence =
  | { type: "every"; minutes: number }
  | { type: "daily"; time: string }        // "HH:mm" local
  | { type: "once"; at: string };         // ISO datetime

export interface Job {
  id: string;
  label: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
  count?: number;
  kind: "chat" | "minion";
  message?: string;   // chat: message sent (as the user) in the session
  task?: string;      // minion: task to spawn
  sessionId?: string;
  cadence: JobCadence;
  disabled?: boolean;
  lastResult?: string;
}

export interface SchedulerOptions {
  storeDir?: string;
  chat?: (sessionId: string, message: string) => Promise<{ text: string }>;
  spawn?: (task: string, opts: { title?: string }) => unknown;
  broadcast?: (topic: string, data: unknown) => void;
  log?: (m: Job, kind: string, data: unknown) => void;
}

function dailyAt(time: string, from: number): number {
  const [hh, mm] = time.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) throw new Error("bad daily time: " + time);
  const d = new Date(from);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export class SchedulerRuntime {
  #opts: SchedulerOptions;
  #jobs = new Map<string, Job>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #storeFile: string | null = null;
  #loaded = false;
  #firing = false;

  constructor(opts: SchedulerOptions) {
    this.#opts = opts;
    if (opts.storeDir) this.#storeFile = join(opts.storeDir, "jobs.json");
  }

  start() {
    this.load();
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, 30_000);
    void this.tick();
  }

  stop() { if (this.#timer) { clearInterval(this.#timer); this.#timer = null; } }

  load() {
    if (this.#loaded || !this.#storeFile) return;
    this.#loaded = true;
    let recs: any[] = [];
    try { recs = JSON.parse(readFileSync(this.#storeFile, "utf8"))?.jobs ?? []; } catch { return; }
    for (const r of recs) if (r && r.id && !this.#jobs.has(r.id)) this.#jobs.set(r.id, r as Job);
  }

  #persist() {
    if (!this.#storeFile) return;
    try {
      const dir = dirname(this.#storeFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      atomicWrite(this.#storeFile, JSON.stringify({ savedAt: Date.now(), jobs: [...this.#jobs.values()] }));
    } catch { /* best effort */ }
  }

  create(params: { label?: string; message?: string; task?: string; sessionId?: string; cadence: JobCadence }): Job {
    const kind = params.task ? "minion" : "chat";
    if (kind === "chat" && !String(params.message ?? "").trim()) throw new Error("schedule: message or task required");
    if (kind === "chat" && !this.#opts.chat) throw new Error("chat scheduler not wired");
    if (kind === "minion" && !this.#opts.spawn) throw new Error("minion scheduler not wired");
    const now = Date.now();
    const cadence = params.cadence;
    let next = now + 15_000;
    if (cadence.type === "every") { if (!(cadence.minutes > 0)) throw new Error("every: minutes must be > 0"); next = now + cadence.minutes * 60_000; }
    else if (cadence.type === "daily") next = dailyAt(cadence.time, now);
    else if (cadence.type === "once") { next = Date.parse(cadence.at); if (!Number.isFinite(next)) throw new Error("once: bad ISO at=" + cadence.at); }
    else throw new Error("bad cadence");
    const j: Job = {
      id: randomUUID().slice(0, 8),
      label: String(params.label ?? (params.task ?? params.message ?? "").slice(0, 60) ?? "job"),
      createdAt: now, nextRunAt: next, kind,
      message: params.message ? String(params.message) : undefined,
      task: params.task ? String(params.task) : undefined,
      sessionId: params.sessionId ? String(params.sessionId) : "main",
      cadence,
    };
    this.#jobs.set(j.id, j);
    this.#persist();
    this.#opts.broadcast?.("schedule.changed", { id: j.id, event: "created" });
    return j;
  }

  list() { return [...this.#jobs.values()].sort((a, b) => a.nextRunAt - b.nextRunAt); }
  get(id: string) { return this.#jobs.get(id); }

  remove(id: string): boolean {
    const ok = this.#jobs.delete(id);
    if (ok) { this.#persist(); this.#opts.broadcast?.("schedule.changed", { id, event: "removed" }); }
    return ok;
  }

  setDisabled(id: string, disabled: boolean): boolean {
    const j = this.#jobs.get(id);
    if (!j) return false;
    j.disabled = disabled;
    this.#persist();
    this.#opts.broadcast?.("schedule.changed", { id, event: disabled ? "disabled" : "enabled" });
    return true;
  }

  runNow(id: string): Job | undefined {
    const j = this.#jobs.get(id);
    if (!j) return undefined;
    void this.#fire(j);
    return j;
  }

  /** Run one pass of due jobs. Exported-ish for tests via runNow; tick() is guarded reentrant. */
  async tick(): Promise<void> {
    if (this.#firing) return;
    this.#firing = true;
    try {
      const now = Date.now();
      for (const j of [...this.#jobs.values()]) {
        if (j.disabled) continue;
        if (j.nextRunAt > now) continue;
        await this.#fire(j);
        if (j.cadence.type === "once") { this.#jobs.delete(j.id); }
        else if (j.cadence.type === "every") { j.nextRunAt = now + Math.max(1, j.cadence.minutes) * 60_000; }
        else { j.nextRunAt = dailyAt(j.cadence.time, Date.now()); }
        this.#persist();
      }
    } finally { this.#firing = false; }
  }

  async #fire(j: Job) {
    j.lastRunAt = Date.now();
    j.count = (j.count ?? 0) + 1;
    try {
      if (j.kind === "chat" && this.#opts.chat) {
        const r = await this.#opts.chat(j.sessionId ?? "main", "[scheduled: " + j.label + "] " + (j.message ?? ""));
        j.lastResult = String(r?.text ?? "").slice(0, 300);
      } else if (j.kind === "minion" && this.#opts.spawn) {
        const m: any = await this.#opts.spawn((j.task ?? "") + " (scheduled run of job " + j.id + ")", { title: j.label });
        j.lastResult = "spawned minion " + String(m?.id ?? "");
      }
    } catch (err) {
      j.lastResult = "error: " + String(err);
    }
    this.#opts.broadcast?.("schedule.fire", { id: j.id, label: j.label, lastResult: j.lastResult, lastRunAt: j.lastRunAt });
    this.#persist();
  }
}
