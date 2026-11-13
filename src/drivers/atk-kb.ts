// ATK Hall-effect keyboards on the BitYuan solution (EDGE 60 / 63 / 75, RS6 / RS7 / RS8, ATK68 V3 / RX,
// ATK60 RX, Hex80, VELOTA Nothing 68 / Fuzzy ...), from ATK HUB 3.x (hub.atk.pro, the vendor's own web
// configurator). Not checked on real hardware yet: the app keeps it view-only until "Allow changes".
//
// Sources (hub bundle, read as text): `demoMode.store-afQcByDx.js` (packet classes `Cn`, `Ux`, `Td`, `Il`,
// the BitKeyboard controller `An`, the device filter lists `KN/ON/BN/$N/NN`), `keymap-CovEqJ6s.js` (command
// enums), `CurveEditor-BUssCLcK.js` (HandleMode + CurveEditor composables), `ConfigPage-C-JzSQza.js`
// (menu gating) and `locales-CEtUcNew.js` (English names).
//
// Transport: VIA-style raw HID, usage page 0xFF60 usage 0x61, report ID 0, 32-byte reports both ways:
//   `var Cn=class Qp extends _v{...}; U(Cn,"SIZE",32); U(Cn,"baseOffset",1)`
//   `async transferAsync(t,e){... this.device.sendReport(e,t)}` with e = 0
// A reply belongs to a request when byte 0 matches, for 0x02/0x03 also byte 1, and for 0x96 also byte 2
// (`isReplyFor(t,e){... a[0]!==e.getUint8(0) ... a[1]!==e.getUint8(1)||a[1]===Lt.customId&&(... a[2]!==e.getUint8(2) ...`);
// the hub waits up to 3 s (`U(this,"TIMEOUT_MS",3e3)`).
//
// Vendor commands are `02|03 96 <field> ...` (`id_get_keyboard_value=2`, `id_set_keyboard_value=3`,
// `customId=150`). Fields used here (`kt=(...){customId=150 ... gamepad=76 ... restart=78 ...}`):
//   - version            `02 96 00` -> "b5.b6" in hex ("1.20"); `Ux.get(): e.raw.setUint8(this.baseOffset,Lt.customId)`,
//                        `get version(){return[this.raw.getUint8(this.baseOffset+4).toString(16),
//                        this.raw.getUint8(this.baseOffset+5).toString(16).padStart(2,"0")].join(".")}`
//   - gamepad (0x4C)     `Il.createBase(e,a,n=0,i=0){... setUint8(baseOffset,Lt.customId), setUint8(baseOffset+1,Lt.gamepad),
//                        o.row=n,o.col=i,o.sub=a}` -> `cmd 96 4C row col sub payload...`, sub
//                        `Sl={MODE:0,MAPPING:1,CLEAR:2,CONFIG:3,ANGLE:4,SQUARE:5,EXTREME:6,KEY_OUTPUT:7,ENABLED:8,CURVE:9}`
//   - auto restart (0x4E) `Td.create(e){... Lt.restart),a.status=e}` -> `03 96 4E <status>`; the hub sends
//                        `Td.create(1)` right before a gamepad mode change:
//                        `async setGamepadMode(e){return await this.transferForResult(Td.create(1)),await this.transferForResult(Il.setMode(e)),...}`
// Keymap legends: VIA `0x12` get buffer, 28 bytes at a time, as the hub does
// (`getCurrentKeyMatrix(){... wA.get(i*28,28) ...}`, keys are [keyClass, keyId] = QMK keycode big-endian).
//
// The gamepad page only exists from firmware 2.00 (`I=u(()=>Number(...deviceConfig.version??"0")>=2)`,
// `{title:Ie.handleMode, component:"HandleMode", hide:!I.value}`), so older firmware gets no gamepad reads.
//
// Left out on purpose: per-key actuation / Rapid Trigger / SOCD (the hub writes them as whole flash tables with
// erase / write flags and a firmware-dependent RT scale), CLEAR all mappings (we clear key by key instead),
// lighting, calibration (0x08/0x18/0x19/0x1F/0x29), reset (0x15), IAP (0x98) and anything else.
// `allowed()` refuses every packet that is not one of the exact shapes below.

import { viaFactory } from './via';
import { AtkCombo } from './atk-combo';
import { label as kcLabel } from '../lib/keycodes';
import type { Driver, DriverFactory, GamepadCurve, KeyCap, PerKeyChoice, Setting, Value } from './types';

export const ATK_VID = 0x373b;
export const USAGE_PAGE = 0xff60;
export const USAGE = 0x61;
const REPORT_ID = 0;
export const REPORT_LEN = 32;
/** keymap bytes per get-buffer request, as the hub reads them */
export const BUF_CHUNK = 28;

export const CMD_GET = 0x02;
export const CMD_SET = 0x03;
export const CMD_GET_BUFFER = 0x12;
export const CUSTOM = 0x96;
export const F_VERSION = 0x00;
export const F_GAMEPAD = 0x4c;
export const F_RESTART = 0x4e;

