import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encode, readJpegSize } from './jpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.resolve(here, '../../native');

/**
 * Capture drivers all expose:
 *   type      - driver name
 *   size()    - { width, height } of the captured screen
 *   grab()    - Promise<{ data, width, height, mime }>
 *   close()
 *
 * Selection order (CAPTURE_DRIVER=auto): screenshot-desktop -> powershell -> synthetic.
 */
export async function createCaptureDriver(config) {
  const wanted = config.captureDriver || 'auto';
  const autoOrder = ['robotjs', 'screenshot-desktop', 'powershell', 'synthetic'];
  const attempts = {
    auto: autoOrder,
    robotjs: ['robotjs', 'synthetic'],
    'screenshot-desktop': ['screenshot-desktop', 'synthetic'],
    powershell: ['powershell', 'synthetic'],
    synthetic: ['synthetic'],
  }[wanted] || autoOrder;

  const failures = [];
  for (const name of attempts) {
    try {
      if (name === 'robotjs') return await createRobotCapture();
      if (name === 'screenshot-desktop') return await createScreenshotDesktop();
      if (name === 'powershell') return await createPowerShellCapture();
      if (name === 'synthetic') return createSynthetic();
    } catch (err) {
      failures.push(`${name}: ${err.message || err}`);
    }
  }
  throw new Error(`no capture driver available (${failures.join('; ')})`);
}

/* ----------------------------------------------------------------- robotjs */

/**
 * robotjs gives raw pixels straight from the OS - no temp files, no child
 * processes per frame. The channel order (BGRA vs RGBA) is probed once at
 * startup instead of assumed, so it stays correct across platforms.
 */
async function createRobotCapture() {
  const robot = (await import('robotjs')).default;
  if (!robot?.screen?.capture || !robot?.getScreenSize) {
    throw new Error('module not loadable');
  }
  const size = robot.getScreenSize();
  if (!size?.width || !size?.height) throw new Error('no screen size');

  const bgra = await detectChannelOrder(robot);
  return {
    type: 'robotjs',
    size: async () => ({ width: size.width, height: size.height }),
    async grab() {
      const bmp = robot.screen.capture(0, 0, size.width, size.height);
      if (!bmp?.image) throw new Error('empty capture');
      return { raw: bmp.image, width: bmp.width, height: bmp.height, bgra };
    },
    close() {},
  };
}

