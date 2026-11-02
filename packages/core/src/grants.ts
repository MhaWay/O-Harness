// Standing tool grants: which device-offered tools may be invoked without prompting.
// Grants are per device+tool, persisted under dataDir/grants.json. Revocation is immediate.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "./jsonfile.ts";
import { join } from "node:path";

export interface Grant { deviceId: string; tool: string; createdAt: number; lastUsedAt?: number }

export class GrantsStore {
  dir: string;
  #grants: Grant[] = [];
  constructor(dir: string) {
    this.dir = join(dir, "grants");
    mkdirSync(this.dir, { recursive: true });
    const f = join(this.dir, "grants.json");
    if (existsSync(f)) { try { this.#grants = JSON.parse(readFileSync(f, "utf8")) as Grant[]; } catch { this.#grants = []; } }
  }
  #save() { atomicWrite(join(this.dir, "grants.json"), JSON.stringify(this.#grants, null, 2), 0o600); }
  list(deviceId?: string): Grant[] { return this.#grants.filter((g) => !deviceId || g.deviceId === deviceId); }
  check(deviceId: string, tool: string): boolean { return this.#grants.some((g) => g.deviceId === deviceId && g.tool === tool); }
  grant(deviceId: string, tool: string): Grant {
    const found = this.#grants.find((g) => g.deviceId === deviceId && g.tool === tool);
    if (found) return found;
    const g: Grant = { deviceId, tool, createdAt: Date.now() };
    this.#grants.push(g);
    this.#save();
    return g;
  }
  touch(deviceId: string, tool: string) {
    const found = this.#grants.find((g) => g.deviceId === deviceId && g.tool === tool);
    if (found) { found.lastUsedAt = Date.now(); this.#save(); }
  }
  revoke(deviceId: string, tool: string): boolean {
    const before = this.#grants.length;
    this.#grants = this.#grants.filter((g) => !(g.deviceId === deviceId && g.tool === tool));
    this.#save();
    return this.#grants.length < before;
  }
}
