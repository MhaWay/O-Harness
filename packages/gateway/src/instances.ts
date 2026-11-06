// Live gateway-instance registry: each running gateway registers itself under
// dataDir/instances/<pid>.json and refreshes a heartbeat every 15s. Because the
// data dir is shared, any instance (or the CLI, offline) can discover sibling
// instances and detect stale ones — this exists to surface accidental duplicate
// gateways running against one data dir.
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { atomicWrite } from "@o-harness/core";
import { join } from "node:path";

export interface InstanceInfo {
  pid: number;
  port: number;
  host: string;
  mode: string;
  startedAt: number;
  heartbeatAt: number;
}

const HEARTBEAT_MS = 15_000;
const STALE_MS = 90_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user (CI runs unprivileged) — alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Instances dir for a data dir. */
export function instancesDir(dataDir: string): string { return join(dataDir, "instances"); }

/** Live instances found under an instances *dir* (not the data dir). Stale pruned. */
export function liveInstances(instancesPath: string): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  let names: string[] = [];
  try { names = readdirSync(instancesPath); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = join(instancesPath, n);
    try {
      const i = JSON.parse(readFileSync(p, "utf-8")) as InstanceInfo;
      if (typeof i.pid !== "number" || typeof i.port !== "number") continue;
      const dead = !pidAlive(i.pid) || Date.now() - i.heartbeatAt > STALE_MS;
      if (dead) { try { unlinkSync(p); } catch { /* raced */ } continue; }
      out.push(i);
    } catch { try { unlinkSync(p); } catch { /* raced */ } }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Live instances for a data dir (the CLI entry point). */
export function listInstances(dataDir: string): InstanceInfo[] { return liveInstances(instancesDir(dataDir)); }

export class InstanceRegistry {
  dir: string;
  #info: InstanceInfo;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, self: Omit<InstanceInfo, "startedAt" | "heartbeatAt">) {
    this.dir = instancesDir(dataDir);
    mkdirSync(this.dir, { recursive: true });
    this.#info = { ...self, startedAt: Date.now(), heartbeatAt: Date.now() };
  }

  #file(pid: number): string { return join(this.dir, pid + ".json"); }

  /** Register self + start heartbeat. Returns other live instances (siblings). */
  start(): InstanceInfo[] {
    this.#beat();
    this.#timer = setInterval(() => this.#beat(), HEARTBEAT_MS);
    if (this.#timer.unref) this.#timer.unref();
    return this.list().filter((i) => i.pid !== this.#info.pid);
  }

  #beat(): void {
    this.#info.heartbeatAt = Date.now();
    atomicWrite(this.#file(this.#info.pid), JSON.stringify(this.#info, null, 2), 0o600);
  }

  list(): InstanceInfo[] { return liveInstances(this.dir); }

  stop(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    try { unlinkSync(this.#file(this.#info.pid)); } catch { /* already gone */ }
  }
}
