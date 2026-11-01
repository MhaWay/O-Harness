import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decode, encode, Methods, Msg, PROTOCOL_VERSION } from "@o-harness/protocol";
import { Bus, PluginHost, Registry, RpcRouter, SessionsStore, MemoryStore, PairingStore, GrantsStore, SCOPE_FOR_METHOD, publicDevice, type DeviceRuntime, type GatewayApi, type Handler, type OHarnessPlugin } from "@o-harness/core";
import { SchedulerRuntime } from './scheduler.ts';
import { ToolBroker, type OfferedTool } from "./toolbroker.ts";
import { ensureOverlay } from "./overlay.ts";
import { SettingsStore, fetchProviderModels, chatOnce, EFFORTS, type Settings, type Effort } from "./models.ts";
import { WEBUI_HTML } from "./webui.ts";
import { MOBILE_HTML } from "./mobile.ts";
import { AgentRuntime } from "./agents.ts";
import { ChatRuntime } from "./chat.ts";
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
}

export const DEFAULT_PORT = 8710;

export function dataDirOf(dataDir?: string): string {
  return dataDir ?? join(homedir(), ".o-harness");
}
export function configFilePath(dataDir?: string): string {
  return join(dataDirOf(dataDir), "config.json");
}

export function isLoopbackHost(h: string): boolean {
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "";
}

