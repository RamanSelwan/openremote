import { Worker } from 'node:worker_threads';

/**
 * Host side of the capture worker.
 *
 * Only one grab is ever in flight: frames are perishable, so queueing them
 * would only add latency. If the worker dies it is recreated on the next
 * grab, which is what keeps a long-running agent alive across driver crashes.
 */
export function createStreamPipeline(config, log = () => {}) {
  let worker = null;
  let initInfo = null;
  let seq = 0;
  let pending = new Map();
  let inFlight = false;
  let closing = false;

  function spawn() {
    closing = false;
    worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.on('message', (msg) => {
      if (msg.type === 'fatal') {
        log('capture', `worker fatal: ${msg.message}`);
      }
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.type === 'fatal') waiter.reject(new Error(msg.message));
      else waiter.resolve(msg);
    });
    worker.on('error', (err) => {
      log('capture', `worker error: ${err.message}`);
      failAll(err);
      worker = null;
      initInfo = null;
    });
    worker.on('exit', (code) => {
      if (code !== 0 && !closing) log('capture', `worker exited with code ${code}`);
      failAll(new Error(`capture worker exited (${code})`));
      worker = null;
      initInfo = null;
    });
  }

  function failAll(err) {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
    inFlight = false;
  }

  function request(payload, transfer = []) {
    if (!worker) spawn();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id }, transfer);
    });
  }

  async function init() {
    if (initInfo) return initInfo;
    if (!worker) spawn();
    const res = await request({ type: 'init', config });
    initInfo = res;
    return res;
  }

  /** Resolves with the frame, `{ unchanged: true }`, or null when busy. */
  async function grab(settings) {
    if (inFlight) return null;
    inFlight = true;
    try {
      if (!initInfo) await init();
      return await request({ type: 'grab', config: settings, at: Date.now() });
    } finally {
      inFlight = false;
    }
  }

  function close() {
    closing = true;
    try {
      worker?.postMessage({ type: 'close' });
    } catch {
      /* ignore */
    }
    setTimeout(() => worker?.terminate().catch(() => {}), 500).unref?.();
    worker = null;
    initInfo = null;
  }

  return {
    init,
    grab,
    close,
    get info() {
      return initInfo;
    },
  };
}
