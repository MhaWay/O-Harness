import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface PairedDevice {
  id: string;
  name: string;
  kind: "remote" | "mobile" | "local";
  scopes: string[];
  secret?: string;
  pairedAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface PairCode {
  code: string;
  kind: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  usedBy?: string;
}

/** Authorize-and-pair store: 6-digit one-time codes redeem into device secrets with scopes. */
export class PairingStore {
  private devices = new Map<string, PairedDevice>();
  private codes = new Map<string, PairCode>();
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "pairing"), { recursive: true });
    this.#load();
  }
  #file(name: string) { return join(this.dir, "pairing", name); }
  #load() {
    const dp = this.#file("devices.json");
    const cp = this.#file("codes.json");
    if (existsSync(dp)) for (const d of JSON.parse(readFileSync(dp, "utf-8")) as PairedDevice[]) this.devices.set(d.id, d);
    if (existsSync(cp)) for (const c of JSON.parse(readFileSync(cp, "utf-8")) as PairCode[]) this.codes.set(c.code, c);
  }
  #save() {
    writeFileSync(this.#file("devices.json"), JSON.stringify([...this.devices.values()], null, 2));
    writeFileSync(this.#file("codes.json"), JSON.stringify([...this.codes.values()], null, 2));
  }
  createCode(opts: { kind?: string; scopes?: string[]; ttlMinutes?: number }): PairCode {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = Date.now();
    const c: PairCode = {
      code,
      kind: opts.kind ?? "remote",
      scopes: opts.scopes ?? ["read", "write"],
      createdAt: now,
      expiresAt: now + (opts.ttlMinutes ?? 10) * 60_000,
    };
    this.codes.set(code, c);
    this.#save();
    return c;
  }
  redeem(code: string, name: string): { device: PairedDevice; secret: string } {
    const c = this.codes.get(code);
    if (!c) throw new Error("invalid pairing code");
    if (c.usedBy) throw new Error("pairing code already used");
    if (Date.now() > c.expiresAt) { this.codes.delete(code); this.#save(); throw new Error("pairing code expired"); }
    const secret = randomBytes(24).toString("hex");
    const dev: PairedDevice = {
      id: randomUUID().slice(0, 8),
      name: name || "device",
      kind: c.kind as PairedDevice["kind"],
      scopes: c.scopes,
      secret,
      pairedAt: Date.now(),
    };
    this.devices.set(dev.id, dev);
    c.usedBy = dev.id;
    this.#save();
    return { device: dev, secret };
  }
  auth(secret: string): PairedDevice | undefined {
    if (!secret) return undefined;
    for (const d of this.devices.values()) {
      if (!d.revokedAt && d.secret && d.secret === secret) { d.lastSeenAt = Date.now(); this.#save(); return d; }
    }
    return undefined;
  }
  get(id: string): PairedDevice | undefined { return this.devices.get(id); }
  list(): PairedDevice[] { return [...this.devices.values()]; }
  scopesFor(id: string): string[] { return this.devices.get(id)?.scopes ?? []; }
  revoke(id: string): void {
    const d = this.devices.get(id);
    if (d) { d.revokedAt = Date.now(); delete d.secret; this.#save(); }
  }
  touch(id: string): void { const d = this.devices.get(id); if (d) { d.lastSeenAt = Date.now(); this.#save(); } }
}

/** Minimal method -> scope policy map for device-originated RPC. */
export const SCOPE_FOR_METHOD: Record<string, string> = {
  "memory.add": "write",
  "sessions.append": "write",
  "agents.spawn": "write",
  "agents.kill": "admin",
  "settings.save": "admin",
  "settings.get": "read",
  "self.update": "admin",
  "device.exec": "admin",
  "device.fs.read": "read",
  "device.fs.write": "admin",
  "pairing.code": "admin",
  "pairing.revoke": "admin",
};
