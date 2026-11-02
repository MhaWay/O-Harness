import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.ts";

describe("doctor", () => {
  it("runs all checks on an empty data dir with useful hints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-doc-"));
    const checks = await runDoctor({ dataDir: dir });
    const names = checks.map((c) => c.name);
    for (const n of ["config", "gateway", "instances", "disk", "models", "voice", "tls", "backups", "runtime"]) {
      assert.ok(names.includes(n), "has check " + n);
    }
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(byName.config.ok, true);
    assert.equal(byName.instances.ok, true, "isolated dir has no other instances");
    assert.equal(byName.disk.ok, true);
    assert.equal(byName.models.ok, false, "no providers -> not ok");
    assert.ok(byName.models.hint, "hint for missing providers");
    assert.equal(byName.backups.ok, false, "no backups yet");
    for (const c of checks) {
      assert.equal(typeof c.name, "string");
      assert.equal(typeof c.ok, "boolean");
      assert.equal(typeof c.detail, "string");
      assert.ok(c.detail.length > 0);
    }
  });
  it("models check passes with a fake provider listing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-doc2-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 8791, token: "x" }), "utf-8");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers: [{ id: "f", name: "fake", url: "http://127.0.0.1:1/does-not-exist", models: [] }] }), "utf-8");
    const checks = await runDoctor({ dataDir: dir });
    const m = checks.find((c) => c.name === "models:f");
    assert.ok(m, "per-provider check emitted");
    assert.equal(m.ok, false, "unreachable provider fails the check");
  });
});