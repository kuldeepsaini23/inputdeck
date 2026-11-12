// Keyboard macros: the QMK dynamic-macro byte format, byte counting, and recording helpers.
// UI-free so drivers and tests can use it.
//
// QMK format (quantum/dynamic_keymap.c + quantum/send_string/send_string.c, the-via/app
// src/utils/macro-api/macro-api.v11.ts): every macro is a send_string string ending in NUL.
//   SS_QMK_PREFIX 0x01, then 0x01 tap / 0x02 down / 0x03 up + one keycode byte,
//   or 0x04 delay + ASCII digits + '|'; any other byte is typed as an ASCII character.
// Before VIA protocol 11 ('qmk-legacy') there is no prefix: 0x01/0x02/0x03 + keycode, no delays.
// QMK only stores 8-bit (basic) keycodes in macros; send_string has no 16-bit key action.

import type { MacroFormat, MacroStep, Value } from '../drivers/types';
import { label as kcLabel } from './keycodes';

export type { MacroFormat, MacroStep };
export type Macros = Extract<Value, { kind: 'macros' }>;

export const SS_PREFIX = 0x01;
export const SS_TAP = 0x01;
export const SS_DOWN = 0x02;
export const SS_UP = 0x03;
export const SS_DELAY = 0x04;
export const DELAY_END = 0x7c; // '|'
/** VIA allows at most 4 digits per delay. */
export const MAX_DELAY = 9999;

const ACTION: Record<'tap' | 'down' | 'up', number> = { tap: SS_TAP, down: SS_DOWN, up: SS_UP };
const BY_ACTION: Record<number, 'tap' | 'down' | 'up'> = { [SS_TAP]: 'tap', [SS_DOWN]: 'down', [SS_UP]: 'up' };

/** Characters a text step may hold (typed with a US layout): printable ASCII, Tab, Enter. */
export const textCharOk = (c: number) => c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e);

/** Mouse macro formats (WLMouse / Pulsar): keys, mouse buttons, wheel, delays; no text. */
export const isMouseFormat = (f: MacroFormat | undefined) => f === 'wlmouse' || f === 'pulsar';
/** Longest delay a mouse macro step can hold (both store 16-bit milliseconds). */
export const MOUSE_MAX_DELAY = 65535;
export const MOUSE_BUTTONS = ['Left', 'Right', 'Middle', 'Back', 'Forward'];

/** Can `kc` go in a macro of this format? Mice take HID keyboard usages A…F24…Menu and modifiers. */
export function keyOk(kc: number, format: MacroFormat): boolean {
  if (!Number.isInteger(kc)) return false;
  if (isMouseFormat(format)) return (kc >= 0x04 && kc <= 0xa4) || (kc >= 0xe0 && kc <= 0xe7);
  return kc >= 1 && kc <= 0xff;
}

/** Why a step can't be stored in `format` (undefined when it can). */
export function stepProblem(s: MacroStep, format: MacroFormat): string | undefined {
  const mouse = isMouseFormat(format);
  switch (s.t) {
    case 'tap':
    case 'down':
    case 'up':
      return keyOk(s.kc, format) ? undefined : `key 0x${(s.kc >>> 0).toString(16)} can't go in a macro`;
    case 'mouse':
      if (!mouse) return "a keyboard macro can't press mouse buttons";
      return Number.isInteger(s.btn) && s.btn >= 1 && s.btn <= 5 && ['tap', 'down', 'up'].includes(s.a) ? undefined : 'unknown mouse button';
    case 'wheel':
      if (!mouse) return "a keyboard macro can't scroll";
      return s.dir === 1 || s.dir === -1 ? undefined : 'unknown scroll direction';
    case 'delay': {
      if (format === 'qmk-legacy') return "this keyboard's firmware can't store delays";
      const max = mouse ? MOUSE_MAX_DELAY : MAX_DELAY;
      return Number.isInteger(s.ms) && s.ms >= 0 && s.ms <= max ? undefined : `delay must be 0-${max} ms`;
    }
    case 'text':
      if (mouse) return "this mouse can't type text: add the keys instead";
      for (let i = 0; i < s.text.length; i++) {
        if (!textCharOk(s.text.charCodeAt(i))) return `“${s.text[i]}” can't be typed by a macro (plain ASCII only)`;
      }
      return undefined;
    default:
      return 'unknown step';
  }
}

