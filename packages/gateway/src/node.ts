import { spawn } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import WebSocket from "ws";
import { decode, encode, Msg, PROTOCOL_VERSION } from "@o-harness/protocol";

export interface NodeOpts { url: string; token: string; name?: string; deviceId?: string; reconnect?: boolean }

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

function handle(method: string, params: any): unknown {
  if (method === "exec") {
    if (typeof params?.command !== "string") throw new Error("exec: command required");
    return runShell(params.command, params.cwd);
  }
  if (method === "fs.read") return readFileText(params?.path);
  if (method === "fs.write") return writeFileAll(params?.path, params?.content);
  throw new Error("node: unsupported method '" + method + "'");
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

export async function connectNode(opts: NodeOpts): Promise<{ ws: WebSocket; nodeId: string }> {
  const ws = new WebSocket(opts.url, { headers: { authorization: "Bearer " + opts.token } });
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    ws.on("open", () => {
      ws.send(encode({
        type: Msg.Hello,
        protocol: PROTOCOL_VERSION,
        name: opts.name ?? hostname(),
        kind: "remote",
        hostname: hostname(),
        platform: platform() + "/" + arch(),
        capabilities: ["exec", "fs.read", "fs.write"],
        deviceId: opts.deviceId,
      }));
    });
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (!msg) return;
      if (msg.type === Msg.Welcome) {
        settled = true;
        resolvePromise({ ws, nodeId: String(msg.nodeId) });
        return;
      }
      if (msg.type === Msg.RpcReq && typeof msg.id === "string") {
        Promise.resolve()
          .then(() => handle(String(msg.method), msg.params))
          .then((result) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, result })))
          .catch((err) => ws.send(encode({ type: Msg.RpcRes, id: msg.id, error: err instanceof Error ? err.message : String(err) })));
      }
    });
    ws.on("close", () => {
      if (!settled && !opts.reconnect) rejectPromise(new Error("node connection closed before welcome"));
      if (opts.reconnect) setTimeout(() => { connectNode(opts).catch(() => { /* keep trying loop */ }); }, 1000);
    });
    ws.on("error", (err) => { if (!settled) rejectPromise(err); });
    setTimeout(() => { if (!settled) rejectPromise(new Error("node handshake timed out")); }, 5000);
  });
}
