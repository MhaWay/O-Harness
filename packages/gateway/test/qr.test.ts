import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-qr-")); tmps.push(d); return d; };
after(async () => { if (gw) { await gw.stop().catch(() => {}); gw = null; } for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

let gw: Gateway | null = null;
let port = 19361;
async function up() {
  port += 1;
  if (gw) { await gw.stop().catch(() => {}); gw = null; }
  const dir = tmp();
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
  return dir;
}
function call(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?token=" + gw!.config.token);
    const id = "t" + Math.random();
    const timer = setTimeout(() => { s.close(); reject(new Error("rpc timeout " + method)); }, 8000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method, params })));
    s.on("message", (raw: Buffer) => {
      const m = JSON.parse(String(raw)) as any;
      if (m.type === "rpc:res" && m.id === id) { clearTimeout(timer); s.close();
        if ("error" in m && m.error) reject(new Error(String(m.error))); else resolve(m.result); }
    });
    s.on("error", reject);
  });
}

test("pairing.qr returns code, candidate urls and an svg", async () => {
  await up();
  const r = await call("pairing.qr", { kind: "mobile", scopes: ["read", "write"], ttlMinutes: 10 });
  assert.match(r.code, /^[0-9]{6}$/);
  assert.ok(Array.isArray(r.urls) && r.urls.length >= 1);
  assert.ok(r.urls.every((x: any) => typeof x.u === "string" && typeof x.k === "string"));
  assert.match(r.qr, /<svg/, "expected svg tag");
  const res = await fetch("http://127.0.0.1:" + port + "/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: r.code, name: "qr-test-phone" })
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.ok(body.deviceId && body.secret);
  const devs = await call("pairing.list", {});
  assert.ok(devs.some((d: any) => d.name === "qr-test-phone"));
});

test("pairing.qr denied for read-scope device", async () => {
  await up();
  const c = await call("pairing.create", { kind: "mobile", scopes: ["read"], ttlMinutes: 10 });
  const res = await fetch("http://127.0.0.1:" + port + "/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: c.code, name: "limited" })
  });
  const body = await res.json() as any;
  const secret = body.secret;
  const bad = await new Promise<string>((resolve) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + secret);
    const id = "x" + Math.random();
    const timer = setTimeout(() => { s.close(); resolve("timeout"); }, 5000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method: "pairing.qr", params: {} })));
    s.on("message", (raw: Buffer) => {
      const m = JSON.parse(String(raw)) as any;
      if (m.type === "rpc:res" && m.id === id) { clearTimeout(timer); s.close(); resolve(m.error ? String(m.error) : "ALLOWED"); }
    });
  });
  assert.match(bad, /scope|denied/i, "read-scope device should be denied pairing.qr, got: " + bad);
});