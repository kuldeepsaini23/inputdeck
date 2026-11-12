// Wraith W75 V2 HE (magnetic / Hall-effect keyboard), VID 2E3C PID C365.
// Port of the desktop app's hardware-verified drivers/wraith.rs to WebHID.
//
// White-label "Online Keyboard Driver" protocol (wraith.software, also AULA, Machenike, ...).
// Interface: vendor usage page 0xFF1B usage 0x91, output/input report ID 1, 63 payload bytes.
// Frame (payload): [cmd, sub, page hi, page lo, len, data...]. Replies echo cmd in d0.
// No checksum, no explicit save command (writes apply immediately).
//
// ~280 boards share this VID/PID; the product field of command 0x0D tells them apart, so
// writable settings are only exposed for known product strings.
//
// NEVER send: 14 00 00 00 01 01 (factory reset), 21 ..18 06 (reset triggers),
// 21 ..18 07 / other 18 ops (calibration), 26 xx (deadband - read is also reset), 25/19/22/24
// writes, or anything firmware-related. `allowed()` enforces an allowlist on every packet.

import type { Driver, DriverFactory, KeyCap, Setting, Value } from './types';
import { sleep } from './types';

const VID = 0x2e3c;
const PID = 0xc365;
const USAGE_PAGE = 0xff1b;
const USAGE = 0x91;
const REPORT_ID = 1;
const PAYLOAD_LEN = 63;

/** Product field (0x0D reply, field 4) of boards whose writable settings we trust. */
const KNOWN: [product: string, model: string][] = [['W75HEARGB', 'W75 V2 HE']];

const POLLING: [string, number][] = [
  ['1000 Hz', 1],
  ['2000 Hz', 2],
  ['4000 Hz', 4],
  ['8000 Hz', 8],
];

const LIGHT_MODES: [number, string][] = [
  [0, 'Static'], [1, 'Breathing'], [2, 'Wave'], [3, 'Neon'], [4, 'Radar'],
  [6, 'Single-key'], [7, 'Aurora'], [8, 'Ripple'], [9, 'Stars'], [10, 'Custom (per-key)'],
  [11, 'Crosshair'], [12, 'Speed response'], [14, 'Auto ripple'],
  [15, 'Marquee'], [16, 'Fireworks'],
];

/** Rapid Trigger sensitivity choices, in hundredths of a mm. */
const RT_SENS = [2, 4, 6, 8, 10, 20, 30, 40, 50, 100];

/** Key indices (row * 22 + col) of every magnetic switch on the W75 (knob = 15 excluded). */
export const W75_KEYS: number[] = [
  0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 37,
  44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59,
  66, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 80, 81,
  88, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101, 102,
  110, 111, 112, 116, 120, 121, 122, 123, 124, 125,
];
/** Key whose trigger settings represent the "global" value (W). */
const REF_KEY = 46;

/**
 * Physical W75 layout, from the official web driver's `config/keys/W75HEARGB.json`
 * (35 px caps on a 38 px pitch), converted to key units and snapped to the usual 75% grid.
 * [index = row*22+col, label, x, y, width]; every cap is 1u high. The rotary knob (index 15,
 * not a switch) sits at x=15.25, y=0 and is deliberately not listed.
 */
