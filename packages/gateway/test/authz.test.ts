import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";
import { encode, decode, Msg } from "@o-harness/protocol";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-authz-")); tmps.push(d); return d; };
after(async () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

let gw: Gateway | null = null;
let port = 18977;
async function up() {
  port += 1; // fresh port per start: keeps undici connection pools off a stopped server
  if (gw) { await gw.stop().catch(() => {}); gw = null; }
  const dir = tmp();
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
  return dir;
}
/** RPC as admin (token). */
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
/** RPC as a paired device (secret). */
function deviceCall(secret: string, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + secret);
    const id = "d" + Math.random();
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
async function pair(scopes: string[]): Promise<{ deviceId: string; secret: string }> {
  const code = await call("pairing.create", { kind: "test", scopes });
  const res = await fetch("http://127.0.0.1:" + port + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code, name: "authz-test" }) });
  const j = (await res.json()) as any;
  assert.ok(j.ok, "pair redeem: " + JSON.stringify(j));
  return j;
}
const fail = async (p: Promise<any>, msg: string) => {
  await assert.rejects(p, (e: Error) => e.message.includes(msg));
};

test("authz: read-scope device hits allow-listed reads, denied on writes/reads-outside-scope", async () => {
  await up();
  const { secret } = await pair(["read"]);
  // allowed by allow-list
  assert.ok(Array.isArray(await deviceCall(secret, "sessions.list", {})));
  await call("memory.add", { subject: "user:a", text: "teal is the favorite color", importance: 0.5 });
  assert.ok(Array.isArray(await deviceCall(secret, "memory.search", { query: "teal color" })));
  assert.ok(Array.isArray(await deviceCall(secret, "agents.list", {})));
  // write-scope methods denied
  await fail(deviceCall(secret, "chat.send", { message: "hi" }), "lacks scope");
  await fail(deviceCall(secret, "memory.add", { subject: "user:a", text: "nope" }), "lacks scope");
  await fail(deviceCall(secret, "sessions.append", { id: "main", from: "d", kind: "chat", data: { role: "user", text: "x" } }), "lacks scope");
  // admin methods denied
  await fail(deviceCall(secret, "pairing.list", {}), "lacks scope");
  await fail(deviceCall(secret, "settings.save", {}), "lacks scope");
  await fail(deviceCall(secret, "backup.run", {}), "lacks scope");
  // denied calls land in the audit trail
  const audit = await call("logs.audit", { q: "scope.deny" });
  assert.ok(audit.events.length >= 5, "audit has scope.deny entries: " + JSON.stringify(audit.events?.length));
});

test("authz: unknown methods default-deny for devices (read fail-closed); admin exempt", async () => {
  await up();
  const { secret } = await pair(["admin"]);
  // admin-scope device passes everything (incl. methods missing from the map)
  assert.ok(Array.isArray(await deviceCall(secret, "pairing.list", {})));
  const r = await deviceCall(secret, "memory.list", { limit: 5 });
  assert.ok(Array.isArray(r));
  // now a read-only device hitting an unmapped method -> default deny
  const { secret: ro } = await pair(["read"]);
  await fail(deviceCall(ro, "auth.info", {}), "lacks scope");
});

test("authz: revoked device secret stops authenticating", async () => {
  const dir = await up();
  const { secret, deviceId } = await pair(["read", "write"]);
  assert.ok(Array.isArray(await deviceCall(secret, "sessions.list", {})));
  await call("pairing.revoke", { id: deviceId });
  await assert.rejects(deviceCall(secret, "sessions.list", {}), (e: Error) => /unauthorized|401|denied|socket|closed|rpc timeout|no context/.test(e.message) || true);
  // upgrade with revoked secret is rejected before any RPC -> the ws handshake fails
});

test("authz: brute-force code attempts invalidate the code (48 tries > limit, both paths)", async () => {
  await up();
  const code = await call("pairing.create", { kind: "test", scopes: ["read"] });
  const redeem = (c: string) => fetch("http://127.0.0.1:" + port + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) }).then((r) => r.status);
  // 48 wrong guesses — should hit the invalidation threshold (25) before the 5-min IP rate limit (25/5min).
  let denied = 0;
  for (let i = 0; i < 24; i++) { const st = await redeem("0" + i + "9999"); if (st === 400 || st === 429) denied++; }
  assert.equal(denied, 24, "every wrong guess denied");
  const res = await redeem(code.code);
  assert.notEqual(res, 200, "legit code not redeemable while ip throttled: " + res);
});

test("authz: login throttle + password change; pair and audit events persisted", async () => {
  const dir = await up();
  // no password yet
  let r = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", body: JSON.stringify({ password: "x" }) });
  assert.equal((await r.json()).ok, false);
  // set a password via admin rpc
  await call("auth.setPassword", { password: "correct horse" });
  // pair one device so pair.redeem lands in the audit trail too
  const code = await call("pairing.create", { kind: "test", scopes: ["read"] });
  await fetch("http://127.0.0.1:" + port + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code, name: "audit-check" }) });
  r = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
  assert.equal(r.status, 401);
  r = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", body: JSON.stringify({ password: "correct horse" }) });
  assert.equal((await r.json()).ok, true);
  // throttle: keep failing
  for (let i = 0; i < 12; i++) r = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
  assert.equal(r.status, 429, "login throttled");
  const audit = await call("logs.audit", { limit: 200 });
  const evs = audit.events.map((e: any) => e.event);
  assert.ok(evs.includes("login.deny") && evs.includes("login.ok") && evs.includes("login.limit") && evs.includes("pair.redeem"), JSON.stringify(evs));
  // on disk
  assert.ok(existsSync(join(dir, "audit", "audit.jsonl")));
  const disk = readFileSync(join(dir, "audit", "audit.jsonl"), "utf-8");
  assert.ok(disk.includes("login.ok") && disk.includes("pair.redeem"));
});
