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
// - Wootility's bundle again for the advanced keys (AKCItem: 1 dks {keys[4], bitmappedActions[4],
//   secondaryActuation}, 2 modTap {tapKey, holdKey, holdDuration, jitActivation}, 3 toggleKey
//   {keybind}, 4 rappySnappy {secondaryKey, socd}, 5 socd {secondaryKey, socd,
//   inputBothOnBottomOut}, 8 keyIndex, 9 layer; 0xFF = no key), SOCDType (0 Both, 1 Neither,
//   2 PrimaryPriority, 3 SecondaryPriority, 4 LastInputPriority) and the DKS bitmap (one byte per
//   point, 2 bits per action: 0 keep, 1 press, 2 release, 3 tap).
//
// Writes (each read back): KeyboardProfile (actuation, Rapid Trigger, Tachyon, "keys still type" in
// gamepad mode), per-key actuation (0x15), per-key Rapid Trigger (0x1D), key mapping per layer (0x14),
// gamepad mapping (0x12) and analog curve (0x13): to the active profile in RAM, then its flash slot.
// Advanced keys (0x18 to RAM + SaveAkcProfile), lighting colours (0x0E/0x0F) and effects / brightness
// (0x16) (to RAM + SaveRgbProfile(active slot)), global settings (0x17, flags 1), profile switching,
// and DeviceConfig (0x07: polling rate, 6KRO, gamepad mode) followed by SoftReset (25), which the
// link only sends right after a DeviceConfig write. Only firmware 2.13+ is written to (the 14-bit
// value format); older firmware is shown read-only.
//
// NEVER sent (allowed() refuses them): ResetToBootloader (2), SoftReset (25) on its own,
// ResetSettings (43), SetRawScanning (44), Delete/CreateProfile (63/64), saves other than
// SaveRgbProfile (8) / SaveAkcProfile (53), KeysOff, profile metadata, profile blobs, direct
// lighting, calibration.
import type { AdvancedKey, Driver, DriverFactory, ExtraCategory, KeyCap, Setting, SocdEntry, Value } from './types';
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
  /** 8000 Hz polling */
  eightK?: boolean;
}
export const MODELS: Model[] = [
  { pid: 0x1230, name: 'Two HE (ARM)' },
  { pid: 0x1310, name: '60HE (ARM)', sixty: true },
  { pid: 0x1320, name: '60HE+', sixty: true },
  { pid: 0x1340, name: '60HE v2', sixty: true, eightK: true },
  { pid: 0x1400, name: '80HE', eightK: true },
  { pid: 0x1410, name: '80HE+', eightK: true },
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
  getAnalogValues: 20,
  activateProfile: 23,
  softReset: 25,
  wootDevInit: 33,
  getRgbColors1: 35,
  getRgbColors2: 36,
  reloadProfile: 38,
  getKeyboardProfile: 39,
  getGamepadMapping: 40,
  getGamepadProfile: 41,
  getMappingProfile: 48,
  getActuationProfile: 49,
  getRgbProfileCore: 50,
  getGlobalSettings: 51,
  getAkcProfile: 52,
  saveAkcProfile: 53,
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
  CMD.getRgbColors1,
  CMD.getRgbColors2,
  CMD.getGamepadMapping,
  CMD.getGamepadProfile,
  CMD.getMappingProfile,
  CMD.getAkcProfile,
  CMD.saveAkcProfile,
]);
const ZERO_CMDS = new Set<number>([CMD.getVersion, CMD.getProfileIndex, CMD.getDeviceConfig, CMD.wootDevInit, CMD.getGlobalSettings, CMD.getProfileCount, CMD.getAnalogValues]);
/** key-mapping layers 0 (main), 1..3 (Fn 1..3) */
export const LAYERS = 4;

export const REPORT = {
  deviceConfig: 0x07,
  colors1: 0x0e,
  colors2: 0x0f,
  keyboardProfile: 0x11,
  gamepadMapping: 0x12,
  gamepadProfile: 0x13,
  mapping: 0x14,
  perKey: 0x15,
  rgbCore: 0x16,
  global: 0x17,
  akc: 0x18,
  rtKeys: 0x1d,
} as const;
/** flags of device-wide reports (GlobalSettings) */
export const FLAGS_GLOBAL = 1;
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
  /** field 2, gamepad mode: keys mapped to the controller still type */
  keys?: boolean;
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
    keys: getV(base, 2) === undefined ? undefined : !!getV(base, 2),
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

/** a packed repeated uint32 field */
function packed(no: number, vals: number[]): PbField {
  const out: number[] = [];
  for (const v of vals) out.push(...varint(v));
  return mf(no, Uint8Array.from(out));
}
const bytesOf = (fs: PbField[], no: number) => fs.find((f) => f.no === no && f.wt === 2)?.b;

// ---------------------------------------------------------------- key codes

/** matrix of the mapping / colour / analog tables */
export const ROWS = 6;
export const COLS = 21;
/** Wooting's "no key" */
export const W_NONE = 0xff;
export const W_FN1 = 0xe7;

/** Wooting key code -> HID keyboard usage, for ordinary keys (HID - 3, keypad HID - 2, modifiers 0x63..) */
export function wootToHid(w: number): number | undefined {
  if (w >= 0x01 && w <= 0x4f) return w + 3;
  if (w >= 0x51 && w <= 0x60) return w + 2;
  if (w === 0x61) return 0x64;
  if (w >= 0x63 && w <= 0x6a) return w - 0x63 + 0xe0;
  if (w >= 0x6b && w <= 0x76) return w - 0x6b + 0x68;
  if (w === 0x77) return 0x65;
  return undefined;
}
export function hidToWoot(h: number): number | undefined {
  if (h >= 0x04 && h <= 0x52) return h - 3;
  if (h >= 0x53 && h <= 0x62) return h - 2;
  if (h === 0x64) return 0x61;
  if (h === 0x65) return 0x77;
  if (h >= 0x68 && h <= 0x73) return h - 0x68 + 0x6b;
  if (h >= 0xe0 && h <= 0xe7) return h - 0xe0 + 0x63;
  return undefined;
}
/** Wooting media / system keys -> QMK v2 keycodes */
const W_MEDIA: [w: number, qmk: number][] = [
  [0xc0, 0xab], [0xc1, 0xac], [0xc2, 0xae], [0xc3, 0xa8], [0xc4, 0xa9], [0xc5, 0xaa], [0xc6, 0xaf], [0xc7, 0xb1],
  [0xc8, 0xb2], [0xc9, 0xb3], [0xca, 0xb4], [0xcb, 0xb5], [0xcc, 0xb6], [0xcd, 0xb7], [0xce, 0xb8], [0xcf, 0xb9],
  [0xd0, 0xba], [0xd1, 0xa5], [0xd2, 0xa6], [0xd6, 0xbe], [0xd7, 0xbd],
];
/** Wooting-only keys, offered as their own picker category (keymap code = WT_BASE | Wooting code) */
export const WT_BASE = 0x7e00;
const W_OWN: [w: number, id: string, label: string, name: string][] = [
  [0xe7, 'FN1', 'Fn', 'Fn key (Fn layer 1)'], [0xea, 'FN2', 'Fn 2', 'Fn layer 2'], [0xeb, 'FN3', 'Fn 3', 'Fn layer 3'],
  [0xe8, 'LOCK', 'Lock', 'Key lock (Wooting)'],
  [0xe5, 'P1', 'P1', 'Profile 1'], [0xe2, 'P2', 'P2', 'Profile 2'], [0xe3, 'P3', 'P3', 'Profile 3'], [0xe4, 'P4', 'P4', 'Profile 4'],
  [0xec, 'PCYC', 'Cycle', 'Next profile'],
  [0xe0, 'RGBU', 'RGB+', 'Lighting brighter'], [0xe1, 'RGBD', 'RGB-', 'Lighting dimmer'], [0xe6, 'RGBM', 'Mode', 'Next lighting effect'],
  [0xd8, 'BTN1', 'Mouse L', 'Mouse left button'], [0xd9, 'BTN2', 'Mouse R', 'Mouse right button'], [0xda, 'BTN3', 'Mouse M', 'Mouse middle button'],
  [0xdb, 'BTN4', 'Mouse 4', 'Mouse back button'], [0xdc, 'BTN5', 'Mouse 5', 'Mouse forward button'],
  [0xd4, 'SCRN', 'Screen', 'Screen switch'], [0xd5, 'APPS', 'Apps', 'App grid'],
  [0xed, 'IMEON', 'IME On', 'IME on (Lang 1)'], [0xee, 'IMEOFF', 'IME Off', 'IME off (Lang 2)'],
  [0xef, 'LANG3', 'Lang 3', 'Lang 3'], [0xf0, 'LANG4', 'Lang 4', 'Lang 4'], [0xf1, 'LANG5', 'Lang 5', 'Lang 5'],
  [0xf2, 'RO', 'Ro', 'JIS Ro'], [0xf3, 'KANA', 'Kana', 'JIS Katakana / Hiragana'], [0xf4, 'YEN', '¥', 'JIS Yen'],
  [0xf5, 'HENK', 'Conv', 'JIS Henkan'], [0xf6, 'MHEN', 'NConv', 'JIS Muhenkan'],
];
const OWN_W = new Set(W_OWN.map(([w]) => w));

/** Wooting code -> keymap code (QMK v2 where there is one) */
export function wootToQmk(w: number): number {
  if (w === W_NONE) return 0;
  const hid = wootToHid(w);
  if (hid !== undefined) return hid;
  const m = W_MEDIA.find(([x]) => x === w);
  if (m) return m[1];
  return WT_BASE | w;
}
/** keymap code -> Wooting code; undefined when the keyboard can't send it */
export function qmkToWoot(q: number): number | undefined {
  if (q === 0 || q === 1) return W_NONE;
  if ((q & 0xff00) === WT_BASE) return q & 0xff;
  const m = W_MEDIA.find(([, x]) => x === q);
  if (m) return m[0];
  if (q <= 0xe7) return hidToWoot(q);
  return undefined;
}

