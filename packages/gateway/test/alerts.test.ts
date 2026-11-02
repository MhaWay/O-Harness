import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-al-")); tmps.push(d); return d; };
after(async () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(async () => { try { await gw?.stop(); } catch { /* not started */ } gw = null; });

const port = 19117;
let portN = port;
let gw: Gateway | null = null;
function call(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + portN + "/api?token=" + gw!.config.token);
    const id = "t" + Math.random();
    const timer = setTimeout(() => { s.close(); reject(new Error("rpc timeout")); }, 8000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method, params })));
    s.on("message", (raw: Buffer) => {
      const m = JSON.parse(String(raw));
      if (m.type === "rpc:res" && m.id === id) { clearTimeout(timer); s.close(); m.error ? reject(new Error(m.error)) : resolve(m.result); }
    });
  });
}
async function boot(dir: string) {
  gw = new Gateway({ port: portN, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
}

describe("alert notifications", () => {
  it("durable trail + resolve across restart", async () => {
    const dir = tmp(); portN = 19117;
    await boot(dir);
    await call("monitor.add", { name: "down-svc", kind: "http", url: "http://127.0.0.1:18998/nope" });
    await call("monitor.add", { name: "live-svc", kind: "http", url: "http://127.0.0.1:" + portN + "/health" });
    const s1 = await call("monitor.check", {});
    const down = s1.find((x: { name: string }) => x.name === "down-svc");
    assert.ok(down && !down.ok, "down service probes fail");
    const al = await call("alerts.list", {});
    assert.ok(al.some((a: { name: string }) => a.name === "down-svc"), "firing alert recorded");
    const sess = await call("sessions.get", { id: "alerts" });
    assert.ok(sess, "dedicated alerts session created");
    assert.ok(sess.entries.some((e: { kind: string }) => e.kind === "alert"), "firing entry in alerts session");
    await gw!.stop();
    await boot(dir);
    const s2 = await call("monitor.check", {});
    const live = s2.find((x: { name: string }) => x.name === "live-svc");
    assert.ok(live && live.ok, "live service ok after restart");
    const sess2 = await call("sessions.get", { id: "alerts" });
    assert.ok(sess2.entries.some((e: { kind: string }) => e.kind === "alert"), "alerts session persisted across restart");
  });
});
