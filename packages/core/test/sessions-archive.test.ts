import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsStore } from "../src/sessions.ts";

test("sessions.archive: hides from default list, keeps usable, survives reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "oharch-"));
  const s = new SessionsStore(dir);
  s.create("Keep me", "keep");
  const gone = s.create("Hide me", "gone");
  assert.equal(s.list().find((x) => x.id === "gone")!.archived, false, "default unarchived");
  assert.ok(s.archive("gone"), "archive returns ok for known id");
  assert.equal(s.list().find((x) => x.id === "gone"), undefined, "hidden by default");
  assert.equal(s.list({ includeArchived: true }).find((x) => x.id === "gone")!.archived, true, "visible + tagged with includeArchived");
  const e = s.append("gone", { kind: "chat", data: { role: "user", text: "still usable" } });
  assert.equal(e.seq, 1, "archived session is still writable");
  assert.ok(s.archive("nope") === false || s.archive("nope") === undefined, "unknown id refused");
  const re = new SessionsStore(dir);
  assert.equal(re.list().find((x) => x.id === "gone"), undefined, "archived after reload");
  assert.ok(re.archive("gone", false), "unarchive ok");
  assert.ok(re.list().some((x) => x.id === "gone"), "back in default list");
  assert.equal(re.list().find((x) => x.id === "gone")!.archived, false, "flag cleared");
});
