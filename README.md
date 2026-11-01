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
```

## Concepts

- **Gateway (local mode)**: plugin host + device registry + WS API (`/api`) + node transport (`/node`), token-auth.
- **Device**: local (this machine, via plugin-local) or remote node (o-h node connect). Mobile companion planned.
- **Plugins**: loaded dynamically by package name or path (`--plugins ./my-plugin.ts,pkg-name`).
- **Protocol**: JSON-RPC-ish messages over WebSocket (see packages/protocol).

## Roadmap (vertical slices)

1. ✅ Slice 1: local gateway, plugin host, device registry, CLI, local device (exec/fs)
2. ✅ Slice 2: remote sessions — persistent shared session log, main session, node auto-reconnect (backoff, stable id)
3. ⬜ Slice 3: sessions / Minions (sub-agent sessions)
4. ⬜ Slice 4: mobile companion (pairing, capabilities, tool grants e.g. calendar)
5. ⬜ Slice 5: authorization/grants model per device
