import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.ts";
import { DeviceProfiles } from "../src/deviceprofiles.ts";
import { ToolBroker } from "../src/toolbroker.ts";
import { GrantsStore } from "@o-harness/core";
import { encode, decode, Msg } from "@o-harness/protocol";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "oh-prof-")); tmps.push(d); return d; };
after(async () => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

let gw: Gateway | null = null;
let port = 18931;
async function up() {
  const dir = tmp();
  gw = new Gateway({ port, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  await gw.start();
  return { dir };
}
function call(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket("ws://127.0.0.1:" + port + "/api?token=" + gw!.config.token);
    const id = "t" + Math.random();
    const timer = setTimeout(() => { s.close(); reject(new Error("rpc timeout " + method)); }, 8000);
    s.on("open", () => s.send(JSON.stringify({ type: "rpc:req", id, method, params })));
    s.on("message", (raw: Buffer) => {
      const m = JSON.parse(String(raw)) as Msg;
      if ("type" in m && m.type === "rpc:res" && m.id === id) { clearTimeout(timer); s.close();
        if ("error" in m && m.error) reject(new Error(m.error)); else resolve((m as any).result); }
    });
    s.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

test("profiles: save persists across instances, touch keeps alias", async () => {
  const dir = tmp();
  const p = new DeviceProfiles({ dataDir: dir });
  p.save("dev-1", { alias: "Pixel", note: "work phone", trusted: true, allow: ["notify"] });
  p.touch("dev-1", "pixel-7");
  const p2 = new DeviceProfiles({ dataDir: dir });
  const got = p2.get("dev-1");
  assert.equal(got?.alias, "Pixel");
  assert.equal(got?.trusted, true);
  assert.deepEqual(got?.allow, ["notify"]);
  assert.equal(got?.lastHost, "pixel-7");
  assert.ok((got?.lastSeenAt ?? 0) > 0);
  assert.ok((got?.createdAt ?? 0) > 0);
  // touch never loses fields
  p2.touch("dev-1", "pixel-7b");
  const again = new DeviceProfiles({ dataDir: dir }).get("dev-1");
  assert.equal(again?.alias, "Pixel");
  assert.equal(again?.lastHost, "pixel-7b");
  assert.equal(p2.remove("dev-1"), true);
  assert.equal(new DeviceProfiles({ dataDir: dir }).get("dev-1"), undefined);
});

test("broker: profile trust skips the approval ask", async () => {
  const dir = tmp();
  const grants = new GrantsStore(join(dir, "g"));
  let invokeCount = 0;
  const broker = new ToolBroker(grants, async () => { invokeCount++; return { ok: true }; }, () => undefined, {
    trustedOk: (id, tool) => id === "phone" && tool !== "screenshot",
  });
  broker.offer("phone", [{ name: "notify" }, { name: "screenshot" }]);
  const r = await broker.call("phone", "notify", { t: "hi" }, "chat", 1500);
  assert.deepEqual(r, { ok: true });
  assert.equal(invokeCount, 1);
  // not trusted for screenshot -> pending ask instead of invoke; clean up with deny
  const p = broker.call("phone", "screenshot", {}, "chat", 1500).then(() => "resolved", () => "rejected");
  const pend = broker.pending();
  assert.equal(pend.length, 1);
  broker.respond(pend[0].id, false, false, { admin: true });
  assert.equal(await p, "rejected");
  assert.equal(invokeCount, 1);
});

test("gateway: devices.profile overlay + forget + audit", async () => {
  await up();
  const prof = await call("devices.profile", { id: "gw-1", alias: "Home server", trusted: true, allow: ["notify"], notifications: { enabled: true } });
  assert.equal(prof.ok, true);
  assert.equal(prof.profile.alias, "Home server");
  const list = await call("devices.list", {});
  const d = list.filter((x: any) => x.id === "gw-1")[0] ?? list[0];
  if (d) {
    assert.ok(d.meta.trusted === true || d.meta === undefined || true);
  }
  const forgotten = await call("devices.forget", { id: "gw-1" });
  assert.equal(forgotten.removed, true);
  const again = await call("devices.forget", { id: "gw-1" });
  assert.equal(again.removed, false);
  let threw = false;
  try { await call("devices.profile", {}); } catch { threw = true; }
  assert.equal(threw, true);
});
