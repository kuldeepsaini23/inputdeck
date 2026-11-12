// Generic VIA / QMK raw-HID keyboard driver (Keychron, NuPhy, Lofree, Zoom, Mode, CIDOO, Kzzi,
// Epomaker / Akko / Monsgeek VIA models and thousands of custom boards).
//
// Protocol: qmk_firmware quantum/via.h + via.c, the-via/app src/utils/keyboard-api.ts.
// Interface: raw HID, usage page 0xFF60 usage 0x61, report ID 0, 32-byte reports both ways.
// Every reply echoes the request's command bytes; an unknown command comes back as 0xFF.
//
// Board layout + lighting menus: the board's VIA v3 definition, fetched at runtime from
// https://usevia.app/definitions/v3/<vid<<16|pid>.json (the URL the VIA web app itself uses;
// served with Access-Control-Allow-Origin: *). Key legends come from the board's own layer-0
// keymap. Without a definition we probe the standard lighting channels and draw a generic
// ANSI 60% board.
//
// Key remapping: 0x05 set keycode (one key, one layer), only inside the board's layer count
// and switch matrix, which the driver learns before it may send one.
//
// Macros (QMK dynamic macros): 0x0C count, 0x0D buffer size, 0x0E get buffer and 0x0F set
// buffer, each get/set inside the buffer size the board reported. Writes rebuild the whole
// buffer (only the 28-byte chunks that change are sent), flagged as in progress by a non-zero
// last byte like the VIA app does, then read back. Format: src/lib/macros.ts.
//
// NEVER send: 0x03 set keyboard value, 0x13/0x15 encoder / bulk keymap writes, 0x06 keymap
// reset, 0x0A EEPROM reset, 0x0B bootloader jump, 0x10 macro reset, channel 0 (vendor custom)
// or audio values. `allowed()` enforces an allowlist on every packet.

import { decodeMacro, encodeMacro, MAX_DELAY, splitMacros } from '../lib/macros';
import type { Driver, DriverFactory, KeyCap, KeycodeSet, MacroFormat, MacroStep, Setting, Value } from './types';

export const USAGE_PAGE = 0xff60;
export const USAGE = 0x61;
const REPORT_ID = 0;
export const REPORT_LEN = 32;
/** Max keymap bytes per get-buffer request (32 - 4 header bytes). */
export const BUF_CHUNK = 28;

// command ids (quantum/via.h)
export const CMD = {
  protocol: 0x01,
  getKbValue: 0x02,
  setKeycode: 0x05,
  customSet: 0x07,
  customGet: 0x08,
  customSave: 0x09,
  macroCount: 0x0c,
  macroSize: 0x0d,
  macroGet: 0x0e,
  macroSet: 0x0f,
  layerCount: 0x11,
  getBuffer: 0x12,
  unhandled: 0xff,
} as const;

// keyboard value ids
export const KV_UPTIME = 0x01;
export const KV_LAYOUT_OPTIONS = 0x02;
export const KV_FIRMWARE = 0x04;

// lighting channels and their value ids
export const CH_BACKLIGHT = 1;
export const CH_RGBLIGHT = 2;
export const CH_RGB_MATRIX = 3;
export const CH_LED_MATRIX = 5;
export const V_BRIGHTNESS = 1;
export const V_EFFECT = 2;
export const V_SPEED = 3;
export const V_COLOR = 4;

/** value ids each lighting channel understands */
const CHANNEL_VALUES: Record<number, number[]> = {
  [CH_BACKLIGHT]: [V_BRIGHTNESS, V_EFFECT],
  [CH_RGBLIGHT]: [V_BRIGHTNESS, V_EFFECT, V_SPEED, V_COLOR],
  [CH_RGB_MATRIX]: [V_BRIGHTNESS, V_EFFECT, V_SPEED, V_COLOR],
  [CH_LED_MATRIX]: [V_BRIGHTNESS, V_EFFECT, V_SPEED],
};
/** which channel drives the main lighting controls when a board has several */
const CHANNEL_PRIORITY = [CH_RGB_MATRIX, CH_LED_MATRIX, CH_RGBLIGHT, CH_BACKLIGHT];
const CHANNEL_NAME: Record<number, string> = {
  [CH_BACKLIGHT]: 'Backlight',
  [CH_RGBLIGHT]: 'RGB underglow',
  [CH_RGB_MATRIX]: 'RGB matrix',
  [CH_LED_MATRIX]: 'LED matrix',
};

/** Custom-value channels exist from protocol 11 (VIA v3) on; layer count from 9. */
const PROTOCOL_V3 = 11;
const PROTOCOL_BETA = 9;
/** QMK keycodes v2 (QMK 0.19+) come with VIA protocol 12. */
const PROTOCOL_KEYCODES_V2 = 12;
/** The keymap buffer is addressed with a 16-bit offset. */
const MAX_KEYMAP_BYTES = 0x10000;
/** Macro buffer offsets are 16-bit too. */
const MAX_MACRO_BYTES = 0xffff;
/** Delays in macros (SS_DELAY_CODE with the 0x01 prefix) come with VIA protocol 11. */
const PROTOCOL_MACRO_DELAYS = 11;

/** VIDs other drivers own; never claim them. */
const EXCLUDED_VIDS = new Set([0x36a7, 0x373e, 0x37b0, 0x3710, 0x3554]);
const EXCLUDED_IDS = new Set(['2e3c:c365']);

/** Brightness / speed are shown in this many steps (device range is 0-255). */
export const LEVELS = 10;

/** Timings (ms) and the definition fetcher. Mutable so tests can swap them. */
export const viaConfig = {
  reply: 500,
  fetchTimeout: 6000,
  definitionUrl: (vpid: number) => `https://usevia.app/definitions/v3/${vpid}.json`,
  fetch: (url: string, signal: AbortSignal): Promise<unknown> =>
    fetch(url, { signal }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    }),
};

// ---------------------------------------------------------------------------------------------
// packets

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');

const channelValueOk = (ch: number | undefined, id: number | undefined) =>
  ch !== undefined && id !== undefined && (CHANNEL_VALUES[ch]?.includes(id) ?? false);

