# OpenRemote — Software Requirements Specification

**Version:** 0.1.0 · **Status:** v1 implemented · **License:** MIT

An open-source, AnyDesk-style remote desktop access platform: view and control a
remote machine from a web browser through a self-hosted relay.

---

## 1. Product overview

### 1.1 Problem
Users need to access their own machines remotely (support, administration,
remote work) without paying per-seat licensing or sending traffic through a
third-party vendor's cloud.

### 1.2 Solution
A self-hosted MERN application in three deployable parts:

| Part | Role | Runs on |
|---|---|---|
| **Server** | REST API + realtime relay/signaling + persistence | Any host with Node 20+ and MongoDB |
| **Client** | React dashboard: accounts, device list, remote viewer | Any browser |
| **Agent** | Desktop daemon: screen capture + input injection | The machine being accessed (Win/macOS/Linux) |

### 1.3 Design principles
1. **Consent first** — the remote machine must approve access by default.
2. **Zero-config dev experience** — `npm run dev` works with no MongoDB install.
3. **Graceful degradation** — every native capability has a fallback driver, so
   the app always starts and clearly reports what is active.
4. **Self-hostable & open** — MIT licensed, no telemetry, no vendor lock-in.

---

## 2. Scope

### 2.1 In scope for v1 (delivered)
- Email/password accounts with JWT sessions (first account = admin).
- Device enrollment by one-time pairing code (AnyDesk-style 12-digit ID).
- Live screen viewing in the browser (JPEG frame relay, 1–30 fps).
- Remote mouse + keyboard control, mouse wheel, clipboard push.
- Per-device consent mode: `approve` (prompt on the agent) or `open`.
- Session audit log (who connected, when, for how long, how many frames).
- Quality presets (Sharp / Balanced / Fast) applied live per session.
- Multi-viewer support: several browsers can watch the same device.
- Fallback driver matrix so the agent runs on machines without native deps.

### 2.2 Explicit non-goals for v1
- File transfer, session recording, audio, multi-monitor picker.
- NAT-traversal/peer-to-peer media (signaling pass-through exists; see §11).
- Mobile clients, unattended-timeout policies, SSO/LDAP.
- Windows service / macOS launchd installers (documented as roadmap).

---

## 3. System architecture

```
┌──────────────┐   HTTPS/REST + WebSocket    ┌───────────────────────────┐
│   Browser    │ ──────────────────────────► │  Server (Express+Socket.IO)│
│ React client │   JWT auth, input events    │  · auth, devices, audit    │
│              │ ◄────────────────────────── │  · frame relay (volatile)  │
└──────────────┘   JPEG frames, status       │  · session approval        │
                                             │  · RTC signaling pass-thru │
                                             └────────────┬──────────────┘
                                                          │ device token auth
                                             ┌────────────▼──────────────┐
                                             │  Agent (Node daemon)      │
                                             │  capture → encode → emit  │
                                             │  input events → OS inject │
                                             └───────────────────────────┘
                                                          │
                                              MongoDB (Mongoose models)
```

**Media path (v1):** agent captures the screen → downscales/encodes JPEG →
`volatile` Socket.IO emit (drops frames instead of queueing) → server relays to
every *granted* viewer → browser decodes into a `<canvas>`.

**Control path:** browser DOM events → normalized coordinates (0..1) → server
(rate-limited, session must be granted) → agent → OS input driver.

Normalized coordinates mean the viewer and remote machine may have different
resolutions, DPI scales and window sizes.

### 3.1 Request flows
1. **Enrollment:** dashboard → `POST /api/devices/enroll-codes` → one-time code
   → agent `POST /api/enroll` → receives `deviceToken` (shown once, stored
   hashed server-side, persisted to `agent/data/device.json`).
2. **Viewing:** viewer joins room → server asks agent (if `approve`) → agent
   auto-accepts or prompts an operator → grant → `stream:start` → frames flow.
3. **Teardown:** last viewer leaves → `stream:stop` → agent halts capture
   (bandwidth is only spent while somebody is watching).

---

