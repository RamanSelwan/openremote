import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { escapeSendKeys, keyEventToOps } from './keyboard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.resolve(here, '../../native');

// Indexed by DOM MouseEvent.button: 0=left, 1=middle, 2=right.
const BUTTONS = ['left', 'middle', 'right'];

/**
 * Input drivers expose:
 *   type
 *   move(x, y)                 absolute physical pixels
 *   button(name, down)
 *   wheel(delta)                positive = scroll up
 *   key(vk, down)               Windows virtual-key code
 *   text(str)
 *   setClipboard(str)
 *   close()
 *
 * Selection order (INPUT_DRIVER=auto): robotjs -> powershell (win32) -> dry-run.
 */
export async function createInputDriver(config) {
  const wanted = config.inputDriver || 'auto';
  const attempts = {
    auto: ['robotjs', 'powershell', 'dry-run'],
    robotjs: ['robotjs', 'dry-run'],
    powershell: ['powershell', 'dry-run'],
    'dry-run': ['dry-run'],
  }[wanted] || ['robotjs', 'powershell', 'dry-run'];

  const failures = [];
  for (const name of attempts) {
    try {
      if (name === 'robotjs') return await createRobotDriver();
      if (name === 'powershell') return await createPowerShellDriver();
      if (name === 'dry-run') return createDryRun();
    } catch (err) {
      failures.push(`${name}: ${err.message || err}`);
    }
  }
  throw new Error(`no input driver available (${failures.join('; ')})`);
}

/* ---------------------------------------------------------------- robotjs */

async function createRobotDriver() {
  const robot = (await import('robotjs')).default;
  if (!robot?.moveMouse) throw new Error('module not loadable');

  const VK_NAMES = {
    0x08: 'backspace',
    0x09: 'tab',
    0x0d: 'enter',
    0x10: 'shift',
    0x11: 'control',
    0x12: 'alt',
    0x13: 'pause',
    0x14: 'capslock',
    0x1b: 'escape',
    0x20: 'space',
    0x21: 'pageup',
    0x22: 'pagedown',
    0x23: 'end',
    0x24: 'home',
    0x25: 'left',
    0x26: 'up',
    0x27: 'right',
    0x28: 'down',
    0x2c: 'printscreen',
    0x2d: 'insert',
    0x2e: 'delete',
    0x5b: 'command',
    0x5c: 'command',
    0x5d: 'menu',
    0x90: 'numlock',
    0x91: 'scrolllock',
    0xbd: '-',
    0xbb: '=',
    0xdb: '[',
    0xdd: ']',
    0xdc: '\\',
    0xba: ';',
    0xde: "'",
    0xbc: ',',
    0xbe: '.',
    0xbf: '/',
    0xc0: '`',
  };
  const nameFor = (vk) => {
    if (VK_NAMES[vk]) return VK_NAMES[vk];
    if (vk >= 0x70 && vk <= 0x7b) return `f${vk - 0x6f}`;
    return String.fromCharCode(vk).toLowerCase();
  };

  return {
    type: 'robotjs',
    move: (x, y) => robot.moveMouse(Math.round(x), Math.round(y)),
    button: (name, down) => {
      const btn = BUTTONS.includes(name) ? name : 'left';
      // robotjs 0.9 exposes mouseToggle(down, button); older builds used
      // mouseDown/mouseUp - support both.
      if (typeof robot.mouseToggle === 'function') {
        robot.mouseToggle(down ? 'down' : 'up', btn);
      } else if (down) {
        robot.mouseDown(btn);
      } else {
        robot.mouseUp(btn);
      }
    },
    wheel: (delta) => robot.scrollMouse(Math.max(1, Math.round(Math.abs(delta))), delta > 0 ? 'up' : 'down'),
    key: (vk, down) => {
      const name = nameFor(vk);
      // Same story: keyToggle(key, down) on 0.9, keyDown/keyUp on older builds.
      if (typeof robot.keyToggle === 'function') {
        robot.keyToggle(name, down ? 'down' : 'up');
      } else if (down) {
        robot.keyDown(name);
      } else {
        robot.keyUp(name);
      }
    },
    text: (str) => robot.typeString(str),
    setClipboard: () => {
      throw new Error('clipboard not supported by robotjs driver');
    },
    close: () => {},
  };
}

/* -------------------------------------------------------------- powershell */

