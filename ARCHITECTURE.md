# O-Harness Architecture

A personal agent gateway that runs on your own hardware: one long-lived gateway process,
one or more devices (nodes) connected over WebSocket (LAN, Tailscale/ZeroTier overlay, or
TLS wss), and a plugin-first core. Everything below is local-first — no cloud dependency.

## Layout

- packages/core — no-I/O building blocks: sessions store, temporal memory store, pairing
  store + scope map, grants store, RPC router, protocol types.
- packages/protocol — wire messages (rpc:req/res, events, hello) and the Methods enum.
- packages/gateway — the server: registry, transports, and all runtimes (see below).
- packages/cli — single binary (o-h) + node subcommand; talks to any gateway via ws api.

## Gateway internals

- rpc router (core) — method -> handler, ctx {deviceId?, admin?}; every call passes
  checkScope (SCOPE_FOR_METHOD) so paired devices are limited to their scopes.
- transports — clients (GUI/CLI/mobile) on /api with ?token= or ?secret=; nodes on /node.
- direct channel (slice 3) — nodes advertise LAN + overlay addresses; gateway probes them
  and prefers the direct WebSocket for device calls (meta.transport = direct|gateway).
- overlay bootstrap (slice 3b/c) — auto: if the peer URL is not loopback, ensure tailscale
  installed/up before connecting (off|tailscale|zerotier, --overlay / config).
- sessions (core) — append-only session logs persisted as JSON; sessions.changed events.
- memory (slice 5) — Mem0-style ADD-only store with supersede chains + validity windows.
  Queries in the past return then-valid facts; BM25 + recency + importance + phrase signals.
  consolidation.ts clusters by Jaccard tokens and merges/contradicts via the model (5-C).
- settings (slice 4) — providers, default model + thinking effort (none|low|medium|xhigh),
  extra JSON per provider; models.test, self.update (git pull + restart notes).
- agents (slice 4-M, 8) — minion runtime: queue (concurrency 2), per-minion session, tool
  loop (exec/fs/memory), persistence + restart recovery, dependsOn chains, kill.
- scheduler (slice 11) — every N min / daily HH:mm / once -> chat message into a session
  or a minion spawn; persisted; enable/disable/runNow; 30s tick.
- chat (slice 9, 12, 13) — assistant loop: memory recall + rolling summary (folds old turns
  into a model-written summary, keeps last 12 verbatim), tools = exec/fs/memory + device
  tools via the broker; tool steps recorded in session entries.
- toolbroker (slice 7) — devices *offer* tools (e.g. phone calendar/notes). Minions and
  chat call "<deviceId>:<tool>"; a standing grant auto-runs, otherwise the owner gets an
  approval prompt (tools.pending -> tools.respond approve/deny/remember).
- pairing (slice 6, 10) — 6-digit CSPRNG one-time codes -> device secret (sha256 at rest),
  scopes read|write|admin, revocation kills access, per-IP rate limit, TLS auto mode.

## Data plane

Device RPC = {method, params} over the node's socket (exec, fs.read/write, tool.invoke).
Device-initiated requests (e.g. the mobile page answering tool asks) are routed the same
way. Everything persists under ~/.o-harness/ (sessions/, memory/, pairing/, grants/,
minions/, schedules/, tls/).

## Events

WS clients receive broadcast events: sessions.changed, agents.changed, memory.added,
tools.ask, chat.message, chat.summary, device.tools, pairing.created... The GUI listens
and refreshes the affected tab.