// ---------------------------------------------------------------- key mapping (0x14)

/** Factory mapping of the 60HE layers (eng1n88r layout.rs, captured from a 60HE+), 14 columns shown */
const DEFAULT_MAP: number[][][] = [
  [
    [],
    [0x26, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x2a, 0x2b, 0x27],
    [0x28, 0x11, 0x17, 0x05, 0x12, 0x14, 0x19, 0x15, 0x09, 0x0f, 0x10, 0x2c, 0x2d, 0x2e],
    [0x36, 0x01, 0x13, 0x04, 0x06, 0x07, 0x08, 0x0a, 0x0b, 0x0c, 0x30, 0x31, 0x2e, 0x25],
    [0x64, 0x61, 0x1a, 0x18, 0x03, 0x16, 0x02, 0x0e, 0x0d, 0x33, 0x34, 0x35, 0xff, 0x68],
    [0x63, 0x66, 0x65, 0xff, 0x29, 0xff, 0x29, 0xff, 0x29, 0xff, 0x69, 0x77, 0x67, 0xe7],
  ],
  [
    [],
    [0x32, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x49],
    [0x43, 0xff, 0x48, 0xff, 0x5d, 0x5e, 0x5f, 0x60, 0xff, 0xff, 0xe2, 0xe3, 0xe4, 0xff],
    [0xea, 0x47, 0x4b, 0x4a, 0x5a, 0x5b, 0x5c, 0xc1, 0xc2, 0xc0, 0xe1, 0xe0, 0xff, 0xe6],
    [0x64, 0xff, 0xff, 0xff, 0xff, 0x57, 0x58, 0x59, 0xc3, 0xc5, 0xc4, 0x4f, 0xff, 0x68],
    [0x63, 0x66, 0x65, 0xff, 0x29, 0x29, 0x29, 0x29, 0x29, 0xff, 0x4d, 0x4e, 0x4c, 0xe7],
  ],
  [
    [],
    [],
    [0xff, 0xff, 0xff, 0xff, 0x05, 0x10, 0x09, 0x03],
    [0xea, 0xff, 0xff, 0xff, 0x07, 0x01, 0x0d, 0x05, 0x12],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0x0d, 0x0f, 0x16, 0x05],
    [0x4c, 0xe8, 0x4d, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7],
  ],
];
const fullRows = (src?: number[][]) => Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => src?.[r]?.[c] ?? W_NONE));
export const defaultMapping = (layer: number) => fullRows(DEFAULT_MAP[layer]);

/** MappingProfile { repeated Row { bytes codes = 1 } rows = 1 }; null = the layer uses the factory mapping */
export function parseMapping(b: Uint8Array): number[][] | null {
  if (!b.length) return null;
  const rows = pbDecode(b).filter((f) => f.no === 1 && f.wt === 2).map((r) => Array.from(bytesOf(pbDecode(r.b!), 1) ?? []));
  return rows.length ? fullRows(rows) : null;
}
export function encodeMapping(rows: number[][]): Uint8Array {
  return pbEncode(fullRows(rows).map((r) => mf(1, pbEncode([mf(1, Uint8Array.from(r))]))));
}

// ---------------------------------------------------------------- gamepad (0x12 / 0x13)

/** [code, label] of the Xbox controller (Wootility v5.4 tooltips, eng1n88r gamepad.rs) */
export const GP_XBOX: [number, string][] = [
  [0x78, 'A'], [0x79, 'B'], [0x7a, 'X'], [0x7b, 'Y'], [0x7c, 'Start'], [0x7d, 'Select'], [0x7e, 'D-pad up'], [0x7f, 'D-pad down'],
  [0x80, 'D-pad left'], [0x81, 'D-pad right'], [0x82, 'LB'], [0x83, 'RB'], [0x84, 'Guide'], [0x85, 'Left stick up'], [0x86, 'Left stick down'],
  [0x87, 'Left stick left'], [0x88, 'Left stick right'], [0x89, 'Right stick up'], [0x8a, 'Right stick down'], [0x8b, 'Right stick left'],
  [0x8c, 'Right stick right'], [0x8d, 'Left stick press'], [0x8e, 'Right stick press'], [0x8f, 'LT'], [0x90, 'RT'],
];
/** the "Classic" generic joystick (12 buttons, 6 axes, hat) */
export const GP_CLASSIC: [number, string][] = [
  ...Array.from({ length: 12 }, (_, i) => [0x78 + i, `Button ${i + 1}`] as [number, string]),
  [0x85, 'Y axis up'], [0x86, 'Y axis down'], [0x87, 'X axis left'], [0x88, 'X axis right'], [0x89, 'Y rotation up'], [0x8a, 'Y rotation down'],
  [0x8b, 'X rotation left'], [0x8c, 'X rotation right'], [0x8f, 'Throttle'], [0x90, 'Elevator'], [0x91, 'Accelerator'], [0x92, 'Rudder'],
  [0x93, 'Trigger'], [0x94, 'Z axis forward'], [0x95, 'Z axis backward'], [0x96, 'Z rotation forward'], [0x97, 'Z rotation back'],
  [0x98, 'Hat up'], [0x99, 'Hat down'], [0x9a, 'Hat left'], [0x9b, 'Hat right'],
];
const GP_MIN = 0x78;
const GP_MAX = 0x9b;

export interface GpMap {
  /** matrix id -> button code */
  keys: Map<number, number>;
  /** "Gamepad mapping override": mapped keys stop typing */
  override: boolean;
}
/** GamepadMapping { 1: Layer { 2: Keys { repeated key = 1 } }, 2: override } */
export function parseGpMap(b: Uint8Array): GpMap {
  const fs = pbDecode(b);
  const keys = new Map<number, number>();
  const layer = bytesOf(fs, 1);
  const list = layer && bytesOf(pbDecode(layer), 2);
  if (list) for (const k of repeated(pbDecode(list), 1)) keys.set(k & 0xff, (k >> 8) & 0xff);
  return { keys, override: !!getV(fs, 2) };
}
export function encodeGpMap(m: GpMap): Uint8Array {
  // Wootility sends an empty report when nothing is mapped
  if (!m.keys.size && !m.override) return new Uint8Array(0);
  const entries = [...m.keys].sort((a, b) => a[0] - b[0]).map(([k, code]) => vf(1, (code << 8) | k));
  return pbEncode([mf(1, pbEncode([mf(2, pbEncode(entries))])), vf(2, m.override ? 1 : 0)]);
}

export interface GpProfile {
  /** 4 points, x = travel 0..255 over 0.10..4.00 mm, y = output 0..255 */
  points: { x: number; y: number }[];
  angleOn: boolean;
  square: boolean;
  snappy: boolean;
  /** 0..100 = 0..90 degrees */
  angle: number;
  /** other top-level fields, kept */
  rest: PbField[];
}
/** GamepadProfile { 1: Curve { repeated Point { 1 x, 2 y } = 1 }, 2: Settings { 1 angle on, 2 square, 3 snappy, 4 angle } } */
export function parseGpProfile(b: Uint8Array): GpProfile {
  const fs = pbDecode(b);
  const curve = bytesOf(fs, 1);
  const points = curve
    ? pbDecode(curve).filter((f) => f.no === 1 && f.wt === 2).map((p) => {
        const pf = pbDecode(p.b!);
        return { x: getV(pf, 1) ?? 0, y: getV(pf, 2) ?? 0 };
      })
    : [];
  const st = bytesOf(fs, 2);
  const sf = st ? pbDecode(st) : [];
  return {
    points,
    angleOn: !!getV(sf, 1),
    square: !!getV(sf, 2),
    snappy: !!getV(sf, 3),
    angle: getV(sf, 4) ?? 50,
    rest: fs.filter((f) => f.no !== 1 && f.no !== 2),
  };
}
export function encodeGpProfile(p: GpProfile): Uint8Array {
  const curve = mf(1, pbEncode(p.points.map((q) => mf(1, pbEncode([vf(1, q.x), vf(2, q.y)])))));
  const settings = mf(2, pbEncode([vf(1, p.angleOn ? 1 : 0), vf(2, p.square ? 1 : 0), vf(3, p.snappy ? 1 : 0), vf(4, p.angle)]));
  return pbEncode([curve, settings, ...p.rest]);
}
/** Wootility's curve presets (x, y) x 4 */
export const GP_PRESETS: { name: string; points: [number, number][] }[] = [
  { name: 'Linear', points: [[0, 20], [60, 60], [194, 195], [253, 255]] },
  { name: 'Aggressive', points: [[0, 33], [63, 114], [139, 231], [253, 255]] },
  { name: 'Slow', points: [[0, 23], [128, 63], [226, 145], [253, 255]] },
  { name: 'Smooth', points: [[0, 26], [78, 84], [199, 174], [253, 255]] },
  { name: 'Steep', points: [[0, 26], [25, 132], [192, 135], [253, 255]] },
  { name: 'Instant', points: [[0, 255], [2, 255], [192, 255], [255, 255]] },
  { name: 'Turbo', points: [[0, 255], [1, 255], [2, 255], [3, 255]] },
];
export const CURVE_X0 = 0.1;
export const CURVE_SPAN = 3.9;
export const curveXToMm = (x: number) => round2(CURVE_X0 + (x / 255) * CURVE_SPAN);
export const curveMmToX = (mm: number) => clamp(Math.round(((mm - CURVE_X0) / CURVE_SPAN) * 255), 0, 255);

// ---------------------------------------------------------------- advanced keys (0x18)

export type AkcKind = 'dks' | 'mt' | 'tgl' | 'rappy' | 'socd' | 'other';
export interface AkcItem {
  /** the entry exactly as read (re-sent unchanged when the entry isn't edited) */
  raw: Uint8Array;
  kind: AkcKind;
  /** matrix id */
  key: number;
  layer: number;
  // dks
  codes?: number[];
  points?: number[];
  secondary?: number;
  // mod-tap
  tap?: number;
  hold?: number;
  duration?: number;
  jit?: number;
  // toggle
  code?: number;
  // rappy snappy / socd
  other?: number;
  socd?: number;
  both?: boolean;
}
const AKC_KIND: Record<number, AkcKind> = { 1: 'dks', 2: 'mt', 3: 'tgl', 4: 'rappy', 5: 'socd' };
const AKC_NO: Record<Exclude<AkcKind, 'other'>, number> = { dks: 1, mt: 2, tgl: 3, rappy: 4, socd: 5 };

