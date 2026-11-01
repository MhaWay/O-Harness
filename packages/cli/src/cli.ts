import { readFileSync } from "node:fs";
import { loadConfig } from "@o-harness/gateway";
import { createDefaultGateway } from "@o-harness/gateway";
import { connectNode } from "@o-harness/gateway";
import { callOnce, wsUrl } from "./client.ts";
import { hostname } from "node:os";

function withoutFlag(rest: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--" + name) { i++; continue; }
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
      const host = flag(args, "host") ?? "127.0.0.1";
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

  if (cmd === "node") {
    const sub = rest[0];
    if (sub === "connect") {
      const name = flag(args, "name") ?? hostname();
      const { nodeId } = await connectNode({ url: wsUrl(port, "/node", cfg.token), token: cfg.token, name });
      console.log("connected as device " + nodeId + " (Ctrl-C to disconnect)");
      process.on("SIGINT", () => process.exit(0));
      await new Promise(() => { /* keep alive */ });
      return;
    }
    throw new Error("usage: o-h node connect [--name <name>]");
  }

  throw new Error("unknown command: " + cmd + "\ncommands: gateway start | token | devices | exec | read | write | node connect");
}
