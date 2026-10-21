import { spawn } from 'node:child_process';
import { readJpegSize } from './jpeg.js';

/**
 * ffmpeg-backed screen capture.
 *
 * The robotjs driver copies the whole framebuffer with GDI (BitBlt) and then
 * JPEG-encodes it in libvips. Both steps are CPU bound and cost ~40 ms per
 * 1080p frame, which caps the stream at ~8 fps on a low-power laptop.
 *
 * ffmpeg can do the same work much cheaper:
 *   -capture: Direct3D 11 Desktop Duplication (`ddagrab`), which only touches
 *             changed regions on the GPU
 *   -encode : `mjpeg_qsv` (Intel Quick Sync) or the tuned `mjpeg` encoder
 *
 * The process is started once and emits a continuous MJPEG stream on stdout;
 * we keep only the newest complete frame. Frames are perishable, so queueing
 * them would only add latency.
 *
 * Every capability is probed by actually producing one frame, because ffmpeg
 * builds differ in what they ship. If nothing works the factory throws and
 * `createCaptureDriver()` falls through to the next driver.
 */

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

const PROBE_TIMEOUT_MS = 5000;
const RESTART_DEBOUNCE_MS = 1500;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_START_FAILURES = 3;

/** Preferred combinations, best first. */
const CANDIDATES = [
  { input: 'ddagrab', encoder: 'mjpeg_qsv' },
  { input: 'ddagrab', encoder: 'mjpeg' },
  { input: 'gdigrab', encoder: 'mjpeg_qsv' },
  { input: 'gdigrab', encoder: 'mjpeg' },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

/**
 * Windows refuses to spawn `.cmd`/`.bat` shims without a shell, and package
 * managers (scoop, conda, chocolatey) do install ffmpeg that way. Real
 * `ffmpeg.exe` installs are launched directly, which avoids shell quoting.
 */
const spawnOptions = (ffmpegPath) => {
  const needsShell = /\.(cmd|bat)$/i.test(ffmpegPath);
  return { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: needsShell };
};

/**
 * Terminate an ffmpeg instance. With `shell: true` the direct child is the
 * shell, so killing it alone would orphan the real encoder: kill the tree.
 */
function killChild(child, ffmpegPath) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid && /\.(cmd|bat)$/i.test(ffmpegPath)) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } catch {
      /* ignore */
    }
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

/** config.quality is "higher is better" (20..90); mjpeg -q:v is the reverse (2..31). */
const mjpegQScale = (quality) => clamp(2 + (31 - 2) * ((90 - quality) / 70), 2, 31);

/** mjpeg_qsv takes a QP-like 1..51; quality 20..90 maps to 51..1. */
const qsvQuality = (quality) => clamp(51 - (51 - 1) * ((quality - 20) / 70), 1, 51);

function buildArgs(candidate, { fps, width, height, quality, frames }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  if (candidate.encoder === 'mjpeg_qsv') {
    args.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
  }

  if (candidate.input === 'ddagrab') {
    // Desktop Duplication: GPU-side capture of changed regions only.
    args.push('-f', 'lavfi', '-i', `ddagrab=0:framerate=${fps}`);
  } else {
    // GDI capture. Slower than ddagrab but available on every Windows build.
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', 'desktop');
  }

  const filters = [];
  if (candidate.input === 'ddagrab') filters.push('hwdownload', 'format=bgra');
  if (width && height) filters.push(`scale=${width}:${height}:flags=fast_bilinear`);
  if (filters.length) args.push('-vf', filters.join(','));

  if (candidate.encoder === 'mjpeg_qsv') {
    args.push('-c:v', 'mjpeg_qsv', '-global_quality', String(qsvQuality(quality)));
  } else {
    args.push('-c:v', 'mjpeg', '-q:v', String(mjpegQScale(quality)));
  }

  if (frames) args.push('-frames:v', String(frames));
  args.push('-f', 'mjpeg', 'pipe:1');
  return args;
}

/**
 * Run one throwaway ffmpeg instance and wait for a complete JPEG.
 * Resolves with the frame size, or null when this combination does not work.
 */
function probe(candidate, ffmpegPath) {
  return new Promise((resolve) => {
    let child = null;
    let timer = null;
    let settled = false;
    const chunks = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killChild(child, ffmpegPath);
      resolve(value);
    };

    try {
      child = spawn(
        ffmpegPath,
        buildArgs(candidate, { fps: 2, quality: 60, frames: 1 }),
        spawnOptions(ffmpegPath)
      );
    } catch {
      resolve(null);
      return;
    }

    timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        const size = readJpegSize(buf);
        if (size?.width && size?.height) finish({ width: size.width, height: size.height });
      }
      if (buf.length > MAX_BUFFER_BYTES) finish(null);
    });
  });
}

const materiallyDifferent = (a, b) =>
  !b ||
  Math.abs(a.fps - b.fps) >= 1 ||
  Math.abs(a.scale - b.scale) >= 0.05 ||
  Math.abs(a.quality - b.quality) >= 5;