export function parseAkcItem(raw: Uint8Array): AkcItem {
  const fs = pbDecode(raw);
  const it: AkcItem = { raw, kind: 'other', key: getV(fs, 8) ?? 0, layer: getV(fs, 9) ?? 0 };
  const sub = fs.find((f) => f.wt === 2 && AKC_KIND[f.no]);
  if (!sub) return it;
  it.kind = AKC_KIND[sub.no];
  const s = pbDecode(sub.b!);
  if (it.kind === 'dks') {
    it.codes = Array.from(bytesOf(s, 1) ?? []);
    it.points = Array.from(bytesOf(s, 2) ?? []);
    it.secondary = getV(s, 3);
    if (it.codes.length !== 4 || it.points.length !== 4) it.kind = 'other';
  } else if (it.kind === 'mt') {
    it.tap = getV(s, 1) ?? W_NONE;
    it.hold = getV(s, 2) ?? W_NONE;
    it.duration = getV(s, 3) || undefined;
    it.jit = getV(s, 4);
  } else if (it.kind === 'tgl') it.code = getV(s, 1) ?? W_NONE;
  else {
    it.other = getV(s, 1) ?? 0;
    it.socd = getV(s, 2) ?? 0;
    if (it.kind === 'socd') it.both = !!getV(s, 3);
  }
  return it;
}
/** a new entry's bytes (field order as Wootility: the function, then 8 key, 9 layer) */
export function encodeAkcItem(it: AkcItem): Uint8Array {
  if (it.kind === 'other') return it.raw;
  let s: PbField[];
  if (it.kind === 'dks') {
    s = [mf(1, Uint8Array.from(it.codes!)), mf(2, Uint8Array.from(it.points!))];
    if (it.secondary !== undefined) s.push(vf(3, it.secondary));
  } else if (it.kind === 'mt') {
    s = [vf(1, it.tap!), vf(2, it.hold!)];
    if (it.duration !== undefined) s.push(vf(3, it.duration));
    if (it.jit !== undefined) s.push(vf(4, it.jit));
  } else if (it.kind === 'tgl') s = [vf(1, it.code!)];
  else {
    s = [vf(1, it.other!), vf(2, it.socd!)];
    if (it.kind === 'socd') s.push(vf(3, it.both ? 1 : 0));
  }
  return pbEncode([mf(AKC_NO[it.kind], pbEncode(s)), vf(8, it.key), vf(9, it.layer)]);
}
export interface Akc {
  items: AkcItem[];
  /** the other top-level fields (2, 3 = entry count), kept */
  rest: PbField[];
}
export function parseAkc(b: Uint8Array): Akc {
  const fs = pbDecode(b);
  return { items: fs.filter((f) => f.no === 1 && f.wt === 2).map((f) => parseAkcItem(f.b!)), rest: fs.filter((f) => f.no !== 1) };
}
export function encodeAkc(items: Uint8Array[], rest: PbField[]): Uint8Array {
  let r = rest.length ? rest : [vf(2, 0)];
  r = setField(r, 3, items.length);
  return pbEncode([...items.map((b) => mf(1, b)), ...r]);
}
/** most advanced-key entries we write (the firmware's limit isn't known; Wootility shows "limited slots") */
export const AKC_MAX = 32;
/** DKS change at a point, per action (2 bits each) */
const DKS_KEEP = 0;
const DKS_DOWN = 1;
const DKS_UP = 2;
const DKS_TAP = 3;
/** UI mask (bit 2k = fires at stage k, bit 2k+1 = held from stage k to k+1) -> the 4 point bytes' 2-bit codes */
export function dksPoints(masks: number[]): number[] {
  const pts = [0, 0, 0, 0];
  masks.forEach((m, a) => {
    for (let k = 0; k < 4; k++) {
      const prev = k > 0 && (m >> (2 * k - 1)) & 1;
      const now = k < 3 && (m >> (2 * k + 1)) & 1;
      const fire = (m >> (2 * k)) & 1;
      const c = prev && now ? DKS_KEEP : !prev && now ? DKS_DOWN : fire ? DKS_TAP : DKS_UP;
      pts[k] |= c << (2 * a);
    }
  });
  return pts;
}
export function dksMasks(points: number[], n = 4): number[] {
  return Array.from({ length: n }, (_, a) => {
    let m = 0;
    let held = false;
    for (let k = 0; k < 4; k++) {
      const c = ((points[k] ?? 0) >> (2 * a)) & 3;
      if (c === DKS_DOWN) {
        m |= 1 << (2 * k);
        held = true;
      } else if (c === DKS_TAP) {
        m |= 1 << (2 * k);
        held = false;
      } else if (c === DKS_UP) held = false;
      if (held && k < 3) m |= 1 << (2 * k + 1);
    }
    return m;
  });
}
/** Snappy Tappy modes (SOCDType) plus Rappy Snappy as its own mode */
export const RAPPY = 100;
export const SOCD_MODES: [string, number][] = [
  ['Last input wins', 4],
  ['Neutral: neither', 1],
  ['Key 1 wins', 2],
  ['Key 2 wins', 3],
  ['Both', 0],
  ['Rappy Snappy: deeper press wins', RAPPY],
];

// ---------------------------------------------------------------- lighting colours (0x0E / 0x0F) and effects

/** RgbRows { repeated Row { repeated uint32 colors = 1 [packed] } rows = 1 }, RGB565 */
export function parseRows(b: Uint8Array): number[][] {
  return pbDecode(b).filter((f) => f.no === 1 && f.wt === 2).map((r) => repeated(pbDecode(r.b!), 1));
}
export function encodeRows(rows: number[][]): Uint8Array {
  return pbEncode(rows.map((r) => mf(1, pbEncode([packed(1, r)]))));
}
export const to565 = (rgb: number) => (((rgb >> 16) & 0xf8) << 8) | (((rgb >> 8) & 0xfc) << 3) | ((rgb & 0xff) >> 3);
export function from565(v: number): number {
  const r = (v >> 11) & 31;
  const g = (v >> 5) & 63;
  const b = v & 31;
  return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
}

/** effect layer kinds Wootility writes, with the parameters its presets use (eng1n88r captures) */
export const EFFECTS: [no: number, name: string, params: [number, number][]][] = [
  [1, 'Wave', [[1, 0], [2, 16], [3, 0]]],
  [3, 'Breathing', [[1, 15], [3, 0]]],
  [5, 'Ripple', [[1, 0], [2, 20], [3, 30], [4, 30]]],
  [6, 'Trail', [[1, 30], [2, 4], [3, 0], [4, 0xffff]]],
  [7, 'Reactive', [[1, 30], [2, 0], [3, 0], [4, 0], [5, 1]]],
  [8, 'Jelly', [[1, 30], [2, 0]]],
  [9, 'Splash', [[1, 30], [2, 0]]],
  [10, 'Mixing', [[1, 0]]],
  [11, 'Rapid Trigger display', [[1, 140]]],
  [14, 'Noise', [[1, 0xf800], [2, 0x001f], [3, 50], [4, 25]]],
  [15, 'Spiral', [[1, 0xf800], [2, 0x001f], [3, 100], [4, 139]]],
];
/** kinds we know by name but don't create (no captured defaults) */
const EFFECT_NAMES: Record<number, string> = { 2: 'Scan', 4: 'Colour cycle', ...Object.fromEntries(EFFECTS.map(([n, name]) => [n, name])) };
/** RgbProfileCore field 4 = Effects { repeated layer = 1 }; each layer one field = the effect kind */
export function coreLayers(core: Uint8Array): Uint8Array[] {
  const fx = bytesOf(pbDecode(core), 4);
  return fx ? pbDecode(fx).filter((f) => f.no === 1 && f.wt === 2).map((f) => f.b!) : [];
}
export function effectKind(layer: Uint8Array): number {
  return pbDecode(layer).find((f) => f.wt === 2)?.no ?? 0;
}
export function withLayers(core: Uint8Array, layers: Uint8Array[]): Uint8Array {
  const fx = mf(4, pbEncode(layers.map((l) => mf(1, l))));
  const fs = pbDecode(core);
  return pbEncode(fs.some((f) => f.no === 4) ? fs.map((f) => (f.no === 4 ? fx : f)) : [...fs, fx]);
}
export function effectLayer(no: number): Uint8Array {
  const e = EFFECTS.find(([n]) => n === no);
  if (!e) throw new Error('unknown effect');
  return pbEncode([mf(no, pbEncode(e[2].map(([f, v]) => vf(f, v))))]);
}

// ---------------------------------------------------------------- global settings (0x17) and DeviceConfig (0x07)

export interface Global {
  dim?: number;
  off?: number;
  numlock: boolean;
  debounce: boolean;
}
/** GlobalSettings { 1: { 1 dim after, 2 off after }, 2 Num Lock inverted, 3 debounce filter } */
export function parseGlobal(b: Uint8Array): Global {
  const fs = pbDecode(b);
  const p = bytesOf(fs, 1);
  const pf = p ? pbDecode(p) : [];
  return { dim: getV(pf, 1), off: getV(pf, 2), numlock: !!getV(fs, 2), debounce: !!getV(fs, 3) };
}
export function encodeGlobal(b: Uint8Array, g: Global): Uint8Array {
  let fs = pbDecode(b);
  const p = bytesOf(fs, 1);
  let pf = p ? pbDecode(p) : [];
  pf = setField(setField(pf, 1, g.dim), 2, g.off);
  const pm = mf(1, pbEncode(pf));
  fs = fs.some((f) => f.no === 1) ? fs.map((f) => (f.no === 1 ? pm : f)) : [pm, ...fs];
  return pbEncode(setField(setField(fs, 2, g.numlock ? 1 : 0), 3, g.debounce ? 1 : 0));
}

