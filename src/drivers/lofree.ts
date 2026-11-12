// Lofree Hyzen (65% mechanical / magnetic "TMR Nexus" hybrid keyboard), VID 388D.
// Ported from Lofree's own web configurator "Lofree HUB" (hyzen.lofree.tech, linked from
// lofree.co/pages/download-center), whose device table lists:
//   PID 0x0024 HYZEN wired, 0x0025 HYZEN 2.4G receiver, 0x0029 HYZEN wired-only ("single"),
//   all on vendor usage page 0xFF1C usage 0x92. (Internal model code OE930.)
// Not VIA/QMK, and not the Wraith/AULA "Online Keyboard Driver" protocol either.
//
// Transport: output/input report ID 4, 63 bytes (31 via the 2.4G receiver). Every command is a
// transaction:  START [00 00 01 (18)] -> reply d2=01,  data frames
// [00 00 cmd len offLo offHi 00 data...] each answered by an echo (d2=cmd|0, d4/d5=offset,
// data from d7),  END [00 00 02 (18)] -> reply d2=02.  Reads put 18 in byte 3 of START/END.
// No checksum. Data is addressed by byte offset into per-command tables:
//   05/06 read/write function area (64 bytes per profile; byte 0 = active profile)
//   07    default key matrix (128 keys x 3-byte keycode) -> the key index of every switch
//   28/29 keyboard / receiver firmware version
//   60    travel spec (u16 LE: min travel um, max travel um, ...)
//   61    per-key calibrated full-travel raw value (u16, low 14 bits)
//   5c/4c per-key actuation word (u16: bit15 deadzone, bit14 rapid trigger, low 14 bits raw)
//   58/48 per-key rapid trigger (u16 press raw, u16 release raw)
//   63    live travel test on/off (samples arrive on report 6)
//   67/66 key type table (1 byte per key, 128 per profile): 20 normal, 24 DKS, 25 RS, 26 SOCD, 27 HT
//   56/46 SOCD table (4 bytes per key, 512 per profile): [partner, prio<<4 | slot<<3 | rt, travel u16]
//   1B    LED location (1 byte per key index = its LED index), read once at start-up (READ_DEFAULT_LIGHT)
//   21    LED colours (ledLength 480 = 160 LEDs x R,G,B; LEDs 70..159 = side light strip, bytes 210..479).
//         The official pollLedColor reads it for the on-screen preview, but the shipped app has it
//         switched off (`const ok=!1`), so it is only used by diagnose().
// Per-key colours: the Hyzen has none. Lofree HUB has no write for 1B/21 or any other colour table,
// and every main-backlight effect (00..0B) is a whole-board effect with one colour or rainbow,
// set through the function area (06). Only diagnose() reads 1B/21.
//
// NEVER send: 0D (factory reset), 40/44/50 (calibration), 1a / AA, firmware update (other
// interfaces), or any write not listed in `allowed()`. Every frame is checked by `allowed()`.

import type { Driver, DriverFactory, KeyCap, Setting, Socd, Value } from './types';
import { sleep } from './types';

const VID = 0x388d;
const USAGE_PAGE = 0xff1c;
const USAGE = 0x92;
const REPORT_ID = 4;
/** live travel samples (after command 63 [01]) */
const LIVE_REPORT_ID = 6;

/** [productId, model, via 2.4G receiver] */
export const MODELS: [number, string, boolean][] = [
  [0x0024, 'Hyzen', false],
  [0x0025, 'Hyzen (2.4G)', true],
  [0x0029, 'Hyzen (wired)', false],
];

const IMAGE_BASE = 'https://hyzen.lofree.tech/deviceImage/';

export const PROFILE_SIZE = 64;
export const PROFILES = 7;
export const KEY_SLOTS = 128;
const MATRIX_SIZE = KEY_SLOTS * 3;
/** function-area byte holding the polling rate (wired / receiver) */
export const POLL_WIRED = 53;
export const POLL_WIRELESS = 54;

export const CMD = {
  READ_FUNC: 0x05,
  WRITE_FUNC: 0x06,
  READ_DEF_MATRIX: 0x07,
  READ_VERSION: 0x28,
  READ_DONGLE_VERSION: 0x29,
  READ_RT: 0x58,
  WRITE_RT: 0x48,
  READ_ACT: 0x5c,
  WRITE_ACT: 0x4c,
  READ_TRAVEL_SPEC: 0x60,
  READ_KEY_SPEC: 0x61,
  LIVE_TRAVEL: 0x63,
  READ_KEY_TYPE: 0x67,
  WRITE_KEY_TYPE: 0x66,
  READ_SOCD: 0x56,
  WRITE_SOCD: 0x46,
  READ_LED_MAP: 0x1b,
  READ_LED_COLORS: 0x21,
} as const;

/** LED colour table (official basicInfo.ledLength): 160 LEDs x 3 bytes R,G,B */
export const LED_BYTES = 480;
/** side light strip inside the LED colour table (official lightConfig.lightStrip) */
export const STRIP_START = 210;
export const STRIP_LEDS = 90;

/** key types (table 67/66) */
export const KEY_NORMAL = 0x20;
export const KEY_SOCD = 0x26;
/** SOCD flags byte: prio << 4 | slot << 3 | rt (bits that may be set) */
const SOCD_FLAG_BITS = 0x39;
/** SOCD resolution modes (pair level). Key 1 stores the mode as its priority nibble, key 2 the mirror. */
export const SOCD_MODES: [string, number][] = [
  ['Last input', 0],
  ['Key 1 wins', 1],
  ['Key 2 wins', 2],
  ['Neutral', 3],
];
/** key 2's priority nibble for a pair mode (official saveSOCDKeyCommand) */
export const mirrorMode = (m: number) => (m === 1 ? 2 : m === 2 ? 1 : m);

const POLLING: [string, number][] = [
  ['8000 Hz', 0x00],
  ['1000 Hz', 0x04],
];

/** main backlight effects (function area byte 1) */
const LIGHT_MODES: [string, number][] = [
  ['Static', 0x00], ['Breathing', 0x01], ['Reactive on', 0x02], ['Reactive off', 0x03],
  ['Heartbeat', 0x04], ['Ripple', 0x05], ['Alternate', 0x06], ['Raindrop', 0x07],
  ['Colour cycle', 0x08], ['Piano', 0x09], ['Wave', 0x0a], ['Spin', 0x0b],
];
/** function area offsets of the main backlight */
export const L_MODE = 1;
export const L_SPEED = 3;
export const L_CUSTOM = 5;
export const L_RGB = 6;
export const L_BRI = 30;
/** 01 mechanical, 02 magnetic */
export const SWITCH_TYPE = 56;
const SPEED_MAX = 4;
const BRI_RAW_MAX = 125;

// --- secondary lights, both inside the same function area (written with cmd 06, like the main
// backlight). Byte offsets and ranges are exactly what Lofree HUB uses (OE930 config +
// LightEffect FrontLightSettings / DongleLightSettings components).
//
// Preposition / bottom "light strip" (hub FrontLightSettings): mode wx(38), brightness wx(31,
// raw 0..100 asc), speed wx(40, SPEED_MAX-ui desc), colour wx(42,43,44,45, flag 1 then R,G,B).
/** bottom light-strip effects (prepositionLight: constantlyOn/breathe/meteor/OpenClose/storeLibra/conversion) */
const STRIP_MODES: [string, number][] = [
  ['Static', 0x00], ['Breathing', 0x01], ['Meteor', 0x02], ['Open/close', 0x03], ['Scale', 0x04], ['Colour cycle', 0x05],
];
export const STRIP_BRI = 31;
export const STRIP_MODE = 38;
export const STRIP_SPEED = 40;
export const STRIP_CUSTOM = 42;
export const STRIP_RGB = 43;
export const STRIP_BRI_MAX = 100;

// Receiver / dongle light (hub DongleLightSettings): mode k(49), brightness k(32,
// ceil(pct*255/100) asc), speed k(52, SPEED_MAX-ui desc), colour wx(10,11,12,16, R,G,B then flag 1).
// Only the "full" config (wired 0x0024 + 2.4G 0x0025) has a dongle light; the wired-only "single"
// variant (0x0029) does not.
/** receiver-light effects (dongleLight: constantlyOn/breathe/meteor/conversion) */
const DONGLE_MODES: [string, number][] = [
  ['Static', 0x00], ['Breathing', 0x01], ['Meteor', 0x02], ['Colour cycle', 0x03],
];
export const DONGLE_RGB = 10;
export const DONGLE_CUSTOM = 16;
export const DONGLE_BRI = 32;
export const DONGLE_MODE = 49;
export const DONGLE_SPEED = 52;
export const DONGLE_BRI_MAX = 255;
/** wired-only variant with no receiver light */
const SINGLE_PID = 0x0029;

// ---------------------------------------------------------------------------------------------
// layout

