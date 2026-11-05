import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway.ts";

// Audit coverage: privileged RPCs (session delete, tool responses, schedule remove) must leave trails on disk.
const tmps: string[] = [];
const stoppers: Promise<void>[] = [];
after(async () => { for (const p of stoppers) await p.catch(() => {}); for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("privileged actions land in the audit trail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-audit-")); tmps.push(dir);
  const gw = new Gateway({ port: 19193, host: "127.0.0.1", plugins: [], tls: "off", overlay: "off" }, dir);
  stoppers.push(Promise.resolve(gw.stop()).catch(() => {}));
  await gw.start();
  const rpc = (m: string, p?: unknown) => gw.rpc.call(m, p, { admin: true }) as Promise<any>;
  const s = await rpc("sessions.create", { title: "audit-e2e" });
  assert.ok(s && s.id);
  await rpc("sessions.delete", { id: s.id });
  const r = await rpc("tools.respond", { id: "ghost-ask", approved: true, remember: false });
  assert.equal(r.ok, false); // unknown ask: handled, still audited
  const job = await rpc("schedule.create", { label: "audit-job", message: "noop", cadence: { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.ok(job && job.id);
  await rpc("schedule.remove", { id: job.id });
  const events = readFileSync(join(dir, "audit", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { event: string }).event);
  assert.ok(events.includes("sessions.delete"), "sessions.delete: " + events.join(","));
  assert.ok(events.includes("tools.respond"), "tools.respond: " + events.join(","));
  assert.ok(events.includes("schedule.remove"), "schedule.remove: " + events.join(","));
  await gw.stop();
});
