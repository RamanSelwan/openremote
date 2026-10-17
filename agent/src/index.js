import readline from 'node:readline/promises';
import { io } from 'socket.io-client';
import { AGENT_VERSION, loadConfig, readCreds } from './config.js';
import { enroll } from './enroll.js';
import { createStreamPipeline } from './capture/stream.js';
import { createInputDriver, dispatchInput } from './input/index.js';

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (tag, msg) => console.log(`[${stamp()}] [${tag}] ${msg}`);

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || min));

const fmtConfig = (c) => `${c.fps}fps scale ${c.scale} q${c.quality}`;

async function main() {
  const config = loadConfig();

  /* ---------------------------------------------------------- credentials */
  let creds = readCreds();
  if (!creds && process.env.DEVICE_TOKEN) {
    creds = {
      deviceId: process.env.DEVICE_ID || '(env)',
      deviceToken: process.env.DEVICE_TOKEN,
      serverUrl: config.serverUrl,
      name: config.name,
    };
  }
  if (config.wantsEnroll || (config.enrollCode && !creds)) {
    creds = await enroll(config);
    log('pair', `enrolled as device ${creds.deviceId} ("${creds.name}")`);
  }
  if (!creds) {
    console.error(
      '\nThis machine is not paired yet.\n' +
        '1. Open the dashboard -> "Add device" to generate a pairing code.\n' +
        '2. Run:  npm run pair -w agent -- --code XXXX-XXXX\n' +
        '   (or set ENROLL_CODE in agent/.env and run npm run dev:agent)\n'
    );
    process.exit(1);
  }

  /* -------------------------------------------------------------- drivers */
  const pipeline = createStreamPipeline(config, log);
  log('capture', 'starting capture worker...');
  const info = await pipeline.init();
  const display = { width: info.width, height: info.height };
  log('capture', `driver=${info.driver} ${display.width}x${display.height} (worker thread)`);
  log('encoder', `backend=${info.encoder}`);

  const input = await createInputDriver(config);
  log(
    'input',
    `driver=${input.type} control=${config.allowControl ? 'enabled' : 'disabled'}`
  );

  const capabilities = () => ({
    canCapture: true,
    canControl: config.allowControl && input.type !== 'dry-run',
    captureDriver: info.driver,
    controlDriver: input.type,
    width: display.width,
    height: display.height,
    agentVersion: AGENT_VERSION,
    node: process.version,
  });

  /* --------------------------------------------------------------- socket */
  const socket = io(creds.serverUrl || config.serverUrl, {
    auth: { deviceToken: creds.deviceToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    socket.emit(
      'agent:hello',
      { name: config.name, capabilities: capabilities() },
      (res) => {
        if (res?.ok) log('session', `connected to ${socket.io.uri} as ${res.deviceId}`);
        else log('session', `hello rejected: ${res?.error || 'no response'}`);
      }
    );
  });
  socket.on('connect_error', (err) => log('session', `connect error: ${err.message}`));
  socket.on('disconnect', (reason) => log('session', `disconnected: ${reason}`));

  const heartbeat = setInterval(() => {
    if (!socket.connected) return;
    socket.emit('heartbeat', { capabilities: capabilities() });
  }, 10_000);

  /* -------------------------------------------------------------- streaming */
  let streamConfig = {
    fps: config.fps,
    scale: config.scale,
    quality: config.quality,
  };
  let streaming = false;
  let timer = null;
  let seq = 0;
  let errors = 0;
  // Unchanged grabs mean an idle desktop: poll slower instead of burning a
  // full CPU core re-encoding an identical picture 15 times a second.
  let idleStreak = 0;
  let statFrames = 0;
  let statGrabs = 0;
  let statEncodes = 0;
  let statBytes = 0;
  let statCaptureMs = 0;
  let statEncodeMs = 0;
  let statAt = Date.now();

  const applyStreamConfig = (cfg = {}) => {
    streamConfig = {
      fps: clamp(cfg.fps ?? streamConfig.fps, 1, 30),
      scale: clamp(cfg.scale ?? streamConfig.scale, 0.2, 1),
      quality: clamp(cfg.quality ?? streamConfig.quality, 20, 90),
    };
  };

  socket.on('stream:start', (cfg) => {
    applyStreamConfig(cfg);
    if (streaming) return;
    streaming = true;
    errors = 0;
    log(
      'stream',
      `start ${streamConfig.fps} fps, scale ${streamConfig.scale}, q${streamConfig.quality}`
    );
    tick();
  });

  socket.on('stream:stop', () => {
    if (!streaming) return;
    streaming = false;
    clearTimeout(timer);
    log('stream', 'stop (no viewers)');
  });

  socket.on('viewer:control', (cfg = {}) => {
    const before = fmtConfig(streamConfig);
    applyStreamConfig(cfg);
    if (fmtConfig(streamConfig) !== before) {
      log('stream', `viewer tuned to ${fmtConfig(streamConfig)}`);
    }
    if (cfg.type === 'clipboard' && config.allowControl) {
      try {
        input.setClipboard(String(cfg.text ?? ''));
        log('control', `clipboard updated (${String(cfg.text ?? '').length} chars)`);
      } catch (err) {
        log('control', `clipboard failed: ${err.message}`);
      }
    }
  });

  async function tick() {
    if (!streaming) return;
    const startedAt = Date.now();
    try {
      const frame = await pipeline.grab(streamConfig);
      if (frame?.sourceWidth) display.width = frame.sourceWidth;
      if (frame?.sourceHeight) display.height = frame.sourceHeight;
      if (frame) statGrabs += 1;
      if (frame?.unchanged) idleStreak += 1;
      else idleStreak = 0;

      if (frame && !frame.unchanged && !frame.error) {
        seq += 1;
        // `startedAt` (not emit time) so the viewer can report the full
        // capture + encode + network age of the picture it is showing.
        socket.volatile.emit(
          'frame',
          { seq, ts: startedAt, width: frame.width, height: frame.height },
          frame.data
        );
        statFrames += 1;
        statBytes += frame.data.byteLength;
        statCaptureMs += frame.captureMs || 0;
        statEncodeMs += frame.encodeMs || 0;
        statEncodes += 1;
        errors = 0;
      } else if (frame?.error) {
        throw new Error(frame.error);
      }
    } catch (err) {
      errors += 1;
      log('capture', `error (${errors}): ${err.message}`);
      if (errors >= 10) {
        log('capture', 'too many failures, stopping stream');
        streaming = false;
        return;
      }
    }

    const now = Date.now();
    if (now - statAt >= 5_000) {
      const secs = (now - statAt) / 1000;
      const encoded = statEncodes || 1;
      const report = {
        fps: Number((statFrames / secs).toFixed(1)),
        kbps: Math.round(statBytes / secs / 1024),
        captureMs: Math.round(statCaptureMs / encoded),
        encodeMs: Math.round(statEncodeMs / encoded),
        scale: streamConfig.scale,
        quality: streamConfig.quality,
      };
      log(
        'stream',
        `${report.fps} fps, ${report.kbps} KiB/s -> server, ` +
          `capture ${report.captureMs}ms, encode ${report.encodeMs}ms`
      );
      // Only report when at least one frame was actually encoded: an idle
      // window would otherwise advertise 0 ms capture/encode as "healthy".
      if (statEncodes > 0) {
        report.encoded = statEncodes;
        if (socket.connected && streaming) socket.emit('stream:stats', report);
      }
      statFrames = 0;
      statGrabs = 0;
      statEncodes = 0;
      statBytes = 0;
      statCaptureMs = 0;
      statEncodeMs = 0;
      statAt = now;
    }

    const fps = idleStreak > 3 ? Math.min(streamConfig.fps, 8) : streamConfig.fps;
    const interval = 1000 / fps;
    timer = setTimeout(tick, Math.max(0, interval - (Date.now() - startedAt)));
  }

  // Latency probe: echo the viewer timestamp straight back.
  socket.on('ping', (payload = {}) => {
    // `srv` is the agent clock at echo time: the viewer combines it with the
    // round trip to estimate clock offset and report true frame age.
    socket.emit('pong', { t: payload.t, sid: payload.sid, srv: Date.now() });
  });

  /* ---------------------------------------------------------------- input */
  socket.on('input', (payload) => {
    if (!config.allowControl) return;
    try {
      dispatchInput(input, payload, display);
    } catch (err) {
      log('input', `failed: ${err.message}`);
    }
  });

  /* ------------------------------------------------- session consent (APPROVE) */
  let promptOpen = false;
  socket.on('session:request', async (req = {}) => {
    const viewer = req.viewer || 'someone';
    const sid = req.viewerSid;
    if (config.accessMode === 'open' || config.autoAccept) {
      log('session', `${viewer} requested access -> auto-accepted`);
      socket.emit('session:decision', { viewerSid: sid, granted: true });
      return;
    }
    if (!process.stdin.isTTY || promptOpen) {
      socket.emit('session:decision', {
        viewerSid: sid,
        granted: false,
        reason: 'no operator available to approve',
      });
      return;
    }
    promptOpen = true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`\n${viewer} wants to view/control this PC. Allow? [y/N] `))
        .trim()
        .toLowerCase();
      const granted = answer === 'y' || answer === 'yes';
      log('session', `${viewer} -> ${granted ? 'allowed' : 'denied'}`);
      socket.emit('session:decision', {
        viewerSid: sid,
        granted,
        reason: granted ? undefined : 'operator denied the request',
      });
    } finally {
      rl.close();
      promptOpen = false;
    }
  });

  /* -------------------------------------------------------------- shutdown */
  const shutdown = (signal) => {
    log('agent', `${signal} received, shutting down`);
    streaming = false;
    clearTimeout(timer);
    clearInterval(heartbeat);
    try {
      pipeline.close();
    } catch {}
    try {
      input.close();
    } catch {}
    socket.close();
    setTimeout(() => process.exit(0), 300).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log('agent', `openremote agent v${AGENT_VERSION} started as "${config.name}"`);
}

main().catch((err) => {
  console.error('[agent] failed to start:', err.message || err);
  process.exit(1);
});