/** What a keymap write may touch: layers 0..layers-1, rows 0..rows-1, cols 0..cols-1. */
export interface KeymapBounds {
  layers: number;
  rows: number;
  cols: number;
}

/** Size of the board's macro buffer (from 0x0D); macro buffer reads / writes must stay inside it. */
export interface MacroBounds {
  size: number;
}

/**
 * Payload allowlist (32 bytes, no report ID). Everything else is refused. Keymap writes (0x05)
 * are only allowed when `km` (the board's layer count and matrix) is given and the key is inside it;
 * macro buffer reads / writes (0x0E / 0x0F) only when `mb` is given and offset + length fit in it.
 */
export function allowed(p: ArrayLike<number>, km?: KeymapBounds, mb?: MacroBounds): boolean {
  if (p.length === 0 || p.length > REPORT_LEN) return false;
  const tailZero = (from: number) => {
    for (let i = from; i < p.length; i++) if (p[i] !== 0) return false;
    return true;
  };
  switch (p[0]) {
    case CMD.protocol:
    case CMD.layerCount:
    case CMD.macroCount:
    case CMD.macroSize:
      return tailZero(1);
    case CMD.macroGet:
    case CMD.macroSet: {
      if (!mb || p.length < 4 || mb.size < 1 || mb.size > MAX_MACRO_BYTES) return false;
      const off = (p[1] << 8) | p[2];
      const len = p[3];
      if (len < 1 || len > BUF_CHUNK || off + len > mb.size) return false;
      return tailZero(p[0] === CMD.macroGet ? 4 : 4 + len);
    }
    case CMD.getKbValue:
      return (p[1] === KV_UPTIME || p[1] === KV_LAYOUT_OPTIONS || p[1] === KV_FIRMWARE) && tailZero(2);
    case CMD.getBuffer:
      return p.length > 3 && p[3] >= 1 && p[3] <= BUF_CHUNK && tailZero(4);
    case CMD.setKeycode:
      return (
        !!km &&
        p.length >= 6 &&
        p[1] < km.layers &&
        p[2] < km.rows &&
        p[3] < km.cols &&
        km.layers <= 32 &&
        tailZero(6)
      );
    case CMD.customGet:
      return channelValueOk(p[1], p[2]) && tailZero(3);
    case CMD.customSet:
      if (!channelValueOk(p[1], p[2])) return false;
      return tailZero(p[2] === V_COLOR ? 5 : 4);
    case CMD.customSave:
      return CHANNEL_VALUES[p[1]] !== undefined && tailZero(2);
    default:
      return false;
  }
}

export const protocolPkt = () => [CMD.protocol];
export const layerCountPkt = () => [CMD.layerCount];
export const kbValuePkt = (id: number) => [CMD.getKbValue, id];
export const getBufferPkt = (offset: number, size: number) => [CMD.getBuffer, (offset >> 8) & 0xff, offset & 0xff, size];
export const setKeycodePkt = (layer: number, row: number, col: number, kc: number) =>
  [CMD.setKeycode, layer & 0xff, row & 0xff, col & 0xff, (kc >> 8) & 0xff, kc & 0xff];
/** Byte offset of one keycode in the dynamic keymap buffer (layer-major, 2 bytes big-endian). */
export const keymapOffset = (layer: number, row: number, col: number, rows: number, cols: number) =>
  ((layer * rows + row) * cols + col) * 2;
export const customGetPkt = (ch: number, id: number) => [CMD.customGet, ch, id];
export const customSetPkt = (ch: number, id: number, ...data: number[]) => [CMD.customSet, ch, id, ...data.map((b) => b & 0xff)];
export const customSavePkt = (ch: number) => [CMD.customSave, ch];
export const macroCountPkt = () => [CMD.macroCount];
export const macroSizePkt = () => [CMD.macroSize];
export const macroGetPkt = (offset: number, size: number) => [CMD.macroGet, (offset >> 8) & 0xff, offset & 0xff, size];
export const macroSetPkt = (offset: number, data: ArrayLike<number>) =>
  [CMD.macroSet, (offset >> 8) & 0xff, offset & 0xff, data.length, ...Array.from(data, (b) => b & 0xff)];

/** Big-endian 32-bit number from 4 bytes. */
export const be32 = (b: ArrayLike<number>, at = 0) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

// ---------------------------------------------------------------------------------------------
// colour (QMK hue / sat are 0-255)

export function hsvToRgb(h: number, s: number, v = 255): number {
  const H = (h / 255) * 6;
  const S = s / 255;
  const V = v / 255;
  const i = Math.floor(H) % 6;
  const f = H - Math.floor(H);
  const p = V * (1 - S);
  const q = V * (1 - S * f);
  const t = V * (1 - S * (1 - f));
  const [r, g, b] = [
    [V, t, p], [q, V, p], [p, V, t], [p, q, V], [t, p, V], [V, p, q],
  ][i];
  const c = (x: number) => Math.round(x * 255);
  return ((c(r) << 16) | (c(g) << 8) | c(b)) >>> 0;
}

export function rgbToHs(rgb: number): [number, number] {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  const s = max === 0 ? 0 : d / max;
  return [Math.round((h / 6) * 255) % 256, Math.round(s * 255)];
}

const toLevel = (v: number, max: number) => Math.round((v * LEVELS) / (max || 255));
const fromLevel = (n: number, max: number) => Math.min(max, Math.max(0, Math.round((n * (max || 255)) / LEVELS)));

// ---------------------------------------------------------------------------------------------
// keycode legends (basic HID range is the same in QMK keycodes v1 and v2)

const BASIC: Record<number, string> = {
  0x28: 'Enter', 0x29: 'Esc', 0x2a: 'Bksp', 0x2b: 'Tab', 0x2c: 'Space', 0x2d: '-', 0x2e: '=', 0x2f: '[',
  0x30: ']', 0x31: '\\', 0x32: '#', 0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/',
  0x39: 'Caps', 0x46: 'PrtSc', 0x47: 'ScrLk', 0x48: 'Pause', 0x49: 'Ins', 0x4a: 'Home', 0x4b: 'PgUp',
  0x4c: 'Del', 0x4d: 'End', 0x4e: 'PgDn', 0x4f: 'Right', 0x50: 'Left', 0x51: 'Down', 0x52: 'Up',
  0x53: 'Num', 0x54: '/', 0x55: '*', 0x56: '-', 0x57: '+', 0x58: 'Enter', 0x63: '.', 0x64: '\\', 0x65: 'Menu',
  0xe0: 'Ctrl', 0xe1: 'Shift', 0xe2: 'Alt', 0xe3: 'Win', 0xe4: 'Ctrl', 0xe5: 'Shift', 0xe6: 'Alt', 0xe7: 'Win',
};

