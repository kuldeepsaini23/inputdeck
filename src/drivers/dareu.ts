// DAREU keyboards on DAREU's own "TG" firmware (自研固件), VID 0x260D.
// Ported from DAREU's official WebHID configurator (driver.dareu.com/allinone, device/tgdevice.js);
// not yet checked on real hardware, so the driver is `verified = false` (read-only until allowed).
//
// Classes: FwType 0/1 = TgKeyboard, FwType 6 = magnetic TgRtKeyboard (TgKeyboard + class 13).
// FwType 2 (Jm), 4 (Heying OHID) and 5 boards speak other protocols and are NOT claimed here.
//
// Transport: feature reports on the interface whose collection is UP 0x000C usage 0x0001.
//   FwType 0/6: report id 0 (no id), FwType 1: report id 0x0A. 64-byte frames, no checksum.
//   Request: sendFeatureReport(id, frame); reply: receiveFeatureReport(id), polled until
//   (reply[0] & 0x0F) == 2 ("done"). Windows returns 65 bytes (id + 64).
// Frame: [0] status/target (0 = wired) [1] payload size [2] class [3] command (| 0x80 = GET)
//        [4] profile [5] 0 [6..] payload.
//
// NEVER sent (the allowlist refuses everything not listed in `allowed()`): DEVICE RESET (class 0
// cmd 8 = factory reset), class 5 profile create/delete/reset, DFU (class 9), TEST (class 10, incl.
// factory defaults), FLASH (class 12), magnetic calibration (class 13 cmd 10), normal-trigger
// reset (13/1), global travel SET (13/7 - the vendor's own SetGlobalTravel can't run), key
// assignment / macros / DKS / MT / TGL writes, and anything undocumented. SOCD (13/11) only as the
// exact per-key set / remove frames below.

import { DAREU_LAYOUTS, DAREU_PRODUCTS, type DareuProduct } from './dareu-products';
import type { Driver, DriverFactory, KeyCap, Setting, Socd, Value } from './types';
import { sleep } from './types';

export const VID = 0x260d;
export const REPORT_SIZE = 64;
export const PAYLOAD = 6;
export const GET = 0x80;
const CMD_UP = 0x000c;
const CMD_USAGE = 0x0001;

export const CLS = { DEVICE: 0, LIGHTING: 3, PROFILE: 5, MAGNETIC: 13 } as const;
/** class 0 */
export const DEV = { FW_VER: 0, POLLING: 4 } as const;
/** class 3 */
export const LED = { ID_LIST: 0, ATTRIBUTE: 1, EFFECT: 2, BRIGHTNESS: 3 } as const;
/** class 5 */
export const PFL = { ACTIVE: 3 } as const;
/** class 13 */
export const MAG = {
  KEY_FUNCTION: 0,
  NORMAL_TRIGGER: 1,
  SINGLE_TRIGGER: 2,
  RAPID_TRIGGER: 3,
  MT: 4,
  TGL: 5,
  DKS: 6,
  GLOBAL_TRAVEL: 7,
  SOCD: 11,
  RT_ADAPTIVE: 14,
  FUNC_AND_SOCD: 17,
} as const;

/** Per-key function ids (class 13 cmd 0 / cmd 17). 3..6 = MT / TGL / DKS / SOCD. */
export const FN_NORMAL = 0;
export const FN_SINGLE = 1;
export const FN_RAPID = 2;
export const FN_MT = 3;
export const FN_TGL = 4;
export const FN_DKS = 5;
export const FN_SOCD = 6;
/** MT / TGL / DKS: keys with these can't be put in SOCD (it would silently drop them) */
const FN_OTHER_SPECIAL = new Set([FN_MT, FN_TGL, FN_DKS]);
/**
 * Vendor GetAllMaKeyInformation: a cmd-0 function id >= 7 (the number of known ids) is treated
 * as a normal-trigger key.
 */
export const normFunc = (f: number) => (f >= 7 ? FN_NORMAL : f);
/** Key ids >= 170 are the knob (rotate / press): the vendor's key-travel page never offers them. */
export const KNOB_KEY_MIN = 170;
/** keys per FUNC_AND_SOCD request (vendor GetFunctionAndSOCD) */
export const FUNC_SOCD_BATCH = 14;
/** Magnetic products whose JSON says `KeyTravel.RtSelfAdaptive: true`. */
export const RT_ADAPTIVE_PIDS = new Set([
  0x0117, 0x0119, 0x0126, 0x0166, 0x0175, 0x0191, 0x0194, 0x0195, 0x0196, 0x0198, 0x0199, 0x0209, 0x0214,
  0x0216, 0x0229, 0x0236,
]);

/** SOCD (class 13 cmd 11 "ST_FUNCTION"): 4 groups, last input wins inside a group. */
export const SOCD_GROUPS = 4;
/** group byte of a key that isn't in SOCD */
export const SOCD_NONE = 0xff;
/** keys per RemoveBindingEx frame (as the vendor sends them) */
const SOCD_REMOVE_BATCH = 10;
/** Firmware from 0.3.0 removes keys from SOCD with (key, FF) pairs; older firmware can't without a trigger reset. */
export const SOCD_REMOVE_FW = 0x000300;
/**
 * Magnetic products whose JSON says `KeyBinding.SupportSOCD: true` (driver.dareu.com/allinone
 * products/XXXX.json). FwType 6 boards without it: 0092 0103 0107 0113 0115 0129 0131 0132 0152.
 */
export const SOCD_PIDS = new Set([
  0x0105, 0x0106, 0x0117, 0x0119, 0x0123, 0x0124, 0x0126, 0x0127, 0x0136, 0x0139, 0x0140, 0x0164, 0x0165,
  0x0166, 0x0169, 0x0174, 0x0175, 0x0179, 0x0180, 0x0187, 0x0188, 0x0191, 0x0192, 0x0193, 0x0194, 0x0195,
  0x0196, 0x0198, 0x0199, 0x0201, 0x0205, 0x0208, 0x0209, 0x0214, 0x0216, 0x0223, 0x0224, 0x0229, 0x0230,
  0x0232, 0x0234, 0x0236, 0x0237, 0x0238, 0x0239, 0x0241, 0x0244, 0x0249, 0x0252, 0x0253,
]);

/** Polling rate ids per USB type (vendor POLLING_RATE_MAP). */
export const POLLING_MAP: [id: number, hz: number][][] = [
  [[8, 125], [4, 250], [2, 500], [1, 1000]],
  [[64, 125], [32, 250], [16, 500], [8, 1000], [4, 2000], [2, 4000], [1, 8000]],
];
const RATE_IDS = new Set([1, 2, 4, 8, 16, 32, 64]);

export const EFFECTS: [number, string][] = [
  [0, 'Off'], [1, 'Static'], [2, 'Breathing'], [3, 'Neon'], [4, 'Reactive'], [5, 'Wave'], [6, 'Raindrop'],
  [7, 'Gather'], [8, 'Ripple'], [9, 'Running light'], [10, 'Rotate'], [11, 'Starlit'], [12, 'Heat-up'],
  [19, 'Lap'], [20, 'Rainbow wheel'], [21, 'Light wave'], [22, 'Steady stream'], [23, 'Start-up'],
  [24, 'Area reactive'], [25, 'Line reactive'], [26, 'Waterfall'], [27, 'Scanning'], [28, 'Heartbeat'],
  [29, 'Fluxay'], [30, 'Heart breath'], [31, 'Moon breath'], [32, 'Star breath'],
];
/** 13..18 are custom / streaming frames: never offered or sent. */
const isEffect = (e: number) => e >= 0 && e <= 32 && !(e >= 13 && e <= 18);
const MAX_COLORS = 17;
/** Brightness is shown as 0..BRI_STEPS (device: 0..255). */
const BRI_STEPS = 5;

