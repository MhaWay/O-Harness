import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, dataDirOf, listInstances } from "@o-harness/gateway";
import { createDefaultGateway } from "@o-harness/gateway";
import { runNodeLoop, runDoctor } from "@o-harness/gateway";
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

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log([
      "O-Harness — personal agent gateway. Global flag: --port <p> (default from ~/.o-harness/config.json).",
      "",
      "gateway start [--port p] [--host h] [--tls auto|off]   start gateway (GUI http://host:port/, mobile /m)",
      "instances                                            live gateway instances sharing this data dir (duplicate detection)",
      "backup run|list|restore <zip> [--dry-run]             automatic daily ZIP backup of the data dir (keep newest)",
      "doctor [--data-dir d] [--deep] [--port p]              one-shot self-check of config, gateway, models, disk, backups",
      "token                                              print admin token",
      "devices                                             list connected devices (+transport)",
      "exec [--device id] <command>                        run command on a device (local default)",
      "read [--device id] <path>                         read a file from a device",
      "write [--device id] <path> [file]                   write a file (or upload file contents)",
      "say <message> [--session s] [--effort e]            chat with the assistant (tool loop + memory)",
      "chat history [--session s]                          show chat history",
      "schedule create|list|run|enable|disable|rm          time triggers (every N min / daily HH:mm / once)",
      "minions spawn|list|show|kill                        dispatch agent tasks (--depends-on a,b chains)",
      "memory add|search|list|consolidate                  durable temporal memory",
      "pair create|list|revoke|redeem                      pairing codes + device secrets with scopes",
      "tools list|call|pending|respond / grants            device-offered tools + approvals",
      "sessions list / sessions search <text> / session show|create|append|export   session logs",
      "node connect [--url wss://..] [--insecure]          run a node that connects to a gateway",
    ].join("\n"));
    return;
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

  if (cmd === "say") {
    const message = rest.filter((a) => !a.startsWith("--")).join(" ");
    if (!message) throw new Error("usage: o-h say <message> [--session S] [--effort E]");
    const sessionId = flag(rest, "session") ?? "main";
    const effort = flag(rest, "effort");
    const r = await callOnce("chat.send", { sessionId, message, effort }, port);
    console.log(r.text);
    return;
  }
  if (cmd === "chat") {
    const sub = rest[0] ?? "history";
    const cargs = rest.slice(1);
    if (sub === "history") {
      const sessionId = flag(cargs, "session") ?? "main";
      const h = await callOnce("chat.history", { sessionId }, port);
      if (!h) throw new Error("unknown session: " + sessionId);
      for (const e of h) console.log(e.seq + " [" + e.role + "] " + e.text);
      return;
    }
    if (sub === "stop") {
      const sessionId = flag(cargs, "session") ?? "main";
      const r = await callOnce("chat.abort", { sessionId }, port);
      console.log(JSON.stringify(r));
      return;
    }
    if (sub === "regen" || sub === "regenerate") {
      const sessionId = flag(cargs, "session") ?? "main";
      const effort = flag(cargs, "effort");
      const r = await callOnce("chat.regenerate", { sessionId, effort }, port);
      if (!r || r.ok === false) throw new Error(String(r && r.reason ? r.reason : "regenerate failed"));
      console.log(r.text);
      return;
    }
    throw new Error("unknown chat subcommand: " + sub);
  }

  if (cmd === "schedule" || cmd === "sched") {
    const sub = rest[0] ?? "list";
    const sargs = rest.slice(1);
    if (sub === "create") {
      const message = withoutFlag(sargs, "task", "session", "every", "daily", "once", "label").join(" ");
      const task = flag(sargs, "task");
      let cadence: any = null;
      const ev = flag(sargs, "every");
      const dy = flag(sargs, "daily");
      const oc = flag(sargs, "once");
      if (ev) cadence = { type: "every", minutes: Number(ev) };
      else if (dy) cadence = { type: "daily", time: dy };
      else if (oc) cadence = { type: "once", at: oc };
      else throw new Error("usage: o-h schedule create <message> [--every N | --daily HH:mm | --once ISO] [--task T] [--session S] [--label L]");
      const r = await callOnce("schedule.create", { message: message || undefined, task: task || undefined, sessionId: flag(sargs, "session"), label: flag(sargs, "label"), cadence }, port);
      console.log(JSON.stringify(r));
      return;
    }
    if (sub === "list") {
      const rows = await callOnce<any[]>("schedule.list", {}, port);
      for (const j of rows) console.log(j.id + " [" + (j.disabled ? "disabled" : "next " + new Date(j.nextRunAt).toLocaleString()) + "] " + j.kind + " " + JSON.stringify(j.label ?? "") + (j.lastResult ? " -> " + String(j.lastResult).slice(0, 70) : ""));
      if (!rows.length) console.log("(no scheduled jobs)");
      return;
    }
    if (sub === "remove" || sub === "rm") { const id = sargs[0]; if (!id) throw new Error("usage: o-h schedule remove <id>"); await callOnce("schedule.remove", { id }, port); console.log(JSON.stringify({ ok: true })); return; }
    if (sub === "run") { const id = sargs[0]; if (!id) throw new Error("usage: o-h schedule run <id>"); console.log(JSON.stringify(await callOnce("schedule.runNow", { id }, port))); return; }
    if (sub === "enable") { const id = sargs[0]; if (!id) throw new Error("usage: o-h schedule enable <id>"); await callOnce("schedule.setDisabled", { id, disabled: false }, port); console.log(JSON.stringify({ ok: true })); return; }
    if (sub === "disable") { const id = sargs[0]; if (!id) throw new Error("usage: o-h schedule disable <id>"); await callOnce("schedule.setDisabled", { id, disabled: true }, port); console.log(JSON.stringify({ ok: true })); return; }
    throw new Error("unknown schedule subcommand: " + sub);
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
      const dep = flag(args, "depends-on"); if (dep) params.dependsOn = dep.split(",").map((x) => x.trim()).filter(Boolean);
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
      if (args.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      const url = flag(args, "url") ?? wsUrl(port, "/node", cfg.token);
      await runNodeLoop({ url: url, token: cfg.token, name, deviceId, directPort: directPort ? Number(directPort) : undefined, noDirect, overlay, overlayAuthKey, overlayNetId, log: (m: string) => console.log(m) });
      return;
    }
    throw new Error("usage: o-h node connect [--name <name>] [--device-id id] [--direct-port n] [--no-direct] [--overlay off|tailscale|zerotier] [--overlay-auth-key k] [--overlay-net id]");
  }

  if (cmd === "companion") {
    // Headless companion: exposes this machine's mic/speaker/screen/notifications
    // as gateway-offered tools (browsers block these on plain-IP origins).
    const sub = rest[0];
    if (sub === "connect" || sub === undefined) {
      const name = flag(args, "name") ?? ("companion@" + hostname());
      const deviceId = flag(args, "device-id");
      const directPort = flag(args, "direct-port");
      const noDirect = args.includes("--no-direct");
      const overlay = flag(args, "overlay") as OverlayKind | undefined;
      const overlayAuthKey = flag(args, "overlay-auth-key");
      const overlayNetId = flag(args, "overlay-net");
      if (args.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      const url = flag(args, "url") ?? wsUrl(port, "/node", cfg.token);
      console.log("companion tools: audio.listen, audio.speak, screenshot, notify");
      await runNodeLoop({ url: url, token: cfg.token, name, deviceId, directPort: directPort ? Number(directPort) : undefined, noDirect, overlay, overlayAuthKey, overlayNetId, log: (m: string) => console.log(m) });
      return;
    }
    throw new Error("usage: o-h companion connect [--url wss://...] [--name n] [--no-direct] [--overlay off|tailscale]");
  }

  if (cmd === "auth") {
    const sub = rest[0];
    if (sub === "set-password") {
      const pw = flag(args, "password") ?? rest[1];
      if (!pw) throw new Error("usage: o-h auth set-password <password> [--url --port]");
      await callOnce("auth.setPassword", { password: pw }, port);
      console.log("master password set; all other login sessions were invalidated");
      return;
    }
    if (sub === "login") {
      const pw = flag(args, "password") ?? rest[1];
      if (!pw) throw new Error("usage: o-h auth login <password>");
      const r = await callOnce("auth.login", { password: pw }, port) as { sessionId: string };
      console.log("ok — connect with ?session=" + r.sessionId + " (valid 30 days; use 'o-h auth sessions' to list)");
      return;
    }
    if (sub === "sessions") {
      const list = await callOnce("auth.sessions.list", undefined, port) as Array<Record<string, unknown>>;
      for (const s of list) console.log(String(s.key) + " [" + s.kind + "] " + (s.label ?? "") + " expires " + new Date(Number(s.expiresAt)).toISOString());
      return;
    }
    if (sub === "revoke-session") {
      const key = rest[1];
      if (!key) throw new Error("usage: o-h auth revoke-session <sessionKey>");
      await callOnce("auth.sessions.revoke", { key }, port);
      console.log("revoked");
      return;
    }
    if (sub === "logout") { const k = flag(args, "key"); await callOnce("auth.logout", k ? { key: k } : undefined, port); console.log("logged out" + (k ? " (session revoked)" : " (this connection)")); return; }
    if (sub === "oauth-set") {
      const name = rest[1];
      if (!name) throw new Error("usage: o-h auth oauth-set <name> --authorize-url --token-url --userinfo-url --client-id --client-secret [--scopes --subs]");
      await callOnce("auth.oauth.set", {
        name,
        authorizeUrl: flag(args, "authorize-url") ?? "",
        tokenUrl: flag(args, "token-url") ?? "",
        userInfoUrl: flag(args, "userinfo-url") ?? "",
        clientId: flag(args, "client-id") ?? "",
        clientSecret: flag(args, "client-secret") ?? "",
        scopes: flag(args, "scopes") ?? "",
        subs: (flag(args, "subs") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      }, port);
      console.log("oauth provider '" + name + "' saved. login url: /oauth/" + name + "/start");
      return;
    }
    if (sub === "oauth-remove") {
      const name = rest[1];
      if (!name) throw new Error("usage: o-h auth oauth-remove <name>");
      await callOnce("auth.oauth.remove", { name }, port);
      console.log("removed " + name);
      return;
    }
    if (sub === "token-login") {
      const en = rest[1] ?? "on";
      if (!["on", "off"].includes(en)) throw new Error("usage: o-h auth token-login on|off");
      const r = await callOnce("auth.setTokenLogin", { enabled: en === "on" }, port) as { tokenEnabled: boolean };
      console.log("token login " + (r.tokenEnabled ? "ENABLED" : "DISABLED") + " (persisted; restart takes full effect)");
      return;
    }
    if (sub === "info") {
      const r = await fetch("http://127.0.0.1:" + port + "/auth/info").then((x) => x.json());
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    throw new Error("usage: o-h auth set-password|login|sessions|revoke-session|logout|oauth-set|oauth-remove|token-login|info");
  }
  if (cmd === "voice") {
    const sub = rest[0] ?? "get";
    const vargs = rest.slice(1);
    if (sub === "get") {
      const v = await callOnce("voice.get", undefined, port);
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    if (sub === "save") {
      const patch: Record<string, unknown> = {};
      const asrUrl = flag(vargs, "asr-url"); const ttsUrl = flag(vargs, "tts-url");
      const rtUrl = flag(vargs, "rt-url"); const vname = flag(vargs, "voice");
      const auto = flag(vargs, "auto-speak"); const lang = flag(vargs, "language");
      if (asrUrl) patch.asr = { url: asrUrl };
      if (ttsUrl) patch.tts = { url: ttsUrl };
      if (lang) { patch.asr = { ...(patch.asr || {}), language: lang }; patch.tts = { ...(patch.tts || {}), language: lang }; }
      if (rtUrl || vname) patch.realtime = { ...(rtUrl ? { url: rtUrl } : {}), ...(vname ? { voice: vname } : {}) };
      if (auto) patch.autoSpeak = auto === "on" || auto === "true" || auto === "1";
      const v = await callOnce("voice.save", patch, port);
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    if (sub === "say") {
      const text = vargs.filter((a) => !a.startsWith("--")).join(" ");
      if (!text) throw new Error("usage: o-h voice say <text> [--out file.wav]");
      const r = await callOnce("voice.speak", { text }, port);
      const out = flag(vargs, "out") ?? "/tmp/oh-tts.wav";
      writeFileSync(out, Buffer.from(String(r.audio), "base64"));
      console.log("wav written: " + out);
      return;
    }
    if (sub === "asr") {
      const file = vargs.filter((a) => !a.startsWith("--"))[0];
      if (!file) throw new Error("usage: o-h voice asr <audio.wav>");
      const audio = readFileSync(file).toString("base64");
      const r = await callOnce("voice.asr", { audio }, port);
      console.log(r.text);
      return;
    }
    if (sub === "probe") {
      const r = await callOnce("voice.probe", undefined, port);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    throw new Error("unknown voice subcommand: " + sub + " (get|save|say|asr|probe)");
  }

  if (cmd === "monitor" || cmd === "mon") {
    const sub = rest[0] ?? "status";
    const vargs = rest.slice(1);
    if (sub === "status") {
      const r = await callOnce("monitor.status", undefined, port) as any;
      console.log("last check: " + (r.lastCheckAt ? new Date(r.lastCheckAt).toLocaleString() : "never"));
      for (const st of r.statuses) console.log((st.ok ? "UP  " : "DOWN") + " " + st.name.padEnd(24) + " " + st.kind.padEnd(7) + " " + st.url + "  (" + (st.latencyMs ?? "-") + "ms, fails=" + st.consecutiveFails + ")");
      if (!r.statuses.length) console.log("(no services defined - add with: monitor add --name X --kind http --url https://...)" );
      console.log("open alerts: " + r.openAlerts);
      return;
    }
    if (sub === "check") { const r = await callOnce("monitor.check", undefined, port) as any; console.log(JSON.stringify(r, null, 2)); return; }
    if (sub === "add") {
      const name = flag(vargs, "name") ?? "service"; const kind = flag(vargs, "kind") ?? "http"; const url = flag(vargs, "url") ?? vargs[0];
      if (!url) throw new Error("monitor add needs --url");
      const r = await callOnce("monitor.add", { name, kind, url }, port) as any;
      console.log(JSON.stringify(r, null, 2)); return;
    }
    if (sub === "remove") { const r = await callOnce("monitor.remove", { id: vargs[0] }, port) as any; console.log(JSON.stringify(r)); return; }
    if (sub === "enable") { const r = await callOnce("monitor.enable", { id: vargs[0], enabled: flag(vargs, "disable") ? false : true }, port) as any; console.log(JSON.stringify(r)); return; }
    if (sub === "alerts") { const r = await callOnce("alerts.list", undefined, port) as any; for (const a of r) console.log(new Date(a.at).toLocaleString() + " " + (a.state === "firing" ? "🔥" : "✅") + " " + a.name + " · " + a.detail + (a.acked ? " (acked)" : "")); return; }
    if (sub === "ack") { const r = await callOnce("alerts.ack", { id: vargs[0] }, port) as any; console.log(JSON.stringify(r)); return; }
    throw new Error("unknown monitor subcommand: " + sub + " (status|check|add|remove|enable|alerts|ack)");
  }

  if (cmd === "cache") {
    const sub = (rest[0] ?? "stats").toLowerCase();
    const vargs = rest.slice(1);
    if (sub === "stats") { const r = await callOnce("cache.stats", undefined, port) as any; const pct = Math.round(r.hitRate * 100); console.log("entries " + r.entries + " · hits " + r.hits + " · misses " + r.misses + " · hit rate " + pct + "% · ttl " + Math.round(r.ttlMs / 1000) + "s" + (r.lastHitAt ? " · last hit " + new Date(r.lastHitAt).toLocaleString() : "")); return; }
    if (sub === "clear") { const r = await callOnce("cache.clear", undefined, port) as any; console.log("cleared " + r.cleared + " entries"); return; }
    throw new Error("unknown cache subcommand: " + sub + " (stats|clear)");
  }
  if (cmd === "logs") {
    const sub = rest[0];
    if (sub === "tail" || sub === undefined) {
      const level = flag(rest, "level"); const moduleF = flag(rest, "module"); const qF = flag(rest, "q");
      const r = await callOnce("logs.tail", { limit: flag(rest, "limit") ? Number(flag(rest, "limit")) : 100, ...(level ? { level } : {}), ...(moduleF ? { module: moduleF } : {}), ...(qF ? { q: qF } : {}) }, port) as any;
      for (const e of [...r.entries].reverse()) console.log(new Date(e.ts).toISOString() + " " + e.level.toUpperCase().padEnd(5) + " " + e.module + "  " + e.msg + (e.meta ? " " + JSON.stringify(e.meta) : ""));
      console.log("(" + r.total + " matching, showing " + Math.min(r.entries.length, 100) + ")");
      return;
    }
    if (sub === "stats") { const r = await callOnce("logs.stats", undefined, port) as any; console.log(JSON.stringify(r, null, 2)); return; }
    if (sub === "audit") {
      const qF = flag(rest, "q"); const limF = flag(rest, "limit");
      const r = await callOnce("logs.audit", { ...(limF ? { limit: Number(limF) } : {}), ...(qF ? { q: qF } : {}) }, port) as any;
      for (const ev of r.events) console.log(new Date(ev.at).toISOString() + "  " + ev.event.padEnd(14) + (ev.actor ? " " + ev.actor : "") + (ev.ip ? " ip=" + ev.ip : "") + (ev.meta ? " " + JSON.stringify(ev.meta) : ""));
      return;
    }
    if (sub === "resolve") {
      const qF = rest.slice(1).filter((x: string) => !x.startsWith("--")).join(" ");
      const level = flag(rest, "level") ?? "warn";
      console.log("asking the model to analyze logs (level=" + level + ")...");

      const r = await callOnce("logs.resolve", { q: qF || undefined, level }, port) as any;
      console.log("\n" + r.analysis);
      return;
    }
    throw new Error("unknown logs subcommand: " + sub + " (tail|stats|resolve|audit)");
  }

  if (cmd === "backup") {
    const sub = rest[0];
    if (sub === "run") {
      const keep = flag(rest, "keep");
      const r = await callOnce("backup.run", keep ? { keep: Number(keep) } : {}, port);
      console.log(r.file + "  (" + r.files + " files, " + Math.round((r.bytes / 1024 / 1024) * 10) / 10 + " MB)");
    } else if (sub === "list") {
      const r = await callOnce("backup.list", {}, port);
      console.log("dir: " + r.dir);
      if (!r.backups.length) console.log("(no backups yet — they run automatically about 1h after start, then daily)");
      for (const b of r.backups) console.log(b.name.padEnd(40) + String(Math.round(b.bytes / 1024)).padStart(8) + " KB");
    } else if (sub === "restore") {
      const file = rest[1];
      if (!file) { console.log("usage: backup restore <zip-file> [--dry-run]"); return; }
      const r = await callOnce("backup.restore", { file, dryRun: rest.includes("--dry-run") }, port);
      console.log((r.dryRun ? "dry-run: would restore " : "restored ") + r.restored + " files. Restart the gateway to reload stores cleanly.");
    } else {
      console.log("subcommands: run | list | restore <zip> [--dry-run]");
    }
    return;
  }

  if (cmd === "instances") {
    const here = dataDirOf(undefined);
    const list = listInstances(here);
    const me = list.find((i) => i.pid === process.pid);
    console.log("data dir: " + here);
    if (!list.length) { console.log("no live instances registered (older gateway?)"); return; }
    for (const i of list) {
      console.log("pid " + String(i.pid).padEnd(7) + " port " + String(i.port).padEnd(6) + " mode " + i.mode + "  up " + Math.round((Date.now() - i.startedAt) / 60000) + "min  hb " + Math.round((Date.now() - i.heartbeatAt) / 1000) + "s ago" + (i.pid === process.pid ? "  <- you" : ""));
    }
    if (list.length > 1) console.log("WARNING: " + list.length + " gateway instances share this data dir — that is usually an accident (duplicate sessions/memory conflicts)");
    return;
  }

  if (cmd === "doctor") {
    const dataDir = flag(rest, "data-dir");
    const checks = await runDoctor({ dataDir: dataDir ?? undefined, deep: rest.includes("--deep") });
    const fails = checks.filter((c) => !c.ok);
    for (const c of checks) {
      console.log((c.ok ? "OK   " : "FAIL ") + c.name.padEnd(22) + c.detail + (c.hint ? "  -> " + c.hint : ""));
    }
    console.log(fails.length ? fails.length + " problem(s) found" : "all checks passed");
    if (fails.length) process.exitCode = 1;
    return;
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
    const sub = rest[0];
    if (sub === "search") {
      const q = rest.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!q) throw new Error("usage: o-h sessions search <text> [--kind chat]");
      const kind = flag(rest, "kind");
      const hits = await callOnce("sessions.search", { q, ...(kind ? { kind } : {}), limit: 50 }, port);
      for (const h of hits) {
        console.log(h.id + " | " + h.title + " | hits " + h.hits + " | " + new Date(h.matchTs).toISOString().slice(0, 16) + "\n    …" + h.snippet + (h.snippet.length >= 180 ? "…" : ""));
      }
      console.log((hits.length || 0) + " sessions matching \"" + q + "\"");
      return;
    }
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
    if (sub === "export") {
      const path = flag(args, "out") ?? (id + ".md");
      const r = await callOnce("sessions.export", { id }, port) as { markdown: string };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, r.markdown, "utf-8");
      console.log("wrote " + r.markdown.length + " chars -> " + path);
      return;
    }
    if (sub === "rename") {
      const title = withoutFlag(rest.slice(1), "id").join(" ") || flag(args, "title") || "";
      const o = await callOnce("sessions.rename", { id, title }, port) as { ok: boolean };
      console.log(o.ok ? "renamed " + id : "unknown session: " + id);
      return;
    }
    if (sub === "delete") {
      const o = await callOnce("sessions.delete", { id }, port) as { ok: boolean };
      console.log(o.ok ? "deleted " + id : "refused or unknown: " + id + (id === "main" ? " (main is protected)" : ""));
      return;
    }
    throw new Error("usage: o-h session show|create|append|rename|delete [--id <id>] [--title t] [--kind k] [text]");
  }

  throw new Error("unknown command: " + cmd + "\ncommands: gateway start | token | devices | exec | read | write | sessions | session | node connect [--device-id id]");
}
