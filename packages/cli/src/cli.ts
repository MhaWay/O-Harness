import { readFileSync } from "node:fs";
import { loadConfig } from "@o-harness/gateway";
import { createDefaultGateway } from "@o-harness/gateway";
import { runNodeLoop } from "@o-harness/gateway";
import type { OverlayKind } from "@o-harness/gateway";
import { callOnce, wsUrl } from "./client.ts";
import { hostname } from "node:os";

function withoutFlag(rest: string[], ...names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (names.some((n) => rest[i] === "--" + n)) { i++; continue; }
    out.push(rest[i]!);
  }
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
}

function extractPort(args: string[]): { rest: string[]; portFlag?: string } {
  const rest: string[] = [];
  let portFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1] !== undefined) { portFlag = args[++i]!; continue; }
    if (args[i] !== undefined && args[i].startsWith("--port=")) { portFlag = args[i]!.split("=")[1]; continue; }
    rest.push(args[i]!);
  }
  return { rest, portFlag };
}

export async function main(args: string[]): Promise<void> {
  const { rest: prePort, portFlag } = extractPort(args);
  const [cmd, ...rest] = prePort;
  const cfg = loadConfig();
  const port = Number(portFlag ?? cfg.port);

  if (cmd === "gateway" || cmd === undefined) {
    const sub = rest[0] ?? "start";
    if (sub === "start") {
      const pluginsArg = flag(args, "plugins")?.split(",").filter(Boolean);
      const host = flag(args, "host") ?? "0.0.0.0";
      const gw = createDefaultGateway({ port, host, ...(pluginsArg ? { plugins: pluginsArg } : {}) });
      await gw.start();
      console.log("gateway (local) running: ws://127.0.0.1:" + port);
      console.log("health: http://127.0.0.1:" + port + "/health  config: " + process.env.OH_DATA_DIR || require("node:os").homedir() + "/.o-harness/config.json");
      await new Promise(() => { /* keep alive */ });
      return;
    }
    throw new Error("unknown gateway subcommand: " + sub);
  }

  if (cmd === "token") {
    console.log(cfg.token);
    return;
  }

  if (cmd === "devices") {
    const list = await callOnce("devices.list", undefined, port);
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (cmd === "exec") {
    const deviceId = flag(args, "device");
    const command = withoutFlag(rest, "device").join(" ");
    if (!command) throw new Error("usage: o-h exec [--device <id>] <command>");
    const res = await callOnce<any>("device.exec", { command, ...(deviceId ? { deviceId } : {}) }, port);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "read") {
    const deviceId = flag(args, "device");
    const path = withoutFlag(rest, "device")[0];
    if (!path) throw new Error("usage: o-h read [--device <id>] <path>");
    const res = await callOnce<any>("device.fs.read", { path, ...(deviceId ? { deviceId } : {}) }, port);
    process.stdout.write(res.content);
    return;
  }

  if (cmd === "write") {
    const deviceId = flag(args, "device");
    const clean = withoutFlag(rest, "device");
    const path = clean[0];
    const source = clean[1];
    if (!path) throw new Error("usage: o-h write [--device <id>] <path> [source-file]");
    const content = source ? readFileSync(source, "utf-8") : await new Promise<string>((res) => {
      let buf = "";
      process.stdin.on("data", (c) => { buf += c.toString(); });
      process.stdin.on("end", () => res(buf));
    });
    const r2 = await callOnce("device.fs.write", { path, content, ...(deviceId ? { deviceId } : {}) }, port);
    console.log(JSON.stringify(r2));
    return;
  }

  if (cmd === "agents" || cmd === "minions") {
    const sub = rest[0] ?? "list";
    if (sub === "spawn") {
      const task = withoutFlag(rest.slice(1), "title", "model", "effort", "max-turns").join(" ");
      if (!task) throw new Error("usage: o-h agents spawn <task> [--title T] [--model M] [--effort E] [--max-turns N]");
      const params: Record<string, unknown> = { task };
      const t = flag(args, "title"); if (t) params.title = t;
      const mo = flag(args, "model"); if (mo) params.model = mo;
      const ef = flag(args, "effort"); if (ef) params.effort = ef;
      const mt = flag(args, "max-turns"); if (mt) params.maxTurns = Number(mt);
      const m = await callOnce("agents.spawn", params, port);
      console.log(JSON.stringify(m, null, 2));
      return;
    }
    if (sub === "list") {
      const list = await callOnce<any[]>("agents.list", {}, port);
      for (const m of list) console.log(m.id + " [" + m.status + "] t" + m.turnsUsed + "/" + m.maxTurns + " " + m.title + (m.result ? " -> " + String(m.result).slice(0, 80) : "") + (m.error ? " !! " + m.error : ""));
      if (!list.length) console.log("(no minions)");
      return;
    }
    if (sub === "show") {
      const id = withoutFlag(rest.slice(1), "follow")[0];
      if (!id) throw new Error("usage: o-h agents show <id>");
      const m = await callOnce<any>("agents.get", { id }, port);
      if (!m) throw new Error("unknown minion: " + id);
      console.log(JSON.stringify({ ...m, entries: undefined }, null, 2));
      console.log("--- entries ---");
      for (const e of m.entries ?? []) console.log("[" + e.seq + " " + e.kind + "] " + JSON.stringify(e.data).slice(0, 300));
      return;
    }
    if (sub === "kill") {
      const id = rest[1];
      if (!id) throw new Error("usage: o-h agents kill <id>");
      console.log(JSON.stringify(await callOnce("agents.kill", { id }, port)));
      return;
    }
    throw new Error("unknown agents subcommand: " + sub);
  }

  if (cmd === "memory") {
    const sub = rest[0] ?? "list";
    if (sub === "add") {
      const text = withoutFlag(rest.slice(1), "subject", "layer", "importance", "supersedes").join(" ");
      if (!text) throw new Error("usage: o-h memory add [--subject S] [--layer L] [--importance N] <text>");
      const params: Record<string, unknown> = { text, provenance: "cli" };
      const subject = flag(args, "subject"); if (subject) params.subject = subject;
      const layer = flag(args, "layer"); if (layer) params.layer = layer;
      const imp = flag(args, "importance"); if (imp) params.importance = Number(imp);
      const sup = flag(args, "supersedes"); if (sup) params.supersedes = sup.split(",");
      console.log(JSON.stringify(await callOnce("memory.add", params, port), null, 2));
      return;
    }
    if (sub === "search") {
      const query = withoutFlag(rest.slice(1), "subject", "limit", "tags").join(" ");
      const params: Record<string, unknown> = {};
      if (query) params.query = query;
      const subject = flag(args, "subject"); if (subject) params.subject = subject;
      const tags = flag(args, "tags"); if (tags) params.tags = tags.split(",");
      const limit = flag(args, "limit"); if (limit) params.limit = Number(limit);
      const hits = await callOnce<any[]>("memory.search", params, port);
      if (!hits.length) console.log("(no hits)");
      for (const h of hits) console.log(h.score.toFixed(3) + " [" + h.subject + "/" + h.layer + "] " + h.text);
      return;
    }
    if (sub === "list") {
      const subject = flag(args, "subject");
      const validity = flag(args, "validity");
      const params: Record<string, unknown> = { ...(subject ? { subject } : {}), ...(validity ? { validity } : {}) };
      const list = await callOnce<any[]>("memory.list", params, port);
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (sub === "consolidate") {
      const subject = flag(args, "subject");
      const dryRun = args.includes("--dry-run");
      const params: Record<string, unknown> = { dryRun, ...(subject ? { subject } : {}) };
      const report = await callOnce<Record<string, unknown>>("memory.consolidate", params, port);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    throw new Error("unknown memory subcommand: " + sub);
  }

  if (cmd === "node") {
    const sub = rest[0];
    if (sub === "connect") {
      const name = flag(args, "name") ?? hostname();
      const deviceId = flag(args, "device-id");
      const directPort = flag(args, "direct-port");
      const noDirect = args.includes("--no-direct");
      const overlay = flag(args, "overlay") as OverlayKind | undefined; // off | tailscale | zerotier
      const overlayAuthKey = flag(args, "overlay-auth-key");
      const overlayNetId = flag(args, "overlay-net");
      await runNodeLoop({ url: wsUrl(port, "/node", cfg.token), token: cfg.token, name, deviceId, directPort: directPort ? Number(directPort) : undefined, noDirect, overlay, overlayAuthKey, overlayNetId, log: (m: string) => console.log(m) });
      return;
    }
    throw new Error("usage: o-h node connect [--name <name>] [--device-id id] [--direct-port n] [--no-direct] [--overlay off|tailscale|zerotier] [--overlay-auth-key k] [--overlay-net id]");
  }

  if (cmd === "pair") {
    const sub = rest[0];
    if (sub === "create") {
      const kind = flag(args, "kind") ?? "mobile";
      const scopes = (flag(args, "scopes") ?? "read,write").split(",").filter(Boolean);
      const ttl = flag(args, "ttl");
      const c = await callOnce("pairing.create", { kind, scopes, ttlMinutes: ttl ? Number(ttl) : undefined }, port);
      console.log(JSON.stringify(c));
      return;
    }
    if (sub === "list") {
      const list = await callOnce("pairing.list", undefined, port);
      for (const d of list as Array<{ id: string; name: string; kind: string; scopes: string[]; pairedAt: number; revokedAt?: number; lastSeenAt?: number }>) {
        console.log(d.id + "  " + d.name + "  [" + d.kind + "]  scopes=" + (d.revokedAt ? "REVOKED" : d.scopes.join(",")) + "  lastSeen=" + (d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : "-"));
      }
      return;
    }
    if (sub === "revoke") {
      const id = rest[1];
      if (!id) throw new Error("usage: o-h pair revoke <deviceId>");
      await callOnce("pairing.revoke", { id }, port);
      console.log("revoked " + id);
      return;
    }
    if (sub === "redeem") {
      // device-side: exchange a 6-digit code for a secret via HTTP /pair
      const code = rest[1];
      const name = flag(args, "name") ?? hostname();
      const base = flag(args, "url") ?? "http://127.0.0.1:" + port;
      const r = await fetch(base + "/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
      const j = await r.json() as { ok: boolean; deviceId?: string; secret?: string; error?: string };
      if (!j.ok) throw new Error(j.error ?? "pair failed");
      console.log(JSON.stringify(j));
      return;
    }
    throw new Error("usage: o-h pair create [--kind mobile|remote] [--scopes read,write,admin] [--ttl minutes] | list | revoke <id> | redeem <code> [--name n] [--url http://host:port]");
  }
  if (cmd === "tools") {
    const sub = rest[0] ?? "list";
    if (sub === "list") {
      const list = await callOnce<any[]>("device.tools.list", undefined, port);
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (sub === "call") {
      const dev = flag(args, "device");
      const tool = flag(args, "tool");
      const argsStr = flag(args, "args");
      if (!dev || !tool) throw new Error("usage: o-h tools call --device <id> --tool <name> [--args json]");
      const res = await callOnce<any>("device.tools.call", { deviceId: dev, tool, args: argsStr ? JSON.parse(argsStr) : {} }, port);
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (sub === "pending") {
      const list = await callOnce<any[]>("tools.pending", undefined, port);
      if (!list.length) { console.log("no pending tool approvals"); return; }
      console.log(list.map(a => a.id + " " + a.deviceId + " " + a.tool + " args=" + JSON.stringify(a.args) + " from " + a.requester + " " + new Date(a.createdAt).toLocaleString()).join("\n"));
      return;
    }
    if (sub === "respond") {
      const id = rest[1];
      const approve = flag(args, "approve");
      if (!id) throw new Error("usage: o-h tools respond <ask-id> [--approve [--remember]]");
      await callOnce("tools.respond", { id, approved: approve === undefined || approve !== "no", remember: flag(args, "remember") !== undefined }, port);
      console.log("answered " + id);
      return;
    }
    if (sub === "grants") {
      const dev = flag(args, "device");
      const list = await callOnce<any[]>("grants.list", dev ? { deviceId: dev } : undefined, port);
      console.log(list.length ? list.map(g => g.deviceId + " " + g.tool + (g.lastUsedAt ? " last " + new Date(g.lastUsedAt).toLocaleString() : "")).join("\n") : "no standing grants");
      return;
    }
    if (sub === "revoke") {
      const dev = rest[1], tool = rest[2];
      if (!dev || !tool) throw new Error("usage: o-h tools revoke <deviceId> <tool>");
      await callOnce("grants.revoke", { deviceId: dev, tool }, port);
      console.log("revoked grant " + dev + " " + tool);
      return;
    }
    throw new Error("usage: o-h tools list | call --device <id> --tool <name> [--args json] | pending | respond <ask-id> [--approve [--remember]] | grants [--device <id>] | revoke <deviceId> <tool>");
  }


  if (cmd === "sessions") {
    const list = await callOnce("sessions.list", undefined, port);
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (cmd === "session") {
    const sub = rest[0];
    const id = flag(args, "id") ?? "main";
    if (sub === "show") {
      const s2 = await callOnce("sessions.get", { id }, port);
      if (!s2) throw new Error("unknown session: " + id);
      console.log(JSON.stringify(s2, null, 2));
      return;
    }
    if (sub === "create") {
      const title = flag(args, "title") ?? rest[1] ?? "session";
      const s2 = await callOnce("sessions.create", { title }, port);
      console.log(JSON.stringify(s2, null, 2));
      return;
    }
    if (sub === "append") {
      const kind = flag(args, "kind") ?? "note";
      const data = withoutFlag(rest.slice(1), "kind").join(" ") || undefined;
      const e = await callOnce("sessions.append", { id, kind, from: (await import("node:os")).hostname(), data }, port);
      console.log(JSON.stringify(e));
      return;
    }
    throw new Error("usage: o-h session show|create|append [--id <id>] [--title t] [--kind k] [text]");
  }

  throw new Error("unknown command: " + cmd + "\ncommands: gateway start | token | devices | exec | read | write | sessions | session | node connect [--device-id id]");
}