/** Timings (ms). Mutable only so tests can shorten them. */
export const dareuTiming = {
  /** wait between reply polls */
  poll: 10,
  /** reply polls per request */
  tries: 20,
  /** pause after the fire-and-forget polling write */
  pollSettle: 300,
  /** extra read-backs of keys that didn't match yet (the vendor never reads back right away) */
  verifyRetries: 3,
  /** wait before each extra read-back */
  verifySettle: 150,
};

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------------
// products

export function productFor(pid: number): DareuProduct | undefined {
  return DAREU_PRODUCTS.find((p) => p.pid === pid);
}

export const reportIdFor = (p: DareuProduct) => (p.fw === 1 ? 0x0a : 0);

/** The board's keys for the UI (index = protocol key id). */
export function capsFor(p: DareuProduct): KeyCap[] {
  return (DAREU_LAYOUTS[p.layout] ?? []).map(([index, label, x, y, w, h]) => ({ index, label, x, y, w, h }));
}

/** mm per device unit for each magnetic value (undefined = not a usable magnetic board). */
export interface Units {
  tv: number;
  global: number;
  single: number;
  rtInit: number;
  rtPress: number;
  rtRelease: number;
}

export function unitsFor(p: DareuProduct): Units | undefined {
  if (p.fw !== 6 || !p.gt || !p.st || !p.rt || p.rt.length < 3) return undefined;
  const tv = p.tv ?? 1;
  if (tv < 0 || tv > 2) return undefined;
  const steps = [p.gt[5], p.st[5], p.rt[0][5], p.rt[1][5], p.rt[2][5]];
  // A98 RT (0x0136) ships step = 1 mm: obviously wrong, so don't guess
  if (steps.some((s) => !(s > 0 && s <= 0.1))) return undefined;
  // TravelVersion 2 halves the step of travel values (not of RT sensitivities)
  const half = tv >= 2 ? 0.5 : 1;
  return { tv, global: p.gt[5] * half, single: p.st[5] * half, rtInit: p.rt[0][5] * half, rtPress: p.rt[1][5], rtRelease: p.rt[2][5] };
}

// ---------------------------------------------------------------------------------------------
// packets

/** Build a 64-byte request frame. */
export function frame(cls: number, cmd: number, size: number, profile: number, payload: number[] = []): Uint8Array<ArrayBuffer> {
  const f = new Uint8Array(REPORT_SIZE);
  f[0] = 0; // wired target
  f[1] = size & 0xff;
  f[2] = cls;
  f[3] = cmd & 0xff;
  f[4] = profile & 0xff;
  payload.forEach((b, i) => (f[PAYLOAD + i] = b & 0xff));
  return f;
}

/** Exact allowlist of request frames. Everything else is refused before it reaches the device. */
export function allowed(f: ArrayLike<number>): boolean {
  if (f.length !== REPORT_SIZE || f[0] !== 0 || f[5] !== 0) return false;
  const size = f[1];
  const cls = f[2];
  const get = (f[3] & GET) !== 0;
  const cmd = f[3] & 0x7f;
  const prof = f[4];
  if (size > REPORT_SIZE - PAYLOAD) return false;
  const pl = (i: number) => (PAYLOAD + i < f.length ? f[PAYLOAD + i] : 0);
  const zeroFrom = (i: number) => {
    for (let k = PAYLOAD + i; k < f.length; k++) if (f[k] !== 0) return false;
    return true;
  };
  const profOk = prof < 16;
  /** [n, key, v.., key, v..]: stride = bytes per key, `vals` = how values must look */
  const keyList = (strides: Record<number, number>, vals: 'zero' | 'set') => {
    const n = pl(0);
    if (n < 1) return false;
    const stride = (size - 1) / n;
    const maxN = strides[stride];
    if (!Number.isInteger(stride) || maxN === undefined || n > maxN) return false;
    // value layout per stride: 2/4 = one byte per value, 3/7 = u16 per value
    const wide = stride === 3 || stride === 7;
    const nVals = stride === 2 || stride === 3 ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const b = 1 + stride * i;
      if (pl(b) === 0) return false;
      for (let v = 0; v < nVals; v++) {
        const at = b + 1 + v * (wide ? 2 : 1);
        const val = wide ? (pl(at) << 8) | pl(at + 1) : pl(at);
        if (vals === 'zero' ? val !== 0 : val === 0) return false;
      }
    }
    return zeroFrom(1 + stride * n);
  };
  switch (cls) {
    case CLS.DEVICE:
      if (get && cmd === DEV.FW_VER) return size === 3 && prof === 0 && zeroFrom(0);
      if (get && cmd === DEV.POLLING) return size === 2 && profOk && zeroFrom(0);
      if (!get && cmd === DEV.POLLING) return size === 2 && profOk && (pl(0) === 0 || pl(0) === 1) && RATE_IDS.has(pl(1)) && zeroFrom(2);
      return false;
    case CLS.PROFILE:
      return get && cmd === PFL.ACTIVE && size === 0 && prof === 0 && zeroFrom(0);
    case CLS.LIGHTING:
      if (get && cmd === LED.ID_LIST) {
        if (prof !== 0) return false;
        if (size === 1) return zeroFrom(0);
        const total = pl(0);
        const off = pl(1);
        return total >= 1 && off < total && size === 2 + Math.min(48, total - off) && zeroFrom(2);
      }
      if (get && cmd === LED.ATTRIBUTE) return size === 1 && prof === 0 && zeroFrom(1);
      if (get && cmd === LED.EFFECT) return size === 1 && profOk && zeroFrom(1);
      if (get && cmd === LED.BRIGHTNESS) return size === 2 && profOk && zeroFrom(1);
      if (!get && cmd === LED.BRIGHTNESS) return size === 2 && profOk && zeroFrom(2);
      if (!get && cmd === LED.EFFECT) {
        const n = pl(4);
        return (
          profOk && isEffect(pl(1)) && (pl(2) === 0 || pl(2) === 2) && pl(3) <= 3 &&
          n <= MAX_COLORS && size === 5 + 3 * n && zeroFrom(5 + 3 * n)
        );
      }
      return false;
    case CLS.MAGNETIC:
      if (get && cmd === MAG.FUNC_AND_SOCD) {
        // vendor GetFunctionAndSOCD: profile in the header, size n + 1, keys 4 bytes apart
        const n = pl(0);
        if (!profOk || n < 1 || n > FUNC_SOCD_BATCH || size !== n + 1) return false;
        for (let i = 0; i < n; i++) {
          if (pl(1 + 4 * i) === 0 || pl(2 + 4 * i) || pl(3 + 4 * i) || pl(4 + 4 * i)) return false;
        }
        return zeroFrom(1 + 4 * n);
      }
      if (prof !== 0) return false;
      if (cmd === MAG.RT_ADAPTIVE) return size === 1 && (get ? zeroFrom(0) : pl(0) <= 1 && zeroFrom(1));
      if (get && cmd === MAG.GLOBAL_TRAVEL) return (size === 1 || size === 2) && zeroFrom(0);
      if (get && cmd === MAG.KEY_FUNCTION) return keyList({ 2: 28 }, 'zero');
      if (cmd === MAG.SINGLE_TRIGGER) return keyList({ 2: 18, 3: 18 }, get ? 'zero' : 'set');
      if (cmd === MAG.RAPID_TRIGGER) return keyList({ 4: 14, 7: 8 }, get ? 'zero' : 'set');
      if (cmd === MAG.SOCD) {
        // GET one key: [1, key]
        if (get) return size === 3 && pl(0) === 1 && pl(1) !== 0 && zeroFrom(2);
        // SET one key: [1, key, group 0..3]
        if (size === 3 && pl(0) === 1) return pl(1) !== 0 && pl(2) < SOCD_GROUPS && zeroFrom(3);
        // RemoveBindingEx: [n, (key, FF) x n]; the size byte is n + 1 although 2n + 1 bytes
        // follow (vendor quirk, copied exactly)
        const n = pl(0);
        if (n < 1 || n > SOCD_REMOVE_BATCH || size !== n + 1) return false;
        for (let i = 0; i < n; i++) if (pl(1 + 2 * i) === 0 || pl(2 + 2 * i) !== SOCD_NONE) return false;
        return zeroFrom(1 + 2 * n);
      }
      return false;
    default:
      return false;
  }
}