/** [24-bit default keycode (type, modifier, usage), label, x, y, w] - standard 65% / 67 keys. */
const HYZEN_LAYOUT: [number, string, number, number, number][] = [
  [0x200029, 'Esc', 0, 0, 1], [0x20001e, '1', 1, 0, 1], [0x20001f, '2', 2, 0, 1], [0x200020, '3', 3, 0, 1],
  [0x200021, '4', 4, 0, 1], [0x200022, '5', 5, 0, 1], [0x200023, '6', 6, 0, 1], [0x200024, '7', 7, 0, 1],
  [0x200025, '8', 8, 0, 1], [0x200026, '9', 9, 0, 1], [0x200027, '0', 10, 0, 1], [0x20002d, '-', 11, 0, 1],
  [0x20002e, '=', 12, 0, 1], [0x20002a, 'Bksp', 13, 0, 2], [0x20004c, 'Del', 15, 0, 1],
  [0x20002b, 'Tab', 0, 1, 1.5], [0x200014, 'Q', 1.5, 1, 1], [0x20001a, 'W', 2.5, 1, 1], [0x200008, 'E', 3.5, 1, 1],
  [0x200015, 'R', 4.5, 1, 1], [0x200017, 'T', 5.5, 1, 1], [0x20001c, 'Y', 6.5, 1, 1], [0x200018, 'U', 7.5, 1, 1],
  [0x20000c, 'I', 8.5, 1, 1], [0x200012, 'O', 9.5, 1, 1], [0x200013, 'P', 10.5, 1, 1], [0x20002f, '[', 11.5, 1, 1],
  [0x200030, ']', 12.5, 1, 1], [0x200031, '\\', 13.5, 1, 1.5], [0x200049, 'Ins', 15, 1, 1],
  [0x200039, 'Caps', 0, 2, 1.75], [0x200004, 'A', 1.75, 2, 1], [0x200016, 'S', 2.75, 2, 1], [0x200007, 'D', 3.75, 2, 1],
  [0x200009, 'F', 4.75, 2, 1], [0x20000a, 'G', 5.75, 2, 1], [0x20000b, 'H', 6.75, 2, 1], [0x20000d, 'J', 7.75, 2, 1],
  [0x20000e, 'K', 8.75, 2, 1], [0x20000f, 'L', 9.75, 2, 1], [0x200033, ';', 10.75, 2, 1], [0x200034, "'", 11.75, 2, 1],
  [0x200028, 'Enter', 12.75, 2, 2.25], [0x20004b, 'PgUp', 15, 2, 1],
  [0x200200, 'Shift', 0, 3, 2.25], [0x20001d, 'Z', 2.25, 3, 1], [0x20001b, 'X', 3.25, 3, 1], [0x200006, 'C', 4.25, 3, 1],
  [0x200019, 'V', 5.25, 3, 1], [0x200005, 'B', 6.25, 3, 1], [0x200011, 'N', 7.25, 3, 1], [0x200010, 'M', 8.25, 3, 1],
  [0x200036, ',', 9.25, 3, 1], [0x200037, '.', 10.25, 3, 1], [0x200038, '/', 11.25, 3, 1],
  [0x202000, 'Shift', 12.25, 3, 1.75], [0x200052, 'Up', 14, 3, 1], [0x20004e, 'PgDn', 15, 3, 1],
  [0x200100, 'Ctrl', 0, 4, 1.25], [0x200800, 'Win', 1.25, 4, 1.25], [0x200400, 'Alt', 2.5, 4, 1.25],
  [0x20002c, 'Space', 3.75, 4, 6.25], [0x204000, 'Alt', 10, 4, 1.25], [0xa00100, 'Fn', 11.25, 4, 1.25],
  [0x200050, 'Left', 13, 4, 1], [0x200051, 'Down', 14, 4, 1], [0x20004f, 'Right', 15, 4, 1],
];
export const HYZEN_CODES = HYZEN_LAYOUT.map((k) => k[0]);
/** key whose trigger represents the "all keys" value */
const REF_CODE = 0x20001a; // W

/** Find each layout key's index in a default key matrix (3 bytes per key); -1 = not present. */
export function keyIndices(matrix: ArrayLike<number>): number[] {
  const where = new Map<number, number>();
  for (let i = 0; i + 2 < matrix.length && i / 3 < KEY_SLOTS; i += 3) {
    const code = (matrix[i] << 16) | (matrix[i + 1] << 8) | matrix[i + 2];
    if (code !== 0 && !where.has(code)) where.set(code, i / 3);
  }
  return HYZEN_CODES.map((c) => where.get(c) ?? -1);
}

/** The board's keys for the picture; `idx` (from keyIndices) gives the protocol index. */
export function hyzenCaps(idx?: number[]): KeyCap[] {
  return HYZEN_LAYOUT.map(([, label, x, y, w], i) => ({ index: idx ? idx[i] : i, label, x, y, w, h: 1 }));
}

// ---------------------------------------------------------------------------------------------
// travel conversion (official rawToMmMapping / mmToRawMapping)

/** Official non-linear actuation curve: y (linear mm, x 1e6) for displayed mm 0.00..3.40 step 0.01. */
const CURVE_Y: number[] = [
  0, 797, 1753, 2390, 3187, 3983, 4780, 5577, 6373, 7170, 7967, 8763,
  9560, 10357, 11153, 11950, 12747, 13543, 14340, 15137, 15933, 16730, 17527, 18323,
  19120, 19917, 20713, 21510, 22307, 23103, 23900, 29619, 35348, 41087, 46838, 52598,
  58369, 64151, 69944, 75747, 81561, 87385, 93221, 99067, 104925, 110793, 116673, 122563,
  128465, 134378, 140302, 146237, 152184, 158142, 164112, 170093, 176086, 182090, 188106, 194134,
  200173, 206225, 212288, 218363, 224451, 230550, 236662, 242785, 248921, 255069, 261230, 267403,
  273589, 279787, 285997, 292221, 298457, 304706, 310967, 317242, 323530, 329830, 336144, 342471,
  348812, 355165, 361532, 367913, 374307, 380714, 387136, 393571, 400019, 406482, 412959, 419450,
  425954, 432473, 439006, 445554, 452116, 458692, 465283, 471889, 478509, 485144, 491794, 498459,
  505139, 511834, 518545, 525270, 532011, 538767, 545539, 552327, 559130, 565949, 572784, 579635,
  586502, 593385, 600284, 607200, 614132, 621081, 628046, 635028, 642027, 649043, 656075, 663125,
  670192, 677277, 684378, 691498, 698635, 705789, 712962, 720152, 727361, 734587, 741832, 749096,
  756377, 763678, 770997, 778335, 785692, 793068, 800463, 807877, 815311, 822765, 830238, 837731,
  845244, 852777, 860330, 867903, 875497, 883112, 890747, 898403, 906080, 913778, 921497, 929238,
  937001, 944785, 952590, 960418, 968268, 976141, 984035, 991953, 999893, 1007856, 1015842, 1023851,
  1031884, 1039940, 1048020, 1056123, 1064251, 1072403, 1080580, 1088781, 1097006, 1105257, 1113533, 1121834,
  1130160, 1138512, 1146890, 1155294, 1163725, 1172181, 1180665, 1189175, 1197712, 1206277, 1214868, 1223488,
  1232135, 1240811, 1249514, 1258247, 1267008, 1275798, 1284617, 1293465, 1302344, 1311252, 1320190, 1329159,
  1338158, 1347188, 1356249, 1365342, 1374466, 1383623, 1392811, 1402032, 1411285, 1420572, 1429892, 1439245,
  1448632, 1458053, 1467509, 1477000, 1486525, 1496086, 1505682, 1515315, 1524983, 1534688, 1544431, 1554210,
  1564027, 1573882, 1583775, 1593707, 1603678, 1613688, 1623738, 1633828, 1643959, 1654130, 1664343, 1674597,
  1684894, 1695232, 1705614, 1716039, 1726508, 1737020, 1747578, 1758180, 1768828, 1779522, 1790262, 1801049,
  1811884, 1822766, 1833696, 1844676, 1855705, 1866784, 1877913, 1889093, 1900324, 1911608, 1922944, 1934334,
  1945777, 1957274, 1968827, 1980435, 1992099, 2003820, 2015599, 2027436, 2039331, 2051287, 2063302, 2075378,
  2087516, 2099716, 2111979, 2124306, 2136698, 2149155, 2161678, 2174269, 2186927, 2199654, 2212450, 2225317,
  2238255, 2251265, 2264349, 2277506, 2290739, 2304048, 2317434, 2330898, 2344441, 2358065, 2371769, 2385556,
  2399427, 2413382, 2427424, 2441552, 2455769, 2470075, 2484472, 2498961, 2513544, 2528222, 2542996, 2557868,
  2572839, 2587910, 2603084, 2618362, 2633745, 2649235, 2664834, 2680543, 2696364, 2712299, 2728350, 2744519,
  2760807, 2777217, 2793750, 2810409, 2827196,
];
const CY = (i: number) => CURVE_Y[i] / 1e6;
const CX = (i: number) => i / 100;

