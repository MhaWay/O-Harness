import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway.ts";

// sessions.list.lastMessage: the GUI subline / tooltip source (round 77).
const tmps: string[] = [];
const stoppers: Promise<void>[] = [];
after(async () => { for (const p of stoppers) await p.catch(() => {}); for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("sessions.list exposes lastMessage from the newest chat entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-last-")); tmps.push(dir);
  const gw = new Gateway({ port: 19213, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  stoppers.push(Promise.resolve(gw.stop()).catch(() => {}));
  await gw.start();
  const s = await gw.rpc.call("sessions.create", { title: "last-e2e" }, { admin: true }) as { id: string };
  // no chat entries yet -> field absent
  let ls = (await gw.rpc.call("sessions.list", { includeArchived: true }, { admin: true })) as { id: string; lastMessage?: string }[];
  assert.equal((ls.find((x) => x.id === s.id) || {}).lastMessage, undefined);
  gw.sessions.append(s.id, { ts: Date.now(), from: "user", kind: "entry", data: { note: "not chat" } } as any);
  ls = (await gw.rpc.call("sessions.list", {}, { admin: true })) as { id: string; lastMessage?: string }[];
  assert.equal((ls.find((x) => x.id === s.id) || {}).lastMessage, undefined);
  gw.sessions.append(s.id, { ts: Date.now(), from: "user", kind: "chat", data: { role: "user", text: "first chat line" } } as any);
  gw.sessions.append(s.id, { ts: Date.now(), from: "user", kind: "chat", data: { role: "assistant", text: "second chat line" } } as any);
  ls = (await gw.rpc.call("sessions.list", {}, { admin: true })) as { id: string; lastMessage?: string }[];
  assert.equal((ls.find((x) => x.id === s.id) || {}).lastMessage, "second chat line");
  await gw.stop();
});
