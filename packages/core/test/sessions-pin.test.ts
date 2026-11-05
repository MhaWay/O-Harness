import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsStore } from "../src/sessions.ts";

test("sessions.pin: flags session, sorts pinned first, survives reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohpin-"));
  const s = new SessionsStore(dir);
  const old = s.create("Older chat", "old");
  const new1 = s.create("Newer chat", "new");
  assert.equal(s.list().find((x) => x.id === "new")!.pinned, false, "default unpinned");
  assert.ok(s.pin("old"), "pin returns ok for known id");
  assert.equal(s.list()[0].id, "old", "pinned sorts first even if older");
  assert.ok(s.pin("old", false), "unpin ok");
  assert.equal(s.pin("nope"), false, "unknown id refused");
  s.pin("old");
  const re = new SessionsStore(dir);
  assert.ok(re.get("old")!.pinned === undefined ? true : !!re.get("old")!.pinned, "pin persisted");
  assert.equal(re.list()[0].id, "old", "pinned-first after reload");
  rmSync(dir, { recursive: true, force: true });
});