const W75_LAYOUT: [number, string, number, number, number][] = [
  [0, 'Esc', 0.0, 0.0, 1.0], [2, 'F1', 1.25, 0.0, 1.0], [3, 'F2', 2.25, 0.0, 1.0], [4, 'F3', 3.25, 0.0, 1.0],
  [5, 'F4', 4.25, 0.0, 1.0], [6, 'F5', 5.5, 0.0, 1.0], [7, 'F6', 6.5, 0.0, 1.0], [8, 'F7', 7.5, 0.0, 1.0],
  [9, 'F8', 8.5, 0.0, 1.0], [10, 'F9', 9.75, 0.0, 1.0], [11, 'F10', 10.75, 0.0, 1.0], [12, 'F11', 11.75, 0.0, 1.0],
  [13, 'F12', 12.75, 0.0, 1.0], [14, 'Del', 14.0, 0.0, 1.0],
  [22, '`', 0.0, 1.25, 1.0], [23, '1', 1.0, 1.25, 1.0], [24, '2', 2.0, 1.25, 1.0], [25, '3', 3.0, 1.25, 1.0],
  [26, '4', 4.0, 1.25, 1.0], [27, '5', 5.0, 1.25, 1.0], [28, '6', 6.0, 1.25, 1.0], [29, '7', 7.0, 1.25, 1.0],
  [30, '8', 8.0, 1.25, 1.0], [31, '9', 9.0, 1.25, 1.0], [32, '0', 10.0, 1.25, 1.0], [33, '-', 11.0, 1.25, 1.0],
  [34, '=', 12.0, 1.25, 1.0], [36, 'Bksp', 13.0, 1.25, 2.0], [37, 'Home', 15.25, 1.25, 1.0],
  [44, 'Tab', 0.0, 2.25, 1.5], [45, 'Q', 1.5, 2.25, 1.0], [46, 'W', 2.5, 2.25, 1.0], [47, 'E', 3.5, 2.25, 1.0],
  [48, 'R', 4.5, 2.25, 1.0], [49, 'T', 5.5, 2.25, 1.0], [50, 'Y', 6.5, 2.25, 1.0], [51, 'U', 7.5, 2.25, 1.0],
  [52, 'I', 8.5, 2.25, 1.0], [53, 'O', 9.5, 2.25, 1.0], [54, 'P', 10.5, 2.25, 1.0], [55, '[', 11.5, 2.25, 1.0],
  [56, ']', 12.5, 2.25, 1.0], [58, '\\', 13.5, 2.25, 1.5], [59, 'PgUp', 15.25, 2.25, 1.0],
  [66, 'Caps', 0.0, 3.25, 1.75], [68, 'A', 1.75, 3.25, 1.0], [69, 'S', 2.75, 3.25, 1.0], [70, 'D', 3.75, 3.25, 1.0],
  [71, 'F', 4.75, 3.25, 1.0], [72, 'G', 5.75, 3.25, 1.0], [73, 'H', 6.75, 3.25, 1.0], [74, 'J', 7.75, 3.25, 1.0],
  [75, 'K', 8.75, 3.25, 1.0], [76, 'L', 9.75, 3.25, 1.0], [77, ';', 10.75, 3.25, 1.0], [78, "'", 11.75, 3.25, 1.0],
  [80, 'Enter', 12.75, 3.25, 2.25], [81, 'PgDn', 15.25, 3.25, 1.0],
  [88, 'Shift', 0.0, 4.25, 2.25], [90, 'Z', 2.25, 4.25, 1.0], [91, 'X', 3.25, 4.25, 1.0], [92, 'C', 4.25, 4.25, 1.0],
  [93, 'V', 5.25, 4.25, 1.0], [94, 'B', 6.25, 4.25, 1.0], [95, 'N', 7.25, 4.25, 1.0], [96, 'M', 8.25, 4.25, 1.0],
  [97, ',', 9.25, 4.25, 1.0], [98, '.', 10.25, 4.25, 1.0], [99, '/', 11.25, 4.25, 1.0],
  [101, 'Shift', 12.25, 4.25, 1.75], [102, 'Up', 14.25, 4.5, 1.0],
  [110, 'Ctrl', 0.0, 5.25, 1.25], [111, 'Win', 1.25, 5.25, 1.25], [112, 'Alt', 2.5, 5.25, 1.25],
  [116, 'Space', 3.75, 5.25, 6.25], [120, 'Alt', 10.0, 5.25, 1.0], [121, 'Fn', 11.0, 5.25, 1.0],
  [122, 'Ctrl', 12.0, 5.25, 1.0], [123, 'Left', 13.25, 5.5, 1.0], [124, 'Down', 14.25, 5.5, 1.0],
  [125, 'Right', 15.25, 5.5, 1.0],
];

/** The W75 layout as drawn by the UI (built once). */
export const W75_CAPS: KeyCap[] = W75_LAYOUT.map(([index, label, x, y, w]) => ({ index, label, x, y, w, h: 1 }));

/** Per-key colour table: 132 key slots (6 rows x 22 cols) x RGB. */
export const COLOR_TABLE = 132 * 3;
/** Colour table page size (bytes) and page count (7 x 54 + 18 = 396). */
export const COLOR_PAGE = 54;
export const COLOR_PAGES = Math.ceil(COLOR_TABLE / COLOR_PAGE);
/** Light mode that shows the per-key table. */
const MODE_CUSTOM = 10;

export const TRIG_FIXED = 0x00;
export const TRIG_RT = 0x0c;
export const TRIG_RT_SPLIT = 0x0d;

/** Timings (ms). Mutable only so tests can shorten them. */
export const wraithTiming = {
  /** wait for a reply to one request */
  reply: 600,
  /** wait for all pages of a colour table */
  colors: 800,
  /** pause after each fire-and-forget write */
  send: 20,
  /** pause between colour pages */
  page: 5,
  /** settle before reading back lighting / triggers */
  settle: 50,
  /** settle before reading back the polling rate */
  poll: 100,
};

export interface Light {
  mode: number;
  bri: number;
  speed: number;
  fg: [number, number, number];
  bg: [number, number, number];
  dir: number;
  fullColor: number;
  power: number;
}

/** One key's trigger settings in device units. */
export interface KeyTrig {
  mode: number;
  travel: number;
  press: number;
  release: number;
}

export interface Trig extends KeyTrig {
  /** hundredths of a mm per device unit */
  unit: number;
  min: number;
  max: number;
}

// ---------------------------------------------------------------------------------------------
// packets

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');