export function loadConfig(dataDir?: string): { port: number; token: string; plugins: string[] } {
  const file = configFilePath(dataDir);
  try {
    const j = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof j.token === "string") return { port: Number(j.port) || DEFAULT_PORT, token: j.token, plugins: Array.isArray(j.plugins) ? j.plugins : [], ...(j.overlay ? { overlay: String(j.overlay) } : {}), ...(j.overlayAuthKey ? { overlayAuthKey: String(j.overlayAuthKey) } : {}), ...(j.overlayNetId ? { overlayNetId: String(j.overlayNetId) } : {}), ...(j.tls ? { tls: String(j.tls) as "auto" | "off" } : {}) };
  } catch { /* first run */ }
  const cfg = { port: DEFAULT_PORT, token: randomBytes(16).toString("hex"), plugins: [] as string[] };
  mkdirSync(dataDirOf(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

export function saveConfig(cfg: { port: number; token: string; plugins: string[] }, dataDir?: string) {
  mkdirSync(dataDirOf(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(configFilePath(dataDir), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function resolvePlugins(cfg: { plugins: string[] }, explicit?: string[]): string[] {
  const list = explicit && explicit.length ? explicit : (cfg.plugins.length ? cfg.plugins : ["@o-harness/plugin-local"]);
  return list;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; conn?: WebSocket }

interface AuthCtx { admin?: boolean; deviceId?: string }

export class Gateway {
  config: GatewayConfig;
  bus = new Bus();
  registry = new Registry();
  rpc = new RpcRouter();
  plugins = new PluginHost();
  sessions: SessionsStore;
  memory: MemoryStore;
  settings: SettingsStore;
  agents: AgentRuntime;
  chat: ChatRuntime;
  pairing: PairingStore;
  consolidator: MemoryConsolidator;
  grants: GrantsStore;
  tools: ToolBroker;
  scheduler: SchedulerRuntime;

  #server: Server | null = null;
  #clientSockets = new Set<WebSocket>();
  #wsCtx = new Map<WebSocket, AuthCtx>();
  #deviceConns = new Map<string, WebSocket>();
  #dataDir = dataDirOf();
  #pairHits = new Map<string, { n: number; resetAt: number }>();
  #pending = new Map<string, Pending>();
  #wssNode = new WebSocketServer({ noServer: true });
  #wssClient = new WebSocketServer({ noServer: true });

  constructor(config: Partial<GatewayConfig> = {}, dataDir?: string) {
    const base = loadConfig(dataDir);
    this.#dataDir = dataDirOf(dataDir);
    this.sessions = new SessionsStore(dataDirOf(dataDir));
    this.memory = new MemoryStore(dataDirOf(dataDir));
    this.pairing = new PairingStore(dataDirOf(dataDir));
    this.settings = new SettingsStore(dataDirOf(dataDir));
    this.consolidator = new MemoryConsolidator(this.memory, this.settings);
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
      onChange: (m) => this.#broadcastEvent("agents.changed", { id: m.id, status: m.status, turnsUsed: m.turnsUsed, result: m.result, error: m.error }),
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
      return s.entries.filter((e) => e.kind === "chat").map((e) => { const t = (e.data as any).tools; return { seq: e.seq, ts: e.ts, role: (e.data as any).role, text: (e.data as any).text, ...(t ? { tools: t } : {}) }; });
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
      const incoming = p?.settings as Settings | undefined;
      if (!incoming || !Array.isArray(incoming.providers)) throw new Error("settings.save: {settings:{providers:[...]}} required");
      const cur = this.settings.get();
      // merge: incoming may have "***set***" masked keys — keep existing real keys
      const byId = new Map(cur.providers.map((x) => [x.id, x]));
      incoming.providers = incoming.providers.map((inc) => {
        const old = byId.get(inc.id);
        if (inc.apiKey === "***set***" && old) inc.apiKey = old.apiKey;
        return inc;
      });
      this.settings.save(incoming);
      return { ok: true };
    });
    this.rpc.set(Methods.MemoryConsolidate, (p) => this.consolidator.consolidate({ subject: p?.subject ? String(p.subject) : undefined, dryRun: Boolean(p?.dryRun) }));
    this.rpc.set(Methods.PairingCreate, (p) => {
      const c = this.pairing.createCode({ kind: String(p?.kind ?? "mobile"), scopes: Array.isArray(p?.scopes) ? p.scopes.map(String) : undefined, ttlMinutes: Number(p?.ttlMinutes) || undefined });
      this.#broadcastEvent("pairing.created", { code: c.code, expiresAt: c.expiresAt });
      return c;
    });
    this.rpc.set(Methods.PairingList, () => this.pairing.list().map((d) => ({ ...d, secret: undefined })));
    this.rpc.set(Methods.PairingRevoke, (p) => { this.pairing.revoke(String(p?.id ?? "")); return { ok: true }; });
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

    const tlsMat = resolveTls(this.config.tls, this.#dataDir);
    if (tlsMat && !tlsMat.key) this.bus.emit("log", { source: "tls", message: String(tlsMat.note ?? "tls material unavailable") });
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "local"));
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(WEBUI_HTML);
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
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, deviceId: device.id, secret }));
          } catch (err) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            try { this.pairing.noteBadCode(String(JSON.parse(body || "{}").code ?? "")); } catch { /* noop */ }
          }
        });
        return;
      }
      if (url.pathname === "/m" || url.pathname === "/m/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(MOBILE_HTML);
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(encode({ ok: true, mode: "local", protocol: PROTOCOL_VERSION, port: this.config.port }));
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

  async stop() {
    await this.plugins.teardownAll();
    for (const d of this.registry.all()) { if (d.conn) { try { (d.conn as WebSocket).close(); } catch { /* noop */ } } }
    for (const ws of [...this.#clientSockets]) { try { ws.close(); } catch { /* noop */ } }
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  #checkAuth(req: IncomingMessage): AuthCtx | null {
    const url = new URL(req.url ?? "/", "http://local");
    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const token = url.searchParams.get("token") || bearer;
    if (token === this.config.token) return { admin: true };
    const secret = url.searchParams.get("secret") || "";
    const paired = this.pairing.auth(secret);
    if (paired) return { deviceId: paired.id };
    return null;
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
    const required = SCOPE_FOR_METHOD[method] ?? "read";
    if (!this.pairing.scopesFor(ctx.deviceId).includes(required)) {
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
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
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
    return this.rpc.call(method, params, { deviceId: ctx.admin ? undefined : ctx.deviceId, admin: ctx.admin });
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
}

export function createDefaultGateway(opts: Partial<GatewayConfig> = {}, dataDir?: string): Gateway {
  const cfg = loadConfig(dataDir);
  const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  return new Gateway({ ...cfg, plugins: resolvePlugins(cfg), ...clean } as Partial<GatewayConfig>, dataDir);
}
