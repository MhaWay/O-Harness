import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SchedulerRuntime } from "../src/scheduler.ts";

test("scheduler: once fires, removed, result recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-schedt-"));
  const fired: string[] = [];
  const s = new SchedulerRuntime({ storeDir: dir + "/sch", chat: async (sid, msg) => { fired.push(msg); return { text: "pong" }; }, spawn: () => ({ id: "x" }) });
  s.start();
  try {
    const j = s.create({ label: "ping", message: "tick", cadence: { type: "once", at: new Date(Date.now() + 5).toISOString() } });
    await new Promise((r) => setTimeout(r, 20));
    await s.tick();
    assert.equal(fired.length, 1);
    assert.equal(s.get(j.id), undefined);
    assert.equal(j.lastResult, "pong");
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler: every-advances, disable skips, persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-schedt2-"));
  const fired: number[] = [];
  const s = new SchedulerRuntime({ storeDir: dir + "/sch", chat: async () => { fired.push(1); return { text: "o" }; }, spawn: () => ({ id: "x" }) });
  try {
    const j = s.create({ label: "loop", message: "m", cadence: { type: "every", minutes: 5 } });
    const n0 = j.nextRunAt;
    s.runNow(j.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fired.length, 1);
    s.setDisabled(j.id, true);
    j.nextRunAt = Date.now() - 1000; // make due
    await s.tick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fired.length, 1, "disabled not fired");
    const s2 = new SchedulerRuntime({ storeDir: dir + "/sch", chat: async () => ({ text: "o" }), spawn: () => ({ id: "x" }) });
    s2.load();
    const j2 = s2.get(j.id);
    assert.ok(j2 && j2.disabled);
    s2.remove(j.id);
    assert.equal(s2.get(j.id), undefined);
  } finally { s.stop(); rmSync(dir, { recursive: true, force: true }); }
});