## 4. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Database | MongoDB + Mongoose | Document model fits devices/sessions; in-memory dev fallback |
| Backend | Express 4, Node 20+ (ESM) | Ubiquitous, well-understood |
| Realtime | Socket.IO 4 | Rooms, volatile emits, binary payloads, reconnects |
| Auth | JSONWebToken + bcryptjs | Stateless API auth, bcrypt password hashing |
| Frontend | React 18 + Vite 6 + React Router 6 | Fast dev loop, simple SPA |
| Agent capture | `robotjs` (preferred) → `screenshot-desktop` → `powershell` → synthetic | RobotJS returns raw pixels: no temp files, 17–57 ms/frame |
| Encoding | `sharp` (native libvips) → `jpeg-js` (pure JS) | sharp ≈ 4× faster; JS fallback keeps install portable |
| Input | `robotjs` → Windows PowerShell/Win32 bridge → dry-run | Verified on this machine: robotjs 0.9.1 works on Node 24 |

---

## 5. Functional requirements

### 5.1 Accounts (FR-AUTH)
- **FR-01** Register with name, email, password (≥ 8 chars); duplicate emails → 409.
- **FR-02** The **first** account created receives role `admin`.
- **FR-03** Login returns a JWT (default TTL 7 days); wrong password → 401 without
  revealing which field was wrong.
- **FR-04** Passwords stored as bcrypt hashes, never returned by any endpoint.
- **FR-05** Auth endpoints rate-limited (50 attempts / 15 min / IP).

### 5.2 Devices & enrollment (FR-DEV)
- **FR-10** A logged-in user generates a pairing code (8 chars, unambiguous
  alphabet, 10-minute TTL, single use, TTL-indexed in Mongo).
- **FR-11** `POST /api/enroll` exchanges a valid code for a `deviceToken`;
  the raw token is returned exactly once — only its SHA-256 is stored.
- **FR-12** Every device gets a human-readable 12-digit ID (`715 834 706 663`),
  plus a space-free normalized key for URL/socket lookups.
- **FR-13** Enrollment endpoint rate-limited (30 / 15 min / IP).
- **FR-14** The dashboard lists only the caller's devices (admins may list all),
  with live online status refreshed every 4 s and via `devices:changed` events.
- **FR-15** Owner can rename a device, switch access mode, or delete it
  (deletion revokes the token).

### 5.3 Session approval (FR-SES)
- **FR-20** `accessMode = 'approve'` (default): the viewer sees "waiting for
  approval"; the agent logs the request and either auto-accepts
  (`AUTO_ACCEPT=1`), prompts the operator in its terminal (interactive TTY), or
  denies when nobody can answer.
- **FR-21** `accessMode = 'open'`: grant immediately. Changeable per device
  from the dashboard at any time.
- **FR-22** Denied sessions show the reason on the viewer.
- **FR-23** Frames and input are relayed **only** to sockets that hold a grant;
  a grant ends when the viewer disconnects.

### 5.4 Viewing (FR-VIEW)
- **FR-30** Agent captures and streams **only while at least one viewer is
  granted**; it stops within one frame period of the last viewer leaving.
- **FR-31** Frames carry `{seq, ts, width, height}`; the viewer shows fps,
  KiB/s, round-trip latency and frame size.
- **FR-32** Quality presets change `fps`, `scale`, `quality` live:
  Sharp 12 fps / Balanced 8 fps / Fast 5 fps.
- **FR-33** Slow viewers drop frames (volatile emit + render guard) rather than
  building latency.
- **FR-34** Agent logs throughput every 10 s while streaming.

### 5.5 Control (FR-CTRL)
- **FR-40** Mouse move/click (left, right, middle), double-click, wheel —
  forwarded as normalized coordinates and mapped onto the remote resolution.
- **FR-41** Keyboard: printable characters, named keys (Enter, Tab, Backspace,
  arrows, F1–F12, …) and modifiers (Ctrl/Alt/Shift/Meta), including combos such
  as Ctrl+C.
- **FR-42** Mousemove is throttled client-side to ~40 events/s and the server
  enforces a 400 events/s per-socket token bucket.
- **FR-43** `Clipboard →` pushes the browser clipboard to the remote machine.
- **FR-44** `ALLOW_CONTROL=0` or a dry-run driver makes the session view-only;
  the dashboard then shows a "view only" badge.
