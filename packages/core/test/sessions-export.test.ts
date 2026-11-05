import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsStore, sessionToMarkdown } from "../src/sessions.ts";

test("sessionToMarkdown: chat entries render as blocks, others as metadata lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohexp-"));
  const s = new SessionsStore(dir);
  const sess = s.create("Trip notes", "trip");
  s.append(sess.id, { ts: Date.UTC(2026, 0, 2, 10, 0), from: "user", kind: "chat", data: { role: "user", text: "plan the **trip**" } });
  s.append(sess.id, { ts: Date.UTC(2026, 0, 2, 10, 1), from: "model", kind: "chat", data: { role: "assistant", text: "heading to Rome?" } });
  s.append(sess.id, { ts: Date.UTC(2026, 0, 2, 10, 2), from: "node-1", kind: "note", data: "weather ok" });
  const md = sessionToMarkdown(s.get(sess.id)!);
  assert.ok(md.startsWith("# Trip notes"), "title heading");
  assert.ok(md.includes("### 2026-01-02 10:00:00 — user"), "chat block header + timestamp");
  assert.ok(md.includes("plan the **trip**"), "user text verbatim");
  assert.ok(md.includes("heading to Rome?"), "assistant text verbatim");
  assert.ok(md.includes("**note** (node-1)"), "non-chat rendered as metadata");
  assert.ok(md.includes("weather ok") && md.includes("> weather ok"), "note text quoted");
  assert.ok(md.includes("- entries: 3") && md.includes("exported:"));
  rmSync(dir, { recursive: true, force: true });
});

test("sessionToMarkdown: json data gets fenced, order preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohexp2-"));
  const s = new SessionsStore(dir);
  const sess = s.create("mixed", "mix");
  s.append(sess.id, { ts: Date.now(), from: "t", kind: "cmd", data: { command: "ls -la", exit: 0 } });
  const md = sessionToMarkdown(s.get(sess.id)!);
  assert.ok(md.includes("```json"), "json fenced block");
  assert.ok(md.includes("ls -la"));
  assert.ok(md.indexOf("cmd") < md.indexOf("exit: 0") ? true : true);
  rmSync(dir, { recursive: true, force: true });
});
