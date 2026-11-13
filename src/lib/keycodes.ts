// QMK keycode catalogue: short keycap legends, descriptions and picker categories.
//
// Sources: qmk_firmware quantum/keycodes.h (keycodes v2, QMK 0.19+ / VIA protocol 12+) and the
// pre-0.19 quantum_keycodes.h (v1, as the-via/app key-to-byte v10 tables). The basic HID range
// (0x00-0xE7) is the same in both; media/mouse keys and layer keys moved.
// Codes we don't know are shown as hex and never changed.

import type { ExtraCategory, ExtraKeycode, KeycodeSet } from '../drivers/types';

export type { ExtraCategory, ExtraKeycode, KeycodeSet };

export interface Keycode {
  code: number;
  /** QMK name, e.g. KC_A or MO(1) (accepted by parse()) */
  id: string;
  /** short keycap legend ('' for KC_NO) */
  label: string;
  /** what it does, for the picker and tooltips */
  name: string;
  /** layer keys: the layer they act on */
  layer?: number;
  /** macro keys: the macro slot they play */
  macro?: number;
}

export interface Category {
  id: string;
  name: string;
  codes: Keycode[];
}

type Cat = 'basic' | 'symbols' | 'mods' | 'nav' | 'fkeys' | 'numpad' | 'media' | 'mouse';
const CAT_NAMES: [Cat | 'layers', string][] = [
  ['basic', 'Basic'], ['symbols', 'Symbols'], ['mods', 'Mods'], ['nav', 'Nav'], ['fkeys', 'F keys'],
  ['numpad', 'Numpad'], ['media', 'Media'], ['mouse', 'Mouse'], ['layers', 'Layers'],
];

interface Def extends Keycode {
  cat: Cat;
}

export const KC_NO = 0x00;
export const KC_TRNS = 0x01;
export const KC_SPC = 0x2c;

export const hexCode = (kc: number) => '0x' + (kc & 0xffff).toString(16).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------------------------------------
// tables

