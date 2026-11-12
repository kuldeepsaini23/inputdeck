// WLMouse ("Compx" page/command framing) - Huan, Huan M, Beast X 8K, Sword X, Ying...
// Also the other CompX-A brands (Lamzu, Vancer, LunaFury, Attack Shark, CRDRAKO): see CATALOG.
// Port of the desktop app's src/drivers/wlmouse.rs (hardware-verified) to WebHID.
//
// Interface: vendor usage page 0xFFFF (also 0xFF00/0xFF02), feature report 0, 64 data bytes.
// Frame (without report-id byte): [status, 0, target, len, page, cmd, payload...]. GET = cmd | 0x80.
// Reply status 0xA1 = OK, 0xA0 pending, 0xA2 unsupported, 0xA3 busy (resend), 0xA4 asleep.
// No checksum. Layouts follow the official web hub (gm.wlmouse.gg, "WL MOUSE HUB" 1.0.47).
// NEVER send: page 0xB0 (bootloader), 00/00 factory reset, 00/0D profile reset,
// 00/0A, 00/26, 00/0B, 00/0F (pairing / dongle identity), macros. Screen pictures are only
// written through uploadScreen()/clearScreen(), which the user starts and confirms.

import type { Driver, DriverFactory, ScreenImage, ScreenSupport, Setting, Value } from './types';
import { sleep as realSleep } from './types';

const VID = 0x36a7;
const MOUSE = 2;
const DONGLE = 0;
/** shared receivers answer "which mouse is paired" on this target */
const PAIRING = 1;

const POLLING: [string, number][] = [
  ['125 Hz', 0x08], ['250 Hz', 0x04], ['500 Hz', 0x02], ['1000 Hz', 0x01],
  ['2000 Hz', 0x20], ['4000 Hz', 0x40], ['8000 Hz', 0x80],
];
/** LOD 3rd byte: official "Standard" = 3 (discrete gears), "Precise" = 11 (0.7-1.7 mm, 0.1 steps). */
const LOD_STANDARD = 0x03;
const LOD_PRECISE = 0x0b;
const LOD_STD = [0.7, 1.0, 2.0];
const LOD_FINE = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7];
const SLEEP_NEVER = 0xffff;
const SLEEP: [string, number][] = [
  ['30 sec', 30], ['1 min', 60], ['2 min', 120], ['5 min', 300], ['10 min', 600], ['15 min', 900],
  ['30 min', 1800], ['Never', SLEEP_NEVER],
];
/** page 0x01 boolean toggles: [key, label, cmd] */
const TOGGLES: [string, string, number][] = [
  ['motion_sync', 'Motion sync', 0x09],
  ['angle_snap', 'Angle snapping', 0x04],
  ['ripple', 'Ripple control', 0x0a],
];
const DEFAULT_STAGES = [400, 800, 1600, 3200, 6400];

const COLOR_KEYS = ['dpi_color1', 'dpi_color2', 'dpi_color3', 'dpi_color4', 'dpi_color5', 'dpi_color6'];

/** Physical button ids 1..5 (official KeyBindingSeq order is 1,4,5,2,3 = L, Back, Fwd, R, M). */
const BTN_KEYS = ['btn1', 'btn2', 'btn3', 'btn4', 'btn5'];
const BTN_LABELS = ['Left button', 'Right button', 'Middle button (wheel click)', 'Back side button', 'Forward side button'];

/** Onboard button actions: [label, action type, data]. Encoding from the official `zd` encoder. */
export const ACTIONS: [string, number, number[]][] = [
  ['Left click', 1, [0x01]],
  ['Right click', 1, [0x02]],
  ['Middle click', 1, [0x03]],
  ['Back', 1, [0x04]],
  ['Forward', 1, [0x05]],
  ['Scroll up', 1, [0x10]],
  ['Scroll down', 1, [0x11]],
  ['Left double-click', 2, [1, 1, 2, 0, 100]],
  ['DPI cycle', 7, [6]],
  ['DPI up', 7, [1]],
  ['DPI down', 7, [2]],
  ['Profile cycle', 8, [3]],
  ['Polling rate cycle', 13, [3]],
  ['LOD cycle', 14, [3]],
  ['Volume up', 5, [0x00, 0xe9]],
  ['Volume down', 5, [0x00, 0xea]],
  ['Mute', 5, [0x00, 0xe2]],
  ['Play / pause', 5, [0x00, 0xcd]],
  ['Next track', 5, [0x00, 0xb5]],
  ['Previous track', 5, [0x00, 0xb6]],
  ['Stop', 5, [0x00, 0xb7]],
  ['Disabled', 0, []],
];
/** Choice value for "whatever is on the button now" (keyboard key, macro...) - never written. */
export const KEEP = 1000;

// ---------------------------------------------------------------- other CompX-A brands
//
// Same firmware family, same page/command framing. Sources (all read as data only):
// - Lamzu: the official "LAMZU Aurora" web hub, lamzu.net/Config/env-models.json (1.0.38)
// - Vancer x Arbiter Studio Akitsu: webapp.arbiterstudio.com/Config/env-models.json (1.0.2.3)
// - LunaFury: the device table inside mouse.lunafury.games (LUNA33 / TYPE33)
// - Attack Shark R5 Ultra / R6 / R8 and CRDRAKO KO-ONE: OpenMouse's catalog (from Attack Shark Core)
// Only listed product IDs match: bootloader IDs (373E:B0xx, 37B0:0002/0004/0006/...) never do, and
// 37B0:003E/003F (Atlantis Mini 54H20, "IsCompx" = other protocol) are deliberately left out.

const LAMZU_VID = 0x37b0;
const COMPX_VID = 0x373e;

const R1K = [125, 250, 500, 1000];
const R8K = [500, 1000, 2000, 4000, 8000];
const RALL = [125, 250, 500, 1000, 2000, 4000, 8000];
const RV_WIRED = [500, 1000];

const MIN = 60;
const sleepList = (secs: number[], never = false): [string, number][] => [
  ...secs.map((v): [string, number] => [v < MIN ? `${v} sec` : `${v / MIN} min`, v]),
  ...(never ? [['Never', SLEEP_NEVER] as [string, number]] : []),
];
/** Lamzu hub "SleepTimeGrade" lists */
const SLEEP_LAMZU = sleepList([10, 30, MIN, 5 * MIN, 10 * MIN, 30 * MIN]);
const SLEEP_LAMZU_MIN = sleepList([MIN, 5 * MIN, 10 * MIN, 15 * MIN, 20 * MIN, 25 * MIN]);
/** Arbiter hub slider: whole minutes 1-30 */
const SLEEP_VANCER = sleepList([1, 2, 3, 5, 10, 15, 20, 30].map((m) => m * MIN));
/** LunaFury: 1-30 minutes, or never (0xFFFF) */
const SLEEP_LUNA = sleepList([1, 2, 3, 5, 10, 15, 20, 30].map((m) => m * MIN), true);

