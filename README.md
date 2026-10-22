# OpenRemote

**Self-hosted, open-source remote access (AnyDesk-style) built on the MERN stack.**
View and control your computers from any browser — your data stays on your own server.

```
 Browser (React)  ──REST/WebSocket──►  Server (Express + Socket.IO + MongoDB)
                                              │  frame relay · consent · audit
                                              ▼
                                     Agent (Node daemon on the remote PC)
                                     capture → JPEG encode → stream
                                     input events → OS mouse/keyboard
```

## Features

- 🖥 **Live screen viewing** in the browser — 10–20 fps, quality presets, live fps/bandwidth/RTT stats, automatic quality adaptation
- 🖱 **Full remote control** — mouse (incl. right/middle click, wheel), keyboard with modifiers, clipboard push
- 🔑 **Pairing-code enrollment** — human-readable 12-digit device IDs, one-time codes, tokens stored hashed
- ✋ **Consent by default** — the remote machine approves each viewer (`approve`) or allows open access
- 👥 **Multi-viewer** — several people can watch the same machine at once
- 📋 **Audit log** — who connected, when, for how long, how many frames/bytes
- 🧩 **Graceful drivers** — runs with native modules; falls back to pure JS/PowerShell/dry-run when they're missing
- 📦 **Zero-setup dev** — `npm install && npm run dev` works without installing MongoDB (in-memory fallback)
- 🔒 **MIT licensed** — no telemetry, no vendor lock-in, no third-party clouds

## Repository layout

```
openremote/
├── server/          Express REST API + Socket.IO relay/signaling + Mongoose models
├── client/          React + Vite dashboard (auth, devices, remote viewer)
├── agent/           Desktop daemon: capture/, input/, native/ PowerShell bridges
├── REQUIREMENTS.md  Full software requirements specification (SRS)
├── LICENSE          MIT
└── package.json     npm workspaces + dev orchestration
```

## Quick start (development)

Requirements: **Node.js ≥ 22.9**, npm. Nothing else.

```bash
npm install          # installs server + client + agent workspaces
npm run dev          # starts server (:5000), client (:5173) and agent together
```

Then in the browser:

1. Open <http://localhost:5173> → **Create account** (the first account becomes admin).
2. Click **Add device** → you get a pairing code like `K7F2-9QMR`.
3. The agent started by `npm run dev` still needs to pair. Stop it and re-run with
   your code:

   ```bash
   npm run dev:agent            # or, to pair and start in one step:
   npm run pair -w agent -- --code K7F2-9QMR
   ```

   > The viewer draws its own cursor on top of the streamed image: OS-level
   > screen capture does not include the mouse pointer, so this keeps pointing
   > responsive even while a frame is still in flight.

   The agent persists its credentials in `agent/data/device.json` and never needs
   the code again.
4. Back in the dashboard the device shows **online** → click **Connect**.
5. With the default `ACCESS_MODE=approve`, the agent console asks
   `Allow? [y/N]` — the session goes **live** and the screen appears in the canvas.

Run the three processes separately if you prefer:

```bash
npm run dev:server     # API + websocket relay
npm run dev:client     # Vite dev server with /api + /socket.io proxy
npm run dev:agent      # desktop agent (same machine or another one)
```

## Configuration

### Server — `server/.env` (see `server/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP + WebSocket port |
| `MONGODB_URI` | *(unset)* | unset ⇒ in-memory MongoDB (dev only, data lost on restart) |
| `JWT_SECRET` | insecure dev default | **set this in production** |
| `JWT_TTL` | `7d` | login lifetime |
| `CLIENT_ORIGIN` | `http://localhost:5173` | comma-separated browser origins (CORS + WS); empty = same origin only |
| `TRUST_PROXY` | `0` (auto-on in production) | trust `X-Forwarded-*` from a proxy |
| `ENROLL_CODE_TTL_MINUTES` | `10` | pairing-code lifetime |

### Client — `client/.env.local` (see `client/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | same origin | API origin for split deployments |
| `VITE_SERVER_URL` | page origin | Socket.IO origin for split deployments |

