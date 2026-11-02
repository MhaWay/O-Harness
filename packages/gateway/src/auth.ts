// Auth methods: master password (scrypt), cookie sessions, generic OAuth/OIDC login.
// Single master user; the bootstrap token stays available when tokenEnabled.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const COOKIE_NAME = "ohs";

export interface SessionRec {
  createdAt: number;
  expiresAt: number;
  kind: "password" | "oauth";
  provider?: string;
  sub?: string;
  label?: string;
}

export interface OAuthProviderCfg {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string;
  /** If non-empty, only these user ids (sub) get an admin session. */
  subs: string[];
}

export class AuthStore {
  private file: string;
  pw: { salt: string; hash: string; updatedAt: number } | null = null;
  /** key = sha256hex(sessionId) */
  sessions: Record<string, SessionRec> = {};
  oauth: Record<string, OAuthProviderCfg> = {};

  constructor(dir: string) {
    this.file = join(dir, "auth.json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#load();
  }

  #load() {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf-8"));
      if (j.pw && typeof j.pw.salt === "string" && typeof j.pw.hash === "string") this.pw = j.pw;
      if (j.sessions && typeof j.sessions === "object") this.sessions = j.sessions;
      if (j.oauth && typeof j.oauth === "object") this.oauth = j.oauth;
    } catch { /* first run */ }
  }

  #save() {
    writeFileSync(this.file, JSON.stringify({ pw: this.pw, sessions: this.#sweep(), oauth: this.oauth }, null, 2), { mode: 0o600 });
  }

  #sweep(): Record<string, SessionRec> {
    const now = Date.now();
    const out: Record<string, SessionRec> = {};
    for (const [k, v] of Object.entries(this.sessions)) if (v.expiresAt > now) out[k] = v;
    return out;
  }

  setPassword(password: string) {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
    this.pw = { salt, hash, updatedAt: Date.now() };
    this.sessions = {}; // changing the password invalidates all sessions
    this.#save();
  }

  verify(password: string): boolean {
    if (!this.pw) return false;
    const want = Buffer.from(this.pw.hash, "hex");
    const got = scryptSync(password, this.pw.salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return want.length === got.length && timingSafeEqual(want, got);
  }

  newSession(opts: { kind: SessionRec["kind"]; provider?: string; sub?: string; label?: string; ttlMs?: number }): { id: string; rec: SessionRec } {
    const id = randomBytes(24).toString("hex");
    const key = createHash("sha256").update(id).digest("hex");
    const rec: SessionRec = { createdAt: Date.now(), expiresAt: Date.now() + (opts.ttlMs ?? SESSION_TTL_MS), kind: opts.kind, provider: opts.provider, sub: opts.sub, label: opts.label };
    this.sessions = this.#sweep();
    this.sessions[key] = rec;
    this.#save();
    return { id, rec };
  }

  resolve(sessionId: string): SessionRec | null {
    if (!sessionId) return null;
    const key = createHash("sha256").update(sessionId).digest("hex");
    const rec = this.sessions[key];
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) { delete this.sessions[key]; this.#save(); return null; }
    return rec;
  }

  listSessions(): Array<{ key: string; rec: SessionRec }> {
    this.sessions = this.#sweep();
    return Object.entries(this.sessions).map(([key, rec]) => ({ key, rec })).sort((a, b) => b.rec.createdAt - a.rec.createdAt);
  }

  revoke(key: string) {
    delete this.sessions[key];
    this.#save();
  }

  setOAuth(name: string, cfg: OAuthProviderCfg) {
    this.oauth[name] = cfg;
    this.#save();
  }

  removeOAuth(name: string) {
    delete this.oauth[name];
    this.#save();
  }
}

export function parseCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookieValue(id: string): string {
  return COOKIE_NAME + "=" + encodeURIComponent(id) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000);
}

export function clearCookieValue(): string {
  return COOKIE_NAME + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

/** sub resolution from common userInfo payloads (OIDC sub, GitHub id, email fallback). */
export function userInfoSub(json: any): string {
  if (!json) return "";
  const s = json.sub ?? json.id ?? json.user?.id ?? json.email ?? "";
  return String(s);
}