export const fwVerPkt = () => frame(CLS.DEVICE, DEV.FW_VER | GET, 3, 0);
export const activeProfilePkt = () => frame(CLS.PROFILE, PFL.ACTIVE | GET, 0, 0);
export const getPollPkt = (profile: number) => frame(CLS.DEVICE, DEV.POLLING | GET, 2, profile);
export const setPollPkt = (profile: number, usbType: number, rate: number) => frame(CLS.DEVICE, DEV.POLLING, 2, profile, [usbType, rate]);
export const regionCountPkt = () => frame(CLS.LIGHTING, LED.ID_LIST | GET, 1, 0);
export const regionChunkPkt = (total: number, offset: number) =>
  frame(CLS.LIGHTING, LED.ID_LIST | GET, 2 + Math.min(48, total - offset), 0, [total, offset]);
export const attributePkt = (region: number) => frame(CLS.LIGHTING, LED.ATTRIBUTE | GET, 1, 0, [region]);
export const getEffectPkt = (profile: number, region: number) => frame(CLS.LIGHTING, LED.EFFECT | GET, 1, profile, [region]);
export const getBrightnessPkt = (profile: number, region: number) => frame(CLS.LIGHTING, LED.BRIGHTNESS | GET, 2, profile, [region]);
export const setBrightnessPkt = (profile: number, region: number, v: number) =>
  frame(CLS.LIGHTING, LED.BRIGHTNESS, 2, profile, [region, clamp(Math.round(v), 0, 255)]);

export interface Light {
  region: number;
  effect: number;
  flag: number;
  speed: number;
  /** 0xRRGGBB; empty = random colours */
  colors: number[];
}

export const rgb = (r: number, g: number, b: number) => ((r << 16) | (g << 8) | b) >>> 0;

export function setEffectPkt(profile: number, l: Light): Uint8Array<ArrayBuffer> {
  const cs = l.colors.slice(0, MAX_COLORS);
  const p = [l.region, l.effect, l.flag, l.speed, cs.length];
  for (const c of cs) p.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  return frame(CLS.LIGHTING, LED.EFFECT, 5 + 3 * cs.length, profile, p);
}

/** Effect GET reply -> light (region from the request). */
export function parseEffect(r: ArrayLike<number>, region: number): Light {
  const at = (i: number) => r[PAYLOAD + i] ?? 0;
  const n = Math.min(at(4), MAX_COLORS);
  const colors: number[] = [];
  for (let i = 0; i < n; i++) colors.push(rgb(at(5 + 3 * i), at(6 + 3 * i), at(7 + 3 * i)));
  return { region, effect: at(1), flag: at(2), speed: at(3), colors };
}

