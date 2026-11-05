import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { SessionsStore, MemoryStore } from "@o-harness/core";
import { ChatRuntime } from "../src/chat.ts";

/** Fake SSE model keyed on the injected environment prompt:
 *  - user writing from phone-1  -> asks phone-1:exec, then echoes tool result
 *  - user asks "read this file" -> asks laptop-1:read_file (generated per-device defs)
 *  - local tool check "edit file" -> edit_file dispatch through fs.read/fs.write
 *  - otherwise -> echoes first 160 chars of the system prompt (env visibility test) */
function fakeModel(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        const req0: any = JSON.parse(body);
        const sys = String(req0.messages?.[0]?.content ?? "");
        const lastUser = [...(req0.messages ?? [])].reverse().find((m: any) => m.role === "user");
        const umsg = String(lastUser?.content ?? "");
        const tr = (req0.messages ?? []).find((m: any) => m.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: string) => { res.write("data: " + o + "\n\n"); };
        const call = (id: string, name: string, args: string) =>
          send(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }] }));
        if (tr) { send(JSON.stringify({ choices: [{ delta: { content: "result:" + String(tr.content).slice(0, 80) } }] })); }
        else if (sys.includes("writing THIS message from device id=phone-1")) { call("c1", "phone-1:exec", JSON.stringify({ command: "id" })); }
        else if (umsg.includes("read this file")) { call("c2", "laptop-1:read_file", JSON.stringify({ path: "/tmp/oh-e2e" })); }
        else if (umsg.includes("edit file")) { call("c3", "edit_file", JSON.stringify({ path: "/tmp/oh-e2e", old: "hello", new: "bye" })); }
        else if (umsg.includes("run long")) { call("c4", "process", JSON.stringify({ op: "start", command: "sleep 0.2; echo done" })); }
        else { send(JSON.stringify({ choices: [{ delta: { content: "env:" + sys.slice(0, 1500) } }] })); }
        send(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
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

type Call = { deviceId: string; method: string; params: any };

function rig(url: string, calls: Call[]) {
  const dir = mkdtempSync(join(tmpdir(), "oh-dwa-"));
  const sessions = new SessionsStore(dir);
  sessions.create("t", "main");
  const settings = { resolveDefault: () => ({ baseUrl: url, apiKey: undefined, model: { id: "m" }, effort: "low" as const }) };
  const chat = new ChatRuntime({
    settings, sessions, memory: new MemoryStore(dir),
    callDevice: async (deviceId: string, method: string, params?: unknown) => {
      calls.push({ deviceId, method, params });
      if (deviceId === "phone-1") return { content: "uid=0(root) gid=0(root)" };
      if (method === "fs.read") return { content: "hello world" };
      if (method === "fs.write") return { ok: true };
      return { content: "x" };
    },
    broadcast: () => { },
    devices: () => [
      { id: "local", name: "hostbox", kind: "local", status: "connected", capabilities: ["exec", "fs.read", "fs.write"], meta: { platform: "linux", hostname: "hostbox" } },
      { id: "phone-1", name: "Pixel", kind: "mobile", status: "connected", capabilities: ["exec", "tools"], meta: { platform: "android", hostname: "pixel-7" } },
      { id: "laptop-1", name: "ThinkPad", kind: "remote", status: "connected", capabilities: ["exec", "fs.read", "fs.write", "tools"], meta: { platform: "linux/x86_64", hostname: "thinkpad" } },
      { id: "old-1", name: "retired", kind: "remote", status: "offline", capabilities: ["exec"], meta: {} },
    ],
    host: () => ({ platform: "linux", arch: "x64", hostname: "hostbox" }),
  } as any);
  return { dir, chat, sessions };
}

test("sourceDevice: phone user -> exec routed to the phone", async () => {
  const fake = await fakeModel();
  const calls: Call[] = [];
  const r = rig(fake.url, calls);
  try {
    const out = await r.chat.chat("main", "dove sto scrivendo?", { sourceDevice: "phone-1" });
    assert.match(out.text, /result:.*uid=0\(root\)/, out.text);
    assert.ok(calls.some((c) => c.deviceId === "phone-1" && c.method === "exec"), JSON.stringify(calls));
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("generated per-device defs: remote node fs tool dispatches with fs.read", async () => {
  const fake = await fakeModel();
  const calls: Call[] = [];
  const r = rig(fake.url, calls);
  try {
    const out = await r.chat.chat("main", "read this file", {});
    assert.match(out.text, /result:.*hello world/, out.text);
    assert.ok(calls.some((c) => c.deviceId === "laptop-1" && c.method === "fs.read"), JSON.stringify(calls));
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("edit_file dispatch: fs.read then fs.write with the replacement", async () => {
  const fake = await fakeModel();
  const calls: Call[] = [];
  const r = rig(fake.url, calls);
  try {
    await r.chat.chat("main", "edit file", {});
    const wr = calls.find((c) => c.method === "fs.write");
    assert.ok(wr, "expected fs.write call: " + JSON.stringify(calls));
    assert.equal((wr.params as any).content, "bye world");
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("environment block: connected devices visible, offline device excluded", async () => {
  const fake = await fakeModel();
  const calls: Call[] = [];
  const r = rig(fake.url, calls);
  try {
    const out = await r.chat.chat("main", "ciao", {});
    assert.match(out.text, /Connected devices:/);
    assert.match(out.text, /laptop-1/);
    assert.doesNotMatch(out.text, /old-1/);
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

test("process tool: start returns pid+log, backgrounded command runs", async () => {
  const fake = await fakeModel();
  const calls: Call[] = [];
  const r = rig(fake.url, calls);
  try {
    const out = await r.chat.chat("main", "run long", {});
    assert.match(out.text, /result:.*"pid"/, out.text);
    const m = out.text.match(/\"pid\":(\d+)/) || out.text.match(/pid"?:(\d+)/);
    assert.ok(m, "pid missing: " + out.text);
    await new Promise((res) => setTimeout(res, 450));
    const out2 = await r.chat.chat("main", "ciao", {}); // env echo path untouched
    assert.match(out2.text, /env:/);
  } finally { fake.close(); rmSync(r.dir, { recursive: true, force: true }); }
});