/** gamepad sub commands (`Sl`) */
export const GP = { mode: 0, mapping: 1, config: 3, angle: 4, square: 5, extreme: 6, keyOutput: 7, enabled: 8, curve: 9 } as const;

/** Timings (ms). Mutable so tests can shorten them. */
export const atkKbConfig = { reply: 3000, modeReply: 1500 };

// ---------------------------------------------------------------------------------------------
// models (generated from the hub's BitYuan filter lists `KN=[...]`, `ON`, `BN`, `$N`, `NN`: productId, the
// `custom` title and the base's `row`/`col`; photos only where the hub's skin points at its asset store,
// `keyboard.assets-v8XFWQWT.js`: `d(){return"https://bpcdn.atkgear.com"}` + `/device/ossAssets/` + path)

/** [productId, name, matrix rows, matrix cols, photo path ('' = none)] */
export const ATK_KEYBOARDS: [number, string, number, number, string][] = [
  [0x10b0, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x1082, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x1114, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x12eb, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x10af, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x115f, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x1160, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x1161, 'EDGE 60HE ULTIMATE', 5, 14, ''],
  [0x11c5, 'ATK60 RX', 5, 14, ''],
  [0x11c6, 'ATK60 RX', 5, 14, ''],
  [0x11c7, 'ATK60 RX', 5, 14, ''],
  [0x11fc, 'ATK60 RX', 5, 14, ''],
  [0x125d, 'Velota 60 HE', 5, 14, ''],
  [0x1267, 'VELOTA FUZZY 60 V2', 5, 14, ''],
  [0x113b, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x113c, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x113d, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x1168, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x1169, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x116a, 'EDGE 63HE ULTIMATE', 5, 14, ''],
  [0x126a, 'RS 63 Air', 5, 14, ''],
  [0x126b, 'RS 63 Air', 5, 14, ''],
  [0x12a6, 'VELOTA FUZZY 63', 5, 15, 'fuzzy63/silver.webp'],
  [0x12b5, 'Keyboard 60A', 5, 15, ''],
  [0x135f, 'Keyboard 60A', 5, 15, ''],
  [0x11e8, 'ATK RS6', 5, 15, ''],
  [0x109c, 'ATK RS6', 5, 15, ''],
  [0x109d, 'ATK RS6 Ultra', 5, 15, ''],
  [0x109e, 'ATK RS6 Ultra', 5, 15, ''],
  [0x11e9, 'ATK RS6 Ultra', 5, 15, ''],
  [0x1162, 'ATK RS6', 5, 15, ''],
  [0x11ea, 'ATK RS6', 5, 15, ''],
  [0x1163, 'ATK RS6 Ultra', 5, 15, ''],
  [0x1164, 'ATK RS6 Ultra', 5, 15, ''],
  [0x11b8, 'RS6 SERIES', 5, 15, ''],
  [0x11d6, 'ATK RS6 Ultra', 5, 15, ''],
  [0x11eb, 'ATK RS6 Ultra', 5, 15, ''],
  [0x11b9, 'ATK RS6 x FLEET18', 5, 15, ''],
  [0x1112, 'ATK68 V3', 5, 15, ''],
  [0x116b, 'ATK68 V3', 5, 15, ''],
  [0x11e6, 'ATK68 V3', 5, 15, ''],
  [0x11d0, 'ATK RS6 Air', 5, 15, ''],
  [0x125b, 'ATK RS6 Air', 5, 15, ''],
  [0x12cf, 'ATK RS6 Air', 5, 15, ''],
  [0x1209, 'ATK RS6 Air', 5, 15, ''],
  [0x125c, 'ATK RS6 Air', 5, 15, ''],
  [0x1294, 'RS6 Air Cyber', 5, 15, ''],
  [0x130a, 'ATK RS6 Air', 5, 15, ''],
  [0x119a, 'ATK68 RX', 5, 15, ''],
  [0x11c0, 'ATK68 RX', 5, 15, ''],
  [0x11c1, 'ATK68 RX', 5, 15, ''],
  [0x120f, 'ATK RS6 +', 5, 15, ''],
  [0x1210, 'ATK RS6 Ultra +', 5, 15, ''],
  [0x12fe, 'ATK RS6 +', 5, 15, ''],
  [0x1259, 'ATK RS6 Cube', 5, 15, ''],
  [0x12f0, 'ATK RS6 Cube', 5, 15, ''],
  [0x12ad, 'VELOTA NOTHING 68', 5, 15, 'nothing68/black.webp'],
  [0x12ae, 'VELOTA NOTHING 68', 5, 15, 'nothing68/black.webp'],
  [0x12fc, 'VELOTA HALO 68', 5, 15, 'nothing68/black.webp'],
  [0x12fd, 'VELOTA HALO 68', 5, 15, 'nothing68/black.webp'],
  [0x1330, 'ATK RS6 V2', 5, 16, 'rs6v2/meteorite-ash.webp'],
  [0x1174, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x1197, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x1198, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11ae, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11b0, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11ad, 'ATK RS7 V2', 6, 15, ''],
  [0x11df, 'ATK RS7 V2', 6, 15, ''],
  [0x11af, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11ba, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11da, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x1336, 'ATK RS7 V2 Ultra', 6, 15, ''],
  [0x11a8, 'ATK RS7 V2 EXTREME', 6, 15, ''],
  [0x108e, 'ATK EDGE75', 6, 15, ''],
  [0x1090, 'ATK EDGE75', 6, 15, ''],
  [0x1206, 'ATK EDGE75', 6, 15, 'edge75/white-translucent.webp'],
  [0x11e0, 'ATK RS7 Turbo', 6, 15, ''],
  [0x11e1, 'ATK RS7 Turbo', 6, 15, ''],
  [0x1220, 'ATK RS7 Air', 6, 15, ''],
  [0x1339, 'ATK RS7 Air', 6, 15, ''],
  [0x1257, 'ATK RS7 Air', 6, 15, ''],
  [0x1335, 'ATK RS7 Air', 6, 15, ''],
  [0x1221, 'ATK RS7 Air', 6, 15, ''],
  [0x122b, 'ATK RS7 Air', 6, 15, ''],
  [0x1258, 'ATK RS7 Air', 6, 15, ''],
  [0x1295, 'RS7 Air Cyber', 6, 15, ''],
  [0x1318, 'ATK RS7 Air PIKACHU Edition', 6, 15, 'rs7-air/pikachu.webp'],
  [0x12c1, 'ATK RS7 Air', 6, 15, ''],
  [0x1176, 'ATK x QK Hex80', 6, 17, ''],
  [0x1177, 'ATK x QK Hex80', 6, 17, ''],
  [0x1250, 'ATK x QK Hex80', 6, 17, ''],
  [0x12ac, 'Hex80 V2', 6, 17, ''],
  [0x12be, 'Hex80 V2', 6, 17, ''],
  [0x1334, 'Hex80 V2', 6, 17, ''],
  [0x122c, 'ATK RS8 Air', 6, 17, 'rs8neo/GlacierBlue.png'],
  [0x12a0, 'ATK RS8 Air', 6, 17, 'rs8neo/GlacierBlue.png'],
  [0x12a1, 'ATK RS8 Air', 6, 17, 'rs8neo/GlacierBlue.png'],
  [0x12ca, 'ATK RS8 Air', 6, 17, 'rs8neo/GlacierBlue.png'],
  [0x12cb, 'ATK RS8 Air', 6, 17, 'rs8neo/GlacierBlue.png'],
  [0x1351, 'ATK RS8 Air GENGAR Edition', 6, 17, 'rs8/gengar.webp'],
];
const OSS = 'https://bpcdn.atkgear.com/device/ossAssets/';
const modelOf = (pid: number) => ATK_KEYBOARDS.find((m) => m[0] === pid);

