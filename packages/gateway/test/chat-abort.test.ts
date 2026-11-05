import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SessionsStore, MemoryStore } from "@o-harness/core";
import { ChatRuntime } from "../src/chat.ts";

/** Fake streaming model: emits content deltas, then (mode="tools") a tool_call, slowly. */
function fakeModel(mode: "plain" | "tools"): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const steps: Array<() => void> = [
          () => res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
          () => res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'),
        ];
        if (mode === "tools") {
          steps.push(() => res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"memory_search","arguments":"{\"query\":\"x\"}"}}]}}]}\n\n'));
        }
        steps.push(() => { res.write("data: [DONE]\n\n"); res.end(); });
        let i = 0;
        const tick = () => {
          if (req.aborted) { clearInterval(iv); return; }
          if (i >= steps.length) { clearInterval(iv); return; }
          steps[i++]();
        };
        const iv = setInterval(tick, 150);
        res.on("close", () => clearInterval(iv));
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + (srv.address() as any).port + "/v1";
      resolve({ url, close: () => srv.close() });
    });
  });
}

function rig(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "oh-abort-"));
  const sessions = new SessionsStore(dir);
  const session = sessions.create("t", "main");
  const settings = { resolveDefault: () => ({ baseUrl: url, apiKey: undefined, model: { id: "m" }, effort: "low" as const }) };
  const chat = new ChatRuntime({ settings, sessions, memory: new MemoryStore(dir), callDevice: async () => ({}) } as any);
  return { dir, chat, sessions };
}

test("abort mid-generation: partial text kept, no hang", async () => {
  const fake = await fakeModel("plain");
  const r = rig(fake.url);
  try {
    const ac = new AbortController();
    const p = r.chat.chat("main", "hi", { signal: ac.signal });
    await new Promise((res) => setTimeout(res, 250));
    ac.abort();
    const out = await p; // must resolve (not throw/hang)
    assert.match(out.text, /Hel?|stopped/);
    const s = r.sessions.get("main");
    const last = s!.entries[s!.entries.length - 1];
    assert.equal((last.data as any).role, "assistant");
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("pre-aborted signal: immediate stop", async () => {
  const fake = await fakeModel("plain");
  const r = rig(fake.url);
  try {
    const ac = new AbortController();
    ac.abort();
    const out = await r.chat.chat("main", "hi", { signal: ac.signal });
    assert.equal(out.text, "(stopped)");
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("no abort still completes normally", async () => {
  const fake = await fakeModel("plain");
  const r = rig(fake.url);
  try {
    const out = await r.chat.chat("main", "hi", {});
    assert.match(out.text, /Hello/);
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});
