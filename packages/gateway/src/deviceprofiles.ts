// Device profiles: durable per-device settings that survive reconnects and restarts.
// Stored in dataDir/devices/devices.json - display name overrides, notes, trust level,
// per-device tool permissions, notification settings, and last-known identity (the id the
// device keeps across restarts so profiles don't fragment when ids rotate).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "@o-harness/core";

export interface DeviceProfile {
  id: string;                 // canonical device id
  alias?: string;             // user-set display name
  note?: string;              // free-form note shown in UI
  trusted?: boolean;          // auto-approve offered tools (device owner trusts this device)
  allow?: string[];           // method whitelist when trusted (e.g. [exec,fs.read]); empty/undefined = capabilities
  notifications?: { enabled?: boolean; quietHours?: [string, string] };
  pairingId?: string;         // pairing record that minted it
  lastSeenAt?: number;        // last connect time (persisted for offline display)
  lastHost?: string;          // hostname from last hello
  createdAt: number;
  updatedAt: number;
}

export interface DeviceProfileInit { dataDir: string; }

export class DeviceProfiles {
  #file: string;
  #items = new Map<string, DeviceProfile>();
  constructor(init: DeviceProfileInit) {
    this.#file = join(init.dataDir, "devices", "devices.json");
    try {
      if (existsSync(this.#file)) {
        const j = JSON.parse(readFileSync(this.#file, "utf-8"));
        for (const p of Array.isArray(j?.devices) ? j.devices : []) if (p && typeof p.id === "string") this.#items.set(p.id, p);
      }
    } catch { /* corrupt file -> start empty, saved on first write */ }
  }
  list(): DeviceProfile[] { return [...this.#items.values()]; }
  get(id: string): DeviceProfile | undefined { return this.#items.get(id); }
  /** merge fields and persist (undefined fields untouched). */
  save(id: string, patch: Partial<DeviceProfile>): DeviceProfile {
    const now = Date.now();
    const cur: DeviceProfile = this.#items.get(id) ?? { id, createdAt: now, updatedAt: now };
    const next: DeviceProfile = { ...cur, ...patch, id, updatedAt: now };
    if (!next.createdAt) next.createdAt = cur.createdAt ?? now;
    this.#items.set(id, next);
    this.#persist();
    return next;
  }
  /** record a connect: lastSeenAt/lastHost only, never loses alias/note. */
  touch(id: string, host?: string): void {
    const cur = this.#items.get(id);
    const now = Date.now();
    if (cur) { cur.lastSeenAt = now; if (host) cur.lastHost = host; cur.updatedAt = now; }
    else this.#items.set(id, { id, createdAt: now, updatedAt: now, lastSeenAt: now, lastHost: host });
    this.#persist();
  }
  remove(id: string): boolean {
    const had = this.#items.delete(id);
    if (had) this.#persist();
    return had;
  }
  #persist() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      atomicWrite(this.#file, JSON.stringify({ savedAt: Date.now(), devices: [...this.#items.values()] }, null, 1));
    } catch { /* best effort */ }
  }
}