/** displayed mm -> linear mm (official tk) */
export function curveLinear(mm: number): number {
  const n = CURVE_Y.length;
  if (mm <= 0) return 0;
  if (mm >= CX(n - 1)) {
    const r = (CY(n - 1) - CY(n - 2)) / (CX(n - 1) - CX(n - 2));
    return CY(n - 1) + r * (mm - CX(n - 1));
  }
  const i = Math.min(n - 2, Math.floor(mm * 100 + 1e-9));
  const t = (mm - CX(i)) / (CX(i + 1) - CX(i));
  return CY(i) + t * (CY(i + 1) - CY(i));
}

/** linear mm -> displayed mm (official nk) */
export function curveDisplay(lin: number): number {
  const n = CURVE_Y.length;
  if (lin <= 0) return 0;
  if (lin >= CY(n - 1)) {
    const r = (CX(n - 1) - CX(n - 2)) / (CY(n - 1) - CY(n - 2));
    return CX(n - 1) + r * (lin - CY(n - 1));
  }
  for (let i = 0; i < n - 1; i++) {
    if (lin >= CY(i) && lin <= CY(i + 1)) {
      if (CY(i + 1) === CY(i)) return CX(i);
      return CX(i) + ((lin - CY(i)) / (CY(i + 1) - CY(i))) * (CX(i + 1) - CX(i));
    }
  }
  return lin;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** raw -> mm without the UI clamp (official rawToMmMapping `gn`) */
const rawToMmRaw = (raw: number, full: number, uiMax: number, curve: boolean) => {
  const lin = ((raw & 0x3fff) / full) * uiMax;
  return Math.max(0, curve ? curveDisplay(lin) : lin);
};

/** raw position -> mm. `curve` = actuation points (non-linear), otherwise linear (RT distances). */
export function rawToMm(raw: number, maxRaw: number, uiMax: number, curve: boolean): number {
  return clamp(rawToMmRaw(raw, maxRaw || 1000, uiMax, curve), 0, uiMax);
}

/**
 * mm -> raw position, 1..maxRaw: best of floor/round/ceil like the official Zx, which measures
 * each candidate with the unclamped `gn` (so near full travel the closer raw wins, as there).
 */
export function mmToRaw(mm: number, maxRaw: number, uiMax: number, curve: boolean): number {
  const full = maxRaw || 1000;
  const want = clamp(mm, 0, uiMax);
  const f = ((curve ? curveLinear(want) : want) / uiMax) * full;
  let best = clamp(Math.round(f), 1, full);
  let err = Math.abs(rawToMmRaw(best, full, uiMax, curve) - want);
  for (const c of [Math.max(1, Math.floor(f)), Math.max(1, Math.round(f)), Math.min(Math.ceil(f), full)]) {
    const e = Math.abs(rawToMmRaw(c, full, uiMax, curve) - want);
    if (e < err) {
      best = c;
      err = e;
    }
  }
  return best;
}

export const ACT_DEADZONE = 0x8000;
export const ACT_RT = 0x4000;

const hex4 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
/** "1.20 mm, RT on (0x4136)" - one actuation word for error messages. */
export function describeAct(w: number, maxRaw: number, maxMm: number): string {
  const flags = `${w & ACT_RT ? ', RT on' : ''}${w & ACT_DEADZONE ? ', dead zone' : ''}`;
  return `${rawToMm(w, maxRaw, maxMm, true).toFixed(2)} mm${flags} (${hex4(w)})`;
}
/** "0.30/0.30 mm (raw 88/88)" - one key's RT press/release distances for error messages. */
export function describeRt(press: number, release: number, maxRaw: number, maxMm: number): string {
  const mm = (v: number) => rawToMm(v, maxRaw, maxMm, false).toFixed(2);
  return `${mm(press)}/${mm(release)} mm (raw ${press}/${release})`;
}

// ---------------------------------------------------------------------------------------------
// packets

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');
/** A whole frame as hex, trailing zero bytes folded into a count. */
export function rawHex(p: ArrayLike<number>): string {
  let n = p.length;
  while (n > 0 && p[n - 1] === 0) n--;
  const zeros = p.length - n;
  return `${hexs(Array.from(p).slice(0, n))}${zeros ? `${n ? ' ' : ''}+${zeros}x00` : ''}`;
}

/** [cmd, table size] of every read we use */
const READS = new Map<number, number>([
  [CMD.READ_FUNC, PROFILE_SIZE * PROFILES],
  [CMD.READ_DEF_MATRIX, MATRIX_SIZE],
  [CMD.READ_VERSION, 2],
  [CMD.READ_DONGLE_VERSION, 2],
  [CMD.READ_TRAVEL_SPEC, 56],
  [CMD.READ_KEY_SPEC, KEY_SLOTS * 2],
  [CMD.READ_ACT, KEY_SLOTS * 2 * PROFILES],
  [CMD.READ_RT, KEY_SLOTS * 4 * PROFILES],
  [CMD.READ_KEY_TYPE, KEY_SLOTS * PROFILES],
  [CMD.READ_SOCD, KEY_SLOTS * 4 * PROFILES],
  [CMD.READ_LED_MAP, KEY_SLOTS],
  [CMD.READ_LED_COLORS, LED_BYTES],
]);
/** [cmd, table size] of every write we use */
const WRITES = new Map<number, number>([
  [CMD.WRITE_FUNC, PROFILE_SIZE * PROFILES],
  [CMD.WRITE_ACT, KEY_SLOTS * 2 * PROFILES],
  [CMD.WRITE_RT, KEY_SLOTS * 4 * PROFILES],
]);

/** Frame size for the connection (report 4 payload, report ID excluded). */
export const frameSize = (dongle: boolean) => (dongle ? 31 : 63);
const chunkSize = (size: number) => size - 7;

/** Report-4 payload allowlist (frame must be exactly `size` bytes). Everything else is refused. */
export function allowed(p: ArrayLike<number>, size = 63): boolean {
  if (p.length !== size || p[0] !== 0 || p[1] !== 0) return false;
  const tailZero = (from: number) => {
    for (let i = from; i < p.length; i++) if (p[i] !== 0) return false;
    return true;
  };
  const cmd = p[2];
  // transaction control: START 01 / END 02 (reads add 18)
  if (cmd === 0x01 || cmd === 0x02) return (p[3] === 0x18 || p[3] === 0) && tailZero(4);
  const len = p[3];
  const off = p[4] | (p[5] << 8);
  if (p[6] !== 0 || len > chunkSize(size)) return false;
  const read = READS.get(cmd);
  if (read !== undefined) return len >= 1 && off + len <= read && tailZero(7);
  // key type: one key at a time, only back to normal (20) or to SOCD (26) - never DKS/RS/HT
  if (cmd === CMD.WRITE_KEY_TYPE) return len === 1 && off < KEY_SLOTS * PROFILES && (p[7] === KEY_NORMAL || p[7] === KEY_SOCD) && tailZero(8);
  // SOCD entry: one whole 4-byte key entry [partner, flags, travel lo, travel hi]
  if (cmd === CMD.WRITE_SOCD) {
    if (len !== 4 || off % 4 !== 0 || off + 4 > KEY_SLOTS * 4 * PROFILES) return false;
    const travel = p[9] | (p[10] << 8);
    return p[7] < KEY_SLOTS && p[7] !== (off / 4) % KEY_SLOTS && (p[8] & ~SOCD_FLAG_BITS) === 0 && travel >= 1 && travel <= 0x3fff && tailZero(11);
  }
  const write = WRITES.get(cmd);
  if (write !== undefined) {
    if (len < 1 || off + len > write || !tailZero(7 + len)) return false;
    // the polling byte only takes known codes when written on its own
    if (cmd === CMD.WRITE_FUNC && len === 1 && (off === POLL_WIRED || off === POLL_WIRELESS)) {
      return POLLING.some(([, c]) => c === p[7]);
    }
    return true;
  }
  // live travel test: 63 [01] starts, 63 (no data) stops
  if (cmd === CMD.LIVE_TRAVEL) return off === 0 && ((len === 1 && p[7] === 1) || len === 0) && tailZero(7 + len);
  return false;
}

const pad = (b: number[], size: number) => {
  const out = new Array<number>(size).fill(0);
  b.forEach((v, i) => (out[i] = v & 0xff));
  return out;
};
export const startPkt = (read: boolean, size = 63) => pad(read ? [0, 0, 0x01, 0x18] : [0, 0, 0x01], size);
export const endPkt = (read: boolean, size = 63) => pad(read ? [0, 0, 0x02, 0x18] : [0, 0, 0x02], size);
export const readFramePkt = (cmd: number, len: number, off: number, size = 63) =>
  pad([0, 0, cmd, len, off & 0xff, (off >> 8) & 0xff, 0], size);
export const writeFramePkt = (cmd: number, off: number, data: number[], size = 63) =>
  pad([0, 0, cmd, data.length, off & 0xff, (off >> 8) & 0xff, 0, ...data], size);

/** Split a read of `len` bytes at `off` into frames. */
export function readFrames(cmd: number, len: number, off: number, size = 63): number[][] {
  const c = chunkSize(size);
  const out: number[][] = [];
  for (let i = 0; i < len; i += c) out.push(readFramePkt(cmd, Math.min(c, len - i), off + i, size));
  return out;
}

/** Split a write of `data` at `off` into frames (an empty write is one frame with len 0). */
export function writeFrames(cmd: number, data: number[], off: number, size = 63): number[][] {
  const c = chunkSize(size);
  if (data.length === 0) return [writeFramePkt(cmd, off, [], size)];
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += c) out.push(writeFramePkt(cmd, off + i, data.slice(i, i + c), size));
  return out;
}