- **FR-45** The browser keeps its own shortcuts (Esc, Ctrl+W, F-keys used by the
  app) local: viewer key events are `preventDefault`ed only while a session is
  live and focused.

### 5.6 Audit (FR-AUDIT)
- **FR-50** Every granted session is persisted: device, viewer, start/end,
  frames relayed, bytes relayed, end reason (`agent-offline`,
  `viewer-disconnected`, …).
- **FR-51** The dashboard can fetch the 25 most recent sessions per device.

---

## 6. Non-functional requirements

| ID | Requirement | Target (v1 measured) |
|---|---|---|
| NFR-01 | Capture→encode latency | ~100 ms/frame at 1536×864 (robotjs+sharp) |
| NFR-02 | Sustained frame rate | 5–12 fps depending on preset (measured 5–7.5 fps end-to-end) |
| NFR-03 | Bandwidth per viewer | ~100–400 KiB/s at Balanced/Fast presets |
| NFR-04 | Viewer-side latency | 4–7 ms on localhost (frame age incl. capture+encode) |
| NFR-05 | Cold start | server < 3 s (excl. first MongoDB download), agent < 2 s |
| NFR-06 | Portability | Node ≥ 20; agent degrades gracefully on any OS/arch |
| NFR-07 | Security | no plaintext secrets at rest; tokens hashed; rate limits on all auth/enroll paths |
| NFR-08 | Availability of dev env | `npm install && npm run dev` with **no** external services |
| NFR-09 | Browser support | current Chromium/Firefox/Safari (ES2020+, `createImageBitmap`) |

---

## 7. Data model

```
User      { name, email*, password(bcrypt), role: admin|user, timestamps }
Device    { deviceId*, deviceIdKey*, name, owner→User, tokenHash(sha256),
            platform/os/hostname/arch, accessMode: open|approve,
            status: online|offline, lastSeen, lastIp,
            capabilities{canCapture, canControl, captureDriver, controlDriver,
                         width, height, agentVersion, node}, timestamps }
EnrollCode{ code*, owner→User, used, usedAt, expiresAt(TTL index) }
Session   { device→Device, viewer→User, startedAt, endedAt, frames, bytes,
            endedReason }
```
`*` = unique index.

---

## 8. Interface contracts

### 8.1 REST (all under `/api`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | — | create account (first = admin) |
| POST | `/auth/login` | — | obtain JWT |
| GET | `/auth/me` | JWT | current user |
| GET | `/devices` | JWT | list devices |
| POST | `/devices/enroll-codes` | JWT | mint pairing code |
| GET | `/devices/:id` | JWT | device detail |
| GET | `/devices/:id/sessions` | JWT | audit log |
| PATCH | `/devices/:id` | JWT | rename / access mode |
| DELETE | `/devices/:id` | JWT | unenroll device |
| POST | `/enroll` | code | agent enrollment → deviceToken |
| GET | `/health` | — | liveness |

Errors are JSON `{ "error": "message" }` with an accurate HTTP status.

### 8.2 Socket.IO
Auth: `handshake.auth = { deviceToken }` (agent) or `{ token: <jwt> }` (viewer).

| Direction | Event | Payload |
|---|---|---|
| agent→srv | `agent:hello` | `{name, capabilities}` → ack `{ok, deviceId, accessMode}` |
| agent→srv | `heartbeat` | `{capabilities}` every 10 s |
| agent→srv | `frame` | `(meta, Buffer)` — binary attachment |
| agent→srv | `session:decision` | `{viewerSid, granted, reason?}` |
| viewer→srv | `viewer:join` | `{deviceId}` → ack `{ok, online, accessMode, device}` |
| viewer→srv | `input` | normalized input event (see §5.5) |
| viewer→srv | `viewer:control` | `{fps, scale, quality}` or `{type:'clipboard', text}` |
| srv→viewer | `session:state` | `{state: granted\|pending\|denied, reason?}` |
| srv→agent | `session:request` | `{viewerSid, viewer}` |
| srv↔both | `stream:start/stop`, `agent:online/offline`, `devices:changed` | |
| srv→viewer | `frame` | `(meta, Buffer)` — volatile (drops under load) |
| either | `rtc:offer/answer/ice` | signaling pass-through (roadmap) |