/** Why a whole macro can't be stored in `format` (undefined when it can). */
export function macroProblem(steps: MacroStep[], format: MacroFormat): string | undefined {
  try {
    encodeMacro(steps, format);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------------------------------------------------------------------------------------------
// mouse formats

/** HID modifier usage (0xE0-0xE7) -> its bit in the modifier byte, or -1. */
const modBit = (kc: number) => (kc >= 0xe0 && kc <= 0xe7 ? kc - 0xe0 : -1);

type Ev = { kind: 'key'; down: boolean; kc: number } | { kind: 'mouse'; down: boolean; btn: number };

/** Key / button steps as press and release events (taps become a press then a release). */
function pressEvents(s: MacroStep): Ev[] {
  if (s.t === 'tap' || s.t === 'down' || s.t === 'up') {
    const d = { kind: 'key' as const, down: true, kc: s.kc };
    return s.t === 'tap' ? [d, { ...d, down: false }] : [{ ...d, down: s.t === 'down' }];
  }
  if (s.t === 'mouse') {
    const d = { kind: 'mouse' as const, down: true, btn: s.btn };
    return s.a === 'tap' ? [d, { ...d, down: false }] : [{ ...d, down: s.a === 'down' }];
  }
  return [];
}

/** Turn a press immediately followed by the release of the same key/button into one tap. */
function mergeTaps(steps: MacroStep[]): MacroStep[] {
  const out: MacroStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    if (a.t === 'down' && b?.t === 'up' && a.kc === b.kc) {
      out.push({ t: 'tap', kc: a.kc });
      i++;
    } else if (a.t === 'mouse' && a.a === 'down' && b?.t === 'mouse' && b.a === 'up' && a.btn === b.btn) {
      out.push({ t: 'mouse', a: 'tap', btn: a.btn });
      i++;
    } else out.push(a);
  }
  return out;
}

/**
 * WLMouse / CompX-A macro bytes (official web hub, functions MA / RA): a list of records
 *   02 kc / 03 kc       key press / release (HID usage)
 *   09 bit / 0A bit     modifier press / release (bit 1 LCtrl, 2 LShift, 4 LAlt, 8 LGUI, 0x10.. right)
 *   01 mask             mouse buttons now held (1 L, 2 R, 4 M, 8 back, 0x10 forward), absolute
 *   10 01 / 10 FF       wheel up / down
 *   20 ms | 21 msHi msLo  delay (8 / 16 bit; the hub also knows 22/23 for 24/32 bit)
 */
function encodeWl(steps: MacroStep[]): number[] {
  const out: number[] = [];
  let held = 0;
  for (const s of steps) {
    if (s.t === 'delay') {
      if (s.ms <= 0xff) out.push(0x20, s.ms);
      else out.push(0x21, s.ms >> 8, s.ms & 0xff);
    } else if (s.t === 'wheel') out.push(0x10, s.dir === 1 ? 0x01 : 0xff);
    else {
      for (const e of pressEvents(s)) {
        if (e.kind === 'key') {
          const m = modBit(e.kc);
          if (m >= 0) out.push(e.down ? 0x09 : 0x0a, 1 << m);
          else out.push(e.down ? 0x02 : 0x03, e.kc);
        } else {
          const bit = 1 << (e.btn - 1);
          held = e.down ? held | bit : held & ~bit;
          out.push(0x01, held);
        }
      }
    }
  }
  return out;
}

function decodeWl(b: ArrayLike<number>): MacroStep[] {
  const out: MacroStep[] = [];
  let held = 0;
  let i = 0;
  const bits = (m: number, f: (bit: number) => void) => {
    for (let k = 0; k < 8; k++) if (m & (1 << k)) f(k);
  };
  while (i < b.length) {
    const c = b[i];
    const n = c === 0x21 ? 3 : c === 0x22 ? 4 : c === 0x23 ? 5 : 2;
    if (i + n > b.length) break;
    const d = Array.from({ length: n - 1 }, (_, k) => b[i + 1 + k]);
    i += n;
    switch (c) {
      case 0x02: out.push({ t: 'down', kc: d[0] }); break;
      case 0x03: out.push({ t: 'up', kc: d[0] }); break;
      case 0x09: bits(d[0], (k) => out.push({ t: 'down', kc: 0xe0 + k })); break;
      case 0x0a: bits(d[0], (k) => out.push({ t: 'up', kc: 0xe0 + k })); break;
      case 0x01: {
        const now = d[0] & 0x1f;
        bits(held & ~now, (k) => out.push({ t: 'mouse', a: 'up', btn: k + 1 }));
        bits(now & ~held, (k) => out.push({ t: 'mouse', a: 'down', btn: k + 1 }));
        held = now;
        break;
      }
      case 0x10: out.push({ t: 'wheel', dir: d[0] === 0x01 ? 1 : -1 }); break;
      case 0x20: case 0x21: case 0x22: case 0x23:
        out.push({ t: 'delay', ms: Math.min(MOUSE_MAX_DELAY, d.reduce((a, x) => a * 256 + x, 0)) });
        break;
      default:
        // unknown record: the official hub stops reading the macro here too
        return mergeTaps(out);
    }
  }
  return mergeTaps(out);
}

/** Pulsar: a tap is stored as press, PULSAR_TAP_MS, release (the web app's own default gap). */
export const PULSAR_TAP_MS = 10;
/** Pulsar keeps at most this many events per macro (web app: contexts.length < 70). */
export const PULSAR_MAX_EVENTS = 70;

/**
 * Pulsar / CompX-B macro events (Pulsar web app, functions la / gi), 5 bytes each:
 *   [status << 6 | type, valueLo, valueHi, delayHi, delayLo]   status 2 press, 1 release, 0 other
 *   type 0 modifier bits (as above), 1 key (HID usage), 4 mouse buttons (1 L, 2 R, 4 M, 8 back,
 *   0x10 forward), 6 wheel (value 1 up, 0xFF down). The delay is the wait AFTER the event.
 */
function encodePulsar(steps: MacroStep[]): number[] {
  const ev: { st: number; type: number; value: number; delay: number }[] = [];
  for (const s of steps) {
    if (s.t === 'delay') {
      const last = ev[ev.length - 1];
      if (!last) throw new Error("a macro can't start with a delay on this mouse");
      if (last.delay + s.ms > MOUSE_MAX_DELAY) throw new Error(`delays in a row may add up to ${MOUSE_MAX_DELAY} ms`);
      last.delay += s.ms;
    } else if (s.t === 'wheel') ev.push({ st: 0, type: 6, value: s.dir === 1 ? 0x01 : 0xff, delay: 0 });
    else {
      const es = pressEvents(s);
      es.forEach((e, k) => {
        const m = e.kind === 'key' ? modBit(e.kc) : -1;
        const type = e.kind === 'mouse' ? 4 : m >= 0 ? 0 : 1;
        const value = e.kind === 'mouse' ? 1 << (e.btn - 1) : m >= 0 ? 1 << m : e.kc;
        ev.push({ st: e.down ? 2 : 1, type, value, delay: es.length === 2 && k === 0 ? PULSAR_TAP_MS : 0 });
      });
    }
  }
  if (ev.length > PULSAR_MAX_EVENTS) throw new Error(`a macro holds at most ${PULSAR_MAX_EVENTS} presses/releases on this mouse`);
  return ev.flatMap((e) => [(e.st << 6) | e.type, e.value & 0xff, (e.value >> 8) & 0xff, (e.delay >> 8) & 0xff, e.delay & 0xff]);
}

function decodePulsar(b: ArrayLike<number>): MacroStep[] {
  const raw: MacroStep[] = [];
  /** index in raw of a press that was followed by exactly the tap gap */
  const tapGap = new Set<number>();
  for (let i = 0; i + 5 <= b.length; i += 5) {
    const st = b[i] >> 6;
    const type = b[i] & 0x0f;
    const value = b[i + 1] | (b[i + 2] << 8);
    const delay = (b[i + 3] << 8) | b[i + 4];
    const t = st === 2 ? 'down' : 'up';
    const before = raw.length;
    if (type === 0) for (let k = 0; k < 8; k++) value & (1 << k) && raw.push({ t, kc: 0xe0 + k });
    else if (type === 1) value >= 1 && value <= 0xff && raw.push({ t, kc: value });
    else if (type === 4) for (let k = 0; k < 5; k++) value & (1 << k) && raw.push({ t: 'mouse', a: t, btn: k + 1 });
    else if (type === 6) raw.push({ t: 'wheel', dir: (value & 0xff) === 0x01 ? 1 : -1 });
    // other types (mouse movement, menu key...) can't be shown and are left out
    if (raw.length === before) continue;
    if (st === 2 && delay === PULSAR_TAP_MS && raw.length === before + 1) tapGap.add(before);
    else if (delay > 0) raw.push({ t: 'delay', ms: delay });
  }
  // a press with the tap gap, then its release: one tap
  const out: MacroStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const b2 = raw[i + 1];
    const tap =
      tapGap.has(i) &&
      ((a.t === 'down' && b2?.t === 'up' && a.kc === b2.kc) ||
        (a.t === 'mouse' && b2?.t === 'mouse' && b2.a === 'up' && a.btn === b2.btn));
    if (tap) {
      out.push(a.t === 'mouse' ? { t: 'mouse', a: 'tap', btn: a.btn } : { t: 'tap', kc: (a as { kc: number }).kc });
      i++;
    } else {
      out.push(a);
      if (tapGap.has(i)) out.push({ t: 'delay', ms: PULSAR_TAP_MS });
    }
  }
  return out;
}