export interface CompxModel {
  brand: string;
  name: string;
  /** official product photo (top-down, transparent) on the brand's own web hub */
  img?: string;
  dpiMax: number;
  /** DPI stages the firmware keeps (the table is always 6 slots / 26 bytes on the wire) */
  stages: number;
  /** maker's hub hides separate X/Y DPI */
  noXY?: boolean;
  /** maker's hub hides high-speed (hyper) mode */
  noHyper?: boolean;
  sleep?: [string, number][];
}

interface CatalogEntry {
  /** more than one when a receiver PID is shared by several mice */
  models: CompxModel[];
  /** polling rates (Hz) on this connection */
  rates: number[];
  /** mouse answers on this target (wired LunaFury / CRDRAKO answer on 0, not 2) */
  target?: number;
  /** a receiver shared by several mice: the paired mouse is asked for */
  paired?: boolean;
}

const CATALOG = new Map<number, CatalogEntry>();
const ckey = (vid: number, pid: number) => vid * 0x10000 + pid;

/** register a model: [pid, rates, target?] per connection (wired cable, 1K / 8K receiver) */
function add(vid: number, m: CompxModel, ...pids: [number, number[], number?][]): void {
  for (const [pid, rates, target] of pids) {
    const e = CATALOG.get(ckey(vid, pid));
    if (e) e.models.push(m);
    else CATALOG.set(ckey(vid, pid), { models: [m], rates, ...(target !== undefined ? { target } : {}) });
  }
}

const lamzuImg = (folder: string) => `https://lamzu.net/Config/${folder}/Device_1.png`;
const lamzu = (name: string, folder: string, dpiMax = 30000, sleep = SLEEP_LAMZU): CompxModel => ({
  brand: 'Lamzu', name, img: lamzuImg(folder), dpiMax, stages: 5, sleep,
});

// Lamzu on the shared CompX vendor ID
add(COMPX_VID, lamzu('Maya X', 'MayaX'), [0x001c, R1K], [0x001d, R1K], [0x001e, R8K]);
// Lamzu's own vendor ID (Inca generation onwards)
add(LAMZU_VID, lamzu('Tachi', 'TACHI'), [0x0005, R1K], [0x000b, R1K], [0x000c, R8K]);
add(LAMZU_VID, lamzu('Inca', 'INCA'), [0x0009, R1K], [0x000f, R1K], [0x0010, R8K]);
add(LAMZU_VID, lamzu('Maya', 'Maya'), [0x0011, R1K], [0x0013, R1K], [0x0015, R8K]);
add(LAMZU_VID, lamzu('Paro', 'PARO'), [0x0007, R1K], [0x000d, R1K], [0x000e, R8K]);
add(LAMZU_VID, lamzu('Thorn', 'THORN'), [0x0017, R1K], [0x0019, R1K], [0x001b, R8K]);
add(LAMZU_VID, lamzu('Thorn V2', 'THORN'), [0x0021, R1K], [0x0023, R8K]);
add(LAMZU_VID, lamzu('Tachi Lite', 'TACHI_LITE'), [0x001c, R1K], [0x001e, R8K]);
add(LAMZU_VID, lamzu('Maya X V2', 'MayaXV2'), [0x001f, R1K], [0x0016, R8K]);
add(LAMZU_VID, lamzu('Atlantis OG Champion', 'AtlantisOG'), [0x0025, R1K], [0x0027, R8K]);
add(LAMZU_VID, lamzu('Atlantis Mini', 'AtlantisMini'), [0x0028, R1K], [0x002b, R1K], [0x002a, R8K]);
add(LAMZU_VID, lamzu('Maya M', 'MayaM'), [0x002c, R8K], [0x002e, R8K]);
add(LAMZU_VID, lamzu('Thorn V2 (54H20)', 'THORNV2', 50000, SLEEP_LAMZU_MIN), [0x0030, R8K], [0x0032, R8K]);
add(LAMZU_VID, lamzu('Thorn V2 3955 (54H20)', 'THORNV2_3955', 50000, SLEEP_LAMZU_MIN), [0x0040, R8K], [0x002e, R8K], [0x0032, R8K]);
add(LAMZU_VID, lamzu('DM198', 'DM198'), [0x0034, R8K], [0x0036, R8K]);
add(LAMZU_VID, lamzu('DM198 OP', 'DM198_OP'), [0x0038, R8K], [0x0036, R8K]);
add(LAMZU_VID, lamzu('Maya X (54H20)', 'MayaX'), [0x003a, R8K], [0x003b, R8K]);
add(LAMZU_VID, lamzu('Maya (54H20)', 'Maya'), [0x003c, R8K], [0x0036, R8K]);
add(LAMZU_VID, lamzu('Orcus', 'ORCUS', 50000, SLEEP_LAMZU_MIN), [0x0042, R8K], [0x0036, R8K]);
add(LAMZU_VID, lamzu('Maya X (LM20)', 'MayaX(LM20)', 50000, SLEEP_LAMZU_MIN), [0x0044, R8K], [0x0048, R8K]);
add(LAMZU_VID, lamzu('Maya M (LM20)', 'MayaM(LM20)', 50000, SLEEP_LAMZU_MIN), [0x0052, R8K], [0x0048, R8K]);
add(LAMZU_VID, lamzu('Maya (LM20)', 'Maya(LM20)', 50000, SLEEP_LAMZU_MIN), [0x0050, R8K], [0x0048, R8K]);
add(LAMZU_VID, lamzu('Mini (LM20)', 'Lamzu_mini(LM20)', 50000, SLEEP_LAMZU_MIN), [0x0046, R8K], [0x0054, R8K]);
add(LAMZU_VID, lamzu('Orcus V2 (LM20)', 'ORCUSV2(LM20)', 50000, SLEEP_LAMZU_MIN), [0x0056, R8K], [0x0048, R8K]);
/** shared "LAMZU Aurora" receivers: the paired mouse is asked for (00/8B) */
const LAMZU_RX: CompxModel = { brand: 'Lamzu', name: 'Aurora receiver', dpiMax: 30000, stages: 5, sleep: SLEEP_LAMZU };
CATALOG.set(ckey(LAMZU_VID, 0x0001), { models: [{ ...LAMZU_RX, name: 'Aurora 8K receiver' }], rates: R8K, paired: true });
CATALOG.set(ckey(LAMZU_VID, 0x0003), { models: [{ ...LAMZU_RX, name: 'Aurora 1K receiver' }], rates: R1K, paired: true });

// Vancer x Arbiter Studio Akitsu (Arbiter Web HUB device table)
const ARB = 'https://webapp.arbiterstudio.com/Config';
const vancer = (name: string, img: string, dpiMax: number): CompxModel => ({
  brand: 'Vancer', name, img, dpiMax, stages: 5, noXY: true, noHyper: true, sleep: SLEEP_VANCER,
});
add(COMPX_VID, vancer('Akitsu 3395', `${ARB}/TD006/Device.png`, 26000), [0x0009, RV_WIRED], [0x000a, R8K]);
add(COMPX_VID, vancer('Akitsu 3950', `${ARB}/TD006_3950/Device.png`, 30000), [0x0038, RV_WIRED], [0x0039, R8K]);
add(COMPX_VID, vancer('Akitsu Medium 3950', `${ARB}/Akitsu_M_3950/Device_1.png`, 30000), [0x0066, RV_WIRED], [0x0067, R8K]);

