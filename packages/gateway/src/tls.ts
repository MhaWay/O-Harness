import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface TlsMaterial { key: string; cert: string; generated: boolean; note?: string }

/**
 * Resolve TLS material for a gateway. "auto" = self-signed in <dataDir>/tls (generated on demand,
 * regenerated when expired/short-lived); "off" = plain HTTP. Returns null when off / unavailable.
 */
export function resolveTls(mode: "auto" | "off" | undefined, dataDir: string): TlsMaterial | null {
  if (!mode || mode === "off") return null;
  const dir = join(dataDir, "tls");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    const key = readFileSync(keyPath, "utf-8");
    const cert = readFileSync(certPath, "utf-8");
    if (!key.startsWith("-----BEGIN") || !cert.startsWith("-----BEGIN")) return { key, cert, generated: false, note: "tls material unreadable" };
    if (!expiredSoon(cert, 14)) return { key, cert, generated: false };
    // fall through and regenerate
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const cn = hostname() || "o-harness.local";
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-subj", "/CN=" + cn,
      "-addext", "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost,DNS:" + cn,
    ], { stdio: "ignore" });
    return { key: readFileSync(keyPath, "utf-8"), cert: readFileSync(certPath, "utf-8"), generated: true };
  } catch (err) {
    return { key: "", cert: "", generated: false, note: "tls generation failed: " + (err instanceof Error ? err.message : String(err)) };
  }
}

function expiredSoon(cert: string, days: number): boolean {
  try {
    const out = execFileSync("openssl", ["x509", "-noout", "-checkend", String(days * 86400)], { input: cert, encoding: "utf-8" });
    return /will expire/i.test(out);
  } catch { return true; }
}
