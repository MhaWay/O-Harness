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
