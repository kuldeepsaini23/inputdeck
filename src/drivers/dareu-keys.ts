// DAREU TG firmware: key ids, key assignments and their mapping to QMK-v2 keycodes (the
// numbering the keymap UI understands). Pure tables, no I/O. Source: driver.dareu.com/allinone
// (keyboard.js TG_KEY_MAP, device.js FUNCTION_INDEX and the decoders in KeyboardBase,
// subpage/tg/keyfunction.html encoders).

/** Vendor TG_KEY_MAP: key id -> HID keyboard usage (ids 72 and 170..174 have none). */
export const TG_KEY_USAGE: [keyId: number, usage: number][] = [
  [1, 0x29], [2, 0x3a], [3, 0x3b], [4, 0x3c], [5, 0x3d], [6, 0x3e], [7, 0x3f], [8, 0x40], [9, 0x41], [10, 0x42],
  [11, 0x43], [12, 0x44], [13, 0x45], [14, 0x46], [15, 0x47], [16, 0x48], [17, 0x35], [18, 0x1e], [19, 0x1f],
  [20, 0x20], [21, 0x21], [22, 0x22], [23, 0x23], [24, 0x24], [25, 0x25], [26, 0x26], [27, 0x27], [28, 0x2d],
  [29, 0x2e], [30, 0x89], [31, 0x2a], [32, 0x49], [33, 0x4a], [34, 0x4b], [35, 0x53], [36, 0x54], [37, 0x55],
  [38, 0x56], [39, 0x2b], [40, 0x14], [41, 0x1a], [42, 0x08], [43, 0x15], [44, 0x17], [45, 0x1c], [46, 0x18],
  [47, 0x0c], [48, 0x12], [49, 0x13], [50, 0x2f], [51, 0x30], [52, 0x31], [53, 0x4c], [54, 0x4d], [55, 0x4e],
  [56, 0x5f], [57, 0x60], [58, 0x61], [59, 0x57], [60, 0x39], [61, 0x04], [62, 0x16], [63, 0x07], [64, 0x09],
  [65, 0x0a], [66, 0x0b], [67, 0x0d], [68, 0x0e], [69, 0x0f], [70, 0x33], [71, 0x34], [73, 0x28], [74, 0x5c],
  [75, 0x5d], [76, 0x5e], [77, 0x85], [78, 0xe1], [79, 0x64], [80, 0x1d], [81, 0x1b], [82, 0x06], [83, 0x19],
  [84, 0x05], [85, 0x11], [86, 0x10], [87, 0x36], [88, 0x37], [89, 0x38], [90, 0x87], [91, 0xe5], [92, 0x52],
  [93, 0x59], [94, 0x5a], [95, 0x5b], [96, 0x58], [97, 0xe0], [98, 0xe3], [99, 0xe2], [100, 0x91], [101, 0x8b],
  [102, 0x2c], [103, 0x8a], [104, 0x90], [105, 0x88], [106, 0xe6], [107, 0xe7], [108, 0x65], [109, 0xe4],
  [110, 0x50], [111, 0x51], [112, 0x48], [113, 0x35], [114, 0x1e],
];
const USAGE_OF = new Map(TG_KEY_USAGE);
const KEY_OF = new Map<number, number>();
for (const [k, u] of TG_KEY_USAGE) if (!KEY_OF.has(u)) KEY_OF.set(u, k);

/** HID usage of a vendor key id (0 = none / no usage). */
export const usageOfKeyId = (keyId: number) => (keyId === 0 ? 0 : (USAGE_OF.get(keyId) ?? -1));
/** Vendor key id for a HID usage (first in TG_KEY_MAP; 0 for none; -1 when there is none). */
export const keyIdOfUsage = (usage: number) => (usage === 0 ? 0 : (KEY_OF.get(usage) ?? -1));

// ---------------------------------------------------------------------------------------------
// key assignment (class 1 cmd 3): FunctionId + 5 data bytes