async function createPowerShellDriver() {
  if (process.platform !== 'win32') throw new Error('powershell driver is Windows-only');
  const script = path.join(NATIVE_DIR, 'win-input.ps1');
  if (!fs.existsSync(script)) throw new Error('win-input.ps1 missing');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr = (stderr + c.toString()).slice(-2000);
  });

  const pending = [];
  let ready = false;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line === 'READY') {
      ready = true;
      return;
    }
    const waiter = pending.shift();
    if (!waiter) return;
    if (line === 'OK' || line === 'PONG' || line === 'BYE') waiter.resolve(line);
    else waiter.reject(new Error(line));
  });

  const waitReady = (async () => {
    const deadline = Date.now() + 8000;
    while (!ready && child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) throw new Error(`input bridge did not start: ${stderr || 'timeout'}`);
  })();

  const send = (line) =>
    new Promise((resolve, reject) => {
      if (child.exitCode !== null) return reject(new Error(`bridge exited: ${stderr}`));
      pending.push({ resolve, reject });
      child.stdin.write(`${line}\n`);
      return undefined;
    });

  await waitReady;
  await send('PING'); // smoke-test the round trip

  return {
    type: 'powershell',
    move: (x, y) => void send(`MOVE ${Math.round(x)} ${Math.round(y)}`).catch(() => {}),
    button: (name, down) =>
      void send(`BTN ${BUTTONS.includes(name) ? name : 'left'} ${down ? 'down' : 'up'}`).catch(() => {}),
    wheel: (delta) =>
      void send(`WHEEL ${Math.round(Math.max(-1200, Math.min(1200, delta * 120)))}`).catch(() => {}),
    key: (vk, down) => void send(`KEY ${vk} ${down ? 'down' : 'up'}`).catch(() => {}),
    text: (str) => void send(`TEXT ${escapeSendKeys(str)}`).catch(() => {}),
    setClipboard: (str) =>
      void send(`CLIP ${Buffer.from(String(str), 'utf8').toString('base64')}`).catch(() => {}),
    close: () => {
      try {
        child.stdin.write('QUIT\n');
      } catch {}
      setTimeout(() => child.kill(), 200).unref?.();
    },
  };
}

/* ----------------------------------------------------------------- dry-run */

/** Logs every action instead of touching the OS (headless / unsupported OS). */
function createDryRun() {
  let last = '';
  const log = (line) => {
    if (line === last) return;
    last = line;
    console.log(`[input:dry-run] ${line}`);
  };
  return {
    type: 'dry-run',
    move: (x, y) => log(`move ${Math.round(x)},${Math.round(y)}`),
    button: (name, down) => log(`${down ? 'down' : 'up'} ${name}`),
    wheel: (delta) => log(`wheel ${Math.round(delta)}`),
    key: (vk, down) => log(`${down ? 'key-down' : 'key-up'} 0x${vk.toString(16)}`),
    text: (str) => log(`text "${str}"`),
    setClipboard: (str) => log(`clipboard <- "${String(str).slice(0, 60)}"`),
    close: () => {},
  };
}

/* --------------------------------------------------------------- dispatcher */

/**
 * Applies one normalized input event from the viewer.
 * Coordinates arrive normalized (0..1) and are mapped onto the real screen.
 *
 * Payload shapes:
 *   {type:'mousemove'|'mousedown'|'mouseup', x, y, button}
 *   {type:'wheel', x, y, deltaX, deltaY}
 *   {type:'keydown'|'keyup', key, code, ctrlKey, altKey, shiftKey, metaKey}
 *   {type:'text', text}   {type:'clipboard', text}   {type:'ping'}
 */
export function dispatchInput(driver, payload, display, onPong) {
  if (!payload || !driver) return;
  const { width, height } = display || {};
  const px = (v) => Math.round((Number(v) || 0) * (width || 0));
  const py = (v) => Math.round((Number(v) || 0) * (height || 0));

  switch (payload.type) {
    case 'mousemove':
      if (width && height) driver.move(px(payload.x), py(payload.y));
      return;
    case 'mousedown':
    case 'mouseup': {
      if (width && height) driver.move(px(payload.x), py(payload.y));
      const btn = BUTTONS[payload.button] || 'left';
      driver.button(btn, payload.type === 'mousedown');
      return;
    }
    case 'dblclick':
      driver.button('left', true);
      driver.button('left', false);
      driver.button('left', true);
      driver.button('left', false);
      return;
    case 'wheel':
      driver.wheel(-(payload.deltaY || 0) / 100);
      return;
    case 'keydown':
    case 'keyup': {
      const ops = keyEventToOps(payload, payload.type === 'keydown');
      for (const op of ops) {
        if (op.type === 'key') driver.key(op.vk, op.down);
        else if (op.type === 'text') driver.text(op.text);
      }
      return;
    }
    case 'text':
      driver.text(String(payload.text || ''));
      return;
    case 'clipboard':
      try {
        driver.setClipboard(String(payload.text || ''));
      } catch (err) {
        console.warn(`[input] clipboard unsupported: ${err.message}`);
      }
      return;
    case 'ping':
      onPong?.();
      return;
    default:
      return;
  }
}