const u16 = (d: ArrayLike<number>, i: number) => (d[i] | (d[i + 1] << 8)) & 0xffff;
const put16 = (d: number[], i: number, v: number) => {
  d[i] = v & 0xff;
  d[i + 1] = (v >> 8) & 0xff;
};

export interface TravelSpec {
  minMm: number;
  maxMm: number;
}

/** 60 reply: u16 min travel (um), u16 max travel (um). 0 -> official fallback (4 mm). */
export function parseTravelSpec(d: ArrayLike<number>): TravelSpec {
  const min = d.length >= 2 ? u16(d, 0) / 1000 : 0;
  const max = d.length >= 4 ? u16(d, 2) / 1000 : 0;
  return { minMm: min, maxMm: max > 0 ? max : 4 };
}

/** firmware version bytes [minor, major] -> official number (major*100 + minor) */
export const versionNumber = (d: ArrayLike<number>) => (d.length >= 2 ? d[1] * 100 + d[0] : 0);

const rgb = (r: number, g: number, b: number) => ((r << 16) | (g << 8) | b) >>> 0;

/** One SOCD pair as stored (key indices; raw travel per key). */
export interface SocdPair {
  k1: number;
  k2: number;
  mode: number;
  rt: boolean;
  raw1: number;
  raw2: number;
}

/**
 * Pairs from the key type table (one profile, 128 bytes) and the SOCD table (512 bytes), like the
 * official reader: a type-26 key whose partner is type 26 too; key 1 is the one with slot bit 0.
 */
export function parseSocdPairs(types: ArrayLike<number>, table: ArrayLike<number>): SocdPair[] {
  const seen = new Set<number>();
  const out: SocdPair[] = [];
  for (let k = 0; k < KEY_SLOTS; k++) {
    if (types[k] !== KEY_SOCD || seen.has(k)) continue;
    const partner = table[k * 4];
    if (partner >= KEY_SLOTS || partner === k || types[partner] !== KEY_SOCD || seen.has(partner)) continue;
    seen.add(k);
    seen.add(partner);
    const [k1, k2] = ((table[k * 4 + 1] >> 3) & 1) === 0 ? [k, partner] : [partner, k];
    const f1 = table[k1 * 4 + 1];
    out.push({ k1, k2, mode: (f1 >> 4) & 0x0f, rt: (f1 & 1) === 1, raw1: u16(table, k1 * 4 + 2), raw2: u16(table, k2 * 4 + 2) });
  }
  return out;
}

/** The two 4-byte entries of a pair: [key, bytes][] (key 1 = slot 0, key 2 = slot 1). */
export function socdEntries(s: SocdPair): [number, number[]][] {
  const rt = s.rt ? 1 : 0;
  return [
    [s.k1, [s.k2, (s.mode << 4) | rt, s.raw1 & 0xff, (s.raw1 >> 8) & 0xff]],
    [s.k2, [s.k1, (mirrorMode(s.mode) << 4) | (1 << 3) | rt, s.raw2 & 0xff, (s.raw2 >> 8) & 0xff]],
  ];
}

// ---------------------------------------------------------------------------------------------
// transport

/** Timings (ms). Mutable only so tests can shorten them. */
export const lofreeTiming = {
  /** wait for one reply */
  reply: 800,
  /** settle before reading back */
  settle: 30,
};

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  readonly listeners = new Set<(id: number, d: Uint8Array) => void>();
  private readonly onReport = (e: HIDInputReportEvent) => {
    const d = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    for (const l of [...this.listeners]) l(e.reportId, d);
  };

  constructor(
    readonly dev: HIDDevice,
    readonly size: number,
  ) {
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

  /** Send one frame and wait for a report-4 reply satisfying `want`. */
  private exchange(p: number[], want: (d: Uint8Array) => boolean, what: string): Promise<Uint8Array> {
    if (!allowed(p, this.size)) return Promise.reject(new Error(`refusing to send ${hexs(p.slice(0, 8))}`));
    return new Promise<Uint8Array>((resolve, reject) => {
      const done = (d?: Uint8Array, err?: unknown) => {
        this.listeners.delete(l);
        clearTimeout(timer);
        if (d) resolve(d);
        else reject(err instanceof Error ? err : new Error(String(err)));
      };
      const l = (id: number, d: Uint8Array) => {
        if (id === REPORT_ID && d.length >= 3 && want(d)) done(d);
      };
      this.listeners.add(l);
      const timer = setTimeout(() => done(undefined, new Error(`no answer (${what})`)), lofreeTiming.reply);
      this.dev.sendReport(REPORT_ID, new Uint8Array(p)).catch((e) => done(undefined, e));
    });
  }

  /**
   * One START / frames / END transaction. With `trace`, every frame sent and every reply is logged
   * raw, and a read that stops answering mid-way gets a best-effort END so the next one starts clean.
   */
  private async transaction(read: boolean, cmd: number, frames: number[][], offs: number[], trace?: string[]): Promise<number[]> {
    const name = `${read ? 'read' : 'write'} ${hex2(cmd)}`;
    // validate everything before the first byte goes out
    for (const f of [startPkt(read, this.size), ...frames, endPkt(read, this.size)]) {
      if (!allowed(f, this.size)) throw new Error(`refusing to send ${hexs(f.slice(0, 8))}`);
    }
    const step = async (p: number[], want: (d: Uint8Array) => boolean, what: string) => {
      trace?.push(`  > ${rawHex(p)}`);
      try {
        const d = await this.exchange(p, want, what);
        trace?.push(`  < ${rawHex(d)}`);
        return d;
      } catch (e) {
        trace?.push(`  < (${e instanceof Error ? e.message : String(e)})`);
        throw e;
      }
    };
    await step(startPkt(read, this.size), (d) => d[2] === 0x01, `${name} start`);
    const out: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const off = offs[i];
      let d: Uint8Array;
      try {
        d = await step(frames[i], (r) => (r[2] === cmd || r[2] === 0) && r.length >= 7 && (r[4] | (r[5] << 8)) === off, name);
      } catch (e) {
        if (trace && read) {
          trace.push('  closing the read:');
          await step(endPkt(read, this.size), (r) => r[2] === 0x02, `${name} end`).catch(() => undefined);
        }
        throw e;
      }
      if (read) {
        const len = Math.min(frames[i][3], d[3] || frames[i][3]);
        for (let k = 0; k < len; k++) out.push(d[7 + k] ?? 0);
      }
    }
    await step(endPkt(read, this.size), (d) => d[2] === 0x02, `${name} end`);
    return out;
  }

  /** Read `len` bytes of table `cmd` at byte offset `off` (`trace` collects the raw frames). */
  async read(cmd: number, len: number, off = 0, trace?: string[]): Promise<number[]> {
    const frames = readFrames(cmd, len, off, this.size);
    const d = await this.transaction(true, cmd, frames, frames.map((f) => f[4] | (f[5] << 8)), trace);
    if (d.length < len) throw new Error(`short reply for ${hex2(cmd)}`);
    return d.slice(0, len);
  }

  /** Write `data` to table `cmd` at byte offset `off`. */
  async write(cmd: number, data: number[], off = 0): Promise<void> {
    const frames = writeFrames(cmd, data, off, this.size);
    await this.transaction(false, cmd, frames, frames.map((f) => f[4] | (f[5] << 8)));
  }
}

// ---------------------------------------------------------------------------------------------
// driver

const text = (key: string, label: string, group: string, s: string): Setting => ({ key, label, group, value: { kind: 'text', text: s } });

interface Magnetic {
  spec: TravelSpec;
  /** layout position -> key index (-1 = not in the matrix) */
  idx: number[];
  /** per key slot: calibrated full-travel raw */
  maxRaw: number[];
  /** actuation words of the active profile (128 x u16) */
  act: number[];
  /** rapid trigger table of the active profile (128 x [press, release]) */
  rt: number[];
  /** key types and SOCD table of the active profile, when they could be read */
  socd?: { types: number[]; table: number[] };
}

/** Layout positions that exist in the key matrix. */
const present = (idx: number[]) => idx.map((k, i) => [i, k] as const).filter(([, k]) => k >= 0);

class Hyzen implements Driver {
  readonly id: string;
  readonly family = 'Lofree HUB';
  readonly kind = 'keyboard' as const;
  readonly verified = false;

  private profile = 0;
  private mag: Magnetic | undefined;
  private idx: number[] | undefined;

  constructor(
    private readonly link: Link,
    private readonly name: string,
    private readonly dongle: boolean,
    private readonly pid: number,
  ) {
    const d = link.dev;
    this.id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
  }

  brand() {
    return 'LOFREE';
  }
  model() {
    return this.name;
  }
  image() {
    return IMAGE_BASE + (this.pid === 0x0029 ? 'oe930-single.webp' : 'oe930.webp');
  }
  layout(): KeyCap[] {
    return hyzenCaps(this.idx);
  }

