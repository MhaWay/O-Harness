import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip, unzip, runBackup, listBackups, restoreBackup } from "../src/backup.ts";

describe("backup", () => {
  it("zip roundtrips text + binary", () => {
    const z = zip([["a.txt", "hello hello hello"], ["sub/b.bin", new Uint8Array([1, 2, 3, 4])]]);
    const back = unzip(z);
    assert.equal(back.length, 2);
    assert.equal(back[0][0], "a.txt");
    assert.equal(back[0][1].toString(), "hello hello hello");
    assert.equal(Buffer.compare(back[1][1], Buffer.from([1, 2, 3, 4])), 0);
  });
  it("runBackup creates a zip excluding backups/ and prunes to keep", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-bk-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s1.json"), "{}", "utf-8");
    writeFileSync(join(dir, "config.json"), "{}", "utf-8");
    const r1 = runBackup(dir, { keep: 2 });
    assert.ok(r1.files >= 2);
    assert.ok(existsSync(r1.file));
    // older duplicates created manually then run again: keep prunes
    const fake = join(dir, "backups", "old.zip");
    writeFileSync(fake, "x");
    runBackup(dir, { keep: 1 });
    assert.equal(existsSync(fake), false, "old fake zip pruned to keep=1");
    const listed = listBackups(dir);
    assert.equal(listed.length, 1);
  });
  it("restoreBackup restores files and rejects path traversal + bad zip", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-bk-"));
    writeFileSync(join(dir, "x.txt"), "original", "utf-8");
    const z = zip([["x.txt", "restored"], ["sub/y.txt", "new"]]);
    const zf = join(dir, "snap.zip");
    writeFileSync(zf, z);
    const r = restoreBackup(dir, zf);
    assert.equal(r.restored, 2);
    assert.equal(readFileSync(join(dir, "x.txt"), "utf-8"), "restored");
    assert.equal(readFileSync(join(dir, "sub", "y.txt"), "utf-8"), "new");
    // traversal must throw
    const evil = zip([["../evil.txt", "nope"]]);
    const ef = join(dir, "evil.zip");
    writeFileSync(ef, evil);
    assert.throws(() => restoreBackup(dir, ef), /unsafe path/);
    // non-zip must throw
    const junk = join(dir, "junk.zip");
    writeFileSync(junk, "not a zip at all, not even close to 22 bytes long");
    assert.throws(() => restoreBackup(dir, junk), /valid ZIP/);
  });
});