/** Bytes of one macro (without its NUL). Throws on steps the format can't hold. */
export function encodeMacro(steps: MacroStep[], format: MacroFormat): number[] {
  if (isMouseFormat(format)) {
    for (const s of steps) {
      const bad = stepProblem(s, format);
      if (bad) throw new Error(bad);
    }
    return format === 'wlmouse' ? encodeWl(steps) : encodePulsar(steps);
  }
  const out: number[] = [];
  const pre = format === 'qmk' ? [SS_PREFIX] : [];
  for (const s of steps) {
    const bad = stepProblem(s, format);
    if (bad) throw new Error(bad);
    if (s.t === 'delay') out.push(SS_PREFIX, SS_DELAY, ...[...String(s.ms)].map((c) => c.charCodeAt(0)), DELAY_END);
    else if (s.t === 'text') for (let i = 0; i < s.text.length; i++) out.push(s.text.charCodeAt(i));
    else if (s.t === 'tap' || s.t === 'down' || s.t === 'up') out.push(...pre, ACTION[s.t], s.kc);
  }
  return out;
}

/** Steps of one macro's bytes (without NUL). Unknown action codes are skipped like QMK does. */
export function decodeMacro(b: ArrayLike<number>, format: MacroFormat): MacroStep[] {
  if (format === 'wlmouse') return decodeWl(b);
  if (format === 'pulsar') return decodePulsar(b);
  const out: MacroStep[] = [];
  const text = (c: number) => {
    const last = out[out.length - 1];
    if (last?.t === 'text') last.text += String.fromCharCode(c);
    else out.push({ t: 'text', text: String.fromCharCode(c) });
  };
  let i = 0;
  while (i < b.length) {
    const c = b[i++];
    if (format === 'qmk-legacy') {
      if (BY_ACTION[c] && i < b.length) out.push({ t: BY_ACTION[c], kc: b[i++] });
      else if (!BY_ACTION[c]) text(c);
      continue;
    }
    if (c !== SS_PREFIX) {
      text(c);
      continue;
    }
    if (i >= b.length) break;
    const code = b[i++];
    if (BY_ACTION[code]) {
      if (i < b.length) out.push({ t: BY_ACTION[code], kc: b[i++] });
    } else if (code === SS_DELAY) {
      let ms = 0;
      while (i < b.length && b[i] >= 0x30 && b[i] <= 0x39) ms = ms * 10 + (b[i++] - 0x30);
      // send_string consumes the character that ends the number ('|')
      if (i < b.length) i++;
      out.push({ t: 'delay', ms });
    }
  }
  return out;
}

