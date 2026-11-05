import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";

const port = 19119;
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-int-")); tmps.push(d); return d; };
let gw: Gateway | null = null;
afterEach(async () => { try { await gw?.stop(); } catch { /* not up */ } gw = null; });
after(async () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const adminUrl = () => "ws://127.0.0.1:" + port + "/api?token=" + gw!.config.token;
function rpc(url: string, method: string, params?: unknown, sock?: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const own = sock === undefined;
    const s = sock ?? new WebSocket(url);
    const id = method + "-" + Math.random();
    const tm = setTimeout(() => { if (own) try { s.close(); } catch {} reject(new Error("timeout " + method)); }, 10000);
    const on = (raw: Buffer) => {
      let m: { type?: string; id?: string; error?: string; result?: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "rpc:res" && m.id === id) { clearTimeout(tm); if (own) s.close(); m.error ? reject(new Error(m.error)) : resolve(m.result); }
    };
    s.on("message", on);
    if (own) s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method, params })));
    else s.send(JSON.stringify({ type: "rpc:req", id, method, params }));
  });
}
async function boot(dir: string) {
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
}

describe("integration: sessions/memory/pairing/tools/logs/doctor/backup", () => {
  it("full vertical pass on one data dir", async () => {
    const dir = tmp();
    await boot(dir);

    // sessions
    const s = await rpc(adminUrl(), "sessions.create", { title: "integration" }) as { id: string };
    await rpc(adminUrl(), "sessions.append", { id: s.id, kind: "chat", data: { role: "user", text: "hello" } });
    const got = await rpc(adminUrl(), "sessions.get", { id: s.id }) as { entries: { kind: string }[] };
    assert.equal(got.entries.length, 1);
    assert.equal(got.entries[0].kind, "chat");
    // sessions.rename + sessions.delete (slice 42)
    assert.deepEqual(await rpc(adminUrl(), "sessions.rename", { id: s.id, title: "renamed" }), { ok: true });
    assert.equal((await rpc(adminUrl(), "sessions.get", { id: s.id }) as { title: string }).title, "renamed");
    assert.deepEqual(await rpc(adminUrl(), "sessions.delete", { id: s.id }), { ok: true });
    assert.equal(await rpc(adminUrl(), "sessions.get", { id: s.id }), null);
    const mainDel = await rpc(adminUrl(), "sessions.delete", { id: "main" }) as { ok: boolean };
    assert.equal(mainDel.ok, false, "main protected");

    // memory
    await rpc(adminUrl(), "memory.add", { text: "user likes dark GUI themes", subject: "user" });
    await rpc(adminUrl(), "memory.add", { text: "deploy target is gx10-8e13 arm64", subject: "project" });
    const hits = await rpc(adminUrl(), "memory.search", { query: "dark themes", limit: 5 }) as { text: string }[];
    assert.ok(hits.some((h) => String(h.text ?? "").includes("dark")), "memory search finds dark");

    // pairing: code (read+write) -> HTTP redeem -> scoped socket
    const pc = await rpc(adminUrl(), "pairing.create", { kind: "mobile", scopes: ["read", "write"] }) as { code: string };
    const res = await fetch("http://127.0.0.1:" + port + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pc.code, name: "test-phone" }) });
    const { deviceId, secret } = await res.json() as { deviceId: string; secret: string };
    const dev = new WebSocket("ws://127.0.0.1:" + port + "/api?secret=" + secret);
    await new Promise((r2, j) => { dev.on("open", r2); dev.on("error", j); });

    // device echoes tool.invoke over its own socket
    dev.on("message", (raw: Buffer) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "rpc:req" && m.method === "tool.invoke") {
        dev.send(JSON.stringify({ type: "rpc:res", id: m.id, result: { echo: m.params.args } }));
      }
    });
    const sl = await rpc("", "sessions.list", {}, dev);
    assert.ok(Array.isArray(sl), "scoped device can list sessions (read)");
    await assert.rejects(rpc("", "settings.save", { settings: {} }, dev), /lacks scope/);

    // device tools broker: offer (write scope) -> admin calls -> ask -> respond approves
    const off = await rpc("", "device.tools.offer", { tools: [{ name: "echo", description: "echo args back" }] }, dev) as { deviceId: string; count: number };
    assert.equal(off.deviceId, deviceId);
    const callP = rpc(adminUrl(), "device.tools.call", { deviceId, tool: "echo", args: { ping: 1 } });
    let ask: { id: string }[] = [];
    for (let i = 0; i < 20 && ask.length === 0; i++) { ask = await rpc(adminUrl(), "tools.pending", {}) as { id: string }[]; if (ask.length === 0) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(ask.length >= 1, "broker created an approval ask");
    await rpc(adminUrl(), "tools.respond", { id: ask[0].id, approved: true, remember: false });
    const called = await callP;
    assert.ok(JSON.stringify(called).includes("ping"), "broker delivered call + device reply");
    dev.close();

    // logs + doctor
    const lt = await rpc(adminUrl(), "logs.tail", { limit: 50 }) as { entries: unknown[] };
    assert.ok(lt.entries.length > 0, "logs have entries");
    const doc = await rpc(adminUrl(), "doctor.run", { deep: false }) as { checks: { name: string; ok: boolean }[] };
    assert.ok(doc.checks.some((c) => c.name === "instances" && c.ok), "doctor instances ok");
    assert.ok(doc.checks.some((c) => c.name === "config" && c.ok), "doctor config ok");

    // backup
    const bk = await rpc(adminUrl(), "backup.run", {}) as { files: number };
    assert.ok(bk.files > 0, "backup wrote files");
    const bl = await rpc(adminUrl(), "backup.list", {}) as { backups: { name: string }[] };
    assert.ok(bl.backups.length >= 1);
    const dry = await rpc(adminUrl(), "backup.restore", { file: bl.backups[0].path, dryRun: true }) as { dryRun: boolean };
    assert.equal(dry.dryRun, true);
  });
});
