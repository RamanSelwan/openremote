import { parentPort } from 'node:worker_threads';
import { createCaptureDriver } from './index.js';
import { createFrameProcessor } from './encode.js';

/**
 * Capture + JPEG encode worker.
 *
 * Screen capture is a synchronous native call (robotjs blocks ~40 ms per
 * frame at 1080p) and JPEG encoding is CPU heavy. Running both off the main
 * thread keeps the agent's socket loop free, so mouse/keyboard events are
 * dispatched immediately instead of queueing behind the next frame.
 */

let capture = null;
let encoder = null;
let cfg = { fps: 15, scale: 0.65, quality: 55 };
let busy = false;
let lastSignature = 0;
let lastSentAt = 0;

// Re-send an unchanged screen occasionally so a deadline or missed packet
// cannot leave the viewer stuck on a stale picture.
const IDLE_REFRESH_MS = 2000;

/** FNV-1a over a sparse sample of the raw pixels (~4k reads, not megabytes). */
function signature(bytes) {
  let hash = 0x811c9dc5;
  const step = Math.max(4, Math.floor(bytes.length / 4096 / 4) * 4);
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      cfg = { ...cfg, ...(msg.config || {}) };
      capture = await createCaptureDriver(msg.config || {});
      const size = await capture.size();
      encoder = await createFrameProcessor();
      parentPort.postMessage({
        type: 'ready',
        id: msg.id,
        driver: capture.type,
        encoder: encoder.backend,
        width: size.width,
        height: size.height,
      });
    } catch (err) {
      parentPort.postMessage({ type: 'fatal', id: msg.id, message: err.message || String(err) });
    }
    return;
  }

  if (msg.type === 'config') {
    cfg = { ...cfg, ...(msg.config || {}) };
    return;
  }

  if (msg.type === 'grab') {
    if (busy) return;
    busy = true;
    try {
      // The viewer can re-tune mid-stream: take the newest settings with every
      // grab so quality/scale changes take effect on the next frame.
      if (msg.config) cfg = { ...cfg, ...msg.config };
      const startedAt = Date.now();
      const frame = await capture.grab();
      const captureMs = Date.now() - startedAt;

      if (frame.raw) {
        const sig = signature(frame.raw);
        if (sig === lastSignature && startedAt - lastSentAt < IDLE_REFRESH_MS) {
          parentPort.postMessage({ type: 'frame', id: msg.id, unchanged: true });
          return;
        }
        lastSignature = sig;
      }

      const encodeStartedAt = Date.now();
      const out = await encoder.process(frame, cfg);
      const encodeMs = Date.now() - encodeStartedAt;
      lastSentAt = Date.now();
      // Copy out of Buffer pool memory so the ArrayBuffer can be transferred
      // without cloning the whole frame twice.
      const bytes = new Uint8Array(out.data);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      parentPort.postMessage(
        {
          type: 'frame',
          id: msg.id,
          data: buffer,
          width: out.width,
          height: out.height,
          sourceWidth: frame.width,
          sourceHeight: frame.height,
          captureMs,
          encodeMs,
        },
        [buffer]
      );
    } catch (err) {
      parentPort.postMessage({ type: 'frame', id: msg.id, error: err.message || String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (msg.type === 'close') {
    try {
      capture?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
});
