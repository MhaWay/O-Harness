import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../src/log.ts";

function fresh(): { store: LogStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ohlogs-"));
  return { store: new LogStore(dir), dir };
}

test("add + tail returns newest first with filters", () => {
  const { store } = fresh();
  store.info("gateway", "started");
  store.warn("auth", "login failed", { ip: "1.2.3.4" });
  store.error("agents", "minion x failed: boom");
  const t = store.tail({ limit: 10 });
  assert.equal(t.total, 3);
  assert.equal(t.entries[0].level, "error");
  const w = store.tail({ level: "warn" });
  assert.equal(w.total, 2); // minimum-severity semantics: warn+error
  const onlyErr = store.tail({ level: "error" });
  assert.equal(onlyErr.total, 1);
  const infos = store.tail({ level: "debug" });
  assert.equal(infos.total, 3);
  const q = store.tail({ q: "minion" });
  assert.equal(q.total, 1);
  assert.equal(q.entries[0].module, "agents");
});

test("stats counts warns and errors", () => {
  const { store } = fresh();
  store.warn("auth", "a");
  store.warn("auth", "b");
  store.error("x", "c");
  const st = store.stats();
  assert.equal(st.errors24h, 1);
  assert.equal(st.warns24h, 2);
  assert.ok(st.lastError);
});

test("persists to jsonl and survives reload", () => {
  const { store, dir } = fresh();
  store.info("gateway", "persist me");
  assert.ok(existsSync(dir));
  assert.ok(readdirSync(dir).some((f) => f.endsWith(".jsonl")));
  const again = new LogStore(dir);
  const t = again.tail({ limit: 10 });
  assert.equal(t.total, 1);
  assert.equal(t.entries[0].msg, "persist me");
  rmSync(dir, { recursive: true, force: true });
});

test("single warn not double counted across ring + files", () => {
  const { store, dir } = fresh();
  store.warn("auth", "dup");
  const t = store.tail({ limit: 10 });
  assert.equal(t.total, 1);
  const st = store.stats();
  assert.equal(st.warns24h, 1);
  const again = new LogStore(dir);
  again.warn("auth", "second");
  assert.equal(again.tail({ limit: 10 }).total, 2);
  assert.equal(again.stats().warns24h, 2);
  rmSync(dir, { recursive: true, force: true });
});