export async function createFfmpegCapture(config = {}) {
  if (process.platform !== 'win32') {
    throw new Error('ffmpeg driver is Windows-only');
  }

  const ffmpegPath = config.ffmpegPath || 'ffmpeg';
  const wantedInput = config.ffmpegInput || 'auto';
  const wantedEncoder = config.ffmpegEncoder || 'auto';

  const candidates = CANDIDATES.filter(
    (c) =>
      (wantedInput === 'auto' || c.input === wantedInput) &&
      (wantedEncoder === 'auto' || c.encoder === wantedEncoder)
  );

  let chosen = null;
  let native = null;
  const tried = [];
  for (const candidate of candidates) {
    const label = `${candidate.input}+${candidate.encoder}`;
    const size = await probe(candidate, ffmpegPath);
    if (size) {
      chosen = candidate;
      native = size;
      break;
    }
    tried.push(label);
  }

  if (!chosen) {
    throw new Error(
      `no usable ffmpeg capture combination (tried: ${tried.join(', ') || 'none'})`
    );
  }

  const state = {
    child: null,
    buffer: Buffer.alloc(0),
    latest: null,
    version: 0,
    returned: -1,
    settings: null,
    failures: 0,
    lastStartAt: 0,
    stderr: '',
    dead: null,
  };

  function targetSize(settings) {
    const scale = Math.min(1, Math.max(0.2, settings.scale));
    return {
      width: Math.max(160, Math.round((native.width * scale) / 2) * 2),
      height: Math.max(90, Math.round((native.height * scale) / 2) * 2),
    };
  }

  function stop() {
    if (!state.child) return;
    const child = state.child;
    state.child = null;
    state.buffer = Buffer.alloc(0);

    killChild(child, ffmpegPath);

    // ffmpeg normally exits on SIGTERM immediately. If it wedges (a stuck
    // hardware encoder will), escalate so the agent never leaks a process.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1000);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }

  function start(settings) {
    stop();
    const size = targetSize(settings);
    const args = buildArgs(chosen, {
      fps: clamp(settings.fps, 1, 60),
      width: size.width,
      height: size.height,
      quality: clamp(settings.quality, 20, 90),
    });

    const child = spawn(ffmpegPath, args, spawnOptions(ffmpegPath));
    state.child = child;
    state.settings = { ...settings, ...size };
    state.lastStartAt = Date.now();
    state.stderr = '';

    child.stderr.on('data', (chunk) => {
      state.stderr = (state.stderr + chunk.toString()).slice(-1000);
    });

    child.stdout.on('data', (chunk) => {
      state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;
      drain(size);
    });

    child.on('error', (err) => {
      state.dead = err.message || String(err);
    });

    child.on('close', (code) => {
      if (state.child !== child) return; // superseded by a restart
      state.child = null;
      // Non-zero exit with no frames is a real startup failure; a later
      // restart attempt is handled by ensure().
      if (code !== 0) {
        state.failures += 1;
        state.dead = `ffmpeg exited with code ${code}${state.stderr ? `: ${state.stderr.trim()}` : ''}`;
      }
    });
  }

  /** Pull every complete JPEG out of the buffer and keep the newest one. */
  function drain(size) {
    const buf = state.buffer;
    let last = null;
    let consumed = 0;

    let startIndex = buf.indexOf(SOI);
    while (startIndex !== -1) {
      const endIndex = buf.indexOf(EOI, startIndex + 2);
      if (endIndex === -1) break;
      last = buf.subarray(startIndex, endIndex + 2);
      consumed = endIndex + 2;
      startIndex = buf.indexOf(SOI, consumed);
    }

    if (last) {
      const dims = readJpegSize(last) || size;
      state.latest = {
        data: last,
        width: dims.width || size.width,
        height: dims.height || size.height,
        sourceWidth: native.width,
        sourceHeight: native.height,
        mime: 'image/jpeg',
        // The frame is already scaled and JPEG-encoded by ffmpeg, so the
        // frame processor can hand it to the socket without re-encoding.
        encoded: true,
      };
      state.version += 1;
      state.failures = 0;
      state.dead = null;
      state.buffer = buf.subarray(consumed);
      return;
    }

    // A partial frame is expected; a runaway buffer means we lost sync.
    if (buf.length > MAX_BUFFER_BYTES) state.buffer = Buffer.alloc(0);
  }

  function ensure(settings) {
    const now = Date.now();
    const running = Boolean(state.child);

    if (running && !materiallyDifferent(settings, state.settings)) return;
    if (running && now - state.lastStartAt < RESTART_DEBOUNCE_MS) return;

    if (!running) {
      if (state.failures >= MAX_START_FAILURES) {
        throw new Error(`ffmpeg capture unavailable: ${state.dead || 'repeated startup failure'}`);
      }
      start(settings);
      return;
    }

    // Settings changed materially: restart so fps/scale/quality take effect.
    start(settings);
  }

  return {
    type: `ffmpeg:${chosen.input}+${chosen.encoder}`,
    size: async () => ({ width: native.width, height: native.height }),
    async grab(settings = {}) {
      ensure({
        fps: settings.fps ?? config.fps ?? 15,
        scale: settings.scale ?? config.scale ?? 0.65,
        quality: settings.quality ?? config.quality ?? 55,
      });

      if (state.version !== state.returned && state.latest) {
        state.returned = state.version;
        return state.latest;
      }
      return { unchanged: true };
    },
    close() {
      stop();
    },
  };
}