// ---------------------------------------------------------------------------------------------
// gamepad targets (`lN=[{id:0,category:"none",...},{id:1,category:"btn",xboxName:"gamepad.targetBtnA",hidName:"Btn1"},...]`).
// In Xbox mode the hub only offers targets with an xboxName (`$.value===2?!!a.xboxName`); ids 16-20 are HID only.

/** [id, Xbox label, HID label] (Xbox label '' = not available in Xbox mode) */
export const GP_TARGETS: [number, string, string][] = [
  [1, 'A', 'Btn 1'],
  [2, 'B', 'Btn 2'],
  [3, 'X', 'Btn 3'],
  [4, 'Y', 'Btn 4'],
  [5, 'LB', 'Btn 5'],
  [6, 'RB', 'Btn 6'],
  [7, 'View', 'Btn 7'],
  [8, 'Menu', 'Btn 8'],
  [9, 'Guide', 'Btn 9'],
  [10, 'LS click', 'Btn 10'],
  [11, 'RS click', 'Btn 11'],
  [16, '', 'Btn 12'],
  [17, '', 'Btn 13'],
  [18, '', 'Btn 14'],
  [19, '', 'Btn 15'],
  [20, '', 'Btn 16'],
  [12, 'D-pad ↑', 'Hat ↑'],
  [13, 'D-pad ↓', 'Hat ↓'],
  [14, 'D-pad ←', 'Hat ←'],
  [15, 'D-pad →', 'Hat →'],
  [96, 'LT', 'LT'],
  [97, 'RT', 'RT'],
  [65, 'LS ↑', 'L ↑'],
  [81, 'LS ↓', 'L ↓'],
  [80, 'LS ←', 'L ←'],
  [64, 'LS →', 'L →'],
  [67, 'RS ↑', 'R ↑'],
  [83, 'RS ↓', 'R ↓'],
  [82, 'RS ←', 'R ←'],
  [66, 'RS →', 'R →'],
];
const TARGET_IDS = new Set([0, ...GP_TARGETS.map(([id]) => id)]);

export const MODE_HID = 1;
export const MODE_XBOX = 2;

