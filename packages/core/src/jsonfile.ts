// Atomic JSON persistence: write temp + fsync + rename, so a crash mid-save
// can never leave a truncated/corrupt store file (rename is atomic on POSIX).
import { openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";

export function atomicWrite(file: string, data: string, mode?: number): void {
  const tmp = file + ".tmp";
  const fd = openSync(tmp, "w", mode ?? 0o644);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
