// Wooting analog keyboards on the "ARM" (v3) firmware: 60HE v2 first, also 60HE (ARM), 60HE+, 80HE,
// 80HE+, Two HE (ARM) and UwU. Our own code; nobody has run it on real hardware yet, so it is
// verified = false (view-only until "Allow changes").
//
// Sources (read, not copied):
// - WootingKb/wooting-rgb-sdk (MPL-2.0), src/wooting-usb.c: PIDs (60HE V2 = 0x1340, every PID also
//   enumerates as pid|1 / pid|2 for the gamepad modes), config interface = usage page 0x1337 or
//   0xFF55 ("v3", multi-report), feature command [id 1, D1 DA, cmd, p3, p2, p1, p0].
// - eng1n88r/wooting (MIT, reverse-engineered from Wootility WebHID captures of a 60HE+, fw 2.14):
//   docs/protocol.md, docs/captures/README.md, crates/wooting-proto/proto/wooting.proto. Command
//   ids, response layout, output report framing [D1 DA type flags lenLo lenHi protobuf], flags
//   0 = active profile in RAM / (slot << 1) | 1 = that profile slot in flash, distances
//   0x4000 | round(mm / 4 * 16383), KeyboardProfile / PerKey (0x15) / RtKeys (0x1D) payloads.
// - clemenscodes/wootswitch docs/hid-protocol.md: profile switch WootDevInit, ActivateProfile,
//   100 ms, ReloadProfile, wait until GetCurrentKeyboardProfileIndex reports the slot.
// - wootility.io's own bundle, analysed statically as text: device table (pid 0x1340 "60HE v2",
//   chip ARM, matrix rows 1..5 x 14 cols; 0x1410 "80HE+"), WebHID filters {0x31E3, usagePage
//   0xFF55}, response header [D1 DA cmd status lenLo lenHi], status 0x88 = ok, report sizes
//   1:32 2:62 3:254 4:510 5:1022 6:2046, proto names (KeyboardProfile.KBase: 1 ActuationPoint,
//   2 isDigitalOn, 3 enableRapidTrigger, 4 rapidTriggerSensitivity, 5 tachyonModeEnabled,
//   6 tickRate, 7 rapidTriggerStrictActuationRange, 8 rapidTriggerSecondarySensitivity,
//   9 tachyonMode; RapidTriggerProfile groups {1 keys, 2 config {1 primary, 2 secondary,
//   3 continuousMode}, 3 enabled}; KeyMMPropertyProfile oneof 1 full / 2 partial / 3 fullEncoded /
//   4 partialEncoded {1 entries = (value << 16) | row << 5 | col}, partial below 50 keys), value
//   formats (14-bit 0x4000|v from firmware 2.13.0 on ARM boards, 8-bit percent before), ranges for
//   Hall-effect switches (actuation 0.1..4.0 mm, Rapid Trigger 0.15..2.35 mm), DeviceConfig bytes
//   (byte 0 bit 4 = 6KRO, bit 3 = USB full speed, byte 5 = layout, byte 6 gamepad mode / rate).
//
// Writes: KeyboardProfile (actuation, Rapid Trigger, Tachyon), per-key actuation (0x15) and per-key
// Rapid Trigger (0x1D) to the active profile (RAM, then its flash slot), RGB brightness (0x16 to RAM
// + SaveRgbProfile(active slot)), profile switching. Each write is read back. Only firmware 2.13+
// is written to (the 14-bit value format); older firmware is shown read-only.
//
// NEVER sent (allowed() refuses them): ResetToBootloader (2), SoftReset (25), ResetSettings (43),
// SetRawScanning (44), Delete/CreateProfile (63/64), any save other than SaveRgbProfile (8), KeysOff,
// DeviceConfig (0x07, restarts the board / changes its USB id), key mappings, gamepad, global
// settings, advanced keys, profile metadata, profile blobs, direct lighting, calibration.
import type { Driver, DriverFactory, KeyCap, Setting, Value } from './types';
import { sleep } from './types';

export const VID = 0x31e3;
/** configuration interface of the ARM ("v3") firmware */
export const USAGE_PAGE = 0xff55;
export const MAGIC0 = 0xd1;
export const MAGIC1 = 0xda;
export const FEATURE_ID = 1;
export const STATUS_OK = 0x88;
/** output / input report id -> bytes after the id (Wootility ej(), 60HE+ descriptor) */
export const REPORT_SIZES: [id: number, size: number][] = [
  [1, 32],
  [2, 62],
  [3, 254],
  [4, 510],
  [5, 1022],
  [6, 2046],
];
const SIZE_OF = new Map(REPORT_SIZES);
/** onboard profile slots (Wootility Ob = 4) */
export const SLOTS = 4;

export interface Model {
  pid: number;
  name: string;
  /** board picture + per-key data (only the 60% boards so far) */
  sixty?: boolean;
}
export const MODELS: Model[] = [
  { pid: 0x1230, name: 'Two HE (ARM)' },
  { pid: 0x1310, name: '60HE (ARM)', sixty: true },
  { pid: 0x1320, name: '60HE+', sixty: true },
  { pid: 0x1340, name: '60HE v2', sixty: true },
  { pid: 0x1400, name: '80HE' },
  { pid: 0x1410, name: '80HE+' },
  { pid: 0x1500, name: 'UwU' },
  { pid: 0x1510, name: 'UwU RGB' },
];
/** pid, pid|1, pid|2 are the same model (gamepad modes, RGB SDK V2_ALT_PID_0..2) */
export function modelOf(pid: number): Model | undefined {
  const alt = pid & 0xf;
  if (alt > 2) return undefined;
  return MODELS.find((m) => m.pid === pid - alt);
}

export const CMD = {
  getVersion: 1,
  saveRgbProfile: 8,
  getProfileIndex: 11,
  getDeviceConfig: 19,
  activateProfile: 23,
  wootDevInit: 33,
  reloadProfile: 38,
  getKeyboardProfile: 39,
  getActuationProfile: 49,
  getRgbProfileCore: 50,
  getGlobalSettings: 51,
  getRapidTriggerProfile: 54,
  getProfileMetadata: 55,
  getRtKeys: 61,
  getProfileCount: 62,
} as const;
/** commands taking a profile slot in data[3] (the rest send all-zero parameters) */
const SLOT_CMDS = new Set<number>([
  CMD.saveRgbProfile,
  CMD.activateProfile,
  CMD.reloadProfile,
  CMD.getKeyboardProfile,
  CMD.getActuationProfile,
  CMD.getRgbProfileCore,
  CMD.getRapidTriggerProfile,
  CMD.getProfileMetadata,
  CMD.getRtKeys,
]);
const ZERO_CMDS = new Set<number>([CMD.getVersion, CMD.getProfileIndex, CMD.getDeviceConfig, CMD.wootDevInit, CMD.getGlobalSettings, CMD.getProfileCount]);