/** curve x axis: key travel in µm (`Dxt=3300`; the editor shows `(e.x[t]/1e3).toFixed(1)` mm) */
export const CURVE_MAX_UM = 3300;
export const CURVE_NAMES = ['Left stick', 'Right stick', 'Left trigger', 'Right trigger'];
const CURVE_KEYS = ['gp_curve_ls', 'gp_curve_rs', 'gp_curve_lt', 'gp_curve_rt'];

/**
 * Presets (`Txt=[{name:"线性",xr:[100,.33,.66,1],y:[20,85,170,255]},...]`), turned into points like the editor
 * does: `{x:t.xr[0],y:t.y[0]},{x:Math.round(t.xr[1]*s.value),...}` with s = 3300 (the first x is absolute µm).
 * English names from the locale: presetLinear, presetAggressive, presetSlow, presetSmooth, presetSteep,
 * presetInstant, presetTurbo.
 */
const PRESET_SRC: [string, number[], number[]][] = [
  ['Linear', [100, 0.33, 0.66, 1], [20, 85, 170, 255]],
  ['Aggressive', [100, 0.17, 0.38, 1], [20, 140, 220, 255]],
  ['Slow', [100, 0.61, 0.85, 1], [20, 60, 150, 255]],
  ['Smooth', [100, 0.32, 0.7, 1], [20, 30, 225, 255]],
  ['Steep', [100, 0.14, 0.26, 1], [20, 200, 240, 255]],
  ['Instant', [100, 0.05, 0.08, 1], [20, 255, 255, 255]],
  ['Turbo', [100, 0.11, 0.2, 1], [20, 180, 250, 255]],
];
/** presets in µm / 0..255 */
export const CURVE_PRESETS_UM: { name: string; x: number[]; y: number[] }[] = PRESET_SRC.map(([name, xr, y]) => ({
  name,
  x: [xr[0], Math.round(xr[1] * CURVE_MAX_UM), Math.round(xr[2] * CURVE_MAX_UM), Math.round(xr[3] * CURVE_MAX_UM)],
  y,
}));

// ---------------------------------------------------------------------------------------------
// packets (32 bytes, no report ID; builders return the meaningful prefix, the rest is zero)

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (p: ArrayLike<number>) => Array.from(p, hex2).join(' ');

/** `Ux.get()` */
export const versionPkt = () => [CMD_GET, CUSTOM, F_VERSION];
/** VIA dynamic keymap get buffer: offset (BE), length (`wA.get(e,a)`: offset at baseOffset (u16 BE), length at +2) */
export const getBufferPkt = (offset: number, size: number) => [CMD_GET_BUFFER, (offset >> 8) & 0xff, offset & 0xff, size];
const gp = (cmd: number, sub: number, row = 0, col = 0, ...payload: number[]) => [cmd, CUSTOM, F_GAMEPAD, row, col, sub, ...payload];
/** `Il.getConfig()` */
export const gpConfigPkt = () => gp(CMD_GET, GP.config);
/** `Il.getMapping(e,a)` */
export const gpGetMapPkt = (row: number, col: number) => gp(CMD_GET, GP.mapping, row, col);
/** `Il.setMapping(e,a,n)`: payload0 (byte 6) = target id, 0 = unmapped */
export const gpSetMapPkt = (row: number, col: number, target: number) => gp(CMD_SET, GP.mapping, row, col, target);
/** `Il.setMode(e)`: 1 HID, 2 Xbox (`Sxt={1:"HID",2:"Xbox"}`) */
export const gpModePkt = (mode: number) => gp(CMD_SET, GP.mode, 0, 0, mode);
/** `Td.create(1)`: firmware restarts by itself after the mode change */
export const autoRestartPkt = () => [CMD_SET, CUSTOM, F_RESTART, 1];
/** `Il.setEnabled(e)`: `a.payload0=e?1:0` */
export const gpEnabledPkt = (on: boolean) => gp(CMD_SET, GP.enabled, 0, 0, on ? 1 : 0);
/** `Il.setKeyOutput(e)`: 0 normal (mixed), 1 mapped keys override, 2 keyboard keys off */
export const gpKeyOutputPkt = (mode: number) => gp(CMD_SET, GP.keyOutput, 0, 0, mode);
/** `Il.setAngle(e,a)`: stick (0 left, 1 right) in the row byte, degrees 0..90 */
export const gpAnglePkt = (stick: number, deg: number) => gp(CMD_SET, GP.angle, stick, 0, deg);
/** `Il.setSquareGate(e,a)` */
export const gpSquarePkt = (stick: number, on: boolean) => gp(CMD_SET, GP.square, stick, 0, on ? 1 : 0);
/** `Il.setExtreme(e,a)` */
export const gpExtremePkt = (stick: number, on: boolean) => gp(CMD_SET, GP.extreme, stick, 0, on ? 1 : 0);
/** `Il.getCurve(e)`: 0 left stick, 1 right stick, 2 LT, 3 RT */
export const gpGetCurvePkt = (i: number) => gp(CMD_GET, GP.curve, i);
/**
 * `Il.setCurve(e,a)`: 4 points from byte 6, each `x&255, x>>8&255, y&255` (x in µm, little-endian):
 * `const o=this.baseOffset+5+i*3;n.raw.setUint8(o,a[i].x&255),n.raw.setUint8(o+1,a[i].x>>8&255),n.raw.setUint8(o+2,a[i].y&255)`
 */
