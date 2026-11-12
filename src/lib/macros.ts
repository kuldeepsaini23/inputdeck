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

/** Why a step can't be stored in `format` (undefined when it can). */
export function stepProblem(s: MacroStep, format: MacroFormat): string | undefined {
  switch (s.t) {
    case 'tap':
    case 'down':
    case 'up':
      return Number.isInteger(s.kc) && s.kc >= 1 && s.kc <= 0xff ? undefined : `key 0x${(s.kc >>> 0).toString(16)} can't go in a macro`;
    case 'delay':
      if (format !== 'qmk') return "this keyboard's firmware can't store delays";
      return Number.isInteger(s.ms) && s.ms >= 0 && s.ms <= MAX_DELAY ? undefined : `delay must be 0-${MAX_DELAY} ms`;
    case 'text':
      for (let i = 0; i < s.text.length; i++) {
        if (!textCharOk(s.text.charCodeAt(i))) return `“${s.text[i]}” can't be typed by a macro (plain ASCII only)`;
      }
      return undefined;
    default:
      return 'unknown step';
  }
}

/** Bytes of one macro (without its NUL). Throws on steps the format can't hold. */
export function encodeMacro(steps: MacroStep[], format: MacroFormat): number[] {
  const out: number[] = [];
  const pre = format === 'qmk' ? [SS_PREFIX] : [];
  for (const s of steps) {
    const bad = stepProblem(s, format);
    if (bad) throw new Error(bad);
    if (s.t === 'delay') out.push(SS_PREFIX, SS_DELAY, ...[...String(s.ms)].map((c) => c.charCodeAt(0)), DELAY_END);
    else if (s.t === 'text') for (let i = 0; i < s.text.length; i++) out.push(s.text.charCodeAt(i));
    else out.push(...pre, ACTION[s.t], s.kc);
  }
  return out;
}

/** Steps of one macro's bytes (without NUL). Unknown action codes are skipped like QMK does. */
export function decodeMacro(b: ArrayLike<number>, format: MacroFormat): MacroStep[] {
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

/** Bytes one macro takes, including its NUL (undefined if it can't be stored). */
export function macroSize(steps: MacroStep[], format: MacroFormat): number | undefined {
  try {
    return encodeMacro(steps, format).length + 1;
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

/** Does this value fit the device (every step storable, total within maxBytes)? */
export function fits(v: Macros): boolean {
  if (!v.format) return true;
  const n = usedBytes(v);
  return n !== undefined && (v.maxBytes === undefined || n <= v.maxBytes);
}

const keyName = (kc: number) => kcLabel(kc, 'qmk-v2') || `0x${kc.toString(16)}`;

/** Short chip text for a step. */
export function stepText(s: MacroStep): string {
  switch (s.t) {
    case 'tap':
      return keyName(s.kc);
    case 'down':
      return `↓ ${keyName(s.kc)}`;
    case 'up':
      return `↑ ${keyName(s.kc)}`;
    case 'delay':
      return `${s.ms} ms`;
    case 'text':
      return `“${s.text.replace(/\n/g, '⏎').replace(/\t/g, '⇥')}”`;
  }
}

/** One-line preview of a macro for the slot list. */
export function macroSummary(steps: MacroStep[], max = 32): string {
  if (!steps.length) return 'Empty';
  const t = steps.filter((s) => s.t !== 'up').map(stepText).join(' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
