import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsStore } from "../src/sessions.ts";

test("sessions: remove deletes file + refuses main; rename persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohses-"));
  const s = new SessionsStore(dir);
  const main = s.create("main", "main");
  const tmp = s.create("tmp one");
  s.append(tmp.id, { ts: Date.now(), from: "t", kind: "note", data: "x" });
  assert.ok(existsSync(join(dir, "sessions", tmp.id + ".json")));

  assert.equal(s.remove(main.id), false, "main protected");
  assert.equal(s.remove("nope"), false);

  assert.equal(s.rename(tmp.id, "  new label  "), true);
  assert.equal(s.get(tmp.id)!.title, "new label");

  assert.equal(s.remove(tmp.id), true);
  assert.equal(s.get(tmp.id), undefined);
  assert.ok(!existsSync(join(dir, "sessions", tmp.id + ".json")));
  assert.equal(s.list().filter((x) => x.id === tmp.id).length, 0);

  // reload from disk keeps deletion + title
  const again = new SessionsStore(dir);
  assert.equal(again.get(tmp.id), undefined);
  assert.ok(again.get(main.id));
  rmSync(dir, { recursive: true, force: true });
});

test("sessions: rename empty keeps title, unknown refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohses2-"));
  const s = new SessionsStore(dir);
  const a = s.create("keepme");
  assert.equal(s.rename(a.id, "   "), true);
  assert.equal(s.get(a.id)!.title, "keepme");
  assert.equal(s.rename("zz", "x"), false);
  rmSync(dir, { recursive: true, force: true });
});
