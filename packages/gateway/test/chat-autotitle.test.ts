import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SessionsStore } from "@o-harness/core";
import { ChatRuntime } from "../src/chat.ts";

function fakeModel(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + (srv.address() as any).port + "/v1", close: () => srv.close() }));
  });
}

test("chat auto-titles placeholder sessions from the first message only", async () => {
  const fake = await fakeModel();
  const settings = { resolveDefault: () => ({ baseUrl: fake.url, apiKey: undefined, model: { id: "m" }, effort: "low" }) } as any;

  const dir1 = mkdtempSync(join(tmpdir(), "oh-at-"));
  const s1 = new SessionsStore(dir1);
  s1.create("main", "main");
  const c1 = new ChatRuntime({ settings, sessions: s1, memory: undefined } as any);
  await c1.chat("main", "how do I set up a Raspberry Pi cluster?");
  assert.equal(s1.get("main")!.title, "how do I set up a Raspberry Pi cluster?", "placeholder main gets named");
  await c1.chat("main", "and should it be 64-bit?");
  assert.equal(s1.get("main")!.title.startsWith("how do I"), true, "later messages do not rename");
  rmSync(dir1, { recursive: true, force: true });

  const dir2 = mkdtempSync(join(tmpdir(), "oh-at2-"));
  const s2 = new SessionsStore(dir2);
  s2.create("Project notes", "notes");
  const c2 = new ChatRuntime({ settings, sessions: s2, memory: undefined } as any);
  await c2.chat("notes", "hello there");
  assert.equal(s2.get("notes")!.title, "Project notes", "named sessions keep their title");
  rmSync(dir2, { recursive: true, force: true });
  fake.close();
});