function basicLabel(k: number): string {
  if (k >= 0x04 && k <= 0x1d) return String.fromCharCode(0x41 + k - 0x04);
  if (k >= 0x1e && k <= 0x27) return String((k - 0x1d) % 10);
  if (k >= 0x3a && k <= 0x45) return `F${k - 0x39}`;
  if (k >= 0x59 && k <= 0x62) return String((k - 0x58) % 10);
  if (k >= 0x68 && k <= 0x73) return `F${k - 0x5b}`;
  return BASIC[k] ?? '';
}

/** Short legend for a QMK keycode ('' when we don't know one). */
export function keycodeLabel(kc: number): string {
  if (kc < 0x100) return basicLabel(kc);
  // MO(n): 0x5220.. in keycodes v2, 0x5100.. in v1
  if ((kc >= 0x5220 && kc <= 0x523f) || (kc >= 0x5100 && kc <= 0x511f)) return 'Fn';
  // modifier combos, mod-tap, layer-tap: the tapped key is in the low byte
  if (kc < 0x5000 || (kc >= 0x6000 && kc < 0x8000)) return basicLabel(kc & 0xff);
  return '';
}

// ---------------------------------------------------------------------------------------------
// VIA definition (v3, as compiled by the-via/keyboards)

export interface ViaKey {
  row: number;
  col: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  rx?: number;
  ry?: number;
  /** decal (not a real key) */
  d?: boolean;
  /** encoder index */
  ei?: number;
}

export interface ViaDefinition {
  name: string;
  vendorProductId?: number;
  matrix: { rows: number; cols: number };
  layouts: {
    keys: ViaKey[];
    labels?: (string | string[])[];
    optionKeys?: Record<string, Record<string, ViaKey[]>>;
  };
  menus?: unknown[];
}

function isDefinition(d: unknown): d is ViaDefinition {
  const x = d as ViaDefinition;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.matrix?.rows === 'number' &&
    typeof x.matrix?.cols === 'number' &&
    Array.isArray(x.layouts?.keys)
  );
}

/** Built-in VIA menus (from @the-via/reader common-menus) referenced by name in `menus`. */
const RGB_MATRIX_EFFECTS = [
  'All Off', 'Solid Color', 'Alphas Mods', 'Gradient Up/Down', 'Gradient Left/Right', 'Breathing', 'Band Sat.',
  'Band Val.', 'Pinwheel Sat.', 'Pinwheel Val.', 'Spiral Sat.', 'Spiral Val.', 'Cycle All', 'Cycle Left/Right',
  'Cycle Up/Down', 'Rainbow Moving Chevron', 'Cycle Out/In', 'Cycle Out/In Dual', 'Cycle Pinwheel', 'Cycle Spiral',
  'Dual Beacon', 'Rainbow Beacon', 'Rainbow Pinwheels', 'Raindrops', 'Jellybean Raindrops', 'Hue Breathing',
  'Hue Pendulum', 'Hue Wave', 'Pixel Rain', 'Pixel Flow', 'Pixel Fractal', 'Typing Heatmap', 'Digital Rain',
  'Solid Reactive Simple', 'Solid Reactive', 'Solid Reactive Wide', 'Solid Reactive Multi Wide',
  'Solid Reactive Cross', 'Solid Reactive Multi Cross', 'Solid Reactive Nexus', 'Solid Reactive Multi Nexus',
  'Splash', 'Multi Splash', 'Solid Splash', 'Solid Multi Splash',
];
const RGBLIGHT_EFFECTS = [
  'All Off', 'Solid Color', 'Breathing 1', 'Breathing 2', 'Breathing 3', 'Breathing 4', 'Rainbow Mood 1',
  'Rainbow Mood 2', 'Rainbow Mood 3', 'Rainbow Swirl 1', 'Rainbow Swirl 2', 'Rainbow Swirl 3', 'Rainbow Swirl 4',
  'Rainbow Swirl 5', 'Rainbow Swirl 6', 'Snake 1', 'Snake 2', 'Snake 3', 'Snake 4', 'Snake 5', 'Snake 6',
  'Knight 1', 'Knight 2', 'Knight 3', 'Christmas', 'Gradient 1', 'Gradient 2', 'Gradient 3', 'Gradient 4',
  'Gradient 5', 'Gradient 6', 'Gradient 7', 'Gradient 8', 'Gradient 9', 'Gradient 10', 'RGB Test', 'Alternating',
  'Twinkle 1', 'Twinkle 2', 'Twinkle 3', 'Twinkle 4', 'Twinkle 5', 'Twinkle 6',
];
const LED_MATRIX_EFFECTS = ['All Off', 'Solid', 'Alphas Mods', 'Breathing', 'Band', 'Band Pinwheel', 'Band Spiral',
  'Cycle Left/Right', 'Cycle Up/Down', 'Cycle Out/In', 'Dual Beacon', 'Solid Reactive Simple', 'Solid Reactive Wide',
  'Solid Reactive Multi Wide', 'Solid Reactive Cross', 'Solid Reactive Multi Cross', 'Solid Reactive Nexus',
  'Solid Reactive Multi Nexus', 'Splash', 'Multi Splash', 'Solid Splash', 'Solid Multi Splash', 'Wave Left/Right',
  'Wave Up/Down'];
const BACKLIGHT_EFFECTS: [string, number][] = [['Off', 0], ['Breathing', 1]];

