import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";
import { encode, decode, Msg } from "@o-harness/protocol";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-gw-")); tmps.push(d); return d; };
after(async () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

let gw: Gateway | null = null;
let port = 18955;
async function up() {
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
      const m = JSON.parse(String(raw)) as Msg;
      if ("type" in m && m.type === "rpc:res" && m.id === id) { clearTimeout(timer); s.close();
        if ("error" in m && m.error) reject(new Error(m.error)); else resolve((m as any).result); }
    });
    s.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

test("gateway: sessions + memory + pairing + scopes over ws", async () => {
  await up();
  // sessions
  const ss = await call("sessions.list", {});
  assert.ok(Array.isArray(ss));
  await call("sessions.create", { title: "itest", id: "itest" });
  await call("sessions.append", { id: "itest", from: "itest", kind: "chat", data: { role: "user", text: "hi" } });
  const s1 = await call("sessions.get", { id: "itest" });
  assert.equal(s1.entries.length, 1);
  // memory
  await call("memory.add", { subject: "user:itest", text: "itest prefers the color teal", importance: 0.6 });
  const hits = await call("memory.search", { query: "teal color prefer" });
  assert.ok(hits.length >= 1);
  // devices: none registered (plugins off)
  const devs = await call("devices.list", {});
  assert.ok(Array.isArray(devs));
  // pairing via admin rpc -> code, then HTTP redeem
  const code = await call("pairing.create", { kind: "mobile", scopes: ["read"] });
  const res = await fetch("http://127.0.0.1:" + port + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code, name: "itest-phone" }) });
  const pr = await res.json() as { ok: boolean; deviceId: string; secret: string };
  assert.ok(pr.ok);
  // secret client: read scopes ok, write denied
  const sec = await new Promise<string>((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + pr.secret);
    const id = "x1"; const timer = setTimeout(() => reject(new Error("sec timeout")), 8000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method: "memory.search", params: { query: "teal" } })));
    s.on("message", (raw: Buffer) => { const m = JSON.parse(String(raw)); if (m.id === id) { clearTimeout(timer); s.close(); resolve(m.result); } });
    s.on("error", reject);
  });
  assert.ok(Array.isArray(sec));
  const denied = await call2("memory.add", { subject: "x", text: "nope" }, pr.secret);
  assert.match(denied, /lacks scope/);
  // revoke -> reconnect refused
  await call("pairing.revoke", { id: pr.deviceId });
  const refused = await new Promise<boolean>((resolve) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + pr.secret);
    s.on("open", () => resolve(false));
    s.on("error", () => resolve(true));
    setTimeout(() => { s.close(); resolve(true); }, 3000);
  });
  assert.equal(refused, true);
});

function call2(method: string, params: unknown, secret: string): Promise<string> {
  return new Promise((resolve) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + secret);
    const id = "d" + Math.random();
    const timer = setTimeout(() => { s.close(); resolve("timeout"); }, 6000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method, params })));
    s.on("message", (raw: Buffer) => { const m = JSON.parse(String(raw)); if (m.id === id) { clearTimeout(timer); s.close(); resolve(String(m.error ?? "no-error")); } });
    s.on("error", () => { clearTimeout(timer); resolve("conn-error"); });
  });
}

test("gateway: http health + unknown method", async () => {
  if (!gw) await up();
  const res = await fetch("http://127.0.0.1:" + port + "/health");
  const j = await res.json() as { ok: boolean; mode: string };
  assert.equal(j.ok, true);
  const err = await call("no.such.method", {}).then(() => "no-error", (e) => String(e.message));
  assert.match(err, /unknown|no such|method/i);
});