/** Payload allowlist (report ID not included). Everything else is refused. */
export function allowed(p: ArrayLike<number>): boolean {
  if (p.length === 0 || p.length > PAYLOAD_LEN) return false;
  const tailZero = (from: number) => {
    for (let i = from; i < p.length; i++) if (p[i] !== 0) return false;
    return true;
  };
  const at = (i: number): number | undefined => (i < p.length ? p[i] : undefined);
  switch (p[0]) {
    case 0x0d:
    case 0x01:
    case 0x0a:
      return tailZero(1);
    // per-key colours: read active slot (09 20), read slot table (09 80|81),
    // write one exact-length page of slot 0|1 (09 slot 00 pg len <data>)
    case 0x09: {
      const sub = at(1);
      if (sub === 0x20 || sub === 0x80 || sub === 0x81) return tailZero(2);
      if (sub === 0 || sub === 1) {
        const pg = at(3) ?? 0xff;
        const want = pg + 1 === COLOR_PAGES ? COLOR_TABLE - pg * COLOR_PAGE : COLOR_PAGE;
        return at(2) === 0 && pg < COLOR_PAGES && at(4) === want && tailZero(5 + want);
      }
      return false;
    }
    case 0x07:
      return (
        (at(1) === 0x01 && tailZero(2)) ||
        (at(1) === 0 && at(2) === 0 && at(3) === 0 && at(4) === 0x0e && tailZero(17))
      );
    case 0x21: {
      if (!(at(1) === 0 && at(2) === 0 && at(3) === 0)) return false;
      const a = at(4);
      const b = at(5);
      if (a === 0x01 && b === 0x09) return tailZero(6);
      if (a === 0x00 && b === 0x09) {
        const r = at(7);
        return at(6) === 1 && (r === 1 || r === 2 || r === 4 || r === 8) && tailZero(8);
      }
      if (a === 0x18 && b === 0x04) return tailZero(6);
      if (a === 0x18 && b === 0x05) return tailZero(8);
      // live travel test: 18 02 <22-byte key bitmap> starts, 18 03 stops (official openTriggerTest)
      if (a === 0x18 && b === 0x02) return tailZero(28);
      if (a === 0x18 && b === 0x03) return tailZero(6);
      if (a === 0x18 && b !== undefined) return (b === TRIG_FIXED || b === TRIG_RT || b === TRIG_RT_SPLIT) && tailZero(36);
      return false;
    }
    default:
      return false;
  }
}

export const readInfoPkt = () => [0x0d];
export const readPollPkt = () => [0x21, 0, 0, 0, 0x01, 0x09];
export const setPollPkt = (rate: number) => [0x21, 0, 0, 0, 0x00, 0x09, 0x01, rate & 0xff];
export const readMaxTravelPkt = () => [0x21, 0, 0, 0, 0x18, 0x04];
/** 22-byte bitmap: byte[col] |= 1 << row for each key index (row*22+col). */
export function keyBitmap(keys: number[]): number[] {
  const m = new Array(22).fill(0);
  for (const k of keys) m[k % 22] |= 1 << Math.floor(k / 22);
  return m;
}
export const startTravelTestPkt = (keys: number[]) => [0x21, 0, 0, 0, 0x18, 0x02, ...keyBitmap(keys)];
export const stopTravelTestPkt = () => [0x21, 0, 0, 0, 0x18, 0x03];
/** live travel report 21 .. 01: [6]=row, [7]=col (as far as we can tell), travel = [9]<<8 | [8] device units */
export function parseTravelSample(d: ArrayLike<number>): { key: number; raw: number } | undefined {
  if (d.length < 10 || d[0] !== 0x21 || d[5] !== 0x01) return undefined;
  return { key: d[6] * 22 + d[7], raw: (d[9] << 8) | d[8] };
}
export const readTrigPkt = (key: number) => [0x21, 0, 0, 0, 0x18, 0x05, Math.floor(key / 22), key % 22];

export function setLightPkt(l: Light): number[] {
  return [0x07, 0, 0, 0, 0x0e, l.mode, l.bri, l.speed, ...l.fg, ...l.bg, l.dir, l.fullColor, l.power].map((b) => b & 0xff);
}

/** Set trigger mode/travel/RT sensitivities (device units) for every key in `keys`. */
export function setTrigPkt(mode: number, travel: number, press: number, release: number, keys: number[]): number[] {
  if (!(mode === TRIG_FIXED || mode === TRIG_RT || mode === TRIG_RT_SPLIT)) {
    throw new Error(`trigger mode ${hex2(mode)} is not a set-mode`);
  }
  const p = new Array<number>(36).fill(0);
  p[0] = 0x21;
  p[4] = 0x18;
  p[5] = mode;
  for (const k of keys) {
    const row = Math.floor(k / 22);
    const col = k % 22;
    p[6 + col] |= 1 << row;
  }
  const hi = (v: number) => (v >> 8) & 0xff;
  const lo = (v: number) => v & 0xff;
  p.splice(28, 8, lo(travel), lo(travel), lo(press), lo(release), hi(travel), hi(travel), hi(press), hi(release));
  return p;
}

export const rgb = (c: ArrayLike<number>) => ((c[0] << 16) | (c[1] << 8) | c[2]) >>> 0;
const split = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];

/** 0xRRGGBB of device key `key` in a colour table. */
export const keyRgb = (table: Uint8Array, key: number) => rgb(table.subarray(key * 3, key * 3 + 3));

/** Put `colors` (parallel to the layout) into a copy of `table`; other slots (e.g. the knob) are kept. */
export function applyColors(table: Uint8Array, colors: number[]): Uint8Array {
  const t = new Uint8Array(table);
  W75_LAYOUT.forEach(([idx], i) => {
    if (i < colors.length) t.set(split(colors[i]), idx * 3);
  });
  return t;
}

export const readColorSlotPkt = () => [0x09, 0x20];
export const readColorsPkt = (slot: number) => [0x09, 0x80 | (slot & 1)];

/** The pages that write a whole per-key colour table to custom slot `slot` (0|1). */
export function setColorsPkts(slot: number, table: Uint8Array): number[][] {
  const out: number[][] = [];
  for (let pg = 0; pg * COLOR_PAGE < table.length; pg++) {
    const chunk = table.subarray(pg * COLOR_PAGE, Math.min(table.length, (pg + 1) * COLOR_PAGE));
    out.push([0x09, slot & 1, (pg >> 8) & 0xff, pg & 0xff, chunk.length, ...chunk]);
  }
  return out;
}

