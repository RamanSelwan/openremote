/**
 * Maps DOM keyboard events coming from the browser viewer to low level
 * operations the input drivers understand:
 *   { type: 'key',   vk, down }   - Windows virtual-key code press/release
 *   { type: 'text',  text }       - literal text (SendKeys-escaped)
 *
 * Assumption: US keyboard layout for punctuation (documented limitation).
 */

const NAMED = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  ' ': 0x20,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  CapsLock: 0x14,
  NumLock: 0x90,
  ScrollLock: 0x91,
  Pause: 0x13,
  ContextMenu: 0x5d,
};

// Unshifted character -> key that produces it on a US layout.
const PUNCT = {
  '-': 0xbd,
  '=': 0xbb,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  ';': 0xba,
  "'": 0xde,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '!': 0x31,
  '@': 0x32,
  '#': 0x33,
  $: 0x34,
  '%': 0x35,
  '^': 0x36,
  '&': 0x37,
  '*': 0x38,
  '(': 0x39,
  ')': 0x30,
  _: 0xbd,
  '+': 0xbb,
  '{': 0xdb,
  '}': 0xdd,
  '|': 0xdc,
  ':': 0xba,
  '"': 0xde,
  '<': 0xbc,
  '>': 0xbe,
  '?': 0xbf,
  '~': 0xc0,
};

const SHIFTED = new Set('!@#$%^&*()_+{}|:"<>?~');

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

/** Key codes coming from `code` as a fallback when `key` is unmapped. */
function codeToVk(code) {
  if (!code) return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Digit(\d)$/.exec(code);
  if (m) return 0x30 + Number(m[1]);
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 0x60 + Number(m[1]);
  m = /^F(\d{1,2})$/.exec(code);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 24) return 0x6f + n;
  }
  const named = {
    Minus: 0xbd,
    Equal: 0xbb,
    BracketLeft: 0xdb,
    BracketRight: 0xdd,
    Backslash: 0xdc,
    Semicolon: 0xba,
    Quote: 0xde,
    Comma: 0xbc,
    Period: 0xbe,
    Slash: 0xbf,
    Backquote: 0xc0,
    ShiftLeft: VK_SHIFT,
    ShiftRight: VK_SHIFT,
    ControlLeft: VK_CONTROL,
    ControlRight: VK_CONTROL,
    AltLeft: VK_MENU,
    AltRight: VK_MENU,
    MetaLeft: VK_LWIN,
    MetaRight: VK_RWIN,
    NumpadEnter: 0x0d,
    NumLock: 0x90,
    CapsLock: 0x14,
    ScrollLock: 0x91,
    PrintScreen: 0x2c,
    Pause: 0x13,
    ContextMenu: 0x5d,
  };
  return named[code] ?? null;
}

/**
 * Convert one DOM key event (already normalised by the viewer) into ops.
 * @param {{key:string, code:string, ctrlKey:boolean, altKey:boolean,
 *          shiftKey:boolean, metaKey:boolean}} evt
 * @param {boolean} down
 */
export function keyEventToOps(evt, down) {
  const key = evt.key ?? '';

  // Modifier keys are forwarded as-is so the OS sees real held modifiers.
  if (key === 'Shift') return [{ type: 'key', vk: VK_SHIFT, down }];
  if (key === 'Control') return [{ type: 'key', vk: VK_CONTROL, down }];
  if (key === 'Alt') return [{ type: 'key', vk: VK_MENU, down }];
  if (key === 'Meta' || key === 'OS') {
    return [{ type: 'key', vk: evt.code === 'MetaRight' ? VK_RWIN : VK_LWIN, down }];
  }
  if (key === 'Dead' || key === 'Unidentified') return [];

  if (key in NAMED) {
    return [{ type: 'key', vk: NAMED[key], down }];
  }

  if (key.length === 1) {
    if (key === ' ') return [{ type: 'key', vk: 0x20, down }];
    const vk = PUNCT[key] ?? PUNCT[key.toLowerCase()] ?? codeToVk(evt.code);
    if (vk == null) return [];
    const needsShift = SHIFTED.has(key) && !evt.shiftKey;
    if (needsShift) {
      // Latch shift around the key so shifted symbols come out right.
      const shiftOp = { type: 'key', vk: VK_SHIFT, down };
      const keyOp = { type: 'key', vk, down };
      return down ? [shiftOp, keyOp] : [keyOp, shiftOp];
    }
    return [{ type: 'key', vk, down }];
  }

  // F1..F12 and friends
  const vk = codeToVk(evt.code);
  return vk == null ? [] : [{ type: 'key', vk, down }];
}

/**
 * SendKeys escaping so literal text can be typed safely.
 * https://learn.microsoft.com/dotnet/api/system.windows.forms.sendkeys
 */
export function escapeSendKeys(text) {
  const meta = { '+': '{+}', '^': '{^}', '%': '{%}', '(': '{(}', ')': '{)}', '~': '{~}' };
  let out = '';
  for (const ch of String(text)) {
    if (ch === '{' || ch === '}') out += `{${ch}}`;
    else out += meta[ch] ?? ch;
  }
  return out;
}
