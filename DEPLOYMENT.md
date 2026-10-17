# Deployment Guide (Render + Vercel)

This repo splits into:
- **Backend (API + Socket.IO)**: deploy to [Render](https://render.com)
- **Frontend (React + Vite)**: deploy to [Vercel](https://vercel.com)
- **Agent (desktop)**: runs on the machines you want to control (Windows/macOS/Linux). Do **not** deploy it to Render/Vercel.

## 1) Prerequisites
- [Render account](https://dashboard.render.com/)
- [Vercel account](https://vercel.com/)
- [MongoDB Atlas](https://www.mongodb.com/atlas) (free tier is fine). Local in-memory DB is only for dev.

## 2) Deploy Backend to Render

### Option A: Use the Blueprint (`render.yaml`)
This repo includes [`render.yaml`](./render.yaml). Render can create the service directly from it.

1. Push this repo to GitHub/GitLab.
2. Go to Render → New → Blueprint.
3. Connect the repo and select the branch.
4. Render will create `openremote` web service with:
   - Build: `npm ci --include=dev && npm run build` (builds the client too so the server can serve `client/dist` in production)
   - Start: `npm start` (runs `server/src/index.js`)
   - Health check: `/api/health`

### Option B: Manual Web Service
1. Render → New → Web Service → Connect repo.
2. Settings:
   - Runtime: Node
   - Build Command: `npm ci --include=dev && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
   - Plan: Free (ok to start)

### Backend Environment Variables (Render → Environment)
Set these in the Render dashboard for your service:

| Key | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Required |
| `TRUST_PROXY` | `1` | Render sits behind a proxy (fixes client IPs, secure cookies if used later) |
| `JWT_SECRET` | (generate random) | Use Render's "Generate" or create a 32+ char secret. Never commit this. |
| `MONGODB_URI` | `mongodb+srv://...` | Atlas connection string. Must be set in production. |
| `CLIENT_ORIGIN` | `https://your-app.vercel.app` | The exact Vercel frontend URL (no trailing slash). This is used for CORS and Socket.IO allowlist. |
| `PORT` | (leave blank) | Render sets this automatically. |

Notes:
- The server serves the built React app from `client/dist` when present (see [`server/src/index.js`](server/src/index.js)). The root `build` script runs `npm run build -w client`, so `npm run build` in Render produces the dist.
- **`--include=dev` is required on the install step.** `render.yaml` sets `NODE_ENV=production`, and npm omits `devDependencies` in production mode — but the build tools (`vite`, `@vitejs/plugin-react`) *are* devDependencies. Without the flag the build fails with `sh: 1: vite: not found`. The same applies to any CI that exports `NODE_ENV=production` before installing.
- Health check returns 200 only when MongoDB is connected (`/api/health`).
- JWT_SECRET defaults to an insecure dev value if unset (you'll see a warning in dev). **Must** be set on Render.

## 3) Deploy Frontend to Vercel

This repo includes [`vercel.json`](./vercel.json) at the root.

1. Go to [Vercel → New Project](https://vercel.com/new).
2. Import your Git repo.
3. Framework Preset: `Other` (or leave auto). The config sets framework to null.
4. Build & Output Settings (auto-filled from `vercel.json`):
   - Install Command: `npm ci --include=dev`
   - Build Command: `npm run build` (runs client build)
   - Output Directory: `client/dist`
5. Environment Variables (optional but fine): Frontend uses relative paths (`/api`, `/socket.io`), so no `VITE_API_URL` is required if you serve via same domain. Since we split origins (Vercel frontend + Render backend), the frontend will call the Render URL. You have two good options:

### Option A: Point the frontend directly at Render (recommended)
Set these in **Vercel → Settings → Environment Variables** for Production (and Preview if used):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://your-render-app.onrender.com` |
| `VITE_SERVER_URL` | `https://your-render-app.onrender.com` |

Vite inlines them at build time, so **redeploy after changing them**. Then set
`CLIENT_ORIGIN` on Render to `https://your-app.vercel.app`.

> **Why not proxy `/socket.io` through Vercel rewrites?** Vercel rewrites do
> **not** carry WebSocket upgrades, so the realtime socket would fail to connect
> even though REST calls would work. The browser must reach the Render origin
> directly for `/socket.io` (see the README note: *"Vercel does not proxy them,
> which is why the socket connects directly to the Render origin"*). This is why
> `VITE_SERVER_URL` exists separately from `VITE_API_URL`.

### Option B: Keep a single origin with a WebSocket-capable proxy
If you specifically want one origin (e.g. to add cookies later), put a proxy
that supports WebSocket upgrades (**Nginx**, **Caddy**, or **Cloudflare**) in
front of both, or simply serve the dashboard from the Render service itself
(single-service deployment). Vercel rewrites alone are not sufficient.

After deploy, Vercel gives you `https://your-app.vercel.app`. Put that into Render's `CLIENT_ORIGIN`.

## 4) Connect the pieces
1. Deploy Render backend first. Verify `/api/health` returns `{"ok":true,...}`.
2. Set the Vercel env vars (`VITE_API_URL`, `VITE_SERVER_URL`) to your Render URL (see §3).
3. Deploy Vercel frontend.
4. Open Vercel URL, register the first account (becomes admin), generate a pairing code, run the agent on the target machine.

## 5) Agent setup (user machines)
The agent is not deployed to web. On each machine you want to control:

```bash
# from repo root or agent dir
npm install
# pair
npm run pair -w agent -- --code YOUR_CODE --server https://your-render-app.onrender.com
# or set SERVER_URL in agent/.env and run:
npm run dev:agent
```

See [`agent/.env.example`](agent/.env.example) and [`agent/src/config.js`](agent/src/config.js)
for the real env vars: `SERVER_URL`, `DEVICE_NAME`, `ACCESS_MODE` (`approve`/`open`),
`AUTO_ACCEPT`, `ALLOW_CONTROL`, `FPS` (default 15), `SCALE` (default 0.65),
`QUALITY` (default 55), `CAPTURE_DRIVER`, `INPUT_DRIVER`.

> The variable names must match `config.js` exactly. Names like
> `AGENT_SERVER_URL` or `CAPTURE_FPS` are **not** read and will be silently
> ignored, leaving the agent pointed at `http://localhost:5000`.

Windows capture uses [`agent/native/win-capture.ps1`](agent/native/win-capture.ps1) via `child_process` (spawns PowerShell). On Linux/macOS you can extend the capture backend; current code targets Windows primarily.

## 6) Production readiness & low-latency tips

What's already tuned for low lag:
- `server` sets `socket.setNoDelay(true)` on every connection (disables Nagle for mouse/keyboard frames) ([server/src/index.js:123](server/src/index.js#L123))
- Socket.IO `perMessageDeflate: false` (JPEGs are already compressed; deflate adds CPU/latency) ([server/src/index.js:135](server/src/index.js#L135))
- Frame emits use `socket.volatile.emit` from agent->viewer relay path to avoid head-of-line blocking for real-time frames
- Agent viewer tuning reacts to pipeline timings (`stream:stats`) so quality/scale adjust dynamically ([server/src/socket/index.js:176-187](server/src/socket/index.js#L176-L187))
- Input rate-limited server-side (400 inputs/sec) to prevent abuse without starving ([server/src/socket/index.js:381-400](server/src/socket/index.js#L381-L400))
- CORS allowlist via `CLIENT_ORIGIN` + same-origin support ([server/src/index.js:40-47](server/src/index.js#L40-L47))

Recommendations in production:
- Keep `FPS` between 8–12. Lower = smoother but uses more bandwidth/CPU. Start ~10.
- `SCALE` 0.5–0.8, `QUALITY` 40–70 balances crispness vs size. The viewer can request tuning.
- Use HTTPS everywhere (Render/Vercel do this by default). 
- If you see socket reconnect churn on Render Free tier, the service may sleep after inactivity. Consider Render Starter or enable "Always On". 
- For many viewers controlling one agent, the first grant starts streaming; additional granted viewers share the same stream (server relays frames to all granted viewers). 
- MongoDB Atlas: choose the region closest to Render region (set in `render.yaml` or manual) to reduce auth/query latency.

## 7) Quick smoke test
1. `GET https://your-render.onrender.com/api/health` → 200 OK with `ok: true`.
2. Open Vercel URL → login/register.
3. Add device → copy code.
4. Run agent with `--server` pointing to Render.
5. Agent appears online → click Connect → accept prompt on agent (if ACCESS_MODE=approve) → remote view loads with frames.

## 8) Troubleshooting
- **CORS/WS blocked**: Ensure `CLIENT_ORIGIN` matches exact Vercel URL. If using rewrites, browser hits Vercel origin so it's fine. If calling Render directly from Vercel app, cross-origin is allowed only if origin matches.
- **Socket disconnects**: Check Render logs (Events/Logs). Free tier sleeps; wake up on first request. Also ensure no adblock interfering with WS.
- **Agent can't enroll/connect**: Verify `AGENT_SERVER_URL` points to Render HTTPS URL. Check agent logs in terminal. Enrollment uses the pairing code from dashboard.
- **Black/empty frames on Windows**: The PowerShell capture runs `SetProcessDPIAware()` and copies primary screen. Multi-monitor? Currently captures primary screen only (`[System.Windows.Forms.Screen]::PrimaryScreen.Bounds`).
- **High CPU/latency**: Lower `SCALE` (e.g. 0.5), reduce `FPS`/`QUALITY`. Watch agent CPU and network. 

---

**Security note:** This is a self-hosted remote access tool. Treat JWT secrets, device tokens, and exposed URLs as sensitive. Only pair agents to machines you trust.