export const gpSetCurvePkt = (i: number, xs: number[], ys: number[]) =>
  gp(CMD_SET, GP.curve, i, 0, ...xs.flatMap((x, k) => [x & 0xff, (x >> 8) & 0xff, ys[k] & 0xff]));

/** What reads may touch: the board's matrix (gamepad mappings, keymap legends of layer 0). */
export interface Bounds {
  rows: number;
  cols: number;
}

const keymapReadBytes = (b: Bounds) => Math.ceil((b.rows * b.cols * 2) / BUF_CHUNK) * BUF_CHUNK;

/**
 * Payload allowlist: exactly the packets above, with their values in range. Everything else is refused,
 * including every other vendor field (reset, calibration, IAP, flash tables) and gamepad CLEAR.
 */
export function allowed(p: ArrayLike<number>, b?: Bounds): boolean {
  if (p.length === 0 || p.length > REPORT_LEN) return false;
  const tailZero = (from: number) => {
    for (let i = from; i < p.length; i++) if (p[i] !== 0) return false;
    return true;
  };
  const at = (i: number) => p[i] ?? 0;
  if (at(0) === CMD_GET_BUFFER) {
    if (!b) return false;
    const off = (at(1) << 8) | at(2);
    return at(3) === BUF_CHUNK && off % BUF_CHUNK === 0 && off + BUF_CHUNK <= keymapReadBytes(b) && tailZero(4);
  }
  if ((at(0) !== CMD_GET && at(0) !== CMD_SET) || at(1) !== CUSTOM) return false;
  const get = at(0) === CMD_GET;
  if (at(2) === F_VERSION) return get && tailZero(3);
  if (at(2) === F_RESTART) return !get && at(3) === 1 && tailZero(4);
  if (at(2) !== F_GAMEPAD) return false;
  const [row, col, sub, v] = [at(3), at(4), at(5), at(6)];
  const fixed = row === 0 && col === 0;
  const stick = (row === 0 || row === 1) && col === 0;
  const bool = v === 0 || v === 1;
  if (get) {
    switch (sub) {
      case GP.config:
        return fixed && tailZero(6);
      case GP.mapping:
        return !!b && row < b.rows && col < b.cols && tailZero(6);
      case GP.curve:
        return row < 4 && col === 0 && tailZero(6);
      default:
        return false;
    }
  }
  switch (sub) {
    case GP.mode:
      return fixed && (v === MODE_HID || v === MODE_XBOX) && tailZero(7);
    case GP.mapping:
      return !!b && row < b.rows && col < b.cols && TARGET_IDS.has(v) && tailZero(7);
    case GP.enabled:
      return fixed && bool && tailZero(7);
    case GP.keyOutput:
      return fixed && v <= 2 && tailZero(7);
    case GP.angle:
      return stick && v <= 90 && tailZero(7);
    case GP.square:
    case GP.extreme:
      return stick && bool && tailZero(7);
    case GP.curve: {
      if (!(row < 4 && col === 0)) return false;
      let last = 0;
      for (let k = 0; k < 4; k++) {
        const x = at(6 + k * 3) | (at(7 + k * 3) << 8);
        if (x > CURVE_MAX_UM || x < last) return false;
        last = x;
      }
      return tailZero(18);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// replies

/** `get version()` */
export const parseVersion = (r: ArrayLike<number>) => `${(r[5] ?? 0).toString(16)}.${(r[6] ?? 0).toString(16).padStart(2, '0')}`;

export interface GpConfig {
  mode: number;
  angle: [number, number];
  square: [boolean, boolean];
  extreme: [boolean, boolean];
  keyOutput: number;
  enabled: boolean;
}

/**
 * Config reply (`get gamepadMode(){return this.raw.getUint8(this.baseOffset+5)}` ... angleLeft +6, angleRight +7,
 * squareGateLeft +8, squareGateRight +9, extremeLeft +10, extremeRight +11, keyOutputMode +12, gamepadEnabled +13),
 * i.e. bytes 6..14 of the report.
 */
export function parseConfig(r: ArrayLike<number>): GpConfig {
  return {
    mode: r[6],
    angle: [r[7], r[8]],
    square: [!!r[9], !!r[10]],
    extreme: [!!r[11], !!r[12]],
    keyOutput: r[13],
    enabled: !!r[14],
  };
}

/** The hub reads an unset mode (0) as Xbox: `gamepadMode:a.gamepadMode||2` in `_fetchBityuanGamepadSnapshot`. */
export const modeOf = (c: GpConfig) => c.mode || MODE_XBOX;

/** `getCurvePoints()`: bytes 6.. as 4 x [xLo, xHi, y] */
export function parseCurve(r: ArrayLike<number>): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let k = 0; k < 4; k++) {
    x.push(r[6 + k * 3] | (r[7 + k * 3] << 8));
    y.push(r[8 + k * 3]);
  }
  return { x, y };
}

/** Does `d` answer `p`? (the hub's `isReplyFor`) */
export function isReplyFor(p: ArrayLike<number>, d: ArrayLike<number>): boolean {
  if (!d.length || d[0] !== p[0]) return false;
  if (p[0] !== CMD_GET && p[0] !== CMD_SET) return true;
  if (d[1] !== p[1]) return false;
  return p[1] !== CUSTOM || d[2] === p[2];
}

// ---------------------------------------------------------------------------------------------
// link

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(d: Uint8Array) => void>();
  bounds: Bounds | undefined;
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

  xfer(p: number[], timeout = atkKbConfig.reply): Promise<Uint8Array> {
    if (!allowed(p, this.bounds)) return Promise.reject(new Error(`refusing to send ${hexs(p.slice(0, 8))}`));
    const buf = new Uint8Array(REPORT_LEN);
    buf.set(p);
    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (d?: Uint8Array, err?: Error) => {
        this.listeners.delete(l);
        if (timer !== undefined) clearTimeout(timer);
        if (d) resolve(d);
        else reject(err);
      };
      const l = (d: Uint8Array) => {
        if (isReplyFor(buf, d)) done(d);
      };
      this.listeners.add(l);
      timer = setTimeout(() => done(undefined, new Error(`no answer for ${hexs(p.slice(0, 6))}`)), timeout);
      this.dev.sendReport(REPORT_ID, buf).catch((e) => done(undefined, e instanceof Error ? e : new Error(String(e))));
    });
  }
}