/** Split a macro buffer into `count` macros (raw bytes, NULs removed). Missing ones are empty. */
export function splitMacros(buf: ArrayLike<number>, count: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < buf.length && out.length < count; i++) {
    if (buf[i] === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(buf[i]);
  }
  while (out.length < count) out.push([]);
  return out;
}

export const decodeMacros = (buf: ArrayLike<number>, count: number, format: MacroFormat): MacroStep[][] =>
  splitMacros(buf, count).map((m) => decodeMacro(m, format));

/** The whole buffer content for these macros: each one followed by NUL. */
export function encodeMacros(macros: MacroStep[][], format: MacroFormat): number[] {
  return macros.flatMap((m) => [...encodeMacro(m, format), 0]);
}

/** Bytes one macro takes, including the NUL of QMK formats (undefined if it can't be stored). */
export function macroSize(steps: MacroStep[], format: MacroFormat): number | undefined {
  try {
    return encodeMacro(steps, format).length + (isMouseFormat(format) ? 0 : 1);
  } catch {
    return undefined;
  }
}

/** Bytes all macros use (undefined when the format is unknown or a step can't be stored). */
export function usedBytes(v: Macros): number | undefined {
  if (!v.format) return undefined;
  let n = 0;
  for (const m of v.macros) {
    const s = macroSize(m, v.format);
    if (s === undefined) return undefined;
    n += s;
  }
  return n;
}

