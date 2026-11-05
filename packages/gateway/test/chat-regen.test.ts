import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SessionsStore, MemoryStore } from "@o-harness/core";
import { ChatRuntime } from "../src/chat.ts";

/** Fake streaming model echoing a fixed token. */
function fakeModel(tok: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"' + tok + '"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + (srv.address() as any).port + "/v1";
      resolve({ url, close: () => srv.close() });
    });
  });
}

test("regenerate drops the last answer and re-runs from the same user message", async () => {
  const fake = await fakeModel("A1");
  const dir = mkdtempSync(join(tmpdir(), "oh-regen-"));
  const sessions = new SessionsStore(dir);
  const session = sessions.create("t", "main");
  const settings = { resolveDefault: () => ({ baseUrl: fake.url, apiKey: undefined, model: { id: "m" }, effort: "low" as const }) };
  const chat = new ChatRuntime({ settings, sessions, memory: new MemoryStore(dir), callDevice: async () => ({}) } as any);
  try {
    await chat.chat(session.id, "hello");
    assert.equal(sessions.get(session.id)!.entries.length, 2); // user + assistant
    const r = await chat.regenerate(session.id);
    assert.ok(r, "expected a regenerate result");
    assert.equal(r!.text, "A1");
    assert.equal(r!.dropped, 1);
    // still just one user + one assistant turn (the user message is not duplicated)
    const chats = sessions.get(session.id)!.entries.filter((e) => e.kind === "chat");
    assert.equal(chats.length, 2);
    assert.equal((chats[0].data as any).role, "user");
    fake.close();
  } finally { fake.close(); }
});

test("regenerate returns null when there is no user message", async () => {
  const fake = await fakeModel("A1");
  const dir = mkdtempSync(join(tmpdir(), "oh-regen2-"));
  const sessions = new SessionsStore(dir);
  const session = sessions.create("t", "main");
  const settings = { resolveDefault: () => ({ baseUrl: fake.url, apiKey: undefined, model: { id: "m" }, effort: "low" as const }) };
  const chat = new ChatRuntime({ settings, sessions, memory: new MemoryStore(dir), callDevice: async () => ({}) } as any);
  try {
    assert.equal(await chat.regenerate(session.id), null);
  } finally { fake.close(); }
});