  /** firmware version (cmd 28) - also proves the keyboard speaks this protocol */
  async identify(): Promise<number> {
    return versionNumber(await this.link.read(CMD.READ_VERSION, 2));
  }

  read(): Promise<Setting[]> {
    return this.link.lock(() => this.readInner());
  }
  write(s: Setting): Promise<void> {
    return this.link.lock(() => this.writeInner(s));
  }

  async travelTest(onSample: (pos: number, mm: number) => void): Promise<() => Promise<void>> {
    const idx = this.idx ?? [];
    const l = (id: number, d: Uint8Array) => {
      if (id !== LIVE_REPORT_ID || d.length < 5) return;
      const cur = u16(d, 1);
      const total = u16(d, 3);
      if (total <= 0 || cur > total) return;
      onSample(idx.indexOf(d[0]), cur / 1000);
    };
    await this.link.lock(async () => {
      this.link.listeners.add(l);
      try {
        await this.link.write(CMD.LIVE_TRAVEL, [1]);
      } catch (e) {
        this.link.listeners.delete(l);
        throw e;
      }
    });
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      this.link.listeners.delete(l);
      await this.link.lock(() => this.link.write(CMD.LIVE_TRAVEL, []));
    };
  }

  /**
   * Read-only probe of the lighting state: firmware, function area (effect bytes), key matrix,
   * LED location map (1B) and LED colours (21, twice, to see whether it is a live frame).
   * Sends only read transactions (START/END with 18, read commands from READS).
   */
  diagnose(onProgress?: (done: number, total: number) => void): Promise<string> {
    return this.link.lock(() => this.diagnoseInner(onProgress));
  }

  private async diagnoseInner(onProgress?: (done: number, total: number) => void): Promise<string> {
    const out: string[] = [
      'Lofree Hyzen diagnostics (read-only)',
      `model ${this.name}, pid ${hex4(this.pid)}, ${this.dongle ? '2.4G receiver' : 'wired'}, ${this.link.size}-byte frames`,
    ];
    const total = this.dongle ? 8 : 7;
    let done = 0;
    onProgress?.(0, total);
    const probe = async (title: string, cmd: number, len: number, off = 0): Promise<number[] | undefined> => {
      const trace: string[] = [];
      out.push('', `## ${title}: read ${hex2(cmd)}, ${len} bytes at ${off}`);
      try {
        const d = await this.link.read(cmd, len, off, trace);
        out.push(...trace);
        return d;
      } catch (e) {
        out.push(...trace, `  FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      } finally {
        onProgress?.(++done, total);
      }
    };
    const note = (s: string) => out.push(`  = ${s}`);
    const rgbHex = (d: ArrayLike<number>, i: number) => `#${hex2(d[i])}${hex2(d[i + 1])}${hex2(d[i + 2])}`;

    const ver = await probe('firmware version', CMD.READ_VERSION, 2);
    if (ver) note(`firmware ${versionNumber(ver)}`);
    if (this.dongle) {
      const dv = await probe('receiver version', CMD.READ_DONGLE_VERSION, 2);
      if (dv) note(`receiver firmware ${versionNumber(dv)}`);
    }

    const pb = await probe('active profile', CMD.READ_FUNC, 1, 0);
    let profile = 0;
    if (pb) {
      if (pb[0] < PROFILES) profile = pb[0];
      note(pb[0] < PROFILES ? `profile ${pb[0] + 1}` : `profile byte ${hex2(pb[0])} out of range, using profile 1 below`);
    }
    const block = await probe(`function area, profile ${profile + 1}`, CMD.READ_FUNC, PROFILE_SIZE, profile * PROFILE_SIZE);
    if (block) {
      const mode = block[L_MODE];
      const name = LIGHT_MODES.find(([, m]) => m === mode)?.[0] ?? 'unknown';
      note(`main backlight: effect ${hex2(mode)} (${name}), speed byte ${block[L_SPEED]}, colour flag ${block[L_CUSTOM]}, colour ${rgbHex(block, L_RGB)}, brightness ${block[L_BRI]}/${BRI_RAW_MAX}`);
      const sname = STRIP_MODES.find(([, m]) => m === block[STRIP_MODE])?.[0] ?? 'unknown';
      note(`light strip: effect ${hex2(block[STRIP_MODE])} (${sname}), speed byte ${block[STRIP_SPEED]}, colour flag ${block[STRIP_CUSTOM]}, colour ${rgbHex(block, STRIP_RGB)}, brightness ${block[STRIP_BRI]}/${STRIP_BRI_MAX}`);
      const dname = DONGLE_MODES.find(([, m]) => m === block[DONGLE_MODE])?.[0] ?? 'unknown';
      note(`receiver light: effect ${hex2(block[DONGLE_MODE])} (${dname}), speed byte ${block[DONGLE_SPEED]}, colour flag ${block[DONGLE_CUSTOM]}, colour ${rgbHex(block, DONGLE_RGB)}, brightness ${block[DONGLE_BRI]}/${DONGLE_BRI_MAX}`);
      note(`switch mode byte ${hex2(block[SWITCH_TYPE])} (01 mechanical, 02 magnetic)`);
    }

    const matrix = await probe('default key matrix', CMD.READ_DEF_MATRIX, MATRIX_SIZE);
    const idx = matrix ? keyIndices(matrix) : this.idx;
    if (matrix && idx) {
      const missing = HYZEN_LAYOUT.filter((_, i) => idx[i] < 0).map(([, l]) => l);
      note(`${idx.length - missing.length}/${idx.length} layout keys found${missing.length ? `, missing: ${missing.join(' ')}` : ''}`);
    }

    const map = await probe('LED location map (1B)', CMD.READ_LED_MAP, KEY_SLOTS);
    if (map && idx) {
      const leds = idx.map((k) => (k >= 0 ? map[k] : -1));
      const used = leds.filter((l) => l >= 0);
      const dup = used.filter((l, i) => used.indexOf(l) !== i);
      note(`key -> LED: ${HYZEN_LAYOUT.map(([, l], i) => `${l}:${idx[i] < 0 ? '-' : `${idx[i]}->${leds[i]}`}`).join(' ')}`);
      if (used.length) {
        note(`${new Set(used).size} distinct LEDs for ${used.length} keys${dup.length ? `, shared: ${[...new Set(dup)].join(' ')}` : ''}; LED range ${Math.min(...used)}..${Math.max(...used)}`);
      }
    }

    const c1 = await probe('LED colours (21)', CMD.READ_LED_COLORS, LED_BYTES);
    if (c1) {
      if (map && idx) {
        const keyCol = HYZEN_LAYOUT.map(([, l], i) => {
          const led = idx[i] >= 0 ? map[idx[i]] : -1;
          return `${l}:${led >= 0 && led * 3 + 2 < LED_BYTES ? rgbHex(c1, led * 3) : '-'}`;
        });
        note(`key colours (R,G,B as Lofree HUB reads them): ${keyCol.join(' ')}`);
      }
      const strip = Array.from({ length: STRIP_LEDS }, (_, i) => rgbHex(c1, STRIP_START + i * 3));
      note(`light strip (${STRIP_LEDS} LEDs from byte ${STRIP_START}): ${strip.join(' ')}`);
      note(`${new Set(Array.from({ length: LED_BYTES / 3 }, (_, i) => rgbHex(c1, i * 3))).size} distinct colours over ${LED_BYTES / 3} LEDs`);
    }
    const c2 = await probe('LED colours again (live or stored?)', CMD.READ_LED_COLORS, LED_BYTES);
    if (c1 && c2) {
      const diff = c1.reduce((n, b, i) => n + (b !== c2[i] ? 1 : 0), 0);
      note(diff ? `${diff} of ${LED_BYTES} bytes changed between the two reads: a live frame of the running effect` : 'identical to the first read (static effect, or a stored table)');
    }

    out.push(
      '',
      'Notes: Lofree HUB has no command that writes per-key colours for the Hyzen. It reads 1B once at start-up;',
      'its 21 poll (pollLedColor) is switched off in the shipped app. Effects 00..0B use one colour or rainbow (function area).',
    );
    return out.join('\n');
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.link.dev.opened) await this.link.dev.close();
  }

  // --- reads

  private pollOffset() {
    return this.dongle ? POLL_WIRELESS : POLL_WIRED;
  }

  private async readProfile(): Promise<number> {
    const [p] = await this.link.read(CMD.READ_FUNC, 1, 0);
    if (p >= PROFILES) throw new Error(`keyboard reports profile ${p}`);
    return p;
  }

  private readBlock(): Promise<number[]> {
    return this.link.read(CMD.READ_FUNC, PROFILE_SIZE, this.profile * PROFILE_SIZE);
  }

  private async readPoll(): Promise<number> {
    return (await this.link.read(CMD.READ_FUNC, 1, this.pollOffset()))[0];
  }

  private readAct(): Promise<number[]> {
    return this.link.read(CMD.READ_ACT, KEY_SLOTS * 2, KEY_SLOTS * 2 * this.profile);
  }

  private readRt(): Promise<number[]> {
    return this.link.read(CMD.READ_RT, KEY_SLOTS * 4, KEY_SLOTS * 4 * this.profile);
  }

  private readKeyTypes(): Promise<number[]> {
    return this.link.read(CMD.READ_KEY_TYPE, KEY_SLOTS, KEY_SLOTS * this.profile);
  }

  private readSocdTable(): Promise<number[]> {
    return this.link.read(CMD.READ_SOCD, KEY_SLOTS * 4, KEY_SLOTS * 4 * this.profile);
  }

  /** UI value for the SOCD pairs (positions = the per-key layout, keys present in the matrix). */
  private socdValue(m: Magnetic): Socd {
    const { types, table } = m.socd!;
    const keys = present(m.idx);
    const caps = hyzenCaps(m.idx).filter((c) => c.index >= 0);
    const pos = (k: number) => keys.findIndex(([, kk]) => kk === k);
    const lo = Math.max(0.01, r2(m.spec.minMm));
    const hi = r2(m.spec.maxMm);
    const entries: Socd['entries'] = [];
    for (const s of parseSocdPairs(types, table)) {
      const a = pos(s.k1);
      const b = pos(s.k2);
      if (a < 0 || b < 0) continue;
      entries.push({ keys: [a, b], mode: s.mode, travel: clamp(r2(rawToMm(s.raw1, m.maxRaw[s.k1], m.spec.maxMm, true)), lo, hi), rapid: s.rt });
    }
    const modes = SOCD_MODES.map(([l, v]) => [l, v] as [string, number]);
    for (const e of entries) if (!modes.some(([, v]) => v === e.mode)) modes.push([`Mode ${e.mode}`, e.mode]);
    return {
      kind: 'socd',
      mode: 'pairs',
      keys: caps,
      max: Math.floor(keys.length / 2),
      modes,
      // DKS / RS / HT keys: making them SOCD would silently drop that function
      unavailable: keys.map(([, k], i) => (types[k] === KEY_NORMAL || types[k] === KEY_SOCD ? -1 : i)).filter((i) => i >= 0),
      travel: { min: lo, max: hi, step: 0.01, default: this.actMm(m, this.refKey(m)) },
      rapid: true,
      entries,
    };
  }

  private async writeSocd(m: Magnetic, v: Socd): Promise<void> {
    if (!m.socd) throw new Error('press Re-read first');
    const { types, table } = m.socd;
    const keys = present(m.idx);
    const label = (k: number) => HYZEN_LAYOUT[m.idx.indexOf(k)]?.[1] ?? `#${k}`;
    if (v.mode !== 'pairs' || v.keys.length !== keys.length) throw new Error("SOCD data doesn't match the keyboard - press Re-read");
    if (v.entries.length > Math.floor(keys.length / 2)) throw new Error('too many SOCD pairs');
    const lo = Math.max(0.01, r2(m.spec.minMm));
    const hi = r2(m.spec.maxMm);
    const old = parseSocdPairs(types, table);
    const used = new Set<number>();
    const pairs: SocdPair[] = v.entries.map((e) => {
      if (e.keys.length !== 2 || e.keys[0] === e.keys[1]) throw new Error('every SOCD pair needs two different keys');
      const [k1, k2] = e.keys.map((i) => {
        const k = keys[i]?.[1];
        if (k === undefined) throw new Error("SOCD data doesn't match the keyboard - press Re-read");
        if (used.has(k)) throw new Error(`${label(k)} is in two SOCD pairs`);
        if (types[k] !== KEY_NORMAL && types[k] !== KEY_SOCD) throw new Error(`${label(k)} has another advanced function (DKS/RS/HT) - remove it in Lofree HUB first`);
        used.add(k);
        return k;
      });
      const was = old.find((o) => o.k1 === k1 && o.k2 === k2);
      if (!SOCD_MODES.some(([, x]) => x === e.mode) && was?.mode !== e.mode) throw new Error(`unknown SOCD mode ${e.mode}`);
      const travel = clamp(r2(e.travel ?? this.actMm(m, k1)), lo, hi);
      // keep the stored travel when the UI shows the same value
      const same = was && r2(rawToMm(was.raw1, m.maxRaw[k1], m.spec.maxMm, true)) === travel;
      return {
        k1,
        k2,
        mode: e.mode,
        rt: !!e.rapid,
        raw1: same ? was.raw1 : mmToRaw(travel, m.maxRaw[k1], m.spec.maxMm, true),
        raw2: same ? was.raw2 : mmToRaw(travel, m.maxRaw[k2], m.spec.maxMm, true),
      };
    });
    const typeWrites = new Map<number, number>();
    for (const o of old) for (const k of [o.k1, o.k2]) if (!used.has(k)) typeWrites.set(k, KEY_NORMAL);
    const entryWrites: [number, number[]][] = [];
    for (const s of pairs) {
      // key 2 first, then key 1, like the official app
      for (const [k, bytes] of socdEntries(s).reverse()) {
        if (bytes.some((b, j) => table[k * 4 + j] !== b)) entryWrites.push([k, bytes]);
      }
      for (const k of [s.k1, s.k2]) if (types[k] !== KEY_SOCD) typeWrites.set(k, KEY_SOCD);
    }
    if (!typeWrites.size && !entryWrites.length) return;
    // keys leaving SOCD go back to normal first, then the entries, then the new SOCD types
    const typeBase = KEY_SLOTS * this.profile;
    const tableBase = KEY_SLOTS * 4 * this.profile;
    for (const [k, t] of typeWrites) if (t === KEY_NORMAL) await this.link.write(CMD.WRITE_KEY_TYPE, [t], typeBase + k);
    for (const [k, bytes] of entryWrites) await this.link.write(CMD.WRITE_SOCD, bytes, tableBase + k * 4);
    for (const [k, t] of typeWrites) if (t === KEY_SOCD) await this.link.write(CMD.WRITE_KEY_TYPE, [t], typeBase + k);
    await sleep(lofreeTiming.settle);
    const got = { types: await this.readKeyTypes(), table: await this.readSocdTable() };
    m.socd = got;
    const bad = new Set<string>();
    let first: string | undefined;
    for (const [k, t] of typeWrites) {
      if (got.types[k] === t) continue;
      bad.add(label(k));
      first ??= `${label(k)}: sent key type ${hex2(t)}, reads back ${hex2(got.types[k])}`;
    }
    for (const [k, bytes] of entryWrites) {
      const now = got.table.slice(k * 4, k * 4 + 4);
      if (bytes.every((b, j) => now[j] === b)) continue;
      bad.add(label(k));
      first ??= `${label(k)}: sent entry ${hexs(bytes)}, reads back ${hexs(now)}`;
    }
    if (bad.size) throw new Error(`keyboard didn't take the SOCD change for: ${[...bad].join(', ')} (${first})`);
  }

  private async readMagnetic(): Promise<Magnetic> {
    const spec = parseTravelSpec(await this.link.read(CMD.READ_TRAVEL_SPEC, 56));
    const idx = keyIndices(await this.link.read(CMD.READ_DEF_MATRIX, MATRIX_SIZE));
    this.idx = idx;
    const ks = await this.link.read(CMD.READ_KEY_SPEC, KEY_SLOTS * 2);
    const maxRaw = Array.from({ length: KEY_SLOTS }, (_, k) => u16(ks, k * 2) & 0x3fff || 1000);
    return { spec, idx, maxRaw, act: await this.readAct(), rt: await this.readRt() };
  }

  /** actuation point (mm) as shown in the UI: 0.01 steps, inside [min travel, max travel] */
  private actMm(m: Magnetic, key: number) {
    const mm = r2(rawToMm(u16(m.act, key * 2), m.maxRaw[key], m.spec.maxMm, true));
    return clamp(mm, Math.max(0.01, r2(m.spec.minMm)), r2(m.spec.maxMm));
  }
  /** Rapid Trigger press distance (mm) as shown in the UI */
  private sensMm(m: Magnetic, key: number) {
    return clamp(r2(rawToMm(u16(m.rt, key * 4), m.maxRaw[key], m.spec.maxMm, false)), 0.01, r2(m.spec.maxMm));
  }

  private refKey(m: Magnetic): number {
    const ref = m.idx[HYZEN_CODES.indexOf(REF_CODE)];
    if (ref >= 0) return ref;
    const first = present(m.idx)[0];
    if (!first) throw new Error('no keys found in the key matrix');
    return first[1];
  }

  private triggerSettings(m: Magnetic): Setting[] {
    const { minMm, maxMm } = m.spec;
    const lo = Math.max(0.01, r2(minMm));
    const ref = this.refKey(m);
    const keys = present(m.idx);
    const caps = hyzenCaps(m.idx).filter((c) => c.index >= 0);
    const sens = keys.map(([, k]) => this.sensMm(m, k));
    return [
      {
        key: 'actuation',
        label: 'Actuation point (all keys)',
        group: 'Switches',
        value: { kind: 'float', min: lo, max: r2(maxMm), step: 0.01, current: clamp(this.actMm(m, ref), lo, r2(maxMm)), unit: ' mm' },
      },
      { key: 'rapid_trigger', label: 'Rapid Trigger (all keys)', group: 'Switches', value: { kind: 'toggle', on: (u16(m.act, ref * 2) & ACT_RT) !== 0 } },
      {
        key: 'rt_sens',
        label: 'Rapid Trigger sensitivity',
        group: 'Switches',
        value: { kind: 'float', min: 0.01, max: r2(maxMm), step: 0.01, current: clamp(this.sensMm(m, ref), 0.01, r2(maxMm)), unit: ' mm' },
      },
      {
        key: 'per_key_trigger',
        label: 'Per-key actuation',
        group: 'Per-key',
        value: {
          kind: 'perKeyTrigger',
          keys: caps,
          travel: keys.map(([, k]) => clamp(this.actMm(m, k), lo, r2(maxMm))),
          rapid: keys.map(([, k]) => (u16(m.act, k * 2) & ACT_RT) !== 0),
          sens: sens.map((s) => clamp(s, 0.01, r2(maxMm))),
          min: lo,
          max: r2(maxMm),
          step: 0.01,
          sensMin: 0.01,
          sensMax: r2(maxMm),
        },
      },
    ];
  }

  private async readInner(): Promise<Setting[]> {
    const out: Setting[] = [];
    let fw: number;
    try {
      fw = await this.identify();
    } catch (e) {
      throw new Error(`Keyboard isn't answering (${e instanceof Error ? e.message : String(e)}).`);
    }
    out.push(text('model', 'Model', 'Info', this.name));
    out.push(text('fw', 'Firmware', 'Info', String(fw)));
    if (this.dongle) {
      try {
        out.push(text('fw_dongle', 'Receiver firmware', 'Info', String(versionNumber(await this.link.read(CMD.READ_DONGLE_VERSION, 2)))));
      } catch {
        // older receivers don't answer
      }
    }
    this.profile = await this.readProfile();
    out.push(text('profile', 'Active profile', 'Info', String(this.profile + 1)));
    const block = await this.readBlock();
    const sw = block[SWITCH_TYPE];
    const magnetic = sw === 0x02;
    out.push(text('switches', 'Switch mode', 'Info', magnetic ? 'Magnetic' : sw === 0x01 ? 'Mechanical' : `Unknown (${hex2(sw)})`));

    // --- performance
    const code = await this.readPoll();
    const options: [string, number][] = POLLING.map(([l, c]) => [l, c]);
    if (!POLLING.some(([, c]) => c === code)) options.push([`Current (code ${code})`, code]);
    out.push({ key: 'polling', label: 'Polling rate', group: 'Performance', value: { kind: 'choice', options, current: code } });

    // --- magnetic switches
    this.mag = undefined;
    if (magnetic) {
      this.mag = await this.readMagnetic();
      out.push(...this.triggerSettings(this.mag));
      try {
        this.mag.socd = { types: await this.readKeyTypes(), table: await this.readSocdTable() };
        out.push({
          key: 'socd',
          label: 'SOCD (Snap Tap)',
          group: 'Switches',
          value: this.socdValue(this.mag),
          hint: 'When both keys of a pair are held, only one counts - great for strafing (A/D). Each pair has its own actuation point and Rapid Trigger.',
        });
      } catch {
        // tables didn't answer: leave SOCD out
      }
    } else {
      out.push(text('switch_note', 'Note', 'Info', 'Actuation and Rapid Trigger need magnetic switch mode (set in Lofree HUB)'));
    }

    // --- lighting (main backlight)
    const mode = block[L_MODE];
    const modes: [string, number][] = LIGHT_MODES.map(([l, m]) => [l, m]);
    if (!LIGHT_MODES.some(([, m]) => m === mode)) modes.push([`Mode ${mode}`, mode]);
    out.push({ key: 'light_mode', label: 'Effect', group: 'Lighting', value: { kind: 'choice', options: modes, current: mode } });
    out.push({
      key: 'light_bri',
      label: 'Brightness',
      group: 'Lighting',
      value: { kind: 'number', min: 0, max: 100, current: clamp(Math.round((block[L_BRI] * 100) / BRI_RAW_MAX), 0, 100), unit: '%' },
    });
    out.push({
      key: 'light_speed',
      label: 'Speed',
      group: 'Lighting',
      value: { kind: 'number', min: 0, max: SPEED_MAX, current: clamp(SPEED_MAX - block[L_SPEED], 0, SPEED_MAX), unit: '' },
    });
    out.push({ key: 'light_color', label: 'Colour', group: 'Lighting', value: { kind: 'color', rgb: rgb(block[L_RGB], block[L_RGB + 1], block[L_RGB + 2]) } });

    // --- bottom light strip (preposition light)
    const smode = block[STRIP_MODE];
    const smodes: [string, number][] = STRIP_MODES.map(([l, m]) => [l, m]);
    if (!STRIP_MODES.some(([, m]) => m === smode)) smodes.push([`Mode ${smode}`, smode]);
    out.push({ key: 'strip_mode', label: 'Light strip effect', group: 'Lighting', value: { kind: 'choice', options: smodes, current: smode } });
    out.push({
      key: 'strip_bri',
      label: 'Light strip brightness',
      group: 'Lighting',
      value: { kind: 'number', min: 0, max: 100, current: clamp(block[STRIP_BRI], 0, STRIP_BRI_MAX), unit: '%' },
    });
    out.push({
      key: 'strip_speed',
      label: 'Light strip speed',
      group: 'Lighting',
      value: { kind: 'number', min: 0, max: SPEED_MAX, current: clamp(SPEED_MAX - block[STRIP_SPEED], 0, SPEED_MAX), unit: '' },
    });
    out.push({ key: 'strip_color', label: 'Light strip colour', group: 'Lighting', value: { kind: 'color', rgb: rgb(block[STRIP_RGB], block[STRIP_RGB + 1], block[STRIP_RGB + 2]) } });

    // --- receiver / dongle light (only the full config has one)
    if (this.pid !== SINGLE_PID) {
      const dmode = block[DONGLE_MODE];
      const dmodes: [string, number][] = DONGLE_MODES.map(([l, m]) => [l, m]);
      if (!DONGLE_MODES.some(([, m]) => m === dmode)) dmodes.push([`Mode ${dmode}`, dmode]);
      out.push({ key: 'dongle_mode', label: 'Receiver light effect', group: 'Lighting', value: { kind: 'choice', options: dmodes, current: dmode } });
      out.push({
        key: 'dongle_bri',
        label: 'Receiver light brightness',
        group: 'Lighting',
        value: { kind: 'number', min: 0, max: 100, current: clamp(Math.round((block[DONGLE_BRI] * 100) / DONGLE_BRI_MAX), 0, 100), unit: '%' },
      });
      out.push({
        key: 'dongle_speed',
        label: 'Receiver light speed',
        group: 'Lighting',
        value: { kind: 'number', min: 0, max: SPEED_MAX, current: clamp(SPEED_MAX - block[DONGLE_SPEED], 0, SPEED_MAX), unit: '' },
      });
      out.push({ key: 'dongle_color', label: 'Receiver light colour', group: 'Lighting', value: { kind: 'color', rgb: rgb(block[DONGLE_RGB], block[DONGLE_RGB + 1], block[DONGLE_RGB + 2]) } });
    }
    return out;
  }

  // --- writes

  private async writeBlock(change: (b: number[]) => void): Promise<void> {
    const block = await this.readBlock();
    const want = block.slice();
    change(want);
    if (want.every((v, i) => v === block[i])) return;
    await this.link.write(CMD.WRITE_FUNC, want, this.profile * PROFILE_SIZE);
    await sleep(lofreeTiming.settle);
    const got = await this.readBlock();
    const bad = want.findIndex((v, i) => got[i] !== v);
    if (bad >= 0) throw new Error(`keyboard didn't take the lighting change (byte ${bad} reads ${hex2(got[bad])})`);
  }

  /** Write new actuation words / RT table for the given keys, then read back. */
  private async writeTriggers(
    m: Magnetic,
    acts: Map<number, number>,
    rts: Map<number, [number, number]>,
  ): Promise<void> {
    if (acts.size) {
      const cur = await this.readAct();
      const next = cur.slice();
      for (const [k, w] of acts) put16(next, k * 2, w);
      await this.link.write(CMD.WRITE_ACT, next, KEY_SLOTS * 2 * this.profile);
    }
    if (rts.size) {
      const cur = await this.readRt();
      const next = cur.slice();
      for (const [k, [p, r]] of rts) {
        put16(next, k * 4, p);
        put16(next, k * 4 + 2, r);
      }
      await this.link.write(CMD.WRITE_RT, next, KEY_SLOTS * 4 * this.profile);
    }
    await sleep(lofreeTiming.settle);
    m.act = await this.readAct();
    m.rt = await this.readRt();
    const label = (k: number) => HYZEN_LAYOUT[m.idx.indexOf(k)]?.[1] ?? `#${k}`;
    const bad = new Set<string>();
    let first: string | undefined;
    // the tables hold raw u16s that the firmware keeps as sent (the official app reads them back
    // verbatim for display), so the comparison is exact at the device's own resolution
    for (const [k, w] of acts) {
      const got = u16(m.act, k * 2);
      if (got === w) continue;
      bad.add(label(k));
      first ??= `${label(k)}: sent actuation ${describeAct(w, m.maxRaw[k], m.spec.maxMm)}, reads back ${describeAct(got, m.maxRaw[k], m.spec.maxMm)}`;
    }
    for (const [k, [p, r]] of rts) {
      const gp = u16(m.rt, k * 4);
      const gr = u16(m.rt, k * 4 + 2);
      if (gp === p && gr === r) continue;
      bad.add(label(k));
      first ??= `${label(k)}: sent RT ${describeRt(p, r, m.maxRaw[k], m.spec.maxMm)}, reads back ${describeRt(gp, gr, m.maxRaw[k], m.spec.maxMm)}`;
    }
    if (bad.size) throw new Error(`keyboard didn't take the trigger change for: ${[...bad].join(', ')} (${first})`);
  }

  /** RT distances for a key that is switched to Rapid Trigger but has none stored yet. */
  private rtFor(m: Magnetic, k: number, sensMm?: number): [number, number] {
    if (sensMm !== undefined) {
      const raw = mmToRaw(sensMm, m.maxRaw[k], m.spec.maxMm, false);
      return [raw, raw];
    }
    const p = u16(m.rt, k * 4);
    const r = u16(m.rt, k * 4 + 2);
    if (p && r) return [p, r];
    const raw = mmToRaw(0.3, m.maxRaw[k], m.spec.maxMm, false);
    return [p || raw, r || raw];
  }

  private async writeInner(s: Setting): Promise<void> {
    const v = s.value;
    const mag = () => {
      if (!this.mag) throw new Error('press Re-read first (and the keyboard must be in magnetic switch mode)');
      return this.mag;
    };
    switch (`${s.key}:${v.kind}`) {
      case 'polling:choice': {
        const code = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!POLLING.some(([, c]) => c === code)) throw new Error('unsupported polling rate');
        await this.link.write(CMD.WRITE_FUNC, [code], this.pollOffset());
        await sleep(lofreeTiming.settle);
        const got = await this.readPoll();
        if (got !== code) throw new Error(`polling rate reads back as code ${got}`);
        return;
      }
      case 'light_mode:choice': {
        const mode = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!LIGHT_MODES.some(([, m]) => m === mode)) throw new Error('unknown lighting effect');
        return this.writeBlock((b) => (b[L_MODE] = mode));
      }
      case 'light_bri:number': {
        const pct = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, 100);
        return this.writeBlock((b) => (b[L_BRI] = clamp(Math.ceil((pct * BRI_RAW_MAX) / 100), 0, BRI_RAW_MAX)));
      }
      case 'light_speed:number': {
        const ui = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, SPEED_MAX);
        return this.writeBlock((b) => (b[L_SPEED] = SPEED_MAX - ui));
      }
      case 'light_color:color': {
        const c = (v as Extract<Value, { kind: 'color' }>).rgb;
        return this.writeBlock((b) => {
          b[L_CUSTOM] = 1;
          b[L_RGB] = (c >> 16) & 0xff;
          b[L_RGB + 1] = (c >> 8) & 0xff;
          b[L_RGB + 2] = c & 0xff;
        });
      }
      case 'strip_mode:choice': {
        const mode = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!STRIP_MODES.some(([, m]) => m === mode)) throw new Error('unknown light-strip effect');
        return this.writeBlock((b) => (b[STRIP_MODE] = mode));
      }
      case 'strip_bri:number': {
        const pct = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, 100);
        return this.writeBlock((b) => (b[STRIP_BRI] = clamp(pct, 0, STRIP_BRI_MAX)));
      }
      case 'strip_speed:number': {
        const ui = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, SPEED_MAX);
        return this.writeBlock((b) => (b[STRIP_SPEED] = SPEED_MAX - ui));
      }
      case 'strip_color:color': {
        const c = (v as Extract<Value, { kind: 'color' }>).rgb;
        return this.writeBlock((b) => {
          b[STRIP_CUSTOM] = 1;
          b[STRIP_RGB] = (c >> 16) & 0xff;
          b[STRIP_RGB + 1] = (c >> 8) & 0xff;
          b[STRIP_RGB + 2] = c & 0xff;
        });
      }
      case 'dongle_mode:choice': {
        if (this.pid === SINGLE_PID) throw new Error('this model has no receiver light');
        const mode = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!DONGLE_MODES.some(([, m]) => m === mode)) throw new Error('unknown receiver-light effect');
        return this.writeBlock((b) => (b[DONGLE_MODE] = mode));
      }
      case 'dongle_bri:number': {
        if (this.pid === SINGLE_PID) throw new Error('this model has no receiver light');
        const pct = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, 100);
        return this.writeBlock((b) => (b[DONGLE_BRI] = clamp(Math.ceil((pct * DONGLE_BRI_MAX) / 100), 0, DONGLE_BRI_MAX)));
      }
      case 'dongle_speed:number': {
        if (this.pid === SINGLE_PID) throw new Error('this model has no receiver light');
        const ui = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, SPEED_MAX);
        return this.writeBlock((b) => (b[DONGLE_SPEED] = SPEED_MAX - ui));
      }
      case 'dongle_color:color': {
        if (this.pid === SINGLE_PID) throw new Error('this model has no receiver light');
        const c = (v as Extract<Value, { kind: 'color' }>).rgb;
        return this.writeBlock((b) => {
          b[DONGLE_RGB] = (c >> 16) & 0xff;
          b[DONGLE_RGB + 1] = (c >> 8) & 0xff;
          b[DONGLE_RGB + 2] = c & 0xff;
          b[DONGLE_CUSTOM] = 1;
        });
      }
      case 'actuation:float': {
        const m = mag();
        const mm = (v as Extract<Value, { kind: 'float' }>).current;
        const acts = new Map<number, number>();
        for (const [, k] of present(m.idx)) {
          const w = u16(m.act, k * 2);
          acts.set(k, (w & (ACT_DEADZONE | ACT_RT)) | mmToRaw(mm, m.maxRaw[k], m.spec.maxMm, true));
        }
        return this.writeTriggers(m, acts, new Map());
      }
      case 'rapid_trigger:toggle': {
        const m = mag();
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        const acts = new Map<number, number>();
        const rts = new Map<number, [number, number]>();
        for (const [, k] of present(m.idx)) {
          const w = u16(m.act, k * 2);
          acts.set(k, on ? w | ACT_RT : w & ~ACT_RT);
          if (on && !(u16(m.rt, k * 4) && u16(m.rt, k * 4 + 2))) rts.set(k, this.rtFor(m, k));
        }
        return this.writeTriggers(m, acts, rts);
      }
      case 'rt_sens:float': {
        const m = mag();
        const mm = (v as Extract<Value, { kind: 'float' }>).current;
        const rts = new Map<number, [number, number]>();
        for (const [, k] of present(m.idx)) rts.set(k, this.rtFor(m, k, mm));
        return this.writeTriggers(m, new Map(), rts);
      }
      case 'socd:socd':
        return this.writeSocd(mag(), v as Socd);
      case 'per_key_trigger:perKeyTrigger': {
        const m = mag();
        const p = v as Extract<Value, { kind: 'perKeyTrigger' }>;
        const keys = present(m.idx);
        if (p.travel.length !== keys.length || p.rapid.length !== keys.length || p.sens.length !== keys.length) {
          throw new Error("per-key data doesn't match the keyboard layout - press Re-read");
        }
        const acts = new Map<number, number>();
        const rts = new Map<number, [number, number]>();
        keys.forEach(([, k], i) => {
          const w = u16(m.act, k * 2);
          let nw = w;
          if (r2(p.travel[i]) !== this.actMm(m, k)) nw = (nw & (ACT_DEADZONE | ACT_RT)) | mmToRaw(p.travel[i], m.maxRaw[k], m.spec.maxMm, true);
          nw = p.rapid[i] ? nw | ACT_RT : nw & ~ACT_RT;
          if (nw !== w) acts.set(k, nw);
          if (r2(p.sens[i]) !== this.sensMm(m, k)) rts.set(k, this.rtFor(m, k, p.sens[i]));
          else if (p.rapid[i] && !(w & ACT_RT) && !(u16(m.rt, k * 4) && u16(m.rt, k * 4 + 2))) rts.set(k, this.rtFor(m, k));
        });
        if (!acts.size && !rts.size) return;
        return this.writeTriggers(m, acts, rts);
      }
      default:
        throw new Error(`${s.key} can't be changed`);
    }
  }
}

const modelFor = (pid: number) => MODELS.find((m) => m[0] === pid);

export const lofreeFactory: DriverFactory = {
  name: 'Lofree',
  filters: MODELS.map(([productId]) => ({ vendorId: VID, productId, usagePage: USAGE_PAGE, usage: USAGE })),
  match(d: HIDDevice): boolean {
    return (
      d.vendorId === VID &&
      modelFor(d.productId) !== undefined &&
      (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE)
    );
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!lofreeFactory.match(device)) return null;
    const [pid, name, dongle] = modelFor(device.productId)!;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const link = new Link(device, frameSize(dongle));
    const drv = new Hyzen(link, name, dongle, pid);
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
