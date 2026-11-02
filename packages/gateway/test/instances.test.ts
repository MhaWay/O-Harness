import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceRegistry, listInstances } from "../src/instances.ts";

describe("instance registry", () => {
  it("registers self, lists live, removes on stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-inst-"));
    const reg = new InstanceRegistry(dir, { pid: process.pid, port: 19501, host: "127.0.0.1", mode: "test" });
    const others = reg.start();
    assert.equal(others.length, 0, "no siblings in a fresh dir");
    const list = listInstances(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].pid, process.pid);
    assert.equal(list[0].port, 19501);
    reg.stop();
    assert.equal(listInstances(dir).length, 0);
  });

  it("discovers sibling instances (other live pid)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-inst-"));
    const reg = new InstanceRegistry(dir, { pid: process.pid, port: 19502, host: "127.0.0.1", mode: "test" });
    // simulate a second gateway that already registered (pid 1 is always alive on linux)
    writeFileSync(join(dir, "instances", "1.json"), JSON.stringify({ pid: 1, port: 19555, host: "h", mode: "sibling", startedAt: Date.now() - 1, heartbeatAt: Date.now() }));
    const others = reg.start();
    assert.ok(others.some((o) => o.port === 19555), "the sibling file is discovered");
    reg.stop();
    assert.equal(existsSync(join(dir, "instances", "1.json")), true, "sibling file survives our stop");
  });

  it("stale (dead-pid) entries are pruned on read", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-inst-"));
    const ghost = join(dir, "instances", "999999999.json");
    const reg = new InstanceRegistry(dir, { pid: process.pid, port: 19504, host: "127.0.0.1", mode: "test" });
    writeFileSync(ghost, JSON.stringify({ pid: 999999999, port: 1, host: "x", mode: "ghost", startedAt: Date.now(), heartbeatAt: Date.now() }));
    assert.equal(listInstances(dir).length, 0, "dead pid dropped");
    assert.equal(existsSync(ghost), false, "ghost file deleted");
    reg.stop();
  });
});