export const REPORT = { keyboardProfile: 0x11, perKey: 0x15, rgbCore: 0x16, rtKeys: 0x1d } as const;
export const flagsFor = (slot: number) => ((slot << 1) | 1) & 0xff;

// ---------------------------------------------------------------- values

/** Hall-effect key travel (Wootility pT: 7/255*4 .. 4.0 mm) */
export const ACT_MIN = 0.1;
export const ACT_MAX = 4.0;
/** Wootility Pu() for Hall-effect switches */
export const SENS_MIN = 0.15;
export const SENS_MAX = 2.35;
export const STEP = 0.05;

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** mm -> 14-bit protocol value (Wootility Lg(.., Percent_14bit)) */
export const mmToCode = (mm: number) => 0x4000 | clamp(Math.round((mm / 4) * 0x3fff), 0, 0x3fff);
/** protocol value -> mm; accepts the 14-bit form and the older 8-bit percent form (Wootility Ji()) */
export function codeToMm(v: number): number | undefined {
  if (!Number.isInteger(v) || v < 0) return undefined;
  if (v <= 0x7f) return round2((v / 0x7f) * 4);
  if (v >>> 14 === 1) return round2(((v & 0x3fff) / 0x3fff) * 4);
  return undefined;
}
const is14 = (v: number) => v >>> 14 === 1;
const inRange = (v: number, lo: number, hi: number) => {
  const mm = codeToMm(v);
  return is14(v) && mm !== undefined && mm >= lo - 1e-9 && mm <= hi + 1e-9;
};

/** matrix id of row/col (Wootility l2()) */
export const mid = (row: number, col: number) => ((row & 7) << 5) | (col & 0x1f);
const validMid = (m: number) => m >= 0 && m <= 0xff && m >> 5 <= 5 && (m & 0x1f) <= 20;

// ---------------------------------------------------------------- protobuf (just enough)

/** internal decoding problems (not shown as translated UI text) */
const protoError = (m: string) => new Error(m);

export interface PbField {
  no: number;
  /** wire type: 0 varint, 1 fixed64, 2 bytes, 5 fixed32 */
  wt: number;
  v: number;
  b?: Uint8Array;
}

function readVarint(b: Uint8Array, p: { i: number }): number {
  let r = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (p.i >= b.length) throw protoError('truncated varint');
    const x = b[p.i++];
    r += (x & 0x7f) * mul;
    if (!(x & 0x80)) return r;
    mul *= 128;
  }
  throw protoError('bad varint');
}

export function pbDecode(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  const p = { i: 0 };
  while (p.i < b.length) {
    const tag = readVarint(b, p);
    const no = Math.floor(tag / 8);
    const wt = tag % 8;
    if (no < 1) throw protoError('bad field number');
    if (wt === 0) out.push({ no, wt, v: readVarint(b, p) });
    else if (wt === 2) {
      const n = readVarint(b, p);
      if (p.i + n > b.length) throw protoError('truncated field');
      out.push({ no, wt, v: n, b: b.slice(p.i, p.i + n) });
      p.i += n;
    } else if (wt === 1 || wt === 5) {
      const n = wt === 1 ? 8 : 4;
      if (p.i + n > b.length) throw protoError('truncated field');
      out.push({ no, wt, v: 0, b: b.slice(p.i, p.i + n) });
      p.i += n;
    } else throw new Error(`wire type ${wt}`);
  }
  return out;
}

function varint(v: number): number[] {
  const out: number[] = [];
  let x = v;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x) byte |= 0x80;
    out.push(byte);
  } while (x);
  return out;
}

export function pbEncode(fs: PbField[]): Uint8Array {
  const out: number[] = [];
  for (const f of fs) {
    out.push(...varint(f.no * 8 + f.wt));
    if (f.wt === 0) out.push(...varint(f.v));
    else if (f.wt === 2) out.push(...varint(f.b!.length), ...f.b!);
    else out.push(...f.b!);
  }
  return Uint8Array.from(out);
}

const vf = (no: number, v: number): PbField => ({ no, wt: 0, v });
const mf = (no: number, b: Uint8Array): PbField => ({ no, wt: 2, v: b.length, b });
const getV = (fs: PbField[], no: number) => fs.find((f) => f.no === no && f.wt === 0)?.v;
/** repeated uint32, packed or not */
function repeated(fs: PbField[], no: number): number[] {
  const out: number[] = [];
  for (const f of fs) {
    if (f.no !== no) continue;
    if (f.wt === 0) out.push(f.v);
    else if (f.wt === 2) {
      const p = { i: 0 };
      while (p.i < f.b!.length) out.push(readVarint(f.b!, p));
    }
  }
  return out;
}
/** set a varint field in place (or insert it in field-number order); undefined removes it */
export function setField(fs: PbField[], no: number, v: number | undefined): PbField[] {
  const out = fs.filter((f) => !(f.no === no && v === undefined));
  if (v === undefined) return out;
  const i = out.findIndex((f) => f.no === no);
  if (i >= 0) {
    out[i] = vf(no, v);
    return out;
  }
  const at = out.findIndex((f) => f.no > no);
  if (at < 0) out.push(vf(no, v));
  else out.splice(at, 0, vf(no, v));
  return out;
}

// ---------------------------------------------------------------- payloads

/** KeyboardProfile { 1: KBase } -> KBase fields */
export function kbBase(top: Uint8Array): PbField[] {
  const fs = pbDecode(top);
  const base = fs.find((f) => f.no === 1 && f.wt === 2);
  if (!base) throw protoError('keyboard profile without settings');
  return pbDecode(base.b!);
}
/** replace KBase inside KeyboardProfile, keeping any other top-level field */
export function withBase(top: Uint8Array, base: PbField[]): Uint8Array {
  const fs = pbDecode(top).map((f) => (f.no === 1 && f.wt === 2 ? mf(1, pbEncode(base)) : f));
  return pbEncode(fs);
}

export interface Kb {
  act: number;
  rt: boolean;
  sens: number;
  tachyon: boolean;
  tmode: number;
  /** false = continuous Rapid Trigger (field 7 rapidTriggerStrictActuationRange) */
  strict: boolean;
  /** release sensitivity code when split sensitivity is on */
  release?: number;
}
export function parseKb(base: PbField[]): Kb {
  const sec = getV(base, 8);
  return {
    act: getV(base, 1) ?? 0,
    rt: !!getV(base, 3),
    sens: getV(base, 4) ?? 0,
    tachyon: !!getV(base, 5),
    tmode: getV(base, 9) ?? 0,
    strict: getV(base, 7) !== 0,
    release: sec ? sec : undefined,
  };
}

