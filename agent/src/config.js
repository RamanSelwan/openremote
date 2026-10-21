import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(AGENT_ROOT, 'data');
export const CREDS_FILE = path.join(DATA_DIR, 'device.json');
export const AGENT_VERSION = '0.2.0';

const argv = process.argv.slice(2);

function argValue(name) {
  const eq = argv.indexOf(`--${name}`);
  if (eq !== -1 && argv[eq + 1] && !argv[eq + 1].startsWith('--')) return argv[eq + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return undefined;
}

const num = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function loadConfig() {
  return {
    serverUrl: (process.env.SERVER_URL || argValue('server') || 'http://localhost:5000').replace(
      /\/+$/,
      ''
    ),
    name: process.env.DEVICE_NAME || argValue('name') || os.hostname(),
    accessMode: process.env.ACCESS_MODE === 'open' ? 'open' : 'approve',
    autoAccept: (process.env.AUTO_ACCEPT ?? '1') !== '0',
    allowControl: (process.env.ALLOW_CONTROL ?? '1') !== '0',
    fps: num(process.env.FPS, 15, 1, 30),
    scale: num(process.env.SCALE, 0.65, 0.2, 1),
    quality: num(process.env.QUALITY, 55, 20, 90),
    captureDriver: process.env.CAPTURE_DRIVER || 'auto',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffmpegInput: process.env.FFMPEG_INPUT || 'auto',
    ffmpegEncoder: process.env.FFMPEG_ENCODER || 'auto',
    inputDriver: process.env.INPUT_DRIVER || 'auto',
    enrollCode: process.env.ENROLL_CODE || argValue('code'),
    wantsEnroll: argv.includes('--enroll'),
    headless: argv.includes('--headless') || process.env.AGENT_HEADLESS === '1',
  };
}

export function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCreds(creds) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
