import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantsStore } from "@o-harness/core";
import { ToolBroker } from "../src/toolbroker.ts";

function mk(): { broker: ToolBroker; grants: GrantsStore; calls: unknown[][]; events: [string, unknown][]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ohbrk-"));
  const grants = new GrantsStore(join(dir, "grants"));
  const calls: unknown[][] = [];
  const events: [string, unknown][] = [];
  const invoke = async (dev: string, tool: string, args: unknown) => { calls.push([dev, tool, args]); return "ran:" + tool; };
  const broker = new ToolBroker(grants, invoke, (t, d) => { events.push([t, d]); });
  broker.offer("dev1", [{ name: "calendar.list", description: "events" }, { name: "calendar.create", description: "new" }]);
  return { broker, grants, calls, events, dir };
}

test("broker: offer/has/forget + unknown tool errors", async () => {
  const { broker, dir } = mk();
  await assert.rejects(() => broker.call("dev1", "nope", {}));
  assert.equal(broker.has("dev1", "calendar.list"), true);
  assert.equal(broker.has("dev2", "calendar.list"), false);
  assert.equal(Object.keys(broker.list()).length, 1);
  assert.equal(broker.list("dev1")["dev1"].length, 2);
  broker.forget("dev1");
  assert.equal(Object.keys(broker.list()).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("broker: standing grant skips approval", async () => {
  const { broker, grants, calls, events, dir } = mk();
  grants.grant("dev1", "calendar.list");
  const r = await broker.call("dev1", "calendar.list", {}, "minion:1", 1500);
  assert.equal(r, "ran:calendar.list");
  assert.equal(calls.length, 1);
  assert.equal(events.filter((e) => e[0] === "tools.ask").length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("broker: ask -> approve+remember -> later grant", async () => {
  const { broker, calls, events, dir } = mk();
  const p = broker.call("dev1", "calendar.create", { t: 1 }, "m", 5000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(broker.pending().length, 1);
  const ask = broker.pending()[0];
  assert.equal(broker.respond(ask.id, true, true, { admin: true }), true);
  assert.equal(await p, "ran:calendar.create");
  await broker.call("dev1", "calendar.create", {}, "m2", 1500);
  assert.equal(calls.length, 2);
  assert.equal(broker.pending().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("broker: deny path + owner-only respond", async () => {
  const { broker, dir } = mk();
  const p = broker.call("dev1", "calendar.list", {}, "m", 3000);
  await new Promise((r) => setTimeout(r, 30));
  const ask = broker.pending()[0];
  assert.throws(() => broker.respond(ask.id, true, true, { deviceId: "other" }), /owner/);
  assert.equal(broker.respond(ask.id, false, false, { admin: true }), true);
  await assert.rejects(() => p, /denied/);
  assert.equal(broker.pending().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("broker: approval timeout", async () => {
  const { broker, dir } = mk();
  const p = broker.call("dev1", "calendar.list", {}, "m", 100);
  await assert.rejects(() => p, /timed out/);
  assert.equal(broker.pending().length, 0);
  rmSync(dir, { recursive: true, force: true });
});