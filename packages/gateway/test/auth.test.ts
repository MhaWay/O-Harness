import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, parseCookie, sessionCookieValue, clearCookieValue, userInfoSub } from "../src/auth.ts";

test("auth: password set/verify + sessions persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohauth-"));
  const a = new AuthStore(dir);
  assert.equal(a.verify("whatever"), false);
  assert.throws(() => a.setPassword("short"));
  a.setPassword("supersecret1");
  assert.equal(a.verify("supersecret1"), true);
  assert.equal(a.verify("wrong-password"), false);
  const { id } = a.newSession({ kind: "password", label: "laptop" });
  assert.ok(a.resolve(id));
  const b = new AuthStore(dir);
  assert.equal(b.verify("supersecret1"), true);
  assert.ok(b.resolve(id), "session survives restart");
  b.revoke(b.listSessions()[0].key);
  assert.equal(b.resolve(id), null);
  b.setPassword("anotherpassword");
  assert.equal(b.listSessions().length, 0, "password change invalidates sessions");
  rmSync(dir, { recursive: true, force: true });
});

test("auth: session expiry + cookie helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohauth2-"));
  const a = new AuthStore(dir);
  const { id } = a.newSession({ kind: "oauth", provider: "github", sub: "alice", ttlMs: -1 });
  assert.equal(a.resolve(id), null, "expired session not resolvable");
  assert.equal(parseCookie("a=1; ohs=abc123; b=2", "ohs"), "abc123");
  assert.equal(parseCookie("a=1", "ohs"), null);
  assert.equal(parseCookie(undefined, "ohs"), null);
  assert.match(sessionCookieValue("xyz"), /ohs=xyz/);
  assert.match(sessionCookieValue("xyz"), /HttpOnly/);
  assert.match(clearCookieValue(), /Max-Age=0.*HttpOnly|HttpOnly.*Max-Age=0/);
  assert.equal(userInfoSub({ sub: "s1", id: "i1" }), "s1");
  assert.equal(userInfoSub({ id: "i1" }), "i1");
  assert.equal(userInfoSub({ user: { id: "deep" } }), "deep");
  assert.equal(userInfoSub({ email: "a@b.c" }), "a@b.c");
  rmSync(dir, { recursive: true, force: true });
});