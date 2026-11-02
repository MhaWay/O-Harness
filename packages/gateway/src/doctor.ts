/**
 * o-h doctor: one-shot health self-check, runnable with or without a live gateway.
 * Checks are independent; one failing never blocks the others.
 */
import { statfsSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { hostname } from "node:os";
import { dataDirOf, loadConfig, configFilePath } from "./gateway.ts";
import { listInstances } from "./instances.ts";
import { listBackups } from "./backup.ts";

export interface DoctorCheck { name: string; ok: boolean; detail: string; hint?: string }

function tcpOk(host: string, port: number, ms = 1200): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); });
    s.on("error", () => { clearTimeout(t); res(false); });
  });
}

async function httpJson(url: string, ms = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function chatOnceLight(url: string, model: string): Promise<boolean> {
  try {
    const { chatOnce } = await import("./models.ts");
    const r = await chatOnce({ baseUrl: url, model, messages: [{ role: "user", content: "reply with the single word OK" }], effort: "none" });
    return String(r?.text ?? "").toUpperCase().includes("OK");
  } catch { return false; }
}

function readdirNames(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Full self-check (deep = real model round-trip). */
export async function runDoctor(opts: { dataDir?: string; deep?: boolean } = {}): Promise<DoctorCheck[]> {
  const dataDir = dataDirOf(opts.dataDir);
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, hint?: string) => checks.push({ name, ok, detail, hint });

  let cfg: { port: number; token: string } | null = null;
  try { cfg = loadConfig(opts.dataDir); add("config", true, configFilePath(opts.dataDir)); } catch (e) { add("config", false, String((e as Error).message ?? e)); }

  // live instances first (their port overrides config), then config port as fallback
  const inst = listInstances(dataDir);
  const ports = [...new Set([18711, cfg?.port ?? 8710, ...inst.map((i) => Number(i.port)).filter((n) => Number.isFinite(n))])];
  let health: Record<string, unknown> | null = null;
  let livePort = 0;
  for (const pt of ports) {
    if (!(await tcpOk("127.0.0.1", pt, 600))) continue;
    try {
      health = (await httpJson("http://127.0.0.1:" + pt + "/health", 2000)) as Record<string, unknown>;
      livePort = pt;
      break;
    } catch { /* reachable but not a gateway */ }
  }
  add("gateway", !!health, health ? "port " + livePort + " healthy (pid " + String(health.pid) + ")" : "no gateway answering /health on ports " + ports.join(","), health ? undefined : "start it with: o-h gateway start --port 18711");

  add("instances", inst.length <= 1, inst.length + " live instance(s)" + (inst.length > 1 ? " sharing " + dataDir : ""), inst.length > 1 ? "duplicate gateways split sessions/memory - kill the extras" : undefined);

  try {
    const probe = join(dataDir, ".doctor-probe-" + process.pid);
    writeFileSync(probe, "x"); rmSync(probe);
    const st = statfsSync(dataDir);
    const freeGB = Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 / 1024 / 1024);
    add("disk", freeGB > 1, "writable " + dataDir + ", " + freeGB + " GB free", freeGB <= 1 ? "under 1 GB free - backups and sessions may fail" : undefined);
  } catch (e) { add("disk", false, String((e as Error).message ?? e)); }

  const settingsFile = join(dataDir, "settings.json");
  let settings: { providers?: Array<{ id?: string; name?: string; url?: string; baseUrl?: string; models?: Array<{ id?: string }> }>; default?: { providerId?: string } } | null = null;
  try { if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch { /* unreadable */ }
  const providers = settings?.providers ?? [];
  if (!providers.length) {
    add("models", false, "no providers configured", "add one in Settings (browser) - chat features are unusable without a model");
  } else {
    for (const p of providers) {
      const base = String(p.baseUrl ?? p.url ?? "").replace(/\/+$/, "");
      if (!base) { add("models:" + String(p.id ?? p.name), false, "missing url"); continue; }
      let ok = false; let n = 0; let why = "";
      try { const j = (await httpJson(/\/v\d+$/.test(base) ? base + "/models" : base + "/v1/models", 4000)) as { data?: unknown[] }; n = Array.isArray(j.data) ? j.data.length : 0; ok = true; } catch (e) { why = String((e as Error).message ?? e); }
      const def = settings?.default?.providerId === (p.id ?? "") || providers.length === 1;
      if (ok && def && opts.deep) {
        const m = String(p.models?.[0]?.id ?? "");
        const rt = m ? await chatOnceLight(base, m) : false;
        add("models:" + String(p.id ?? p.name), rt, rt ? "round-trip ok (" + n + " models)" : "reachable (" + n + " models) but round-trip failed", "check model name and GPU memory");
      } else {
        add("models:" + String(p.id ?? p.name), ok, (ok ? n + " models served" : why) + (def ? " (default)" : ""));
      }
    }
  }

  const voiceFile = join(dataDir, "voice.json");
  let voice: { tts?: { url?: string } } | null = null;
  try { if (existsSync(voiceFile)) voice = JSON.parse(readFileSync(voiceFile, "utf-8")); } catch { /* unreadable */ }
  if (voice?.tts?.url) {
    let p2 = "8023";
    try { p2 = new URL(voice.tts.url).port || "8023"; } catch { /* not a url */ }
    const up = await tcpOk("127.0.0.1", Number(p2) || 8023);
    add("voice", up, "tts " + voice.tts.url + (up ? " reachable" : " refused"), up ? undefined : "start the LFM3 batch server or disable voice in Settings");
  } else {
    add("voice", true, "voice disabled or not configured");
  }

  const tlsDir = join(dataDir, "tls");
  if (existsSync(tlsDir)) {
    const files = readdirNames(tlsDir);
    add("tls", files.length > 0, files.length ? "material present (" + files.join(", ") + ")" : "empty dir");
  } else {
    add("tls", true, "not generated yet (auto mode creates on demand)");
  }

  const bks = listBackups(dataDir);
  const newestAgeH = bks.length ? Math.round((Date.now() - Number(bks[0].mtime ?? 0)) / 3600000) : -1;
  add("backups", bks.length > 0 && newestAgeH < 30, bks.length ? bks.length + " archive(s), newest " + newestAgeH + "h old" : "no backups yet", bks.length ? (newestAgeH >= 30 ? "backups are stale - check housekeeping logs" : undefined) : "run: o-h backup run");

  add("runtime", true, "node " + process.version + " on " + hostname());

  return checks;
}