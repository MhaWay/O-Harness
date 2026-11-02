import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { hostname, platform, arch, networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { decode, encode, Msg, PROTOCOL_VERSION } from "@o-harness/protocol";
import { ensureOverlay, type OverlayKind } from "./overlay.ts";
import { companionInvoke, companionTools } from "./companion.ts";

export interface NodeOpts {
  url: string;
  token: string;
  name?: string;
  deviceId?: string;
  directPort?: number; // 0 = ephemeral; false disables via noDirect
  noDirect?: boolean;
  /** Overlay network: bootstrap+join tailscale or zerotier (install on demand).
   * "auto" (default): tailscale when the gateway URL is NOT loopback (remote/headless use), off for local. */
  overlay?: OverlayKind | "auto";
  overlayAuthKey?: string;
  overlayNetId?: string;
  log?: (m: string) => void;
  onConnected?: (nodeId: string) => void;
}

function runShell(command: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function readFileText(p: unknown) {
  const { readFile } = await import("node:fs/promises");
  return { content: await readFile(String(p), "utf-8") };
}
async function writeFileAll(p: unknown, content: unknown) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(String(p)), { recursive: true });
  await writeFile(String(p), String(content));
  return { ok: true };
}

function isLoopbackHost(h: string): boolean {
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "";
}

function handle(method: string, params: any): unknown {
  if (method === "exec") {
    if (typeof params?.command !== "string") throw new Error("exec: command required");
    return runShell(params.command, params.cwd);
  }
  if (method === "fs.read") return readFileText(params?.path);
  if (method === "fs.write") return writeFileAll(params?.path, params?.content);
  if (method === "tool.invoke") return companionInvoke(String(params?.tool ?? ""), params?.args);
  throw new Error("node: unsupported method '" + method + "'");
}

/** Local IPv4 addresses (LAN candidates). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** Tailscale IPv4 if the tailscale CLI is present (integration point; headscale works too). */
export function tailscaleAddress(): string | undefined {
  try {
    const ip = execSync("tailscale ip -4 2>/dev/null", { timeout: 1500 }).toString().trim().split("\n")[0];
    return /^100\./.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

export function buildCandidates(directPort: number, overlayAddresses: string[] = []): string[] {
  const extra = (process.env.OH_ADDR_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!Number.isFinite(directPort)) return [...new Set(extra)]; // no direct server: only explicit candidates
  const out: string[] = [];
  for (const ip of lanAddresses()) out.push(`ws://${ip}:${directPort}`);
  for (const ip of overlayAddresses) out.push(`ws://${ip}:${directPort}`);
  const ts = tailscaleAddress(); // passive: if tailscale happens to be running, also advertise it
  if (ts && !overlayAddresses.includes(ts)) out.push(`ws://${ts}:${directPort}`);
  out.push(...extra);
  return [...new Set(out)];
}

/** Direct data-plane server: same RPC protocol, token-auth on upgrade. */
export async function startDirectServer(port: number, token: string): Promise<{ port: number; close: () => void }> {
  const httpServer = createServer((_req, res) => { res.writeHead(200); res.end("o-h node: direct channel ok\n"); });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    const bearer = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const tok = u.searchParams.get("token") ?? bearer;
    if (tok !== token) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); (socket as Duplex).destroy(); return; }
    wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
      ws.on("message", (raw: Buffer | string) => {
        const msg = decode(String(raw));
        if (!msg || msg.type !== Msg.RpcReq || typeof msg.id !== "string") return;
        Promise.resolve()
          .then(() => handle(String(msg.method), msg.params))
          .then((result) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, result })))
          .catch((err) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) })));
      });
    });
  });
  return await new Promise((res) => {
    httpServer.listen(port, "0.0.0.0", () => {
      const addr = httpServer.address() as AddressInfo;
      res({ port: addr.port, close: () => { wss.close(); httpServer.close(); } });
    });
  });
}

export async function connectNode(opts: NodeOpts & { addresses?: string[] }): Promise<{ ws: WebSocket; nodeId: string }> {
  const ws = new WebSocket(opts.url, { headers: { authorization: "Bearer " + opts.token } });
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) rejectPromise(new Error("node handshake timed out")); }, 6000);
    const settleOk = (id: string) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ ws, nodeId: id }); } };
    ws.on("open", () => {
      ws.send(encode({
        type: Msg.Hello,
        protocol: PROTOCOL_VERSION,
        name: opts.name ?? hostname(),
        kind: "remote",
        hostname: hostname(),
        platform: platform() + "/" + arch(),
        capabilities: ["exec", "fs.read", "fs.write", "tools"],
        tools: companionTools(),
        deviceId: opts.deviceId,
        addresses: opts.addresses ?? [],
      }));
    });
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (!msg) return;
      if (msg.type === Msg.Welcome) { settleOk(String(msg.nodeId)); return; }
      if (msg.type === Msg.RpcReq && typeof msg.id === "string") {
        Promise.resolve()
          .then(() => handle(String(msg.method), msg.params))
          .then((result) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, result })))
          .catch((err) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) })));
      }
    });
    ws.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(e); } });
    ws.on("close", () => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(new Error("connection closed before welcome")); } });
  });
}

export async function runNodeLoop(opts: NodeOpts): Promise<void> {
  let deviceId: string | undefined = opts.deviceId;
  let attempt = 0;
  let everConnected = false;
  let direct: { port: number; close: () => void } | undefined;
  if (!opts.noDirect) {
    direct = await startDirectServer(opts.directPort ?? 0, opts.token);
    opts.log?.("direct server on port " + direct.port);
  }
  let overlayAddresses: string[] = [];
  const wantOverlay: OverlayKind =
    !opts.overlay || opts.overlay === "auto"
      ? isLoopbackHost(new URL(opts.url).hostname) ? "off" : "tailscale" // remote/headless use => tailscale default
      : opts.overlay;
  if (wantOverlay !== "off") {
    const ov = await ensureOverlay(wantOverlay, { log: opts.log, authKey: opts.overlayAuthKey, netId: opts.overlayNetId });
    overlayAddresses = ov.addresses;
    if (ov.notes.length) opts.log?.(ov.notes.join("; "));
    if (!ov.started) opts.log?.("overlay enabled but not active — direct candidates without overlay");
  }
  const addresses = direct ? buildCandidates(direct.port, overlayAddresses) : buildCandidates(Infinity, overlayAddresses);
  for (;;) {
    try {
      const { ws, nodeId } = await connectNode({ ...opts, deviceId, addresses });
      deviceId = nodeId;
      opts.onConnected?.(nodeId);
      const isReconnect = everConnected;
      everConnected = true;
      attempt = 0;
      opts.log?.((isReconnect ? "reconnected as device " : "connected as device ") + nodeId);
      await new Promise<void>((res) => {
        if (ws.readyState !== WebSocket.OPEN) { res(); return; }
        ws.on("close", () => res());
      });
      opts.log?.("disconnected, retrying");
    } catch (e) {
      if (!everConnected) { direct?.close(); throw e; } // first-ever connection failed: surface it
      opts.log?.("connection failed: " + (e instanceof Error ? e.message : String(e)));
    }
    const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
    attempt++;
    await new Promise((r) => setTimeout(r, delay));
  }
}
