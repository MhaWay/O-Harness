# O-Harness System Design

This document is the design contract: goals, principles, subsystem map and the rationale
behind every major decision. ARCHITECTURE.md describes *where things live*; this describes
*why they are shaped this way* and what the next work is built against.

## 1. Goals

1. A personal, self-hosted agent gateway that runs on the user's own hardware.
2. Long-lived: sessions, memory, schedules and minions survive restarts.
3. Multi-device: phones, laptops, servers all join through one gateway; tools living on any
   device are callable with explicit, revocable authorization.
4. Model-agnostic: any OpenAI-compatible endpoint (or local vLLM) can be hot-configured; the
   gateway itself must be able to update when the change is clearly valid.
5. Plugin-first: capabilities arrive as plugins, not core edits (dsh-inspired).

## 2. Principles

- Local-first, no cloud dependency in the core. External calls (model APIs, OAuth, overlay
  installers) are always opt-in and visible in the GUI.
- Vertical slices: every feature ships with backend + RPC + CLI + GUI + test. No "phase 2 UI".
- Append-only, auditable data. Sessions and memory are logs, not tables that mutate.
- Explicit authority. Everything a device or model may do maps to a named scope; nothing is
  implicit. Human always on top: one master identity (password/OAuth) with token as bootstrap.
- Fail visibly: every error lands in the structured log; the model can be asked to fix the
  gateway's own errors through a dedicated session.

## 3. Architecture (target, not aspiration)

A single long-lived gateway process owns state and routing. Three planes:

- Control plane — WebSocket RPC (ws /api, /node) with typed methods, scoped auth, events.
- Data plane — device-local exec/fs/tool.invoke, direct-channel probing (LAN/overlay).
- Presentation plane — browser GUI (static assets, same-origin, token/cookie auth), mobile
  page /m, CLI, voice in/out.

State lives entirely under ~/.o-harness/ (JSON stores + append-only logs + tls material).
No external database by default: the workload is single-user, low-write, and portability +
crash-safety matter more than query power (see storage.md). A future SQLite option is scoped
behind the same store interface.

## 4. Subsystem map

| Subsystem | Owner | Status |
|---|---|---|
| sessions, memory, pairing, grants, rpc router | core | shipped |
| transports (ws, direct, overlay, tls), registry | gateway | shipped |
| chat loop, minions, scheduler, toolbroker, voice, consolidation | gateway runtimes | shipped |
| auth (password/OAuth/sessions), tokenEnabled flag | gateway | shipped |
| structured logging + error-resolver session | logs | this roadmap |
| metrics, monitors, alerts, dashboard | monitoring | this roadmap |
| model response cache | cache | this roadmap |
| CI (test on push) | .github | this roadmap |
| backup/retention, storage report | storage | this roadmap |
| multi-instance (nodes + gateways) registry | instances | this roadmap |
| scaling knobs (queue, concurrency, budgets) | config | this roadmap |

## 5. Key decisions and rationale

1. JSON stores, atomic writes (tmp + rename), append-only memory chains. Rationale: zero
   deps, human-inspectable, good enough for single-user write rates; supersede chains give
   bi-temporal queries that a plain KV would lose.
2. WebSocket-first instead of REST-first. Rationale: every feature needs server->client
   events (agents.changed, tools.ask, chat.stream, memory.added); REST would add polling on
   top. The few GETs that exist (/health, /assets, /api/voice/tts) are stateless conveniences.
3. Token as bootstrap, password/OAuth as primary identities. Rationale: token pairs the CLI
   and LAN tools in seconds, while browsers want cookies and phones want OAuth linking.
   Both paths resolve to the same AuthCtx, so the RPC router stays identity-agnostic.
4. Model = config, not code. Providers are rows with baseUrl/models/effort; chat and minions
   resolve the default at call time, so switching model or endpoint never needs a restart.
5. One authorization map (SCOPE_FOR_METHOD) + per-device grants. Rationale: two layers means
   a stolen secret still can't do admin, and a phone's calendar stays private unless the user
   says "remember".
6. Direct channel + overlay bootstrap. Rationale: on LAN we want latency; when the user moves
   to mobile the same connection survives by upgrading to the overlay (tailscale) instead of
   breaking.
7. Logs go to ring buffer + file, and the model can read them through a dedicated
   log-resolver session. Self-fixing is a first-class slice, not an afterthought: the same
   agent loop with a log-reading tool, a clear "explain and patch" prompt, and a human
   approve gate before any gateway change.
8. Cache in-process, keyed by (model, messages-hash), with per-provider TTL. Rationale: chat
   and minion loops re-send long prefixes constantly; a small exact-match cache is the
   cheapest latency and GPU saver for a single-node deployment.

## 6. Roadmap alignment (user's outline -> slices)

- system design / architecture -> this file + ARCHITECTURE.md (maintained)
- frontend -> hybrid UI (shipped) + dashboard/logs (monitoring slices)
- APIs & backend -> RPC surface (shipped) + per-method docs in api.md
- database & storage -> store specs + backup/retention (storage slice)
- auth & permissions -> shipped, hardened with permission matrix UI
- instance management -> node + gateway instance registry
- CI/CD & version control -> GitHub Actions test pipeline
- security -> TLS auto, CSPRNG codes, rate limits, CSP headers (security pass)
- caching & CDN -> model response cache + static asset caching headers
- error tracking & logs -> logs module + resolver session
- monitoring & alerts -> metrics, alerts, dashboard view
- testing -> unit + integration + GUI e2e checklist
- scaling -> concurrency/queue/budget knobs, docs