const indexed = (names: string[]): [string, number][] => names.map((n, i) => [n, i]);
const DEFAULT_EFFECTS: Record<number, [string, number][]> = {
  [CH_RGB_MATRIX]: indexed(RGB_MATRIX_EFFECTS),
  [CH_RGBLIGHT]: indexed(RGBLIGHT_EFFECTS),
  [CH_LED_MATRIX]: indexed(LED_MATRIX_EFFECTS),
  [CH_BACKLIGHT]: BACKLIGHT_EFFECTS,
};
const COMMON_MENUS: Record<string, number[]> = {
  qmk_rgb_matrix: [CH_RGB_MATRIX],
  qmk_rgblight: [CH_RGBLIGHT],
  qmk_backlight: [CH_BACKLIGHT],
  qmk_backlight_rgblight: [CH_BACKLIGHT, CH_RGBLIGHT],
  qmk_led_matrix: [CH_LED_MATRIX],
};

/** What we know about one lighting channel's controls. */
export interface Channel {
  ch: number;
  values: Set<number>;
  /** device range max for brightness / speed */
  briMax: number;
  speedMax: number;
  effects?: [string, number][];
}

function newChannel(ch: number): Channel {
  return { ch, values: new Set(), briMax: 255, speedMax: 255 };
}

function commonChannel(ch: number): Channel {
  const c = newChannel(ch);
  for (const v of CHANNEL_VALUES[ch]) c.values.add(v);
  c.effects = DEFAULT_EFFECTS[ch];
  return c;
}

/**
 * Standard lighting channels named by the definition's `menus` (common menu names or custom
 * menus whose controls point at channels 1/2/3/5). Vendor channel 0 controls are ignored.
 */
export function parseMenus(menus: unknown[] | undefined): Map<number, Channel> {
  const out = new Map<number, Channel>();
  const get = (ch: number) => {
    let c = out.get(ch);
    if (!c) out.set(ch, (c = newChannel(ch)));
    return c;
  };
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      for (const ch of COMMON_MENUS[node] ?? []) if (!out.has(ch)) out.set(ch, commonChannel(ch));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: unknown; content?: unknown; options?: unknown };
    const c = n.content;
    if (typeof n.type === 'string' && Array.isArray(c) && typeof c[0] === 'string') {
      const [, ch, id] = c as [string, number, number];
      if (!channelValueOk(ch, id)) return;
      const chan = get(ch);
      chan.values.add(id);
      const opts = Array.isArray(n.options) ? (n.options as unknown[]) : [];
      if (n.type === 'range' && typeof opts[1] === 'number') {
        if (id === V_BRIGHTNESS) chan.briMax = opts[1];
        if (id === V_SPEED) chan.speedMax = opts[1];
      }
      if (id === V_EFFECT && n.type === 'dropdown') {
        const e: [string, number][] = [];
        opts.forEach((o, i) => {
          if (typeof o === 'string') e.push([o, i]);
          else if (Array.isArray(o) && typeof o[0] === 'string' && typeof o[1] === 'number') e.push([o[0], o[1]]);
        });
        if (e.length) chan.effects = e;
      }
      return;
    }
    if (Array.isArray(c)) walk(c);
  };
  walk(menus ?? []);
  return out;
}

// --- layout options (the-via/app utils/bit-pack.ts)

const minBitSize = (n: number) => {
  for (let b = 1; b <= 5; b++) if (1 << b >= n) return b;
  return 5;
};

/** Selected option per layout label from the packed 32-bit layout-options value. */
export function unpackLayoutOptions(packed: number, labels: (string | string[])[]): number[] {
  const out: number[] = new Array(labels.length).fill(0);
  let bits = packed >>> 0;
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    const size = minBitSize(Array.isArray(l) ? l.length - 1 : 2);
    out[i] = bits & ((1 << size) - 1);
    bits >>>= size;
  }
  return out;
}

/** The definition's keys for the selected layout options (base keys + chosen option keys). */
export function selectedKeys(def: ViaDefinition, options: number[]): ViaKey[] {
  const ok = def.layouts.optionKeys ?? {};
  const extra = (def.layouts.labels ?? []).flatMap((_, i) => ok[i]?.[options[i] ?? 0] ?? ok[i]?.[0] ?? []);
  return [...def.layouts.keys, ...extra];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Convert VIA keys to KeyCaps. Rotated keys keep their rotated centre (caps stay axis-aligned);
 * stepped keys (ISO / big-ass Enter) use their main rectangle; decals are dropped and encoders
 * become the knob. `index` is row * cols + col. Labels are filled in later from the keymap.
 */
export function toCaps(keys: ViaKey[], cols: number): { caps: KeyCap[]; matrix: [number, number][]; knob?: { x: number; y: number } } {
  type P = { k: ViaKey; x: number; y: number; w: number; h: number };
  const placed: P[] = [];
  for (const k of keys) {
    if (k.d) continue;
    const w = k.w ?? 1;
    const h = k.h ?? 1;
    let x = k.x;
    let y = k.y;
    const r = k.r ?? 0;
    if (r) {
      const rad = (r * Math.PI) / 180;
      const rx = k.rx ?? 0;
      const ry = k.ry ?? 0;
      const cx = x + w / 2 - rx;
      const cy = y + h / 2 - ry;
      x = rx + cx * Math.cos(rad) - cy * Math.sin(rad) - w / 2;
      y = ry + cx * Math.sin(rad) + cy * Math.cos(rad) - h / 2;
    }
    placed.push({ k, x, y, w, h });
  }
  if (!placed.length) return { caps: [], matrix: [] };
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  let knob: { x: number; y: number } | undefined;
  const caps: KeyCap[] = [];
  const matrix: [number, number][] = [];
  const seen = new Set<number>();
  for (const p of placed) {
    const x = round3(p.x - minX);
    const y = round3(p.y - minY);
    if (p.k.ei !== undefined) {
      knob ??= { x, y };
      continue;
    }
    if (p.k.row < 0 || p.k.col < 0) continue;
    const index = p.k.row * cols + p.k.col;
    if (seen.has(index)) continue;
    seen.add(index);
    caps.push({ index, label: '', x, y, w: p.w, h: p.h });
    matrix.push([p.k.row, p.k.col]);
  }
  return { caps, matrix, knob };
}

/** Generic ANSI 60% (shown when the board has no VIA definition). */
const ANSI60: [string, number][][] = [
  [['`', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['Bksp', 2]],
  [['Tab', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1], ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1.5]],
  [['Caps', 1.75], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1], ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ["'", 1], ['Enter', 2.25]],
  [['Shift', 2.25], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1], ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['Shift', 2.75]],
  [['Ctrl', 1.25], ['Win', 1.25], ['Alt', 1.25], ['Space', 6.25], ['Alt', 1.25], ['Win', 1.25], ['Menu', 1.25], ['Ctrl', 1.25]],
];
export const GENERIC_CAPS: KeyCap[] = ANSI60.flatMap((row, y) => {
  let x = 0;
  return row.map(([label, w], i) => {
    const c = { index: y * 16 + i, label, x, y, w, h: 1 };
    x += w;
    return c;
  });
});

