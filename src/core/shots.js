// Screenshots: the key that takes one, the file names, and where each game's pictures live.
// Shared with the window (renderer/index.html loads this file too), so it has no Node-only code.
'use strict';
(function () {
const DEFAULT_KEY = 'F8';

// KeyboardEvent.code -> the name Electron's global shortcut wants
const NAMED = {
  Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock', Pause: 'Pause', NumLock: 'Numlock', CapsLock: 'Capslock',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/**
 * A key press -> an accelerator like "F8" or "Shift+F9". Returns null for a press that is only a modifier,
 * or for a key that can't be a shortcut (Escape is reserved: it cancels the picker).
 */
function accelFromEvent(e) {
  const code = String(e.code || '');
  if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === 'Escape') return null;
  let key = null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
  else if (NAMED[code]) key = NAMED[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

/** "Control+Shift+F9" -> "Ctrl + Shift + F9" for display. */
function prettyAccel(a) {
  return String(a || '').split('+').map((p) => ({ Control: 'Ctrl', Super: 'Win/Cmd', Scrolllock: 'Scroll Lock', Capslock: 'Caps Lock', Numlock: 'Num Lock', PrintScreen: 'Print Screen', Return: 'Enter' }[p] || p)).join(' + ');
}

const two = (n) => String(n).padStart(2, '0');

/** "Zelda 64 Recomp 2026-10-31 21-36-05.png": safe on every file system. */
function fileName(title, date = new Date()) {
  const base = String(title || 'Screenshot').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Screenshot';
  const d = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`;
  return `${base} ${d}.png`;
}

/** The window that belongs to a game: a window whose title mentions the game or its exe. null when none fits. */
function pickWindow(sources, names) {
  const wants = (names || []).map((n) => String(n || '').toLowerCase().trim()).filter((n) => n.length >= 3);
  let best = null;
  for (const s of sources || []) {
    const t = String(s.name || '').toLowerCase();
    if (!t || t === 'fulton' || t.startsWith('fulton ')) continue; // never Fulton's own window
    for (const w of wants) {
      if (t.includes(w) && (!best || w.length > best.len)) best = { s, len: w.length };
    }
  }
  return best ? best.s : null;
}

const api = { DEFAULT_KEY, accelFromEvent, prettyAccel, fileName, pickWindow };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.cartShots = api;
})();
