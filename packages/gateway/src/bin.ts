#!/usr/bin/env node
import { createDefaultGateway } from "./gateway.ts";

const args = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith("--")) opts[a.slice(2)] = args[++i] ?? "";
}

const gw = createDefaultGateway(opts.port ? { port: Number(opts.port) } : {});
await gw.start();
process.stdout.write("O-Harness gateway (local) ws://" + gw.config.host + ":" + gw.config.port + "\n");
const shutdown = async () => { await gw.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
