// O-Harness companion: runs on the user's machine and exposes native hardware
// capabilities as gateway-offered tools. Browsers block mic/speaker/screen on
// plain-IP http origins; the companion is the bridge: mic capture, playback,
// screenshot, notifications.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import type { OfferedTool } from "./toolbroker.ts";

function runCmd(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try { child = spawn(cmd, args); } catch (e) { rejectPromise(e); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; try { child.kill(); } catch { /* ignore */ } resolvePromise({ code: -1 }); }, timeoutMs);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(e); } });
    child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ code: code ?? -1 }); } });
  });
}

export const COMPANION_TOOLS: OfferedTool[] = [
  { name: "audio.listen", description: "Record audio from the machine microphone and return wav base64 (speech-to-text source). Args: {seconds?: number, default 5}", parameters: { type: "object", properties: { seconds: { type: "number" } } } },
  { name: "audio.speak", description: "Play base64 wav audio through the machine speakers. Args: {audio: b64 wav}", parameters: { type: "object", properties: { audio: { type: "string" } }, required: ["audio"] } },
  { name: "screenshot", description: "Capture the machine screen and return png base64." },
  { name: "notify", description: "Show a desktop notification on the machine. Args: {title?: string, body?: string}", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } } },
];

async function audioListen(seconds: number): Promise<{ audio: string; format: string }> {
  const os = platform();
  const dir = mkdtempSync(join(tmpdir(), "oh-comp-"));
  const out = join(dir, "mic.wav");
  const secs = Math.min(60, Math.max(1, seconds));
  try {
    if (os === "darwin") {
      await runCmd("afrecord", ["-o", out, "-d", String(secs)]);
    } else {
      await runCmd("sox", ["-q", "-r", "16000", "-c", "1", out, "trim", "0", String(secs)], secs * 1000 + 15_000);
    }
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(out);
    return { audio: buf.toString("base64"), format: "wav" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function audioSpeak(b64: string): Promise<{ ok: true }> {
  const os = platform();
  const dir = mkdtempSync(join(tmpdir(), "oh-comp-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const f = join(dir, "play.wav");
    await writeFile(f, Buffer.from(b64, "base64"));
    if (os === "darwin") await runCmd("afplay", [f]);
    else if (os === "win32") await runCmd("powershell", ["-NoProfile", "-c", "(New-Object Media.SoundPlayer '" + f.replace(/'/g, "") + "').PlaySync()"], 120_000);
    else await runCmd("sox", [f], 120_000);
    return { ok: true };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function screenshot(): Promise<{ image: string; format: string }> {
  const os = platform();
  const dir = mkdtempSync(join(tmpdir(), "oh-comp-"));
  const out = join(dir, "shot.png");
  try {
    if (os === "darwin") await runCmd("screencapture", ["-x", out]);
    else if (os === "win32") await runCmd("powershell", ["-NoProfile", "-c", "Add-Type -AssemblyName System.Drawing,System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); $bmp.Save('" + out.replace(/'/g, "") + "'); $g.Dispose(); $bmp.Dispose()"]);
    else await runCmd("scrot", ["--silent", out]);
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(out);
    return { image: buf.toString("base64"), format: "png" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function notify(title: string, body: string): Promise<{ ok: true }> {
  const os = platform();
  if (os === "darwin") await runCmd("osascript", ["-e", "display notification " + JSON.stringify(body) + " with title " + JSON.stringify(title)]);
  else if (os === "win32") await runCmd("powershell", ["-NoProfile", "-c", "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $n=New-Object Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000," + JSON.stringify(title) + "," + JSON.stringify(body) + ",[Windows.Forms.ToolTipIcon]::Info)"]);
  else await runCmd("notify-send", [title, body]);
  return { ok: true };
}

export async function companionInvoke(tool: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "audio.listen") return await audioListen(Number(a.seconds ?? 5));
  if (tool === "audio.speak") {
    const b = String(a.audio ?? "");
    if (!b) throw new Error("audio.speak: audio (base64 wav) required");
    return await audioSpeak(b);
  }
  if (tool === "screenshot") return await screenshot();
  if (tool === "notify") return await notify(String(a.title ?? "O-Harness"), String(a.body ?? ""));
  throw new Error("companion: unknown tool '" + tool + "'");
}

export function companionTools(): OfferedTool[] { return COMPANION_TOOLS.map((t) => ({ ...t })); }