/** device.js FUNCTION_INDEX (the ones we name) */
export const FID = {
  OFF: 0,
  MOUSE_BUTTON: 1,
  WHEEL: 4,
  COMBINE_KEY: 6,
  POWER: 7,
  MEDIA: 8,
  VENDOR: 10,
  MACRO_ONCE: 12,
  MACRO_HOLD: 13,
  MACRO_TOGGLE: 14,
  MACRO_STEP: 15,
  HWHEEL: 34,
} as const;

/** Function ids we ever SET (everything else is only kept as it is). */
export const WRITABLE_FIDS = new Set<number>([0, 1, 4, 6, 7, 8, 12, 13, 14, 15, 34]);

export interface Assign {
  fid: number;
  /** 5 data bytes */
  data: number[];
}
export const sameAssign = (a: Assign, b: Assign) => a.fid === b.fid && a.data.every((x, i) => x === b.data[i]);
export const assignKey = (a: Assign) => `${a.fid}:${a.data.join(',')}`;

/**
 * Vendor IsDisableEdit: keys the key-function page won't let you change on a layer: the Fn key
 * (VendorKey / key id 107), dial / pairing / reset / system functions (39-42, 44-49, 54-63) and
 * LightingModeV2 (53) on a region other than 0/1.
 */
export function lockedAssign(a: Assign, keyId: number): boolean {
  if (keyId === 107 || a.fid === FID.VENDOR) return true;
  const f = a.fid;
  if ((f >= 39 && f <= 42) || (f >= 44 && f <= 49) || (f >= 54 && f <= 63)) return true;
  if (f === 53 && a.data[0] !== 0 && a.data[0] !== 1) return true;
  return false;
}

// QMK v2 codes (src/lib/keycodes.ts)
const KC_BTN1 = 0xd1;
const KC_WH_U = 0xd9;
const KC_WH_D = 0xda;
const KC_WH_L = 0xdb;
const KC_WH_R = 0xdc;
const QK_MACRO = 0x7700;
/** codes for assignments QMK has no keycode for (kept as they are): QK_USER range 0x7E00-0x7EFF */
export const OPAQUE_BASE = 0x7e00;
export const OPAQUE_MAX = 0x100;

/** Consumer usage (MediaKeys, 16-bit) <-> QMK media keycode. */
const MEDIA: [usage: number, kc: number][] = [
  [0xe2, 0xa8], [0xe9, 0xa9], [0xea, 0xaa], [0xb5, 0xab], [0xb6, 0xac], [0xb7, 0xad], [0xcd, 0xae],
  [0x183, 0xaf], [0xb8, 0xb0], [0x18a, 0xb1], [0x192, 0xb2], [0x194, 0xb3], [0x221, 0xb4], [0x223, 0xb5],
  [0x224, 0xb6], [0x225, 0xb7], [0x226, 0xb8], [0x227, 0xb9], [0x22a, 0xba], [0xb3, 0xbb], [0xb4, 0xbc],
  [0x6f, 0xbd], [0x70, 0xbe],
];
const KC_OF_MEDIA = new Map(MEDIA);
const MEDIA_OF_KC = new Map(MEDIA.map(([u, k]) => [k, u]));
/** System control (PowerKeys d0) <-> QMK KC_PWR / KC_SLEP / KC_WAKE */
const POWER: [usage: number, kc: number][] = [[0x81, 0xa5], [0x82, 0xa6], [0x83, 0xa7]];
const KC_OF_POWER = new Map(POWER);
const POWER_OF_KC = new Map(POWER.map(([u, k]) => [k, u]));

/**
 * Assignment -> QMK-v2 keycode, or undefined when QMK has no code for it (the driver then gives
 * it an opaque code and never changes it unless asked to copy it).
 * CombineKey: d0 = HID modifier byte (bit 0 LCtrl … 3 LGui, 4 RCtrl … 7 RGui), d1 = usage, d2 = 2nd usage.
 */