/** Compare raw bytes against robotjs' own colorAt() to learn the layout. */
async function detectChannelOrder(robot) {
  const fallback = process.platform === 'darwin' ? false : true;
  try {
    const probe = robot.screen.capture(0, 0, 300, 300);
    if (!probe?.image) return fallback;
    let bgraVotes = 0;
    let rgbaVotes = 0;
    for (let y = 0; y < 300 && bgraVotes + rgbaVotes < 30; y += 11) {
      for (let x = 0; x < 300 && bgraVotes + rgbaVotes < 30; x += 11) {
        const hex = String(probe.colorAt(x, y)).replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if (!Number.isFinite(r) || !Number.isFinite(b) || r === b) continue;
        const i = (y * probe.width + x) * 4;
        if (probe.image[i] === r && probe.image[i + 2] === b) rgbaVotes += 1;
        else if (probe.image[i] === b && probe.image[i + 2] === r) bgraVotes += 1;
      }
    }
    if (bgraVotes === rgbaVotes) return fallback;
    return bgraVotes > rgbaVotes;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------- screenshot-desktop */

async function createScreenshotDesktop() {
  const mod = await import('screenshot-desktop');
  const screenshot = mod.default;
  if (typeof screenshot !== 'function') throw new Error('module not loadable');
  const displays = await screenshot.listDisplays();
  if (!displays?.length) throw new Error('no displays reported');
  const primary = displays.find((d) => d.id === displays[0].id) || displays[0];

  let size = { width: 0, height: 0 };
  return {
    type: 'screenshot-desktop',
    async size() {
      if (!size.width) await this.grab();
      return size;
    },
    async grab() {
      const data = await screenshot({ screen: primary.id, format: 'jpg' });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const dims = readJpegSize(buf);
      if (dims) size = dims;
      return { data: buf, width: size.width, height: size.height, mime: 'image/jpeg' };
    },
    close() {},
  };
}

/* ------------------------------------------------------------ powershell */

async function createPowerShellCapture() {
  if (process.platform !== 'win32') throw new Error('powershell driver is Windows-only');
  const script = path.join(NATIVE_DIR, 'win-capture.ps1');
  if (!fs.existsSync(script)) throw new Error('win-capture.ps1 missing');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.on('error', (err) => {
    stderr = `${err.message}`;
  });

  const pending = [];
  let size = { width: 0, height: 0 };
  let ready = false;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.startsWith('READY ')) {
      const [, w, h] = line.split(' ');
      size = { width: Number(w), height: Number(h) };
      ready = true;
      return;
    }
    if (line.startsWith('FRAME ')) {
      const firstSpace = line.indexOf(' ');
      const secondSpace = line.indexOf(' ', firstSpace + 1);
      const thirdSpace = line.indexOf(' ', secondSpace + 1);
      const width = Number(line.slice(firstSpace + 1, secondSpace));
      const height = Number(line.slice(secondSpace + 1, thirdSpace));
      const data = Buffer.from(line.slice(thirdSpace + 1), 'base64');
      pending.shift()?.resolve({ data, width, height, mime: 'image/jpeg' });
      return;
    }
    if (line.startsWith('ERR ')) {
      pending.shift()?.reject(new Error(line.slice(4)));
    }
  });

  const deadline = Date.now() + 8000;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) {
    child.kill();
    throw new Error(`powershell capture did not start: ${stderr || 'timeout'}`);
  }

  return {
    type: 'powershell',
    size: async () => size,
    grab() {
      if (child.exitCode !== null) {
        return Promise.reject(new Error(`capture process exited: ${stderr}`));
      }
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write('CAP\n');
        setTimeout(() => {
          if (pending[0]?.resolve === resolve) {
            pending.shift();
            reject(new Error('capture timeout'));
          }
        }, 5000);
      });
    },
    close() {
      try {
        child.stdin.write('QUIT\n');
      } catch {}
      child.kill();
    },
  };
}

/* -------------------------------------------------------------- synthetic */

/**
 * Fully dependency-free demo frame source: a gradient test card with a moving
 * marker, used when no real screen capture is available (CI, headless, or an
 * unsupported platform).
 */
function createSynthetic() {
  const width = 960;
  const height = 540;
  let frame = 0;
  return {
    type: 'synthetic',
    size: async () => ({ width, height }),
    async grab() {
      frame += 1;
      const rgba = new Uint8Array(width * height * 4);
      const markerX = Math.floor((Math.sin(frame / 12) * 0.5 + 0.5) * (width - 60));
      const markerY = Math.floor((Math.cos(frame / 9) * 0.5 + 0.5) * (height - 60));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          rgba[i] = (x * 255) / width;
          rgba[i + 1] = (y * 255) / height;
          rgba[i + 2] = 96;
          rgba[i + 3] = 255;
        }
      }
      // moving block + frame counter stripes so motion is obvious
      for (let y = markerY; y < Math.min(height, markerY + 60); y++) {
        for (let x = markerX; x < Math.min(width, markerX + 60); x++) {
          const i = (y * width + x) * 4;
          rgba[i] = 255;
          rgba[i + 1] = 240;
          rgba[i + 2] = 60;
        }
      }
      const barWidth = 40 + (frame % 8) * 8;
      for (let y = height - 40; y < height - 20; y++) {
        for (let x = 20; x < 20 + barWidth; x++) {
          const i = (y * width + x) * 4;
          rgba[i] = 20;
          rgba[i + 1] = 255;
          rgba[i + 2] = 140;
        }
      }
      const data = encode(rgba, width, height, 60);
      return { data, width, height, mime: 'image/jpeg' };
    },
    close() {},
  };
}
