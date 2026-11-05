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
node packages/cli/src/bin.ts auth set-password '<strong pw>'  # master password (scrypt) + session cookies

node packages/cli/src/bin.ts auth sessions | revoke-session <key> | logout

node packages/cli/src/bin.ts auth token-login on|off       # raw bootstrap token usable interchangeably

node packages/cli/src/bin.ts auth oauth-set google --authorize-url ... --token-url ... --userinfo-url ... --client-id ... --client-secret ... --scopes openid --subs me@gmail.com

# TLS (self-signed, auto-renewed):
node packages/cli/src/bin.ts gateway start --tls auto   # https/wss on the same port
node packages/cli/src/bin.ts node connect --url wss://<host>:<port>/node --insecure   # wss node (self-signed)

# device-offered tools + approval:
node packages/cli/src/bin.ts tools list | tools call --device <id> --tool calendar.list
node packages/cli/src/bin.ts tools pending
node packages/cli/src/bin.ts tools respond <ask-id> --approve [--remember]
node packages/cli/src/bin.ts tools grants | tools revoke <deviceId> <tool>

# companion app (exposes mic/speaker/screenshot/notify):
node packages/cli/src/bin.ts companion connect --url ws://<host>:<port>/node --name living-room
```

GUI: open http://<host>:<port>/ (token from `o-h token`): dashboard, Chat (assistant, live token streaming), Scheduler, Memory, Minions + Pairing + Tools tabs, Models settings. Mobile companion: `/m`.


```
o-h schedule create "send a summary" --daily 09:00 --label morning   # chat job in session main
o-h schedule create --task "backup notes" --every 60                     # minion job every hour
o-h schedule create "one-off ping" --once 2026-12-01T08:00:00
o-h schedule list | run <id> | disable <id> | enable <id> | remove <id>
```
## Concepts

- **Gateway (local mode)**: plugin host + device registry + WS API (`/api`) + node transport (`/node`), token-auth.
- **Device**: local (this machine, via plugin-local), remote node (`o-h node connect`), or mobile companion (pairing code + device secret, scoped).
- **Minions**: sub-agent sessions that run a tool loop (`exec`, `read_file`, `write_file`, `memory_search`, `memory_add`) against the device registry and memory; concurrency-queued, killable, each one logs to its own session.
- **Memory**: ADD-only temporal store (Mem0/Letta-inspired): supersede chains, validity windows, BM25 + recency + importance + phrase scoring; query in the past returns what was believed then.
- **Pairing & scopes**: 6-digit one-time codes redeem into device secrets with `read|write|admin` scopes; every RPC is scope-checked for device-originated sockets; revocation takes effect immediately.
- **Device tools & grants**: the phone companion (`/m`) offers `device.info`, `calendar.list`, `calendar.create`, `notes.list`, `notes.create`, `notes.search` on connect. Invocations are brokered: standing grant -> direct invoke, else a live ask (GUI Tools tab, `o-h tools respond`, or the in-page banner on /m; owner-or-admin only). Approve & always creates a standing grant, revocable from GUI or CLI.
- **Direct channel**: a remote node also exposes a local WS server (`startDirectServer`). On `Hello` it advertises candidate addresses — LAN IPv4 + overlay IPs + `OH_ADDR_EXTRA` overrides. The gateway prefers the direct path (`transport: "direct"` in device meta), probing with a small timeout and a 15s fail-cache; if unreachable it transparently falls back to the gateway relay. Use `--no-direct` or `--direct-port N` (0 = ephemeral) to control.
- **Overlay networks (opt-in)**: `--overlay off|tailscale|zerotier` (default `off`). Tailscale and ZeroTier are *alternatives* — enable one and the node bootstraps it: if missing it installs on the fly (Linux/macOS/Windows), brings it up (`tailscale up`, or with `--overlay-auth-key`; `zerotier-cli join <net>` with `--overlay-net <netid>`) and advertises its IPs as direct candidates. Same "LAN when close, overlay when roaming" behavior.
- **Sessions**: persistent shared logs (`sessions/<id>.json`). All devices see the *same* session; `main` is auto-created. Append from anywhere, read from anywhere.
- **Plugins**: loaded dynamically by package name or path (`--plugins ./my-plugin.ts,pkg-name`).
- **Protocol**: JSON-RPC-ish messages over WebSocket (see packages/protocol).
- **TLS**: '--tls auto' serves https/wss with a self-signed cert auto-generated in <dataDir>/tls (825 days, renewed when <14d remain); pairing secrets are stored only as sha256 hashes, auth uses constant-time compare, /pair is rate-limited per IP (20 per 5 min).
- **Login & sessions**: a master password (scrypt, N=16384) enables browser login (`POST /login`, HttpOnly `ohs` cookie, 30-day sessions, per-session revoke); OAuth providers (Google/GitHub/...) can be configured and their verified `sub` allow-listed per provider so devices on other accounts link together; `tokenEnabled` config flag makes the raw bootstrap token usable or not — the two paths are interchangeable. Session/cookie auth is admin-grade like the token.

## New UI (static assets)

The gateway serves a chat-first web app at / from packages/gateway/src/ui/
(index.html, style.css, client.js, app.js - plain JS, no build step).
Chat is home; the sidebar carries sessions, minions, scheduler, memory, tools,
devices and settings, plus a Ctrl+K command palette. A hamburger opens the
sidebar on narrow viewports. Long chat histories load paginated (newest 60,
"Load earlier messages" to scroll back) — the DOM stays small even for
sessions with thousands of entries. Legacy tab-style UI is still at /legacy.

## Roadmap (vertical slices)

1. ✅ Slice 1: local gateway, plugin host, device registry, CLI, local device (exec/fs)
2. ✅ Slice 2: remote sessions — persistent shared session log, main session, node auto-reconnect (backoff, stable id)
3. ✅ Slice 3: direct channel — LAN/Tailscale direct data-plane when reachable, gateway relay fallback, address candidates + probing
4. ✅ Slice 4: web GUI (dashboard + sessions/devices/settings) and Models settings — providers, custom-add with api-fetch model dropdown, extra JSON, default model with thinking effort `none|low|medium|xhigh`, `models.test`, `self.update`
5. ✅ Slice 4-M: Minions — persistent agent runtime with tool loop (`exec`/`read_file`/`write_file`/`memory_search`/`memory_add`), concurrency queue, session-per-minion, kill, CLI + GUI dispatch tab
6. ✅ Slice 5: temporal memory layer — Mem0-style ADD-only, supersede chains, validity windows (query in the past), BM25 + recency + importance + phrase signals, RPC + CLI
7. ✅ Slice 6: pairing + authorization — 6-digit one-time codes redeem into device secrets with scopes (`read|write|admin`), per-method scope policy, revocation, `o-h pair create|list|revoke|redeem`
8. ✅ Slice 6-M: mobile companion page (`/m`) — pair with code, sessions, append messages, memory search/add, dispatch + watch minions; scoped access via device secret
9. ✅ Slice 5-C: memory consolidation - model-driven clustering (Jaccard tokens) + merge/contradict resolution, supersede chains; o-h memory consolidate [--dry-run]
10. ✅ Slice 7: mobile tool grants - devices *offer* tools (e.g. calendar); every call is brokered: standing grants (approve & always) or live per-call approval (ask -> approve/deny, owner-or-admin only); minions invoke offered tools as <deviceId>:<tool>, auto-prompting the device owner
11. ✅ Slice 9: chat interface - `o-h say` / `chat history`, GUI Chat tab, assistant loop with memory-context injection
12. ✅ Slice 10: authz hardening + TLS - CSPRNG codes, hashed secrets, rate-limited pairing, self-signed https/wss auto mode
13. ✅ More device tools - mobile companion offers 6 tools (calendar.list/create, notes.list/create/search, device.info) brokered with per-call approval + standing grants
14. ✅ Scheduler - time-triggered chat messages or minion runs (every N min / daily HH:mm / once ISO), persistent across restarts, enable/disable/runNow; o-h schedule ...
15. ✅ Context management (chat) — bounded verbatim tail + rolling model-summarized history (Letta/dsh-style), memory recall injected every turn; `o-h say` keeps long conversations cheap
17. ✅: new hybrid UI - chat-first shell, static assets, command palette, responsive hamburger, legacy tab UI at /legacy
19. ✅ Error tracking & logs: structured LogStore (ring + daily JSONL), logs.tail/stats/resolve RPC+CLI, GUI Logs view with model-assisted analysis
20. ✅ Voice: local ASR/TTS adapter (LFM3), mic dictation + speak/reply buttons in chat, listen buttons on history, Settings > Voice card with probe (`o-h voice ...`)
21. ✅ Monitoring & alerts: service probes (models/http/ws) + fired/resolved alerts with ack, Overview panel (services table + open alerts + Re-check now), `o-h monitor ...`
22. ✅ CI/CD: GitHub Actions (pnpm + Node 24, `pnpm test` on push/PR to main)18. ✅ Slice 14: login & sessions - master password (scrypt) with HttpOnly session cookies, OAuth providers with sub allow-lists (device linking across accounts), `tokenEnabled` flag (token/password interchangeable), session revoke + logout, rate-limited login, CLI `o-h auth ...`, GUI gate password row + Settings Access panel
23. ✅ Caching: in-process model response cache (deterministic auxiliary calls: consolidation, log analysis) keyed by model+messages, stats/clear RPC+CLI+Settings panel
24. ✅ Testing: unit suites for auth (scrypt+sessions+cookies), voice config, tool broker (offer/grants/ask/approve/deny/timeout), settings store — 31 tests, all offline
25. ✅ Security pass: CSP + nosniff + frame/deny headers on every response, 1 MiB request-body limit (→ 413), maxPayload caps on all websockets; inline-script hash policy noted as follow-up

### Logs (error tracking + model-assisted resolution)
26. ✅ Storage & atomicity: all JSON stores persist via atomic write-tmp+fsync+rename (no torn files on crash); config, sessions, memory, pairing, grants, settings, auth, voice, scheduler, monitor, minions
27. ✅ Instance registry (scaling/gestione istanze): heartbeated instance files under data dir, duplicate-gateway detection, `o-h instances`, health reports `others`
28. ✅ Companion apps: `o-h companion connect` runs a device that exposes OS tools (16kHz mic capture, speaker playback, screenshot, notifications) to the broker — per-call approval with standing grants, environment errors propagate to the caller. Lets non-secure (plain-IP) installs reach mic/screen/audio that browsers block.
29. ✅ Mobile /m redesign — chat-first page reusing the new UI assets (pairing, chat+voice, minions, memory, tool approvals, device tools)
30. ✅ Backups: automatic daily ZIP snapshots of the data dir (atomic, prune-to-keep), manual run/list/restore via RPC+CLI+Settings card
31. ✅ Doctor self-check: `o-h doctor` runs a full one-shot self-check (config, live gateway, instance duplicates, disk space, every model provider, voice services, TLS material, backup freshness, runtime) and prints pass/fail with fix hints; same via `doctor.run` RPC, and a "Run doctor" button in the GUI Overview
32. ✅ Alert notifications: fired/resolved events toast in the GUI and land as entries in a dedicated `alerts` session (durable, restart-safe, browsable like chat history)
33. ✅ Resolver sessions: `o-h logs resolve` keeps its own session (`logs-resolver`) — every analysis is appended as an entry and previous rounds are replayed into the next prompt, so investigations stay continuous across calls
34. ✅ Streaming thinking + tool badges: reasoning tokens stream live into a collapsible *Thinking* panel inside the reply bubble (dsh-style, collapsed when done), and each tool call appears as a live ⚙ badge as it executes. Chat history persists the reasoning so it survives reloads
34. ✅ Static asset caching: UI files served with weak ETags + gzip (304 revalidation, `no-cache`) — repeat loads are byte-free and payloads ~4x smaller
35. ✅ Security hardening: `Permissions-Policy` locks every capability except the mic (camera/display-capture/geolocation/clipboard denied — needed for browser dictation); strict HSTS header on TLS responses; header contract + ETag/gzip revalidation locked by tests (47/47)
36. ✅ Chat pagination: `chat.history` returns windowed pages (`limit` + `since`); the GUI renders the newest 60 bubbles and lazily prepends older pages via a "Load earlier messages" button — long sessions no longer build a huge DOM (no browser lag).
37. ✅ Agent-loop transparency: every tool call (exec commands, file edits, attempted/failed calls) streams live into a collapsible “Ran N steps” panel inside the assistant bubble with argument previews, and the loop now runs up to 30 turns; at the limit the model is asked for a “what is done / what remains” wrap-up instead of stopping cold. Persisted with the chat entry (`data.steps`).
38. ✅ Agent-loop autonomy: the chat loop no longer has a turn limit — the model decides when it is done. A dsh-style `<system-reminder>` is re-injected every turn keeping it focused on finishing, guarded only by a 30-minute wall-clock deadline and a death-loop detector (the same call 4x). If a guard trips, the model writes a “done vs remaining” wrap-up instead of stopping cold.
39. ✅ Realtime voice view (Jarvis mode): new GUI tab with a persistent mic<->LFM3 realtime relay through the gateway (`/voice` ws), server-side VAD, live transcripts of both speakers, a mic mute that keeps the session alive, and “send transcript to chat”. Messages queued until the upstream opens.
40. Next: npm publish (deferred by user)
Every RPC error, login failure and minion failure is logged as a structured entry (ring buffer +
daily JSONL under `~/.o-harness/logs/`). `o-h logs tail|stats` browse them;
`o-h logs resolve` streams a digest to your default model, which analyzes root causes read-only. Analyses accumulate in a dedicated `logs-resolver` session, so follow-up resolutions inherit the context of previous rounds.
The GUI Logs view has search, level filter, 24h stats and an “Ask model to analyze” button.

### Caching
Expensive, deterministic model calls (memory consolidation, log analysis) are cached in-process,
keyed by model + prompt hash, with a 15-minute TTL and LRU eviction (100 entries). Chat and minion
turns are never served from cache. `o-h cache stats` shows hits/misses; `o-h cache clear` drops it;
Settings > Model cache shows the same with a clear button.
### Monitoring & alerts
O-Harness probes every configured service (model providers are auto-registered, plus any you add):
`models` endpoints check `/v1/models`, `http` any GET, `ws` a handshake. A failed check fires an
alert immediately (deduplicated while open); the first success after down marks it resolved.
The Overview shows live status and open alerts (ack button + Re-check now).

```bash
o-h monitor status                       # services UP/DOWN + open alerts
o-h monitor check                        # run all probes now
o-h monitor add --name gpu-box --kind ws --url ws://10.0.0.5:8710/node
o-h monitor alerts                       # history
o-h monitor ack <alert-id>               # acknowledge
```
Alerts double as notifications: `alert.fired` / `alert.resolved` broadcast as events (browser
shows an error toast) and are appended as entries to a dedicated `alerts` session, so the whole
service up/down history survives restarts and is browsable in the chat history list.

### Voice (dictation + text-to-speech)
O-Harness integrates local speech models through an HTTP adapter (LFM3 batch API exposed on port 8023:
`POST /tts_to_audio {text}` -> 24kHz PCM16 WAV, `POST /asr {audio_b64|audio_path, language}` -> text).

```bash
o-h voice probe                            # check batch + realtime endpoints
o-h voice say "ciao mondo" --out out.wav   # synthesize to wav
o-h voice asr rec.wav                      # transcribe
o-h voice save --tts-url http://127.0.0.1:8023 --rt-url ws://127.0.0.1:8024/ --auto-speak on
```

In the web UI: the mic button in the composer dictates (mic -> 16kHz PCM -> ASR -> text in the box),
the speaker button toggles auto-speak of replies, and each assistant reply carries a `listen` button.
`GET /api/voice/tts?text=...` serves WAV for clients (token auth). Settings > Voice edits
asr/tts/realtime URLs, language, voice and auto-speak, with a live service probe.

### Companion apps
Browsers refuse microphone and screen access on plain-IP (non-secure) origins. The companion solves that: run it once on
the machine that owns the hardware and the gateway can use that hardware for you, with per-tool approval.

```bash
node packages/cli/src/bin.ts companion connect --url ws://<gateway-host>:18711/node --name desktop
```

It connects exactly like `o-h node connect` (token, overlay/direct, TLS, reconnect) and additionally offers
four OS tools: `audio.listen` (sox/afrecord, 16 kHz mono — the shape the ASR backend wants), `audio.speak`
(speaks a WAV), `screenshot` and `notify`. The first invocation of each tool fires an approval ask on the
Tools tab (or `o-h tools respond <id> --approve --remember`); choosing *remember* creates a standing grant
so subsequent calls run silently, revocable with `o-h tools revoke <device> <tool>`.
Minions can also call device tools (`<deviceId>:<tool>` in the tool list), same broker and grants.

### Mobile (/m)
The mobile companion is a single-page app at `/m` built from the same static-asset layer as the desktop UI
(`packages/gateway/src/ui/mobile.html` + `mobile.js`, sharing `style.css` and the persistent-websocket client).
Pair with a 6-digit code (`o-h pair create`, or the Devices page — codes expire in 10 minutes by default);
the secret is stored in the device browser's localStorage and survives reconnects. The page gives the phone:
chat with the assistant (voice dictation via the mic button, replies spoken when voice replies are enabled),
minion dispatch + live status, memory search, an approvals tray for tool-use prompts raised against the
phone's own tools, and an unpair button. The phone's offered tools (device.info, notes.*, calendar.*) execute
locally in the browser — phone data never leaves the device without approval.

### Doctor (self-check)
One command validates the whole install: `o-h doctor [--deep]`. It checks the config file, that a
gateway actually answers `/health` (probing live instance ports, not just the config port), that no
duplicate gateway shares the data dir, disk space, every configured model provider (endpoint + model
listing; `--deep` does a real round-trip against the default model), the voice batch server, TLS
material, and that backups are fresh (< 30 h). Failures print a concrete hint. The gateway exposes
the same as `doctor.run` and the Overview tab has a "Run doctor" button.

### Backups
The gateway snapshots its whole data dir (sessions, memory, settings, auth, pairing, grants, voice,
scheduler, monitor, logs, tls material) into a dependency-free ZIP under `dataDir/backups/`, first about
1h after boot and then daily. The newest `keep` archives survive; the archive format is plain ZIP, so any
tool can open it — no O-Harness needed to read a backup.

```bash
o-h backup run                       # snapshot now
o-h backup list                      # archives + sizes
o-h backup restore <zip> [--dry-run] # files land immediately; restart to reload stores
```

The `backup` block in `config.json` tunes `enabled`, `everyHours` and `keep`; `logsKeepDays` prunes old
log JSONL. Restore refuses to run while more than one gateway instance shares the data dir.

### Instance registry (scaling / gestione istanze)
Every running gateway registers itself (`dataDir/instances/<pid>.json`) and refreshes a heartbeat every 15s.
Any instance — or the CLI without a live connection — can therefore discover sibling instances that
share the same data dir. Two gateways on one data dir double the scheduler, split session writes and
split event buses, so a second instance warns loudly at startup and `o-h instances` shows them all:

```bash
o-h instances                             # live instances + duplicate warning
curl http://host:port/health              # { ok, pid, others: <sibling count> }
```

Stale entries (dead pid or heartbeat older than 90s) are pruned on read. Scaling up intentionally means
separate data dirs per instance (isolated state), possibly behind a reverse proxy; the registry makes
accidental sharing visible instead of silently corrupting shared stores.

## Production (on the machine)
O-Harness runs as a docker service on the host (the `o-harness` container, `--restart=unless-stopped`, host network),
serving the GUI at `http://<machine-ip>:18711/` and the mobile page `/m`. Data lives in the host's `/root/.o-harness`.
The app tree is `/opt/o-harness` (extracted WITHOUT dereferencing, workspace symlinks are load-bearing).

```sh
# deploy loop (run from the dev container):
tar -cf /tmp/oh-repo.tar -C /root/Projects/O-Harness --exclude=.git .   # raw tar, NO -h
docker cp /tmp/oh-repo.tar gx10-8e13:/tmp/   # or docker run ... < tar pipe
ssh/docker chroot /host /opt/oh-redeploy.sh   # re-extract + restart + /health check
```

Redeploy script `/opt/oh-redeploy.sh` (on host): stops the container, re-extracts `/tmp/oh-repo.tar`
into `/opt/o-harness`, restarts `alpine` + `chroot /host env HOME=/root node --experimental-strip-types
--no-warnings /opt/o-harness/packages/gateway/src/bin.ts --host 0.0.0.0 --port 18711`, verifies `/health`.
The `o-harness` container itself is the persistence layer across host reboots (docker is enabled
in systemd and its containers restart). For the gateway restart (not redeploys), restart is also
safe because every runtime state is on disk in `/root/.o-harness`.

## Tests

pnpm install && pnpm test   # node test runner over strip-types: core unit tests + gateway integration (in-process ws server on an ephemeral port, no model calls).