// LunaFury (mouse.lunafury.games device table): wired mice answer on target 0
const luna = (name: string, stages: number): CompxModel => ({
  brand: 'LunaFury', name, dpiMax: 30000, stages, noXY: true, sleep: SLEEP_LUNA,
});
add(COMPX_VID, luna('LUNA33', 6), [0x0032, R1K, DONGLE], [0x0033, RALL]);
add(COMPX_VID, luna('TYPE33', 5), [0x0054, RALL, DONGLE], [0x0084, RALL]);

// Attack Shark on CompX (Attack Shark Core device table, via OpenMouse)
const shark = (name: string): CompxModel => ({ brand: 'Attack Shark', name, dpiMax: 42000, stages: 6 });
add(COMPX_VID, shark('R5 Ultra'), [0x0046, R1K], [0x0047, RALL]);
add(COMPX_VID, shark('R6'), [0x0021, R1K], [0x0022, RALL]);
add(COMPX_VID, shark('R8'), [0x003a, R1K], [0x003b, RALL]);

// CRDRAKO KO-ONE: the wired mouse answers on target 0
add(COMPX_VID, { brand: 'CRDRAKO', name: 'KO-ONE', dpiMax: 30000, stages: 6 }, [0x006a, RALL, DONGLE], [0x006b, RALL]);

/** catalog entry for a non-WLMouse CompX-A device (exported for tests / UI) */
export function compxEntry(vid: number, pid: number): Readonly<CatalogEntry> | undefined {
  return CATALOG.get(ckey(vid, pid));
}

/** Brands shipping this same "Compx page/command" protocol, by USB vendor ID. */
function brandOf(vid: number, pid: number): string | null {
  if (vid === VID) return 'WLMouse';
  const e = CATALOG.get(ckey(vid, pid));
  if (e) return e.models[0].brand;
  if (vid === 0x258a && ((pid >= 0x2011 && pid <= 0x2014) || (pid >= 0x2022 && pid <= 0x2025))) return 'Glorious (wireless)';
  return null;
}

const GLORIOUS_PIDS = [0x2011, 0x2012, 0x2013, 0x2014, 0x2022, 0x2023, 0x2024, 0x2025];
const USAGE_PAGES = [0xffff, 0xff00, 0xff02];

/** [model name, official hub UIFolder] by the mouse's wired PID (from Config/env-models.json). */
const MODELS: Record<number, [string, string]> = {
  0xa857: ['BEAST X V2', 'WL_X_V2'],
  0xa859: ['HUAN M', 'WLX_HUANM'],
  0xa861: ['BEAST G', 'WL_G'],
  0xa864: ['HUAN', 'WLX_HUAN'],
  0xa867: ['BEAST MIAO', 'WLX_MIAO'],
  0xa869: ['BEAST MINI PRO', 'WL_MINI_PRO'],
  0xa871: ['BEAST X PRO', 'WL_X_PRO'],
  0xa873: ['STRIDER', 'WLX_STRIDER'],
  0xa875: ['YING', 'WL_YING'],
  0xa879: ['SWORD X', 'WL_SWORD_X'],
  0xa881: ['BEAST MAX', 'WLX_MAX'],
  0xa884: ['BEAST X', 'WLX_EID'],
  0xa886: ['BEAST MINI', 'WL'],
};

export function modelInfo(vid: number, pid: number): [string, string] | undefined {
  return vid === VID ? MODELS[pid] : undefined;
}

/** LOD byte: <1 mm -> 0x80 | tenths, 1<x<2 -> (int << 4) | tenth, integers as-is. */
export function lodEncode(mm: number): number {
  const t = Math.round(mm * 10);
  if (t < 10) return 0x80 | t;
  if (t % 10 === 0) return t / 10;
  return ((Math.floor(t / 10) << 4) | t % 10) & 0xff;
}

export function lodDecode(b: number): number {
  if (b >= 0x80) return (b - 0x80) / 10;
  if (b === 1 || b === 2) return b;
  return ((b >> 4) * 10 + (b & 0x0f)) / 10;
}

const lodOptions = (mode: number) => (mode === LOD_PRECISE ? LOD_FINE : LOD_STD);

type Button = { t: number; d: number[] } | null;
const isLeft = (b: Button) => !!b && b.t === 1 && b.d[0] === 1;

function describeAction(t: number, d: number[]): string {
  const h = (n: number | undefined) => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
  if (t === 4) return `Keyboard key (usage ${h(d[1])})`;
  if (t === 5) return `Media key ${h(d[0])}${h(d[1])}`;
  if (t === 6) return 'Power key';
  if (t >= 16 && t <= 18) return `Macro ${((d[0] ?? 0) << 8) | (d[1] ?? 0)}`;
  if (t === 20) return 'HP / game mode';
  return `Custom (type ${t})`;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => n.toString(16).padStart(4, '0');

function byte(v: number[], i: number): number {
  const b = v[i];
  if (b === undefined) throw new Error('short reply');
  return b;
}

const s = (key: string, label: string, group: string, value: Value): Setting => ({ key, label, group, value });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });
const choice = (options: [string, number][], current: number): Value => ({ kind: 'choice', options, current });
const toggle = (on: boolean): Value => ({ kind: 'toggle', on });

// ---------------------------------------------------------------- product photo skin

const SKIN_PREFIX = 'inputdeck.skin.';

/** Remember the user's colour choice (Config/<folder>/Colors/<n>.png) for a device id. */
export function setSkin(id: string, n: number | string): void {
  try {
    localStorage.setItem(SKIN_PREFIX + id, String(n));
  } catch {
    /* storage unavailable */
  }
}

function getSkin(id: string): string {
  try {
    return localStorage.getItem(SKIN_PREFIX + id) || '1';
  } catch {
    return '1';
  }
}

// ---------------------------------------------------------------- driver

export interface WlMouseOptions {
  /** injectable delay (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

export class WlMouseDriver implements Driver {
  readonly id: string;
  readonly family = 'Compx (WLMouse / Lamzu / Vancer / LunaFury / Attack Shark / CRDRAKO / Glorious wireless)';
  readonly kind = 'mouse' as const;

  /** only WLMouse is checked on real hardware; other CompX-A brands start read-only */
  readonly verified: boolean;

  private readonly brandName: string;
  /** catalog entry for non-WLMouse brands (undefined for WLMouse / Glorious) */
  private readonly entry: CatalogEntry | undefined;
  /** resolved model of a non-WLMouse brand (null while a shared receiver's mouse is unknown) */
  private cat: CompxModel | null = null;
  /** target the mouse answers on (2 through a receiver; some wired mice answer on 0) */
  private readonly mouse: number;
  private modelName: string | null = null;
  private folder: string | null = null;
  private profile = 1;
  private lodMode = LOD_STANDARD;
  /** full 6-entry DPI table [X, Y] as last read/written, plus active stage count */
  private stages: [number, number][] = Array.from({ length: 6 }, () => [0, 0] as [number, number]);
  private count = 0;
  private xy = false;
  /** 1-based active stage */
  private active = 1;
  private dpiMax = 26000;
  /** 6 x RGB stage colours */
  private colors: number[] | null = null;
  /** per physical button 1..5 */
  private buttons: Button[] = [null, null, null, null, null];
  private hyper = false;