---

## 9. Security & privacy requirements

- **SR-01** Device tokens are 24 random bytes, stored only as SHA-256; shown once.
- **SR-02** Viewer JWTs are signed; every socket handshake is authenticated
  before any room join, and ownership is checked server-side per device.
- **SR-03** Consent-by-default (`approve`) so an unattended machine is not
  silently observable.
- **SR-04** All relay traffic is gated on a live grant; input additionally
  passes a server-side rate limiter.
- **SR-05** `JWT_SECRET` must be set in production; the server warns loudly when
  it falls back to the insecure dev default.
- **SR-06** No telemetry, no third-party calls from client or agent.
- **SR-07** Browser origin for CORS is configurable (`CLIENT_ORIGIN`).
- **SR-08** Enrollment codes are single-use, short-lived and rate-limited.

*Known v1 limitations (documented, not silently accepted):* transport is plain
HTTP in dev (terminate TLS at a reverse proxy in production); the relay server
can read frames by design (self-hosted trust model); keyboard layout assumes US
punctuation; there is no per-session MFA.

---

## 10. Licensing (open-source requirements)

- Project license: **MIT** (see `LICENSE`) — permits commercial and private use,
  modification and redistribution with attribution.
- Third-party inventory and obligations:

| Package | License | Use |
|---|---|---|
| express, cors, socket.io, mongoose, jsonwebtoken, bcryptjs, express-rate-limit | MIT | server |
| react, react-dom, react-router-dom, vite, @vitejs/plugin-react | MIT | client |
| socket.io-client, jpeg-js | MIT | agent |
| robotjs | MIT | capture + input (optionalDependency) |
| sharp | Apache-2.0 | JPEG encoding (optionalDependency) |
| screenshot-desktop | MIT | capture fallback |
| mongodb-memory-server (dev) | MIT | zero-setup dev database |
| concurrently (dev) | ISC | dev orchestration |

- **Avoided:** `@nut-tree/nut-js` (commercial EULA on current registry builds) —
  rejected for an MIT project.
- Contributors must not add dependencies without a permissive license
  (MIT/ISC/Apache-2.0/BSD) without an explicit note in this document.

---

## 11. Roadmap

| Version | Feature | Notes |
|---|---|---|
| v1.0 | ✅ this document | frame relay, control, consent, audit |
| v1.1 | WebRTC P2P media path | signaling relay (`rtc:*`) already in place; use `node-datachannel`/`werift` in the agent to bypass server bandwidth |
| v1.2 | Multi-monitor + window picker, cursor with remote pointer overlay | |
| v1.3 | File transfer over the socket data channel | |
| v1.4 | Service installers (Windows service / launchd / systemd) + auto-start | |
| v2.0 | E2E encryption of media, per-session MFA, recording playback | |

---

## 12. Acceptance criteria & verification (v1)

| # | Criterion | Verified how | Result |
|---|---|---|---|
| AC-1 | Fresh clone: `npm install && npm run dev` starts everything | run on Windows/Node 24 | ✅ |
| AC-2 | Register → login → wrong password rejected | HTTP checks | ✅ 201 / 200 / 401 |
| AC-3 | Pairing code enrolls an agent exactly once | agent run + reuse attempt | ✅ second redeem fails |
| AC-4 | Dashboard shows live device status | browser | ✅ online badge + drivers |
| AC-5 | Connect → consent → live frames on canvas | browser | ✅ live badge, canvas 1152×648 |
| AC-6 | Stats reflect reality (fps/KiB/s/latency) | browser sampling | ✅ 5 fps / ~120 KiB/s / ~5 ms |
| AC-7 | Quality preset changes stream live | browser | ✅ 1152×648 → 768×432 |
| AC-8 | Remote input path executes | agent driver test | see §13 |
| AC-9 | Agent stops streaming when no viewers | agent log (`stream stop`) | ✅ |
| AC-10 | Server survives restart; in-memory DB documented | restart cycle | ✅ (set `MONGODB_URI` for durability) |
