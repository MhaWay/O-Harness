import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceStore, defaultVoiceConfig } from "../src/voice.ts";

test("voice: defaults, partial save, persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohvoice-"));
  const v = new VoiceStore(dir);
  const d = defaultVoiceConfig();
  assert.equal(v.get().tts.url, d.tts.url);
  assert.equal(v.get().autoSpeak, false);
  v.save({ tts: { enabled: true, url: "http://x:9", language: "en" } });
  assert.equal(v.get().tts.url, "http://x:9");
  assert.equal(v.get().asr.url, d.asr.url, "untouched section preserved");
  v.save({ autoSpeak: true });
  const w = new VoiceStore(dir);
  assert.equal(w.get().tts.url, "http://x:9");
  assert.equal(w.get().autoSpeak, true);
  rmSync(dir, { recursive: true, force: true });
});