import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/models.ts";

test("settings: upsert, resolveDefault, removeProvider", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohset-"));
  const s = new SettingsStore(dir);
  const seeded = s.get().providers.length;
  s.upsertProvider({ id: "p1", name: "P one", baseUrl: "http://h:1/v1", models: [{ id: "m1" }] } as never);
  s.upsertProvider({ id: "p1", name: "P1", baseUrl: "http://h:2/v1", models: [{ id: "m1" }, { id: "m2" }] } as never);
  assert.equal(s.get().providers.length, seeded + 1);
  s.save({ ...s.get(), default: { providerId: "p1", modelId: "m2", effort: "low" } } as never);
  const d = s.resolveDefault();
  assert.equal(d!.baseUrl, "http://h:2/v1");
  assert.equal(d!.model.id, "m2");
  assert.equal(d!.effort, "low");
  assert.ok(s.resolveRef("p1", "m1"));
  assert.equal(s.resolveRef("p1", "zz"), undefined);
  s.removeProvider("p1");
  assert.equal(s.get().providers.length, seeded);
  assert.equal(s.resolveDefault(), undefined);
  const again = new SettingsStore(dir);
  assert.equal(again.get().providers.length, seeded);
  rmSync(dir, { recursive: true, force: true });
});