### Agent — `agent/.env` (see `agent/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_URL` | `http://localhost:5000` | relay server |
| `ENROLL_CODE` | — | one-time pairing code (alternative to `--code`) |
| `ACCESS_MODE` | `approve` | `approve` (ask) or `open` (no prompt) |
| `AUTO_ACCEPT` | `1` | auto-approve session requests in `approve` mode |
| `ALLOW_CONTROL` | `1` | `0` = view-only |
| `FPS` / `SCALE` / `QUALITY` | `15` / `0.65` / `55` | stream defaults (viewer can override) |
| `CAPTURE_DRIVER` | `auto` | `ffmpeg` \| `robotjs` \| `screenshot-desktop` \| `powershell` \| `synthetic` |
| `INPUT_DRIVER` | `auto` | `robotjs` \| `powershell` \| `dry-run` |
| `FFMPEG_PATH` | `ffmpeg` | path to the ffmpeg binary (see *Hardware capture*) |
| `FFMPEG_INPUT` | `auto` | `ddagrab` \| `gdigrab` — force a capture source |
| `FFMPEG_ENCODER` | `auto` | `mjpeg_qsv` \| `mjpeg` — force a hardware/software encoder |

## How the drivers work

The agent picks the best driver it can load and **logs which one is active**:

| Concern | Preference order | Notes |
|---|---|---|
| Screen capture | `ffmpeg` → `robotjs` → `screenshot-desktop` → `powershell` → `synthetic` | ffmpeg captures on the GPU (Direct3D duplication) and encodes JPEG with the hardware encoder when available; robotjs returns raw pixels but is CPU-bound. Channel order BGRA/RGBA is auto-detected, not assumed. Capture + JPEG encoding run on a worker thread, so input dispatch never waits for the next frame |
| Input injection | `robotjs` → Windows PowerShell/Win32 bridge → `dry-run` | the PowerShell bridge (`agent/native/win-input.ps1`) is a persistent process speaking a line protocol, so keystrokes stay fast |
| JPEG encoding | `ffmpeg` (in-driver) → `sharp` → `jpeg-js` | ffmpeg frames arrive already scaled and encoded, so they are forwarded without a second pass; sharp ≈ 4× faster than jpeg-js, which keeps the agent installable without native modules |

### Hardware capture (optional, recommended)

With ffmpeg installed the agent captures via Direct3D 11 Desktop Duplication and
encodes with Intel Quick Sync, which is far cheaper than copying the framebuffer
and encoding in JavaScript:

```powershell
winget install Gyan.FFmpeg     # then restart the agent
```

ffmpeg must be **6.0 or newer** (the `ddagrab` filter). The agent probes four
combinations — `ddagrab+mjpeg_qsv`, `ddagrab+mjpeg`, `gdigrab+mjpeg_qsv`,
`gdigrab+mjpeg` — and uses the first that actually produces a frame, so a
missing ffmpeg or an unsupported GPU simply falls back to robotjs. Force a
combination with `FFMPEG_INPUT` / `FFMPEG_ENCODER`, or disable ffmpeg entirely
with `CAPTURE_DRIVER=robotjs`.

Measured on a 1536×864 Windows machine with the robotjs + sharp drivers:
≈ **44 ms** capture and **20–30 ms** resize/encode per frame (worker thread),
so the relay sustains **~15 fps** at the Balanced preset (~50 KB/frame).
Unchanged screens are detected and skipped, and the viewer lowers
resolution/quality automatically when the round-trip time rises.

## Deployment

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for a detailed, step-by-step guide for Render (backend + Socket.IO) and Vercel (frontend).**

Three things have to run: the server (API + socket relay), the dashboard, and
the agent on each controlled machine. The dashboard can be served by the server
itself (single origin, simplest) or hosted separately on Vercel.

### Option A — one service (Render, Railway, Fly.io, VPS)

```bash
npm install
npm run build          # builds client/dist
MONGODB_URI=mongodb://... JWT_SECRET=<long-random> NODE_ENV=production npm start
```

> If your platform exports `NODE_ENV=production` **before** installing, use
> `npm ci --include=dev` for the install step: npm skips `devDependencies` in
> production mode, and the build tools (`vite`) live there.

The Express server serves `client/dist` and the WebSocket relay on the same
origin, so no CORS configuration is needed. `GET /api/health` returns `200`
only when MongoDB is connected — point the platform health check at it.

