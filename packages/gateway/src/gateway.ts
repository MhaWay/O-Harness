import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decode, encode, Methods, Msg, PROTOCOL_VERSION } from "@o-harness/protocol";
import { Bus, PluginHost, Registry, RpcRouter, SessionsStore, MemoryStore, PairingStore, GrantsStore, SCOPE_FOR_METHOD, publicDevice, atomicWrite, type DeviceRuntime, type GatewayApi, type Handler, type OHarnessPlugin } from "@o-harness/core";
import { SchedulerRuntime } from './scheduler.ts';
import { ToolBroker, type OfferedTool } from "./toolbroker.ts";
import { ensureOverlay } from "./overlay.ts";
import { SettingsStore, fetchProviderModels, chatOnce, EFFORTS, type Settings, type Effort } from "./models.ts";
import { WEBUI_HTML } from "./webui.ts";
import { AuthStore, parseCookie, sessionCookieValue, clearCookieValue, userInfoSub, COOKIE_NAME, type OAuthProviderCfg } from "./auth.ts";
import { runBackup, listBackups, restoreBackup } from "./backup.ts";
import { runDoctor } from "./doctor.ts";
import { LogStore } from "./log.ts";
import { AuditStore } from "./audit.ts";
import { logToolDefs, resolveLogs } from "./logtools.ts";
const UI_DIR = new URL("./ui/", import.meta.url);
import { MOBILE_HTML } from "./mobile.ts";
import { AgentRuntime } from "./agents.ts";
import { ChatRuntime } from "./chat.ts";
import { VoiceStore, voiceTts, voiceAsr, voiceProbe, type VoiceConfig } from "./voice.ts";
import { MonitorStore } from "./monitor.ts";
import { InstanceRegistry, listInstances, type InstanceInfo } from "./instances.ts";
import { ModelCache } from "./cache.ts";
import { MemoryConsolidator } from "./consolidation.ts";
import { resolveTls } from "./tls.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import type { Duplex } from "node:stream";

export interface GatewayConfig {
  host: string;
  port: number;
  token: string;
  plugins: string[];
  /** Overlay bootstrap: auto = tailscale for non-loopback (headless/remote), off on localhost. */
  overlay?: "auto" | "off" | "tailscale" | "zerotier";
  overlayAuthKey?: string;
  overlayNetId?: string;
  /** TLS: auto = self-signed generated on demand; off = plain HTTP. */
  tls?: "auto" | "off";
  /** Raw bootstrap token stays usable (default true). Set false to force password/oauth logins. */
  tokenEnabled?: boolean;
  /** Housekeeping: backups (default on, daily) and log pruning. */
  backup?: { enabled?: boolean; everyHours?: number; keep?: number };
  logsKeepDays?: number;
}

export const DEFAULT_PORT = 8710;

/** Minimal mark: dark rounded square, O ring, vertical spine (the harness). */
export const FAVICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
  + "<rect width='64' height='64' rx='14' fill='#0d1117'/>"
  + "<circle cx='32' cy='32' r='17' fill='none' stroke='#5ba0ff' stroke-width='7'/>"
  + "<rect x='29' y='20' width='6' height='24' rx='3' fill='#0d1117'/>"
  + "</svg>";

export function dataDirOf(dataDir?: string): string {
  return dataDir ?? join(homedir(), ".o-harness");
}
export function configFilePath(dataDir?: string): string {
  return join(dataDirOf(dataDir), "config.json");
}

export function isLoopbackHost(h: string): boolean {
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "";
}

export function loadConfig(dataDir?: string): { port: number; token: string; plugins: string[]; tokenEnabled?: boolean } {
  const file = configFilePath(dataDir);
  try {
    const j = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof j.token === "string") return { port: Number(j.port) || DEFAULT_PORT, token: j.token, plugins: Array.isArray(j.plugins) ? j.plugins : [], ...(j.tokenEnabled === false ? { tokenEnabled: false } : {}), ...(j.overlay ? { overlay: String(j.overlay) } : {}), ...(j.overlayAuthKey ? { overlayAuthKey: String(j.overlayAuthKey) } : {}), ...(j.overlayNetId ? { overlayNetId: String(j.overlayNetId) } : {}), ...(j.tls ? { tls: String(j.tls) as "auto" | "off" } : {}), ...(j.backup ? { backup: j.backup } : {}), ...(typeof j.logsKeepDays === "number" ? { logsKeepDays: j.logsKeepDays } : {}) };
  } catch { /* first run */ }
  const cfg = { port: DEFAULT_PORT, token: randomBytes(16).toString("hex"), plugins: [] as string[] };
  mkdirSync(dataDirOf(dataDir), { recursive: true, mode: 0o700 });
  atomicWrite(file, JSON.stringify(cfg, null, 2), 0o600);
  return cfg;
}

export function saveConfig(cfg: { port: number; token: string; plugins: string[] }, dataDir?: string) {
  mkdirSync(dataDirOf(dataDir), { recursive: true, mode: 0o700 });
  atomicWrite(configFilePath(dataDir), JSON.stringify(cfg, null, 2), 0o600);
}

export function resolvePlugins(cfg: { plugins: string[] }, explicit?: string[]): string[] {
  const list = explicit && explicit.length ? explicit : (cfg.plugins.length ? cfg.plugins : ["@o-harness/plugin-local"]);
  return list;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; conn?: WebSocket }

interface AuthCtx { admin?: boolean; deviceId?: string; sessionKey?: string }

export class Gateway {
  config: GatewayConfig;
  bus = new Bus();
  registry = new Registry();
  rpc = new RpcRouter();
  plugins = new PluginHost();
  log: LogStore;
  audit: AuditStore;
  sessions: SessionsStore;
  memory: MemoryStore;
  settings: SettingsStore;
  agents: AgentRuntime;
  chat: ChatRuntime;
  pairing: PairingStore;
  auth: AuthStore;
  voice: VoiceStore;
  monitor: MonitorStore;
  cache: ModelCache;
  #monitorTimer: ReturnType<typeof setInterval> | null = null;
  consolidator: MemoryConsolidator;
  grants: GrantsStore;
  tools: ToolBroker;
  scheduler: SchedulerRuntime;

