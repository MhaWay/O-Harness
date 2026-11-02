// Voice configuration for O-Harness: batch TTS/ASR (lfm3 :8023) + realtime (lfm3 :8024).
// lfm3-realtime exposes a non-OpenAI batch API: POST /tts_to_audio {text} -> wav;
// POST /asr {audio_b64|audio_path, language} -> {text}; realtime is OpenAI-Realtime-protocol ws.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VoiceConfig {
  asr: { enabled: boolean; url: string; language: string };
  tts: { enabled: boolean; url: string; language: string };
  realtime: { enabled: boolean; url: string; voice: string };
  autoSpeak: boolean;
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    asr: { enabled: true, url: "http://127.0.0.1:8023", language: "italian" },
    tts: { enabled: true, url: "http://127.0.0.1:8023", language: "italian" },
    realtime: { enabled: true, url: "ws://127.0.0.1:8024/", voice: "female" },
    autoSpeak: false,
  };
}

export class VoiceStore {
  #path: string;
  #cfg: VoiceConfig;
  // NOTE: no parameter properties (strip-only mode).
  constructor(dir: string) {
    this.#path = join(dir, "voice.json");
    this.#cfg = defaultVoiceConfig();
    try {
      const j = JSON.parse(readFileSync(this.#path, "utf-8"));
      const d = defaultVoiceConfig();
      this.#cfg = {
        asr: { ...d.asr, ...(j.asr || {}) },
        tts: { ...d.tts, ...(j.tts || {}) },
        realtime: { ...d.realtime, ...(j.realtime || {}) },
        autoSpeak: Boolean(j.autoSpeak),
      };
    } catch { /* first run */ }
  }
  get(): VoiceConfig { return this.#cfg; }
  save(c: Partial<VoiceConfig>): VoiceConfig {
    const d = defaultVoiceConfig();
    this.#cfg = {
      asr: { ...d.asr, ...(c.asr || {}) },
      tts: { ...d.tts, ...(c.tts || {}) },
      realtime: { ...d.realtime, ...(c.realtime || {}) },
      autoSpeak: c.autoSpeak !== undefined ? Boolean(c.autoSpeak) : this.#cfg.autoSpeak,
    };
    const dir = this.#path.substring(0, this.#path.lastIndexOf("/"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#cfg, null, 2), { mode: 0o600 });
    return this.#cfg;
  }
}

/** Synthesize via lfm3 batch API -> raw WAV bytes. */
export async function voiceTts(url: string, text: string): Promise<Uint8Array> {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(base + "/tts_to_audio", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error("tts failed: HTTP " + res.status + " " + (await res.text().then((t) => t.slice(0, 120))));
  return new Uint8Array(await res.arrayBuffer());
}

/** Transcribe wav bytes (or b64) via lfm3 batch API -> text. */
export async function voiceAsr(url: string, audioB64: string, language: string): Promise<string> {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(base + "/asr", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_b64: audioB64, language }), signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error("asr failed: HTTP " + res.status + " " + (await res.text().then((t) => t.slice(0, 120))));
  const j = (await res.json()) as { text?: string };
  return String(j.text ?? "");
}

/** Probe voice services: batch /health + realtime ws handshake. */
export async function voiceProbe(cfg: VoiceConfig): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const r = await fetch(cfg.tts.url.replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(4000) });
    out.batch = { ok: r.ok, ...(r.ok ? (await r.json() as object) : {}) };
  } catch (e) { out.batch = { ok: false, error: String(e) }; }
  try {
    const { default: WS } = await import("ws") as { default: unknown };
    const W = WS as new (u: string) => { on: (e: string, f: () => void) => void; close: () => void };
    out.realtime = await new Promise((resolve) => {
      const w = new W(cfg.realtime.url);
      const t = setTimeout(() => { try { w.close(); } catch { /* noop */ } resolve({ ok: false, error: "timeout" }); }, 4000);
      w.on("open", () => { clearTimeout(t); w.close(); resolve({ ok: true }); });
      w.on("error", (e: unknown) => { clearTimeout(t); resolve({ ok: false, error: String(e) }); });
    });
  } catch (e) { out.realtime = { ok: false, error: String(e) }; }
  return out;
}