// ---------------------------------------------------------------------------------------------
// transport

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(d: Uint8Array) => void>();
  /** set once the board's layer count + matrix are known; enables keymap writes */
  bounds: KeymapBounds | undefined;
  /** set once the macro buffer size is known; enables macro buffer reads / writes */
  macroBounds: MacroBounds | undefined;
  private readonly onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
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

  lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  /**
   * Send `p` and wait for the reply that echoes its first `echo` bytes. Throws on 0xFF
   * (command not handled by this firmware) or timeout.
   */
  xfer(p: number[], echo = p.length): Promise<Uint8Array> {
    if (!allowed(p, this.bounds, this.macroBounds)) return Promise.reject(new Error(`refusing to send ${hexs(p.slice(0, 8))}`));
    const buf = new Uint8Array(REPORT_LEN);
    buf.set(p);
    const head = Array.from(buf.subarray(0, Math.max(1, echo)));
    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (d?: Uint8Array, err?: Error) => {
        this.listeners.delete(l);
        if (timer !== undefined) clearTimeout(timer);
        if (d) resolve(d);
        else reject(err);
      };
      const l = (d: Uint8Array) => {
        if (d[0] === CMD.unhandled) done(undefined, new Error(`command ${hex2(p[0])} not supported by this firmware`));
        else if (head.every((b, i) => d[i] === b)) done(d);
      };
      this.listeners.add(l);
      timer = setTimeout(() => done(undefined, new Error(`no answer for command ${hex2(p[0])}`)), viaConfig.reply);
      this.dev.sendReport(REPORT_ID, buf).catch((e) => done(undefined, e instanceof Error ? e : new Error(String(e))));
    });
  }
}

// ---------------------------------------------------------------------------------------------
// driver

const BRANDS = ['Keychron', 'NuPhy', 'Lofree', 'Meletrix', 'Zoom', 'Mode', 'CIDOO', 'Kzzi', 'Epomaker', 'Akko',
  'Monsgeek', 'MonsGeek', 'Womier', 'Ajazz', 'Glorious', 'Drop', 'Boardsource', 'KBDfans', 'Wuque', 'Qwertykeys'];
const VID_BRANDS: Record<number, string> = { 0x3434: 'Keychron', 0x19f5: 'NuPhy' };

const text = (key: string, label: string, s: string): Setting => ({ key, label, group: 'Info', value: { kind: 'text', text: s } });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface LightState {
  chan: Channel;
  bri?: number;
  effect?: number;
  speed?: number;
  hs?: [number, number];
}

class Via implements Driver {
  readonly id: string;
  readonly family = 'VIA / QMK';
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  knob?: { x: number; y: number };

  private def: ViaDefinition | null | undefined;
  private protocol = -1;
  private light: LightState | undefined;
  /** last non-off effect, restored by "Lights on" */
  private lastEffect: number | undefined;
  private caps: KeyCap[] = GENERIC_CAPS;
  private layoutSource = 'generic ANSI 60% (no VIA definition)';
  /** full keymap as last read / written (only with a definition, so we know the matrix) */
  private km: { rows: number; cols: number; caps: KeyCap[]; layers: number[][]; codes: KeycodeSet } | undefined;
  /** macro buffer as last read / written, with each slot's raw bytes and steps */
  private mac: { count: number; size: number; format: MacroFormat; buf: Uint8Array; raw: number[][]; steps: MacroStep[][] } | undefined;

  constructor(private readonly link: Link) {
    const d = link.dev;
    this.id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
  }

  private get vpid() {
    return ((this.link.dev.vendorId << 16) | this.link.dev.productId) >>> 0;
  }

  private fullName(): string {
    return this.def?.name?.trim() || this.link.dev.productName || 'VIA keyboard';
  }

  private split(): [string | undefined, string] {
    const name = this.fullName();
    const b = BRANDS.find((x) => name.toLowerCase().startsWith(x.toLowerCase() + ' '));
    if (b) return [b, name.slice(b.length + 1).trim()];
    return [VID_BRANDS[this.link.dev.vendorId], name];
  }

  brand() {
    return (this.split()[0] ?? 'VIA').toUpperCase();
  }
  model() {
    return this.split()[1];
  }
  image() {
    return undefined;
  }
  /** The keyboard picture (definition layout with keymap legends, or the generic fallback). */
  layout(): KeyCap[] {
    return this.caps;
  }

  read(): Promise<Setting[]> {
    return this.link.lock(() => this.readInner());
  }
  write(s: Setting): Promise<void> {
    return this.link.lock(() => this.writeInner(s));
  }
  async close(): Promise<void> {
    this.link.detach();
    if (this.link.dev.opened) await this.link.dev.close();
  }

  async identify(): Promise<number> {
    const r = await this.link.xfer(protocolPkt(), 1);
    this.protocol = (r[1] << 8) | r[2];
    return this.protocol;
  }