`render.yaml` is a ready blueprint: create a **Blueprint** in Render from this
repo, then set `MONGODB_URI` (MongoDB Atlas free tier is enough) and leave
`CLIENT_ORIGIN` empty. Render injects `PORT` and generates `JWT_SECRET`.

> Render's free plan sleeps after inactivity; the first connection after a
> sleep takes a few seconds. Use a paid instance (or a small VPS) for a
> always-on remote-access endpoint.

### Option B — dashboard on Vercel, server on Render

1. Deploy the backend first (Option A) and note its URL, e.g.
   `https://openremote.onrender.com`.
2. Import the same repo into Vercel. `vercel.json` already sets the install
   command (`npm ci --include=dev`), build command (`npm run build`) and output
   directory (`client/dist`).
3. In **Vercel → Settings → Environment Variables** add for Production:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://openremote.onrender.com` |
   | `VITE_SERVER_URL` | `https://openremote.onrender.com` |

   (Set them for Preview too if you use preview deployments; Vite inlines them
   at build time, so redeploy after changing them.)
4. In Render set `CLIENT_ORIGIN=https://your-project.vercel.app` (comma-separate
   several origins for preview URLs) and redeploy.

Both hosts must allow WebSockets — Render does by default, Vercel does not
proxy them, which is why the socket connects directly to the Render origin.

> **Keep the two in sync.** Render redeploys on push but Vercel does not, so they
> drift easily — the same repo can serve two different dashboards depending on
> which URL you open. Set the `VERCEL_DEPLOY_HOOK` secret to have
> [`.github/workflows/vercel.yml`](./.github/workflows/vercel.yml) rebuild Vercel
> on every push, and see
> [DEPLOYMENT.md § Keeping the two hosts in sync](./DEPLOYMENT.md) for how to
> tell which build a host is serving.

### Agent on the controlled machine

```bash
npm install
cp agent/.env.example agent/.env     # set SERVER_URL=https://your.domain
npm run pair -w agent -- --code XXXX-XXXX     # first run, starts the agent
```

Subsequent runs: `npm run start -w agent`. The token is stored in
`agent/data/device.json` (mode 0600).

### Production checklist

- `JWT_SECRET` set to a long random value (the server refuses to start in
  production without it) and `MONGODB_URI` pointing at a persistent database.
- `CLIENT_ORIGIN` lists every dashboard origin when they are not same-origin.
- Terminate TLS at the platform/reverse proxy; the app itself speaks plain HTTP.
- Keep `TRUST_PROXY=1` behind a proxy/platform so rate limits see real client IPs.
- The browser dashboard and the agent must reach the same server URL.

## Security model

- Device tokens: 24 random bytes, **SHA-256 stored**, revealed once at enrollment.
- Every WebSocket is authenticated (device token or JWT) before any room join;
  device ownership is re-checked server-side for every join.
- Frames and input are relayed **only** to sockets holding a live consent grant.
- Rate limits: auth 50/15 min, enrollment 30/15 min, input 400 events/s/socket.
- Consent-by-default; `ALLOW_CONTROL=0` gives a view-only agent.
- Known v1 limits (see `REQUIREMENTS.md` §9): US keyboard layout assumption,
  server can see frames (self-hosted trust), no MFA.

## Open-source licensing

MIT — see [`LICENSE`](LICENSE). Third-party license inventory lives in
[`REQUIREMENTS.md`](REQUIREMENTS.md) §10. `@nut-tree/nut-js` was deliberately
avoided (commercial EULA on current registry builds).

## Roadmap

- **v1.1** WebRTC P2P media (the signaling pass-through `rtc:offer/answer/ice`
  is already wired through the server) to remove the relay bandwidth bottleneck
- **v1.2** Multi-monitor/window picker, remote cursor overlay
- **v1.3** File transfer over the socket data channel
- **v1.4** Windows service / launchd / systemd installers
- **v2.0** End-to-end encryption, session recording, MFA

## Project documents

- [`REQUIREMENTS.md`](REQUIREMENTS.md) — full SRS: functional/non-functional
  requirements, data model, API + socket contracts, security, roadmap, acceptance
  matrix
- [`REQUIREMENTS.md` §12](REQUIREMENTS.md) — the verification table for v1