/** Parse one `09 8x pgHi pgLo len RGB..` reply page into `table`. Returns the page number. */
export function parseColorPage(d: ArrayLike<number>, table: Uint8Array): number | undefined {
  if (d.length < 5) return undefined;
  const pg = (d[2] << 8) | d[3];
  const len = d[4];
  if (d.length < 5 + len) return undefined;
  const start = pg * COLOR_PAGE;
  if (start >= COLOR_TABLE) return undefined;
  const end = Math.min(start + len, COLOR_TABLE);
  for (let i = start; i < end; i++) table[i] = d[5 + i - start];
  return pg;
}

/** Reply of `21 ..18 05 row col` -> that key's trigger. */
export function parseKeyTrig(t: ArrayLike<number>): KeyTrig | undefined {
  if (t.length < 15 || t[5] !== 0x05) return undefined;
  return {
    mode: t[6],
    travel: (t[11] << 8) | t[7],
    press: (t[13] << 8) | t[9],
    release: (t[14] << 8) | t[10],
  };
}

/** d0.. of a reply (report ID stripped). */
export function parseLight(d: ArrayLike<number>): Light | undefined {
  if (d.length < 17) return undefined;
  const v = (i: number) => d[5 + i];
  return {
    mode: v(0),
    bri: v(1),
    speed: v(2),
    fg: [v(3), v(4), v(5)],
    bg: [v(6), v(7), v(8)],
    dir: v(9),
    fullColor: v(10),
    power: v(11),
  };
}

const sameLight = (a: Light, b: Light) => hexs(setLightPkt(a)) === hexs(setLightPkt(b));

/** Returns [modes, max speed, max brightness]. */
export function parseModeList(d: ArrayLike<number>): [number[], number, number] | undefined {
  if (d.length < 5) return undefined;
  const len = d[4];
  const data = Array.from(d).slice(5, Math.min(5 + len, d.length));
  let sep = -1;
  for (let i = 0; i + 1 < data.length; i++) {
    if (data[i] === 0xa5 && data[i + 1] === 0x5a) {
      sep = i;
      break;
    }
  }
  if (sep < 0 || sep + 3 >= data.length) return undefined;
  const modes = data.slice(0, sep);
  if (!modes.includes(MODE_CUSTOM)) modes.push(MODE_CUSTOM);
  return [modes, data[sep + 2], data[sep + 3]];
}

/** Returns [product, firmware] from the comma-separated text of the first 0x0D page. */
export function parseInfo(d: ArrayLike<number>): [string, string] | undefined {
  if (d.length < 5) return undefined;
  const raw = Array.from(d).slice(5);
  const n = raw.indexOf(0);
  const bytes = new Uint8Array(n < 0 ? raw : raw.slice(0, n));
  const text = new TextDecoder().decode(bytes);
  const f = text.split(',').map((s) => s.trim());
  if (f.length < 5) return undefined;
  return [f[4], f[5] ?? '?'];
}

const isRt = (mode: number) => mode === TRIG_RT || mode === TRIG_RT_SPLIT;
const isSetMode = (mode: number) => mode === TRIG_FIXED || isRt(mode);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toUnits = (mm: number, unit: number) => clamp(Math.round((mm * 100) / unit), 0, 0xffff);
/** Largest RT sensitivity offered in the UI (mm). */
const sensMaxMm = () => Math.max(...RT_SENS) / 100;
const sameTrig = (a: KeyTrig, b: KeyTrig) =>
  a.mode === b.mode && a.travel === b.travel && a.press === b.press && a.release === b.release;

export function perKeyTriggerValue(t: Trig, keys: KeyTrig[]): Value {
  const u = t.unit / 100;
  const sens = keys.map((k) => k.press * u);
  return {
    kind: 'perKeyTrigger',
    keys: W75_CAPS,
    travel: keys.map((k) => k.travel * u),
    rapid: keys.map((k) => isRt(k.mode)),
    sens,
    min: t.min * u,
    max: t.max * u,
    step: u,
    sensMin: u,
    sensMax: Math.max(sensMaxMm(), ...sens),
  };
}

/**
 * Work out the new trigger of every key the UI changed: [layout position, new trigger][].
 * Unchanged keys (same values at device resolution) are left out so they're never rewritten.
 * Throws on a length mismatch or when a changed key uses a mode we don't understand.
 */
export function planKeyTrigs(
  old: KeyTrig[],
  t: Trig,
  travel: number[],
  rapid: boolean[],
  sens: number[],
): [number, KeyTrig][] {
  const n = old.length;
  if (travel.length !== n || rapid.length !== n || sens.length !== n) {
    throw new Error("per-key data doesn't match the keyboard layout - press Re-read");
  }
  const sensMax = Math.max(toUnits(sensMaxMm(), t.unit), ...old.map((k) => k.press), 0);
  const out: [number, KeyTrig][] = [];
  old.forEach((o, i) => {
    const tu = toUnits(travel[i], t.unit);
    const su = toUnits(sens[i], t.unit);
    const travelChanged = tu !== o.travel;
    const sensChanged = su !== o.press;
    if (!travelChanged && !sensChanged && rapid[i] === isRt(o.mode)) return;
    if (!isSetMode(o.mode)) {
      const label = W75_LAYOUT[i]?.[1] ?? '?';
      throw new Error(`${label} uses a special trigger mode (${hex2(o.mode)}) - change it in the official driver`);
    }
    const nt = travelChanged ? clamp(tu, t.min, t.max) : o.travel;
    const press = sensChanged ? clamp(su, 1, sensMax) : Math.max(o.press, 1);
    const mode = rapid[i] ? (o.mode === TRIG_RT_SPLIT && !sensChanged ? TRIG_RT_SPLIT : TRIG_RT) : TRIG_FIXED;
    let release = mode === TRIG_RT_SPLIT || !sensChanged ? Math.max(o.release, 1) : press;
    if (mode === TRIG_RT) release = press;
    out.push([i, { mode, travel: nt, press, release }]);
  });
  return out;
}