/** per-key actuation (KeyMMPropertyProfile): matrix id -> value code */
export function parsePerKey(b: Uint8Array): { map: Map<number, number>; form: string } {
  const map = new Map<number, number>();
  const fs = pbDecode(b);
  const kinds = new Set(fs.map((f) => f.no));
  if (kinds.has(4)) {
    for (const f of fs) if (f.no === 4 && f.wt === 2) for (const e of repeated(pbDecode(f.b!), 1)) map.set(e & 0xff, Math.floor(e / 65536) & 0xffff);
    return { map, form: 'partialEncoded' };
  }
  if (kinds.has(3)) {
    // fullEncoded: rows of values, row index = matrix row, 0 = no override
    let r = 0;
    for (const f of fs) {
      if (f.no !== 3 || f.wt !== 2) continue;
      for (const row of pbDecode(f.b!)) {
        if (row.no !== 1 || row.wt !== 2) continue;
        repeated(pbDecode(row.b!), 1).forEach((v, c) => v && map.set(mid(r, c), v));
        r++;
      }
    }
    return { map, form: 'fullEncoded' };
  }
  if (kinds.has(1) || kinds.has(2)) return { map, form: 'legacy' };
  return { map, form: fs.length ? 'unknown' : 'none' };
}
export function encodePerKey(map: Map<number, number>): Uint8Array {
  if (!map.size) return new Uint8Array(0);
  const entries = [...map].sort((a, b) => a[0] - b[0]).map(([m, v]) => vf(1, (v & 0xffff) * 65536 + m));
  return pbEncode([mf(4, pbEncode(entries))]);
}

export interface RtConfig {
  primary: number;
  secondary?: number;
  continuous?: boolean;
}
export interface RtGroup {
  keys: number[];
  enabled?: boolean;
  config?: RtConfig;
}
export function parseRt(b: Uint8Array): RtGroup[] {
  const out: RtGroup[] = [];
  for (const g of pbDecode(b)) {
    if (g.no !== 1 || g.wt !== 2) continue;
    const fs = pbDecode(g.b!);
    const grp: RtGroup = { keys: repeated(fs, 1) };
    const cfg = fs.find((f) => f.no === 2 && f.wt === 2);
    if (cfg) {
      const c = pbDecode(cfg.b!);
      const cont = getV(c, 3);
      grp.config = { primary: getV(c, 1) ?? 0, secondary: getV(c, 2) || undefined, continuous: cont === undefined ? undefined : !!cont };
    }
    const en = getV(fs, 3);
    if (en !== undefined) grp.enabled = !!en;
    out.push(grp);
  }
  return out;
}
export function encodeRt(groups: RtGroup[]): Uint8Array {
  const top: PbField[] = [];
  for (const g of groups) {
    const fs: PbField[] = g.keys.map((k) => vf(1, k));
    if (g.config) {
      const c: PbField[] = [vf(1, g.config.primary)];
      if (g.config.secondary) c.push(vf(2, g.config.secondary));
      if (g.config.continuous !== undefined) c.push(vf(3, g.config.continuous ? 1 : 0));
      fs.push(mf(2, pbEncode(c)));
    } else fs.push(vf(3, g.enabled ? 1 : 0));
    top.push(mf(1, pbEncode(fs)));
  }
  return pbEncode(top);
}
/** what Rapid Trigger does on one key: false (off) or its press sensitivity code */
export function rtOf(m: number, kb: Kb, groups: RtGroup[]): false | number {
  let s: false | number = kb.rt ? kb.sens : false;
  for (const g of groups) {
    if (!g.keys.includes(m)) continue;
    if (g.config) s = g.config.primary;
    else s = g.enabled ? kb.sens : false;
  }
  return s;
}

/** RgbProfileCore { 1: { 1 brightness, ... }, effects } */
export function coreBrightness(b: Uint8Array): number | undefined {
  const base = pbDecode(b).find((f) => f.no === 1 && f.wt === 2);
  return base ? getV(pbDecode(base.b!), 1) : undefined;
}
export function withBrightness(b: Uint8Array, bri: number): Uint8Array {
  return pbEncode(pbDecode(b).map((f) => (f.no === 1 && f.wt === 2 ? mf(1, pbEncode(setField(pbDecode(f.b!), 1, bri))) : f)));
}

// ---------------------------------------------------------------- allowlist

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');

