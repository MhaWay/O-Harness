# O-Harness

Plugin-first local/remote device gateway, dsh-style: monorepo, dynamic plugins, WebSocket + JSON-RPC.

## Quickstart

```bash
pnpm install
node packages/cli/src/bin.ts gateway start   # local mode, ws://127.0.0.1:8710
node packages/cli/src/bin.ts devices         # registry
node packages/cli/src/bin.ts exec "uname -a"
# remote demo (second terminal):
node packages/cli/src/bin.ts node connect --name demo-node
node packages/cli/src/bin.ts devices
node packages/cli/src/bin.ts exec --device <node-id> "uname -a"
# sessions (shared, persistent across devices):
node packages/cli/src/bin.ts sessions
node packages/cli/src/bin.ts session append "note from the other side"
```

## Concepts

- **Gateway (local mode)**: plugin host + device registry + WS API (`/api`) + node transport (`/node`), token-auth.
- **Device**: local (this machine, via plugin-local) or remote node (`o-h node connect`). Mobile companion planned.
- **Direct channel**: a remote node also exposes a local WS server (`startDirectServer`). On `Hello` it advertises candidate addresses — LAN IPv4 + overlay IPs + `OH_ADDR_EXTRA` overrides. The gateway prefers the direct path (`transport: "direct"` in device meta), probing with a small timeout and a 15s fail-cache; if unreachable it transparently falls back to the gateway relay. Use `--no-direct` or `--direct-port N` (0 = ephemeral) to control.
- **Overlay networks (opt-in)**: `--overlay off|tailscale|zerotier` (default `off`). Tailscale and ZeroTier are *alternatives* — enable one and the node bootstraps it: if missing it installs on the fly (Linux/macOS/Windows), brings it up (`tailscale up`, or with `--overlay-auth-key`; `zerotier-cli join <net>` with `--overlay-net <netid>`) and advertises its IPs as direct candidates. Same "LAN when close, overlay when roaming" behavior.
- **Sessions**: persistent shared logs (`sessions/<id>.json`). All devices see the *same* session; `main` is auto-created. Append from anywhere, read from anywhere.
- **Plugins**: loaded dynamically by package name or path (`--plugins ./my-plugin.ts,pkg-name`).
- **Protocol**: JSON-RPC-ish messages over WebSocket (see packages/protocol).

## Roadmap (vertical slices)

1. ✅ Slice 1: local gateway, plugin host, device registry, CLI, local device (exec/fs)
2. ✅ Slice 2: remote sessions — persistent shared session log, main session, node auto-reconnect (backoff, stable id)
3. ✅ Slice 3: direct channel — LAN/Tailscale direct data-plane when reachable, gateway relay fallback, address candidates + probing
4. ⬜ Slice 4: sessions / Minions (sub-agent sessions)
5. ⬜ Slice 5: mobile companion (pairing, capabilities, tool grants e.g. calendar)
6. ⬜ Slice 6: authorization/grants model per device