  /** where page/cmd sit in received DataViews: 0 = no report-id byte, 1 = leading report id */
  private rxOffset: number | null = null;
  private ioQueue: Promise<unknown> = Promise.resolve();
  private opQueue: Promise<unknown> = Promise.resolve();
  private readonly delay: (ms: number) => Promise<void>;

  constructor(readonly device: HIDDevice, opts: WlMouseOptions = {}) {
    this.delay = opts.sleep ?? realSleep;
    this.id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
    this.brandName = brandOf(device.vendorId, device.productId) ?? 'Compx';
    this.verified = device.vendorId === VID;
    this.entry = device.vendorId === VID ? undefined : CATALOG.get(ckey(device.vendorId, device.productId));
    this.mouse = this.entry?.target ?? MOUSE;
    if (this.entry?.models.length === 1 && !this.entry.paired) {
      this.cat = this.entry.models[0];
      this.modelName = this.cat.name;
    }
    // wired mode: the device PID is the mouse's own PID
    const m = modelInfo(device.vendorId, device.productId);
    if (m) [this.modelName, this.folder] = m;
  }

  brand(): string {
    return this.brandName;
  }

  model(): string {
    return this.modelName ?? (this.device.productName || this.brandName);
  }

  image(): string | undefined {
    if (this.entry) return this.cat?.img;
    if (!this.folder) return undefined;
    return `https://gm.wlmouse.gg/Config/${this.folder}/Colors/${getSkin(this.id)}.png`;
  }

  /** DPI stages this firmware keeps */
  private get maxStages(): number {
    return this.spec?.stages ?? 6;
  }

  /** resolved model, or the first candidate of a shared receiver (same limits for all of them) */
  private get spec(): CompxModel | undefined {
    return this.cat ?? this.entry?.models[0];
  }

  /** detected receive offset (for tests / diagnostics) */
  get reportOffset(): number | null {
    return this.rxOffset;
  }

  private serial<T>(q: 'io' | 'op', fn: () => Promise<T>): Promise<T> {
    const prev = q === 'io' ? this.ioQueue : this.opQueue;
    const r = prev.then(fn, fn);
    const tail = r.catch(() => undefined);
    if (q === 'io') this.ioQueue = tail;
    else this.opQueue = tail;
    return r;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  /** locate [status, 0, target, len, page, cmd] in a received report; -1 if it doesn't echo page/cmd */
  private locate(dv: DataView, page: number, cmd: number): number {
    const fits = (o: number) =>
      dv.byteLength >= o + 6 && dv.getUint8(o + 4) === page && dv.getUint8(o + 5) === cmd;
    const order = this.rxOffset === 1 ? [1, 0] : [0, 1];
    for (const o of order) {
      if (fits(o)) {
        // an offset-1 frame always starts with report id 0
        if (o === 1 && dv.getUint8(0) !== 0 && fits(0)) return 0;
        return o;
      }
    }
    return -1;
  }

  /** One request/response exchange. Low level: prefer get()/setTo(). */
  xfer(target: number, page: number, cmd: number, len: number, payload: number[], waitMs: number): Promise<number[]> {
    if (page === 0xb0) return Promise.reject(new Error('bootloader page is never allowed'));
    if (payload.length > 58) return Promise.reject(new Error('payload too long'));
    return this.serial('io', async () => {
      await this.ensureOpen();
      const req = new Uint8Array(64);
      req[2] = target;
      req[3] = len;
      req[4] = page;
      req[5] = cmd;
      req.set(payload, 6);
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.device.sendFeatureReport(0, req);
        await this.delay(waitMs);
        let resend = false;
        for (let i = 0; i < 10 && !resend; i++) {
          const dv = await this.device.receiveFeatureReport(0);
          const o = this.locate(dv, page, cmd);
          if (o < 0) {
            await this.delay(15);
            continue;
          }
          const status = dv.getUint8(o);
          if (status === 0xa1) {
            this.rxOffset = o;
            const n = Math.min(dv.getUint8(o + 3), 58, dv.byteLength - o - 6);
            const out: number[] = [];
            for (let k = 0; k < n; k++) out.push(dv.getUint8(o + 6 + k));
            return out;
          }
          if (status === 0xa2) throw new Error('not supported');
          if (status === 0xa3) resend = true; // busy / not handled -> resend
          else if (status === 0xa4) throw new Error('mouse is asleep');
          else await this.delay(15); // pending
        }
      }
      throw new Error(`no answer for ${hex2(page)}/${hex2(cmd)} - is the mouse awake?`);
    });
  }

  get(target: number, page: number, cmd: number, len: number, args: number[] = []): Promise<number[]> {
    return this.xfer(target, page, cmd | 0x80, len, args, 30);
  }

  private async tryGet(target: number, page: number, cmd: number, len: number, args: number[] = []): Promise<number[] | null> {
    try {
      return await this.get(target, page, cmd, len, args);
    } catch {
      return null;
    }
  }

  private set(page: number, cmd: number, payload: number[], waitMs: number): Promise<void> {
    return this.setTo(this.mouse, page, cmd, payload, waitMs);
  }

  /** SET with the hard block on destructive / identity commands, whatever the caller does. */
  async setTo(target: number, page: number, cmd: number, payload: number[], waitMs: number): Promise<void> {
    const c = cmd & 0x7f;
    const forbidden =
      page === 0xb0 ||
      page === 0x04 || // macros
      (page === 0x05 && [0x00, 0x04, 0x05, 0x07, 0x09].includes(c)) || // image upload / delete
      (page === 0x00 && [0x00, 0x0a, 0x0b, 0x0d, 0x0f, 0x26].includes(c));
    if (forbidden) throw new Error(`command ${hex2(page)}/${hex2(cmd)} is blocked`);
    await this.xfer(target, page, c, payload.length, payload, waitMs);
  }

  private light: { effect: number; speed: number; rgb: number; bri: number } | undefined;

  /** set by read() when the receiver answers the screen commands */
  screen?: ScreenSupport;