  #server: Server | null = null;
  #clientSockets = new Set<WebSocket>();
  #wsCtx = new Map<WebSocket, AuthCtx>();
  #wssVoice = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  #deviceConns = new Map<string, WebSocket>();
  #dataDir = dataDirOf();
  instances: InstanceRegistry | null = null;
  #warnedOthers = false;
  #pairHits = new Map<string, { n: number; resetAt: number }>();
  #pending = new Map<string, Pending>();
  #wssNode = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  #wssClient = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  constructor(config: Partial<GatewayConfig> = {}, dataDir?: string) {
    const base = loadConfig(dataDir);
    this.#dataDir = dataDirOf(dataDir);
    this.sessions = new SessionsStore(dataDirOf(dataDir));
    this.memory = new MemoryStore(dataDirOf(dataDir));
    this.pairing = new PairingStore(dataDirOf(dataDir));
    this.log = new LogStore(join(dataDirOf(dataDir), "logs"));
    this.audit = new AuditStore(join(dataDirOf(dataDir), "audit"));
    this.auth = new AuthStore(join(dataDirOf(dataDir), "auth"));
    this.voice = new VoiceStore(join(dataDirOf(dataDir), "voice"));
    this.monitor = new MonitorStore(join(dataDirOf(dataDir), "monitor"));
    this.settings = new SettingsStore(dataDirOf(dataDir));
    this.cache = new ModelCache();
    this.consolidator = new MemoryConsolidator(this.memory, this.settings, this.cache);
    this.grants = new GrantsStore(dataDirOf(dataDir));
    this.tools = new ToolBroker(
      this.grants,
      (deviceId, tool, args) => this.#callDevice(deviceId, "tool.invoke", { tool, args }, 60_000),
      (topic, data) => this.#broadcastEvent(topic, data),
    );
    this.agents = new AgentRuntime({
      settings: this.settings,
      sessions: this.sessions,
      memory: this.memory,
      callDevice: (deviceId, method, params) => this.#callDevice(deviceId, method, params ?? {}),
      listDeviceTools: () => this.tools.list(),
      callTool: (deviceId, tool, args, requester) => this.tools.call(deviceId, tool, args ?? {}, requester ?? "minion"),
      onChange: (m) => {
        if (m.status === "error") this.log.error("agents", "minion " + m.id + " failed: " + String(m.error ?? ""));
        this.#broadcastEvent("agents.changed", { id: m.id, status: m.status, turnsUsed: m.turnsUsed, result: m.result, error: m.error });
      },
      storeDir: join(dataDirOf(dataDir), "minions"),
    });
    this.chat = new ChatRuntime({
      settings: this.settings,
      sessions: this.sessions,
      memory: this.memory,
      callDevice: (deviceId, method, params) => this.#callDevice(deviceId, method, params ?? {}),
      listDeviceTools: () => this.tools.list(),
      callTool: (deviceId, tool, args, requester) => this.tools.call(deviceId, tool, args ?? {}, requester),
      broadcast: (t, d) => this.#broadcastEvent(t, d),
    });
    this.scheduler = new SchedulerRuntime({
      storeDir: join(dataDirOf(dataDir), 'schedules'),
      chat: (sessionId, message) => this.chat.chat(sessionId || 'main', message),
      spawn: (task, opts) => this.agents.spawn(task, { title: opts.title }),
      broadcast: (t, d) => this.#broadcastEvent(t, d),
    });
    this.config = {
      host: config.host ?? "0.0.0.0",
      port: config.port ?? base.port,
      token: config.token ?? base.token,
      plugins: config.plugins ?? base.plugins,
      ...(config.overlay ?? base.overlay ? { overlay: (config.overlay ?? base.overlay) as GatewayConfig["overlay"] } : {}),
      ...(config.overlayAuthKey ?? base.overlayAuthKey ? { overlayAuthKey: (config.overlayAuthKey ?? base.overlayAuthKey) as string } : {}),
      ...(config.overlayNetId ?? base.overlayNetId ? { overlayNetId: (config.overlayNetId ?? base.overlayNetId) as string } : {}),
      ...(config.tls ?? base.tls ? { tls: (config.tls ?? base.tls) as "auto" | "off" } : {}),
      ...((config.backup ?? (base as { backup?: GatewayConfig["backup"] }).backup) ? { backup: (config.backup ?? (base as { backup?: GatewayConfig["backup"] }).backup) as GatewayConfig["backup"] } : {}),
      ...(config.logsKeepDays ?? (base as { logsKeepDays?: number }).logsKeepDays ? { logsKeepDays: (config.logsKeepDays ?? (base as { logsKeepDays?: number }).logsKeepDays) as number } : {}),
    };
  }

  #api(): GatewayApi {
    return {
      bus: this.bus,
      registerRpc: (method, handler) => this.rpc.set(method, handler),
      registerDevice: (dev) => {
        const full: DeviceRuntime = {
          id: dev.id ?? randomUUID().slice(0, 8),
          name: dev.name,
          kind: dev.kind,
          status: "connected",
          capabilities: dev.capabilities ?? [],
          conn: dev.conn,
          localHandler: dev.localHandler,
          meta: dev.meta,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
        };
        this.registry.register(full);
        this.#broadcastEvent("device.up", { deviceId: full.id, device: publicDevice(full) });
        return full;
      },
      unregisterDevice: (id) => { this.registry.remove(id); this.#broadcastEvent("device.down", { deviceId: id }); },
      emitEvent: (topic, data) => this.#broadcastEvent(topic, data),
      callDevice: (deviceId, method, params, timeoutMs) => this.#callDevice(deviceId, method, params, timeoutMs),
    };
  }

  async start() {
    this.agents.load();
    this.scheduler.start();
    this.#seedMonitorServices();
    this.#monitorTimer = setInterval(() => { void this.monitor.check((t, d) => this.#monitorBroadcast(t, d), this.log).catch(() => { /* probe errors are logged inside */ }) }, 30_000);
    void this.monitor.check((t, d) => this.#monitorBroadcast(t, d), this.log).catch(() => { /* noop */ });

    this.rpc.set(Methods.DevicesList, () => this.registry.listPublic());
    this.rpc.set(Methods.DeviceInfo, (p) => {
      const d = this.registry.get(String(p?.deviceId));
      if (!d) throw new Error("unknown device: " + String(p?.deviceId));
      return publicDevice(d);
    });
    this.rpc.set(Methods.DeviceExec, (p) =>
      this.#callDevice(p?.deviceId ?? "local", "exec", p, Number(p?.timeoutMs ?? 30_000)));
    this.rpc.set(Methods.DeviceFsRead, (p) => this.#callDevice(p?.deviceId ?? "local", "fs.read", p));
    this.rpc.set(Methods.DeviceFsWrite, (p) => this.#callDevice(p?.deviceId ?? "local", "fs.write", p));

    // sessions: persistent and shared across devices — all views the same log
    this.rpc.set(Methods.SessionsList, () => this.sessions.list().map((s) => { const full = this.sessions.get(String(s.id)); return { ...s, entryCount: full ? full.entries.length : 0, chat: (full?.entries.some((e) => e.kind === "chat") ?? false) }; }));
    this.rpc.set(Methods.SessionsCreate, (p) => {
      const title = typeof p?.title === "string" ? p.title : "session";
      const s = this.sessions.create(title, typeof p?.id === "string" ? p.id : undefined);
      this.#broadcastEvent("sessions.changed", { sessionId: s.id });
      return s;
    });
    this.rpc.set(Methods.SessionsGet, (p) => this.sessions.get(String(p?.id)) ?? null);
    this.rpc.set(Methods.SessionsAppend, (p) => {
      const entry = this.sessions.append(String(p?.id), {
        ts: Date.now(),
        from: String(p?.from ?? "unknown"),
        kind: String(p?.kind ?? "note"),
        data: p?.data,
      });
      this.#broadcastEvent("sessions.changed", { sessionId: String(p?.id), entry });
      return entry;
    });
    if (!this.sessions.get("main")) this.sessions.create("main", "main");

    // memory: ADD-only store, bitemporal, hybrid retrieval (see packages/core/src/memory.ts)
    this.rpc.set(Methods.MemoryAdd, (p) => {
      if (typeof p?.text !== "string" || !p.text.trim()) throw new Error("memory.add: text required");
      const m = this.memory.add({
        text: p.text,
        subject: p.subject, tags: p.tags, entities: p.entities, layer: p.layer,
        importance: p.importance, validFrom: p.validFrom, validUntil: p.validUntil,
        provenance: p.provenance ?? "client",
      }, { supersedeIds: Array.isArray(p.supersedes) ? p.supersedes.map(String) : [] });
      this.#broadcastEvent("memory.added", { id: m.id, subject: m.subject });
      return m;
    });
    this.rpc.set(Methods.MemorySearch, (p) => this.memory.search({
      query: p?.query ? String(p.query) : undefined,
      subject: p?.subject ? String(p.subject) : undefined,
      tags: Array.isArray(p?.tags) ? p.tags.map(String) : undefined,
      layer: p?.layer ? String(p.layer) : undefined,
      validity: p?.validity === "history" ? "history" : "now",
      limit: p?.limit ? Number(p.limit) : undefined,
    }).map((h) => ({ ...h.memory, score: Number(h.score.toFixed(4)), signals: h.signals })));
    this.rpc.set(Methods.MemoryList, (p) => this.memory.list({
      subject: p?.subject ? String(p.subject) : undefined,
      layer: p?.layer ? String(p.layer) : undefined,
      validity: p?.validity === "history" ? "history" : "now",
    }));

    // agents: minions — sub-agent employees that run a tool-calling loop per task
    this.rpc.set(Methods.AgentsSpawn, (p) => {
      const task = typeof p?.task === "string" ? p.task : "";
      if (!task.trim()) throw new Error("agents.spawn: task required");
      return this.agents.spawn(task, {
        title: p?.title ? String(p.title) : undefined,
        model: p?.model ? String(p.model) : undefined,
        effort: EFFORTS.includes(p?.effort) ? p.effort : undefined,
        maxTurns: p?.maxTurns ? Number(p.maxTurns) : undefined,
        dependsOn: Array.isArray(p?.dependsOn) ? p.dependsOn.map(String) : undefined,
      });
    });
    this.rpc.set(Methods.AgentsList, () => this.agents.list());
    this.rpc.set(Methods.AgentsGet, (p) => {
      const m = this.agents.get(String(p?.id));
      if (!m) return null;
      const s = this.sessions.get(m.sessionId);
      return { ...m, entries: s?.entries ?? [] };
    });
    this.rpc.set(Methods.AgentsKill, (p) => ({ ok: this.agents.kill(String(p?.id)) }));

    // chat: conversational interface on top of sessions (history + memory context)
    this.rpc.set(Methods.ChatSend, async (p) => {
      const sessionId = String(p?.sessionId ?? "main");
      const message = typeof p?.message === "string" ? (p.message as string) : String(p?.message ?? "");
      if (!message.trim()) throw new Error("chat.send: message required");
      return await this.chat.chat(sessionId, message, {
        effort: EFFORTS.includes(p?.effort) ? p.effort : undefined,
        model: p?.model ? String(p.model) : undefined,
      });
    });
    this.rpc.set(Methods.ChatHistory, (p) => {
      const s = this.sessions.get(String(p?.sessionId ?? "main"));
      if (!s) return null;
      const all = s.entries.filter((e) => e.kind === "chat");
      const map = (e: (typeof all)[number]) => { const t = (e.data as any).tools; const rz = (e.data as any).reasoning; const st = (e.data as any).steps; return { seq: e.seq, ts: e.ts, role: (e.data as any).role, text: (e.data as any).text, ...(t ? { tools: t } : {}), ...(st ? { steps: st } : {}), ...(rz ? { reasoning: rz } : {}) }; };
      // pagination: newest `limit` entries, or the window ending before `since` for "load earlier"
      const limit = p?.limit ? Math.max(1, Math.min(500, Number(p.limit))) : all.length || 1;
      const since = p?.since ? Number(p.since) : Infinity;
      const idx = all.findIndex((e) => e.seq >= since);
      const end = idx === -1 ? all.length : idx;
      const start = Math.max(0, end - limit);
      return all.slice(start, end).map(map);
    });

    // scheduler: time-triggered chat messages and minion runs
    this.rpc.set(Methods.ScheduleCreate, (p) => this.scheduler.create({
      label: p?.label ? String(p.label) : undefined,
      message: p?.message ? String(p.message) : undefined,
      task: p?.task ? String(p.task) : undefined,
      sessionId: p?.sessionId ? String(p.sessionId) : undefined,
      cadence: p?.cadence as any,
    }));
    this.rpc.set(Methods.ScheduleList, () => this.scheduler.list());
    this.rpc.set(Methods.ScheduleRemove, (p) => ({ ok: this.scheduler.remove(String(p?.id ?? "")) }));
    this.rpc.set(Methods.ScheduleRunNow, (p) => { const j = this.scheduler.runNow(String(p?.id ?? "")); return j ? { ok: true, id: j.id } : { ok: false, error: "unknown job" }; });
    this.rpc.set(Methods.ScheduleSetDisabled, (p) => ({ ok: this.scheduler.setDisabled(String(p?.id ?? ""), Boolean(p?.disabled)) }));

    // models & settings (GUI uses these; apiKey never returned by settings.get)
    this.rpc.set(Methods.SettingsGet, () => {
      const s = this.settings.get();
      return { ...s, providers: s.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***set***" : undefined })) };
    });
    this.rpc.set(Methods.SettingsSave, (p) => {
      // quick path: change only the default model / thinking effort (GUI pill dropdown)
      if (p && (p.modelId || p.effort !== undefined)) {
        const cur = this.settings.get();
        const curDef = cur.default ?? { providerId: "", modelId: "" };
        cur.default = { ...curDef, modelId: String(p.modelId ?? curDef.modelId), effort: (p.effort as Effort | undefined) ?? curDef.effort };
        this.settings.save(cur);
        this.#broadcastEvent("settings.changed", { default: cur.default });
        return { ok: true, default: cur.default };
      }
      const incoming = p?.settings as Settings | undefined;
      if (!incoming || !Array.isArray(incoming.providers)) throw new Error("settings.save: {settings:{providers:[...]}} required");
      const cur = this.settings.get();
      const byId = new Map(cur.providers.map((x) => [x.id, x]));
      incoming.providers = incoming.providers.map((inc) => {
        const old = byId.get(inc.id);
        if (inc.apiKey === "***set***" && old) inc.apiKey = old.apiKey;
        const any = inc as unknown as Record<string, unknown>;
        if (!any.baseUrl && typeof any.url === "string") { any.baseUrl = any.url; delete any.url; }
        if (!Array.isArray(inc.models)) {
          const ex = any.extra as Record<string, unknown> | undefined;
          if (ex && Array.isArray(ex.models)) inc.models = (ex.models as string[]).map((id) => ({ id }));
          else inc.models = [];
        }
        return inc;
      });
      this.settings.save(incoming);
      return { ok: true };
    });
    this.rpc.set(Methods.LogsTail, (p) => this.log.tail({ limit: p?.limit ? Number(p.limit) : 100, level: p?.level, module: p?.module, q: p?.q }));
    this.rpc.set(Methods.LogsStats, () => this.log.stats());
    this.rpc.set(Methods.LogsAudit, (p) => ({ events: this.audit.tail({ limit: p?.limit ? Number(p.limit) : 100, q: p?.q ? String(p.q) : undefined }) }));
    this.rpc.set(Methods.LogsResolve, async (p) => {
      const rq = p?.q ? String(p.q) : undefined;
      const lvl = p?.level ? String(p.level) as "debug" | "info" | "warn" | "error" : undefined;
      if (!this.sessions.get("logs-resolver")) this.sessions.create("logs-resolver", "logs-resolver");
      const hist = this.sessions.get("logs-resolver")!.entries.filter((e) => e.kind === "resolver").slice(-12);
      const prior = hist.flatMap((e) => { const d = e.data as { q?: string }; return [{ role: "user", content: d?.q ?? "log analysis" }, { role: "assistant", content: String((e.data as { analysis?: string }).analysis ?? "").slice(0, 900) }]; });
      const res = await resolveLogs(this.log, chatOnce, this.settings, { q: rq, level: lvl, history: prior }, this.cache);
      this.sessions.append("logs-resolver", { ts: Date.now(), from: "resolver", kind: "resolver", data: { q: rq ?? "(no focus)", level: lvl ?? "warn", analysis: res.analysis } });
      this.#broadcastEvent("sessions.changed", { sessionId: "logs-resolver" });
      return res;
    });
    this.rpc.set(Methods.MemoryConsolidate, (p) => this.consolidator.consolidate({ subject: p?.subject ? String(p.subject) : undefined, dryRun: Boolean(p?.dryRun) }));
    this.rpc.set(Methods.PairingCreate, (p) => {
      const c = this.pairing.createCode({ kind: String(p?.kind ?? "mobile"), scopes: Array.isArray(p?.scopes) ? p.scopes.map(String) : undefined, ttlMinutes: Number(p?.ttlMinutes) || undefined });
      this.#broadcastEvent("pairing.created", { code: c.code, expiresAt: c.expiresAt });
      return c;
    });
    this.rpc.set(Methods.PairingList, () => this.pairing.list().map((d) => ({ ...d, secret: undefined })));
    this.rpc.set(Methods.PairingRevoke, (p) => { this.pairing.revoke(String(p?.id ?? "")); this.audit.note("device.revoke", { id: String(p?.id ?? "") }); return { ok: true }; });
    // --- authentication methods (password / sessions / oauth) ---
    this.rpc.set(Methods.AuthInfo, () => ({
      hasPassword: !!this.auth.pw,
      tokenEnabled: this.config.tokenEnabled !== false,
      providers: Object.entries(this.auth.oauth).map(([name, c]) => ({ name, scopes: c.scopes, hasSubs: Array.isArray(c.subs) && c.subs.length > 0 })),
    }));
    this.rpc.set(Methods.AuthSetPassword, (p) => { this.auth.setPassword(String(p?.password ?? "")); return { ok: true }; });
    this.rpc.set(Methods.AuthLogin, (p, ctx) => {
      const pw = String(p?.password ?? "");
      if (!ctx.admin) {
        if (!this.auth.verify(pw)) throw new Error("wrong password");
      }
      const { id } = this.auth.newSession({ kind: "password", label: "rpc login" });
      return { ok: true, sessionId: id };
    });
    this.rpc.set(Methods.AuthLogout, (p, ctx) => {
      if (ctx.sessionKey && !p?.key) { this.auth.revoke(ctx.sessionKey); return { ok: true }; }
      if (p?.key && (ctx.admin || ctx.sessionKey)) { this.auth.revoke(String(p.key)); return { ok: true, byKey: true }; }
      throw new Error("current connection is not a login session");
    });
    this.rpc.set(Methods.AuthSessionsList, () => this.auth.listSessions().map((s) => ({ key: s.key, ...s.rec })));
    this.rpc.set(Methods.AuthSessionsRevoke, (p) => { this.auth.revoke(String(p?.key ?? "")); return { ok: true }; });
    this.rpc.set(Methods.AuthOAuthSet, (p) => {
      const name = String(p?.name ?? "").replace(/[^a-z0-9._-]/g, "");
      if (!name) throw new Error("oauth.set: name required");
      const cfg: OAuthProviderCfg = {
        clientId: String(p?.clientId ?? ""), clientSecret: String(p?.clientSecret ?? ""),
        authorizeUrl: String(p?.authorizeUrl ?? ""), tokenUrl: String(p?.tokenUrl ?? ""),
        userInfoUrl: String(p?.userInfoUrl ?? ""), scopes: String(p?.scopes ?? ""),
        subs: Array.isArray(p?.subs) ? p.subs.map(String) : [],
      };
      for (const k of ["authorizeUrl", "tokenUrl", "userInfoUrl"] as const) {
        if (!/^https?:\/\//.test(cfg[k])) throw new Error("oauth.set: bad " + k);
      }
      if (!cfg.clientId) throw new Error("oauth.set: clientId required");
      this.auth.setOAuth(name, cfg);
      return { ok: true };
    });
    this.rpc.set(Methods.AuthOAuthRemove, (p) => { this.auth.removeOAuth(String(p?.name ?? "")); return { ok: true }; });
    this.rpc.set(Methods.AuthSetTokenLogin, (p) => {
      // flip tokenEnabled in the gateway's own config file (loadConfig reads this on next start)
      const path = configFilePath(this.#dataDir);
      const cur = JSON.parse(readFileSync(path, "utf-8"));
      cur.tokenEnabled = Boolean(p?.enabled);
      atomicWrite(path, JSON.stringify(cur, null, 2), 0o600);
      this.config.tokenEnabled = cur.tokenEnabled;
      return { ok: true, tokenEnabled: cur.tokenEnabled };
    });
    // --- voice (LFM3 batch TTS/ASR + realtime relay) ---
    this.rpc.set(Methods.VoiceGet, () => this.voice.get());
    this.rpc.set(Methods.VoiceSave, (p) => {
      const saved = this.voice.save((p ?? {}) as Partial<VoiceConfig>);
      this.#broadcastEvent("voice.settings", saved);
      return saved;
    });
    this.rpc.set(Methods.VoiceSpeak, async (p) => {
      const text = String(p?.text ?? "").trim();
      if (!text) throw new Error("voice.speak: text required");
      const wav = await voiceTts(this.voice.get().tts.url, text);
      return { ok: true, format: "wav", audio: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64") };
    });
    this.rpc.set(Methods.VoiceAsr, async (p) => {
      const audio = String(p?.audio ?? "");
      if (!audio) throw new Error("voice.asr: audio (base64) required");
      const cfg = this.voice.get();
      const text = await voiceAsr(cfg.asr.url, audio, String(p?.language ?? cfg.asr.language));
      return { text };
    });
    this.rpc.set(Methods.VoiceProbe, () => voiceProbe(this.voice.get()));
    this.rpc.set(Methods.CacheStats, () => ({ ...this.cache.stats(), ttlMs: this.cache.ttlMs, maxEntries: this.cache.maxEntries }));
    this.rpc.set(Methods.CacheClear, () => ({ cleared: this.cache.clear() }));
    this.rpc.set(Methods.MonitorStatus, () => ({ services: this.monitor.services, statuses: this.monitor.lastStatus, lastCheckAt: this.monitor.lastCheckAt, openAlerts: this.monitor.alerts.filter((a) => a.state === "firing" && !a.acked).length, alerts: this.monitor.alerts.slice(0, 30) }));
    this.rpc.set(Methods.MonitorCheck, async () => await this.monitor.check((t, d) => this.#monitorBroadcast(t, d), this.log));
    this.rpc.set(Methods.MonitorAdd, (p) => this.monitor.addService(String(p?.name ?? "service"), (String(p?.kind ?? "http") as "http" | "ws" | "models"), String(p?.url ?? "")));
    this.rpc.set(Methods.MonitorRemove, (p) => ({ removed: this.monitor.removeService(String(p?.id ?? "")) }));
    this.rpc.set(Methods.MonitorEnable, (p) => ({ enabled: this.monitor.setEnabled(String(p?.id ?? ""), Boolean(p?.enabled)) }));
    this.rpc.set(Methods.AlertList, () => this.monitor.alerts.slice(0, 50));
    this.rpc.set(Methods.AlertAck, (p) => ({ acked: this.monitor.ackAlert(String(p?.id ?? "")) }));
    this.rpc.set(Methods.BackupRun, (p) => {
      const res = runBackup(this.#dataDir, { keep: Number(p?.keep) || undefined });
      this.#broadcastEvent("backup.done", { file: res.file, bytes: res.bytes });
      return res;
    });
    this.rpc.set(Methods.BackupList, () => ({ dir: join(this.#dataDir, "backups"), backups: listBackups(this.#dataDir) }));
    this.rpc.set(Methods.BackupRestore, (p) => {
      if (this.instances && this.instances.list().some((o) => o.pid !== process.pid)) throw new Error("restore requires a single gateway instance — stop the others first");
      const live = this.instances ? this.instances.list().length : 0;
      void live;
      const file = String(p?.file ?? "");
      if (!file) throw new Error("restore needs { file: path }");
      this.log.warn("backup", "restoring from " + file + " — restart required for stores to reload cleanly");
      this.audit.note("backup.restore", { file });
      return { ...restoreBackup(this.#dataDir, file, { dryRun: Boolean(p?.dryRun) }), restartRequired: true };
    });

    this.rpc.set(Methods.DoctorRun, async (p) => ({ checks: await runDoctor({ dataDir: this.#dataDir, deep: Boolean(p?.deep) }) }));

    // --- device-offered tools + authorization grants ---
    this.rpc.set(Methods.DeviceToolsOffer, (p, ctx) => {
      const deviceId = ctx.deviceId ?? "local"; // registered device socket; admin callers pass deviceId param
      const offered = (Array.isArray(p?.tools) ? p.tools : []) as OfferedTool[];
      const dev = String(p?.deviceId ?? deviceId);
      this.tools.offer(dev, offered);
      return { ok: true, deviceId: dev, count: offered.length };
    });
    this.rpc.set(Methods.DeviceToolsList, () => this.tools.list());
    this.rpc.set(Methods.DeviceToolsCall, (p) => this.tools.call(String(p?.deviceId ?? ""), String(p?.tool ?? ""), p?.args, "client"));
    this.rpc.set(Methods.ToolsPending, () => this.tools.pending());
    this.rpc.set(Methods.ToolsRespond, (p, ctx) =>
      ({ ok: this.tools.respond(String(p?.id ?? ""), Boolean(p?.approved), Boolean(p?.remember), { admin: ctx.admin, deviceId: ctx.deviceId }) }));
    this.rpc.set(Methods.GrantsList, (p) => this.tools.grantsFor(p?.deviceId ? String(p.deviceId) : undefined));
    this.rpc.set(Methods.GrantsRevoke, (p) => ({ ok: this.tools.revoke(String(p?.deviceId ?? ""), String(p?.tool ?? "")) }));
    this.rpc.set(Methods.ModelsFetch, (p) => fetchProviderModels(String(p?.baseUrl ?? ""), typeof p?.apiKey === "string" && p.apiKey !== "***set***" ? p.apiKey : undefined));
    this.rpc.set(Methods.ModelsTest, async (p) => {
      const ref = this.settings.resolveRef(String(p?.providerId ?? ""), String(p?.modelId ?? ""));
      if (!ref) throw new Error("unknown provider/model");
      const out = await chatOnce({
        baseUrl: ref.provider.baseUrl, apiKey: ref.provider.apiKey, model: ref.model.id,
        effort: (EFFORTS.includes(p?.effort) ? p.effort : "none") as Effort,
        messages: [{ role: "user", content: "ping — reply with just OK" }],
      });
      return { text: String(out?.choices?.[0]?.message?.content ?? "").trim(), usage: out?.usage };
    });
    this.rpc.set(Methods.SelfUpdate, async () => {
      const s = this.settings.get();
      if (!s.allowSelfUpdate) throw new Error("self-update disabled (settings.allowSelfUpdate=false)");
      const dir = s.repoDir ?? process.cwd();
      const { stdout, stderr } = await execFileP("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30_000 });
      return { dir, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 800) };
    });

    for (const spec of this.config.plugins) {
      const target = /^\.\//.test(spec) || spec.startsWith("/") ? pathToFileURL(resolve(process.cwd(), spec)).href : spec;
      const mod = (await import(target)) as { default?: OHarnessPlugin; plugin?: OHarnessPlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.setup !== "function") throw new Error("plugin '" + spec + "' has no default plugin export");
      this.plugins.register(plugin);
    }
    await this.plugins.setupAll(this.#api());
    this.log.info("gateway", "started", { port: this.config.port, host: this.config.host });
    this.instances = new InstanceRegistry(this.#dataDir, { pid: process.pid, port: this.config.port, host: this.config.host, mode: "local" });
    const others = this.instances.start();
    if (others.length) {
      const msg = "other gateway instance(s) are running against the same data dir: " + others.map((o) => "pid " + o.pid + " on port " + o.port).join(", ") + " — sessions/memory are shared and may conflict";
      this.log.warn("gateway", msg);
      this.#warnedOthers = true;
      console.warn("WARNING: " + msg);
    }

    this.#startHousekeeping();

    const tlsMat = resolveTls(this.config.tls, this.#dataDir);
    if (tlsMat && !tlsMat.key) this.bus.emit("log", { source: "tls", message: String(tlsMat.note ?? "tls material unavailable") });
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      // Baseline security headers on every response. The UI, mobile and legacy pages all use
      // inline scripts, so script-src must keep 'unsafe-inline'; everything else is locked down.
      // All UI assets are same-origin — cross-origin script execution is blocked by frame-ancestors
      // and object-src. An inline-script hash policy is a known follow-up (tracked in security notes).
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      // Mic is needed by the browser UI (dictation); every other capability is denied.
      res.setHeader("Permissions-Policy", "microphone=(self), camera=(), display-capture=(), geolocation=(), clipboard-read=(), clipboard-write=()");
      if (tlsMat && tlsMat.key) res.setHeader("Strict-Transport-Security", "max-age=31536000");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      const bodyChunks: Buffer[] = [];
      let bodyLen = 0;
      if (Number(req.headers["content-length"] ?? 0) > 1_048_576) { res.writeHead(413, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify({ ok: false, error: "body too large" })); if (req.socket) req.socket.destroySoon(); return; }
      req.on("data", (c: Buffer) => { bodyLen += c.length; if (bodyLen > 1_048_576) { if (!res.headersSent) { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "body too large" })); } if (res.socket) res.socket.end(); else req.destroy(); } else { bodyChunks.push(c); } });
      const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "local"));
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(readFileSync(new URL("index.html", UI_DIR), "utf8"));
        return;
      }
      if (url.pathname === "/legacy") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(WEBUI_HTML);
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        const name = url.pathname.slice("/assets/".length).replace(/[^a-z0-9.-]/g, "");
        const mime: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html" };
        try {
          const body = readFileSync(new URL(name, UI_DIR), "utf8");
          const ext = name.slice(name.lastIndexOf("."));
          const etag = "W/\"" + createHash("sha1").update(body).digest("hex").slice(0, 20) + "\"";
          const inm = req.headers["if-none-match"];
          if (inm === etag) { res.writeHead(304); res.end(); return; }
          const wantsGzip = /gzip/.test(String(req.headers["accept-encoding"] ?? ""));
          const payload = wantsGzip ? gzipSync(Buffer.from(body, "utf8")) : body;
          res.writeHead(200, {
            "content-type": (mime[ext] ?? "text/plain") + "; charset=utf-8",
            etag,
            "cache-control": "no-cache",
            ...(wantsGzip ? { "content-encoding": "gzip" } : {}),
          });
          res.end(payload);
        } catch {
          res.writeHead(404); res.end("not found");
        }
        return;
      }
      if (url.pathname === "/api/voice/tts") {
        const vctx = this.#checkAuth(req);
        if (!vctx) { res.writeHead(401); res.end(); return; }
        const text = url.searchParams.get("text") ?? "";
        if (!text.trim()) { res.writeHead(400); res.end("text required"); return; }
        voiceTts(this.voice.get().tts.url, text)
          .then((wav) => { res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" }); res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)); })
          .catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(String(e)); });
        return;
      }
      if (url.pathname === "/auth/info") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          hasPassword: !!this.auth.pw,
          tokenEnabled: this.config.tokenEnabled !== false,
          providers: Object.entries(this.auth.oauth).map(([name, c]) => ({ name, scopes: c.scopes, hasSubs: Array.isArray(c.subs) && c.subs.length > 0 })),
        }));
        return;
      }
      if (url.pathname === "/login" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += String(c); if (body.length > 64_000) req.destroy(); });
        req.on("end", async () => {
          const ip = (req.socket.remoteAddress ?? "?unknown").replace(/^::ffff:/, "");
          if (!this.#loginAllowed(ip)) {
            this.audit.note("login.limit", { ip });
            res.writeHead(429, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "too many login attempts, wait 5 minutes" }));
            return;
          }
          let pw = "";
          try { pw = String(JSON.parse(body || "{}").password ?? ""); } catch { pw = ""; }
          if (!this.auth.pw) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "no password configured yet (o-harness auth set-password)" }));
            return;
          }
          if (!this.auth.verify(pw)) {
            this.log.warn("auth", "failed login", { ip });
            this.audit.note("login.deny", { ip });
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "wrong password" }));
            return;
          }
          const { id } = this.auth.newSession({ kind: "password", label: "password login" });
          this.audit.note("login.ok", { ip });
          res.writeHead(200, { "content-type": "application/json", "set-cookie": sessionCookieValue(id) });
          res.end(JSON.stringify({ ok: true, sessionId: id }));
        });
        return;
      }
      if (url.pathname === "/logout") {
        res.writeHead(302, { location: "/", "set-cookie": clearCookieValue() });
        res.end();
        return;
      }
      if (url.pathname.startsWith("/oauth/") && url.pathname.endsWith("/start")) {
        const name = url.pathname.slice("/oauth/".length, -"/start".length).replace(/[^a-z0-9._-]/g, "");
        const cfg = this.auth.oauth[name];
        if (!cfg) { res.writeHead(404); res.end("unknown oauth provider"); return; }
        const state = randomBytes(16).toString("hex");
        const redir = (req.headers["x-oh-redirect"] ?? "").toString().slice(0, 200) || "/";
        const u = new URL(cfg.authorizeUrl);
        u.searchParams.set("client_id", cfg.clientId);
        u.searchParams.set("redirect_uri", "http://" + (req.headers.host ?? "localhost") + "/oauth/" + name + "/callback");
        u.searchParams.set("response_type", "code");
        u.searchParams.set("scope", cfg.scopes);
        u.searchParams.set("state", state);
        res.writeHead(302, { location: u.toString(), "set-cookie": "oh_oauth_state_" + name + "=" + state + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=600" });
        res.end();
        return;
      }
      if (url.pathname.startsWith("/oauth/") && url.pathname.endsWith("/callback")) {
        const name = url.pathname.slice("/oauth/".length, -"/callback".length).replace(/[^a-z0-9._-]/g, "");
        const cfg = this.auth.oauth[name];
        const code = url.searchParams.get("code") ?? "";
        const stateQ = url.searchParams.get("state") ?? "";
        const stateC = parseCookie(req.headers.cookie, "oh_oauth_state_" + name) ?? "";
        if (!cfg) { res.writeHead(404); res.end("unknown oauth provider"); return; }
        if (!code || !stateQ || stateQ !== stateC) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad oauth state or missing code" }));
          return;
        }
        (async () => {
        try {
          const tokRes = await fetch(cfg.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: "http://" + (req.headers.host ?? "localhost") + "/oauth/" + name + "/callback" }).toString(),
          });
          const tokJson: any = await tokRes.json().catch(() => null);
          const access = String(tokJson?.access_token ?? "");
          if (!access) throw new Error("no access_token from provider");
          const uiRes = await fetch(cfg.userInfoUrl, { headers: { authorization: "Bearer " + access, accept: "application/json" } });
          const uiJson: any = await uiRes.json().catch(() => null);
          const sub = userInfoSub(uiJson);
          if (!sub) throw new Error("provider returned no user id");
          if (Array.isArray(cfg.subs) && cfg.subs.length > 0 && !cfg.subs.includes(sub)) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "user " + sub + " is not allowed on this gateway" }));
            return;
          }
          const { id } = this.auth.newSession({ kind: "oauth", provider: name, sub, label: name + ":" + sub });
          res.writeHead(302, { location: "/", "set-cookie": [sessionCookieValue(id), "oh_oauth_state_" + name + "=; Max-Age=0; Path=/"] });
          res.end();
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "oauth exchange failed: " + String((err as Error)?.message ?? err) }));
        }
        })();
        return;
      }
      if (url.pathname === "/pair" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += String(c); if (body.length > 10_000) req.destroy(); });
        req.on("end", () => {
          const ip = (req.socket.remoteAddress ?? "?unknown").replace(/^::ffff:/, "");
          if (!this.#pairAllowed(ip)) {
            res.writeHead(429, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "too many pairing attempts, try again later" }));
            return;
          }
          try {
            const { code, name } = JSON.parse(body || "{}") as { code?: string; name?: string };
            const { device, secret } = this.pairing.redeem(String(code ?? ""), String(name ?? "device"));
            this.audit.note("pair.redeem", { ip, deviceId: device.id });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, deviceId: device.id, secret }));
          } catch (err) {
            this.audit.note("pair.deny", { ip, error: err instanceof Error ? err.message : String(err) });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            try { this.pairing.noteBadCode(String(JSON.parse(body || "{}").code ?? "")); } catch { /* noop */ }
          }
        });
        return;
      }
      if (url.pathname === "/m" || url.pathname === "/m/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        try { res.end(readFileSync(new URL("mobile.html", UI_DIR), "utf8")); }
        catch { res.end(MOBILE_HTML); }
        return;
      }
      if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        res.end(FAVICON_SVG);
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(encode({ ok: true, mode: "local", protocol: PROTOCOL_VERSION, port: this.config.port, pid: process.pid, others: listInstances(this.#dataDir).filter((o) => o.pid !== process.pid).length }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    };
    const server = (tlsMat && tlsMat.key) ? createSecureServer({ key: tlsMat.key, cert: tlsMat.cert }, handler) : createServer(handler);
    server.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
    // overlay bootstrap: "auto" (default) enables tailscale on non-loopback binds (headless/remote servers)
    const wantOv = this.config.overlay ?? "auto";
    if ((wantOv === "auto" && !isLoopbackHost(this.config.host)) || (wantOv !== "auto" && wantOv !== "off")) {
      const kind = wantOv === "auto" ? "tailscale" : wantOv as "tailscale" | "zerotier";
      const ov = await ensureOverlay(kind, { log: (m) => this.bus.emit("log", { source: "overlay", message: m }), authKey: this.config.overlayAuthKey, netId: this.config.overlayNetId });
      if (ov.notes.length) this.bus.emit("log", { source: "overlay", message: ov.notes.join("; ") });
    }
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(this.config.port, this.config.host, () => res());
    });
    this.#server = server;
  }

    /** Seed sensible probes once: each models provider + batch voice endpoint. */
  #seedMonitorServices(): void {
    if (this.monitor.services.length) return;
    for (const p of this.settings.get().providers) {
      this.monitor.addService(p.name || p.id, "models", p.baseUrl);
    }
    const v = this.voice.get();
    if (v?.tts?.url) this.monitor.addService("Voice batch (LFM3)", "http", v.tts.url + "/health");
    this.monitor.save();
  }

  #houseTimer: ReturnType<typeof setTimeout> | null = null;
  #backupInFlight = false;

  /** Periodic housekeeping: prune old logs, then a data-dir backup (keeps N newest). */
  #startHousekeeping() {
    const run = () => {
      if (this.#backupInFlight) return;
      this.#backupInFlight = true;
      try {
        const days = this.config.logsKeepDays ?? 0;
        if (days > 0) { const n = this.log.prune(days); if (n) this.log.info("housekeeping", "pruned " + n + " log file(s) older than " + days + " days"); }
        const bk = this.config.backup;
        if (!bk || bk.enabled !== false) {
          const res = runBackup(this.#dataDir, { keep: bk.keep ?? 14 });
          this.log.info("housekeeping", "backup " + res.files + " files -> " + res.file + " (" + res.bytes + " bytes)");
          this.#broadcastEvent("backup.done", { file: res.file, bytes: res.bytes });
        }
      } catch (err) {
        this.log.warn("housekeeping", "housekeeping failed: " + String((err as Error).message ?? err));
      } finally {
        this.#backupInFlight = false;
      }
    };
    if (this.#houseTimer) clearTimeout(this.#houseTimer);
    const every = Math.max(1, this.config.backup?.everyHours ?? 24) * 3600_000;
    const tick = () => { run(); this.#houseTimer = setTimeout(tick, every); this.#houseTimer.unref(); };
    this.#houseTimer = setTimeout(tick, 3600_000);
    this.#houseTimer.unref();
  }

  async stop() {
    if (this.#monitorTimer) { clearInterval(this.#monitorTimer); this.#monitorTimer = null; }
    if (this.instances) { this.instances.stop(); this.instances = null; }
    await this.plugins.teardownAll();
    for (const d of this.registry.all()) { if (d.conn) { try { (d.conn as WebSocket).close(); } catch { /* noop */ } } }
    for (const ws of [...this.#clientSockets]) { try { ws.close(); } catch { /* noop */ } }
    this.log.info("gateway", "stopped");
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  #checkAuth(req: IncomingMessage): AuthCtx | null {
    const url = new URL(req.url ?? "/", "http://local");
    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const token = url.searchParams.get("token") || bearer;
    if (this.config.tokenEnabled !== false && token === this.config.token) return { admin: true };
    const cookie = parseCookie(req.headers.cookie, COOKIE_NAME);
    const sessQ = url.searchParams.get("session") || "";
    const sessId = cookie || sessQ;
    if (sessId && this.auth.resolve(sessId)) return { admin: true, sessionKey: createHash("sha256").update(sessId).digest("hex") };
    const secret = url.searchParams.get("secret") || "";
    const paired = this.pairing.auth(secret);
    if (paired) return { deviceId: paired.id };
    return null;
  }

  #loginAllowed(ip: string): boolean {
    const now = Date.now();
    const rec = this.#pairHits.get("login:" + ip);
    if (!rec || now > rec.resetAt) { this.#pairHits.set("login:" + ip, { n: 1, resetAt: now + 300_000 }); return true; }
    rec.n++;
    return rec.n <= 12;
  }


  #pairAllowed(ip: string): boolean {
    const now = Date.now();
    const rec = this.#pairHits.get(ip);
    if (!rec || now > rec.resetAt) { this.#pairHits.set(ip, { n: 1, resetAt: now + 300_000 }); return true; }
    rec.n++;
    return rec.n <= 20;
  }

  #checkScope(ctx: AuthCtx | undefined, method: string) {
    if (!ctx || ctx.admin || !ctx.deviceId) return;
    const required = SCOPE_FOR_METHOD[method] ?? "*"; // unmapped = fail-closed (admin ctx returns above)
    const granted = this.pairing.scopesFor(ctx.deviceId);
    // hierarchy: admin satisfies write, write satisfies read
    const need = required === "write" ? ["write", "admin"] : required === "read" ? ["read", "write", "admin"] : [required];
    if (required === "*" || !granted.some((s) => need.includes(s))) {
      this.audit.note("scope.deny", { deviceId: ctx.deviceId, method, required });
      throw new Error("device " + ctx.deviceId + " lacks scope '" + required + "' for " + method);
    }
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const auth = this.#checkAuth(req);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/node") {
      this.#wssNode.handleUpgrade(req, socket, head, (ws) => { this.#wsCtx.set(ws, auth); this.#onNodeSocket(ws); });
    } else if (url.pathname === "/api") {
      this.#wssClient.handleUpgrade(req, socket, head, (ws) => { this.#wsCtx.set(ws, auth); this.#onClientSocket(ws); });
    } else if (url.pathname === "/voice") {
      this.#wssVoice.handleUpgrade(req, socket, head, (ws) => { this.#voiceRelay(ws); });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  /** Bidirectional pipe between browser and the LFM3 realtime server. */
  #voiceRelay(ws: WebSocket) {
    const cfg = this.voice.get();
    if (!cfg.realtime.enabled) {
      try { ws.close(1013, "realtime voice disabled"); } catch { /* noop */ }
      return;
    }
    let upstream: WebSocket;
    try { upstream = new WebSocket(cfg.realtime.url); } catch { try { ws.close(1011, "bad realtime url"); } catch { /* noop */ } return; }
    let closed = false;
    const queue: Array<[Buffer, boolean]> = [];
    const flush = () => { for (const [b, isBin] of queue) { if (upstream.readyState === WebSocket.OPEN) upstream.send(b, { binary: isBin }); } queue.length = 0; };
    upstream.on("open", flush);
    const done = () => { if (closed) return; closed = true; try { ws.close(); } catch { /* noop */ } try { upstream.close(); } catch { /* noop */ } };
    ws.on("message", (raw: Buffer, isBinary: boolean) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(raw, { binary: isBinary }); else queue.push([raw as Buffer, !!isBinary]); });
    ws.on("close", done);
    ws.on("error", done);
    upstream.on("message", (raw: Buffer, isBinary: boolean) => { if (ws.readyState === WebSocket.OPEN) ws.send(raw, { binary: isBinary }); });
    upstream.on("close", done);
    upstream.on("error", () => { try { ws.close(1011, "realtime server error"); } catch { /* noop */ } done(); });
    setTimeout(() => { if (upstream.readyState !== WebSocket.OPEN) { try { ws.close(1013, "realtime server unreachable"); } catch { /* noop */ } done(); } }, 4000);
  }

  #onNodeSocket(ws: WebSocket) {
    let device: DeviceRuntime | undefined;
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (!msg) return;
      if (msg.type === Msg.Hello) {
        device = this.#registerNode(device, msg, ws);
        return;
      }
      if (msg.type === Msg.RpcRes) {
        const id = String(msg.id);
        const p = this.#pending.get(id);
        if (p) {
          this.#pending.delete(id);
          clearTimeout(p.timer);
          if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.type === Msg.RpcReq) {
        const ctx = this.#wsCtx.get(ws) ?? {};
        this.#callScoped(String(msg.method), msg.params, ctx).then((result) => {
          ws.send(encode({ type: Msg.RpcRes, id: msg.id, result }));
        }).catch((err) => {
          ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) }));
        });
      }
    });
    ws.on("close", () => { this.#wsCtx.delete(ws); const d = device ?? this.#deviceByConn(ws); if (d) this.#markOffline(d.id); });
    ws.on("error", () => { /* close handles it */ });
  }

  #deviceByConn(conn: WebSocket): DeviceRuntime | undefined {
    return this.registry.all().find((d) => d.conn === conn);
  }

  #registerNode(current: DeviceRuntime | undefined, msg: Record<string, unknown>, ws: WebSocket): DeviceRuntime {
    const id = typeof msg.deviceId === "string" && msg.deviceId ? msg.deviceId : (current?.id ?? randomUUID().slice(0, 8));
    const dev: DeviceRuntime = {
      id,
      name: typeof msg.name === "string" ? msg.name : "node",
      kind: msg.kind === "mobile" ? "mobile" : "remote",
      status: "connected",
      capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [],
      conn: ws,
      meta: { hostname: typeof msg.hostname === "string" ? msg.hostname : undefined, platform: typeof msg.platform === "string" ? msg.platform : undefined },
      addresses: Array.isArray(msg.addresses) ? msg.addresses.map(String) : [],
      connectedAt: current?.connectedAt ?? Date.now(),
      lastSeen: Date.now(),
    };
    this.registry.register(dev);
    if (Array.isArray(msg.tools) && msg.tools.length) {
      this.tools.offer(dev.id, msg.tools as { name: string; description?: string; parameters?: Record<string, unknown> }[]);
    }
    const ctx = this.#wsCtx.get(ws);
    if (ctx && !ctx.admin && ctx.deviceId) {
      this.pairing.touch(ctx.deviceId);
      dev.meta = { ...dev.meta, paired: true };
    }
    this.#broadcastEvent("device.up", { deviceId: dev.id, device: publicDevice(dev) });
    ws.send(encode({ type: Msg.Welcome, ok: true, nodeId: dev.id, protocol: PROTOCOL_VERSION }));
    return dev;
  }

  #markOffline(id: string) {
    const d = this.registry.get(id);
    if (d && d.status !== "offline") {
      d.status = "offline";
      d.lastSeen = Date.now();
      this.#broadcastEvent("device.down", { deviceId: id });
    }
  }

  #callScoped(method: string, params: unknown, ctx: AuthCtx): Promise<unknown> {
    try { this.#checkScope(ctx, method); } catch (e) { return Promise.reject(e); }
    return this.rpc.call(method, params, { deviceId: ctx.admin ? undefined : ctx.deviceId, admin: ctx.admin, sessionKey: ctx.sessionKey });
  }

  #onClientSocket(ws: WebSocket) {
    this.#clientSockets.add(ws);
    const ctx = this.#wsCtx.get(ws) ?? {};
    // Paired clients (e.g. phones) register as devices so tools/devices can reach them.
    if (!ctx.admin && ctx.deviceId) {
      this.#deviceConns.set(ctx.deviceId, ws);
      const existing = this.registry.get(ctx.deviceId);
      if (!existing) {
        this.registry.register({ id: ctx.deviceId, name: "mobile", kind: "mobile", status: "connected", capabilities: ["tools"], conn: ws, meta: { paired: true }, connectedAt: Date.now(), lastSeen: Date.now() });
        const reg = this.registry.get(ctx.deviceId);
        if (reg) this.#broadcastEvent("device.up", { deviceId: reg.id, device: publicDevice(reg) });
      } else {
        // Reconnect: the old conn is stale — rebind it or calls would hit the dead socket.
        existing.conn = ws;
        this.#markOnline(ctx.deviceId);
      }
    }
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (!msg || typeof msg.id !== "string") return;
      if (msg.type === Msg.RpcRes) {
        const p = this.#pending.get(String(msg.id));
        if (p) {
          this.#pending.delete(String(msg.id));
          clearTimeout(p.timer);
          if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.type !== Msg.RpcReq) return;
      const c = this.#wsCtx.get(ws) ?? {};
      this.#callScoped(String(msg.method), msg.params, c).then((result) => {
        ws.send(encode({ type: Msg.RpcRes, id: msg.id, result }));
      }).catch((err) => {
        this.log.warn("rpc", String(msg.method) + " failed: " + (err instanceof Error ? err.message : String(err)));
        ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) }));
      });
    });
    ws.on("close", () => {
      this.#clientSockets.delete(ws); this.#wsCtx.delete(ws);
      const d = this.#wsCtx.get(ws);
      const id = (ctx.deviceId && this.#deviceConns.get(ctx.deviceId) === ws) ? ctx.deviceId : undefined;
      if (id) { this.#deviceConns.delete(id); this.tools.forget(id); this.#markOffline(id); }
      if (d) void d;
    });
    ws.on("error", () => { /* noop */ });
  }

  #markOnline(id: string) {
    const d = this.registry.get(id);
    if (d && d.status !== "connected") {
      d.status = "connected";
      d.lastSeen = Date.now();
      this.#broadcastEvent("device.up", { deviceId: id, device: publicDevice(d) });
    }
  }

  async #callDevice(deviceId: string, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const dev = this.registry.get(deviceId);
    if (!dev) throw new Error("unknown device: " + deviceId);
    if (dev.kind === "remote" && dev.addresses?.length) {
      const viaDirect = await this.#tryDirect(dev, method, params, timeoutMs);
      if (viaDirect !== undefined) return viaDirect;
    }
    if (dev.conn) { dev.meta = { ...dev.meta, transport: "gateway" }; return await this.#callRemote(dev, method, params, timeoutMs); }
    if (dev.localHandler) return await dev.localHandler(method, params);
    throw new Error("device " + deviceId + " is not reachable");
  }

  #callRemote(dev: DeviceRuntime, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const ws = dev.conn as WebSocket | undefined;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        rejectPromise(new Error("device " + dev.id + " is not connected"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error("device call timed out (" + timeoutMs + "ms): " + method));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      ws.send(encode({ type: Msg.RpcReq, id, method, params }));
    });
  }

  /** Prefer the direct (LAN/tailscale) channel when reachable; probe is cached to keep calls fast. */
  async #tryDirect(dev: DeviceRuntime, method: string, params: unknown, timeoutMs: number): Promise<unknown | undefined> {
    const d = dev.direct as WebSocket | undefined;
    if (d && d.readyState === WebSocket.OPEN) {
      try {
        const result = await this.#wsCall(d, method, params, timeoutMs);
        dev.meta = { ...dev.meta, transport: "direct" };
        return result;
      } catch (err) {
        const message = String(err);
        dev.meta = { ...dev.meta, transport: "gateway", directError: message };
      }
    } else {
      const failAt = typeof dev.meta?.probeFailAt === "number" ? dev.meta.probeFailAt : 0;
      if (Date.now() - failAt < 15_000) return undefined; // keep probing off, fall back to gateway channel
      const probed = await this.#probeDirect(dev);
      if (!probed) {
        dev.meta = { ...dev.meta, probeFailAt: Date.now() };
        return undefined;
      }
    }
    return undefined;
  }

  #probeDirect(dev: DeviceRuntime): Promise<WebSocket | undefined> {
    return new Promise((res) => {
      const addrs = dev.addresses ?? [];
      let i = 0;
      const next = (): void => {
        for (;;) {
          if (i >= addrs.length) { res(undefined); return; }
          const url = addrs[i++]!;
          const ws = new WebSocket(url + "?token=" + encodeURIComponent(this.config.token));
          let done = false;
          const giveUp = () => {
            if (done) return;
            done = true;
            clearTimeout(t);
            try { ws.close(); } catch { /* noop */ }
            next();
          };
          const t = setTimeout(giveUp, 1200);
          ws.on("open", () => {
            if (done) return;
            done = true;
            clearTimeout(t);
            ws.on("error", () => { this.#closeDirect(dev); });
            ws.on("close", () => { this.#closeDirect(dev); });
            dev.direct = ws;
            dev.meta = { ...dev.meta, transport: "direct" };
            ws.on("message", (raw2: Buffer | string) => this.#routeDirectRes(raw2));
            res(ws);
          });
          ws.on("error", giveUp);
        }
      };
      next();
    });
  }

  /** Responses arriving on a direct socket: resolve the matching pending call. */
  #routeDirectRes(raw: Buffer | string) {
    const msg = decode(String(raw));
    if (!msg || msg.type !== Msg.RpcRes) return;
    const id = String(msg.id);
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
  }

  #closeDirect(dev: DeviceRuntime) {
    const d = dev.direct as WebSocket | undefined;
    dev.direct = undefined;
    if (d) { try { d.close(); } catch { /* noop */ } }
  }

  #wsCall(conn: WebSocket, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (conn.readyState !== WebSocket.OPEN) { rejectPromise(new Error("direct channel not open")); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error("direct call timed out (" + timeoutMs + "ms): " + method));
      }, timeoutMs);
      // reuse the pending map keyed by unique id; socket chosen by send target
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, conn });
      conn.send(encode({ type: Msg.RpcReq, id, method, params }));
    });
  }

  #broadcastEvent(topic: string, data?: unknown) {
    const payload = encode({ type: Msg.Event, topic, data });
    for (const ws of this.#clientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /**
   * Monitor events go out live, and also leave a durable trail in a dedicated
   * `alerts` session so notifications are never lost when nobody is watching.
   */
  #monitorBroadcast(topic: string, data: unknown) {
    this.#broadcastEvent(topic, data);
    if (topic !== "alert.fired" && topic !== "alert.resolved") return;
    const a = data as { id?: string; name?: string; state?: string; detail?: string };
    try {
      if (!this.sessions.get("alerts")) this.sessions.create("alerts", "alerts");
      const entry = this.sessions.append("alerts", {
        ts: Date.now(),
        from: "monitor",
        kind: "alert",
        data: { state: topic === "alert.fired" ? "firing" : "resolved", name: String(a?.name ?? ""), detail: String(a?.detail ?? ""), alertId: String(a?.id ?? "") },
      });
      this.#broadcastEvent("sessions.changed", { sessionId: "alerts", entry });
    } catch { /* never let notification routing break a probe cycle */ }
  }
}

export function createDefaultGateway(opts: Partial<GatewayConfig> = {}, dataDir?: string): Gateway {
  const cfg = loadConfig(dataDir);
  const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  return new Gateway({ ...cfg, plugins: resolvePlugins(cfg), ...clean } as Partial<GatewayConfig>, dataDir);
}
