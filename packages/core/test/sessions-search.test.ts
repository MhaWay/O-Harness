import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsStore } from "../src/sessions.ts";

test("sessions.search: matches titles and entry text, respects kind filter", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohsearch-"));
  const s = new SessionsStore(dir);
  const a = s.create("Alpha project notes", "alpha");
  const b = s.create("Empty chat");
  const c = s.create("Side notes");
  s.append(a.id, { ts: Date.now(), from: "t", kind: "chat", data: { role: "user", text: "the ZEBRA sleeps today" } });
  s.append(b.id, { ts: Date.now(), from: "t", kind: "note", data: "zebra is here" });
  const r1 = s.search("zebra");
  assert.equal(r1.length, 2, "both zebra sessions");
  assert.ok(r1.find((h) => h.id === "alpha" && h.hits === 1));
  const r2 = s.search("zebra", { kind: "chat" });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].id, "alpha");
  assert.ok(r2[0].snippet.includes("ZEBRA sleeps"), "snippet from entry text");
  const r3 = s.search("EMPTY chat"); // title, case-insensitive
  assert.equal(r3.length, 1);
  assert.equal(r3[0].id, b.id);
  assert.equal(r3[0].hits, 1);
  assert.equal(s.search("").length, 0, "empty q -> []");
  assert.equal(s.search("   ").length, 0);
  assert.equal(s.search("nothinghere123").length, 0);
  // limit respected
  for (let i = 0; i < 4; i++) s.append(c.id, { ts: Date.now(), from: "t", kind: "note", data: "zebra note " + i });
  const r4 = s.search("zebra", { limit: 2 });
  assert.ok(r4.length <= 2);
  rmSync(dir, { recursive: true, force: true });
});

test("sessions.search: results sorted by most recent match; reload sees it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohsearch2-"));
  const s = new SessionsStore(dir);
  const old = s.create("old side");
  const fresh = s.create("fresh side");
  s.append(old.id, { ts: 1000, from: "t", kind: "note", data: "alpha one" });
  s.append(fresh.id, { ts: Date.now(), from: "t", kind: "note", data: "alpha two" });
  const r = s.search("alpha");
  assert.ok(r.length >= 2);
  assert.equal(r[0].id, fresh.id, "freshest match first");
  const again = new SessionsStore(dir);
  assert.equal(again.search("alpha").length, r.length);
  rmSync(dir, { recursive: true, force: true });
});