  /**
   * Receiver screen upload (page 0x05, target 0), as the official hub does it:
   * 05/04 [02] start -> per picture a header frame (cmd 00: offset 0 + len32,w16,h16,type)
   * and 32-byte data frames (offset = 9 + n) -> 05/80 read-back of the header -> 05/05 [00] finish.
   * Each frame waits for the receiver's OK before the next one is sent.
   */
  async uploadScreen(images: ScreenImage[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const sc = this.screen;
    if (!sc) throw new Error('this receiver has no screen');
    if (!images.length || images.length > sc.slots) throw new Error(`pick 1 to ${sc.slots} pictures`);
    const total = images.reduce((n, i) => n + i.data.length, 0);
    if (total > sc.maxBytes) throw new Error(`pictures are too big together (${Math.ceil(total / 1024)} KB of ${Math.floor(sc.maxBytes / 1024)} KB)`);
    for (const im of images) {
      if (im.kind === 'still' && (im.width !== sc.width || im.height !== sc.height || im.data.length !== sc.width * sc.height * 2))
        throw new Error(`still pictures must be ${sc.width}×${sc.height} RGB565`);
      if (im.kind === 'gif' && (im.width !== sc.gifSize || im.height !== sc.gifSize)) throw new Error(`GIFs must be ${sc.gifSize}×${sc.gifSize}`);
    }
    const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    const frame = (cmd: number, payload: number[]) => this.xfer(DONGLE, 0x05, cmd, payload.length, payload, 1);
    const CHUNK = 32;
    const steps = images.reduce((n, i) => n + 1 + Math.ceil(i.data.length / CHUNK), 0);
    let done = 0;
    await this.serial('op', async () => {
      await frame(0x04, [0x02]);
      for (const im of images) {
        const type = im.kind === 'gif' ? 4 : 1;
        await frame(0x00, [0, 0, 0, 0, ...be32(im.data.length), ...be16(im.width), ...be16(im.height), type]);
        onProgress?.(++done, steps);
        for (let off = 0; off < im.data.length; off += CHUNK) {
          await frame(0x00, [...be32(9 + off), ...im.data.subarray(off, off + CHUNK)]);
          onProgress?.(++done, steps);
        }
        let ok = false;
        for (let t = 0; t < 30 && !ok; t++) {
          try {
            await this.xfer(DONGLE, 0x05, 0x80, 5, [0, 0, 0, 0, 9], 5);
            ok = true;
          } catch {
            await this.delay(20);
          }
        }
        if (!ok) throw new Error('the receiver did not confirm the picture');
      }
      await frame(0x05, [0x00]);
    });
  }

  /** 05/09 [02]: delete every user picture on the receiver. */
  clearScreen(): Promise<void> {
    return this.serial('op', async () => {
      await this.xfer(DONGLE, 0x05, 0x09, 1, [0x02], 200);
    });
  }

  /**
   * Read-only "which mouse is paired" query to a shared receiver (target 1, 00/8B [02])
   * -> [?, ?, vidHi, vidLo, pidHi, pidLo]. Only the GET is ever sent; 00/0B SET stays blocked.
   */
  private async pairedModel(): Promise<CompxModel | null> {
    const v = await this.tryGet(PAIRING, 0x00, 0x0b, 6, [0x02]);
    if (!v || v.length < 6) return null;
    const e = CATALOG.get(ckey((v[2] << 8) | v[3], (v[4] << 8) | v[5]));
    return e?.models.length === 1 ? e.models[0] : null;
  }

  /** read-only dongle firmware query (works even if the mouse sleeps) */
  identify(): Promise<number[]> {
    return this.get(DONGLE, 0x00, 0x01, 0x10);
  }

  /** 01/01: [profile, count, 6 x (xHi, xLo, yHi, yLo)] - always the full 26 bytes. */
  private writeTable(): Promise<void> {
    const pl = [this.profile, this.count];
    for (const [x, yy] of this.stages) {
      const y = this.xy ? yy : x;
      pl.push((x >> 8) & 0xff, x & 0xff, (y >> 8) & 0xff, y & 0xff);
    }
    return this.set(0x01, 0x01, pl, 200);
  }

  private writeColors(): Promise<void> {
    if (!this.colors) throw new Error('stage colours were not read');
    return this.set(0x02, 0x01, [this.profile, ...this.colors], 100);
  }

  private async writeButton(btn: number, t: number, data: number[]): Promise<void> {
    // official rule: at least one button must stay Left click
    const wouldBeLeft = t === 1 && data[0] === 1;
    const othersLeft = this.buttons.some((b, i) => i !== btn && isLeft(b));
    if (!wouldBeLeft && !othersLeft) {
      throw new Error(
        'at least one button must stay "Left click". Map another button to Left click first (Apply), then change this one',
      );
    }
    await this.set(0x03, 0x00, [this.profile, btn + 1, 0x00, t, data.length, ...data], 60);
    this.buttons[btn] = { t, d: [...data] };
  }

  private async readButton(btn: number): Promise<Button> {
    const v = await this.tryGet(this.mouse, 0x03, 0x00, 0x0f, [this.profile, btn, 0x00, 0xff, 0x0a]);
    // [profile, button, 0, type, len, data...]
    if (!v || v.length < 5 || v[1] !== btn) return null;
    const n = Math.min(v[4], v.length - 5);
    return { t: v[3], d: v.slice(5, 5 + n) };
  }

  private colorOf(i: number): number {
    const c = this.colors!;
    return (c[i * 3] << 16) | (c[i * 3 + 1] << 8) | c[i * 3 + 2];
  }

  read(): Promise<Setting[]> {
    return this.serial('op', () => this.doRead());
  }

  write(st: Setting): Promise<void> {
    return this.serial('op', () => this.doWrite(st));
  }

  close(): Promise<void> {
    return this.serial('op', () =>
      this.serial('io', async () => {
        if (this.device.opened) await this.device.close();
      }),
    );
  }

  private async doRead(): Promise<Setting[]> {
    const out: Setting[] = [];

    // --- info
    let fw: number[];
    try {
      fw = await this.get(this.mouse, 0x00, 0x01, 0x10);
    } catch (e) {
      throw new Error(
        `Mouse isn't answering (${(e as Error).message}). Turn it on / move it to wake it, then press Re-read.`,
      );
    }
    let model: string | undefined;
    if (this.entry) {
      // other CompX-A brands: the model comes from the USB product ID (catalog); a receiver
      // shared by several mice is asked which mouse is paired to it
      if (!this.cat) this.cat = await this.pairedModel();
      const e = this.entry;
      this.modelName = this.cat?.name ?? (e.models.length === 1 ? e.models[0].name : `${this.brandName} receiver`);
      this.folder = null;
    } else {
      const pid = (byte(fw, 4) << 8) | byte(fw, 5);
      const vid = this.brandName === 'WLMouse' ? VID : 0;
      const info = modelInfo(vid, pid);
      this.modelName = info ? info[0] : `(model ${hex4(pid).toUpperCase()})`;
      this.folder = info ? info[1] : null;
      model = info?.[0];
    }
    out.push(text('model', 'Model', 'Info', this.modelName));
    if (this.folder) out.push(text('ui_folder', 'Model folder', 'Info', this.folder));
    if (fw.length >= 4) out.push(text('fw', 'Mouse firmware', 'Info', `${fw[0]}.${fw[1]}.${fw[2]}.${fw[3]}`));
    // a wired mouse that answers on target 0 has no separate receiver
    const d = this.mouse === DONGLE ? null : await this.tryGet(DONGLE, 0x00, 0x01, 0x10);
    if (d && d.length >= 4) out.push(text('dongle_fw', 'Receiver firmware', 'Info', `${d[0]}.${d[1]}.${d[2]}.${d[3]}`));
    const b = await this.tryGet(this.mouse, 0x00, 0x03, 2);
    if (b) {
      const charging = byte(b, 0) === 1 ? ' (charging)' : '';
      out.push(text('battery', 'Battery', 'Info', `${byte(b, 1)}%${charging}`));
    }

    // --- profile
    this.profile = byte(await this.get(this.mouse, 0x00, 0x05, 1), 0);
    const cnt = await this.tryGet(this.mouse, 0x00, 0x06, 1);
    const count = Math.max(1, cnt?.[0] ?? 1);
    const p = this.profile;
    // 00/8E [p] -> [p, byteLen, UTF-16LE name]
    const names: (string | null)[] = [];
    for (let i = 1; i <= count; i++) {
      const v = await this.tryGet(this.mouse, 0x00, 0x0e, 0x3a, [i]);
      let name: string | null = null;
      if (v && v.length >= 2) {
        const n = Math.min(v[1], v.length - 2);
        let str = '';
        for (let k = 2; k + 1 < 2 + n; k += 2) {
          const u = v[k] | (v[k + 1] << 8);
          if (u === 0) break;
          str += String.fromCharCode(u);
        }
        str = str.trim();
        if (str) name = str;
      }
      names.push(name);
    }
    const options: [string, number][] = names.map((n, idx) => {
      const i = idx + 1;
      return n && n !== `Profile ${i}` ? [`${i}: ${n}`, i] : [`Profile ${i}`, i];
    });
    out.push(s('profile', 'Active profile (all settings below belong to it)', 'Profile', choice(options, p)));
    const pname = names[p - 1];
    if (pname) out.push(text('profile_name', 'Profile name', 'Profile', pname));

    // --- DPI
    const mx = await this.tryGet(this.mouse, 0x01, 0x0c, 2);
    const spec = this.spec;
    this.dpiMax = mx && mx.length >= 2 ? (mx[0] << 8) | mx[1] : (spec?.dpiMax ?? 26000);
    const step = model === 'HUAN M' ? 1 : 50;
    const maxStages = this.maxStages;
    const t = await this.get(this.mouse, 0x01, 0x01, 0x0a, [p, maxStages]);
    this.count = Math.min(maxStages, Math.max(1, byte(t, 1)));
    for (let i = 0; i < 6; i++) {
      const o = 2 + i * 4;
      this.stages[i] = t.length >= o + 4 ? [(t[o] << 8) | t[o + 1], (t[o + 2] << 8) | t[o + 3]] : [0, 0];
    }
    this.active = Math.min(this.count, Math.max(1, byte(await this.get(this.mouse, 0x01, 0x02, 2, [p]), 1)));
    this.xy = ((await this.tryGet(this.mouse, 0x01, 0x0d, 2, [p]))?.[1] ?? 0) !== 0;
    const c = await this.tryGet(this.mouse, 0x02, 0x01, 0x13, [p]);
    this.colors = c && c.length >= 19 ? c.slice(1, 19) : null;
    const n = this.count;
    const active = this.active - 1;
    const colors = this.colors ? Array.from({ length: n }, (_, i) => this.colorOf(i)) : undefined;
    const dpiVal = (stages: number[]): Value => ({
      kind: 'dpi', stages, active, min: 50, max: this.dpiMax, step, ...(colors ? { colors } : {}),
    });
    out.push(s('dpi', this.xy ? 'DPI stages (X)' : 'DPI stages', 'DPI', dpiVal(this.stages.slice(0, n).map((v) => v[0]))));
    if (this.xy) out.push(s('dpi_y', 'DPI stages (Y)', 'DPI', dpiVal(this.stages.slice(0, n).map((v) => v[1]))));
    out.push(s('dpi_count', 'Number of DPI stages', 'DPI', choice(Array.from({ length: maxStages }, (_, i) => [String(i + 1), i + 1]), this.count)));
    // the maker's hub hides separate X/Y for some models; still shown if it is somehow on
    if (!spec?.noXY || this.xy) out.push(s('dpi_xy', 'Separate X / Y DPI', 'DPI', toggle(this.xy)));
    if (this.colors) {
      for (let i = 0; i < 6; i++) {
        out.push(s(COLOR_KEYS[i], `Stage ${i + 1} colour`, 'DPI', { kind: 'color', rgb: this.colorOf(i) }));
      }
    }

    // --- performance
    let code = byte(await this.get(this.mouse, 0x01, 0x00, 2, [p]), 1);
    if (code === 0x10) code = 0x01; // alternate encoding of 1000 Hz
    const rates = this.entry?.rates;
    const pollOpts: [string, number][] = POLLING.filter(([l]) => !rates || rates.includes(parseInt(l, 10))).map(([l, v]) => [l, v]);
    if (rates && !pollOpts.some(([, v]) => v === code)) {
      const known = POLLING.find(([, v]) => v === code);
      pollOpts.push(known ? [known[0], code] : [`Code ${hex2(code)}`, code]);
    }
    out.push(s('polling', 'Polling rate', 'Performance', choice(pollOpts, code)));
    const l = await this.tryGet(this.mouse, 0x01, 0x08, 3, [p]);
    if (l) {
      const lod = byte(l, 1);
      this.lodMode = l[2] ?? LOD_STANDARD;
      if (model === 'HUAN M' || this.lodMode === LOD_PRECISE) {
        out.push(s('lod_mode', 'Lift-off distance mode', 'Performance', choice(
          [['Standard', LOD_STANDARD], ['Precise', LOD_PRECISE]],
          this.lodMode === LOD_PRECISE ? LOD_PRECISE : LOD_STANDARD,
        )));
      }
      const opts: [string, number][] = lodOptions(this.lodMode).map((mm) => [`${mm} mm`, lodEncode(mm)]);
      if (!opts.some((o) => o[1] === lod)) opts.push([`${lodDecode(lod)} mm`, lod]);
      out.push(s('lod', 'Lift-off distance', 'Performance', choice(opts, lod)));
    }
    const hv = spec?.noHyper ? null : await this.tryGet(this.mouse, 0x01, 0x0b, 2, [p]);
    if (hv) {
      this.hyper = byte(hv, 1) !== 0;
      out.push(s('hyper', 'High-speed mode', 'Performance', toggle(this.hyper)));
      const tv = await this.tryGet(this.mouse, 0x01, 0x13, 2, [p]);
      if (tv) out.push(s('turbo', 'Turbo mode (needs high-speed mode)', 'Performance', toggle(byte(tv, 1) !== 0)));
    }
    for (const [key, label, cmd] of TOGGLES) {
      const v = await this.tryGet(this.mouse, 0x01, cmd, 2, [p]);
      if (v) out.push(s(key, label, 'Performance', toggle(byte(v, 1) !== 0)));
    }
    const at = await this.tryGet(this.mouse, 0x01, 0x14, 2, [p]);
    if (at) {
      const raw = byte(at, 1);
      const deg = raw <= 30 ? raw : raw - 256;
      out.push(s('angle_tune', 'Angle tune', 'Performance', {
        kind: 'number', min: -30, max: 30, current: Math.min(30, Math.max(-30, deg)), unit: '°',
      }));
    }
    const cb = await this.tryGet(this.mouse, 0x03, 0x01, 2, [p]);
    if (cb) out.push(s('combo', 'Button combination', 'Performance', toggle(byte(cb, 1) !== 0)));

    // --- buttons
    for (let bi = 0; bi < 5; bi++) {
      const btn = await this.readButton(bi + 1);
      this.buttons[bi] = btn;
      if (!btn) continue;
      const opts: [string, number][] = ACTIONS.map((a, i) => [a[0], i]);
      let current = ACTIONS.findIndex(
        (a) => a[1] === btn.t && (a[1] === 0 || (a[2].length === btn.d.length && a[2].every((x, k) => x === btn.d[k]))),
      );
      if (current < 0) {
        opts.unshift([`${describeAction(btn.t, btn.d)} (keep)`, KEEP]);
        current = KEEP;
      }
      out.push(s(BTN_KEYS[bi], BTN_LABELS[bi], 'Buttons', choice(opts, current)));
    }
    const db = await this.tryGet(this.mouse, 0x00, 0x08, 2, [p]);
    if (db) out.push(s('debounce', 'Click debounce', 'Buttons', { kind: 'number', min: 0, max: 15, current: byte(db, 1), unit: ' ms' }));

    // --- power
    const sl = await this.tryGet(this.mouse, 0x00, 0x07, 3, [p]);
    if (sl) {
      let secs = (byte(sl, 1) << 8) | byte(sl, 2);
      if (secs === 0 || secs >= 0xff00) secs = SLEEP_NEVER; // official treats 0, 0xFF00 and 0xFFFF as disabled
      const list = spec?.sleep ?? SLEEP;
      const opts: [string, number][] = list.map(([a, v]) => [a, v]);
      if (!list.some(([, v]) => v === secs)) opts.push([secs === SLEEP_NEVER ? 'Never' : `${secs} sec`, secs]);
      out.push(s('sleep', 'Sleep after', 'Power', choice(opts, secs)));
    }

    // --- hidden by the maker: mouse RGB light (02/80 effect, 02/82 brightness). WLMouse's hub
    // reads these on every open but hides the menu for HUAN M (LightScrollEnable=0).
    const le = await this.tryGet(this.mouse, 0x02, 0x00, 26, [1]);
    const lb = le ? await this.tryGet(this.mouse, 0x02, 0x02, 3, [1, 0]) : null;
    if (le && lb && le.length >= 8) {
      const effect = byte(le, 2);
      this.light = { effect, speed: Math.min(6, Math.max(1, 7 - byte(le, 4))), rgb: ((le[5] << 16) | (le[6] << 8) | le[7]) >>> 0, bri: byte(lb, 2) };
      const A = 'Advanced';
      const opts: [string, number][] = [['Off', 0], ['Single colour', 4], ['Breathing', 5]];
      if (!opts.some(([, v]) => v === effect)) opts.push([`Effect ${effect}`, effect]);
      out.push({ key: 'rgb_effect', label: 'Mouse RGB lighting', group: A, value: choice(opts, effect), hint: 'hidden' });
      out.push(s('rgb_color', 'Light colour', A, { kind: 'color', rgb: this.light.rgb }));
      out.push(s('rgb_bri', 'Light brightness', A, { kind: 'number', min: 0, max: 100, current: Math.round((this.light.bri / 255) * 100), unit: '%' }));
      out.push(s('rgb_speed', 'Breathing speed', A, { kind: 'number', min: 1, max: 6, current: this.light.speed, unit: '' }));
    }
    // --- features other WLMouse models have: checked with read-only queries, listed when missing
    const probes: [string, number, number, number, number, number[]][] = [
      ['Adaptive DPI', this.mouse, 0x01, 0x1a, 9, [p]],
      ['Sensor COG offset', this.mouse, 0x01, 0x15, 3, [p]],
      ['Wheel BHOP', this.mouse, 0x00, 0x24, 5, [p]],
      ['Scroll HP', this.mouse, 0x00, 0x19, 4, [p]],
      ['DPI indicator', this.mouse, 0x02, 0x04, 2, [p]],
      ['Touch shortcut', DONGLE, 0x05, 0x0c, 3, [0, 1]],
    ];
    const missing: string[] = [];
    const present: string[] = [];
    for (const [name, t, pg, c, n, args] of probes) ((await this.tryGet(t, pg, c, n, args)) ? present : missing).push(name);
    if (missing.length) out.push(text('fw_missing', 'Not on this firmware', 'Advanced', missing.join('|')));
    if (present.length) out.push(text('fw_present', 'On this firmware', 'Advanced', present.join('|')));

    // --- receiver screen (page 0x05 on the dongle, target 0)
    const se = await this.tryGet(DONGLE, 0x05, 0x06, 1);
    if (se) {
      const G = 'Dongle screen';
      this.screen = {
        width: 360, height: 360, round: true, slots: 8, maxBytes: 650 * 1024 - 1, gifSize: 224,
        upload: (images, onProgress) => this.uploadScreen(images, onProgress),
        clear: () => this.clearScreen(),
      };
      out.push(s('screen_effect', 'Screen effect (show images)', G, toggle(byte(se, 0) !== 0)));
      const ss = await this.tryGet(DONGLE, 0x05, 0x0a, 1);
      if (ss) out.push(s('screen_status', 'Show mouse status on screen', G, toggle(byte(ss, 0) !== 0)));
      const vo = await this.tryGet(DONGLE, 0x06, 0x00, 1);
      if (vo) out.push(s('voice', 'Voice', G, toggle(byte(vo, 0) !== 0)));
      // 05/88 [0, slot] -> [0, slot, sizeBE32, wBE16, hBE16, type]; FF.. = empty slot
      const used: string[] = [];
      for (let slot = 1; slot <= 8; slot++) {
        const h = await this.tryGet(DONGLE, 0x05, 0x08, 0x0b, [0, slot]);
        if (!h) break;
        if (h.length >= 11 && !(h[2] === 0xff && h[3] === 0xff && h[4] === 0xff && h[5] === 0xff)) {
          const w = (h[6] << 8) | h[7];
          const hh = (h[8] << 8) | h[9];
          used.push(`${h[10] === 4 ? 'GIF' : 'image'} ${w}×${hh}`);
        }
      }
      out.push(text('screen_images', 'Stored screen images', G, used.length ? `${used.length} of 8: ${used.join(', ')}` : 'none'));
    }
    return out;
  }

  private async doWrite(st: Setting): Promise<void> {
    const p = this.profile;
    const v = st.value;
    const bad = () => new Error(`bad value for ${st.key}`);

    const bi = BTN_KEYS.indexOf(st.key);
    if (bi >= 0) {
      if (v.kind !== 'choice') throw bad();
      if (v.current === KEEP) return;
      const a = ACTIONS[v.current];
      if (!a) throw new Error('unknown action');
      return this.writeButton(bi, a[1], a[2]);
    }
    const ci = COLOR_KEYS.indexOf(st.key);
    if (ci >= 0) {
      if (v.kind !== 'color') throw bad();
      if (!this.colors) throw new Error('stage colours were not read');
      this.colors.splice(ci * 3, 3, (v.rgb >> 16) & 0xff, (v.rgb >> 8) & 0xff, v.rgb & 0xff);
      return this.writeColors();
    }

    if (st.key.startsWith('rgb_')) {
      if (!this.light) throw new Error('lighting was not read');
      const l = { ...this.light };
      if (st.key === 'rgb_effect' && v.kind === 'choice') l.effect = v.current;
      else if (st.key === 'rgb_color' && v.kind === 'color') l.rgb = v.rgb;
      else if (st.key === 'rgb_bri' && v.kind === 'number') l.bri = Math.round((Math.min(100, Math.max(0, v.current)) / 100) * 255);
      else if (st.key === 'rgb_speed' && v.kind === 'number') l.speed = Math.min(6, Math.max(1, v.current));
      else throw bad();
      // same order as the official hub: brightness, then effect
      await this.set(0x02, 0x02, [1, 0, l.bri], 60);
      await this.set(0x02, 0x00, [1, 0, l.effect, 0, 7 - l.speed, (l.rgb >> 16) & 0xff, (l.rgb >> 8) & 0xff, l.rgb & 0xff], 60);
      this.light = l;
      return;
    }

    switch (st.key) {
      case 'profile':
        if (v.kind !== 'choice') throw bad();
        await this.set(0x00, 0x05, [v.current & 0xff], 150);
        this.profile = v.current & 0xff;
        return;
      case 'polling':
        if (v.kind !== 'choice') throw bad();
        return this.set(0x01, 0x00, [p, v.current & 0xff], 60);
      case 'lod_mode':
        if (v.kind !== 'choice') throw bad();
        // official: switching mode resets LOD to 1 mm
        this.lodMode = v.current & 0xff;
        return this.set(0x01, 0x08, [p, 0x01, this.lodMode], 60);
      case 'lod': {
        if (v.kind !== 'choice') throw bad();
        const code = v.current & 0xff;
        // value belongs to the other mode (mode changed in the same apply)
        if (!lodOptions(this.lodMode).some((mm) => lodEncode(mm) === code)) return;
        return this.set(0x01, 0x08, [p, code, this.lodMode], 60);
      }
      case 'debounce':
        if (v.kind !== 'number') throw bad();
        return this.set(0x00, 0x08, [p, Math.min(15, Math.max(0, Math.round(v.current)))], 60);
      case 'angle_tune':
        if (v.kind !== 'number') throw bad();
        return this.set(0x01, 0x14, [p, Math.min(30, Math.max(-30, Math.round(v.current))) & 0xff], 60);
      case 'sleep':
        if (v.kind !== 'choice') throw bad();
        return this.set(0x00, 0x07, [p, (v.current >> 8) & 0xff, v.current & 0xff], 60);
      case 'dpi':
      case 'dpi_y': {
        if (v.kind !== 'dpi') throw bad();
        if (v.stages.length < 1 || v.stages.length > this.maxStages) throw new Error(`need 1-${this.maxStages} DPI stages`);
        const isX = st.key === 'dpi';
        v.stages.forEach((dd, i) => {
          const val = Math.min(v.max, Math.max(v.min, Math.round(dd))) & 0xffff;
          if (isX) this.stages[i][0] = val;
          else this.stages[i][1] = val;
        });
        // the UI may add / remove stages through the dpi value itself
        if (isX && v.stages.length !== this.count) {
          for (let i = this.count; i < v.stages.length; i++) if (!this.xy) this.stages[i][1] = this.stages[i][0];
          this.count = v.stages.length;
        }
        await this.writeTable();
        if (isX) {
          this.active = Math.min(Math.max(0, v.active), this.count - 1) + 1;
          await this.set(0x01, 0x02, [p, this.active], 60);
        }
        if (v.colors && this.colors) {
          let changed = false;
          v.colors.slice(0, 6).forEach((rgb, i) => {
            if (rgb !== this.colorOf(i)) {
              this.colors!.splice(i * 3, 3, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
              changed = true;
            }
          });
          if (changed) await this.writeColors();
        }
        return;
      }
      case 'dpi_count': {
        if (v.kind !== 'choice') throw bad();
        const n = Math.min(this.maxStages, Math.max(1, v.current));
        if (this.active > n) {
          this.active = n;
          await this.set(0x01, 0x02, [p, n], 60);
        }
        // like the official hub: fill unused (zero) stages with defaults
        for (let i = 0; i < n; i++) {
          if (this.stages[i][0] === 0) {
            const dd = DEFAULT_STAGES[i] ?? Math.min(this.dpiMax, 0xffff);
            this.stages[i] = [dd, dd];
          }
        }
        this.count = n;
        return this.writeTable();
      }
      case 'dpi_xy':
        if (v.kind !== 'toggle') throw bad();
        await this.set(0x01, 0x0d, [p, v.on ? 1 : 0], 60);
        this.xy = v.on;
        return this.writeTable();
      case 'hyper':
        if (v.kind !== 'toggle') throw bad();
        await this.set(0x01, 0x0b, [p, v.on ? 1 : 0], 60);
        this.hyper = v.on;
        if (!v.on) await this.set(0x01, 0x13, [p, 0], 60); // official turns turbo off with it
        return;
      case 'turbo':
        if (v.kind !== 'toggle') throw bad();
        if (v.on && !this.hyper) throw new Error('turn on High-speed mode first');
        return this.set(0x01, 0x13, [p, v.on ? 1 : 0], 60);
      case 'combo':
        if (v.kind !== 'toggle') throw bad();
        return this.set(0x03, 0x01, [p, v.on ? 1 : 0], 60);
      case 'screen_effect':
        if (v.kind !== 'toggle') throw bad();
        return this.setTo(DONGLE, 0x05, 0x06, [v.on ? 1 : 0], v.on ? 200 : 1000);
      case 'screen_status':
        if (v.kind !== 'toggle') throw bad();
        return this.setTo(DONGLE, 0x05, 0x0a, [v.on ? 1 : 0], 100);
      case 'voice':
        if (v.kind !== 'toggle') throw bad();
        return this.setTo(DONGLE, 0x06, 0x00, [v.on ? 1 : 0], 300);
    }
    const tg = TOGGLES.find((x) => x[0] === st.key);
    if (tg) {
      if (v.kind !== 'toggle') throw bad();
      return this.set(0x01, tg[2], [p, v.on ? 1 : 0], 60);
    }
    throw new Error(`${st.key} can't be changed`);
  }
}

/** open + identify (read-only dongle firmware query); null if the device doesn't answer */
export async function openWlMouse(device: HIDDevice, opts: WlMouseOptions = {}): Promise<WlMouseDriver | null> {
  if (!wlmouseFactory.match(device)) return null;
  const wasOpen = device.opened;
  try {
    if (!device.opened) await device.open();
    const drv = new WlMouseDriver(device, opts);
    await drv.identify();
    return drv;
  } catch {
    if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    return null;
  }
}

export const wlmouseFactory: DriverFactory = {
  name: 'WLMouse / Compx',
  filters: [
    { vendorId: VID },
    // other CompX-A brands: only catalogued product IDs (never their bootloaders)
    ...[...CATALOG.keys()].map((k) => ({ vendorId: Math.floor(k / 0x10000), productId: k % 0x10000 })),
    ...GLORIOUS_PIDS.map((productId) => ({ vendorId: 0x258a, productId })),
  ],
  match(d: HIDDevice): boolean {
    if (!brandOf(d.vendorId, d.productId)) return false;
    return (d.collections ?? []).some(
      (c) => USAGE_PAGES.includes(c.usagePage ?? -1) && (c.featureReports?.length ?? 0) > 0,
    );
  },
  create: (d: HIDDevice) => openWlMouse(d),
};
