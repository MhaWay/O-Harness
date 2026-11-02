import { it } from "node:test";
import assert from "node:assert";
import { LogStore } from "../src/log.ts";
import { resolveLogs } from "../src/logtools.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("resolveLogs injects prior history before the user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-res"));
  try {
    const store = new LogStore(join(dir, "logs"));
    store.error("test", "boom 1", { k: 1 });
    let captured: any = null;
    const stub = async (p: any) => { captured = p.messages; return { choices: [{ message: { content: "analysis: fine" } }] }; };
    const settings = { resolveDefault: () => ({ baseUrl: "http://x/v1", model: { id: "m" } }) };
    const r1 = await resolveLogs(store, stub, settings, {});
    assert.ok(r1.analysis.includes("fine"));
    const r2 = await resolveLogs(store, stub, settings, { history: [{ role: "user", content: "prev q" }, { role: "assistant", content: "prev analysis" }] });
    assert.equal(captured[1].role, "user");
    assert.equal(captured[1].content, "prev q");
    assert.equal(captured[2].role, "assistant");
    assert.equal(captured[2].content, "prev analysis");
    assert.ok(captured[3].content.includes("boom 1"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});