/** Feature command data (after report id 1): D1 DA cmd slot 0 0 0. */
export function allowedCommand(d: ArrayLike<number>): boolean {
  if (d.length !== 7 || d[0] !== MAGIC0 || d[1] !== MAGIC1) return false;
  const cmd = d[2];
  if (d[4] !== 0 || d[5] !== 0 || d[6] !== 0) return false;
  if (SLOT_CMDS.has(cmd)) return d[3] < SLOTS;
  if (ZERO_CMDS.has(cmd)) return d[3] === 0;
  return false;
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
const isBool = (v: number | undefined) => v === undefined || v === 0 || v === 1;
const varintsOnly = (fs: PbField[]) => fs.every((f) => f.wt === 0);

function okKbPayload(p: Uint8Array): boolean {
  const top = safe(() => pbDecode(p));
  if (!top || top.length !== 1 || top[0].no !== 1 || top[0].wt !== 2) return false;
  const b = safe(() => pbDecode(top[0].b!));
  if (!b || !varintsOnly(b) || new Set(b.map((f) => f.no)).size !== b.length) return false;
  const v = (n: number) => getV(b, n);
  if (v(1) === undefined || !inRange(v(1)!, ACT_MIN, ACT_MAX)) return false;
  if (v(4) !== undefined && !inRange(v(4)!, ACT_MIN, ACT_MAX)) return false;
  if (v(8) !== undefined && v(8) !== 0 && !inRange(v(8)!, ACT_MIN, ACT_MAX)) return false;
  return isBool(v(2)) && isBool(v(3)) && isBool(v(5)) && isBool(v(7)) && (v(6) ?? 0) <= 2 && (v(9) ?? 0) <= 7 && b.every((f) => f.no <= 9);
}
function okPerKeyPayload(p: Uint8Array): boolean {
  if (!p.length) return true;
  const top = safe(() => pbDecode(p));
  if (!top || top.length !== 1 || top[0].no !== 4 || top[0].wt !== 2) return false;
  const fs = safe(() => pbDecode(top[0].b!));
  if (!fs || !fs.every((f) => f.no === 1 && f.wt === 0) || fs.length >= 50) return false;
  return fs.every((f) => validMid(f.v & 0xff) && ((f.v >>> 8) & 0xff) === 0 && inRange(Math.floor(f.v / 65536), ACT_MIN, ACT_MAX));
}
function okRtPayload(p: Uint8Array): boolean {
  const top = safe(() => pbDecode(p));
  if (!top || top.length > 30) return false;
  for (const g of top) {
    if (g.no !== 1 || g.wt !== 2) return false;
    const fs = safe(() => pbDecode(g.b!));
    if (!fs) return false;
    let keys = 0;
    let kinds = 0;
    for (const f of fs) {
      if (f.no === 1 && f.wt === 0 && validMid(f.v)) keys++;
      else if (f.no === 3 && f.wt === 0 && isBool(f.v)) kinds++;
      else if (f.no === 2 && f.wt === 2) {
        const c = safe(() => pbDecode(f.b!));
        if (!c || !varintsOnly(c) || !c.every((x) => x.no <= 3)) return false;
        if (!inRange(getV(c, 1) ?? 0, ACT_MIN, ACT_MAX) || !isBool(getV(c, 3))) return false;
        const s = getV(c, 2);
        if (s !== undefined && !inRange(s, ACT_MIN, ACT_MAX)) return false;
        kinds++;
      } else return false;
    }
    if (keys < 1 || keys > 10 || kinds !== 1) return false;
  }
  return true;
}
function okCorePayload(p: Uint8Array): boolean {
  const top = safe(() => pbDecode(p));
  const base = top?.find((f) => f.no === 1 && f.wt === 2);
  if (!top || !base) return false;
  const b = safe(() => pbDecode(base.b!));
  return !!b && (getV(b, 1) ?? 0) <= 255;
}

/** Output report data (after the report id): D1 DA type flags lenLo lenHi payload, zero padded. */
export function allowedReport(id: number, d: ArrayLike<number>): boolean {
  if (SIZE_OF.get(id) !== d.length || d[0] !== MAGIC0 || d[1] !== MAGIC1) return false;
  const type = d[2];
  const flags = d[3];
  const len = d[4] | (d[5] << 8);
  if (6 + len > d.length) return false;
  for (let i = 6 + len; i < d.length; i++) if (d[i] !== 0) return false;
  // the smallest report that fits, like Wootility
  const smallest = REPORT_SIZES.find(([, s]) => s >= 6 + len)?.[0];
  if (smallest !== id) return false;
  const p = Uint8Array.from(Array.from(d).slice(6, 6 + len));
  const profileFlags = flags === 0 || ((flags & 1) === 1 && flags >> 1 < SLOTS);
  switch (type) {
    case REPORT.keyboardProfile:
      return profileFlags && okKbPayload(p);
    case REPORT.perKey:
      return profileFlags && okPerKeyPayload(p);
    case REPORT.rtKeys:
      return profileFlags && okRtPayload(p);
    case REPORT.rgbCore:
      return flags === 0 && okCorePayload(p);
    default:
      return false;
  }
}

/** Frame an output report: [report id, data]. */
export function frameReport(type: number, flags: number, payload: Uint8Array): [number, Uint8Array<ArrayBuffer>] {
  const need = 6 + payload.length;
  const fit = REPORT_SIZES.find(([, s]) => s >= need);
  if (!fit) throw protoError('settings too large for one report');
  const d = new Uint8Array(fit[1]);
  d.set([MAGIC0, MAGIC1, type, flags, payload.length & 0xff, payload.length >> 8]);
  d.set(payload, 6);
  return [fit[0], d];
}

// ---------------------------------------------------------------- link

export interface Reply {
  status: number;
  body: Uint8Array;
}

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: { cmd: number; resolve: (r: Uint8Array) => void } | null = null;
  private partial: Uint8Array | null = null;
  private lastRx = 0;

  constructor(
    private readonly dev: HIDDevice,
    private readonly timeoutMs: number,
  ) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach() {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    let b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    const want = SIZE_OF.get(e.reportId);
    if (want === undefined) return;
    this.lastRx = Date.now();
    // a report split in pieces (Wootility joins them the same way)
    if (b.length < want) {
      const joined = this.partial ? new Uint8Array([...this.partial, ...b]) : b;
      if (joined.length < want) {
        this.partial = joined;
        return;
      }
      this.partial = null;
      b = joined.slice(0, want);
    }
    if (b[0] !== MAGIC0 || b[1] !== MAGIC1) return;
    if (this.waiter && b[2] === this.waiter.cmd) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(b);
    }
  };

  /** Feature command; resolves with the matching answer. One at a time. */
  cmd(cmd: number, slot = 0, trace?: string[]): Promise<Reply> {
    const data = Uint8Array.from([MAGIC0, MAGIC1, cmd, slot, 0, 0, 0]);
    if (!allowedCommand(data)) return Promise.reject(new Error(`command ${cmd} is blocked`));
    const run = async () => {
      // the keyboard sometimes answers twice: let a late copy pass before asking again (wootswitch)
      const quiet = 25 - (Date.now() - this.lastRx);
      if (quiet > 0) await sleep(quiet);
      const got = new Promise<Uint8Array | null>((resolve) => {
        const w = { cmd, resolve: (b: Uint8Array) => resolve(b) };
        this.waiter = w;
        setTimeout(() => {
          if (this.waiter === w) {
            this.waiter = null;
            resolve(null);
          }
        }, this.timeoutMs);
      });
      if (!this.dev.opened) await this.dev.open();
      trace?.push(`  > feature 01 ${hexs(data)}`);
      await this.dev.sendFeatureReport(FEATURE_ID, data);
      const r = await got;
      if (!r) throw new Error('no answer from the keyboard');
      const len = r[4] | (r[5] << 8);
      const body = r.slice(6, 6 + len);
      trace?.push(`  < status ${hex2(r[3])}, ${len} bytes: ${hexs(body)}`);
      return { status: r[3], body };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  report(type: number, flags: number, payload: Uint8Array): Promise<void> {
    const [id, data] = frameReport(type, flags, payload);
    if (!allowedReport(id, data)) return Promise.reject(new Error(`report ${hex2(type)} is blocked`));
    const run = async () => {
      if (!this.dev.opened) await this.dev.open();
      await this.dev.sendReport(id, data);
      await sleep(15);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- 60% board

/** [row, col, label, x, y, w]; matrix rows 1..5 (row 0 unused), from eng1n88r layouts/60he.toml */
const SIXTY: [number, number, string, number, number, number][] = [
  [1, 0, 'Esc', 0, 0, 1], [1, 1, '1', 1, 0, 1], [1, 2, '2', 2, 0, 1], [1, 3, '3', 3, 0, 1], [1, 4, '4', 4, 0, 1],
  [1, 5, '5', 5, 0, 1], [1, 6, '6', 6, 0, 1], [1, 7, '7', 7, 0, 1], [1, 8, '8', 8, 0, 1], [1, 9, '9', 9, 0, 1],
  [1, 10, '0', 10, 0, 1], [1, 11, '-', 11, 0, 1], [1, 12, '=', 12, 0, 1], [1, 13, 'Backspace', 13, 0, 2],
  [2, 0, 'Tab', 0, 1, 1.5], [2, 1, 'Q', 1.5, 1, 1], [2, 2, 'W', 2.5, 1, 1], [2, 3, 'E', 3.5, 1, 1], [2, 4, 'R', 4.5, 1, 1],
  [2, 5, 'T', 5.5, 1, 1], [2, 6, 'Y', 6.5, 1, 1], [2, 7, 'U', 7.5, 1, 1], [2, 8, 'I', 8.5, 1, 1], [2, 9, 'O', 9.5, 1, 1],
  [2, 10, 'P', 10.5, 1, 1], [2, 11, '[', 11.5, 1, 1], [2, 12, ']', 12.5, 1, 1], [2, 13, '\\', 13.5, 1, 1.5],
  [3, 0, 'Caps', 0, 2, 1.75], [3, 1, 'A', 1.75, 2, 1], [3, 2, 'S', 2.75, 2, 1], [3, 3, 'D', 3.75, 2, 1], [3, 4, 'F', 4.75, 2, 1],
  [3, 5, 'G', 5.75, 2, 1], [3, 6, 'H', 6.75, 2, 1], [3, 7, 'J', 7.75, 2, 1], [3, 8, 'K', 8.75, 2, 1], [3, 9, 'L', 9.75, 2, 1],
  [3, 10, ';', 10.75, 2, 1], [3, 11, "'", 11.75, 2, 1], [3, 13, 'Enter', 12.75, 2, 2.25],
  [4, 0, 'Shift', 0, 3, 2.25], [4, 2, 'Z', 2.25, 3, 1], [4, 3, 'X', 3.25, 3, 1], [4, 4, 'C', 4.25, 3, 1], [4, 5, 'V', 5.25, 3, 1],
  [4, 6, 'B', 6.25, 3, 1], [4, 7, 'N', 7.25, 3, 1], [4, 8, 'M', 8.25, 3, 1], [4, 9, ',', 9.25, 3, 1], [4, 10, '.', 10.25, 3, 1],
  [4, 11, '/', 11.25, 3, 1], [4, 13, 'Shift', 12.25, 3, 2.75],
  [5, 0, 'Ctrl', 0, 4, 1.25], [5, 1, 'Win', 1.25, 4, 1.25], [5, 2, 'Alt', 2.5, 4, 1.25], [5, 4, 'Space', 3.75, 4, 6.25],
  [5, 10, 'Alt', 10, 4, 1.25], [5, 11, 'Menu', 11.25, 4, 1.25], [5, 12, 'Ctrl', 12.5, 4, 1.25], [5, 13, 'Fn', 13.75, 4, 1.25],
];
/** the space bar spans three matrix cells (eng1n88r mapping dump: 29 at (5,4), (5,6), (5,8)) */
const EXTRA_CELLS = new Map<number, number[]>([[mid(5, 4), [mid(5, 6), mid(5, 8)]]]);
export const SIXTY_ANSI: KeyCap[] = SIXTY.map(([r, c, label, x, y, w]) => ({ index: mid(r, c), label, x, y, w, h: 1 }));
/** ISO (DeviceConfig layout 1 / 4): the extra keys left of Z and left of Enter */
export const SIXTY_ISO: KeyCap[] = SIXTY_ANSI.flatMap((k): KeyCap[] => {
  if (k.index === mid(4, 0)) return [{ ...k, w: 1.25 }, { index: mid(4, 1), label: '\\', x: 1.25, y: 3, w: 1, h: 1 }];
  if (k.index === mid(3, 13)) return [{ index: mid(3, 12), label: '#', x: 12.75, y: 2, w: 1, h: 1 }, { ...k, x: 13.75, w: 1.25 }];
  return [k];
});
export const cellsOf = (k: KeyCap) => [k.index, ...(EXTRA_CELLS.get(k.index) ?? [])];

export const LAYOUT_NAMES = ['ANSI', 'ISO', 'JIS', 'ANSI (split space)', 'ISO (split space)'];
const GAMEPAD_NAMES = ['Xbox', 'Classic', 'Off'];

// ---------------------------------------------------------------- driver

export interface WootingOptions {
  timeoutMs?: number;
}

interface State {
  slot: number;
  fw: number[];
  writable: boolean;
  kbTop: Uint8Array;
  base: PbField[];
  kb: Kb;
  rtRaw: Uint8Array;
  groups: RtGroup[];
  perKey?: Map<number, number>;
  coreRaw?: Uint8Array;
  caps?: KeyCap[];
}

const text = (key: string, label: string, t: string): Setting => ({ key, label, group: 'Info', value: { kind: 'text', text: t } });
const P = 'Performance';

export class WootingDriver implements Driver {
  readonly id: string;
  readonly family = 'Wooting';
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  private readonly link: Link;
  private readonly m: Model;
  private st: State | null = null;
  /** the board picture (60% boards only) */
  readonly layout?: () => KeyCap[];

  constructor(
    private readonly device: HIDDevice,
    o: WootingOptions = {},
  ) {
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.m = modelOf(device.productId) ?? { pid: device.productId, name: 'keyboard' };
    this.link = new Link(device, o.timeoutMs ?? 1500);
    if (this.m.sixty) this.layout = () => this.st?.caps ?? SIXTY_ANSI;
  }

  brand() {
    return 'Wooting';
  }
  model() {
    return this.m.name;
  }
  image() {
    return undefined;
  }

  private async ok(cmd: number, slot = 0): Promise<Uint8Array> {
    const r = await this.link.cmd(cmd, slot);
    if (r.status !== STATUS_OK) throw new Error(`the keyboard refused command ${cmd} (status ${hex2(r.status)})`);
    return r.body;
  }

  private async readFw(): Promise<[number[], string]> {
    const b = await this.ok(CMD.getVersion);
    if (b.length < 3) throw protoError('short firmware version');
    const suffix = String.fromCharCode(...b.slice(3).filter((x) => x >= 0x20 && x < 0x7f));
    const v = `${b[0]}.${b[1]}.${b[2]}`;
    return [[b[0], b[1], b[2]], suffix ? (/^[-+]/.test(suffix) ? v + suffix : `${v}-${suffix}`) : v];
  }

  private async readSlot(): Promise<number> {
    const b = await this.ok(CMD.getProfileIndex);
    const s = b[0];
    if (s === undefined || s >= SLOTS) throw new Error(`unexpected active profile ${s}`);
    return s;
  }

  async read(): Promise<Setting[]> {
    const out: Setting[] = [text('model', 'Model', `Wooting ${this.m.name}`)];
    const [fw, fwText] = await this.readFw();
    out.push(text('fw', 'Firmware', fwText));
    // writes only on the 14-bit value format (firmware 2.13.0+, Wootility r9())
    let writable = fw[0] > 2 || (fw[0] === 2 && fw[1] >= 13);
    const slot = await this.readSlot();

    const names: string[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const r = await this.link.cmd(CMD.getProfileMetadata, s).catch(() => undefined);
      if (!r || r.status !== STATUS_OK || !r.body.length) break;
      const name = safe(() => pbDecode(r.body).find((f) => f.no === 1 && f.wt === 2));
      names.push(name?.b ? new TextDecoder().decode(name.b) : '');
    }
    if (names.length > slot) {
      const options = names.map((n, i) => [n || `Profile ${i + 1}`, i] as [string, number]);
      out.push({ key: 'profile', label: 'Profile', group: 'Profile', value: { kind: 'choice', options, current: slot } });
    } else out.push(text('profile_n', 'Active profile', String(slot + 1)));

    const cfg = await this.ok(CMD.getDeviceConfig).catch(() => undefined);
    let caps: KeyCap[] | undefined;
    if (this.m.sixty) caps = cfg && (cfg[5] === 1 || cfg[5] === 4) ? SIXTY_ISO : SIXTY_ANSI;
    if (cfg && cfg.length >= 7) {
      out.push(text('kb_layout', 'Layout', LAYOUT_NAMES[cfg[5]] ?? `#${cfg[5]}`));
      out.push(text('usb_speed', 'USB polling', cfg[0] & 0x08 ? '1000 Hz' : '8000 Hz'));
      out.push(text('nkro', 'Key rollover', cfg[0] & 0x10 ? '6KRO' : 'NKRO'));
      out.push(text('gamepad', 'Gamepad mode', GAMEPAD_NAMES[(cfg[6] >> 1) & 3] ?? '?'));
    }

    const kbTop = await this.ok(CMD.getKeyboardProfile, slot);
    const base = kbBase(kbTop);
    const kb = parseKb(base);
    if (!is14(kb.act)) writable = false;
    // the per-key Rapid Trigger list is resent with every KeyboardProfile write: without a good copy, no writes
    const rtGot = await this.ok(CMD.getRtKeys, slot).catch(() => undefined);
    const parsed = rtGot && safe(() => parseRt(rtGot));
    if (!parsed) writable = false;
    const rtRaw = rtGot ?? new Uint8Array(0);
    const groups = parsed ?? [];
    let perKey: Map<number, number> | undefined;
    if (caps) {
      const pk = parsePerKey(await this.ok(CMD.getActuationProfile, slot));
      if (pk.form === 'legacy' || pk.form === 'unknown') writable = false;
      perKey = pk.map;
    }
    const coreRaw = await this.ok(CMD.getRgbProfileCore, slot).catch(() => undefined);
    this.st = { slot, fw, writable, kbTop, base, kb, rtRaw, groups, perKey, coreRaw, caps };

    const mm = (v: number) => codeToMm(v) ?? 0;
    const sens = mm(kb.sens) || 0.4;
    if (caps && perKey) {
      const travel = caps.map((k) => mm(perKey!.get(k.index) ?? kb.act));
      const rts = caps.map((k) => rtOf(k.index, kb, groups));
      const sensArr = rts.map((r) => (r === false ? sens : mm(r)));
      out.push({
        key: 'per_key_trigger',
        label: 'Per-key actuation',
        group: 'Per-key',
        value: {
          kind: 'perKeyTrigger',
          keys: caps,
          travel,
          rapid: rts.map((r) => r !== false),
          sens: sensArr,
          min: Math.min(ACT_MIN, ...travel),
          max: ACT_MAX,
          step: STEP,
          sensMin: Math.min(SENS_MIN, ...sensArr),
          sensMax: Math.max(SENS_MAX, ...sensArr),
        },
      });
    } else {
      const act = mm(kb.act);
      out.push({ key: 'actuation', label: 'Actuation point', group: P, value: { kind: 'float', min: Math.min(ACT_MIN, act), max: ACT_MAX, step: STEP, current: act, unit: 'mm' } });
      out.push({ key: 'rapid_trigger', label: 'Rapid Trigger', group: P, value: { kind: 'toggle', on: kb.rt } });
      out.push({ key: 'rt_sens', label: 'Rapid Trigger sensitivity', group: P, value: { kind: 'float', min: Math.min(SENS_MIN, sens), max: Math.max(SENS_MAX, sens), step: STEP, current: sens, unit: 'mm' } });
    }
    const rel = kb.release ? mm(kb.release) : sens;
    out.push({ key: 'rt_split', label: 'Separate release sensitivity', group: P, value: { kind: 'toggle', on: kb.release !== undefined }, hint: 'Rapid Trigger uses its own distance for releasing a key' });
    out.push({ key: 'rt_release', label: 'Release sensitivity', group: P, value: { kind: 'float', min: Math.min(SENS_MIN, rel), max: Math.max(SENS_MAX, rel), step: STEP, current: rel, unit: 'mm' } });
    out.push({ key: 'rt_continuous', label: 'Continuous Rapid Trigger', group: P, value: { kind: 'toggle', on: !kb.strict }, hint: 'Rapid Trigger stays on until the key is fully released, not only below the actuation point' });
    out.push({ key: 'tachyon', label: 'Tachyon mode', group: P, value: { kind: 'toggle', on: kb.tachyon }, hint: 'Faster key scanning; Wootility also lowers the brightness and turns off RGB effects' });
    const bri = coreRaw ? coreBrightness(coreRaw) : undefined;
    if (bri !== undefined) out.push({ key: 'light_bri', label: 'Brightness', group: 'Lighting', value: { kind: 'number', min: 0, max: 100, current: Math.round((bri * 100) / 255), unit: '%' } });
    if (!writable) out.push(text('unsupported', 'Note', 'Update the firmware in Wootility (2.13 or newer) to change settings here.'));
    return out;
  }

  async write(s: Setting): Promise<void> {
    const st = this.st;
    if (!st) throw new Error('press Re-read first');
    if (!st.writable) throw new Error('Update the firmware in Wootility (2.13 or newer) to change settings here.');
    const v: Value = s.value;
    const bad = () => new Error('bad value');
    // the active profile may have been switched on the keyboard itself: never write into another slot
    if ((await this.readSlot()) !== st.slot) throw new Error('The active profile changed on the keyboard - press Re-read.');
    switch (s.key) {
      case 'profile':
        if (v.kind !== 'choice') throw bad();
        return this.switchProfile(v.current);
      case 'light_bri':
        if (v.kind !== 'number' || v.current < 0 || v.current > 100) throw bad();
        return this.writeBrightness(Math.round((v.current * 255) / 100));
      case 'per_key_trigger':
        if (v.kind !== 'perKeyTrigger') throw bad();
        return this.writePerKey(v);
    }
    const kb = { ...st.kb };
    const snapMm = (n: number, lo: number, hi: number) => mmToCode(clamp(Math.round(n / STEP) * STEP, lo, hi));
    if (s.key === 'actuation' && v.kind === 'float') kb.act = snapMm(v.current, ACT_MIN, ACT_MAX);
    else if (s.key === 'rapid_trigger' && v.kind === 'toggle') kb.rt = v.on;
    else if (s.key === 'rt_sens' && v.kind === 'float') kb.sens = snapMm(v.current, SENS_MIN, SENS_MAX);
    else if (s.key === 'rt_split' && v.kind === 'toggle') kb.release = v.on ? (kb.release ?? kb.sens) : undefined;
    else if (s.key === 'rt_release' && v.kind === 'float') {
      if (kb.release === undefined) throw new Error('Turn on "Separate release sensitivity" first.');
      kb.release = snapMm(v.current, SENS_MIN, SENS_MAX);
    } else if (s.key === 'rt_continuous' && v.kind === 'toggle') kb.strict = !v.on;
    else if (s.key === 'tachyon' && v.kind === 'toggle') {
      kb.tachyon = v.on;
      // keep a special Tachyon variant the board already uses; otherwise Enabled (1) / Disabled (0)
      kb.tmode = v.on ? (st.kb.tachyon && st.kb.tmode > 1 ? st.kb.tmode : 1) : 0;
    } else throw new Error(`unknown setting ${s.key}`);
    await this.writeProfile(kb, st.groups);
  }

  private baseFor(kb: Kb): PbField[] {
    let b = this.st!.base;
    b = setField(b, 1, kb.act);
    b = setField(b, 3, kb.rt ? 1 : 0);
    b = setField(b, 4, kb.sens);
    b = setField(b, 5, kb.tachyon ? 1 : 0);
    b = setField(b, 7, kb.strict ? 1 : 0);
    // Wootility leaves field 8 out when split sensitivity is off
    b = setField(b, 8, kb.release);
    b = setField(b, 9, kb.tmode);
    return b;
  }

  /** RtKeys then KeyboardProfile, to RAM and then the active slot (Wootility's order), then read back. */
  private async writeProfile(kb: Kb, groups: RtGroup[]): Promise<void> {
    const st = this.st!;
    const top = withBase(st.kbTop, this.baseFor(kb));
    const rt = groups === st.groups ? st.rtRaw : encodeRt(groups);
    for (const flags of [0, flagsFor(st.slot)]) {
      await this.link.report(REPORT.rtKeys, flags, rt);
      await this.link.report(REPORT.keyboardProfile, flags, top);
    }
    await this.verify(async () => {
      const gotTop = await this.ok(CMD.getKeyboardProfile, st.slot);
      const gotKb = parseKb(kbBase(gotTop));
      const gotRtRaw = await this.ok(CMD.getRtKeys, st.slot);
      const gotGroups = parseRt(gotRtRaw);
      const same =
        gotKb.act === kb.act && gotKb.rt === kb.rt && gotKb.sens === kb.sens && gotKb.tachyon === kb.tachyon &&
        gotKb.strict === kb.strict && gotKb.release === kb.release && sameRt(kb, groups, gotKb, gotGroups, st.caps);
      if (same) {
        st.kbTop = gotTop;
        st.base = kbBase(gotTop);
        st.kb = gotKb;
        st.rtRaw = gotRtRaw;
        st.groups = gotGroups;
      }
      return same;
    }, "the keyboard didn't keep the setting");
  }

  private async verify(check: () => Promise<boolean>, msg: string) {
    for (let i = 0; i < 3; i++) {
      if (await check()) return;
      await sleep(80);
    }
    throw new Error(msg);
  }

  private async writePerKey(v: Extract<Value, { kind: 'perKeyTrigger' }>): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.perKey) throw new Error('per-key settings are not available on this keyboard');
    const n = caps.length;
    if (v.travel.length !== n || v.rapid.length !== n || v.sens.length !== n) throw new Error("per-key data doesn't match the keyboard layout - press Re-read");
    const snap = (x: number, lo: number, hi: number) => mmToCode(clamp(Math.round(x / STEP) * STEP, lo, hi));
    const plan = planPerKey(st.kb, st.perKey, st.groups, caps, v.travel.map((t) => snap(t, ACT_MIN, ACT_MAX)), v.rapid, v.sens.map((x) => snap(x, SENS_MIN, SENS_MAX)));

    if (plan.perKey) {
      const payload = encodePerKey(plan.perKey);
      for (const flags of [0, flagsFor(st.slot)]) await this.link.report(REPORT.perKey, flags, payload);
      const want = plan.perKey;
      await this.verify(async () => {
        const got = parsePerKey(await this.ok(CMD.getActuationProfile, st.slot)).map;
        const same = got.size === want.size && [...want].every(([m, c]) => got.get(m) === c);
        if (same) st.perKey = got;
        return same;
      }, "the keyboard didn't keep the per-key actuation");
    }
    if (plan.kb || plan.groups) await this.writeProfile(plan.kb ?? st.kb, plan.groups ?? st.groups);
  }

  private async writeBrightness(bri: number): Promise<void> {
    const st = this.st!;
    if (!st.coreRaw) throw new Error('no lighting settings');
    await this.link.report(REPORT.rgbCore, 0, withBrightness(st.coreRaw, bri));
    // SaveRgbProfile copies the lighting in RAM into the slot (Wootility saveRgbProfile)
    const r = await this.link.cmd(CMD.saveRgbProfile, st.slot);
    if (r.status !== STATUS_OK) throw new Error(`the keyboard refused to save the lighting (status ${hex2(r.status)})`);
    await this.verify(async () => {
      const got = await this.ok(CMD.getRgbProfileCore, st.slot);
      const ok = coreBrightness(got) === bri;
      if (ok) st.coreRaw = got;
      return ok;
    }, "the keyboard didn't keep the brightness");
  }

  /** wootswitch: WootDevInit, ActivateProfile(slot), 100 ms, ReloadProfile(slot), wait until active */
  private async switchProfile(slot: number): Promise<void> {
    const st = this.st!;
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error('bad profile');
    if (slot === st.slot) return;
    await this.ok(CMD.wootDevInit);
    await this.ok(CMD.activateProfile, slot);
    await sleep(100);
    // the keyboard may answer late while it reloads
    await this.link.cmd(CMD.reloadProfile, slot).catch(() => undefined);
    await sleep(100);
    for (let i = 0; i < 15; i++) {
      const now = await this.readSlot().catch(() => -1);
      if (now === slot) {
        st.slot = slot;
        return;
      }
      await sleep(100);
    }
    throw new Error("the keyboard didn't switch the profile");
  }

  async diagnose(onProgress?: (done: number, total: number) => void): Promise<string> {
    const out: string[] = ['Wooting diagnostics (read-only)', `model ${this.m.name}, id ${this.id}`];
    out.push('collections: ' + (this.device.collections ?? []).map((c) => `${(c.usagePage ?? 0).toString(16)}/${(c.usage ?? 0).toString(16)}`).join(', '));
    let slot = 0;
    const steps: [string, number, (() => number) | number][] = [
      ['firmware version', CMD.getVersion, 0],
      ['active profile', CMD.getProfileIndex, 0],
      ['device config', CMD.getDeviceConfig, 0],
      ['profile count', CMD.getProfileCount, 0],
      ...[0, 1, 2, 3].map((s) => [`profile ${s + 1} metadata`, CMD.getProfileMetadata, s] as [string, number, number]),
      ['keyboard profile', CMD.getKeyboardProfile, () => slot],
      ['per-key actuation', CMD.getActuationProfile, () => slot],
      ['per-key rapid trigger (61)', CMD.getRtKeys, () => slot],
      ['rapid trigger profile (54)', CMD.getRapidTriggerProfile, () => slot],
      ['rgb core', CMD.getRgbProfileCore, () => slot],
      ['global settings', CMD.getGlobalSettings, 0],
    ];
    let done = 0;
    onProgress?.(0, steps.length);
    for (const [title, cmd, s] of steps) {
      const sl = typeof s === 'function' ? s() : s;
      const trace: string[] = [];
      out.push('', `## ${title}: command ${cmd}, slot ${sl}`);
      try {
        const r = await this.link.cmd(cmd, sl, trace);
        out.push(...trace);
        if (cmd === CMD.getProfileIndex && r.body[0] !== undefined && r.body[0] < SLOTS) slot = r.body[0];
        if (r.status === STATUS_OK && r.body.length && cmd !== CMD.getVersion && cmd !== CMD.getDeviceConfig && cmd !== CMD.getProfileIndex) {
          const tree = safe(() => pbTree(r.body, '  '));
          out.push(...(tree ?? ['  (not protobuf)']));
        }
      } catch (e) {
        out.push(...trace, `  FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
      onProgress?.(++done, steps.length);
    }
    return out.join('\n');
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

/** Generic protobuf dump for diagnostics (nested messages tried, values also shown as mm). */
export function pbTree(b: Uint8Array, ind: string, depth = 0): string[] {
  const out: string[] = [];
  for (const f of pbDecode(b)) {
    if (f.wt === 0) {
      const mm = f.v > 0x7f ? codeToMm(f.v) : undefined;
      out.push(`${ind}${f.no}: ${f.v}${mm !== undefined ? ` (${mm} mm)` : ''}`);
    } else if (f.wt === 2) {
      const sub = depth < 4 && f.b!.length ? safe(() => pbTree(f.b!, ind + '  ', depth + 1)) : undefined;
      if (sub && sub.length) out.push(`${ind}${f.no}: {`, ...sub, `${ind}}`);
      else out.push(`${ind}${f.no}: bytes ${hexs(f.b!)}`);
    } else out.push(`${ind}${f.no}: fixed ${hexs(f.b!)}`);
  }
  return out;
}

/** Rapid Trigger state on every key of the board equal before / after (null caps: base only). */
function sameRt(kb: Kb, groups: RtGroup[], got: Kb, gotGroups: RtGroup[], caps?: KeyCap[]): boolean {
  if (!caps) return JSON.stringify(groups) === JSON.stringify(gotGroups) || groups.length === gotGroups.length;
  return caps.every((k) => cellsOf(k).every((m) => rtOf(m, kb, groups) === rtOf(m, got, gotGroups)));
}

export interface PerKeyPlan {
  perKey?: Map<number, number>;
  kb?: Kb;
  groups?: RtGroup[];
}

/** most common value (ties: keep `prefer`) */
function modeOf(vals: number[], prefer: number): number {
  const n = new Map<number, number>();
  for (const v of vals) n.set(v, (n.get(v) ?? 0) + 1);
  let best = prefer;
  let bestN = n.get(prefer) ?? 0;
  for (const [v, c] of n) if (c > bestN) [best, bestN] = [v, c];
  return best;
}

/**
 * Turn the board's per-key values (codes) into Wooting's model: one actuation point for all keys plus
 * per-key exceptions (0x15), and one Rapid Trigger switch + sensitivity plus exception groups (0x1D),
 * like Wootility's setRapidTriggerProfile. Parts that don't change are left out.
 */
export function planPerKey(kb: Kb, perKey: Map<number, number>, groups: RtGroup[], caps: KeyCap[], travel: number[], rapid: boolean[], sens: number[]): PerKeyPlan {
  const plan: PerKeyPlan = {};
  const next: Kb = { ...kb };
  // ---- actuation
  const oldTravel = caps.map((k) => perKey.get(k.index) ?? kb.act);
  if (travel.some((t, i) => t !== oldTravel[i])) {
    const g = modeOf(travel, kb.act);
    const map = new Map<number, number>();
    // keep exceptions on cells outside the picture (e.g. a layout we don't draw)
    const drawn = new Set(caps.flatMap(cellsOf));
    for (const [m, c] of perKey) if (!drawn.has(m)) map.set(m, c);
    caps.forEach((k, i) => {
      if (travel[i] !== g) for (const m of cellsOf(k)) map.set(m, travel[i]);
    });
    if (map.size >= 50) throw new Error('Too many keys with their own actuation point (49 at most).');
    plan.perKey = map;
    if (g !== kb.act) next.act = g;
  }
  // ---- rapid trigger
  const oldRt = caps.map((k) => rtOf(k.index, kb, groups));
  const newRt = caps.map((_, i) => (rapid[i] ? sens[i] : (false as const)));
  if (newRt.some((r, i) => r !== oldRt[i])) {
    const on = newRt.filter((r): r is number => r !== false);
    const out: RtGroup[] = [];
    if (!on.length) next.rt = false;
    else {
      const baseSens = modeOf(on, kb.sens);
      const nOn = on.filter((s) => s === baseSens).length;
      const nOff = newRt.filter((r) => r === false).length;
      next.sens = baseSens;
      next.rt = nOn > nOff;
      const cfg = (s: number): RtConfig => ({ primary: s, ...(next.release ? { secondary: next.release } : {}), continuous: !next.strict });
      const byVal = new Map<string, { g: RtGroup; keys: number[] }>();
      caps.forEach((k, i) => {
        const r = newRt[i];
        let g: RtGroup | undefined;
        if (r === false) g = next.rt ? { keys: [], enabled: false } : undefined;
        else if (r === baseSens) g = next.rt ? undefined : { keys: [], enabled: true };
        else g = { keys: [], config: cfg(r) };
        if (!g) return;
        const id = JSON.stringify(g);
        if (!byVal.has(id)) byVal.set(id, { g, keys: [] });
        byVal.get(id)!.keys.push(...cellsOf(k));
      });
      for (const { g, keys } of byVal.values()) for (let i = 0; i < keys.length; i += 10) out.push({ ...g, keys: keys.slice(i, i + 10) });
      if (out.length > 30) throw new Error('Too many different Rapid Trigger settings (30 groups of 10 keys at most).');
    }
    plan.groups = out;
  }
  if (JSON.stringify(next) !== JSON.stringify(kb)) plan.kb = next;
  return plan;
}

// ---------------------------------------------------------------- factory

const hasConfig = (d: HIDDevice) => (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE);

export const wootingFactory: DriverFactory = {
  name: 'Wooting',
  // Wootility asks for {vendorId 0x31E3, usagePage 0xFF55} the same way
  filters: [{ vendorId: VID, usagePage: USAGE_PAGE }],
  match(d: HIDDevice): boolean {
    return d.vendorId === VID && !!modelOf(d.productId) && hasConfig(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!wootingFactory.match(device)) return null;
    if (!device.opened) await device.open();
    return new WootingDriver(device);
  },
};
