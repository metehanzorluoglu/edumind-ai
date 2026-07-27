# Reaching the backend from a physical device

By default `uvicorn` binds to `127.0.0.1` (localhost), which is only
reachable from the same machine. A phone running Expo Go (or a dev build)
on the same Wi-Fi network needs the backend bound to your machine's actual
LAN address instead.

## 1. Find your Mac's LAN IP address

```bash
ipconfig getifaddr en0
```

This prints something like `192.168.1.20`. If you're on Wi-Fi via a
different interface (rare), try `en1` instead. Ethernet-connected Macs may
need a different interface name — check `ifconfig` if `en0` prints nothing.

## 2. Start the backend bound to all interfaces

From `rag-backend/`:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` makes uvicorn listen on every network interface on the
machine, including the LAN one — not just localhost. This is a normal,
common way to run a local dev server; it does **not** require disabling
your Mac's firewall and does **not** require any router port-forwarding
configuration, since the phone and the dev machine are already on the same
local network and can already reach each other directly. Do not disable
the macOS firewall or configure port forwarding to make this work — if
`0.0.0.0` binding plus the steps below aren't enough, the actual problem is
almost always that the phone and the dev machine aren't on the same Wi-Fi
network (check both, including guest-network isolation, which some
routers enable by default and which blocks device-to-device traffic even
on the "same" network).

## 3. Point the app at that address

Preferred: set `EXPO_PUBLIC_API_BASE_URL` in the example app's `.env` (copy
from `.env.example`) to your LAN address:

```
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:8000
```

This bakes the address into every build started from that `.env`, so it
works both from `localhost:8081` on the dev machine itself and from any
other device on the LAN opening `http://192.168.1.20:8081` — no per-device
manual step needed. Restart `expo start` after changing `.env` (Expo only
reads `EXPO_PUBLIC_*` vars at bundler start).

Alternative: the example app's Settings screen also lets you set the backend
base URL per-device at runtime, under its collapsed "Developer Options"
section (overrides `EXPO_PUBLIC_API_BASE_URL` for that device only,
persisted via SecureStore/localStorage) — useful for a one-off test without
touching `.env`.

Either way, the SDK's `normalizeBaseUrl()` recognizes RFC 1918 private-LAN
addresses like this one and will not warn about using plain HTTP with it —
see the package README's "Auth and secrets" section for when it does warn.

### Web browser access from another device (not just Expo Go)

Opening the app in a **browser** on another computer via
`http://192.168.1.20:8081` is subject to the backend's CORS policy — unlike
a native app, a browser will not even send a request whose origin isn't on
the backend's allowlist. Add that origin to `rag-backend/.env`:

```
CORS_ORIGINS=http://localhost:8081,http://192.168.1.20:8081
```

If you use OAuth login (not dev-login) from that origin, also add its
callback URL to `ALLOWED_AUTH_REDIRECT_URIS` in the same file:

```
ALLOWED_AUTH_REDIRECT_URIS=expoeducationassistant://auth-callback,http://localhost:8081/auth-callback,http://192.168.1.20:8081/auth-callback
```

See `rag-backend/.env.example` for full comments on both variables, and
`rag-backend/README.md`'s "LAN development access" section for the full
checklist (backend bind address, frontend start command, env vars).

## 4. Revert to localhost-only when you're done

When you no longer need a physical device to reach the backend, stop the
`--host 0.0.0.0` server and go back to the default localhost-only bind:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

There's no other cleanup needed — no firewall rule or port-forward was
added in step 2, so there's nothing else to undo.

## Troubleshooting

- **Phone can't connect at all**: confirm both devices show the same Wi-Fi
  network name, and check whether the router has "AP/client isolation" or
  a "guest network" feature enabled — these deliberately block
  device-to-device traffic even within the same SSID.
- **Works on simulator/emulator but not a physical device**: this is
  expected — an iOS Simulator shares the host Mac's network stack
  (`localhost` on the simulator IS the Mac), but a physical device is a
  separate machine on the network and always needs the LAN IP, never
  `localhost`.
- **Connects but every request 401s**: the LAN address change doesn't
  affect auth — sign in (OAuth or dev-login) as normal; authentication is
  JWT-based, issued on sign-in, with no separate static token to configure.
  If you use OAuth from a LAN origin, confirm that origin's
  `/auth-callback` URL is in the backend's `ALLOWED_AUTH_REDIRECT_URIS`
  (see step 3 above) — a rejected redirect_uri also shows up as a failed
  sign-in, not a 401.
