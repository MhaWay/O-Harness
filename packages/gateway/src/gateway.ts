import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decode, encode, Methods, Msg, PROTOCOL_VERSION } from "@o-harness/protocol";
import { Bus, PluginHost, Registry, RpcRouter, publicDevice, type DeviceRuntime, type GatewayApi, type Handler, type OHarnessPlugin } from "@o-harness/core";
import type { Duplex } from "node:stream";

export interface GatewayConfig {
  host: string;
  port: number;
  token: string;
  plugins: string[];
}

export const DEFAULT_PORT = 8710;

export function dataDirOf(dataDir?: string): string {
  return dataDir ?? join(homedir(), ".o-harness");
}
export function configFilePath(dataDir?: string): string {
  return join(dataDirOf(dataDir), "config.json");
}

export function loadConfig(dataDir?: string): { port: number; token: string; plugins: string[] } {
  const file = configFilePath(dataDir);
  try {
    const j = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof j.token === "string") return { port: Number(j.port) || DEFAULT_PORT, token: j.token, plugins: Array.isArray(j.plugins) ? j.plugins : [] };
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

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Gateway {
  config: GatewayConfig;
  bus = new Bus();
  registry = new Registry();
  rpc = new RpcRouter();
  plugins = new PluginHost();

  #server: Server | null = null;
  #clientSockets = new Set<WebSocket>();
  #pending = new Map<string, Pending>();
  #wssNode = new WebSocketServer({ noServer: true });
  #wssClient = new WebSocketServer({ noServer: true });

  constructor(config: Partial<GatewayConfig> = {}, dataDir?: string) {
    const base = loadConfig(dataDir);
    this.config = {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? base.port,
      token: config.token ?? base.token,
      plugins: config.plugins ?? base.plugins,
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

    for (const spec of this.config.plugins) {
      const target = /^\.\//.test(spec) || spec.startsWith("/") ? pathToFileURL(resolve(process.cwd(), spec)).href : spec;
      const mod = (await import(target)) as { default?: OHarnessPlugin; plugin?: OHarnessPlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.setup !== "function") throw new Error("plugin '" + spec + "' has no default plugin export");
      this.plugins.register(plugin);
    }
    await this.plugins.setupAll(this.#api());

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "local"));
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(encode({ ok: true, mode: "local", protocol: PROTOCOL_VERSION, port: this.config.port }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
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

  #checkAuth(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "/", "http://local");
    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const token = url.searchParams.get("token") || bearer;
    return token === this.config.token;
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.#checkAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/node") {
      this.#wssNode.handleUpgrade(req, socket, head, (ws) => this.#onNodeSocket(ws));
    } else if (url.pathname === "/api") {
      this.#wssClient.handleUpgrade(req, socket, head, (ws) => this.#onClientSocket(ws));
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
        this.rpc.call(String(msg.method), msg.params).then((result) => {
          ws.send(encode({ type: Msg.RpcRes, id: msg.id, result }));
        }).catch((err) => {
          ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) }));
        });
      }
    });
    ws.on("close", () => { const d = device ?? this.#deviceByConn(ws); if (d) this.#markOffline(d.id); });
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
      connectedAt: current?.connectedAt ?? Date.now(),
      lastSeen: Date.now(),
    };
    this.registry.register(dev);
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

  #onClientSocket(ws: WebSocket) {
    this.#clientSockets.add(ws);
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (!msg || msg.type !== Msg.RpcReq || typeof msg.id !== "string") return;
      this.rpc.call(String(msg.method), msg.params).then((result) => {
        ws.send(encode({ type: Msg.RpcRes, id: msg.id, result }));
      }).catch((err) => {
        ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) }));
      });
    });
    ws.on("close", () => this.#clientSockets.delete(ws));
    ws.on("error", () => { /* noop */ });
  }

  async #callDevice(deviceId: string, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const dev = this.registry.get(deviceId);
    if (!dev) throw new Error("unknown device: " + deviceId);
    if (dev.conn) return await this.#callRemote(dev, method, params, timeoutMs);
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

  #broadcastEvent(topic: string, data?: unknown) {
    const payload = encode({ type: Msg.Event, topic, data });
    for (const ws of this.#clientSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

export function createDefaultGateway(opts: Partial<GatewayConfig> = {}, dataDir?: string): Gateway {
  const cfg = loadConfig(dataDir);
  return new Gateway({ ...cfg, plugins: resolvePlugins(cfg), ...opts }, dataDir);
}
