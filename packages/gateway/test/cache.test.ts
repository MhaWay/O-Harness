import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCache } from "../src/cache.ts";

test("wrap calls fn once for same key, hit second time", async () => {
  const c = new ModelCache(60000, 10);
  let n = 0;
  const opts = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const v1 = await c.wrap(opts, async () => { n++; return { x: 1 }; });
  const v2 = await c.wrap(opts, async () => { n++; return { x: 2 }; });
  assert.equal(n, 1);
  assert.equal(v2.x, 1);
  const st = c.stats();
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 1);
});

test("different messages miss; cacheBust forces miss; ttl expires", async () => {
  const c = new ModelCache(50, 10);
  let n = 0;
  await c.wrap({ model: "m", messages: [{ role: "user", content: "a" }] }, async () => { n++; return 1; });
  await c.wrap({ model: "m", messages: [{ role: "user", content: "b" }] }, async () => { n++; return 2; });
  assert.equal(n, 2);
  await c.wrap({ model: "m", messages: [{ role: "user", content: "a" }], cacheBust: "2" }, async () => { n++; return 3; });
  assert.equal(n, 3);
  await new Promise((r) => setTimeout(r, 80));
  const v = await c.wrap({ model: "m", messages: [{ role: "user", content: "a" }] }, async () => { n++; return 4; });
  assert.equal(n, 4);
  assert.equal(v, 4);
});

test("evicts oldest past maxEntries, clear returns count", async () => {
  const c = new ModelCache(60000, 2);
  await c.wrap({ model: "m", messages: [{ role: "u", content: "1" }] }, async () => 1);
  await c.wrap({ model: "m", messages: [{ role: "u", content: "2" }] }, async () => 2);
  await c.wrap({ model: "m", messages: [{ role: "u", content: "3" }] }, async () => 3);
  assert.equal(c.stats().entries, 2);
  assert.equal(c.clear(), 2);
  assert.equal(c.stats().entries, 0);
});
