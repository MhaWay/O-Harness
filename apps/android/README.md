# O-Harness Android Companion

Native node for O-Harness gateways. Registers as a `kind: mobile` device over
`wss://.../node` (same `hello` wire protocol as `o-h node connect`) and offers the
Android APIs a browser PWA cannot get on plain-IP/VPN deployments:

- `notify` — real system notifications (the gateway can push; trusted devices skip prompts)
- `calendar.list` / `calendar.create` — device calendar via `CalendarContract`
- `location.get` / `location.watch` — last-known GPS/network position
- `battery.get`, `device.info` — model, android level, saver mode
- `record.audio` — mic recording returned as base64 (for the voice stack)

The app does not expose `exec`/`fs.*` — the node dispatch refuses them.
Config is stored on first run: gateway URL + token (long token from web UI
Settings, or a 6-digit pairing code from `o-h pair create`), persistent `deviceId`
from the `welcome` message. A foreground service keeps the session connected.

## Build

Requires JDK 17+, Android SDK 35 + build-tools (set `sdk.dir` in
`local.properties`). From `apps/android`:

```bash
gradle --no-daemon assembleDebug   # -> app/build/outputs/apk/debug/app-debug.apk
gradle --no-daemon assembleRelease  # debug-signed until we add a release key
```

minSdk 26 (Android 8); `targetSdk 34` (notifications need the runtime permission,
the app requests it; battery optimization should be set to Unrestricted).

## Roadmap (not yet)

- MediaProjection screenshots (requires interactive consent)
- Boot-time autostart (`RECEIVE_BOOT_COMPLETED` — Android blocks silent background start otherwise)
- Push relay for offline wake (FCM/web-push via a relay service)
- audio.listen/speak bridge over LFM3 realtime (the gateway already streams PCM)