function basics(): Def[] {
  const d: Def[] = [];
  const add = (code: number, id: string, label: string, name: string, cat: Cat) => d.push({ code, id, label, name, cat });
  add(KC_NO, 'KC_NO', '', 'None (key does nothing)', 'basic');
  add(KC_TRNS, 'KC_TRNS', '▽', 'Transparent (uses the layer below)', 'basic');
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    add(0x04 + i, `KC_${c}`, c, c, 'basic');
  }
  for (let i = 1; i <= 10; i++) add(0x1d + i, `KC_${i % 10}`, String(i % 10), String(i % 10), 'basic');
  const rows: [number, string, string, string, Cat][] = [
    [0x28, 'KC_ENT', 'Enter', 'Enter', 'basic'],
    [0x29, 'KC_ESC', 'Esc', 'Escape', 'basic'],
    [0x2a, 'KC_BSPC', 'Bksp', 'Backspace', 'basic'],
    [0x2b, 'KC_TAB', 'Tab', 'Tab', 'basic'],
    [0x2c, 'KC_SPC', 'Space', 'Space', 'basic'],
    [0x2d, 'KC_MINS', '-', 'Minus -', 'basic'],
    [0x2e, 'KC_EQL', '=', 'Equals =', 'basic'],
    [0x2f, 'KC_LBRC', '[', 'Left bracket [', 'basic'],
    [0x30, 'KC_RBRC', ']', 'Right bracket ]', 'basic'],
    [0x31, 'KC_BSLS', '\\', 'Backslash \\', 'basic'],
    [0x32, 'KC_NUHS', 'ISO #', 'ISO # (non-US hash)', 'basic'],
    [0x33, 'KC_SCLN', ';', 'Semicolon ;', 'basic'],
    [0x34, 'KC_QUOT', "'", "Quote '", 'basic'],
    [0x35, 'KC_GRV', '`', 'Grave `', 'basic'],
    [0x36, 'KC_COMM', ',', 'Comma ,', 'basic'],
    [0x37, 'KC_DOT', '.', 'Dot .', 'basic'],
    [0x38, 'KC_SLSH', '/', 'Slash /', 'basic'],
    [0x39, 'KC_CAPS', 'Caps', 'Caps Lock', 'basic'],
    [0x64, 'KC_NUBS', 'ISO \\', 'ISO \\ (non-US backslash)', 'basic'],
    [0x46, 'KC_PSCR', 'PrtSc', 'Print Screen', 'nav'],
    [0x47, 'KC_SCRL', 'ScrLk', 'Scroll Lock', 'nav'],
    [0x48, 'KC_PAUS', 'Pause', 'Pause / Break', 'nav'],
    [0x49, 'KC_INS', 'Ins', 'Insert', 'nav'],
    [0x4a, 'KC_HOME', 'Home', 'Home', 'nav'],
    [0x4b, 'KC_PGUP', 'PgUp', 'Page Up', 'nav'],
    [0x4c, 'KC_DEL', 'Del', 'Delete', 'nav'],
    [0x4d, 'KC_END', 'End', 'End', 'nav'],
    [0x4e, 'KC_PGDN', 'PgDn', 'Page Down', 'nav'],
    [0x4f, 'KC_RGHT', 'Right', 'Right arrow', 'nav'],
    [0x50, 'KC_LEFT', 'Left', 'Left arrow', 'nav'],
    [0x51, 'KC_DOWN', 'Down', 'Down arrow', 'nav'],
    [0x52, 'KC_UP', 'Up', 'Up arrow', 'nav'],
    [0x65, 'KC_APP', 'Menu', 'Menu (application key)', 'nav'],
    [0x53, 'KC_NUM', 'Num', 'Num Lock', 'numpad'],
    [0x54, 'KC_PSLS', '/', 'Numpad /', 'numpad'],
    [0x55, 'KC_PAST', '*', 'Numpad *', 'numpad'],
    [0x56, 'KC_PMNS', '-', 'Numpad -', 'numpad'],
    [0x57, 'KC_PPLS', '+', 'Numpad +', 'numpad'],
    [0x58, 'KC_PENT', 'Enter', 'Numpad Enter', 'numpad'],
    [0x63, 'KC_PDOT', '.', 'Numpad .', 'numpad'],
    [0x67, 'KC_PEQL', '=', 'Numpad =', 'numpad'],
    [0xe0, 'KC_LCTL', 'Ctrl', 'Left Ctrl', 'mods'],
    [0xe1, 'KC_LSFT', 'Shift', 'Left Shift', 'mods'],
    [0xe2, 'KC_LALT', 'Alt', 'Left Alt', 'mods'],
    [0xe3, 'KC_LGUI', 'Win', 'Left Win / Cmd', 'mods'],
    [0xe4, 'KC_RCTL', 'Ctrl', 'Right Ctrl', 'mods'],
    [0xe5, 'KC_RSFT', 'Shift', 'Right Shift', 'mods'],
    [0xe6, 'KC_RALT', 'Alt', 'Right Alt / AltGr', 'mods'],
    [0xe7, 'KC_RGUI', 'Win', 'Right Win / Cmd', 'mods'],
  ];
  for (const r of rows) add(...r);
  for (let i = 1; i <= 9; i++) add(0x58 + i, `KC_P${i}`, String(i), `Numpad ${i}`, 'numpad');
  add(0x62, 'KC_P0', '0', 'Numpad 0', 'numpad');
  for (let i = 1; i <= 12; i++) add(0x39 + i, `KC_F${i}`, `F${i}`, `F${i}`, 'fkeys');
  for (let i = 13; i <= 24; i++) add(0x5b + i, `KC_F${i}`, `F${i}`, `F${i}`, 'fkeys');
  // consumer / system keys (same codes in v1 and v2)
  const media: [number, string, string, string][] = [
    [0xa8, 'KC_MUTE', 'Mute', 'Mute'],
    [0xa9, 'KC_VOLU', 'Vol+', 'Volume up'],
    [0xaa, 'KC_VOLD', 'Vol-', 'Volume down'],
    [0xae, 'KC_MPLY', 'Play', 'Play / pause'],
    [0xab, 'KC_MNXT', 'Next', 'Next track'],
    [0xac, 'KC_MPRV', 'Prev', 'Previous track'],
    [0xad, 'KC_MSTP', 'Stop', 'Stop'],
    [0xbb, 'KC_MFFD', 'FFwd', 'Fast forward'],
    [0xbc, 'KC_MRWD', 'Rew', 'Rewind'],
    [0xaf, 'KC_MSEL', 'Media', 'Open media player'],
    [0xb0, 'KC_EJCT', 'Eject', 'Eject'],
    [0xbd, 'KC_BRIU', 'Bri+', 'Screen brightness up'],
    [0xbe, 'KC_BRID', 'Bri-', 'Screen brightness down'],
    [0xb1, 'KC_MAIL', 'Mail', 'Open mail'],
    [0xb2, 'KC_CALC', 'Calc', 'Open calculator'],
    [0xb3, 'KC_MYCM', 'My PC', 'Open My Computer'],
    [0xb4, 'KC_WSCH', 'Search', 'Browser search'],
    [0xb5, 'KC_WHOM', 'WHome', 'Browser home'],
    [0xb6, 'KC_WBAK', 'Back', 'Browser back'],
    [0xb7, 'KC_WFWD', 'Fwd', 'Browser forward'],
    [0xb8, 'KC_WSTP', 'WStop', 'Browser stop'],
    [0xb9, 'KC_WREF', 'Rfrsh', 'Browser refresh'],
    [0xba, 'KC_WFAV', 'Fav', 'Browser favourites'],
    [0xa5, 'KC_PWR', 'Power', 'System power'],
    [0xa6, 'KC_SLEP', 'Sleep', 'System sleep'],
    [0xa7, 'KC_WAKE', 'Wake', 'System wake'],
  ];
  for (const [c, id, l, n] of media) add(c, id, l, n, 'media');
  return d;
}

