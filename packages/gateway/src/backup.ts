/**
 * Backup & restore for the whole data dir (config, sessions, memory, pairing,
 * grants, settings, auth, voice, scheduler, monitor, logs, tls).
 *
 * Format: dependency-free ZIP (deflate) — readable by every archive tool.
 * Restoring requires the gateway to be stopped (we refuse while a live
 * instance is registered).
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const p = join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile()) out.push(p);
    }
  }
  return out;
}

/** Pack [name, content] pairs into a ZIP buffer (deflate, deterministic order). */
export function zip(entries) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of sorted) {
    const raw = content instanceof Uint8Array ? content : Buffer.from(String(content));
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** Unpack a ZIP buffer back to [name, content] pairs. */
export function unzip(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = Buffer.from(buf.subarray(i + 30, i + 30 + nameLen)).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    out.push([name, method === 8 ? Buffer.from(inflateRawSync(data)) : Buffer.from(data)]);
    i = start + compSize;
  }
  return out;
}

/** Create a ZIP of dataDir (excluding backups/) in destDir, keeping `keep` newest. */
export function runBackup(dataDir, opts = {}) {
  const destDir = opts.destDir || join(dataDir, "backups");
  const keep = opts.keep ?? 14;
  mkdirSync(destDir, { recursive: true });
  const entries = [];
  for (const p of walkFiles(dataDir)) {
    const rel = relative(dataDir, p).split(sep).join("/");
    if (!rel) continue;
    if (rel === "backups" || rel.startsWith("backups/")) continue;
    try { entries.push([rel, readFileSync(p)]); } catch { /* vanished mid-walk */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(destDir, "o-harness-backup-" + stamp + ".zip");
  const buf = zip(entries);
  writeFileSync(file, buf);
  const made = listBackups(dataDir, opts);
  for (const b of made.slice(keep)) { try { rmSync(b.path); } catch { /* ignore */ } }
  return { file, bytes: buf.length, files: entries.length, kept: Math.min(keep, made.length) };
}

export function listBackups(dataDir, opts = {}) {
  const destDir = opts.destDir || join(dataDir, "backups");
  if (!existsSync(destDir)) return [];
  const rows = [];
  for (const n of readdirSync(destDir)) {
    if (!n.endsWith(".zip")) continue;
    const p = join(destDir, n);
    try { const st = statSync(p); rows.push({ name: n, path: p, bytes: st.size, mtime: st.mtimeMs }); } catch { /* ignore */ }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

/** Restore a backup into dataDir. Caller must stop the gateway first. */
export function restoreBackup(dataDir, file, opts = {}) {
  if (!existsSync(file)) throw new Error("backup file not found: " + file);
  const buf = readFileSync(file);
  if (buf.length < 22 || buf.readUInt32LE(buf.length - 22) !== 0x06054b50) {
    throw new Error("not a valid ZIP archive: " + file);
  }
  let restored = 0;
  for (const [name, content] of unzip(buf)) {
    if (name.includes("../") || name.startsWith("/")) throw new Error("unsafe path in archive: " + name);
    const target = join(dataDir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    if (!opts.dryRun) { writeFileSync(target, content, { mode: 0o600 }); }
    restored++;
  }
  return { restored, dryRun: !!opts.dryRun };
}