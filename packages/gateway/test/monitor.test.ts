import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { MonitorStore } from "../src/monitor.ts";

function listen(): Promise<{ srv: Server; url: string }> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"data\":[\"m1\"]}"); });
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const url = a && typeof a === "object" ? "http://127.0.0.1:" + a.port : "";
      resolve({ srv, url });
    });
  });
}

async function withStore(): Promise<{ store: MonitorStore; dir: string; srv: Server; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ohmon-"));
  const { srv, url } = await listen();
  return { store: new MonitorStore(dir), dir, srv, url };
}

test("add/list/remove services + persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohmon-"));
  const store = new MonitorStore(dir);
  const s = store.addService("up", "http", "http://127.0.0.1:1/x");
  assert.ok(s.id);
  const again = new MonitorStore(dir);
  assert.equal(again.services.length, 1);
  assert.equal(again.services[0].name, "up");
  assert.equal(store.setEnabled(s.id, false), true);
  assert.equal(store.services[0].enabled, false);
  assert.equal(store.removeService(s.id), true);
  assert.equal(store.services.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("up service probes ok, models kind hits /v1/models", async () => {
  const { store, srv, url } = await withStore();
  try {
    store.addService("ok", "http", url);
    store.addService("mods", "models", url + "/v1");
    const res = await store.check();
    assert.equal(res.length, 2);
    assert.ok(res.every((r) => r.ok), "all probes ok");
    assert.equal(store.openAlerts().length, 0);
  } finally { srv.close(); rmSync(store.dir, { recursive: true, force: true }); }
});

test("down fires once, ack works, ok resolves", async () => {
  const { store, srv, url } = await withStore();
  try {
    store.addService("dead", "http", "http://127.0.0.1:1/x");
    const fired: unknown[] = [];
    await store.check((t, d) => { if (t === "alert.fired") fired.push(d); });
    assert.equal(store.openAlerts().length, 1);
    assert.equal(fired.length, 1);
    await store.check();
    assert.equal(store.openAlerts().length, 1);
    const open = store.openAlerts()[0];
    assert.equal(store.ackAlert(open.id), true);
    store.services[0].url = url;
    const resolved: unknown[] = [];
    await store.check((t, d) => { if (t === "alert.resolved") resolved.push(d); });
    assert.equal(store.openAlerts().length, 0);
    assert.equal(resolved.length, 1);
    assert.equal(store.alerts[0].state, "resolved");
    store.setEnabled(store.services[0].id, false);
    const res = await store.check();
    assert.equal(res.length, 0);
  } finally { srv.close(); rmSync(store.dir, { recursive: true, force: true }); }
});