/** DeviceConfig bits (eng1n88r captures; Wootility bundle) */
export const CFG = { usbFull: 0x08, sixKro: 0x10, gpClassic: 0x02, gpOff: 0x04, gp1000: 0x08 } as const;
/** the 7 bytes to write: what GetDeviceConfig returned, read-only byte 4 cleared (Wootility writes 0 there) */
export function configBody(cfg: Uint8Array): number[] {
  const b = Array.from(cfg.slice(0, 7));
  while (b.length < 7) b.push(0);
  b[4] = 0;
  return b;
}

// ---------------------------------------------------------------- allowlist

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');

/**
 * Feature command data (after report id 1): D1 DA cmd slot 0 layer 0 (layer only for GetMappingProfile).
 * SoftReset (25) only with `reset` (the link sets it right after a DeviceConfig write).
 */
export function allowedCommand(d: ArrayLike<number>, reset = false): boolean {
  if (d.length !== 7 || d[0] !== MAGIC0 || d[1] !== MAGIC1) return false;
  const cmd = d[2];
  if (d[4] !== 0 || d[6] !== 0) return false;
  if (d[5] !== 0 && !(cmd === CMD.getMappingProfile && d[5] < LAYERS)) return false;
  if (cmd === CMD.softReset) return reset && d[3] === 0 && d[5] === 0;
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
  if (!b || (getV(b, 1) ?? 0) > 255) return false;
  // effects: layers of exactly one known effect kind with small numeric parameters
  const fx = top.filter((f) => f.no === 4);
  if (fx.length > 1 || fx.some((f) => f.wt !== 2)) return false;
  if (fx.length) {
    const layers = safe(() => pbDecode(fx[0].b!));
    if (!layers || layers.length > 8) return false;
    for (const l of layers) {
      if (l.no !== 1 || l.wt !== 2) return false;
      const k = safe(() => pbDecode(l.b!));
      if (!k || k.length !== 1 || k[0].wt !== 2 || k[0].no < 1 || k[0].no > 15) return false;
      const params = safe(() => pbDecode(k[0].b!));
      if (!params || !varintsOnly(params) || params.some((x) => x.no > 8 || x.v > 0xffff)) return false;
    }
  }
  return true;
}
function okColorsPayload(p: Uint8Array): boolean {
  const rows = safe(() => pbDecode(p));
  if (!rows || rows.length > 3) return false;
  return rows.every((r) => {
    if (r.no !== 1 || r.wt !== 2) return false;
    const fs = safe(() => pbDecode(r.b!));
    if (!fs || fs.length !== 1 || fs[0].no !== 1) return false;
    const vals = safe(() => repeated(fs, 1));
    return !!vals && vals.length <= COLS && vals.every((v) => v <= 0xffff);
  });
}
function okGpMapPayload(p: Uint8Array): boolean {
  if (!p.length) return true;
  const fs = safe(() => pbDecode(p));
  if (!fs || !fs.every((f) => (f.no === 1 && f.wt === 2) || (f.no === 2 && f.wt === 0 && isBool(f.v)))) return false;
  for (const f of fs.filter((x) => x.no === 1)) {
    const l = safe(() => pbDecode(f.b!));
    if (!l || !l.every((x) => x.no === 2 && x.wt === 2)) return false;
    for (const k of l) {
      const keys = safe(() => pbDecode(k.b!));
      if (!keys || keys.length > ROWS * COLS) return false;
      for (const e of keys) {
        const code = (e.v >> 8) & 0xff;
        if (e.no !== 1 || e.wt !== 0 || e.v > 0xffff || !validMid(e.v & 0xff) || code < GP_MIN || code > GP_MAX) return false;
      }
    }
  }
  return true;
}
function okGpProfilePayload(p: Uint8Array): boolean {
  const fs = safe(() => pbDecode(p));
  if (!fs) return false;
  const curve = fs.filter((f) => f.no === 1);
  const st = fs.filter((f) => f.no === 2);
  if (curve.length !== 1 || st.length !== 1 || curve[0].wt !== 2 || st[0].wt !== 2 || fs.length !== 2) return false;
  const pts = safe(() => pbDecode(curve[0].b!));
  if (!pts || pts.length !== 4) return false;
  for (const q of pts) {
    const pf = q.no === 1 && q.wt === 2 ? safe(() => pbDecode(q.b!)) : undefined;
    if (!pf || !varintsOnly(pf) || pf.some((x) => x.no > 2 || x.v > 255)) return false;
  }
  const s = safe(() => pbDecode(st[0].b!));
  if (!s || !varintsOnly(s) || s.some((x) => x.no > 4)) return false;
  return isBool(getV(s, 1)) && isBool(getV(s, 2)) && isBool(getV(s, 3)) && (getV(s, 4) ?? 0) <= 100;
}
function okMappingPayload(p: Uint8Array): boolean {
  if (!p.length) return true;
  const rows = safe(() => pbDecode(p));
  if (!rows || rows.length !== ROWS) return false;
  return rows.every((r) => {
    if (r.no !== 1 || r.wt !== 2) return false;
    const fs = safe(() => pbDecode(r.b!));
    return !!fs && fs.length === 1 && fs[0].no === 1 && fs[0].wt === 2 && fs[0].b!.length === COLS;
  });
}
const okCode = (v: number | undefined) => v !== undefined && v <= 0xff;
function okAkcEntry(b: Uint8Array): boolean {
  const fs = safe(() => pbDecode(b));
  if (!fs) return false;
  const kinds = fs.filter((f) => f.no >= 1 && f.no <= 5);
  if (kinds.length !== 1 || kinds[0].wt !== 2) return false;
  if (!fs.every((f) => (f.no >= 1 && f.no <= 5) || ((f.no === 8 || f.no === 9) && f.wt === 0))) return false;
  if (!validMid(getV(fs, 8) ?? -1) || (getV(fs, 9) ?? 0) >= LAYERS) return false;
  const s = safe(() => pbDecode(kinds[0].b!));
  if (!s) return false;
  switch (kinds[0].no) {
    case 1: {
      const codes = s.find((f) => f.no === 1);
      const pts = s.find((f) => f.no === 2);
      const sec = getV(s, 3);
      return s.every((f) => f.no <= 3) && codes?.wt === 2 && codes.b!.length === 4 && pts?.wt === 2 && pts.b!.length === 4 && (sec === undefined || inRange(sec, ACT_MIN, ACT_MAX));
    }
    case 2:
      return varintsOnly(s) && s.every((f) => f.no <= 4) && okCode(getV(s, 1)) && okCode(getV(s, 2)) && (getV(s, 3) ?? 0) <= 5000 && (getV(s, 4) ?? 0) <= 3;
    case 3:
      return varintsOnly(s) && s.length === 1 && s[0].no === 1 && okCode(s[0].v);
    case 4:
    case 5:
      return varintsOnly(s) && s.every((f) => f.no <= (kinds[0].no === 5 ? 3 : 2)) && validMid(getV(s, 1) ?? -1) && (getV(s, 2) ?? 0) <= 4 && isBool(getV(s, 3));
  }
  return false;
}
function okAkcPayload(p: Uint8Array): boolean {
  const fs = safe(() => pbDecode(p));
  if (!fs) return false;
  const entries = fs.filter((f) => f.no === 1);
  if (entries.length > AKC_MAX) return false;
  if (!fs.every((f) => (f.no === 1 && f.wt === 2) || ((f.no === 2 || f.no === 3) && f.wt === 0))) return false;
  if (getV(fs, 3) !== undefined && getV(fs, 3) !== entries.length) return false;
  return entries.every((e) => okAkcEntry(e.b!));
}
function okGlobalPayload(p: Uint8Array): boolean {
  const fs = safe(() => pbDecode(p));
  if (!fs || !fs.every((f) => (f.no === 1 && f.wt === 2) || ((f.no === 2 || f.no === 3) && f.wt === 0 && isBool(f.v)))) return false;
  const pw = bytesOf(fs, 1);
  const pf = pw ? safe(() => pbDecode(pw)) : [];
  return !!pf && varintsOnly(pf) && pf.every((f) => f.no <= 2 && f.v <= 255);
}
/** DeviceConfig body: byte 0 only the USB-speed / 6KRO bits, 1..4 zero, 5 layout, 6 only the gamepad bits */
export function okConfigBody(b: ArrayLike<number>): boolean {
  if (b.length !== 7) return false;
  return (b[0] & ~(CFG.usbFull | CFG.sixKro)) === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[4] === 0 && b[5] <= 4 && (b[6] & ~(CFG.gpClassic | CFG.gpOff | CFG.gp1000)) === 0;
}

/** Output report data (after the report id): D1 DA type flags lenLo lenHi payload, zero padded. */
export function allowedReport(id: number, d: ArrayLike<number>): boolean {
  if (SIZE_OF.get(id) !== d.length || d[0] !== MAGIC0 || d[1] !== MAGIC1) return false;
  const type = d[2];
  const flags = d[3];
  const zeroFrom = (n: number) => {
    for (let i = n; i < d.length; i++) if (d[i] !== 0) return false;
    // the smallest report that fits, like Wootility
    return REPORT_SIZES.find(([, s]) => s >= n)?.[0] === id;
  };
  // DeviceConfig: D1 DA 07 <7 bytes>, no flags or length
  if (type === REPORT.deviceConfig) return zeroFrom(10) && okConfigBody(Array.from(d).slice(3, 10));
  const profileFlags = flags === 0 || ((flags & 1) === 1 && flags >> 1 < SLOTS);
  // key mapping: D1 DA 14 flags layer 0 0 lenLo lenHi payload
  if (type === REPORT.mapping) {
    const len = d[7] | (d[8] << 8);
    if (9 + len > d.length || d[4] >= LAYERS || d[5] !== 0 || d[6] !== 0 || !zeroFrom(9 + len)) return false;
    return profileFlags && okMappingPayload(Uint8Array.from(Array.from(d).slice(9, 9 + len)));
  }
  const len = d[4] | (d[5] << 8);
  if (6 + len > d.length || !zeroFrom(6 + len)) return false;
  const p = Uint8Array.from(Array.from(d).slice(6, 6 + len));
  switch (type) {
    case REPORT.keyboardProfile:
      return profileFlags && okKbPayload(p);
    case REPORT.perKey:
      return profileFlags && okPerKeyPayload(p);
    case REPORT.rtKeys:
      return profileFlags && okRtPayload(p);
    case REPORT.gamepadMapping:
      return profileFlags && okGpMapPayload(p);
    case REPORT.gamepadProfile:
      return profileFlags && okGpProfilePayload(p);
    case REPORT.rgbCore:
      return flags === 0 && okCorePayload(p);
    case REPORT.colors1:
    case REPORT.colors2:
      return flags === 0 && okColorsPayload(p);
    case REPORT.akc:
      return flags === 0 && okAkcPayload(p);
    case REPORT.global:
      return flags === FLAGS_GLOBAL && okGlobalPayload(p);
    default:
      return false;
  }
}

