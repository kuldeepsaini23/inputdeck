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
// assignment / macros / SOCD / DKS / MT / TGL writes, and anything undocumented.

import { DAREU_LAYOUTS, DAREU_PRODUCTS, type DareuProduct } from './dareu-products';
import type { Driver, DriverFactory, KeyCap, Setting, Value } from './types';
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
export const MAG = { KEY_FUNCTION: 0, SINGLE_TRIGGER: 2, RAPID_TRIGGER: 3, GLOBAL_TRAVEL: 7 } as const;

/** Per-key function ids (class 13 cmd 0). 3..6 = MT / TGL / DKS / SOCD (edited in the official app only). */
export const FN_NORMAL = 0;
export const FN_SINGLE = 1;
export const FN_RAPID = 2;

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
      if (prof !== 0) return false;
      if (get && cmd === MAG.GLOBAL_TRAVEL) return (size === 1 || size === 2) && zeroFrom(0);
      if (get && cmd === MAG.KEY_FUNCTION) return keyList({ 2: 28 }, 'zero');
      if (cmd === MAG.SINGLE_TRIGGER) return keyList({ 2: 18, 3: 18 }, get ? 'zero' : 'set');
      if (cmd === MAG.RAPID_TRIGGER) return keyList({ 4: 14, 7: 8 }, get ? 'zero' : 'set');
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
    this.fw = fwVersion(await this.link.xfer(fwVerPkt()));
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

  /** Every layout key's function + values, parallel to the layout. */
  private async readKeyTrigs(u: Units): Promise<KeyTrig[]> {
    const ids = this.caps.map((c) => c.index);
    // the vendor asks one key at a time
    const funcs: number[] = [];
    for (const id of ids) funcs.push(parseKeyFuncs(await this.link.xfer(keyFuncPkt([id])), 1)[0]);
    const out: KeyTrig[] = funcs.map((f) => ({ func: f, travel: 0, press: 0, release: 0 }));
    const single = ids.map((_, i) => i).filter((i) => funcs[i] === FN_SINGLE);
    for (let s = 0; s < single.length; s += 18) {
      const chunk = single.slice(s, s + 18);
      const v = parseSingle(await this.link.xfer(getSinglePkt(u, chunk.map((i) => ids[i]))), u, chunk.length);
      chunk.forEach((i, j) => (out[i].travel = v[j]));
    }
    const rapid = ids.map((_, i) => i).filter((i) => funcs[i] === FN_RAPID);
    for (let s = 0; s < rapid.length; s += rtBatch(u)) {
      const chunk = rapid.slice(s, s + rtBatch(u));
      const v = parseRt(await this.link.xfer(getRtPkt(u, chunk.map((i) => ids[i]))), u, chunk.length);
      chunk.forEach((i, j) => Object.assign(out[i], v[j]));
    }
    return out;
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
      const editable = keys.filter((k) => isEditable(k.func));
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
    const bad: string[] = [];
    for (const [i, want] of changes) {
      const id = this.caps[i].index;
      const label = this.caps[i].label;
      try {
        const func = parseKeyFuncs(await this.link.xfer(keyFuncPkt([id])), 1)[0];
        let got: KeyTrig = { func, travel: 0, press: 0, release: 0 };
        if (func === FN_SINGLE) got.travel = parseSingle(await this.link.xfer(getSinglePkt(u, [id])), u, 1)[0];
        if (func === FN_RAPID) got = { func, ...parseRt(await this.link.xfer(getRtPkt(u, [id])), u, 1)[0] };
        cache[i] = got;
        if (!sameTrig(got, want, u)) bad.push(label);
      } catch {
        bad.push(label);
      }
    }
    this.keyTrigs = cache;
    const rt = cache.find((k) => k.func === FN_RAPID);
    if (rt) this.sensDefault = rt.press;
    if (bad.length) throw new Error(`keyboard didn't take the trigger change for: ${bad.join(', ')}`);
  }

  /** Apply `fn` to every editable key and write the keys that change. */
  private async writeAll(fn: (k: KeyTrig, i: number) => KeyTrig | undefined): Promise<void> {
    const keys = this.keyTrigs;
    if (!keys) throw new Error('press Re-read first');
    const u = this.units!;
    const changes: [number, KeyTrig][] = [];
    keys.forEach((k, i) => {
      if (!isEditable(k.func)) return;
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
        );
        return this.writeKeyTrigs(changes);
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