// ---------------------------------------------------------------------------------------------
// driver

const um = (mm: number) => Math.round(mm * 1000);
const mm = (u: number) => u / 1000;

function curveValue(c: { x: number[]; y: number[] }): GamepadCurve {
  return {
    kind: 'gamepadCurve',
    points: c.x.map((x, k) => ({ x: mm(x), y: c.y[k] })),
    maxX: mm(CURVE_MAX_UM),
    stepX: 0.01,
    maxY: 255,
    presets: CURVE_PRESETS_UM.map((p) => ({ name: p.name, points: p.x.map((x, k) => ({ x: mm(x), y: p.y[k] })) })),
  };
}

/** Options for the per-key mapping in `mode` (Xbox mode: only Xbox targets, plus any HID-only one in use). */
export function targetOptions(mode: number, inUse: number[] = []): [string, number][] {
  const xbox = mode !== MODE_HID;
  const used = new Set(inUse);
  return [
    ['None', 0],
    ...GP_TARGETS.filter(([id, x]) => !xbox || x || used.has(id)).map(([id, x, h]) => [xbox ? x || h : h, id] as [string, number]),
  ];
}

interface State {
  version: string;
  keys: KeyCap[];
  /** matrix position of each key */
  pos: [row: number, col: number][];
  config?: GpConfig;
  map?: number[];
  curves?: { x: number[]; y: number[] }[];
}

class AtkKeyboard implements Driver {
  readonly family = 'ATK (BitYuan)';
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  readonly id: string;
  private st: State | undefined;
  /** set after a gamepad mode change: the keyboard restarts and comes back as a new device */
  private restartingTo: number | undefined;

  constructor(
    private readonly link: Link,
    private readonly model_: [number, string, number, number, string],
  ) {
    const d = link.dev;
    this.id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    link.bounds = { rows: model_[2], cols: model_[3] };
  }

  brand() {
    return 'ATK';
  }
  model() {
    return this.model_[1];
  }
  image() {
    return this.model_[4] ? OSS + this.model_[4] : undefined;
  }
  layout() {
    return this.st?.keys ?? [];
  }
  /** true once a mode change made the keyboard restart; it has to come back (re-enumerate) before anything else */
  get reconnectNeeded() {
    return this.restartingTo !== undefined;
  }

  /** firmware version; gamepad needs 2.00+ */
  async identify(): Promise<string> {
    const r = await this.link.xfer(versionPkt());
    return parseVersion(r);
  }

  private get rows() {
    return this.model_[2];
  }
  private get cols() {
    return this.model_[3];
  }