function fit(need: number): [number, number] {
  const f = REPORT_SIZES.find(([, s]) => s >= need);
  if (!f) throw protoError('settings too large for one report');
  return f;
}
/** Frame an output report: [report id, data]. */
export function frameReport(type: number, flags: number, payload: Uint8Array): [number, Uint8Array<ArrayBuffer>] {
  const [id, size] = fit(6 + payload.length);
  const d = new Uint8Array(size);
  d.set([MAGIC0, MAGIC1, type, flags, payload.length & 0xff, payload.length >> 8]);
  d.set(payload, 6);
  return [id, d];
}
/** the key-mapping report has the layer and two zero bytes before the length */
export function frameMapping(flags: number, layer: number, payload: Uint8Array): [number, Uint8Array<ArrayBuffer>] {
  const [id, size] = fit(9 + payload.length);
  const d = new Uint8Array(size);
  d.set([MAGIC0, MAGIC1, REPORT.mapping, flags, layer, 0, 0, payload.length & 0xff, payload.length >> 8]);
  d.set(payload, 9);
  return [id, d];
}
/** DeviceConfig: D1 DA 07 <7 bytes> (an extra byte would shift every flag) */
export function frameConfig(body: number[]): [number, Uint8Array<ArrayBuffer>] {
  if (body.length !== 7) throw protoError('device config must be 7 bytes');
  const [id, size] = fit(10);
  const d = new Uint8Array(size);
  d.set([MAGIC0, MAGIC1, REPORT.deviceConfig, ...body]);
  return [id, d];
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

  /** set by a DeviceConfig write: the next command may be the SoftReset that applies it */
  private resetArmed = false;

  /** Feature command; resolves with the matching answer. One at a time. */
  cmd(cmd: number, slot = 0, trace?: string[], layer = 0): Promise<Reply> {
    const data = Uint8Array.from([MAGIC0, MAGIC1, cmd, slot, 0, layer, 0]);
    const reset = this.resetArmed && cmd === CMD.softReset;
    this.resetArmed = false;
    if (!allowedCommand(data, reset)) return Promise.reject(new Error(`command ${cmd} is blocked`));
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
    return this.send(...frameReport(type, flags, payload));
  }

  /** A framed output report, checked against the allowlist. */
  send(id: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!allowedReport(id, data)) return Promise.reject(new Error(`report ${hex2(data[2])} is blocked`));
    const run = async () => {
      if (!this.dev.opened) await this.dev.open();
      await this.dev.sendReport(id, data);
      await sleep(15);
      if (data[2] === REPORT.deviceConfig) this.resetArmed = true;
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
  /** GetDeviceConfig answer */
  cfg?: Uint8Array;
  /** key mapping per layer as stored (null = factory mapping) */
  maps?: (number[][] | null)[];
  gpMap?: GpMap;
  gpProf?: GpProfile;
  akc?: Akc;
  /** colour rows 0..5, RGB565 per matrix column */
  colors?: number[][];
  globalRaw?: Uint8Array;
}

const text = (key: string, label: string, t: string): Setting => ({ key, label, group: 'Info', value: { kind: 'text', text: t } });
const P = 'Performance';
const G = 'Gamepad';
const L = 'Lighting';
const RESTART = 'The keyboard restarts to apply this. If it comes back as a new device, press Connect and pick it again. Continue?';
/** Mod-Tap hold time shown when the entry has none (the firmware then uses its own) */
export const MT_DEFAULT = 200;
type Keymap = Extract<Value, { kind: 'keymap' }>;
type PerKeyChoiceV = Extract<Value, { kind: 'perKeyChoice' }>;
type Curve = Extract<Value, { kind: 'gamepadCurve' }>;
type Adv = Extract<Value, { kind: 'advancedKeys' }>;
type SocdV = Extract<Value, { kind: 'socd' }>;

const posOf = (caps: KeyCap[], m: number) => caps.findIndex((k) => cellsOf(k).includes(m));
const cellRows = (rows: number[][], m: number) => rows[m >> 5]?.[m & 0x1f];
const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** the board's key map for the UI: layers 0..2, plus Fn layer 3 once it is used */
export function keymapView(maps: (number[][] | null)[], caps: KeyCap[]): Keymap {
  const rows = maps.map((m, l) => m ?? defaultMapping(l));
  const fn3 = !!maps[3] || rows.some((r) => r.some((row) => row.includes(0xeb)));
  const shown = rows.slice(0, fn3 ? 4 : 3);
  const unknown = new Map<number, number>();
  const layers = shown.map((r) =>
    caps.map((k) => {
      const w = cellRows(r, k.index) ?? W_NONE;
      const q = wootToQmk(w);
      if ((q & 0xff00) === WT_BASE && !OWN_W.has(w)) unknown.set(q, w);
      return q;
    }),
  );
  const extra: ExtraCategory[] = [{ id: 'wooting', name: 'Wooting', codes: W_OWN.map(([w, id, label, name]) => ({ code: WT_BASE | w, id: `WT_${id}`, label, name })) }];
  if (unknown.size) extra.push({ id: 'kept', name: 'Kept as is', hidden: true, codes: [...unknown].map(([code, w]) => ({ code, id: `WT_RAW_${hex2(w)}`, label: hex2(w), name: `Wooting key 0x${hex2(w)} (kept as is)` })) });
  return { kind: 'keymap', keys: caps, layers, codes: 'qmk-v2', extra, cats: ['basic', 'mods', 'nav', 'fkeys', 'numpad', 'media'] };
}

const hidOf = (w: number) => (w === W_NONE ? 0 : wootToHid(w));
interface AdvView {
  entries: AdvancedKey[];
  src: Map<number, AkcItem>;
  unavailable: number[];
}
/** Mod-Tap / Toggle / DKS on the main layer, as the generic value; everything else is kept as it is */
export function advView(akc: Akc, caps: KeyCap[]): AdvView {
  const entries: AdvancedKey[] = [];
  const src = new Map<number, AkcItem>();
  const un = new Set<number>();
  for (const it of akc.items) {
    if (it.layer !== 0) continue;
    const p = posOf(caps, it.key);
    if (p < 0) continue;
    if (it.kind === 'rappy' || it.kind === 'socd') {
      un.add(p);
      const q = posOf(caps, it.other!);
      if (q >= 0) un.add(q);
      continue;
    }
    let e: AdvancedKey | undefined;
    if (it.kind === 'mt') {
      const tap = hidOf(it.tap!);
      const hold = hidOf(it.hold!);
      if (tap !== undefined && hold !== undefined) e = { key: p, mode: 'mt', tap, hold, delay: it.duration ?? MT_DEFAULT };
    } else if (it.kind === 'tgl') {
      const kc = hidOf(it.code!);
      if (kc !== undefined) e = { key: p, mode: 'tgl', kc, delay: 200 };
    } else if (it.kind === 'dks') {
      const masks = dksMasks(it.points!);
      const kcs = it.codes!.map(hidOf);
      if (kcs.every((k) => k !== undefined)) e = { key: p, mode: 'dks', actions: kcs.map((kc, a) => ({ kc: kc!, mask: kc ? masks[a] : 0 })) };
    }
    if (e && !src.has(p)) {
      entries.push(e);
      src.set(p, it);
    } else un.add(p);
  }
  return { entries, src, unavailable: [...un].sort((a, b) => a - b) };
}

interface SocdView {
  entries: SocdEntry[];
  src: Map<string, AkcItem>;
  unavailable: number[];
}
/** Snappy Tappy (SOCD) and Rappy Snappy pairs on the main layer */
export function socdView(akc: Akc, caps: KeyCap[]): SocdView {
  const entries: SocdEntry[] = [];
  const src = new Map<string, AkcItem>();
  const un = new Set<number>();
  for (const it of akc.items) {
    if (it.layer !== 0) continue;
    const p = posOf(caps, it.key);
    if (it.kind !== 'rappy' && it.kind !== 'socd') {
      if (p >= 0) un.add(p);
      continue;
    }
    const q = posOf(caps, it.other!);
    if (p < 0 || q < 0 || src.has(`${p},${q}`)) {
      if (p >= 0) un.add(p);
      if (q >= 0) un.add(q);
      continue;
    }
    entries.push({ keys: [p, q], mode: it.kind === 'rappy' ? RAPPY : it.socd! });
    src.set(`${p},${q}`, it);
  }
  return { entries, src, unavailable: [...un].sort((a, b) => a - b) };
}

/** AnalogValues { repeated Row { bytes values = 1 } rows = 1 } */
export function parseAnalog(b: Uint8Array): number[][] {
  return pbDecode(b).filter((f) => f.no === 1 && f.wt === 2).map((r) => Array.from(bytesOf(pbDecode(r.b!), 1) ?? []));
}

export class WootingDriver implements Driver {
  readonly id: string;
  readonly family = 'Wooting';
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  private readonly link: Link;
  private readonly m: Model;
  private st: State | null = null;
  /** set once a DeviceConfig write made the keyboard restart */
  private restarting = false;
  /** the board picture (60% boards only) */
  readonly layout?: () => KeyCap[];
  readonly travelTest?: (onSample: (pos: number, mm: number) => void) => Promise<() => Promise<void>>;

  constructor(
    private readonly device: HIDDevice,
    o: WootingOptions = {},
  ) {
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.m = modelOf(device.productId) ?? { pid: device.productId, name: 'keyboard' };
    this.link = new Link(device, o.timeoutMs ?? 1500);
    if (this.m.sixty) {
      this.layout = () => this.st?.caps ?? SIXTY_ANSI;
      this.travelTest = (cb) => this.runTravel(cb);
    }
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

  private async ok(cmd: number, slot = 0, layer = 0): Promise<Uint8Array> {
    const r = await this.link.cmd(cmd, slot, undefined, layer);
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
    if (this.restarting) throw new Error('The keyboard is restarting to apply the new setting. Press Connect once it is back.');
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
    // the rest is optional: a part that doesn't read cleanly is simply not offered
    const gpMapRaw = await this.ok(CMD.getGamepadMapping, slot).catch(() => undefined);
    const gpMap = gpMapRaw ? safe(() => parseGpMap(gpMapRaw)) : undefined;
    const gpProfRaw = await this.ok(CMD.getGamepadProfile, slot).catch(() => undefined);
    const gpProf = gpProfRaw && okGpProfilePayload(gpProfRaw) ? safe(() => parseGpProfile(gpProfRaw)) : undefined;
    let maps: (number[][] | null)[] | undefined;
    let akc: Akc | undefined;
    if (caps) {
      maps = [];
      for (let l = 0; l < LAYERS && maps; l++) {
        const r = await this.link.cmd(CMD.getMappingProfile, slot, undefined, l).catch(() => undefined);
        const m = r && r.status === STATUS_OK ? safe(() => parseMapping(r.body)) : undefined;
        if (m === undefined) maps = undefined;
        else maps.push(m);
      }
      const akcRaw = await this.ok(CMD.getAkcProfile, slot).catch(() => undefined);
      akc = akcRaw && (!akcRaw.length || okAkcPayload(akcRaw)) ? safe(() => parseAkc(akcRaw)) : undefined;
    }
    const c1 = await this.ok(CMD.getRgbColors1, slot).catch(() => undefined);
    const c2 = c1 ? await this.ok(CMD.getRgbColors2, slot).catch(() => undefined) : undefined;
    const colors = c1 && c2 ? safe(() => [...parseRows(c1), ...parseRows(c2)]) : undefined;
    const globalRaw = await this.ok(CMD.getGlobalSettings).catch(() => undefined);
    this.st = { slot, fw, writable, kbTop, base, kb, rtRaw, groups, perKey, coreRaw, caps, cfg, maps, gpMap, gpProf, akc, colors: colors?.length === ROWS ? colors : undefined, globalRaw };
    const st = this.st;

    // ---- device config: polling, rollover, controller
    const cfgOk = !!cfg && cfg.length >= 7 && okConfigBody(configBody(cfg));
    let gpMode = 0;
    if (cfg && cfg.length >= 7) {
      gpMode = cfg[6] & CFG.gpOff ? 2 : cfg[6] & CFG.gpClassic ? 1 : 0;
      out.push(text('kb_layout', 'Layout', LAYOUT_NAMES[cfg[5]] ?? `#${cfg[5]}`));
      if (cfgOk && this.m.eightK)
        out.push({ key: 'polling', label: 'Polling rate', group: P, value: { kind: 'choice', options: [['8000 Hz', 0], ['1000 Hz', 1]], current: cfg[0] & CFG.usbFull ? 1 : 0 }, confirm: RESTART });
      else out.push(text('usb_speed', 'USB polling', cfg[0] & CFG.usbFull ? '1000 Hz' : this.m.eightK ? '8000 Hz' : '1000 Hz'));
      if (cfgOk)
        out.push({ key: 'nkro', label: 'Key rollover', group: 'Settings', value: { kind: 'choice', options: [['NKRO', 0], ['6KRO (compatibility mode)', 1]], current: cfg[0] & CFG.sixKro ? 1 : 0 }, hint: '6KRO helps with old BIOS screens and some KVM switches', confirm: RESTART });
      else out.push(text('nkro_t', 'Key rollover', cfg[0] & CFG.sixKro ? '6KRO' : 'NKRO'));
      if (cfgOk) {
        out.push({ key: 'gp_mode', label: 'Controller', group: G, value: { kind: 'choice', options: [['Xbox controller', 0], ['Classic joystick', 1], ['Off', 2]], current: gpMode }, hint: 'Off: the keyboard is only a keyboard', confirm: RESTART });
        out.push({ key: 'gp_rate', label: 'Controller polling', group: G, value: { kind: 'choice', options: [['250 Hz', 0], ['1000 Hz', 1]], current: cfg[6] & CFG.gp1000 ? 1 : 0 }, confirm: RESTART });
      } else out.push(text('gamepad', 'Gamepad mode', GAMEPAD_NAMES[gpMode] ?? '?'));
    }

    // ---- actuation and Rapid Trigger
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

    // ---- keys: remap, advanced keys, Snappy Tappy
    if (caps && maps) out.push({ key: 'keymap', label: 'Key map', group: 'Keys', value: keymapView(maps, caps) });
    if (caps && akc) {
      const av = advView(akc, caps);
      const sv = socdView(akc, caps);
      out.push({
        key: 'advanced_keys',
        label: 'Advanced keys',
        group: 'Keys',
        value: { kind: 'advancedKeys', keys: caps, modes: ['dks', 'mt', 'tgl'], unavailable: av.unavailable, mt: { min: 100, max: 1000, step: 10, default: MT_DEFAULT }, tgl: { min: 200, max: 200, step: 10, default: 200 }, dks: { actions: 4, points: 7 }, entries: av.entries },
      });
      out.push({ key: 'socd', label: 'Snappy Tappy', group: 'SOCD', value: { kind: 'socd', mode: 'pairs', keys: caps, max: AKC_MAX, modes: SOCD_MODES, unavailable: sv.unavailable, entries: sv.entries } });
    }

    // ---- gamepad
    if (kb.keys !== undefined) out.push({ key: 'gp_keys', label: 'Mapped keys still type', group: G, value: { kind: 'toggle', on: kb.keys }, hint: '"Enable keyboard keys" in Wootility' });
    if (gpMap && caps) {
      out.push({ key: 'gp_override', label: 'Mapped keys only act as controller', group: G, value: { kind: 'toggle', on: gpMap.override }, hint: '"Gamepad mapping override" in Wootility' });
      const table = gpMode === 1 ? GP_CLASSIC : GP_XBOX;
      const values = caps.map((k) => cellsOf(k).map((m) => gpMap.keys.get(m)).find((c) => c !== undefined) ?? 0);
      const options: [string, number][] = [['None', 0], ...table.map(([c, l]) => [l, c] as [string, number])];
      for (const v of values) if (v && !options.some((o) => o[1] === v)) options.push([`Button 0x${hex2(v)}`, v]);
      out.push({ key: 'gp_map', label: 'Gamepad mapping', group: G, value: { kind: 'perKeyChoice', keys: caps, options, none: 0, values } });
    }
    if (gpProf && gpProf.points.length === 4) {
      out.push({
        key: 'gp_curve',
        label: 'Analog curve',
        group: G,
        value: {
          kind: 'gamepadCurve',
          points: gpProf.points.map((p) => ({ x: curveXToMm(p.x), y: p.y })),
          maxX: ACT_MAX,
          stepX: 0.01,
          maxY: 255,
          presets: GP_PRESETS.map((p) => ({ name: p.name, points: p.points.map(([x, y]) => ({ x: curveXToMm(x), y })) })),
        },
      });
      out.push({ key: 'gp_angle_en', label: 'Stick angle adjustment', group: G, value: { kind: 'toggle', on: gpProf.angleOn } });
      out.push({ key: 'gp_angle_deg', label: 'Stick diagonal angle', group: G, value: { kind: 'number', min: 0, max: 90, current: Math.round(gpProf.angle * 0.9), unit: '°' }, hint: '45° is the default' });
      out.push({ key: 'gp_square_all', label: 'Square stick output', group: G, value: { kind: 'toggle', on: gpProf.square }, hint: 'Full output on diagonals instead of a round gate' });
      out.push({ key: 'gp_extreme_snappy', label: 'Snappy joystick', group: G, value: { kind: 'toggle', on: gpProf.snappy }, hint: 'Opposite directions: the deeper press wins instead of adding up' });
    }

    // ---- lighting
    if (coreRaw) {
      const bri = coreBrightness(coreRaw);
      if (bri !== undefined) out.push({ key: 'light_bri', label: 'Brightness', group: L, value: { kind: 'number', min: 0, max: 100, current: Math.round((bri * 100) / 255), unit: '%' } });
      const layers = safe(() => coreLayers(coreRaw));
      if (layers) {
        const cur = layers.length ? effectKind(layers[0]) : 0;
        const options: [string, number][] = [['Static', 0], ...EFFECTS.map(([n, name]) => [name, n] as [string, number])];
        if (!options.some((o) => o[1] === cur)) options.push([EFFECT_NAMES[cur] ?? `Effect ${cur}`, cur]);
        out.push({ key: 'light_mode', label: 'Effect', group: L, value: { kind: 'choice', options, current: cur } });
      }
    }
    if (st.colors) {
      const all = (caps ?? []).map((k) => from565(cellRows(st.colors!, k.index) ?? 0));
      if (caps) out.push({ key: 'per_key_color', label: 'Key colours', group: L, value: { kind: 'perKeyColor', keys: caps, colors: all } });
      const flat = st.colors.flat();
      out.push({ key: 'light_color', label: 'Colour', group: L, value: { kind: 'color', rgb: from565(modeOf(flat, flat[0] ?? 0)) } });
    }

    // ---- device-wide settings
    const g = globalRaw && okGlobalPayload(globalRaw) ? safe(() => parseGlobal(globalRaw)) : undefined;
    if (g) {
      out.push({ key: 'numlock_inv', label: 'Inverted Num Lock', group: 'Settings', value: { kind: 'toggle', on: g.numlock } });
      out.push({ key: 'debounce', label: 'Debounce filter', group: 'Settings', value: { kind: 'toggle', on: g.debounce }, hint: 'Ignores very short accidental presses' });
      if (g.dim !== undefined) out.push({ key: 'dim_after', label: 'Dim the lights after', group: 'Settings', value: { kind: 'number', min: Math.min(1, g.dim), max: 60, current: g.dim, unit: 'min' } });
      if (g.off !== undefined) out.push({ key: 'off_after', label: 'Turn the lights off after', group: 'Settings', value: { kind: 'number', min: Math.min(1, g.off), max: 60, current: g.off, unit: 'min' } });
    }
    if (!writable) out.push(text('unsupported', 'Note', 'Update the firmware in Wootility (2.13 or newer) to change settings here.'));
    return out;
  }

  async write(s: Setting): Promise<void> {
    if (this.restarting) throw new Error('The keyboard is restarting to apply the new setting. Press Connect once it is back.');
    const st = this.st;
    if (!st) throw new Error('press Re-read first');
    if (!st.writable) throw new Error('Update the firmware in Wootility (2.13 or newer) to change settings here.');
    const v: Value = s.value;
    const bad = () => new Error('bad value');
    const want = <K extends Value['kind']>(k: K) => {
      if (v.kind !== k) throw bad();
      return v as Extract<Value, { kind: K }>;
    };
    // the active profile may have been switched on the keyboard itself: never write into another slot
    if ((await this.readSlot()) !== st.slot) throw new Error('The active profile changed on the keyboard - press Re-read.');
    switch (s.key) {
      case 'profile':
        return this.switchProfile(want('choice').current);
      case 'light_bri': {
        const n = want('number').current;
        if (n < 0 || n > 100) throw bad();
        const bri = Math.round((n * 255) / 100);
        return this.writeCore(withBrightness(st.coreRaw!, bri), (got) => coreBrightness(got) === bri);
      }
      case 'light_mode':
        return this.writeEffect(want('choice').current);
      case 'per_key_color':
        return this.writeKeyColors(want('perKeyColor'));
      case 'light_color': {
        const c = to565(want('color').rgb);
        if (!st.colors) throw new Error('no lighting colours');
        return this.writeColors(st.colors.map((r) => r.map(() => c)));
      }
      case 'per_key_trigger':
        return this.writePerKey(want('perKeyTrigger'));
      case 'keymap':
        return this.writeKeymap(want('keymap'));
      case 'advanced_keys':
        return this.writeAdv(want('advancedKeys'));
      case 'socd':
        return this.writeSocd(want('socd'));
      case 'polling':
        return this.writeConfig((b) => (b[0] = want('choice').current ? b[0] | CFG.usbFull : b[0] & ~CFG.usbFull));
      case 'nkro':
        return this.writeConfig((b) => (b[0] = want('choice').current ? b[0] | CFG.sixKro : b[0] & ~CFG.sixKro));
      case 'gp_mode': {
        const m = want('choice').current;
        if (m !== 0 && m !== 1 && m !== 2) throw bad();
        return this.writeConfig((b) => (b[6] = (b[6] & ~(CFG.gpClassic | CFG.gpOff)) | (m === 1 ? CFG.gpClassic : m === 2 ? CFG.gpOff : 0)));
      }
      case 'gp_rate':
        return this.writeConfig((b) => (b[6] = want('choice').current ? b[6] | CFG.gp1000 : b[6] & ~CFG.gp1000));
      case 'gp_override': {
        if (!st.gpMap) throw new Error('no gamepad mapping');
        return this.writeGpMap({ keys: st.gpMap.keys, override: want('toggle').on });
      }
      case 'gp_map':
        return this.writeGpKeys(want('perKeyChoice'));
      case 'gp_curve':
        return this.writeGpCurve(want('gamepadCurve'));
      case 'gp_angle_en':
        return this.writeGpProf((p) => (p.angleOn = want('toggle').on));
      case 'gp_angle_deg': {
        const deg = want('number').current;
        if (deg < 0 || deg > 90) throw bad();
        return this.writeGpProf((p) => (p.angle = clamp(Math.round(deg / 0.9), 0, 100)));
      }
      case 'gp_square_all':
        return this.writeGpProf((p) => (p.square = want('toggle').on));
      case 'gp_extreme_snappy':
        return this.writeGpProf((p) => (p.snappy = want('toggle').on));
      case 'numlock_inv':
        return this.writeGlobal((g) => (g.numlock = want('toggle').on));
      case 'debounce':
        return this.writeGlobal((g) => (g.debounce = want('toggle').on));
      case 'dim_after':
      case 'off_after': {
        const n = want('number').current;
        if (!Number.isInteger(n) || n < 0 || n > 60) throw bad();
        return this.writeGlobal((g) => (s.key === 'dim_after' ? (g.dim = n) : (g.off = n)));
      }
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
    } else if (s.key === 'gp_keys' && v.kind === 'toggle') {
      if (kb.keys === undefined) throw new Error('this keyboard has no such setting');
      kb.keys = v.on;
    } else throw new Error(`unknown setting ${s.key}`);
    await this.writeProfile(kb, st.groups);
  }

  // ---------------------------------------------------------------- new writes

  /** DeviceConfig, then SoftReset: the keyboard restarts (and may come back with another USB id). */
  private async writeConfig(change: (b: number[]) => void): Promise<void> {
    const st = this.st!;
    if (!st.cfg) throw new Error('no device settings');
    const body = configBody(st.cfg);
    const before = body.join();
    change(body);
    if (body.join() === before) return;
    if (!okConfigBody(body)) throw new Error("this setting can't be changed here");
    await this.link.send(...frameConfig(body));
    this.restarting = true;
    // the keyboard drops off USB while it resets, so an answer may never come
    await this.link.cmd(CMD.softReset).catch(() => undefined);
  }

  private async writeGpMap(m: GpMap): Promise<void> {
    const st = this.st!;
    const payload = encodeGpMap(m);
    for (const flags of [0, flagsFor(st.slot)]) await this.link.report(REPORT.gamepadMapping, flags, payload);
    await this.verify(async () => {
      const got = parseGpMap(await this.ok(CMD.getGamepadMapping, st.slot));
      const same = got.override === m.override && got.keys.size === m.keys.size && [...m.keys].every(([k, c]) => got.keys.get(k) === c);
      if (same) st.gpMap = got;
      return same;
    }, "the keyboard didn't keep the gamepad mapping");
  }

  private async writeGpKeys(v: PerKeyChoiceV): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.gpMap) throw new Error('no gamepad mapping');
    if (v.values.length !== caps.length) throw new Error("gamepad mapping doesn't match the keyboard - press Re-read");
    const keys = new Map(st.gpMap.keys);
    let changed = false;
    caps.forEach((k, i) => {
      const cur = cellsOf(k).map((m) => keys.get(m)).find((c) => c !== undefined) ?? 0;
      const nv = v.values[i];
      if (nv === cur) return;
      if (nv !== 0 && (!Number.isInteger(nv) || nv < GP_MIN || nv > GP_MAX)) throw new Error(`${k.label}: unknown controller button`);
      for (const m of cellsOf(k)) keys.delete(m);
      if (nv) keys.set(k.index, nv);
      changed = true;
    });
    if (changed) await this.writeGpMap({ keys, override: st.gpMap.override });
  }

  private async writeGpProf(change: (p: GpProfile) => void): Promise<void> {
    const st = this.st!;
    if (!st.gpProf) throw new Error('no gamepad settings');
    const p: GpProfile = { ...st.gpProf, points: st.gpProf.points.map((q) => ({ ...q })) };
    change(p);
    const payload = encodeGpProfile(p);
    for (const flags of [0, flagsFor(st.slot)]) await this.link.report(REPORT.gamepadProfile, flags, payload);
    await this.verify(async () => {
      const got = parseGpProfile(await this.ok(CMD.getGamepadProfile, st.slot));
      const same = jsonEq(got.points, p.points) && got.angleOn === p.angleOn && got.square === p.square && got.snappy === p.snappy && got.angle === p.angle;
      if (same) st.gpProf = got;
      return same;
    }, "the keyboard didn't keep the gamepad settings");
  }

  private writeGpCurve(v: Curve): Promise<void> {
    if (v.points.length !== 4) throw new Error('the curve needs 4 points');
    let last = 0;
    const pts = v.points.map((q) => {
      const x = Math.max(last, curveMmToX(q.x));
      last = x;
      return { x, y: clamp(Math.round(q.y), 0, 255) };
    });
    return this.writeGpProf((p) => (p.points = pts));
  }

  private async writeKeymap(v: Keymap): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.maps) throw new Error('no key map');
    const view = keymapView(st.maps, caps);
    if (v.layers.length !== view.layers.length || v.layers.some((l) => l.length !== caps.length)) throw new Error("key map doesn't match the keyboard - press Re-read");
    for (let l = 0; l < v.layers.length; l++) {
      const rows = (st.maps[l] ?? defaultMapping(l)).map((r) => r.slice());
      let changed = false;
      v.layers[l].forEach((code, i) => {
        if (code === view.layers[l][i]) return;
        const w = qmkToWoot(code);
        const name = `${caps[i].label}${l ? ` (Fn layer ${l})` : ''}`;
        if (w === undefined) throw new Error(`${name}: this keyboard can't send that key`);
        for (const m of cellsOf(caps[i])) rows[m >> 5][m & 0x1f] = w;
        changed = true;
      });
      if (!changed) continue;
      const had = (st.maps[l] ?? defaultMapping(l)).some((r) => r.includes(W_FN1));
      if (l === 0 && had && !rows.some((r) => r.includes(W_FN1))) throw new Error('Keep an Fn key on the main layer, or the Fn layers become unreachable.');
      const payload = encodeMapping(rows);
      for (const flags of [0, flagsFor(st.slot)]) await this.link.send(...frameMapping(flags, l, payload));
      await this.verify(async () => {
        const got = parseMapping(await this.ok(CMD.getMappingProfile, st.slot, l));
        const same = jsonEq(got, rows);
        if (same) st.maps![l] = got;
        return same;
      }, "the keyboard didn't keep the key map");
    }
  }

  private toHidW(kc: number, name: string): number {
    if (!kc) return W_NONE;
    const w = hidToWoot(kc);
    if (w === undefined) throw new Error(`${name}: this keyboard can't use that key here`);
    return w;
  }

  private async writeAdv(v: Adv): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.akc) throw new Error('no advanced keys');
    const view = advView(st.akc, caps);
    const used = new Set(view.src.values());
    const out = st.akc.items.filter((i) => !used.has(i)).map((i) => i.raw);
    const seen = new Set<number>();
    for (const e of v.entries) {
      const cap = caps[e.key];
      if (!cap || seen.has(e.key)) throw new Error('bad value');
      seen.add(e.key);
      if (view.unavailable.includes(e.key)) throw new Error(`${cap.label} already has another function`);
      const orig = view.src.get(e.key);
      const origUi = view.entries.find((x) => x.key === e.key);
      if (orig && origUi && jsonEq(origUi, e)) {
        out.push(orig.raw);
        continue;
      }
      const it: AkcItem = { raw: new Uint8Array(0), kind: e.mode, key: cap.index, layer: 0 };
      if (e.mode === 'mt') {
        it.tap = this.toHidW(e.tap, cap.label);
        it.hold = this.toHidW(e.hold, cap.label);
        if (!Number.isInteger(e.delay) || e.delay < 1 || e.delay > 5000) throw new Error('bad value');
        it.duration = e.delay === MT_DEFAULT && !(orig?.kind === 'mt' && orig.duration) ? undefined : e.delay;
        if (orig?.kind === 'mt') it.jit = orig.jit;
      } else if (e.mode === 'tgl') it.code = this.toHidW(e.kc, cap.label);
      else {
        const acts = Array.from({ length: 4 }, (_, a) => e.actions[a] ?? { kc: 0, mask: 0 });
        if (e.actions.length > 4) throw new Error('DKS has 4 keys at most');
        it.codes = acts.map((a) => this.toHidW(a.kc, cap.label));
        it.points = dksPoints(acts.map((a) => (a.kc ? a.mask : 0)));
        if (orig?.kind === 'dks') it.secondary = orig.secondary;
      }
      out.push(encodeAkcItem(it));
    }
    await this.writeAkc(out);
  }

  private async writeSocd(v: SocdV): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.akc) throw new Error('no Snappy Tappy');
    const view = socdView(st.akc, caps);
    const used = new Set(view.src.values());
    const out = st.akc.items.filter((i) => !used.has(i)).map((i) => i.raw);
    const seen = new Set<number>();
    for (const e of v.entries) {
      if (e.keys.length !== 2) throw new Error('Snappy Tappy works on two keys');
      const [p, q] = e.keys;
      if (!caps[p] || !caps[q] || p === q || seen.has(p) || seen.has(q)) throw new Error('bad value');
      seen.add(p).add(q);
      for (const x of [p, q]) if (view.unavailable.includes(x)) throw new Error(`${caps[x].label} already has another function`);
      if (!SOCD_MODES.some(([, m]) => m === e.mode)) throw new Error('bad value');
      const orig = view.src.get(`${p},${q}`);
      const origMode = orig ? (orig.kind === 'rappy' ? RAPPY : orig.socd) : undefined;
      if (orig && origMode === e.mode) {
        out.push(orig.raw);
        continue;
      }
      const rappy = e.mode === RAPPY;
      const it: AkcItem = { raw: new Uint8Array(0), kind: rappy ? 'rappy' : 'socd', key: caps[p].index, layer: 0, other: caps[q].index, socd: rappy ? (orig?.kind === 'rappy' ? orig.socd! : 0) : e.mode };
      if (!rappy) it.both = orig?.kind === 'socd' ? orig.both : false;
      out.push(encodeAkcItem(it));
    }
    await this.writeAkc(out);
  }

  /** AdvancedKeys to RAM, SaveAkcProfile(active slot), read back. */
  private async writeAkc(items: Uint8Array[]): Promise<void> {
    const st = this.st!;
    if (items.length > AKC_MAX) throw new Error(`Too many advanced keys and Snappy Tappy pairs (${AKC_MAX} at most).`);
    const payload = encodeAkc(items, st.akc!.rest);
    await this.link.report(REPORT.akc, 0, payload);
    const r = await this.link.cmd(CMD.saveAkcProfile, st.slot);
    if (r.status !== STATUS_OK) throw new Error(`the keyboard refused to save the advanced keys (status ${hex2(r.status)})`);
    const canon = (list: AkcItem[]) => list.map((i) => hexs(encodeAkcItem(i))).sort().join('|');
    const want = canon(items.map(parseAkcItem));
    await this.verify(async () => {
      const got = parseAkc(await this.ok(CMD.getAkcProfile, st.slot));
      const same = canon(got.items) === want;
      if (same) st.akc = got;
      return same;
    }, "the keyboard didn't keep the advanced keys");
  }

  /** RgbProfileCore to RAM, SaveRgbProfile(active slot), read back. */
  private async writeCore(core: Uint8Array, check: (got: Uint8Array) => boolean): Promise<void> {
    const st = this.st!;
    if (!st.coreRaw) throw new Error('no lighting settings');
    await this.link.report(REPORT.rgbCore, 0, core);
    // SaveRgbProfile copies the lighting in RAM into the slot (Wootility saveRgbProfile)
    const r = await this.link.cmd(CMD.saveRgbProfile, st.slot);
    if (r.status !== STATUS_OK) throw new Error(`the keyboard refused to save the lighting (status ${hex2(r.status)})`);
    await this.verify(async () => {
      const got = await this.ok(CMD.getRgbProfileCore, st.slot);
      const ok = check(got);
      if (ok) st.coreRaw = got;
      return ok;
    }, "the keyboard didn't keep the lighting");
  }

  private writeEffect(kind: number): Promise<void> {
    const st = this.st!;
    if (!st.coreRaw) throw new Error('no lighting settings');
    const layers = coreLayers(st.coreRaw);
    const cur = layers.length ? effectKind(layers[0]) : 0;
    if (kind === cur) return Promise.resolve();
    if (kind !== 0 && !EFFECTS.some(([n]) => n === kind)) throw new Error('unknown effect');
    const next = kind === 0 ? [] : [effectLayer(kind), ...layers.slice(1)];
    const want = next.map(hexs).join('|');
    return this.writeCore(withLayers(st.coreRaw, next), (got) => coreLayers(got).map(hexs).join('|') === want);
  }

  private writeKeyColors(v: Extract<Value, { kind: 'perKeyColor' }>): Promise<void> {
    const st = this.st!;
    const caps = st.caps;
    if (!caps || !st.colors) throw new Error('no lighting colours');
    if (v.colors.length !== caps.length) throw new Error("colours don't match the keyboard - press Re-read");
    const rows = st.colors.map((r) => r.slice());
    caps.forEach((k, i) => {
      const c = to565(v.colors[i]);
      for (const m of cellsOf(k)) {
        const row = rows[m >> 5];
        while (row.length <= (m & 0x1f)) row.push(0);
        row[m & 0x1f] = c;
      }
    });
    return this.writeColors(rows);
  }

  /** both colour halves to RAM, SaveRgbProfile(active slot), read back */
  private async writeColors(rows: number[][]): Promise<void> {
    const st = this.st!;
    await this.link.report(REPORT.colors1, 0, encodeRows(rows.slice(0, 3)));
    await this.link.report(REPORT.colors2, 0, encodeRows(rows.slice(3, 6)));
    const r = await this.link.cmd(CMD.saveRgbProfile, st.slot);
    if (r.status !== STATUS_OK) throw new Error(`the keyboard refused to save the lighting (status ${hex2(r.status)})`);
    await this.verify(async () => {
      const got = [...parseRows(await this.ok(CMD.getRgbColors1, st.slot)), ...parseRows(await this.ok(CMD.getRgbColors2, st.slot))];
      const same = jsonEq(got, rows);
      if (same) st.colors = got;
      return same;
    }, "the keyboard didn't keep the colours");
  }

  private async writeGlobal(change: (g: Global) => void): Promise<void> {
    const st = this.st!;
    if (!st.globalRaw) throw new Error('no device settings');
    const g = parseGlobal(st.globalRaw);
    change(g);
    await this.link.report(REPORT.global, FLAGS_GLOBAL, encodeGlobal(st.globalRaw, g));
    await this.verify(async () => {
      const got = await this.ok(CMD.getGlobalSettings);
      const same = jsonEq(parseGlobal(got), g);
      if (same) st.globalRaw = got;
      return same;
    }, "the keyboard didn't keep the setting");
  }

  /** live key travel: GetAnalogValues (0..255 over the 4 mm travel), polled until stopped */
  private async runTravel(onSample: (pos: number, mm: number) => void): Promise<() => Promise<void>> {
    const caps = this.st?.caps ?? SIXTY_ANSI;
    const last = new Map<number, number>();
    const emit = (b: Uint8Array) => {
      const rows = parseAnalog(b);
      caps.forEach((k, i) => {
        const v = Math.max(...cellsOf(k).map((m) => cellRows(rows, m) ?? 0));
        const mm = round2((v / 255) * ACT_MAX);
        if (last.get(i) !== mm) {
          last.set(i, mm);
          onSample(i, mm);
        }
      });
    };
    // one read first, so a keyboard that doesn't answer fails here instead of looping
    emit(await this.ok(CMD.getAnalogValues));
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        try {
          emit(await this.ok(CMD.getAnalogValues));
          await sleep(5);
        } catch {
          await sleep(100);
        }
      }
    })();
    return async () => {
      stopped = true;
      await loop;
    };
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
    if (kb.keys !== undefined) b = setField(b, 2, kb.keys ? 1 : 0);
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
        gotKb.strict === kb.strict && gotKb.release === kb.release && gotKb.keys === kb.keys && sameRt(kb, groups, gotKb, gotGroups, st.caps);
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
