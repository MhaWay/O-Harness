import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway.ts";

// undici keeps a global keep-alive pool; reusing one fixed port across
// gw restarts reuses a socket to the dead server -> "other side closed".
// Bump the port per gateway boot so every test opens a fresh connection.
let portN = 19161;
let gw: Gateway | null = null;
afterEach(async () => { try { await gw?.stop(); } catch { /* not up */ } gw = null; });

async function withGateway(fn: (base: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oh-http-"));
  const port = portN++;
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
  try { await fn("http://127.0.0.1:" + port); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("http surface", () => {
  it("health reports ok, protocol, port and pid", async () => {
    await withGateway(async (base) => {
      const r = await fetch(base + "/health");
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.port, Number(new URL(base).port));
      assert.equal(j.pid, process.pid);
      assert.equal(typeof j.protocol, "number");
      assert.equal(typeof j.others, "number");
    });
  });
  it("favicon serves the brand mark without 404", async () => {
    await withGateway(async (base) => {
      for (const p of ["/favicon.svg", "/favicon.ico"]) {
        const r = await fetch(base + p);
        assert.equal(r.status, 200, p);
        assert.match(r.headers.get("content-type") ?? "", /svg/);
        assert.match(await r.text(), /<svg/);
      }
    });
  });
  it("unknown paths 404", async () => {
    await withGateway(async (base) => {
      const r = await fetch(base + "/definitely-not-a-route");
      assert.equal(r.status, 404);
    });
  });
});