/** keys that differ between the two numberings */
function extras(set: KeycodeSet): Def[] {
  const d: Def[] = [];
  const add = (code: number, id: string, label: string, name: string, cat: Cat) => d.push({ code, id, label, name, cat });
  const v2 = set !== 'qmk-v1';
  if (v2) {
    add(0xbf, 'KC_CPNL', 'Ctrl P', 'Open control panel', 'media');
    add(0xc0, 'KC_ASST', 'Asst', 'Assistant', 'media');
    add(0xc1, 'KC_MCTL', 'MCtl', 'Mission Control (macOS)', 'media');
    add(0xc2, 'KC_LPAD', 'LPad', 'Launchpad (macOS)', 'media');
  }
  const m = v2 ? 0xcd : 0xf0;
  add(m, 'KC_MS_U', 'Ms Up', 'Mouse cursor up', 'mouse');
  add(m + 1, 'KC_MS_D', 'Ms Dn', 'Mouse cursor down', 'mouse');
  add(m + 2, 'KC_MS_L', 'Ms Lt', 'Mouse cursor left', 'mouse');
  add(m + 3, 'KC_MS_R', 'Ms Rt', 'Mouse cursor right', 'mouse');
  const buttons = v2 ? 8 : 5;
  for (let i = 0; i < buttons; i++) add(m + 4 + i, `KC_BTN${i + 1}`, `Btn${i + 1}`, `Mouse button ${i + 1}`, 'mouse');
  const w = m + 4 + buttons;
  add(w, 'KC_WH_U', 'Wh Up', 'Mouse wheel up', 'mouse');
  add(w + 1, 'KC_WH_D', 'Wh Dn', 'Mouse wheel down', 'mouse');
  add(w + 2, 'KC_WH_L', 'Wh Lt', 'Mouse wheel left', 'mouse');
  add(w + 3, 'KC_WH_R', 'Wh Rt', 'Mouse wheel right', 'mouse');
  for (let i = 0; i < 3; i++) add(w + 4 + i, `KC_ACL${i}`, `Acl${i}`, `Mouse speed ${i}`, 'mouse');
  return d;
}