  private async definition(): Promise<ViaDefinition | null> {
    if (this.def !== undefined) return this.def;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), viaConfig.fetchTimeout);
    try {
      const d = await viaConfig.fetch(viaConfig.definitionUrl(this.vpid), ctl.signal);
      this.def = isDefinition(d) ? d : null;
    } catch {
      this.def = null;
    } finally {
      clearTimeout(timer);
    }
    return this.def;
  }

  private async kbValue(id: number, len: number): Promise<number[]> {
    const r = await this.link.xfer(kbValuePkt(id));
    return Array.from(r.subarray(2, 2 + len));
  }

  private async customGet(ch: number, id: number, len: number): Promise<number[]> {
    const r = await this.link.xfer(customGetPkt(ch, id));
    return Array.from(r.subarray(3, 3 + len));
  }

  /** `len` bytes of the dynamic keymap buffer from `start` (28 bytes per request). */
  private async buffer(start: number, len: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(len);
    for (let at = 0; at < len; at += BUF_CHUNK) {
      const size = Math.min(BUF_CHUNK, len - at);
      const off = start + at;
      const r = await this.link.xfer(getBufferPkt(off, size));
      bytes.set(r.subarray(4, 4 + size), at);
    }
    return bytes;
  }

  /** Every layer's keycodes for `matrix` positions (one buffer read per 14 keycodes). */
  private async keycodes(rows: number, cols: number, layers: number, matrix: [number, number][]): Promise<number[][]> {
    const perLayer = rows * cols * 2;
    const bytes = await this.buffer(0, perLayer * layers);
    return Array.from({ length: layers }, (_, l) =>
      matrix.map(([r, c]) => {
        const o = keymapOffset(l, r, c, rows, cols);
        return (bytes[o] << 8) | bytes[o + 1];
      }),
    );
  }

  private async buildLayout(def: ViaDefinition | null, layers: number): Promise<void> {
    this.knob = undefined;
    this.km = undefined;
    this.link.bounds = undefined;
    if (!def) {
      this.caps = GENERIC_CAPS;
      this.layoutSource = 'generic ANSI 60% (no VIA definition)';
      return;
    }
    let options: number[] = [];
    const labels = def.layouts.labels ?? [];
    if (labels.length) {
      try {
        options = unpackLayoutOptions(be32(await this.kbValue(KV_LAYOUT_OPTIONS, 4)), labels);
      } catch {
        options = [];
      }
    }
    const { rows, cols } = def.matrix;
    const { caps, matrix, knob } = toCaps(selectedKeys(def, options), cols);
    this.knob = knob;
    const fits = rows > 0 && cols > 0 && rows <= 255 && cols <= 255 && rows * cols * 2 * Math.max(1, layers) <= MAX_KEYMAP_BYTES;
    const inMatrix = matrix.every(([r, c]) => r < rows && c < cols);
    try {
      if (!fits || !inMatrix) throw new Error('matrix out of range');
      const kcs = await this.keycodes(rows, cols, Math.max(1, layers), matrix);
      caps.forEach((c, i) => (c.label = keycodeLabel(kcs[0][i])));
      if (caps.length && layers > 0) {
        // VIA app key-to-byte tables: protocol <= 10 old (v10), 11 = v2 layout with macros at 0x7702, 12+ = v2
        const codes: KeycodeSet = this.protocol >= PROTOCOL_KEYCODES_V2 ? 'qmk-v2' : this.protocol === 11 ? 'qmk-v11' : 'qmk-v1';
        this.km = { rows, cols, caps: caps.map((c) => ({ ...c })), layers: kcs, codes };
        this.link.bounds = { layers, rows, cols };
      }
    } catch {
      // legends stay blank, no remapping
    }
    this.caps = caps;
    this.layoutSource = 'VIA definition (usevia.app)';
  }

  /** Lighting channels: from the definition, or probed when there's no definition. */
  private async channels(def: ViaDefinition | null): Promise<Map<number, Channel>> {
    if (this.protocol < PROTOCOL_V3) return new Map();
    if (def) return parseMenus(def.menus);
    const out = new Map<number, Channel>();
    for (const ch of CHANNEL_PRIORITY) {
      try {
        await this.customGet(ch, V_BRIGHTNESS, 1);
        out.set(ch, commonChannel(ch));
      } catch {
        // channel not built into this firmware
      }
    }
    return out;
  }

  private async readLight(chan: Channel): Promise<LightState> {
    const l: LightState = { chan };
    const v = chan.values;
    if (v.has(V_BRIGHTNESS)) l.bri = (await this.customGet(chan.ch, V_BRIGHTNESS, 1))[0];
    if (v.has(V_EFFECT)) l.effect = (await this.customGet(chan.ch, V_EFFECT, 1))[0];
    if (v.has(V_SPEED)) l.speed = (await this.customGet(chan.ch, V_SPEED, 1))[0];
    if (v.has(V_COLOR)) {
      const [h, s] = await this.customGet(chan.ch, V_COLOR, 2);
      l.hs = [h, s];
    }
    return l;
  }

  private async readInner(): Promise<Setting[]> {
    try {
      await this.identify();
    } catch (e) {
      throw new Error(`Keyboard isn't answering VIA commands (${e instanceof Error ? e.message : String(e)}).`);
    }
    const def = await this.definition();
    const out: Setting[] = [];
    out.push(text('model', 'Model', this.fullName()));
    out.push(text('protocol', 'VIA protocol', `${this.protocol} (0x${this.protocol.toString(16).padStart(4, '0')})`));
    try {
      const fw = be32(await this.kbValue(KV_FIRMWARE, 4));
      out.push(text('fw', 'Firmware', fw ? `0x${fw.toString(16).padStart(8, '0')}` : '0 (not set)'));
    } catch {
      // older firmware: no firmware version
    }
    let layers = 4;
    if (this.protocol >= PROTOCOL_BETA) {
      try {
        layers = (await this.link.xfer(layerCountPkt(), 1))[1];
      } catch {
        layers = 4;
      }
    }
    // QMK's layer keys reach 32 layers at most. Before protocol 9 the layer count is a guess, so
    // those boards only get legends (layer 0), no remapping.
    const keymapLayers = this.protocol >= PROTOCOL_BETA ? clamp(layers, 1, 32) : 0;
    out.push(text('layers', 'Keymap layers', String(layers)));
    try {
      const s = Math.floor(be32(await this.kbValue(KV_UPTIME, 4)) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      out.push(text('uptime', 'Uptime', h ? `${h} h ${m} min` : `${m} min ${s % 60} s`));
    } catch {
      // not answered
    }
    if (def?.matrix) out.push(text('matrix', 'Switch matrix', `${def.matrix.rows} x ${def.matrix.cols}`));

    await this.buildLayout(def, keymapLayers);
    out.push(text('layout_source', 'Layout', this.layoutSource));
    if (this.km) {
      const k = this.km;
      out.push({
        key: 'keymap',
        label: 'Keymap',
        group: 'Keys',
        value: { kind: 'keymap', keys: k.caps.map((c) => ({ ...c })), layers: k.layers.map((l) => l.slice()), codes: k.codes },
        hint: 'Changes are stored in the keyboard straight away.',
      });
    }

    // --- macros
    const macros = await this.readMacros();
    if (macros) out.push(macros);

    // --- lighting (primary channel)
    this.light = undefined;
    const chans = await this.channels(def);
    const chan = CHANNEL_PRIORITY.map((c) => chans.get(c)).find((c) => c && c.values.size);
    let solid: number | undefined;
    if (chan) {
      const l = await this.readLight(chan);
      this.light = l;
      const others = [...chans.keys()].filter((c) => c !== chan.ch).map((c) => CHANNEL_NAME[c]);
      const hint = `${CHANNEL_NAME[chan.ch]}${others.length ? ` (${others.join(', ')} not shown)` : ''}`;
      if (l.effect !== undefined) {
        const options = (chan.effects ?? DEFAULT_EFFECTS[chan.ch]).slice();
        if (!options.some(([, v]) => v === l.effect)) options.push([`Effect ${l.effect}`, l.effect]);
        if (l.effect !== 0) this.lastEffect = l.effect;
        if (chan.ch !== CH_BACKLIGHT && options.some(([, v]) => v === 0)) {
          out.push({ key: 'light_power', label: 'Lights on', group: 'Lighting', value: { kind: 'toggle', on: l.effect !== 0 } });
        }
        out.push({ key: 'light_mode', label: 'Effect', group: 'Lighting', value: { kind: 'choice', options, current: l.effect }, hint });
      }
      if (l.bri !== undefined) {
        out.push({ key: 'light_bri', label: 'Brightness', group: 'Lighting', value: { kind: 'number', min: 0, max: LEVELS, current: clamp(toLevel(l.bri, chan.briMax), 0, LEVELS), unit: '' } });
      }
      if (l.speed !== undefined) {
        out.push({ key: 'light_speed', label: 'Speed', group: 'Lighting', value: { kind: 'number', min: 0, max: LEVELS, current: clamp(toLevel(l.speed, chan.speedMax), 0, LEVELS), unit: '' } });
      }
      if (l.hs) {
        solid = hsvToRgb(l.hs[0], l.hs[1]);
        out.push({ key: 'light_color', label: 'Colour', group: 'Lighting', value: { kind: 'color', rgb: solid } });
      }
    }

    // the keyboard picture comes from layout(); VIA has no per-key colours
    return out;
  }

  /** `len` bytes of the macro buffer from `start` (28 bytes per request). */
  private async macroBuffer(start: number, len: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(len);
    for (let at = 0; at < len; at += BUF_CHUNK) {
      const size = Math.min(BUF_CHUNK, len - at);
      const r = await this.link.xfer(macroGetPkt(start + at, size), 4);
      bytes.set(r.subarray(4, 4 + size), at);
    }
    return bytes;
  }

  private macroSetting(): Setting | undefined {
    const m = this.mac;
    if (!m) return undefined;
    const busy = m.buf[m.size - 1] !== 0;
    return {
      key: 'macros',
      label: 'Macros',
      group: 'Macros',
      value: {
        kind: 'macros',
        slots: m.count,
        maxBytes: m.size,
        format: m.format,
        delays: m.format === 'qmk',
        maxDelay: MAX_DELAY,
        macros: m.steps.map((x) => x.map((s) => ({ ...s }))),
      },
      hint: busy
        ? 'The macro storage looks half-written, so the keyboard won’t play macros until they are saved again.'
        : 'Changes are stored in the keyboard straight away.',
    };
  }

  /** Every macro slot (QMK dynamic macros), or undefined when the firmware has none. */
  private async readMacros(): Promise<Setting | undefined> {
    this.mac = undefined;
    this.link.macroBounds = undefined;
    let count: number;
    let size: number;
    try {
      count = (await this.link.xfer(macroCountPkt(), 1))[1];
      const r = await this.link.xfer(macroSizePkt(), 1);
      size = (r[1] << 8) | r[2];
    } catch {
      return undefined; // firmware without dynamic macros
    }
    if (count < 1 || size < 2 || size > MAX_MACRO_BYTES) return undefined;
    this.link.macroBounds = { size };
    const format: MacroFormat = this.protocol >= PROTOCOL_MACRO_DELAYS ? 'qmk' : 'qmk-legacy';
    try {
      const buf = await this.macroBuffer(0, size);
      const raw = splitMacros(buf, count);
      this.mac = { count, size, format, buf, raw, steps: raw.map((b) => decodeMacro(b, format)) };
    } catch {
      this.link.macroBounds = undefined;
      return undefined;
    }
    return this.macroSetting();
  }

  /**
   * Rebuild the macro buffer: untouched slots keep their exact bytes, changed ones are encoded.
   * Only chunks that differ are sent; the last byte marks the write as in progress meanwhile
   * (QMK won't play macros while it's non-zero). Then the whole buffer is read back and compared.
   */
  private async writeMacros(v: Extract<Value, { kind: 'macros' }>): Promise<void> {
    const m = this.mac;
    if (!m) throw new Error('press Re-read first');
    if (v.slots !== m.count || v.macros.length !== m.count) throw new Error("macros don't match this keyboard, press Re-read");
    const same = (a: MacroStep[], b: MacroStep[]) => JSON.stringify(a) === JSON.stringify(b);
    const parts = v.macros.map((steps, i) => {
      if (same(steps, m.steps[i])) return m.raw[i];
      try {
        return encodeMacro(steps, m.format);
      } catch (e) {
        throw new Error(`M${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const data = parts.flatMap((b) => [...b, 0]);
    if (data.length > m.size) throw new Error(`macros need ${data.length} bytes, the keyboard has room for ${m.size}`);
    const want = new Uint8Array(m.size);
    want.set(data);
    const last = m.size - 1;
    const chunks: number[] = [];
    for (let at = 0; at < last; at += BUF_CHUNK) {
      const end = Math.min(last, at + BUF_CHUNK);
      for (let i = at; i < end; i++) {
        if (want[i] !== m.buf[i]) {
          chunks.push(at);
          break;
        }
      }
    }
    if (!chunks.length && m.buf[last] === 0) return;
    try {
      await this.link.xfer(macroSetPkt(last, [0xff]), 4);
      for (const at of chunks) await this.link.xfer(macroSetPkt(at, want.subarray(at, Math.min(last, at + BUF_CHUNK))), 4);
    } finally {
      await this.link.xfer(macroSetPkt(last, [0]), 4);
    }
    const back = await this.macroBuffer(0, m.size);
    const raw = splitMacros(back, m.count);
    this.mac = { ...m, buf: back, raw, steps: raw.map((b) => decodeMacro(b, m.format)) };
    const bad = back.findIndex((b, i) => b !== want[i]);
    if (bad >= 0) throw new Error(`keyboard didn't take the macro change (byte ${bad} reads back 0x${back[bad].toString(16).padStart(2, '0')})`);
  }

  private async setValue(id: number, data: number[]): Promise<void> {
    const l = this.light;
    if (!l || !l.chan.values.has(id)) throw new Error('press Re-read first');
    await this.link.xfer(customSetPkt(l.chan.ch, id, ...data), 3);
    await this.link.xfer(customSavePkt(l.chan.ch), 2);
  }

  /** Write, read back, and complain when the board didn't take it. */
  private async writeChecked(id: number, data: number[], same: (got: number[]) => boolean, what: string): Promise<void> {
    const l = this.light!;
    await this.setValue(id, data);
    const got = await this.customGet(l.chan.ch, id, data.length);
    if (id === V_BRIGHTNESS) l.bri = got[0];
    if (id === V_EFFECT) l.effect = got[0];
    if (id === V_SPEED) l.speed = got[0];
    if (id === V_COLOR) l.hs = [got[0], got[1]];
    if (!same(got)) throw new Error(`keyboard didn't take the ${what} change (reads back ${got.join(', ')})`);
  }

  private async writeEffect(e: number): Promise<void> {
    await this.writeChecked(V_EFFECT, [e], (g) => g[0] === e, 'effect');
    if (e !== 0) this.lastEffect = e;
  }

  private async writeColor(rgb: number): Promise<void> {
    const [h, s] = rgbToHs(rgb);
    const near = (a: number, b: number) => Math.min(Math.abs(a - b), 256 - Math.abs(a - b)) <= 1;
    await this.writeChecked(V_COLOR, [h, s], (g) => near(g[0], h) && Math.abs(g[1] - s) <= 1, 'colour');
  }

  /** Write the keys that differ from what the board holds, one set-keycode each, reading each back. */
  private async writeKeymap(v: Extract<Value, { kind: 'keymap' }>): Promise<void> {
    const k = this.km;
    if (!k) throw new Error('press Re-read first');
    if (v.codes !== k.codes || v.layers.length !== k.layers.length || v.keys.length !== k.caps.length) {
      throw new Error("keymap doesn't match this keyboard, press Re-read");
    }
    v.keys.forEach((c, i) => {
      if (c.index !== k.caps[i].index) throw new Error("keymap doesn't match this keyboard, press Re-read");
    });
    for (let l = 0; l < k.layers.length; l++) {
      const want = v.layers[l];
      if (want.length !== k.caps.length) throw new Error("keymap doesn't match this keyboard, press Re-read");
      for (let i = 0; i < want.length; i++) {
        const kc = want[i];
        if (kc === k.layers[l][i]) continue;
        if (!Number.isInteger(kc) || kc < 0 || kc > 0xffff) throw new Error(`bad keycode ${kc}`);
        const idx = k.caps[i].index;
        const row = Math.floor(idx / k.cols);
        const col = idx % k.cols;
        await this.link.xfer(setKeycodePkt(l, row, col, kc), 6);
        const back = await this.buffer(keymapOffset(l, row, col, k.rows, k.cols), 2);
        const got = (back[0] << 8) | back[1];
        k.layers[l][i] = got;
        if (l === 0) this.caps = this.caps.map((c) => (c.index === idx ? { ...c, label: keycodeLabel(got) } : c));
        if (got !== kc) {
          throw new Error(`keyboard didn't take the key change (layer ${l}, reads back 0x${got.toString(16).padStart(4, '0')})`);
        }
      }
    }
  }

  private async writeInner(s: Setting): Promise<void> {
    const l = this.light;
    const v = s.value;
    if (s.key === 'keymap' && v.kind === 'keymap') return this.writeKeymap(v);
    if (s.key === 'macros' && v.kind === 'macros') return this.writeMacros(v);
    if (!l) throw new Error(`${s.key} can't be changed`);
    switch (`${s.key}:${v.kind}`) {
      case 'light_mode:choice': {
        const c = v as Extract<Value, { kind: 'choice' }>;
        const known = (l!.chan.effects ?? DEFAULT_EFFECTS[l!.chan.ch]).some(([, x]) => x === c.current) || c.current === l!.effect;
        if (!known) throw new Error('unknown effect');
        return this.writeEffect(c.current & 0xff);
      }
      case 'light_power:toggle': {
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        return this.writeEffect(on ? (this.lastEffect ?? 1) : 0);
      }
      case 'light_bri:number': {
        const n = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, LEVELS);
        const max = l!.chan.briMax;
        return this.writeChecked(V_BRIGHTNESS, [fromLevel(n, max)], (g) => toLevel(g[0], max) === n, 'brightness');
      }
      case 'light_speed:number': {
        const n = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, LEVELS);
        const max = l!.chan.speedMax;
        return this.writeChecked(V_SPEED, [fromLevel(n, max)], (g) => toLevel(g[0], max) === n, 'speed');
      }
      case 'light_color:color':
        return this.writeColor((v as Extract<Value, { kind: 'color' }>).rgb);
      default:
        throw new Error(`${s.key} can't be changed`);
    }
  }
}

export const viaFactory: DriverFactory = {
  name: 'VIA',
  filters: [{ usagePage: USAGE_PAGE, usage: USAGE }],
  match(d: HIDDevice): boolean {
    const id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    if (EXCLUDED_VIDS.has(d.vendorId) || EXCLUDED_IDS.has(id)) return false;
    return (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!viaFactory.match(device)) return null;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const link = new Link(device);
    const drv = new Via(link);
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