/** Attribute GET reply -> effect ids (custom/streaming frames dropped, like the vendor). */
export function parseEffectList(r: ArrayLike<number>): number[] {
  const at = (i: number) => r[PAYLOAD + i] ?? 0;
  const n = at(5);
  const out: number[] = [];
  for (let i = 0; i < n && 6 + i < REPORT_SIZE - PAYLOAD; i++) {
    const e = at(6 + i);
    if (isEffect(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

/** Region id list (multi-packet data): ids 0 and 1 are the same main region. */
export function mergeRegions(ids: number[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    if (id === 0 || id === 1) {
      if (!out.some((x) => x === 0 || x === 1)) out.push(id);
    } else if (!out.includes(id)) out.push(id);
  }
  return out;
}

export const fwVersion = (r: ArrayLike<number>) => `${r[PAYLOAD]}.${r[PAYLOAD + 1]}.${r[PAYLOAD + 2]}`;

// --- magnetic

/** One key's trigger, in mm. */
export interface KeyTrig {
  func: number;
  /** single-trigger travel or RT initial travel (unused for normal keys) */
  travel: number;
  press: number;
  release: number;
}

const wideOf = (u: Units) => u.tv >= 1;
const raw = (mm: number, unit: number) => Math.max(0, Math.round(mm / unit + 1e-9));
const mmOf = (r: number, unit: number) => Math.round(r * unit * 10000) / 10000;

export const globalTravelPkt = (u: Units) => frame(CLS.MAGNETIC, MAG.GLOBAL_TRAVEL | GET, wideOf(u) ? 2 : 1, 0);
export function parseGlobalTravel(r: ArrayLike<number>, u: Units): number {
  const v = wideOf(u) ? (r[PAYLOAD] << 8) | r[PAYLOAD + 1] : r[PAYLOAD];
  return mmOf(v, u.global);
}

export function keyFuncPkt(keys: number[]): Uint8Array<ArrayBuffer> {
  const p = [keys.length];
  for (const k of keys) p.push(k, 0);
  return frame(CLS.MAGNETIC, MAG.KEY_FUNCTION | GET, 2 * keys.length + 1, 0, p);
}
export const parseKeyFuncs = (r: ArrayLike<number>, n: number) => Array.from({ length: n }, (_, i) => r[PAYLOAD + 2 * i + 2]);

/**
 * FUNC_AND_SOCD GET (vendor GetFunctionAndSOCD, class 13 cmd 17): [n, (key, 0, 0, 0) x n] with
 * the active profile in the header and a size byte of n + 1 (vendor quirk, copied exactly).
 * The vendor trusts this over cmd 0 when it answers.
 */
export function funcSocdPkt(profile: number, keys: number[]): Uint8Array<ArrayBuffer> {
  if (keys.length < 1 || keys.length > FUNC_SOCD_BATCH) throw new Error('1..14 keys per FUNC_AND_SOCD frame');
  const p = new Array<number>(1 + 4 * keys.length).fill(0);
  p[0] = keys.length;
  keys.forEach((k, i) => (p[1 + 4 * i] = k));
  return frame(CLS.MAGNETIC, MAG.FUNC_AND_SOCD | GET, keys.length + 1, profile, p);
}
export interface FuncSocd {
  key: number;
  func: number;
  /** IsSOCD byte */
  socd: number;
  /** SOCD group (0..3, FF = none) */
  group: number;
}
/** Reply: (key, function, is SOCD, group) x n at payload 1 + 4i. */
export const parseFuncSocd = (r: ArrayLike<number>, n: number): FuncSocd[] =>
  Array.from({ length: n }, (_, i) => {
    const b = PAYLOAD + 1 + 4 * i;
    return { key: r[b], func: r[b + 1], socd: r[b + 2], group: r[b + 3] };
  });

export const getRtAdaptivePkt = () => frame(CLS.MAGNETIC, MAG.RT_ADAPTIVE | GET, 1, 0);
export const setRtAdaptivePkt = (on: boolean) => frame(CLS.MAGNETIC, MAG.RT_ADAPTIVE, 1, 0, [on ? 1 : 0]);
export const parseRtAdaptive = (r: ArrayLike<number>) => r[PAYLOAD] === 1;

const enc = (v: number, wide: boolean) => (wide ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff]);
const dec = (r: ArrayLike<number>, at: number, wide: boolean) => (wide ? (r[at] << 8) | r[at + 1] : r[at]);

export function getSinglePkt(u: Units, keys: number[]): Uint8Array<ArrayBuffer> {
  const stride = wideOf(u) ? 3 : 2;
  const p = [keys.length];
  for (const k of keys) p.push(k, ...new Array(stride - 1).fill(0));
  return frame(CLS.MAGNETIC, MAG.SINGLE_TRIGGER | GET, stride * keys.length + 1, 0, p);
}
export function parseSingle(r: ArrayLike<number>, u: Units, n: number): number[] {
  const w = wideOf(u);
  const stride = w ? 3 : 2;
  return Array.from({ length: n }, (_, i) => mmOf(dec(r, PAYLOAD + stride * i + 2, w), u.single));
}
export function setSinglePkt(u: Units, keys: number[], travel: number): Uint8Array<ArrayBuffer> {
  const w = wideOf(u);
  const v = Math.max(1, raw(travel, u.single));
  const p = [keys.length];
  for (const k of keys) p.push(k, ...enc(v, w));
  return frame(CLS.MAGNETIC, MAG.SINGLE_TRIGGER, (w ? 3 : 2) * keys.length + 1, 0, p);
}

export const rtBatch = (u: Units) => (wideOf(u) ? 8 : 14);
export function getRtPkt(u: Units, keys: number[]): Uint8Array<ArrayBuffer> {
  const stride = wideOf(u) ? 7 : 4;
  const p = [keys.length];
  for (const k of keys) p.push(k, ...new Array(stride - 1).fill(0));
  return frame(CLS.MAGNETIC, MAG.RAPID_TRIGGER | GET, stride * keys.length + 1, 0, p);
}
export function parseRt(r: ArrayLike<number>, u: Units, n: number): { travel: number; press: number; release: number }[] {
  const w = wideOf(u);
  const stride = w ? 7 : 4;
  const vs = w ? 2 : 1;
  return Array.from({ length: n }, (_, i) => {
    const b = PAYLOAD + stride * i + 2;
    return {
      travel: mmOf(dec(r, b, w), u.rtInit),
      press: mmOf(dec(r, b + vs, w), u.rtPress),
      release: mmOf(dec(r, b + 2 * vs, w), u.rtRelease),
    };
  });
}
export function setRtPkt(u: Units, keys: number[], travel: number, press: number, release: number): Uint8Array<ArrayBuffer> {
  const w = wideOf(u);
  const vals = [
    Math.max(1, raw(travel, u.rtInit)),
    Math.max(1, raw(press, u.rtPress)),
    Math.max(1, raw(release, u.rtRelease)),
  ];
  const p = [keys.length];
  for (const k of keys) p.push(k, ...vals.flatMap((v) => enc(v, w)));
  return frame(CLS.MAGNETIC, MAG.RAPID_TRIGGER, (w ? 7 : 4) * keys.length + 1, 0, p);
}

const isEditable = (f: number) => f === FN_NORMAL || f === FN_SINGLE || f === FN_RAPID;

const FN_NAMES: Record<number, string> = { 0: 'normal', 1: 'single', 2: 'RT', 3: 'MT', 4: 'TGL', 5: 'DKS', 6: 'SOCD' };
const mm2 = (v: number) => String(Math.round(v * 10000) / 10000);

/** One key's trigger in words, mm and raw device units, for error messages and Feedback. */
export function describeTrig(k: KeyTrig, u: Units): string {
  const fn = `${FN_NAMES[k.func] ?? 'function'} (${k.func})`;
  if (k.func === FN_SINGLE) return `${fn} ${mm2(k.travel)} mm [raw ${raw(k.travel, u.single)}]`;
  if (k.func === FN_RAPID) {
    return (
      `${fn} start ${mm2(k.travel)} / press ${mm2(k.press)} / release ${mm2(k.release)} mm ` +
      `[raw ${raw(k.travel, u.rtInit)}/${raw(k.press, u.rtPress)}/${raw(k.release, u.rtRelease)}]`
    );
  }
  return fn;
}

// --- SOCD

export const getSocdPkt = (key: number) => frame(CLS.MAGNETIC, MAG.SOCD | GET, 3, 0, [1, key]);
/** the reply's group byte: 0..3 = in that group, anything else (FF) = not SOCD */
export const parseSocd = (r: ArrayLike<number>) => (r[PAYLOAD + 2] < SOCD_GROUPS ? r[PAYLOAD + 2] : -1);
export const setSocdPkt = (key: number, group: number) => {
  if (!(group >= 0 && group < SOCD_GROUPS)) throw new Error(`SOCD group ${group + 1} doesn't exist`);
  return frame(CLS.MAGNETIC, MAG.SOCD, 3, 0, [1, key, group]);
};
/** RemoveBindingEx (firmware 0.3.0+): size byte n + 1 although 2n + 1 bytes follow, like the vendor. */
export function removeSocdPkt(keys: number[]): Uint8Array<ArrayBuffer> {
  if (keys.length < 1 || keys.length > SOCD_REMOVE_BATCH) throw new Error('1..10 keys per SOCD remove frame');
  const p = [keys.length];
  for (const k of keys) p.push(k, SOCD_NONE);
  return frame(CLS.MAGNETIC, MAG.SOCD, keys.length + 1, 0, p);
}
/** firmware bytes [a, b, c] -> 0xAABBCC (vendor FwVer) */
export const fwNumber = (fw: ArrayLike<number>) => ((fw[0] << 16) | (fw[1] << 8) | fw[2]) >>> 0;

/**
 * UI value -> the SOCD group of every layout key (-1 = none). Throws when a key is in two groups,
 * when the group count is wrong or a position doesn't exist.
 */
export function planSocd(v: Socd, caps: KeyCap[]): number[] {
  if (v.mode !== 'groups' || v.entries.length !== SOCD_GROUPS) throw new Error("SOCD data doesn't match the keyboard - press Re-read");
  const want = new Array<number>(caps.length).fill(-1);
  v.entries.forEach((e, g) => {
    for (const k of e.keys) {
      if (!(k >= 0 && k < caps.length)) throw new Error("SOCD data doesn't match the keyboard - press Re-read");
      if (want[k] >= 0 && want[k] !== g) throw new Error(`${caps[k].label} is in two SOCD groups`);
      want[k] = g;
    }
  });
  return want;
}

/** Two triggers equal at device resolution. */
export function sameTrig(a: KeyTrig, b: KeyTrig, u: Units): boolean {
  if (a.func !== b.func) return false;
  if (a.func === FN_SINGLE) return raw(a.travel, u.single) === raw(b.travel, u.single);
  if (a.func === FN_RAPID) {
    return (
      raw(a.travel, u.rtInit) === raw(b.travel, u.rtInit) &&
      raw(a.press, u.rtPress) === raw(b.press, u.rtPress) &&
      raw(a.release, u.rtRelease) === raw(b.release, u.rtRelease)
    );
  }
  return true;
}

export interface MagRanges {
  travelMin: number;
  travelMax: number;
  step: number;
  sensMin: number;
  sensMax: number;
  rtMin: number;
  rtMax: number;
}

export function rangesFor(p: DareuProduct): MagRanges {
  const gt = p.gt!;
  const rt = p.rt!;
  return {
    travelMin: gt[0],
    travelMax: gt[3],
    step: gt[5],
    sensMin: rt[1][0],
    sensMax: Math.max(rt[1][3], rt[1][0]),
    rtMin: rt[0][0],
    rtMax: Math.max(rt[0][3], rt[0][0]),
  };
}

/** What the UI shows for a key: [actuation, rapid, sensitivity]. */
export function shown(k: KeyTrig, global: number, sensDefault: number): [number, boolean, number] {
  if (k.func === FN_SINGLE) return [k.travel, false, sensDefault];
  if (k.func === FN_RAPID) return [k.travel, true, k.press];
  return [global, false, sensDefault];
}

/**
 * Work out every key the UI changed: [layout position, new trigger][]. Unchanged keys (equal at
 * device resolution) are left out. Throws on a length mismatch or when a changed key uses a
 * function we don't edit (MT/TGL/DKS/SOCD).
 */
export function planKeyTrigs(
  old: KeyTrig[],
  labels: string[],
  global: number,
  sensDefault: number,
  u: Units,
  r: MagRanges,
  travel: number[],
  rapid: boolean[],
  sens: number[],
  /** positions without an adjustable switch (knob) */
  fixed: ReadonlySet<number> = new Set(),
): [number, KeyTrig][] {
  const n = old.length;
  if (travel.length !== n || rapid.length !== n || sens.length !== n) {
    throw new Error("per-key data doesn't match the keyboard layout - press Re-read");
  }
  const out: [number, KeyTrig][] = [];
  old.forEach((o, i) => {
    const [t0, r0, s0] = shown(o, global, sensDefault);
    const travelChanged = raw(travel[i], u.single) !== raw(t0, u.single);
    const sensChanged = raw(sens[i], u.rtPress) !== raw(s0, u.rtPress);
    if (!travelChanged && rapid[i] === r0 && !(rapid[i] && sensChanged)) return;
    if (fixed.has(i)) throw new Error(`${labels[i] ?? '?'} has no adjustable switch`);
    if (!isEditable(o.func)) {
      throw new Error(`${labels[i] ?? '?'} uses a special key function (${o.func}) - change it in the DAREU app`);
    }
    let next: KeyTrig;
    if (rapid[i]) {
      const t = clamp(travel[i], Math.max(r.rtMin, r.travelMin), Math.min(r.rtMax, r.travelMax));
      const press = clamp(sens[i], r.sensMin, r.sensMax);
      // keep a separate release sensitivity unless the sensitivity itself changed
      const release = o.func === FN_RAPID && !sensChanged ? o.release : press;
      next = { func: FN_RAPID, travel: t, press, release };
    } else {
      next = { func: FN_SINGLE, travel: clamp(travel[i], r.travelMin, r.travelMax), press: 0, release: 0 };
    }
    out.push([i, next]);
  });
  return out;
}

/** Group changes by identical values -> request frames (key ids from `caps`). */
export function planPackets(changes: [number, KeyTrig][], caps: KeyCap[], u: Units): Uint8Array<ArrayBuffer>[] {
  const groups = new Map<string, [KeyTrig, number[]]>();
  for (const [i, k] of changes) {
    const id =
      k.func === FN_RAPID
        ? `r${raw(k.travel, u.rtInit)},${raw(k.press, u.rtPress)},${raw(k.release, u.rtRelease)}`
        : `s${raw(k.travel, u.single)}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = [k, []]));
    g[1].push(caps[i].index);
  }
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (const [k, keys] of groups.values()) {
    const per = k.func === FN_RAPID ? rtBatch(u) : 18;
    for (let i = 0; i < keys.length; i += per) {
      const chunk = keys.slice(i, i + per);
      out.push(k.func === FN_RAPID ? setRtPkt(u, chunk, k.travel, k.press, k.release) : setSinglePkt(u, chunk, k.travel));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// transport

/** Reply bytes as the vendor reads them: strip the report id byte Windows adds. */
export function normalizeReply(d: Uint8Array): Uint8Array {
  if (d.length === REPORT_SIZE + 1) return d.slice(1);
  if (d[0] & 0x0f) return d.slice();
  return d.slice(1);
}

class Link {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dev: HIDDevice,
    readonly reportId: number,
  ) {}

  lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  private check(f: Uint8Array) {
    if (!allowed(f)) throw new Error(`refusing to send ${hexs(f.slice(0, 10))}`);
  }

  /** Send one request and poll for its reply (status low nibble 2 = done). */
  async xfer(f: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    this.check(f);
    await this.dev.sendFeatureReport(this.reportId, f);
    for (let i = 0; i < dareuTiming.tries; i++) {
      const dv = await this.dev.receiveFeatureReport(this.reportId);
      const r = normalizeReply(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
      if ((r[0] & 0x0f) === 2) return r;
      await sleep(dareuTiming.poll);
    }
    throw new Error(`no answer for ${hex2(f[2])}/${hex2(f[3])}`);
  }

  /** Fire-and-forget write (the vendor sends the polling rate this way). */
  async send(f: Uint8Array<ArrayBuffer>): Promise<void> {
    this.check(f);
    await this.dev.sendFeatureReport(this.reportId, f);
  }
}

// ---------------------------------------------------------------------------------------------
// driver

const text = (key: string, label: string, group: string, s: string): Setting => ({ key, label, group, value: { kind: 'text', text: s } });
const effectName = (e: number) => EFFECTS.find((x) => x[0] === e)?.[1] ?? `Effect ${e}`;
const DEFAULT_EFFECTS = [1, 2, 4, 9, 11, 19];

class Dareu implements Driver {
  readonly id: string;
  readonly family = 'DAREU TG firmware';
  readonly kind = 'keyboard' as const;
  readonly verified = false;

  private readonly caps: KeyCap[];
  private readonly units: Units | undefined;
  private readonly ranges: MagRanges | undefined;
  private profile = 0;
  private fw: string | undefined;
  private light: Light | undefined;
  private lastEffect = 1;
  private lastColor = 0xffffff;
  private poll: { usbType: number; rate: number } | undefined;
  private global: number | undefined;
  private keyTrigs: KeyTrig[] | undefined;
  private sensDefault: number;
  private fwRaw: number[] = [0, 0, 0];
  /** SOCD group per layout key (-1 = none), when the board has SOCD */
  private socd: number[] | undefined;
  /** the board answers FUNC_AND_SOCD (class 13 cmd 17) */
  private funcSocd: boolean | undefined;
  /** RT self-adaptive switch (products with RtSelfAdaptive), when readable */
  private rtAdaptive: boolean | undefined;
  /** layout positions without an adjustable switch (knob ids >= 170) */
  private readonly fixed: Set<number>;

  constructor(
    private readonly link: Link,
    private readonly product: DareuProduct,
  ) {
    const d = link.dev;
    this.id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    this.caps = capsFor(product);
    this.units = unitsFor(product);
    this.ranges = this.units ? rangesFor(product) : undefined;
    this.sensDefault = product.rt?.[1]?.[4] ?? 0.3;
    this.fixed = new Set(this.caps.map((c, i) => (c.index >= KNOB_KEY_MIN ? i : -1)).filter((i) => i >= 0));
  }

  brand() {
    return 'DAREU';
  }
  model() {
    return this.product.name;
  }
  image() {
    return undefined;
  }
  layout() {
    return this.caps;
  }

  read(): Promise<Setting[]> {
    return this.link.lock(() => this.readInner());
  }
  write(s: Setting): Promise<void> {
    return this.link.lock(() => this.writeInner(s));
  }
  async close(): Promise<void> {
    if (this.link.dev.opened) await this.link.dev.close();
  }

  async identify(): Promise<string> {
    const r = await this.link.xfer(fwVerPkt());
    this.fwRaw = [r[PAYLOAD], r[PAYLOAD + 1], r[PAYLOAD + 2]];
    this.fw = fwVersion(r);
    return this.fw;
  }

  // --- reads

  private async readProfile(): Promise<number> {
    const r = await this.link.xfer(activeProfilePkt());
    return r[4];
  }

  private async readPoll(): Promise<{ usbType: number; rate: number }> {
    const r = await this.link.xfer(getPollPkt(this.profile));
    return { usbType: r[PAYLOAD], rate: r[PAYLOAD + 1] };
  }

  private async readRegions(): Promise<number[]> {
    const first = await this.link.xfer(regionCountPkt());
    const total = first[PAYLOAD];
    const ids: number[] = [];
    for (let off = 0; off < total; ) {
      const n = Math.min(48, total - off);
      const r = await this.link.xfer(regionChunkPkt(total, off));
      for (let i = 0; i < n; i++) ids.push(r[PAYLOAD + 2 + i]);
      off += n;
    }
    return mergeRegions(ids);
  }

  private async readEffect(region: number): Promise<Light> {
    return parseEffect(await this.link.xfer(getEffectPkt(this.profile, region)), region);
  }

  private async readBrightness(region: number): Promise<number> {
    const r = await this.link.xfer(getBrightnessPkt(this.profile, region));
    return r[PAYLOAD + 1];
  }

  /** cmd 17 (FUNC_AND_SOCD) functions of these key ids; undefined when the board doesn't answer it. */
  private async readFuncSocd(ids: number[]): Promise<number[] | undefined> {
    const out: number[] = [];
    for (let s = 0; s < ids.length; s += FUNC_SOCD_BATCH) {
      const chunk = ids.slice(s, s + FUNC_SOCD_BATCH);
      let r: Uint8Array;
      try {
        r = await this.link.xfer(funcSocdPkt(this.profile, chunk));
      } catch {
        return undefined;
      }
      const v = parseFuncSocd(r, chunk.length);
      // a reply that doesn't echo our keys isn't one we understand
      if (v.some((x, j) => x.key !== chunk[j])) return undefined;
      out.push(...v.map((x) => x.func));
    }
    return out;
  }

  /**
   * Functions of these layout positions, the way the vendor reads them (GetAllMaKeyInformation):
   * cmd 0 one key at a time (ids >= 7 count as normal), then cmd 17 overrides when the board has it.
   * `full` = initial read (always does both); read-backs use cmd 17 alone once it worked.
   */
  private async readFuncs(pos: number[], full: boolean): Promise<number[]> {
    const ids = pos.map((i) => this.caps[i].index);
    let funcs: number[] | undefined;
    if (full || !this.funcSocd) {
      funcs = [];
      for (const id of ids) funcs.push(normFunc(parseKeyFuncs(await this.link.xfer(keyFuncPkt([id])), 1)[0]));
    }
    if (full || this.funcSocd) {
      const fs = await this.readFuncSocd(ids);
      if (full) this.funcSocd = !!fs;
      if (fs) funcs = fs;
    }
    if (!funcs) throw new Error('no key functions');
    return funcs;
  }

  /** Function + values of these layout positions (same order). */
  private async readTrigs(u: Units, pos: number[], full: boolean): Promise<KeyTrig[]> {
    const funcs = await this.readFuncs(pos, full);
    const out: KeyTrig[] = funcs.map((f) => ({ func: f, travel: 0, press: 0, release: 0 }));
    const idOf = (j: number) => this.caps[pos[j]].index;
    const single = pos.map((_, j) => j).filter((j) => funcs[j] === FN_SINGLE);
    for (let s = 0; s < single.length; s += 18) {
      const chunk = single.slice(s, s + 18);
      const v = parseSingle(await this.link.xfer(getSinglePkt(u, chunk.map(idOf))), u, chunk.length);
      chunk.forEach((j, k) => (out[j].travel = v[k]));
    }
    const rapid = pos.map((_, j) => j).filter((j) => funcs[j] === FN_RAPID);
    for (let s = 0; s < rapid.length; s += rtBatch(u)) {
      const chunk = rapid.slice(s, s + rtBatch(u));
      const v = parseRt(await this.link.xfer(getRtPkt(u, chunk.map(idOf))), u, chunk.length);
      chunk.forEach((j, k) => Object.assign(out[j], v[k]));
    }
    return out;
  }

  /** Every layout key's function + values, parallel to the layout. */
  private readKeyTrigs(u: Units): Promise<KeyTrig[]> {
    return this.readTrigs(u, this.caps.map((_, i) => i), true);
  }

  /** firmware 0.3.0+ can take keys out of SOCD without touching their triggers */
  private socdRemovable() {
    return fwNumber(this.fwRaw) >= SOCD_REMOVE_FW;
  }

  /** SOCD group of every layout key (the vendor asks one key at a time). */
  private async readSocd(): Promise<number[]> {
    const out: number[] = [];
    for (const c of this.caps) out.push(parseSocd(await this.link.xfer(getSocdPkt(c.index))));
    return out;
  }

  private socdValue(groups: number[], keys: KeyTrig[]): Socd {
    return {
      kind: 'socd',
      mode: 'groups',
      keys: this.caps,
      max: SOCD_GROUPS,
      modes: [['Last input', 0]],
      unavailable: keys.map((k, i) => (FN_OTHER_SPECIAL.has(k.func) ? i : -1)).filter((i) => i >= 0),
      removable: this.socdRemovable(),
      entries: Array.from({ length: SOCD_GROUPS }, (_, g) => ({ keys: groups.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0), mode: 0 })),
    };
  }

  private async writeSocd(v: Socd): Promise<void> {
    const cur = this.socd;
    const keys = this.keyTrigs;
    if (!cur || !keys) throw new Error('press Re-read first');
    const want = planSocd(v, this.caps);
    const sets: number[] = [];
    const removes: number[] = [];
    want.forEach((g, i) => {
      if (g === cur[i]) return;
      if (g < 0) removes.push(i);
      else if (FN_OTHER_SPECIAL.has(keys[i].func)) throw new Error(`${this.caps[i].label} has another special function (MT/TGL/DKS) - change it in the DAREU app`);
      else sets.push(i);
    });
    if (removes.length && !this.socdRemovable()) {
      throw new Error(`firmware ${this.fw} can't take keys out of SOCD without resetting their triggers - use the DAREU app`);
    }
    if (!sets.length && !removes.length) return;
    for (const i of sets) await this.link.xfer(setSocdPkt(this.caps[i].index, want[i]));
    for (let s = 0; s < removes.length; s += SOCD_REMOVE_BATCH) {
      await this.link.xfer(removeSocdPkt(removes.slice(s, s + SOCD_REMOVE_BATCH).map((i) => this.caps[i].index)));
    }
    const next = cur.slice();
    const bad: string[] = [];
    for (const i of [...sets, ...removes]) {
      const id = this.caps[i].index;
      try {
        next[i] = parseSocd(await this.link.xfer(getSocdPkt(id)));
        if (next[i] !== want[i]) bad.push(this.caps[i].label);
        // older firmware: SOCD replaces the key's trigger function
        if (!this.socdRemovable()) {
          const func = parseKeyFuncs(await this.link.xfer(keyFuncPkt([id])), 1)[0];
          if (func !== keys[i].func) keys[i] = { func, travel: 0, press: 0, release: 0 };
        }
      } catch {
        bad.push(this.caps[i].label);
      }
    }
    this.socd = next;
    if (bad.length) throw new Error(`keyboard didn't take the SOCD change for: ${bad.join(', ')}`);
  }

  private perKeyValue(keys: KeyTrig[], global: number): Value {
    const r = this.ranges!;
    const sh = keys.map((k) => shown(k, global, this.sensDefault));
    const sens = sh.map((s) => s[2]);
    return {
      kind: 'perKeyTrigger',
      keys: this.caps,
      travel: sh.map((s) => s[0]),
      rapid: sh.map((s) => s[1]),
      sens,
      min: r.travelMin,
      max: r.travelMax,
      step: r.step,
      sensMin: r.sensMin,
      sensMax: Math.max(r.sensMax, ...sens),
    };
  }

  private async readInner(): Promise<Setting[]> {
    const out: Setting[] = [];
    try {
      await this.identify();
    } catch (e) {
      throw new Error(`Keyboard isn't answering (${e instanceof Error ? e.message : String(e)}).`);
    }
    out.push(text('model', 'Model', 'Info', `${this.product.name} (${this.product.model})`));
    out.push(text('fw', 'Firmware', 'Info', this.fw!));
    try {
      this.profile = await this.readProfile();
      out.push(text('profile', 'Active profile', 'Info', String(this.profile)));
    } catch {
      this.profile = 0;
    }

    // --- performance
    this.poll = undefined;
    try {
      const p = await this.readPoll();
      this.poll = p;
      const map = this.product.poll ?? POLLING_MAP[p.usbType] ?? [];
      const options: [string, number][] = map.map(([id, hz]) => [`${hz} Hz`, id]);
      if (!options.some(([, id]) => id === p.rate)) options.push([`Current (id ${p.rate})`, p.rate]);
      out.push({ key: 'polling', label: 'Polling rate', group: 'Performance', value: { kind: 'choice', options, current: p.rate } });
    } catch {
      // board without a readable polling rate
    }

    // --- switches (magnetic boards)
    this.global = undefined;
    this.keyTrigs = undefined;
    this.socd = undefined;
    const u = this.units;
    if (this.product.fw === 6 && !u) {
      out.push(text('unsupported', 'Note', 'Info', "This board's switch ranges aren't known - magnetic settings are hidden"));
    }
    if (u && this.ranges) {
      const r = this.ranges;
      const global = parseGlobalTravel(await this.link.xfer(globalTravelPkt(u)), u);
      const keys = await this.readKeyTrigs(u);
      this.global = global;
      this.keyTrigs = keys;
      const firstRt = keys.find((k) => k.func === FN_RAPID);
      if (firstRt) this.sensDefault = firstRt.press;
      const editable = keys.filter((k, i) => isEditable(k.func) && !this.fixed.has(i));
      const allRt = editable.length > 0 && editable.every((k) => k.func === FN_RAPID);
      const travels = editable.map((k) => shown(k, global, this.sensDefault)[0]);
      const act = travels.length > 0 && travels.every((t) => Math.abs(t - travels[0]) < 1e-6) ? travels[0] : global;
      out.push({
        key: 'actuation',
        label: 'Actuation point (all keys)',
        group: 'Switches',
        value: { kind: 'float', min: r.travelMin, max: r.travelMax, step: r.step, current: act, unit: ' mm' },
      });
      out.push({ key: 'rapid_trigger', label: 'Rapid Trigger (all keys)', group: 'Switches', value: { kind: 'toggle', on: allRt } });
      out.push({
        key: 'rt_sens',
        label: 'Rapid Trigger sensitivity',
        group: 'Switches',
        value: { kind: 'float', min: r.sensMin, max: Math.max(r.sensMax, this.sensDefault), step: r.step, current: this.sensDefault, unit: ' mm' },
      });
      out.push({ key: 'per_key_trigger', label: 'Per-key actuation', group: 'Per-key', value: this.perKeyValue(keys, global) });

      // --- RT self-adaptive (products whose JSON says RtSelfAdaptive; the vendor hides it when GET fails)
      this.rtAdaptive = undefined;
      if (RT_ADAPTIVE_PIDS.has(this.product.pid)) {
        try {
          this.rtAdaptive = parseRtAdaptive(await this.link.xfer(getRtAdaptivePkt()));
          out.push({
            key: 'rt_adaptive',
            label: 'RT self-adaptive',
            group: 'Switches',
            value: { kind: 'toggle', on: this.rtAdaptive },
            hint: 'Rapid Trigger keys adapt their actuation and release points to how you press them.',
          });
        } catch {
          // older firmware: no switch
        }
      }

      // --- SOCD (only boards whose product JSON says SupportSOCD)
      this.socd = undefined;
      if (SOCD_PIDS.has(this.product.pid)) {
        try {
          const groups = await this.readSocd();
          this.socd = groups;
          out.push({
            key: 'socd',
            label: 'SOCD (Snap Tap)',
            group: 'Switches',
            value: this.socdValue(groups, keys),
            hint: this.socdRemovable()
              ? 'Keys in the same group: only the last one pressed counts - great for strafing (A/D).'
              : "Keys in the same group: only the last one pressed counts. On this firmware SOCD replaces the key's trigger, and keys can only be taken out again in the DAREU app.",
          });
        } catch {
          // no answer: leave SOCD out
        }
      }
    }

    // --- lighting
    this.light = undefined;
    try {
      const regions = await this.readRegions();
      const region = regions[0] ?? 0;
      let effects: number[] = [];
      try {
        effects = parseEffectList(await this.link.xfer(attributePkt(region)));
      } catch {
        effects = [];
      }
      const l = await this.readEffect(region);
      const bri = await this.readBrightness(region);
      this.light = l;
      if (l.effect !== 0) this.lastEffect = l.effect;
      if (l.colors.length) this.lastColor = l.colors[0];
      let list = effects.filter((e) => e !== 0);
      if (!list.length) list = (this.product.colorFx ?? DEFAULT_EFFECTS).filter(isEffect).filter((e) => e !== 0);
      if (!list.includes(this.lastEffect)) list.push(this.lastEffect);
      const options: [string, number][] = list.map((e) => [effectName(e), e]);
      out.push({ key: 'light_power', label: 'Lights on', group: 'Lighting', value: { kind: 'toggle', on: l.effect !== 0 } });
      out.push({ key: 'light_mode', label: 'Effect', group: 'Lighting', value: { kind: 'choice', options, current: this.lastEffect } });
      out.push({
        key: 'light_bri',
        label: 'Brightness',
        group: 'Lighting',
        value: { kind: 'number', min: 0, max: BRI_STEPS, current: Math.round((bri * BRI_STEPS) / 255), unit: '' },
      });
      out.push({ key: 'light_speed', label: 'Speed', group: 'Lighting', value: { kind: 'number', min: 1, max: 3, current: l.speed === 0 ? 2 : clamp(l.speed, 1, 3), unit: '' } });
      out.push({ key: 'light_color', label: 'Colour', group: 'Lighting', value: { kind: 'color', rgb: this.lastColor } });
      out.push({ key: 'light_rainbow', label: 'Rainbow colours', group: 'Lighting', value: { kind: 'toggle', on: l.colors.length === 0 } });
    } catch {
      // no lighting (or it didn't answer): leave the tab out
    }
    return out;
  }

  // --- writes

  private async writeLight(l: Light): Promise<void> {
    await this.link.xfer(setEffectPkt(this.profile, l));
    const got = await this.readEffect(l.region);
    this.light = got;
    if (got.effect !== 0) this.lastEffect = got.effect;
    if (got.colors.length) this.lastColor = got.colors[0];
    const same =
      got.effect === l.effect && got.flag === l.flag && got.speed === l.speed &&
      got.colors.length === l.colors.length && got.colors.every((c, i) => c === l.colors[i]);
    if (!same) throw new Error(`keyboard didn't take the lighting change (reads back effect ${got.effect}, speed ${got.speed})`);
  }

  /** Write `changes` (layout position, new trigger), then read those keys back. */
  private async writeKeyTrigs(changes: [number, KeyTrig][]): Promise<void> {
    const u = this.units!;
    if (!this.keyTrigs) throw new Error('press Re-read first');
    if (changes.length === 0) return;
    for (const f of planPackets(changes, this.caps, u)) await this.link.xfer(f);
    const cache = this.keyTrigs.slice();
    const want = new Map(changes);
    // read back; keys that don't match yet get a few more tries after a pause (the vendor never
    // reads back right away, so a firmware that applies the change a little later must not fail)
    let pending = changes.map(([i]) => i);
    let failure = new Map<number, string>();
    for (let attempt = 0; ; attempt++) {
      failure = new Map();
      let back: KeyTrig[] | undefined;
      let err = '';
      try {
        back = await this.readTrigs(u, pending, false);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      pending.forEach((i, j) => {
        const got = back?.[j];
        if (got) cache[i] = got;
        if (!got) failure.set(i, `no answer (${err})`);
        else if (!sameTrig(got, want.get(i)!, u)) failure.set(i, describeTrig(got, u));
      });
      pending = [...failure.keys()];
      if (!pending.length || attempt >= dareuTiming.verifyRetries) break;
      await sleep(dareuTiming.verifySettle);
    }
    this.keyTrigs = cache;
    const rt = cache.find((k) => k.func === FN_RAPID);
    if (rt) this.sensDefault = rt.press;
    if (failure.size) {
      const [first, gotText] = [...failure][0];
      let adaptive = '';
      if (this.rtAdaptive !== undefined) adaptive = `; RT self-adaptive ${this.rtAdaptive ? 'on' : 'off'}`;
      const labels = [...failure.keys()].map((i) => this.caps[i].label);
      throw new Error(
        `keyboard didn't take the trigger change for: ${labels.join(', ')} ` +
          `(${this.caps[first].label} #${this.caps[first].index}: sent ${describeTrig(want.get(first)!, u)}, ` +
          `reads back ${gotText}; TravelVersion ${u.tv}, fw ${this.fw ?? '?'}, functions via cmd ${this.funcSocd ? 17 : 0}${adaptive})`,
      );
    }
  }

  /** Apply `fn` to every editable key and write the keys that change. */
  private async writeAll(fn: (k: KeyTrig, i: number) => KeyTrig | undefined): Promise<void> {
    const keys = this.keyTrigs;
    if (!keys) throw new Error('press Re-read first');
    const u = this.units!;
    const changes: [number, KeyTrig][] = [];
    keys.forEach((k, i) => {
      if (!isEditable(k.func) || this.fixed.has(i)) return;
      const n = fn(k, i);
      if (n && !sameTrig(n, k, u)) changes.push([i, n]);
    });
    await this.writeKeyTrigs(changes);
  }

  private async writeInner(s: Setting): Promise<void> {
    const v = s.value;
    const light = () => {
      if (!this.light) throw new Error('press Re-read first');
      return this.light;
    };
    const mag = () => {
      if (!this.units || !this.ranges || this.global === undefined || !this.keyTrigs) throw new Error('press Re-read first');
      return { u: this.units, r: this.ranges, global: this.global };
    };
    switch (`${s.key}:${v.kind}`) {
      case 'polling:choice': {
        const rate = (v as Extract<Value, { kind: 'choice' }>).current;
        const p = this.poll;
        if (!p) throw new Error('press Re-read first');
        const map = this.product.poll ?? POLLING_MAP[p.usbType] ?? [];
        if (!map.some(([id]) => id === rate)) throw new Error('unsupported polling rate');
        await this.link.send(setPollPkt(this.profile, p.usbType, rate));
        await sleep(dareuTiming.pollSettle);
        let got: { usbType: number; rate: number } | undefined;
        try {
          got = await this.readPoll();
        } catch {
          got = undefined; // the board may re-attach after a rate change
        }
        if (got) {
          this.poll = got;
          if (got.rate !== rate) throw new Error(`polling rate reads back as id ${got.rate}`);
        }
        return;
      }
      case 'actuation:float': {
        const { r } = mag();
        const t = clamp((v as Extract<Value, { kind: 'float' }>).current, r.travelMin, r.travelMax);
        // every key gets its own trigger (single trigger, or RT start point for RT keys)
        return this.writeAll((k) =>
          k.func === FN_RAPID
            ? { ...k, travel: clamp(t, Math.max(r.rtMin, r.travelMin), Math.min(r.rtMax, r.travelMax)) }
            : { func: FN_SINGLE, travel: t, press: 0, release: 0 },
        );
      }
      case 'rapid_trigger:toggle': {
        const { r, global } = mag();
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        const sens = clamp(this.sensDefault, r.sensMin, r.sensMax);
        return this.writeAll((k) => {
          const [t] = shown(k, global, sens);
          if (on) {
            if (k.func === FN_RAPID) return undefined;
            return { func: FN_RAPID, travel: clamp(t, Math.max(r.rtMin, r.travelMin), Math.min(r.rtMax, r.travelMax)), press: sens, release: sens };
          }
          return k.func === FN_RAPID ? { func: FN_SINGLE, travel: clamp(t, r.travelMin, r.travelMax), press: 0, release: 0 } : undefined;
        });
      }
      case 'rt_sens:float': {
        const { r } = mag();
        const sens = clamp((v as Extract<Value, { kind: 'float' }>).current, r.sensMin, r.sensMax);
        this.sensDefault = sens;
        return this.writeAll((k) => (k.func === FN_RAPID ? { ...k, press: sens, release: sens } : undefined));
      }
      case 'per_key_trigger:perKeyTrigger': {
        const { u, r, global } = mag();
        const p = v as Extract<Value, { kind: 'perKeyTrigger' }>;
        const changes = planKeyTrigs(
          this.keyTrigs!,
          this.caps.map((c) => c.label),
          global,
          this.sensDefault,
          u,
          r,
          p.travel,
          p.rapid,
          p.sens,
          this.fixed,
        );
        return this.writeKeyTrigs(changes);
      }
      case 'socd:socd':
        return this.writeSocd(v as Socd);
      case 'rt_adaptive:toggle': {
        if (this.rtAdaptive === undefined) throw new Error('press Re-read first');
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        await this.link.xfer(setRtAdaptivePkt(on));
        const got = parseRtAdaptive(await this.link.xfer(getRtAdaptivePkt()));
        this.rtAdaptive = got;
        if (got !== on) throw new Error(`keyboard didn't take the RT self-adaptive change (reads back ${got ? 'on' : 'off'})`);
        return;
      }
      case 'light_power:toggle': {
        const l = light();
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        if (on === (l.effect !== 0)) return;
        return this.writeLight({ ...l, effect: on ? this.lastEffect : 0 });
      }
      case 'light_mode:choice': {
        const e = (v as Extract<Value, { kind: 'choice' }>).current;
        if (!isEffect(e)) throw new Error('unknown effect');
        return this.writeLight({ ...light(), effect: e });
      }
      case 'light_speed:number': {
        const n = clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 1, 3);
        return this.writeLight({ ...light(), speed: n });
      }
      case 'light_color:color': {
        const l = light();
        const c = (v as Extract<Value, { kind: 'color' }>).rgb & 0xffffff;
        return this.writeLight({ ...l, colors: [c, ...l.colors.slice(1)] });
      }
      case 'light_rainbow:toggle': {
        const l = light();
        const on = (v as Extract<Value, { kind: 'toggle' }>).on;
        return this.writeLight({ ...l, colors: on ? [] : [this.lastColor] });
      }
      case 'light_bri:number': {
        const l = light();
        const want = Math.round((clamp(Math.round((v as Extract<Value, { kind: 'number' }>).current), 0, BRI_STEPS) * 255) / BRI_STEPS);
        await this.link.xfer(setBrightnessPkt(this.profile, l.region, want));
        const got = await this.readBrightness(l.region);
        if (got !== want) throw new Error(`brightness reads back as ${got}`);
        return;
      }
      default:
        throw new Error(`${s.key} can't be changed`);
    }
  }
}

/** The command collection: UP 0x0C usage 1 with the product's feature report id. */
function hasCommandCollection(d: HIDDevice, p: DareuProduct): boolean {
  const id = reportIdFor(p);
  return (d.collections ?? []).some(
    (c) => c.usagePage === CMD_UP && c.usage === CMD_USAGE && (c.featureReports ?? []).some((r) => r.reportId === id),
  );
}

export const dareuFactory: DriverFactory = {
  name: 'DAREU',
  filters: [{ vendorId: VID, usagePage: CMD_UP, usage: CMD_USAGE }],
  match(d: HIDDevice): boolean {
    if (d.vendorId !== VID) return false;
    const p = productFor(d.productId);
    return !!p && hasCommandCollection(d, p);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!dareuFactory.match(device)) return null;
    const product = productFor(device.productId)!;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const link = new Link(device, reportIdFor(product));
    const drv = new Dareu(link, product);
    try {
      await link.lock(() => drv.identify());
    } catch {
      if (openedHere) await device.close().catch(() => undefined);
      return null;
    }
    return drv;
  },
};