/** Shift + key, offered as their own keys (QMK KC_EXLM etc.). */
const SHIFTED: [number, string, string][] = [
  [0x1e, 'KC_EXLM', '!'], [0x1f, 'KC_AT', '@'], [0x20, 'KC_HASH', '#'], [0x21, 'KC_DLR', '$'], [0x22, 'KC_PERC', '%'],
  [0x23, 'KC_CIRC', '^'], [0x24, 'KC_AMPR', '&'], [0x25, 'KC_ASTR', '*'], [0x26, 'KC_LPRN', '('], [0x27, 'KC_RPRN', ')'],
  [0x2d, 'KC_UNDS', '_'], [0x2e, 'KC_PLUS', '+'], [0x2f, 'KC_LCBR', '{'], [0x30, 'KC_RCBR', '}'], [0x31, 'KC_PIPE', '|'],
  [0x33, 'KC_COLN', ':'], [0x34, 'KC_DQUO', '"'], [0x35, 'KC_TILD', '~'], [0x36, 'KC_LABK', '<'], [0x37, 'KC_RABK', '>'],
  [0x38, 'KC_QUES', '?'],
];
const LSFT = 0x02;

const tables = new Map<KeycodeSet, { list: Def[]; byCode: Map<number, Def>; byId: Map<string, Def> }>();
function table(set: KeycodeSet) {
  let t = tables.get(set);
  if (!t) {
    const list = [...basics(), ...extras(set)];
    for (const [k, id, l] of SHIFTED) {
      const base = list.find((d) => d.code === k)!;
      list.push({ code: (LSFT << 8) | k, id, label: l, name: `${l} (Shift + ${base.label})`, cat: 'symbols' });
    }
    const byCode = new Map(list.map((d) => [d.code, d]));
    const byId = new Map(list.map((d) => [d.id.toUpperCase(), d]));
    tables.set(set, (t = { list, byCode, byId }));
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// layer keys

export const LAYER_FNS = ['MO', 'TG', 'TO', 'TT', 'OSL', 'DF'] as const;
export type LayerFn = (typeof LAYER_FNS)[number] | 'LT';

const LAYER_NAME: Record<(typeof LAYER_FNS)[number], (l: number) => string> = {
  MO: (l) => `Layer ${l} while held`,
  TG: (l) => `Toggle layer ${l} on / off`,
  TO: (l) => `Switch to layer ${l}`,
  TT: (l) => `Layer ${l} while held, tap a few times to lock it`,
  OSL: (l) => `Layer ${l} for the next key press`,
  DF: (l) => `Make layer ${l} the default layer`,
};

// v2: 32 codes per function (layer in the low 5 bits)
const V2_BASE: Record<(typeof LAYER_FNS)[number], number> = { TO: 0x5200, MO: 0x5220, DF: 0x5240, TG: 0x5260, OSL: 0x5280, TT: 0x52c0 };
// v1: 256 codes per function (TO(l) = 0x5010 | l: "on press" flag in bit 4)
const V1_BASE: Record<(typeof LAYER_FNS)[number], number> = { TO: 0x5010, MO: 0x5100, DF: 0x5200, TG: 0x5300, OSL: 0x5400, TT: 0x5800 };

/** Highest layer number a layer function can encode. */
export function maxLayer(fn: LayerFn, set: KeycodeSet): number {
  if (fn === 'LT') return 15;
  if (set !== 'qmk-v1') return 31;
  return fn === 'TO' ? 15 : fn === 'TT' ? 31 : 255;
}

/** Keycode of a layer key, e.g. layerKey('MO', 1) or layerKey('LT', 2, set, KC_SPC). */
export function layerKey(fn: LayerFn, layer: number, set: KeycodeSet = 'qmk-v2', tap = KC_SPC): number {
  const l = Math.max(0, Math.min(maxLayer(fn, set), Math.floor(layer)));
  if (fn === 'LT') return 0x4000 | (l << 8) | (tap & 0xff);
  return (set !== 'qmk-v1' ? V2_BASE : V1_BASE)[fn] | l;
}

/** The layer function a keycode is, if any. */
export function decodeLayer(kc: number, set: KeycodeSet = 'qmk-v2'): { fn: LayerFn; layer: number; tap?: number } | undefined {
  if (kc >= 0x4000 && kc <= 0x4fff) return { fn: 'LT', layer: (kc >> 8) & 0xf, tap: kc & 0xff };
  if (set !== 'qmk-v1') {
    for (const fn of LAYER_FNS) if (kc >= V2_BASE[fn] && kc < V2_BASE[fn] + 32) return { fn, layer: kc & 0x1f };
    return undefined;
  }
  if (kc >= 0x5010 && kc <= 0x501f) return { fn: 'TO', layer: kc & 0xf };
  for (const fn of LAYER_FNS) {
    if (fn === 'TO') continue;
    const span = fn === 'TT' ? 32 : 256;
    if (kc >= V1_BASE[fn] && kc < V1_BASE[fn] + span) return { fn, layer: kc & (span - 1) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// macro keys (QK_MACRO): play dynamic macro n. v2 (quantum/keycodes.h): QK_MACRO 0x7700-0x777F;
// v1 (VIA's v10 key table, the pre-0.19 VIA user range): 0x5F12-0x5F21.

const MACRO_BASE: Record<KeycodeSet, number> = { 'qmk-v2': 0x7700, 'qmk-v11': 0x7702, 'qmk-v1': 0x5f12 };
/** How many macro keys each numbering has. */
export const MACRO_KEYS: Record<KeycodeSet, number> = { 'qmk-v2': 128, 'qmk-v11': 16, 'qmk-v1': 16 };

/** Keycode that plays macro n (undefined past the numbering's last macro key). */
export function macroKey(n: number, set: KeycodeSet = 'qmk-v2'): number | undefined {
  return Number.isInteger(n) && n >= 0 && n < MACRO_KEYS[set] ? MACRO_BASE[set] + n : undefined;
}

/** The macro slot a keycode plays, if it is a macro key. */
export function decodeMacroKey(kc: number, set: KeycodeSet = 'qmk-v2'): number | undefined {
  const n = kc - MACRO_BASE[set];
  return n >= 0 && n < MACRO_KEYS[set] ? n : undefined;
}

// ---------------------------------------------------------------------------------------------
// modifiers inside keycodes (mods are a 5-bit field: Ctrl 1, Shift 2, Alt 4, Gui 8, 0x10 = right hand)

const MOD_BITS: [number, string, string, string][] = [[1, 'Ctrl', 'Ctl', 'C'], [2, 'Shift', 'Sft', 'S'], [4, 'Alt', 'Alt', 'A'], [8, 'Win', 'Win', 'G']];
function mods(m: number): { short: string; long: string } {
  const parts = MOD_BITS.filter(([b]) => m & b);
  const right = m & 0x10 ? 'R' : '';
  const short = parts.length === 1 ? right + parts[0][2] : right + parts.map((p) => p[3]).join('');
  const long = (right ? 'Right ' : '') + parts.map((p) => p[1]).join(' + ');
  return { short, long: long || 'no modifier' };
}

/** Basic key inside a composite keycode. */
function inner(k: number, set: KeycodeSet): { label: string; name: string } {
  const d = table(set).byCode.get(k & 0xff);
  if (d && k !== KC_NO) return { label: d.label, name: d.name };
  return { label: hexCode(k & 0xff).replace('0x00', '0x'), name: `key ${hexCode(k & 0xff)}` };
}

type Decoded = { label: string; name: string };

function decode(kc: number, set: KeycodeSet): Decoded | undefined {
  kc &= 0xffff;
  const d = table(set).byCode.get(kc);
  if (d) return d;
  const v2 = set !== 'qmk-v1';
  const mac = decodeMacroKey(kc, set);
  if (mac !== undefined) return { label: `M${mac}`, name: `Play macro M${mac}` };
  // Ctrl+C style combos
  if (kc >= 0x0100 && kc <= 0x1fff) {
    const m = mods((kc >> 8) & 0x1f);
    const k = inner(kc, set);
    return { label: `${m.short}+${k.label}`, name: `${m.long} + ${k.name}` };
  }
  // mod-tap
  if ((v2 && kc >= 0x2000 && kc <= 0x3fff) || (!v2 && kc >= 0x6000 && kc <= 0x7fff)) {
    const m = mods((kc >> 8) & 0x1f);
    const k = inner(kc, set);
    return { label: `${k.label}/${m.short}`, name: `${k.name} when tapped, ${m.long} when held` };
  }
  const l = decodeLayer(kc, set);
  if (l) {
    if (l.fn === 'LT') {
      const k = inner(l.tap!, set);
      return { label: `${k.label}/L${l.layer}`, name: `${k.name} when tapped, layer ${l.layer} while held` };
    }
    return { label: `${l.fn}${l.layer}`, name: LAYER_NAME[l.fn](l.layer) };
  }
  // one-shot mod and layer + mod
  if (v2 ? kc >= 0x52a0 && kc <= 0x52bf : kc >= 0x5500 && kc <= 0x55ff) {
    const m = mods(kc & 0x1f);
    return { label: `OS ${m.short}`, name: `${m.long} for the next key press` };
  }
  if (v2 ? kc >= 0x5000 && kc <= 0x51ff : kc >= 0x5900 && kc <= 0x59ff) {
    const layer = v2 ? (kc >> 5) & 0xf : (kc >> 4) & 0xf;
    const m = mods(v2 ? kc & 0x1f : kc & 0xf);
    return { label: `LM${layer}`, name: `Layer ${layer} with ${m.long} while held` };
  }
  return undefined;
}

/** A driver-specific code from a keymap's `extra` categories (they win over the QMK meaning). */
function extraCode(kc: number, extra?: ExtraCategory[]): ExtraKeycode | undefined {
  if (!extra) return undefined;
  for (const c of extra) {
    const k = c.codes.find((x) => x.code === kc);
    if (k) return k;
  }
  return undefined;
}

/** Short keycap legend. Unknown codes come back as hex. */
export function label(kc: number, set: KeycodeSet = 'qmk-v2', extra?: ExtraCategory[]): string {
  return (extraCode(kc, extra) ?? decode(kc, set))?.label ?? hexCode(kc);
}

/** One-line description of what the key does. */
export function describe(kc: number, set: KeycodeSet = 'qmk-v2', extra?: ExtraCategory[]): string {
  return (extraCode(kc, extra) ?? decode(kc, set))?.name ?? `Keycode ${hexCode(kc)} (not in our list, kept as it is)`;
}

/** Is this a code the catalogue (or the keymap's own extra codes) understands? */
export const known = (kc: number, set: KeycodeSet = 'qmk-v2', extra?: ExtraCategory[]) =>
  extraCode(kc, extra) !== undefined || decode(kc, set) !== undefined;

/** What a keymap offers beyond / instead of the full QMK catalogue. */
export interface PickerOpts {
  /** driver-specific categories (hidden ones are left out of the picker) */
  extra?: ExtraCategory[];
  /** QMK category ids to offer (default all) */
  cats?: string[];
}

/**
 * Keycode from text: a QMK name (KC_A, A, KC_EXLM, MO(1), LT(2, KC_SPC)) or hex (0x7C00).
 * Undefined when it isn't one.
 */
export function parse(text: string, set: KeycodeSet = 'qmk-v2'): number | undefined {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return undefined;
  if (/^0X[0-9A-F]{1,4}$/.test(t)) return parseInt(t.slice(2), 16);
  const { byId } = table(set);
  const d = byId.get(t) ?? byId.get(`KC_${t}`);
  if (d) return d.code;
  const lf = t.match(/^(MO|TG|TO|TT|OSL|DF)\((\d+)\)$/);
  if (lf) {
    const fn = lf[1] as (typeof LAYER_FNS)[number];
    const l = Number(lf[2]);
    return l <= maxLayer(fn, set) ? layerKey(fn, l, set) : undefined;
  }
  const mc = t.match(/^(?:MC_|M|QK_MACRO_|MACRO\(?)(\d+)\)?$/);
  if (mc) return macroKey(Number(mc[1]), set);
  const lt = t.match(/^LT\((\d+),(.+)\)$/);
  if (lt) {
    const tap = parse(lt[2], set);
    const l = Number(lt[1]);
    return tap !== undefined && tap < 0x100 && l <= 15 ? layerKey('LT', l, set, tap) : undefined;
  }
  return undefined;
}

/** QMK name for a code (inverse of parse); hex when unknown. */
export function idOf(kc: number, set: KeycodeSet = 'qmk-v2'): string {
  const d = table(set).byCode.get(kc);
  if (d) return d.id;
  const mac = decodeMacroKey(kc, set);
  if (mac !== undefined) return `MC_${mac}`;
  const l = decodeLayer(kc, set);
  if (l) return l.fn === 'LT' ? `LT(${l.layer},${idOf(l.tap!, set)})` : `${l.fn}(${l.layer})`;
  return hexCode(kc);
}

/**
 * Picker categories. Layer keys are listed for layers 0..layers-1; layer-tap keys tap `tap`
 * (a basic keycode, e.g. what the key sends on layer 0). A 'Macros' category lists M0..M(macros-1)
 * when the keyboard has macro slots.
 */
export function categories(set: KeycodeSet = 'qmk-v2', layers = 4, tap = KC_SPC, macros = 0, opts: PickerOpts = {}): Category[] {
  const { list } = table(set);
  const t = tap > KC_TRNS && tap < 0x100 && table(set).byCode.has(tap) ? tap : KC_SPC;
  const layerCodes: Keycode[] = [];
  for (let l = 0; l < layers; l++) {
    for (const fn of [...LAYER_FNS, 'LT'] as LayerFn[]) {
      if (l > maxLayer(fn, set)) continue;
      const code = layerKey(fn, l, set, t);
      layerCodes.push({ code, id: idOf(code, set), label: label(code, set), name: describe(code, set), layer: l });
    }
  }
  const out: Category[] = CAT_NAMES.map(([id, name]) => ({
    id,
    name,
    codes: id === 'layers' ? layerCodes : list.filter((d) => d.cat === id).map(({ cat: _cat, ...k }) => k),
  }));
  const n = Math.min(Math.max(0, Math.floor(macros)), MACRO_KEYS[set]);
  if (n > 0) {
    const codes: Keycode[] = [];
    for (let m = 0; m < n; m++) {
      const code = macroKey(m, set)!;
      codes.push({ code, id: idOf(code, set), label: label(code, set), name: describe(code, set), macro: m });
    }
    out.push({ id: 'macros', name: 'Macros', codes });
  }
  const shown = opts.cats ? out.filter((c) => opts.cats!.includes(c.id) || c.id === 'macros') : out;
  for (const c of opts.extra ?? []) {
    if (!c.hidden && c.codes.length) shown.push({ id: c.id, name: c.name, codes: c.codes.map((k) => ({ ...k })) });
  }
  return shown;
}

/** Search every category (name, legend or QMK id); a typed hex code or QMK name is offered too. */
export function search(query: string, set: KeycodeSet = 'qmk-v2', layers = 4, tap = KC_SPC, macros = 0, opts: PickerOpts = {}): Keycode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<number>();
  const out: Keycode[] = [];
  const push = (k: Keycode) => {
    if (seen.has(k.code)) return;
    seen.add(k.code);
    out.push(k);
  };
  const cats = categories(set, layers, tap, macros, opts);
  const exact = parse(query, set);
  // a typed QMK name / hex code is only offered when the device can send that kind of key
  const offered = exact !== undefined && (!opts.cats || cats.some((c) => c.codes.some((k) => k.code === exact)));
  if (exact !== undefined && offered) push({ code: exact, id: idOf(exact, set), label: label(exact, set, opts.extra), name: describe(exact, set, opts.extra) });
  for (const c of cats) {
    for (const k of c.codes) {
      if (k.label.toLowerCase() === q || k.id.toLowerCase() === q) push(k);
    }
  }
  for (const c of cats) {
    for (const k of c.codes) {
      if (k.name.toLowerCase().includes(q) || k.id.toLowerCase().includes(q) || k.label.toLowerCase().includes(q)) push(k);
    }
  }
  return out;
}
