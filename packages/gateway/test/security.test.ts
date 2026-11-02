import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway.ts";
import { WebSocket } from "ws";

const tmps: string[] = [];
let gw: Gateway | null = null;
const port = 18959;
async function up(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohsec-"));
  tmps.push(dir);
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" } as never, dir);
  await gw!.start();
}
after(async () => { if (gw) await gw!.stop(); for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("security: baseline headers on all responses", async () => {
  await up();
  const paths = ["/", "/health", "/assets/app.js", "/m", "/legacy"];
  for (const path of paths) {
    const res = await fetch("http://127.0.0.1:" + port + path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.ok(csp.indexOf("frame-ancestors") >= 0, "csp frame-ancestors " + path);
    assert.ok(csp.indexOf("object-src") >= 0, "csp object-src " + path);
  }
});

test("security: 1MB body limit -> 413, small bodies fine", async () => {
  if (!gw) await up();
  const big = "A".repeat(1100000);
  const res = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(res.status, 413);
  const small = await fetch("http://127.0.0.1:" + port + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"password\":\"wrong\"}" });
  assert.ok(small.status >= 400 && small.status < 413, "reaches login logic: " + small.status);
});

test("security: ws rpc still works after body-guard", async () => {
  if (!gw) await up();
  const r = await new Promise<unknown>((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?token=" + gw!.config.token);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 6000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id: "h1", method: "sessions.list", params: {} })));
    s.on("message", (raw: Buffer) => { const m = JSON.parse(String(raw)) as any; if (m.type === "rpc:res" && m.id === "h1") { clearTimeout(timer); s.close(); resolve(m.result ?? m.error); } });
    s.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
  });
  assert.ok(Array.isArray(r));
});