export function codeOfAssign(a: Assign): number | undefined {
  const [d0, d1, d2, d3, d4] = a.data;
  switch (a.fid) {
    case FID.OFF:
      return a.data.every((x) => x === 0) ? 0 : undefined;
    case FID.COMBINE_KEY: {
      if (d2 || d3 || d4) return undefined;
      if (d0 === 0) return d1 >= 0x04 && d1 <= 0xe7 ? d1 : d1 === 0 ? 0 : undefined;
      if (d1 === 0) {
        // a modifier on its own
        if (d0 & (d0 - 1)) return undefined;
        return 0xe0 + Math.log2(d0);
      }
      if (d1 < 0x04 || d1 > 0xa4) return undefined;
      if ((d0 & 0xf0) === 0) return (d0 << 8) | d1;
      if ((d0 & 0x0f) === 0) return ((0x10 | (d0 >> 4)) << 8) | d1;
      return undefined; // left and right modifiers together
    }
    case FID.MEDIA: {
      if (d2 || d3 || d4) return undefined;
      return KC_OF_MEDIA.get((d0 << 8) | d1);
    }
    case FID.POWER:
      return d1 || d2 || d3 || d4 ? undefined : KC_OF_POWER.get(d0);
    case FID.MOUSE_BUTTON:
      return d0 >= 1 && d0 <= 5 && !d1 && !d2 && !d3 && !d4 ? KC_BTN1 + d0 - 1 : undefined;
    case FID.WHEEL:
      return d1 || d2 || d3 || d4 ? undefined : d0 === 0x01 ? KC_WH_U : d0 === 0xff ? KC_WH_D : undefined;
    case FID.HWHEEL:
      return d1 || d2 || d3 || d4 ? undefined : d0 === 0xff ? KC_WH_L : d0 === 0x01 ? KC_WH_R : undefined;
    case FID.MACRO_ONCE:
      // play once: macro id d0 (1-based) -> M(id - 1)
      return d0 >= 1 && d0 <= 128 && d1 === 0 && d2 === 1 && !d3 && !d4 ? QK_MACRO + d0 - 1 : undefined;
    default:
      return undefined;
  }
}

/** QMK-v2 keycode -> assignment (undefined when this firmware can't do it). */
export function assignOfCode(kc: number): Assign | undefined {
  const z = (fid: number, ...d: number[]): Assign => ({ fid, data: [...d, 0, 0, 0, 0, 0].slice(0, 5) });
  if (kc === 0) return z(FID.OFF);
  if (kc >= 0xe0 && kc <= 0xe7) return z(FID.COMBINE_KEY, 1 << (kc - 0xe0), 0);
  if (kc >= 0x04 && kc <= 0xa4) return z(FID.COMBINE_KEY, 0, kc);
  if (MEDIA_OF_KC.has(kc)) {
    const u = MEDIA_OF_KC.get(kc)!;
    return z(FID.MEDIA, u >> 8, u & 0xff);
  }
  if (POWER_OF_KC.has(kc)) return z(FID.POWER, POWER_OF_KC.get(kc)!);
  if (kc >= KC_BTN1 && kc < KC_BTN1 + 5) return z(FID.MOUSE_BUTTON, kc - KC_BTN1 + 1);
  if (kc === KC_WH_U) return z(FID.WHEEL, 0x01);
  if (kc === KC_WH_D) return z(FID.WHEEL, 0xff);
  if (kc === KC_WH_L) return z(FID.HWHEEL, 0xff);
  if (kc === KC_WH_R) return z(FID.HWHEEL, 0x01);
  if (kc >= QK_MACRO && kc < QK_MACRO + 128) return z(FID.MACRO_ONCE, kc - QK_MACRO + 1, 0, 1);
  // Ctrl+C style: one side's modifiers + a basic key
  if (kc >= 0x0100 && kc <= 0x1fff) {
    const m = (kc >> 8) & 0x1f;
    const k = kc & 0xff;
    if (k < 0x04 || k > 0xa4 || (m & 0x0f) === 0) return undefined;
    return z(FID.COMBINE_KEY, m & 0x10 ? (m & 0x0f) << 4 : m, k);
  }
  return undefined;
}
