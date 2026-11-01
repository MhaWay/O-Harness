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
# minions (sub-agent sessions with tool loop, memory-aware):
node packages/cli/src/bin.ts minions spawn "count the .ts files in the repo"
node packages/cli/src/bin.ts minions list
node packages/cli/src/bin.ts minions spawn "write the deploy report" --depends-on <minionId>   # waits until that minion finishes
> Minions persist across restarts (~/.o-harness/minions/minions.json): running ones are marked interrupted, pending chains resume, dependsOn orders pipelines.

# memory (temporal, ADD-only, queryable at any past instant):
node packages/cli/src/bin.ts memory search "user prefers"
node packages/cli/src/bin.ts memory add "user prefers dark GUI themes" --subject user
# chat (assistant loop over sessions + memory):
node packages/cli/src/bin.ts say 'what is the hostname?'
node packages/cli/src/bin.ts chat history --session main
# pairing a phone:
node packages/cli/src/bin.ts pair create --kind mobile   # 6-digit code -> open http://<host>:<port>/m and enter it
node packages/cli/src/bin.ts pair list | pair revoke <deviceId>
# device-offered tools + approval:
node packages/cli/src/bin.ts tools list | tools call --device <id> --tool calendar.list
node packages/cli/src/bin.ts tools pending
node packages/cli/src/bin.ts tools respond <ask-id> --approve [--remember]
node packages/cli/src/bin.ts tools grants | tools revoke <deviceId> <tool>
```

GUI: open http://<host>:<port>/ (token from `o-h token`): dashboard, Chat (assistant), Minions + Pairing tabs, Models settings. Mobile companion: `/m`.

## Concepts

- **Gateway (local mode)**: plugin host + device registry + WS API (`/api`) + node transport (`/node`), token-auth.
- **Device**: local (this machine, via plugin-local), remote node (`o-h node connect`), or mobile companion (pairing code + device secret, scoped).
- **Minions**: sub-agent sessions that run a tool loop (`exec`, `read_file`, `write_file`, `memory_search`, `memory_add`) against the device registry and memory; concurrency-queued, killable, each one logs to its own session.
- **Memory**: ADD-only temporal store (Mem0/Letta-inspired): supersede chains, validity windows, BM25 + recency + importance + phrase scoring; query in the past returns what was believed then.
- **Pairing & scopes**: 6-digit one-time codes redeem into device secrets with `read|write|admin` scopes; every RPC is scope-checked for device-originated sockets; revocation takes effect immediately.
- **Device tools & grants**: a device (typically the phone companion /m - offers calendar.list/calendar.create) *offers* tools on connect. Invocations are brokered: standing grant -> direct invoke, else a live ask (GUI Tools tab or o-h tools respond; owner-or-admin only). Approve & always creates a standing grant, revocable from GUI or CLI.
- **Direct channel**: a remote node also exposes a local WS server (`startDirectServer`). On `Hello` it advertises candidate addresses — LAN IPv4 + overlay IPs + `OH_ADDR_EXTRA` overrides. The gateway prefers the direct path (`transport: "direct"` in device meta), probing with a small timeout and a 15s fail-cache; if unreachable it transparently falls back to the gateway relay. Use `--no-direct` or `--direct-port N` (0 = ephemeral) to control.
- **Overlay networks (opt-in)**: `--overlay off|tailscale|zerotier` (default `off`). Tailscale and ZeroTier are *alternatives* — enable one and the node bootstraps it: if missing it installs on the fly (Linux/macOS/Windows), brings it up (`tailscale up`, or with `--overlay-auth-key`; `zerotier-cli join <net>` with `--overlay-net <netid>`) and advertises its IPs as direct candidates. Same "LAN when close, overlay when roaming" behavior.
- **Sessions**: persistent shared logs (`sessions/<id>.json`). All devices see the *same* session; `main` is auto-created. Append from anywhere, read from anywhere.
- **Plugins**: loaded dynamically by package name or path (`--plugins ./my-plugin.ts,pkg-name`).
- **Protocol**: JSON-RPC-ish messages over WebSocket (see packages/protocol).

## Roadmap (vertical slices)

1. ✅ Slice 1: local gateway, plugin host, device registry, CLI, local device (exec/fs)
2. ✅ Slice 2: remote sessions — persistent shared session log, main session, node auto-reconnect (backoff, stable id)
3. ✅ Slice 3: direct channel — LAN/Tailscale direct data-plane when reachable, gateway relay fallback, address candidates + probing
4. ✅ Slice 4: web GUI (dashboard + sessions/devices/settings) and Models settings — providers, custom-add with api-fetch model dropdown, extra JSON, default model with thinking effort `none|low|medium|xhigh`, `models.test`, `self.update`
5. ✅ Slice 4-M: Minions — persistent agent runtime with tool loop (`exec`/`read_file`/`write_file`/`memory_search`/`memory_add`), concurrency queue, session-per-minion, kill, CLI + GUI dispatch tab
6. ✅ Slice 5: temporal memory layer — Mem0-style ADD-only, supersede chains, validity windows (query in the past), BM25 + recency + importance + phrase signals, RPC + CLI
7. ✅ Slice 6: pairing + authorization — 6-digit one-time codes redeem into device secrets with scopes (`read|write|admin`), per-method scope policy, revocation, `o-h pair create|list|revoke|redeem`
8. ✅ Slice 6-M: mobile companion page (`/m`) — pair with code, sessions, append messages, memory search/add, dispatch + watch minions; scoped access via device secret
9. Slice 5-C: memory consolidation - model-driven clustering (Jaccard tokens) + merge/contradict resolution, supersede chains; o-h memory consolidate [--dry-run]
10. Slice 7: mobile tool grants - devices *offer* tools (e.g. calendar); every call is brokered: standing grants (approve & always) or live per-call approval (ask -> approve/deny, owner-or-admin only); minions invoke offered tools as <deviceId>:<tool>, auto-prompting the device owner
11. Next: npm publish, authz hardening (pairing over TLS), more device tools