/** Group changes by identical trigger values -> one set packet per group (keys = device indices). */
export function groupKeyTrigs(changes: [number, KeyTrig][]): [KeyTrig, number[]][] {
  const g = new Map<string, [KeyTrig, number[]]>();
  for (const [i, k] of changes) {
    const id = `${k.mode},${k.travel},${k.press},${k.release}`;
    let e = g.get(id);
    if (!e) g.set(id, (e = [k, []]));
    e[1].push(W75_LAYOUT[i][0]);
  }
  return [...g.values()];
}

// ---------------------------------------------------------------------------------------------
// transport

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  readonly listeners = new Set<(d: Uint8Array) => void>();
  private readonly onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
    // copy: the browser may reuse the buffer
    const d = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    for (const l of [...this.listeners]) l(d);
  };

  constructor(readonly dev: HIDDevice) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach() {
    this.dev.removeEventListener('inputreport', this.onReport);
    this.listeners.clear();
  }

  /** Run `fn` with exclusive access to the device. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  private frame(p: number[]): Uint8Array<ArrayBuffer> {
    if (!allowed(p)) throw new Error(`refusing to send ${hexs(p.slice(0, 8))}`);
    const buf = new Uint8Array(PAYLOAD_LEN);
    buf.set(p);
    return buf;
  }

  /**
   * Send `p`, then feed every report-1 reply to `onReply` until it returns true (resolve) or
   * `timeout` ms pass (resolve false). Listening starts before the send.
   */
  listen(p: number[], timeout: number, onReply: (d: Uint8Array) => boolean): Promise<boolean> {
    const buf = this.frame(p);
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean, err?: unknown) => {
        this.listeners.delete(l);
        if (timer !== undefined) clearTimeout(timer);
        if (err !== undefined) reject(err);
        else resolve(ok);
      };
      const l = (d: Uint8Array) => {
        if (onReply(d)) finish(true);
      };
      this.listeners.add(l);
      timer = setTimeout(() => finish(false), timeout);
      this.dev.sendReport(REPORT_ID, buf).catch((e) => finish(false, e instanceof Error ? e : new Error(String(e))));
    });
  }

  /** Send one payload and wait for a reply whose d0 == cmd and that satisfies `want`. */
  async xfer(p: number[], want: (d: Uint8Array) => boolean): Promise<Uint8Array> {
    let got: Uint8Array | undefined;
    await this.listen(p, wraithTiming.reply, (d) => {
      if (d.length >= 1 && d[0] === p[0] && want(d)) {
        got = d;
        return true;
      }
      return false;
    });
    if (!got) throw new Error(`no answer for command ${hex2(p[0])}`);
    return got;
  }

  /** Fire-and-forget write (any ack is ignored). */
  async send(p: number[]): Promise<void> {
    await this.dev.sendReport(REPORT_ID, this.frame(p));
    await sleep(wraithTiming.send);
  }
}

// ---------------------------------------------------------------------------------------------
// driver

const text = (key: string, label: string, group: string, s: string): Setting => ({
  key,
  label,
  group,
  value: { kind: 'text', text: s },
});

class Wraith implements Driver {
  readonly id: string;
  readonly family = 'Wraith / HE web driver';
  readonly kind = 'keyboard' as const;

  /** confirmed model name (set once 0x0D returned a known product) */
  private verified: string | undefined;
  private product: string;
  private light: Light | undefined;
  private trig: Trig | undefined;
  /** last read per-key triggers, parallel to the layout */
  private keyTrigs: KeyTrig[] | undefined;
  /** last read custom colour slot (0|1) and its raw table */
  private colors: { slot: number; table: Uint8Array } | undefined;

  constructor(private readonly link: Link) {
    const d = link.dev;
    this.id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    this.product = d.productName || 'Wraith keyboard';
  }

  /** the W75's rotary knob (index 15, not a switch) */
  readonly knob = { x: 15.25, y: 0 };

  brand() {
    return 'WRAITH';
  }
  model() {
    return this.verified ?? this.product;
  }
  image() {
    return undefined;
  }

  /** 0x0D -> [firmware product, firmware version]; also sets the verified model. */
  async identify(): Promise<[string, string]> {
    const r = await this.link.xfer(readInfoPkt(), (d) => d[3] === 0);
    const info = parseInfo(r);
    if (!info) throw new Error("couldn't parse device info");
    this.verified = KNOWN.find((k) => k[0] === info[0])?.[1];
    return info;
  }

  read(): Promise<Setting[]> {
    return this.link.lock(() => this.readInner());
  }

  write(s: Setting): Promise<void> {
    return this.link.lock(() => this.writeInner(s));
  }