  /** layer 0 of the keymap: which matrix cells are keys, and their legends */
  private async readKeys(): Promise<{ keys: KeyCap[]; pos: [number, number][] }> {
    const n = this.rows * this.cols;
    const bytes: number[] = [];
    for (let off = 0; off < n * 2; off += BUF_CHUNK) {
      const r = await this.link.xfer(getBufferPkt(off, BUF_CHUNK));
      bytes.push(...r.slice(4, 4 + BUF_CHUNK));
    }
    const keys: KeyCap[] = [];
    const pos: [number, number][] = [];
    for (let row = 0; row < this.rows; row++)
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        const kc = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
        if (kc === 0) continue; // KC_NO: no switch at this matrix position
        keys.push({ index: i, label: kcLabel(kc), x: col, y: row, w: 1, h: 1 });
        pos.push([row, col]);
      }
    if (!keys.length)
      // no keymap answer: offer every matrix position
      for (let row = 0; row < this.rows; row++)
        for (let col = 0; col < this.cols; col++) {
          keys.push({ index: row * this.cols + col, label: `R${row + 1}C${col + 1}`, x: col, y: row, w: 1, h: 1 });
          pos.push([row, col]);
        }
    return { keys, pos };
  }

  private async readConfig(): Promise<GpConfig> {
    return parseConfig(await this.link.xfer(gpConfigPkt()));
  }
  private async readMap(row: number, col: number): Promise<number> {
    return (await this.link.xfer(gpGetMapPkt(row, col)))[6];
  }
  private async readCurve(i: number) {
    return parseCurve(await this.link.xfer(gpGetCurvePkt(i)));
  }

  read(): Promise<Setting[]> {
    return this.link.lock(async () => {
      if (this.restartingTo !== undefined && this.st) return this.settings();
      const version = await this.identify();
      const gamepad = Number(version) >= 2;
      const { keys, pos } = await this.readKeys();
      const st: State = { version, keys, pos };
      if (gamepad) {
        st.config = await this.readConfig();
        st.map = [];
        for (const [r, c] of pos) st.map.push(await this.readMap(r, c));
        st.curves = [];
        for (let i = 0; i < 4; i++) st.curves.push(await this.readCurve(i));
      }
      this.st = st;
      return this.settings();
    });
  }

  private settings(): Setting[] {
    const st = this.st!;
    const out: Setting[] = [{ key: 'fw', label: 'Firmware', group: 'Info', value: { kind: 'text', text: st.version } }];
    if (!st.config || !st.map || !st.curves) {
      out.push({
        key: 'unsupported',
        label: 'Gamepad',
        group: 'Info',
        value: { kind: 'text', text: `Gamepad mode needs firmware 2.00 or newer (this keyboard has ${st.version}).` },
      });
      return out;
    }
    const c = st.config;
    const G = 'Gamepad';
    if (this.restartingTo !== undefined)
      out.push({
        key: 'gp_status',
        label: 'Restarting',
        group: G,
        value: { kind: 'text', text: `Switching to ${this.restartingTo === MODE_XBOX ? 'Xbox' : 'HID'} mode: the keyboard restarts. Unplug and replug it if it doesn't come back.` },
      });
    const mode = modeOf(c);
    const modes: [string, number][] = [['Xbox', MODE_XBOX], ['HID (DInput)', MODE_HID]];
    if (mode !== MODE_XBOX && mode !== MODE_HID) modes.push([`Unknown (${mode})`, mode]);
    out.push(
      { key: 'gp_enabled', label: 'Gamepad', group: G, value: { kind: 'toggle', on: c.enabled }, hint: 'Mapped keys act as a game controller' },
      { key: 'gp_mode', label: 'Controller type', group: G, value: { kind: 'choice', options: modes, current: mode }, hint: 'Changing it restarts the keyboard', confirm: 'The keyboard will restart. You may need to unplug it, plug it back in and press Connect again. Continue?' },
      {
        key: 'gp_output',
        label: 'Key output',
        group: G,
        value: { kind: 'choice', options: [['Normal', 0], ['Override mapped keys', 1], ['Gamepad only', 2]], current: c.keyOutput },
        hint: 'Normal: mapped keys type and drive the controller. Override: mapped keys only drive the controller. Gamepad only: every keyboard key is off',
      },
    );
    ['Left', 'Right'].forEach((side, s) => {
      const k = s ? 'r' : 'l';
      out.push(
        { key: `gp_angle_${k}`, label: `${side} stick diagonal angle`, group: G, value: { kind: 'number', min: 0, max: 90, current: c.angle[s], unit: '°' }, hint: '45° is the default' },
        { key: `gp_square_${k}`, label: `${side} stick square gate`, group: G, value: { kind: 'toggle', on: c.square[s] }, hint: 'Full output on diagonals instead of a round gate' },
        { key: `gp_extreme_${k}`, label: `${side} stick extreme priority`, group: G, value: { kind: 'toggle', on: c.extreme[s] }, hint: 'Opposite directions: the deeper press wins instead of mixing' },
      );
    });
    st.curves.forEach((cv, i) => out.push({ key: CURVE_KEYS[i], label: `${CURVE_NAMES[i]} curve`, group: G, value: curveValue(cv) }));
    const map: PerKeyChoice = { kind: 'perKeyChoice', keys: st.keys, options: targetOptions(mode, st.map), none: 0, values: st.map.slice() };
    out.push({ key: 'gp_map', label: 'Gamepad mapping', group: G, value: map });
    return out;
  }

  write(s: Setting): Promise<void> {
    return this.link.lock(async () => {
      if (this.restartingTo !== undefined) throw new Error('The keyboard is restarting to switch controller type. Wait for it to come back (or replug it).');
      const st = this.st;
      if (!st?.config || !st.map || !st.curves) throw new Error("gamepad settings aren't available, press Re-read");
      const v = s.value;
      const want = <K extends Value['kind']>(k: K) => {
        if (v.kind !== k) throw new Error(`${s.key}: unexpected value`);
        return v as Extract<Value, { kind: K }>;
      };
      const side = s.key.endsWith('_r') ? 1 : 0;
      const check = async (ok: (c: GpConfig) => boolean, what: string) => {
        st.config = await this.readConfig();
        if (!ok(st.config)) throw new Error(`the keyboard didn't keep the new ${what}`);
      };
      switch (s.key) {
        case 'gp_enabled': {
          const on = want('toggle').on;
          await this.link.xfer(gpEnabledPkt(on));
          return check((c) => c.enabled === on, 'gamepad switch');
        }
        case 'gp_mode': {
          const m = want('choice').current;
          if (m === modeOf(st.config)) return;
          if (m !== MODE_HID && m !== MODE_XBOX) throw new Error('unknown controller type');
          // the hub's order: auto restart on, then the mode (the firmware restarts with the new USB interface)
          await this.link.xfer(autoRestartPkt());
          try {
            await this.link.xfer(gpModePkt(m), atkKbConfig.modeReply);
          } catch (e) {
            // a restarting keyboard may not answer any more
            if (!(e instanceof Error && e.message.startsWith('no answer'))) throw e;
          }
          this.restartingTo = m;
          st.config = { ...st.config, mode: m };
          return;
        }
        case 'gp_output': {
          const m = want('choice').current;
          if (m < 0 || m > 2) throw new Error('unknown key output mode');
          await this.link.xfer(gpKeyOutputPkt(m));
          return check((c) => c.keyOutput === m, 'key output mode');
        }
        case 'gp_angle_l':
        case 'gp_angle_r': {
          const deg = Math.round(want('number').current);
          if (deg < 0 || deg > 90) throw new Error('angle must be 0..90°');
          await this.link.xfer(gpAnglePkt(side, deg));
          return check((c) => c.angle[side] === deg, 'angle');
        }
        case 'gp_square_l':
        case 'gp_square_r': {
          const on = want('toggle').on;
          await this.link.xfer(gpSquarePkt(side, on));
          return check((c) => c.square[side] === on, 'square gate setting');
        }
        case 'gp_extreme_l':
        case 'gp_extreme_r': {
          const on = want('toggle').on;
          await this.link.xfer(gpExtremePkt(side, on));
          return check((c) => c.extreme[side] === on, 'extreme priority setting');
        }
        case 'gp_map': {
          const m = want('perKeyChoice');
          if (m.values.length !== st.pos.length) throw new Error("mapping doesn't match this keyboard, press Re-read");
          for (let i = 0; i < st.pos.length; i++) {
            const t = m.values[i];
            if (t === st.map[i]) continue;
            if (!TARGET_IDS.has(t)) throw new Error(`unknown gamepad target ${t}`);
            const [r, c] = st.pos[i];
            await this.link.xfer(gpSetMapPkt(r, c, t));
            const got = await this.readMap(r, c);
            st.map[i] = got;
            if (got !== t) throw new Error(`the keyboard didn't keep the mapping of ${st.keys[i].label || 'a key'}`);
          }
          return;
        }
        default: {
          const ci = CURVE_KEYS.indexOf(s.key);
          if (ci < 0) throw new Error(`${s.key} can't be changed`);
          const pts = want('gamepadCurve').points;
          if (pts.length !== 4) throw new Error('a curve has 4 points');
          const xs = pts.map((p) => um(p.x));
          const ys = pts.map((p) => Math.round(p.y));
          for (let k = 0; k < 4; k++) {
            if (xs[k] < 0 || xs[k] > CURVE_MAX_UM || (k && xs[k] < xs[k - 1])) throw new Error('curve points must go left to right within the key travel');
            if (ys[k] < 0 || ys[k] > 255) throw new Error('curve output must be 0..255');
          }
          await this.link.xfer(gpSetCurvePkt(ci, xs, ys));
          const got = await this.readCurve(ci);
          st.curves[ci] = got;
          if (got.x.some((x, k) => x !== xs[k]) || got.y.some((y, k) => y !== ys[k])) throw new Error(`the keyboard didn't keep the ${CURVE_NAMES[ci].toLowerCase()} curve`);
          return;
        }
      }
    });
  }

  async close(): Promise<void> {
    this.link.detach();
    await this.link.dev.close().catch(() => undefined);
  }
}

export const atkKbFactory: DriverFactory = {
  name: 'ATK keyboard',
  filters: [{ vendorId: ATK_VID, usagePage: USAGE_PAGE, usage: USAGE }],
  match(d: HIDDevice): boolean {
    return d.vendorId === ATK_VID && !!modelOf(d.productId) && (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!atkKbFactory.match(device)) return null;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const link = new Link(device);
    const drv = new AtkKeyboard(link, modelOf(device.productId)!);
    try {
      await link.lock(() => drv.identify());
    } catch {
      link.detach();
      if (openedHere) await device.close().catch(() => undefined);
      return null;
    }
    // the same interface also speaks VIA: keep its keymap / macros / lighting next to the gamepad
    const via = await viaFactory.create(device).catch(() => null);
    return via ? new AtkCombo(drv, via) : drv;
  },
};