/** Merge neighbouring text steps and drop empty ones (what a read back would give). */
export function normalize(steps: MacroStep[]): MacroStep[] {
  const out: MacroStep[] = [];
  for (const s of steps) {
    if (s.t === 'text') {
      if (!s.text) continue;
      const last = out[out.length - 1];
      if (last?.t === 'text') {
        out[out.length - 1] = { t: 'text', text: last.text + s.text };
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// recording (browser KeyboardEvent.code -> HID usage)

const CODE_TO_HID: Record<string, number> = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
  BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f,
  ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
  NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58, Numpad0: 0x62, NumpadDecimal: 0x63,
  IntlBackslash: 0x64, ContextMenu: 0x65, NumpadEqual: 0x67,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3, OSLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7, OSRight: 0xe7,
  AudioVolumeMute: 0xa8, AudioVolumeUp: 0xa9, AudioVolumeDown: 0xaa, MediaTrackNext: 0xab,
  MediaTrackPrevious: 0xac, MediaStop: 0xad, MediaPlayPause: 0xae,
};

/** HID usage for a KeyboardEvent.code ('KeyA' -> 0x04), undefined when it has none. */
export function hidFromCode(code: string): number | undefined {
  let m = code.match(/^Key([A-Z])$/);
  if (m) return 0x04 + m[1].charCodeAt(0) - 65;
  m = code.match(/^Digit([0-9])$/);
  if (m) return m[1] === '0' ? 0x27 : 0x1d + Number(m[1]);
  m = code.match(/^Numpad([1-9])$/);
  if (m) return 0x58 + Number(m[1]);
  m = code.match(/^F([0-9]{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) return 0x39 + n;
    if (n >= 13 && n <= 24) return 0x5b + n;
    return undefined;
  }
  return CODE_TO_HID[code];
}

export interface RecordedKey {
  type: 'down' | 'up';
  /** HID usage */
  kc: number;
  /** ms timestamp */
  at: number;
}

/** Pauses shorter than this aren't kept as delays; longer ones are rounded to 10 ms. */
export const MIN_RECORDED_DELAY = 30;

/**
 * Turn recorded key events into steps: a key pressed and released with nothing in between
 * becomes one tap; pauses between keys become delays (when `delays`), capped at `maxDelay`.
 * Releases of keys that weren't pressed while recording are dropped.
 */
export function stepsFromRecording(ev: RecordedKey[], o: { delays: boolean; maxDelay?: number }): MacroStep[] {
  const max = o.maxDelay ?? MAX_DELAY;
  const held = new Set<number>();
  const out: MacroStep[] = [];
  let lastAt: number | undefined;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type === 'down' && held.has(e.kc)) continue; // auto-repeat
    if (e.type === 'up' && !held.has(e.kc)) continue;
    if (o.delays && lastAt !== undefined && out.length) {
      const gap = Math.min(max, Math.round((e.at - lastAt) / 10) * 10);
      if (e.at - lastAt >= MIN_RECORDED_DELAY && gap > 0) out.push({ t: 'delay', ms: gap });
    }
    if (e.type === 'down') {
      held.add(e.kc);
      const next = ev.slice(i + 1).find((x) => !(x.type === 'down' && x.kc === e.kc));
      if (next && next.type === 'up' && next.kc === e.kc) {
        out.push({ t: 'tap', kc: e.kc });
        held.delete(e.kc);
        i = ev.indexOf(next);
        lastAt = next.at;
        continue;
      }
      out.push({ t: 'down', kc: e.kc });
    } else {
      held.delete(e.kc);
      out.push({ t: 'up', kc: e.kc });
    }
    lastAt = e.at;
  }
  // keys still held when recording stopped get released, so the macro never leaves one down
  for (const kc of held) out.push({ t: 'up', kc });
  return out;
}

// ---------------------------------------------------------------------------------------------
// editing

/** Steps with `add` inserted at index `at` (clamped). */
export function insertSteps(steps: MacroStep[], at: number, add: MacroStep[]): MacroStep[] {
  const i = Math.max(0, Math.min(steps.length, at));
  return [...steps.slice(0, i), ...add.map((s) => ({ ...s })), ...steps.slice(i)];
}

/** Steps with step i moved by `by` places (clamped to the ends). */
export function moveStep(steps: MacroStep[], i: number, by: number): MacroStep[] {
  if (i < 0 || i >= steps.length) return steps.slice();
  const j = Math.max(0, Math.min(steps.length - 1, i + by));
  const out = steps.slice();
  const [s] = out.splice(i, 1);
  out.splice(j, 0, s);
  return out;
}

export const removeStep = (steps: MacroStep[], i: number): MacroStep[] => steps.filter((_, k) => k !== i);

/** The macros value with slot `slot` replaced. */
export function withMacro(v: Macros, slot: number, steps: MacroStep[]): Macros {
  return { ...v, macros: v.macros.map((m, i) => (i === slot ? steps : m)) };
}

/** Does this value fit the device (every step storable, total within maxBytes, each macro within maxPerMacro)? */
export function fits(v: Macros): boolean {
  if (!v.format) return true;
  const n = usedBytes(v);
  if (n === undefined || (v.maxBytes !== undefined && n > v.maxBytes)) return false;
  const per = v.maxPerMacro;
  return per === undefined || v.macros.every((m) => (macroSize(m, v.format!) ?? Infinity) <= per);
}

/** Label of a macro slot ("M0", or the device's own slot name). */
export const slotName = (v: Macros, slot: number) => v.slotNames?.[slot] ?? `M${slot}`;

const keyName = (kc: number) => kcLabel(kc, 'qmk-v2') || `0x${kc.toString(16)}`;
const btnName = (btn: number) => `${MOUSE_BUTTONS[btn - 1] ?? `Button ${btn}`} click`;

/** Short chip text for a step. */
export function stepText(s: MacroStep): string {
  switch (s.t) {
    case 'tap':
      return keyName(s.kc);
    case 'down':
      return `↓ ${keyName(s.kc)}`;
    case 'up':
      return `↑ ${keyName(s.kc)}`;
    case 'mouse':
      return `${s.a === 'down' ? '↓ ' : s.a === 'up' ? '↑ ' : ''}${btnName(s.btn)}`;
    case 'wheel':
      return s.dir === 1 ? 'Scroll ↑' : 'Scroll ↓';
    case 'delay':
      return `${s.ms} ms`;
    case 'text':
      return `“${s.text.replace(/\n/g, '⏎').replace(/\t/g, '⇥')}”`;
  }
}

/** One-line preview of a macro for the slot list. */
export function macroSummary(steps: MacroStep[], max = 32): string {
  if (!steps.length) return 'Empty';
  const t = steps.filter((s) => s.t !== 'up' && !(s.t === 'mouse' && s.a === 'up')).map(stepText).join(' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