  /**
   * Live key travel: the keyboard streams how far keys are pressed until the returned stop() runs.
   * onSample gets the key's layout position (or -1 if the report can't be matched to a key) and mm.
   */
  async travelTest(onSample: (pos: number, mm: number) => void): Promise<() => Promise<void>> {
    const unit = (this.trig?.unit ?? 2) / 100;
    const l = (d: Uint8Array) => {
      const s = parseTravelSample(d);
      if (!s) return;
      onSample(W75_CAPS.findIndex((k) => k.index === s.key), s.raw * unit);
    };
    await this.link.lock(async () => {
      this.link.listeners.add(l);
      await this.link.send(startTravelTestPkt(W75_KEYS));
    });
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      this.link.listeners.delete(l);
      await this.link.lock(() => this.link.send(stopTravelTestPkt()));
    };
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.link.dev.opened) await this.link.dev.close();
  }

  // --- low-level reads

  private async readPoll(): Promise<number> {
    const r = await this.link.xfer(readPollPkt(), (d) => d[5] === 0x09);
    if (r.length < 7) throw new Error('short reply');
    return r[6];
  }

  private async readKeyTrig(key: number): Promise<KeyTrig> {
    const t = await this.link.xfer(readTrigPkt(key), (d) => d[5] === 0x05);
    const k = parseKeyTrig(t);
    if (!k) throw new Error('short reply');
    return k;
  }

  private async readTrig(): Promise<Trig> {
    const m = await this.link.xfer(readMaxTravelPkt(), (d) => d[5] === 0x04);
    if (m.length < 11) throw new Error('short reply');
    const max = (m[9] << 8) | m[6];
    const unit = m[7] === 0 ? 2 : m[7];
    const min = Math.max(m[10], 1);
    const k = await this.readKeyTrig(REF_KEY);
    return { ...k, unit, min, max };
  }

  /** Every layout key's trigger; a key that doesn't answer (twice) gets the global value `g`. */
  private async readKeyTrigs(g: Trig): Promise<KeyTrig[]> {
    const fallback: KeyTrig = { mode: g.mode, travel: g.travel, press: g.press, release: g.release };
    const out: KeyTrig[] = [];
    for (const [key] of W75_LAYOUT) {
      let k: KeyTrig;
      try {
        k = await this.readKeyTrig(key);
      } catch {
        try {
          k = await this.readKeyTrig(key);
        } catch {
          k = { ...fallback };
        }
      }
      out.push(k);
    }
    return out;
  }

  private async readLight(): Promise<Light> {
    const r = await this.link.xfer([0x07, 0x01], () => true);
    const l = parseLight(r);
    if (!l) throw new Error('short lighting reply');
    return l;
  }

  private async readStatus(): Promise<Uint8Array | undefined> {
    try {
      return await this.link.xfer([0x01], () => true);
    } catch {
      return undefined;
    }
  }

  /** Active custom colour slot (0|1) per `09 20`; 0 if the board doesn't say. */
  private async readColorSlot(): Promise<number> {
    try {
      const r = await this.link.xfer(readColorSlotPkt(), (d) => d[1] === 0 || d[1] === 1);
      return r[1];
    } catch {
      return 0;
    }
  }

  /** Read a custom colour table (the board streams 8 pages for one request). */
  private async readColors(slot: number): Promise<Uint8Array> {
    const p = readColorsPkt(slot);
    const table = new Uint8Array(COLOR_TABLE);
    const seen = new Set<number>();
    await this.link.listen(p, wraithTiming.colors, (d) => {
      if (d.length >= 5 && d[0] === 0x09 && d[1] === p[1]) {
        const pg = parseColorPage(d, table);
        if (pg !== undefined) seen.add(pg);
      }
      return seen.size >= COLOR_PAGES;
    });
    if (seen.size < COLOR_PAGES) {
      const bits = Array.from({ length: COLOR_PAGES }, (_, i) => (seen.has(COLOR_PAGES - 1 - i) ? '1' : '0')).join('');
      throw new Error(`colour table incomplete (pages ${bits})`);
    }
    return table;
  }

  // --- low-level writes

  /** Send `changes` (layout position, new trigger) grouped by value, then read the keys back. */
  private async writeKeyTrigs(changes: [number, KeyTrig][]): Promise<void> {
    if (!this.keyTrigs) throw new Error('press Re-read first');
    const cache = this.keyTrigs.slice();
    for (const [k, keys] of groupKeyTrigs(changes)) {
      await this.link.send(setTrigPkt(k.mode, k.travel, k.press, k.release, keys));
    }
    await sleep(wraithTiming.settle);
    const bad: string[] = [];
    for (const [i, want] of changes) {
      const [key, label] = W75_LAYOUT[i];
      try {
        const got = await this.readKeyTrig(key);
        cache[i] = got;
        if (!sameTrig(got, want)) bad.push(label);
      } catch {
        bad.push(label);
      }
      if (key === REF_KEY && this.trig) {
        const k = cache[i];
        this.trig = { ...this.trig, mode: k.mode, travel: k.travel, press: k.press, release: k.release };
      }
    }
    this.keyTrigs = cache;
    if (bad.length) throw new Error(`keyboard didn't take the trigger change for: ${bad.join(', ')}`);
  }

  private async writeTrig(t: Trig): Promise<void> {
    const travel = clamp(t.travel, t.min, t.max);
    const press = Math.max(t.press, 1);
    const release = Math.max(t.release, 1);
    await this.link.send(setTrigPkt(t.mode, travel, press, release, W75_KEYS));
    this.trig = { ...t, travel, press, release };
    if (this.keyTrigs) this.keyTrigs = this.keyTrigs.map(() => ({ mode: t.mode, travel, press, release }));
  }

  private async writeLight(l: Light): Promise<void> {
    await this.link.send(setLightPkt(l));
    await sleep(wraithTiming.settle);
    // read back so a silently ignored write is reported instead of "saved"
    const got = await this.readLight();
    this.light = got;
    if (!sameLight(got, l)) {
      throw new Error(`keyboard didn't take the lighting change (reads back ${JSON.stringify(got)})`);
    }
  }

  private async writeColors(colors: number[]): Promise<void> {
    if (colors.length !== W75_LAYOUT.length) {
      throw new Error("per-key colours don't match the keyboard layout - press Re-read");
    }
    const l = this.light;
    if (!l) throw new Error('press Re-read first');
    const { slot, table: old } = this.colors ?? { slot: 0, table: new Uint8Array(COLOR_TABLE) };
    const table = applyColors(old, colors);
    for (const p of setColorsPkts(slot, table)) {
      await this.link.send(p);
      await sleep(wraithTiming.page);
    }
    this.colors = { slot, table };
    if (l.mode !== MODE_CUSTOM || l.power !== 0) {
      await this.writeLight({ ...l, mode: MODE_CUSTOM, power: 0 });
    }
    // verify when the board lets us read the table back
    let got: Uint8Array;
    try {
      got = await this.readColors(slot);
    } catch {
      return;
    }
    this.colors = { slot, table: got };
    const bad = W75_LAYOUT.filter(([k]) => keyRgb(got, k) !== keyRgb(table, k)).map((k) => k[1]);
    if (bad.length) throw new Error(`keyboard didn't take the colour for: ${bad.join(', ')}`);
  }

  // --- Driver

  private async readInner(): Promise<Setting[]> {
    const out: Setting[] = [];

    // --- info (also gates everything writable)
    let info: [string, string];
    try {
      info = await this.identify();
    } catch (e) {
      throw new Error(`Keyboard isn't answering (${e instanceof Error ? e.message : String(e)}).`);
    }
    const [product, fw] = info;
    out.push(text('model', 'Model', 'Info', this.model()));
    out.push(text('product_id', 'Firmware product ID', 'Info', product));
    out.push(text('fw', 'Firmware', 'Info', fw));
    if (!this.verified) {
      out.push(text('unsupported', 'Note', 'Info', `'${product}' isn't a verified board - settings are read-only`));
      return out;
    }

    // --- performance
    const code = await this.readPoll();
    const options: [string, number][] = POLLING.map(([l, c]) => [l, c]);
    if (!POLLING.some(([, c]) => c === code)) options.push([`Current (code ${code})`, code]);
    out.push({ key: 'polling', label: 'Polling rate', group: 'Performance', value: { kind: 'choice', options, current: code } });

    // --- switches (skip if the board uses the high-precision travel table)
    const precise = ((await this.readStatus())?.[5 + 13] ?? 0) !== 0;
    this.trig = undefined;
    this.keyTrigs = undefined;
    if (!precise) {
      let t: Trig | undefined;
      try {
        t = await this.readTrig();
      } catch {
        t = undefined;
      }
      if (t) {
        this.trig = t;
        // actuation in mm at the device's own resolution (unit = hundredths of a mm)
        const u = t.unit / 100;
        out.push({
          key: 'actuation',
          label: 'Actuation point (all keys)',
          group: 'Switches',
          value: { kind: 'float', min: t.min * u, max: t.max * u, step: u, current: t.travel * u, unit: ' mm' },
        });
        out.push({ key: 'rapid_trigger', label: 'Rapid Trigger (all keys)', group: 'Switches', value: { kind: 'toggle', on: isRt(t.mode) } });
        out.push({
          key: 'rt_sens',
          label: 'Rapid Trigger sensitivity',
          group: 'Switches',
          value: { kind: 'float', min: u, max: sensMaxMm(), step: u, current: t.press * u, unit: ' mm' },
        });
        const keys = await this.readKeyTrigs(t);
        out.push({ key: 'per_key_trigger', label: 'Per-key actuation', group: 'Per-key', value: perKeyTriggerValue(t, keys) });
        this.keyTrigs = keys;
      }
    }

    // --- lighting
    const l = await this.readLight();
    this.light = l;
    let modeList: [number[], number, number] | undefined;
    try {
      modeList = parseModeList(await this.link.xfer([0x0a], () => true));
    } catch {
      modeList = undefined;
    }
    const [modes, maxSpeed, maxBri] = modeList ?? [LIGHT_MODES.map((m) => m[0]), 4, 4];
    const name = (m: number) => LIGHT_MODES.find((x) => x[0] === m)?.[1] ?? `Mode ${m}`;
    const modeOptions: [string, number][] = modes.map((m) => [name(m), m]);
    if (!modes.includes(l.mode)) modeOptions.push([name(l.mode), l.mode]);
    // power byte: 0 = LEDs ON, 1 = LEDs OFF (official driver: "LED ON/OFF" switch, checked -> 0)
    out.push({ key: 'light_power', label: 'Lights on', group: 'Lighting', value: { kind: 'toggle', on: l.power === 0 } });
    out.push({ key: 'light_mode', label: 'Effect', group: 'Lighting', value: { kind: 'choice', options: modeOptions, current: l.mode } });
    out.push({ key: 'light_bri', label: 'Brightness', group: 'Lighting', value: { kind: 'number', min: 0, max: Math.max(maxBri, 1), current: l.bri, unit: '' } });
    out.push({ key: 'light_speed', label: 'Speed', group: 'Lighting', value: { kind: 'number', min: 0, max: Math.max(maxSpeed, 1), current: l.speed, unit: '' } });
    out.push({ key: 'light_color', label: 'Colour', group: 'Lighting', value: { kind: 'color', rgb: rgb(l.fg) } });
    out.push({ key: 'light_rainbow', label: 'Rainbow colours', group: 'Lighting', value: { kind: 'toggle', on: l.fullColor !== 0 } });

    // --- per-key colours (status flag F[12] bit 0x02 = custom per-key light)
    this.colors = undefined;
    const flags = (await this.readStatus())?.[5 + 12] ?? 0;
    if (flags & 0x02) {
      const slot = await this.readColorSlot();
      let colors: number[];
      try {
        const table = await this.readColors(slot);
        this.colors = { slot, table };
        colors = W75_LAYOUT.map(([k]) => keyRgb(table, k));
      } catch {
        // couldn't read the table: start every key from the main colour
        colors = W75_LAYOUT.map(() => rgb(l.fg));
      }
      out.push({ key: 'per_key_color', label: 'Per-key colours', group: 'Per-key', value: { kind: 'perKeyColor', keys: W75_CAPS, colors } });
    }
    return out;
  }

  private async writeInner(s: Setting): Promise<void> {
    if (!this.verified) throw new Error('unverified board - settings are read-only');
    const light = () => {
      if (!this.light) throw new Error('press Re-read first');
      return this.light;
    };
    const trig = () => {
      if (!this.trig) throw new Error('press Re-read first');
      return this.trig;
    };
    const v = s.value;
    switch (`${s.key}:${v.kind}`) {
      case 'polling:choice': {
        const rate = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!POLLING.some(([, c]) => c === rate)) throw new Error('unsupported polling rate');
        await this.link.send(setPollPkt(rate));
        await sleep(wraithTiming.poll);
        const r = await this.readPoll();
        if (r !== rate) throw new Error(`polling rate reads back as code ${r}`);
        return;
      }
      case 'actuation:float': {
        const t = trig();
        const travel = toUnits((v as Extract<Value, { kind: 'float' }>).current, t.unit);
        return this.writeTrig({ ...t, travel });
      }
      case 'rapid_trigger:toggle': {
        const t = trig();
        const mode = (v as Extract<Value, { kind: 'toggle' }>).on ? TRIG_RT : TRIG_FIXED;
        return this.writeTrig({ ...t, mode, release: t.press });
      }
      case 'rt_sens:float': {
        const t = trig();
        const mode = t.mode === TRIG_RT_SPLIT ? TRIG_RT : t.mode;
        const u = Math.max(toUnits((v as Extract<Value, { kind: 'float' }>).current, t.unit), 1);
        return this.writeTrig({ ...t, mode, press: u, release: u });
      }
      case 'light_mode:choice':
        return this.writeLight({ ...light(), mode: (v as Extract<Value, { kind: 'choice' }>).current & 0xff });
      case 'light_bri:number': {
        const n = v as Extract<Value, { kind: 'number' }>;
        return this.writeLight({ ...light(), bri: clamp(Math.round(n.current), 0, n.max) });
      }
      case 'light_speed:number': {
        const n = v as Extract<Value, { kind: 'number' }>;
        return this.writeLight({ ...light(), speed: clamp(Math.round(n.current), 0, n.max) });
      }
      case 'light_color:color':
        return this.writeLight({ ...light(), fg: split((v as Extract<Value, { kind: 'color' }>).rgb), fullColor: 0 });
      case 'light_rainbow:toggle':
        return this.writeLight({ ...light(), fullColor: (v as Extract<Value, { kind: 'toggle' }>).on ? 1 : 0 });
      case 'light_power:toggle':
        return this.writeLight({ ...light(), power: (v as Extract<Value, { kind: 'toggle' }>).on ? 0 : 1 });
      case 'per_key_trigger:perKeyTrigger': {
        const t = trig();
        if (!this.keyTrigs) throw new Error('press Re-read first');
        const p = v as Extract<Value, { kind: 'perKeyTrigger' }>;
        const changes = planKeyTrigs(this.keyTrigs, t, p.travel, p.rapid, p.sens);
        if (changes.length === 0) return;
        return this.writeKeyTrigs(changes);
      }
      case 'per_key_color:perKeyColor':
        return this.writeColors((v as Extract<Value, { kind: 'perKeyColor' }>).colors);
      default:
        throw new Error(`${s.key} can't be changed`);
    }
  }
}

export const wraithFactory: DriverFactory = {
  name: 'Wraith',
  filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE }],
  match(d: HIDDevice): boolean {
    return (
      d.vendorId === VID &&
      d.productId === PID &&
      (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE)
    );
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!wraithFactory.match(device)) return null;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const link = new Link(device);
    const drv = new Wraith(link);
    try {
      await link.lock(() => drv.identify());
    } catch {
      link.detach();
      if (openedHere) await device.close().catch(() => undefined);
      return null;
    }
    return drv;
  },
};
