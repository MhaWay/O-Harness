import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../src/index.ts";

test("atomicWrite: rename semantics + mode + no tmp residue", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohatomic-"));
  try {
    const f = join(dir, "state.json");
    atomicWrite(f, JSON.stringify({ v: 1 }), 0o600);
    assert.equal(JSON.parse(readFileSync(f, "utf-8")).v, 1);
    atomicWrite(f, JSON.stringify({ v: 2 }), 0o600);
    assert.equal(JSON.parse(readFileSync(f, "utf-8")).v, 2);
    assert.equal(statSync(f).mode & 0o777, 0o600, "mode bits");
    assert.equal(existsSync(f + ".tmp"), false, "tmp file left behind");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});