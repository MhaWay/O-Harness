import WebSocket from "ws";
import { decode, encode, Msg } from "@o-harness/protocol";

let counter = 0;

export function wsUrl(port: number, path: string, token: string): string {
  return `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`;
}

export async function callOnce<T = unknown>(method: string, params?: unknown, port?: number): Promise<T> {
  const { loadConfig } = await import("@o-harness/gateway");
  const cfg = loadConfig();
  const url = wsUrl(port ?? cfg.port, "/api", cfg.token);
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url);
    const id = "cli-" + Date.now().toString(36) + "-" + counter++;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    ws.on("open", () => ws.send(encode({ type: Msg.RpcReq, id, method, params })));
    ws.on("message", (raw: Buffer | string) => {
      const msg = decode(String(raw));
      if (msg && msg.type === Msg.RpcRes && msg.id === id) {
        done(() => {
          ws.close();
          if (msg.error !== undefined) rejectPromise(new Error(String(msg.error)));
          else resolvePromise(msg.result as T);
        });
      }
    });
    ws.on("error", (e) => done(() => rejectPromise(e)));
    ws.on("close", () => done(() => rejectPromise(new Error("gateway connection closed — is it running? try: o-h gateway start"))));
  });
}
