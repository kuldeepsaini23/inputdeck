// Razer gaming mice (VID 0x1532) over the 90-byte "Razer report" on feature report 0.
// Protocol layout and per-model quirks taken from OpenRazer's documentation/driver
// (driver/razermouse_driver.c, razercommon.h, razerchromacommon.c); this is our own code.
//
// Report (90 bytes):
//   [0] status        0x00 new, 0x01 busy, 0x02 ok, 0x03 failure, 0x04 timeout, 0x05 not supported
//   [1] transaction id (differs per model AND sometimes per command, see MODELS)
//   [2..3] remaining packets (big endian, always 0 here)
//   [4] protocol type (0)
//   [5] data size (argument bytes used)
//   [6] command class
//   [7] command id (bit 7 set = get, clear = set)
//   [8..87] arguments x80
//   [88] crc = XOR of bytes 2..87
//   [89] reserved (0)
// The host writes the request with SET_FEATURE, waits a model-specific time, then reads the
// answer with GET_FEATURE.
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';
import { sleep as realSleep } from './types';

export const RAZER_VID = 0x1532;
const REPORT_ID = 0;
export const REPORT_LEN = 90;

const ST_BUSY = 0x01;
const ST_OK = 0x02;
const ST_FAIL = 0x03;
const ST_TIMEOUT = 0x04;
const ST_UNSUPPORTED = 0x05;

const VARSTORE = 0x01;
const NOSTORE = 0x00;

// ---------------------------------------------------------------- commands

/** Every command this driver may send: [class, id, data size]. Nothing else goes out. */
export const CMD = {
  getFirmware: [0x00, 0x81, 0x02],
  getSerial: [0x00, 0x82, 0x16],
  getPoll: [0x00, 0x85, 0x01],
  setPoll: [0x00, 0x05, 0x01],
  getPoll2: [0x00, 0xc0, 0x01],
  setPoll2: [0x00, 0x40, 0x02],
  getDpi: [0x04, 0x85, 0x07],
  setDpi: [0x04, 0x05, 0x07],
  getStages: [0x04, 0x86, 0x26],
  setStages: [0x04, 0x06, 0x26],
  getBattery: [0x07, 0x80, 0x02],
  getLowBattery: [0x07, 0x81, 0x01],
  getIdle: [0x07, 0x83, 0x02],
  getCharging: [0x07, 0x84, 0x02],
  setLowBattery: [0x07, 0x01, 0x01],
  setIdle: [0x07, 0x03, 0x02],
} as const satisfies Record<string, readonly [number, number, number]>;
type CmdName = keyof typeof CMD;

/** "class:id" -> data size. Firmware update, bootloader, device mode, factory reset etc. are not here. */
const ALLOWED = new Map<string, number>(Object.values(CMD).map(([c, i, n]) => [`${c}:${i}`, n]));
export const isAllowed = (cls: number, id: number) => ALLOWED.has(`${cls}:${id}`);

// ---------------------------------------------------------------- models

/** Which transaction id a command family uses, when the model deviates from its default. */
type Feature = 'info' | 'dpi' | 'stages' | 'poll' | 'battery' | 'charging' | 'idle' | 'lowBattery';

/** Which family each command belongs to (for per-family transaction id overrides). */
const FEATURE_OF: Record<CmdName, Feature> = {
  getFirmware: 'info',
  getSerial: 'info',
  getPoll: 'poll',
  setPoll: 'poll',
  getPoll2: 'poll',
  setPoll2: 'poll',
  getDpi: 'dpi',
  setDpi: 'dpi',
  getStages: 'stages',
  setStages: 'stages',
  getBattery: 'battery',
  getLowBattery: 'lowBattery',
  getIdle: 'idle',
  getCharging: 'charging',
  setLowBattery: 'lowBattery',
  setIdle: 'idle',
};

export interface Model {
  name: string;
  /** default transaction id */
  tid: number;
  /** per-feature transaction id overrides (from OpenRazer's per-attribute switch tables) */
  tids?: Partial<Record<Feature, number>>;
  /** per-command overrides, for models whose get and set (or firmware and serial) differ */
  cmdTids?: Partial<Record<CmdName, number>>;
  /** false when the mouse has no DPI stages (only the current DPI is read / written) */
  stages?: boolean;
  maxDpi: number;
  /** 'classic' = class 0 cmd 05/85 (125/500/1000 Hz); 'hyper' = class 0 cmd 40/C0 (up to 8000 Hz) */
  poll: 'classic' | 'hyper';
  maxHz: number;
  /** has a battery (wired and wireless PIDs of a wireless mouse both answer battery queries) */
  battery: boolean;
  /** battery can report charging (false for AA-powered mice) */
  charging?: boolean;
  /** this PID is a wireless receiver / dongle rather than the cable */
  receiver: boolean;
  /** supports the low-battery warning threshold */
  lowBattery?: boolean;
  /** hyperpolling: transaction id of the second (arg 0x01) set-polling packet */
  poll2SecondTid?: number;
  /** ms to wait between SET_FEATURE and GET_FEATURE */
  waitMs: number;
  /** official top-down product photo on Razer's CDN (transparent PNG, 500x500) */
  image?: string;
}

const IMG = 'https://medias-p1.phoenix.razer.com/sys-master-phoenix-images-container/';
const I = {
  da3: IMG + 'h79/haf/9529652674590/deathadder-v3-2-500x500.png',
  da3pro: IMG + 'hc9/h51/9449963946014/deathadder-v3-pro-black-v2-500x500.png',
  da3hs: IMG + 'h79/h1f/9786703085598/deathadder-v3-hyperspeed-2-500x500.png',
  da4pro: IMG + 'h01/hf3/9926511951902/deathadder-v4-pro-black-500x500.png',
  v2pro: IMG + 'h9f/h4c/9529653461022/viper-v2-pro-black-2-500x500.png',
  v3pro: IMG + 'h08/h61/9765618188318/viper-v3-pro-black-500x500.png',
  v3proSe: IMG + 'h55/h10/10011389198366/viper-v3-pro-se-500x500.png',
  v3hs: IMG + 'h21/h26/9767046578206/240424-Viper-V3-Hyperspeed_500x500.png',
  bv3: IMG + 'hf7/hb6/9529652412446/basilisk-v3-2-500x500.png',
  bv3_35k: IMG + 'he4/h63/9822107926558/basilisk-v3-35k-2-500x500.png',
  bv3pro: IMG + 'ha0/hb6/9529652445214/basilisk-v3-pro-black-2-500x500.png',
  bv3pro35k: IMG + 'h5a/h1c/9821720576030/basilisk-v3-pro-35k-500x500.png',
  bv3pro35kPg: IMG + 'h48/h82/9917235167262/basilisk-v3-pro-35k-phantom-green-500x500.png',
  cobra: IMG + 'h54/h60/9591466950686/cobra-500x500.png',
  cobraPro: IMG + 'h35/hcc/9594549370910/cobra-pro-500x500-2.png',
  orochiV2: IMG + 'h63/h8c/10078843797534/orochi-v2-2026-black-2-500x500.png',
};

// OpenRazer wait times (razer_get_report): 31 ms "new receiver", 59.9 ms "viper receiver",
// 400 ms Atheris / Orochi V2, 0.6 ms for everything else.
const W_NEW = 31;
const W_VIPER = 60;
const W_SLOW = 400;
const W_WIRED = 1;

/** A wired-only mouse: no battery, classic 125/500/1000 Hz polling. */
const wired = (name: string, tid: number, maxDpi: number, extra: Partial<Model> = {}): Model => ({
  name,
  tid,
  maxDpi,
  poll: 'classic',
  maxHz: 1000,
  battery: false,
  receiver: false,
  waitMs: W_WIRED,
  ...extra,
});

/** A wireless mouse (its cable PID or its receiver PID): battery, charging, sleep timer, low-battery warning. */
const wl = (name: string, maxDpi: number, image: string | undefined, receiver: boolean, extra: Partial<Model> = {}): Model => ({
  name,
  tid: 0x1f,
  maxDpi,
  poll: 'classic',
  maxHz: 1000,
  battery: true,
  charging: true,
  receiver,
  lowBattery: true,
  waitMs: W_NEW,
  image,
  ...extra,
});

/**
 * Every PID we drive. Facts only (USB product ids, transaction id per command, wait time, max DPI,
 * polling scheme) from OpenRazer's public device tables: driver/razermouse_driver.h (PIDs),
 * driver/razermouse_driver.c (per-attribute transaction id switches, razer_get_report wait times,
 * the polling_rate2 "send twice" lists) and daemon/openrazer_daemon/hardware/mouse.py (DPI_MAX,
 * POLL_RATES). Wireless mice appear twice: once for the cable PID, once for the receiver PID.
 * Any other Razer PID is still recognized, as "not supported yet" (see UnsupportedRazer).
 */
export const MODELS: Record<number, Model> = {
  // ---- DeathAdder
  0x005c: wired('DeathAdder Elite', 0x3f, 16000, { stages: false }),
  0x006e: wired('DeathAdder Essential', 0xff, 6400, { stages: false }),
  0x0071: wired('DeathAdder Essential (White Edition)', 0xff, 6400, { stages: false }),
  0x0098: wired('DeathAdder Essential (2021)', 0xff, 6400, { stages: false }),
  0x0084: wired('DeathAdder V2', 0x3f, 20000, { stages: false }),
  0x008c: wired('DeathAdder V2 Mini', 0x3f, 8500, { tids: { stages: 0xff } }),
  0x00a1: wired('DeathAdder V2 Lite', 0x1f, 8500, { tids: { stages: 0xff } }),
  0x007c: wl('DeathAdder V2 Pro', 20000, undefined, false, { tid: 0x3f, tids: { stages: 0xff, idle: 0xff, lowBattery: 0xff }, waitMs: W_VIPER }),
  0x007d: wl('DeathAdder V2 Pro', 20000, undefined, true, { tid: 0x3f, tids: { stages: 0xff, idle: 0xff, lowBattery: 0xff }, waitMs: W_VIPER }),
  // AA battery: no charging status
  0x009c: wl('DeathAdder V2 X HyperSpeed', 14000, undefined, true, { charging: false, tids: { lowBattery: 0xff } }),
  0x00b2: { name: 'DeathAdder V3', tid: 0x1f, maxDpi: 30000, poll: 'hyper', maxHz: 8000, battery: false, receiver: false, waitMs: W_WIRED, image: I.da3 },
  0x00b6: wl('DeathAdder V3 Pro', 30000, I.da3pro, false),
  0x00b7: wl('DeathAdder V3 Pro', 30000, I.da3pro, true),
  0x00c2: wl('DeathAdder V3 Pro', 30000, I.da3pro, false),
  // the later receiver PID uses extended polling, second packet with transaction 0xff (like the HyperPolling dongle)
  0x00c3: wl('DeathAdder V3 Pro', 30000, I.da3pro, true, { poll: 'hyper', maxHz: 8000, poll2SecondTid: 0xff }),
  0x00c4: wl('DeathAdder V3 HyperSpeed', 26000, I.da3hs, false),
  0x00c5: wl('DeathAdder V3 HyperSpeed', 26000, I.da3hs, true),
  0x00be: wl('DeathAdder V4 Pro', 45000, I.da4pro, false, { poll: 'hyper', maxHz: 8000 }),
  0x00bf: wl('DeathAdder V4 Pro', 45000, I.da4pro, true, { poll: 'hyper', maxHz: 8000 }),

  // ---- Viper
  0x0078: wired('Viper', 0xff, 16000),
  0x008a: wired('Viper Mini', 0xff, 8500),
  // Viper 8K: everything on 0xff except extended polling (0x1f, second packet 0xff)
  0x0091: wired('Viper 8K Hz', 0xff, 20000, { poll: 'hyper', maxHz: 8000, tids: { poll: 0x1f }, poll2SecondTid: 0xff }),
  0x007a: wl('Viper Ultimate', 20000, undefined, false, { tid: 0xff, waitMs: W_VIPER }),
  0x007b: wl('Viper Ultimate', 20000, undefined, true, { tid: 0xff, waitMs: W_VIPER }),
  // Viper Mini Signature Edition: extended polling on both PIDs, up to 1000 Hz on the cable, 8000 Hz wireless
  0x009e: wl('Viper Mini Signature Edition', 30000, undefined, false, { poll: 'hyper', maxHz: 1000, waitMs: W_VIPER }),
  0x009f: wl('Viper Mini Signature Edition', 30000, undefined, true, { poll: 'hyper', maxHz: 8000, waitMs: W_VIPER }),
  0x00a5: wl('Viper V2 Pro', 30000, I.v2pro, false, { tids: { lowBattery: 0xff } }),
  0x00a6: wl('Viper V2 Pro', 30000, I.v2pro, true, { tids: { lowBattery: 0xff } }),
  0x00c0: wl('Viper V3 Pro', 35000, I.v3pro, false),
  0x00c1: wl('Viper V3 Pro', 35000, I.v3pro, true, { poll: 'hyper', maxHz: 8000, waitMs: W_VIPER }),
  0x00de: wl('Viper V3 Pro SE', 35000, I.v3proSe, false),
  0x00df: wl('Viper V3 Pro SE', 35000, I.v3proSe, true, { waitMs: W_VIPER }),
  // AA battery: no charging status
  0x00b8: wl('Viper V3 HyperSpeed', 30000, I.v3hs, true, { charging: false, waitMs: W_VIPER }),
  // OpenRazer talks to the Viper V4 Pro on USB interface 3 (we take whichever interface has the 90-byte report)
  0x00e5: wl('Viper V4 Pro', 50000, undefined, false, { poll: 'hyper', maxHz: 8000, waitMs: W_VIPER }),
  0x00e6: wl('Viper V4 Pro', 50000, undefined, true, { poll: 'hyper', maxHz: 8000, waitMs: W_VIPER }),

  // ---- Basilisk
  0x0064: wired('Basilisk', 0x3f, 16000, { stages: false }),
  0x0065: wired('Basilisk Essential', 0x3f, 6400, { tids: { stages: 0xff } }),
  0x0085: wired('Basilisk V2', 0x1f, 20000, { stages: false }),
  0x0086: wl('Basilisk Ultimate', 20000, undefined, false, { stages: false, tids: { idle: 0xff, lowBattery: 0xff }, cmdTids: { getPoll: 0xff } }),
  0x0088: wl('Basilisk Ultimate', 20000, undefined, true, { stages: false, tids: { idle: 0xff, lowBattery: 0xff }, cmdTids: { getPoll: 0xff } }),
  // AA battery, everything on 0xff
  0x0083: wl('Basilisk X HyperSpeed', 16000, undefined, true, { tid: 0xff, charging: false }),
  0x0099: wired('Basilisk V3', 0x1f, 26000, { tids: { stages: 0xff }, image: I.bv3 }),
  0x00cb: wired('Basilisk V3 35K', 0x1f, 35000, { image: I.bv3_35k }),
  0x00b9: wl('Basilisk V3 X HyperSpeed', 18000, undefined, true, { charging: false }),
  0x00aa: wl('Basilisk V3 Pro', 30000, I.bv3pro, false, { tids: { lowBattery: 0xff } }),
  0x00ab: wl('Basilisk V3 Pro', 30000, I.bv3pro, true, { tids: { lowBattery: 0xff } }),
  0x00cc: wl('Basilisk V3 Pro 35K', 35000, I.bv3pro35k, false, { tids: { lowBattery: 0xff } }),
  0x00cd: wl('Basilisk V3 Pro 35K', 35000, I.bv3pro35k, true, { tids: { lowBattery: 0xff } }),
  0x00d6: wl('Basilisk V3 Pro 35K Phantom Green', 35000, I.bv3pro35kPg, false, { tids: { lowBattery: 0xff } }),
  0x00d7: wl('Basilisk V3 Pro 35K Phantom Green', 35000, I.bv3pro35kPg, true, { tids: { lowBattery: 0xff } }),
  0x00d3: wl('Basilisk Mobile', 18000, undefined, false, { charging: false }),
  0x00d4: wl('Basilisk Mobile', 18000, undefined, true, { charging: false }),

  // ---- Cobra
  0x00a3: wired('Cobra', 0xff, 8500, { image: I.cobra }),
  0x00af: wl('Cobra Pro', 30000, I.cobraPro, false, { tids: { lowBattery: 0xff } }),
  0x00b0: wl('Cobra Pro', 30000, I.cobraPro, true, { tids: { lowBattery: 0xff } }),
  // OpenRazer uses 0xff for the low-battery warning on the cable PID only
  0x00da: wl('Cobra HyperSpeed', 26000, undefined, false, { tids: { lowBattery: 0xff } }),
  0x00db: wl('Cobra HyperSpeed', 26000, undefined, true),

  // ---- Naga
  0x0067: wired('Naga Trinity', 0xff, 16000, { stages: false }),
  0x008d: wired('Naga Left-Handed Edition', 0x1f, 20000, { stages: false }),
  // Naga X: serial number answers on transaction 0x08 (sic, OpenRazer); OpenRazer talks to it on USB interface 3
  0x0096: wired('Naga X', 0x1f, 18000, { tids: { stages: 0xff }, cmdTids: { getSerial: 0x08 } }),
  0x008f: wl('Naga Pro', 20000, undefined, false, { waitMs: W_WIRED }),
  0x0090: wl('Naga Pro', 20000, undefined, true),
  0x00a7: wl('Naga V2 Pro', 30000, undefined, false),
  0x00a8: wl('Naga V2 Pro', 30000, undefined, true),
  // AA battery; the low-battery warning is read on 0x1f but written on 0xff
  0x00b4: wl('Naga V2 HyperSpeed', 30000, undefined, true, { charging: false, cmdTids: { setLowBattery: 0xff } }),

  // ---- Orochi (AA/AAA powered: no charging status). Bluetooth PID 0x0095 has no 90-byte report over WebHID.
  0x0094: wl('Orochi V2', 18000, I.orochiV2, true, { charging: false, tids: { idle: 0xff, lowBattery: 0xff }, waitMs: W_SLOW }),
  0x00e0: wl('Orochi V2 (2026)', 18000, I.orochiV2, true, { charging: false, tids: { idle: 0xff, lowBattery: 0xff }, waitMs: W_SLOW }),

  // ---- other wireless
  0x0062: wl('Atheris', 7200, undefined, true, { charging: false, tids: { stages: 0xff, idle: 0xff, lowBattery: 0xff }, waitMs: W_SLOW }),
  0x0072: wl('Mamba Wireless', 16000, undefined, true, { tid: 0x3f, stages: false, tids: { idle: 0xff, lowBattery: 0xff } }),
  0x0073: wl('Mamba Wireless', 16000, undefined, false, { tid: 0x3f, stages: false, tids: { idle: 0xff, lowBattery: 0xff } }),
  0x006f: wl('Lancehead Wireless', 16000, undefined, true, { tid: 0x3f, tids: { battery: 0x1f, charging: 0x1f, stages: 0xff, idle: 0xff, lowBattery: 0xff } }),
  0x0070: wl('Lancehead Wireless', 16000, undefined, false, { tid: 0x3f, tids: { battery: 0x1f, charging: 0x1f, stages: 0xff, idle: 0xff, lowBattery: 0xff } }),
  0x0077: wl('Pro Click', 16000, undefined, true, { tids: { idle: 0xff, lowBattery: 0xff } }),
  0x0080: wl('Pro Click', 16000, undefined, false, { tids: { idle: 0xff, lowBattery: 0xff } }),
  0x009a: wl('Pro Click Mini', 12000, undefined, true),
  0x00d0: wl('Pro Click V2', 30000, undefined, false),
  0x00d1: wl('Pro Click V2', 30000, undefined, true),
  0x00c7: wl('Pro Click V2 Vertical Edition', 30000, undefined, false),
  0x00c8: wl('Pro Click V2 Vertical Edition', 30000, undefined, true),

  // ---- other wired
  0x0060: wired('Lancehead Tournament Edition', 0x3f, 16000, { tids: { stages: 0xff } }),
  0x006a: wired('Abyssus Elite D.Va Edition', 0xff, 7200, { stages: false }),
  0x006b: wired('Abyssus Essential', 0xff, 7200, { stages: false }),
  // Mamba Elite: firmware / DPI on 0x1f, serial number / polling on 0xff
  0x006c: wired('Mamba Elite', 0x1f, 16000, { stages: false, tids: { poll: 0xff }, cmdTids: { getSerial: 0xff } }),

  // ---- HyperPolling Wireless Dongle (pairs with DeathAdder V3 Pro / Viper V2 Pro / Cobra Pro...): mouse unknown, no photo.
  0x00b3: wl('HyperPolling Wireless Dongle', 30000, undefined, true, { tids: { lowBattery: 0xff }, poll: 'hyper', maxHz: 8000, poll2SecondTid: 0xff, waitMs: W_VIPER }),
};

/** The transaction id this driver sends `cmd` with on `pid` (the first packet, for set polling 2). */
export function tidFor(pid: number, cmd: CmdName): number | undefined {
  const m = MODELS[pid];
  if (!m) return undefined;
  return m.cmdTids?.[cmd] ?? m.tids?.[FEATURE_OF[cmd]] ?? m.tid;
}

/** The transaction id of the second (argument 0x01) set-polling-2 packet. */
export const poll2SecondTidFor = (pid: number): number | undefined => (MODELS[pid] ? (MODELS[pid].poll2SecondTid ?? tidFor(pid, 'setPoll2')) : undefined);

// ---------------------------------------------------------------- encoding

export function crc(r: ArrayLike<number>): number {
  let c = 0;
  for (let i = 2; i < 88; i++) c ^= r[i] ?? 0;
  return c;
}

export function buildReport(tid: number, cls: number, id: number, size: number, args: number[] = []): Uint8Array<ArrayBuffer> {
  if (!isAllowed(cls, id)) throw new Error(`Razer command ${cls.toString(16)}:${id.toString(16)} is blocked`);
  if (ALLOWED.get(`${cls}:${id}`) !== size) throw new Error('bad data size');
  if (args.length > 80) throw new Error('too many arguments');
  const r = new Uint8Array(REPORT_LEN);
  r[1] = tid & 0xff;
  r[5] = size;
  r[6] = cls;
  r[7] = id;
  args.forEach((b, i) => (r[8 + i] = b & 0xff));
  r[88] = crc(r);
  return r;
}

/** Hz <-> code tables */
const POLL_CLASSIC: [number, number][] = [
  [125, 0x08],
  [500, 0x02],
  [1000, 0x01],
];
const POLL_HYPER: [number, number][] = [
  [125, 0x40],
  [250, 0x20],
  [500, 0x10],
  [1000, 0x08],
  [2000, 0x04],
  [4000, 0x02],
  [8000, 0x01],
];

const IDLE: [string, number][] = [
  ['1 min', 60],
  ['2 min', 120],
  ['3 min', 180],
  ['5 min', 300],
  ['10 min', 600],
  ['15 min', 900],
];
/** threshold byte is a 0..255 battery scale; OpenRazer clamps to 0x0C..0x3F */
const LOW_BATTERY: [string, number][] = [
  ['5%', 0x0c],
  ['10%', 0x19],
  ['15%', 0x26],
  ['20%', 0x33],
  ['25%', 0x3f],
];

const MAX_STAGES = 5;
const DPI_MIN = 100;
const DPI_STEP = 50;

const s = (key: string, label: string, group: string, value: Value, hint?: string): Setting => (hint ? { key, label, group, value, hint } : { key, label, group, value });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });
const choice = (options: [string, number][], current: number): Value => ({ kind: 'choice', options, current });

const be16 = (hi: number, lo: number) => ((hi & 0xff) << 8) | (lo & 0xff);

// ---------------------------------------------------------------- transport

class RazerError extends Error {
  constructor(
    msg: string,
    readonly status?: number,
  ) {
    super(msg);
  }
}

/** One request at a time: SET_FEATURE, wait, GET_FEATURE, check, retry up to 5 times. */
class Link {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dev: HIDDevice,
    private readonly model: Model,
    private readonly delay: (ms: number) => Promise<void>,
  ) {}

  send(name: CmdName, args: number[] = [], tidOverride?: number): Promise<Uint8Array> {
    const [cls, id, size] = CMD[name];
    const m = this.model;
    const tid = tidOverride ?? m.cmdTids?.[name] ?? m.tids?.[FEATURE_OF[name]] ?? m.tid;
    const req = buildReport(tid, cls, id, size, args);
    const run = async () => {
      let last: RazerError | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.dev.sendFeatureReport(REPORT_ID, req);
        await this.delay(this.model.waitMs);
        const view = await this.dev.receiveFeatureReport(REPORT_ID);
        let r = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        // some platforms prepend the (zero) report id
        if (r.length === REPORT_LEN + 1) r = r.subarray(1);
        if (r.length < REPORT_LEN || r[6] !== cls || r[7] !== id || r[2] !== 0 || r[3] !== 0) {
          last = new RazerError('reply does not match the request');
        } else if (r[0] === ST_OK || r[0] === ST_BUSY) {
          return r.slice(0, REPORT_LEN);
        } else if (r[0] === ST_UNSUPPORTED) {
          throw new RazerError('not supported', r[0]);
        } else if (r[0] === ST_FAIL) {
          last = new RazerError('command failed', r[0]);
        } else if (r[0] === ST_TIMEOUT) {
          last = new RazerError('no answer from the mouse — is it switched on?', r[0]);
        } else {
          last = new RazerError(`unexpected status ${r[0]}`, r[0]);
        }
        await this.delay(10);
      }
      throw last ?? new RazerError('no answer');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface RazerOptions {
  sleep?: (ms: number) => Promise<void>;
}

const arg = (r: Uint8Array, i: number) => r[8 + i];

export class RazerDriver implements Driver {
  readonly id: string;
  readonly family = 'Razer (90-byte protocol)';
  readonly kind: DeviceKind = 'mouse';
  readonly verified = false;
  readonly info: Model;
  private link: Link;
  /** last DPI stages read from / written to the mouse */
  private stages: number[] = [];
  private active = 0;
  private hasStages = false;

  constructor(
    private readonly device: HIDDevice,
    opts: RazerOptions = {},
  ) {
    const m = MODELS[device.productId];
    if (device.vendorId !== RAZER_VID || !m) throw new Error('not a supported Razer mouse');
    this.info = m;
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.link = new Link(device, m, opts.sleep ?? realSleep);
  }

  brand(): string {
    return 'RAZER';
  }
  model(): string {
    return this.info.name;
  }
  image(): string | undefined {
    return this.info.image;
  }

  private pollTable(): [number, number][] {
    const t = this.info.poll === 'hyper' ? POLL_HYPER : POLL_CLASSIC;
    return t.filter(([hz]) => hz <= this.info.maxHz);
  }

  async read(): Promise<Setting[]> {
    const m = this.info;
    const L = this.link;
    const out: Setting[] = [];
    const tryGet = (name: CmdName, args: number[] = []) => L.send(name, args).catch(() => null);

    out.push(text('model', 'Model', 'Info', m.name));
    out.push(text('connection', 'Connection', 'Info', m.receiver ? 'Wireless' : 'Wired'));
    const fw = await tryGet('getFirmware');
    if (fw) out.push(text('fw', 'Firmware', 'Info', `v${arg(fw, 0)}.${arg(fw, 1)}`));
    const sn = await tryGet('getSerial');
    if (sn) {
      const chars: string[] = [];
      for (let i = 0; i < 22; i++) {
        const c = arg(sn, i);
        if (c === 0) break;
        if (c >= 0x20 && c < 0x7f) chars.push(String.fromCharCode(c));
      }
      if (chars.length) out.push(text('serial', 'Serial number', 'Info', chars.join('').trim()));
    }
    if (m.battery) {
      const b = await tryGet('getBattery');
      if (b) {
        const pct = Math.round((arg(b, 1) / 255) * 100);
        let charging = false;
        if (m.charging) {
          const c = await tryGet('getCharging');
          charging = !!c && arg(c, 1) === 1;
        }
        out.push(text('battery', 'Battery', 'Info', `${pct}%${charging ? ' (charging)' : ''}`));
      }
    }

    // DPI: stages if the mouse has them, else just the current DPI
    const dpiMax = m.maxDpi;
    const st = m.stages === false ? null : await tryGet('getStages', [VARSTORE]);
    let stages: number[] = [];
    let active = 0;
    if (st) {
      const count = Math.min(MAX_STAGES, arg(st, 2));
      const activeId = arg(st, 1);
      let activeIdx = -1;
      for (let i = 0; i < count; i++) {
        const o = 3 + 7 * i;
        if (arg(st, o) === activeId) activeIdx = i;
        stages.push(be16(arg(st, o + 1), arg(st, o + 2)));
      }
      if (activeIdx < 0) activeIdx = activeId - 1;
      active = Math.max(0, Math.min(stages.length - 1, activeIdx));
    }
    if (stages.length > 0 && stages.every((d) => d > 0)) {
      this.hasStages = true;
    } else {
      this.hasStages = false;
      const d = await tryGet('getDpi', [NOSTORE]);
      stages = d ? [be16(arg(d, 1), arg(d, 2))] : [];
      active = 0;
    }
    this.stages = stages;
    this.active = active;
    if (stages.length) {
      out.push(s('dpi', this.hasStages ? 'DPI stages' : 'DPI', 'DPI', { kind: 'dpi', stages: [...stages], active, min: DPI_MIN, max: dpiMax, step: DPI_STEP }));
      if (this.hasStages) out.push(s('dpi_count', 'Number of DPI stages', 'DPI', choice([1, 2, 3, 4, 5].map((i) => [String(i), i]), stages.length)));
    }

    // polling
    const table = this.pollTable();
    let hz: number | undefined;
    if (m.poll === 'hyper') {
      const p = await tryGet('getPoll2');
      if (p) hz = POLL_HYPER.find(([, c]) => c === arg(p, 1))?.[0];
    } else {
      const p = await tryGet('getPoll');
      if (p) hz = POLL_CLASSIC.find(([, c]) => c === arg(p, 0))?.[0];
    }
    if (hz !== undefined) {
      const opts = table.map(([h]) => [`${h} Hz`, h] as [string, number]);
      if (!opts.some(([, h]) => h === hz)) opts.push([`${hz} Hz`, hz]);
      out.push(s('polling', 'Polling rate', 'Performance', choice(opts, hz), m.receiver && m.poll === 'hyper' ? 'Above 1000 Hz needs the HyperPolling dongle' : undefined));
    }

    // power
    if (m.battery) {
      const idle = await tryGet('getIdle');
      if (idle) {
        const sec = be16(arg(idle, 0), arg(idle, 1));
        const opts = [...IDLE];
        if (!opts.some(([, v]) => v === sec)) opts.push([`${sec} sec`, sec]);
        opts.sort((a, b) => a[1] - b[1]);
        out.push(s('sleep', 'Sleep after', 'Power', choice(opts, sec)));
      }
      if (m.lowBattery) {
        const lb = await tryGet('getLowBattery');
        if (lb) {
          const v = arg(lb, 0);
          const opts = [...LOW_BATTERY];
          if (!opts.some(([, x]) => x === v)) opts.push([`${Math.round((v / 255) * 100)}%`, v]);
          opts.sort((a, b) => a[1] - b[1]);
          out.push(s('low_battery', 'Low battery warning at', 'Power', choice(opts, v)));
        }
      }
    }

    if (out.length <= 2) throw new Error('no answer — is the mouse switched on?');
    return out;
  }

  private clampDpi(d: number): number {
    if (!Number.isFinite(d)) throw new Error('bad DPI');
    const v = Math.round(d / DPI_STEP) * DPI_STEP;
    return Math.max(DPI_MIN, Math.min(this.info.maxDpi, v));
  }

  private async writeStages(stages: number[], active: number): Promise<void> {
    if (stages.length < 1 || stages.length > MAX_STAGES) throw new Error('bad stage count');
    if (active < 0 || active >= stages.length) throw new Error('bad active stage');
    // layout exactly as OpenRazer sends it: varstore, active stage (1-based), count, then
    // per stage [index (0-based), xHi, xLo, yHi, yLo, 0, 0]
    const args = [VARSTORE, active + 1, stages.length];
    stages.forEach((d, i) => args.push(i, d >> 8, d & 0xff, d >> 8, d & 0xff, 0, 0));
    await this.link.send('setStages', args);
    this.stages = [...stages];
    this.active = active;
  }

  private async writeDpi(d: number): Promise<void> {
    await this.link.send('setDpi', [VARSTORE, d >> 8, d & 0xff, d >> 8, d & 0xff, 0, 0]);
  }

  async write(st: Setting): Promise<void> {
    const v = st.value;
    const m = this.info;
    switch (st.key) {
      case 'dpi': {
        if (v.kind !== 'dpi' || v.stages.length < 1) throw new Error('bad value');
        const stages = v.stages.slice(0, this.hasStages ? MAX_STAGES : 1).map((d) => this.clampDpi(d));
        const active = Math.max(0, Math.min(stages.length - 1, v.active));
        if (this.hasStages) await this.writeStages(stages, active);
        else this.stages = stages;
        await this.writeDpi(stages[active]);
        return;
      }
      case 'dpi_count': {
        if (!this.hasStages) throw new Error("dpi_count can't be changed");
        if (v.kind !== 'choice' || !Number.isInteger(v.current) || v.current < 1 || v.current > MAX_STAGES) throw new Error('bad value');
        const stages = this.stages.slice(0, v.current);
        while (stages.length < v.current) stages.push(this.clampDpi((stages[stages.length - 1] ?? 800) * 2));
        const active = Math.min(this.active, stages.length - 1);
        await this.writeStages(stages, active);
        if (active !== this.active) await this.writeDpi(stages[active]);
        return;
      }
      case 'polling': {
        if (v.kind !== 'choice') throw new Error('bad value');
        const row = this.pollTable().find(([hz]) => hz === v.current);
        if (!row) throw new Error('bad polling rate');
        if (m.poll === 'hyper') {
          // Razer sends this twice, with argument 0 and then 1
          await this.link.send('setPoll2', [0x00, row[1]]);
          await this.link.send('setPoll2', [0x01, row[1]], m.poll2SecondTid);
        } else {
          await this.link.send('setPoll', [row[1]]);
        }
        return;
      }
      case 'sleep': {
        if (!m.battery || v.kind !== 'choice') throw new Error('bad value');
        const sec = v.current;
        if (!Number.isInteger(sec) || sec < 60 || sec > 900) throw new Error('sleep must be 1-15 minutes');
        await this.link.send('setIdle', [sec >> 8, sec & 0xff]);
        return;
      }
      case 'low_battery': {
        if (!m.lowBattery || v.kind !== 'choice') throw new Error('bad value');
        const x = v.current;
        if (!Number.isInteger(x) || x < 0x0c || x > 0x3f) throw new Error('bad value');
        await this.link.send('setLowBattery', [x]);
        return;
      }
      default:
        throw new Error(`${st.key} can't be changed`);
    }
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factory

/** The control interface carries a 90-byte feature report without a report id. */
function hasControlReport(d: HIDDevice): boolean {
  return (d.collections ?? []).some((c) =>
    (c.featureReports ?? []).some((r) => {
      if ((r.reportId ?? 0) !== REPORT_ID) return false;
      const items = r.items ?? [];
      if (items.length === 0) return true;
      const bits = items.reduce((n, it) => n + (it.reportSize ?? 0) * (it.reportCount ?? 0), 0);
      return bits === REPORT_LEN * 8;
    }),
  );
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/**
 * A Razer device whose PID is not in MODELS (a model newer than this table, a keyboard, a headset...).
 * Shown as "not supported yet" instead of being dropped silently. read() and write() never talk to the
 * device; only diagnose() sends anything, and only allowlisted read (get) commands, to help add the model.
 */
export class UnsupportedRazer implements Driver {
  readonly id: string;
  readonly family = 'Razer (not supported yet)';
  readonly kind: DeviceKind = 'mouse';
  readonly verified = false;

  constructor(
    private readonly device: HIDDevice,
    private readonly opts: RazerOptions = {},
  ) {
    if (device.vendorId !== RAZER_VID) throw new Error('not a Razer device');
    this.id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
  }

  brand(): string {
    return 'RAZER';
  }
  model(): string {
    const n = (this.device.productName ?? '').replace(/^\s*razer\s+/i, '').trim();
    return n || `Unknown model (${this.id})`;
  }
  image(): string | undefined {
    return undefined;
  }

  async read(): Promise<Setting[]> {
    // Info is for the header; the Status group is what the mouse page shows
    return [
      text('model', 'Model', 'Info', this.model()),
      { key: 'unsupported', label: "This Razer model isn't supported yet", group: 'Status', value: { kind: 'text', text: this.id } },
      { key: 'unsupported_help', label: 'Send a report with the Feedback button so it can be added', group: 'Status', value: { kind: 'text', text: '' } },
    ];
  }

  async write(): Promise<void> {
    throw new Error("This Razer model isn't supported yet");
  }

  /** Read-only probe: which transaction id the firmware query answers on, and a few other get commands. */
  async diagnose(onProgress?: (done: number, total: number) => void): Promise<string> {
    const lines = [`Razer ${this.id} "${this.device.productName ?? ''}" (not in the model table)`];
    for (const c of this.device.collections ?? []) {
      const ids = (rs?: HIDReportInfo[]) => (rs ?? []).map((r) => r.reportId ?? 0).join(',') || '-';
      lines.push(`collection ${hex4(c.usagePage ?? 0)}:${hex4(c.usage ?? 0)} in ${ids(c.inputReports)} out ${ids(c.outputReports)} feature ${ids(c.featureReports)}`);
    }
    // the 90-byte report may sit on another interface of the same device
    let dev: HIDDevice | undefined = hasControlReport(this.device) ? this.device : undefined;
    if (!dev && typeof navigator !== 'undefined' && 'hid' in navigator) {
      const all = await navigator.hid.getDevices().catch(() => [] as HIDDevice[]);
      dev = all.find((d) => d.vendorId === this.device.vendorId && d.productId === this.device.productId && hasControlReport(d));
    }
    if (!dev) {
      lines.push('no interface with the 90-byte feature report: nothing sent');
      return lines.join('\n');
    }
    if (!dev.opened) await dev.open();
    const probe = (tid: number): Model => ({ name: 'probe', tid, maxDpi: 0, poll: 'classic', maxHz: 1000, battery: false, receiver: false, waitMs: W_VIPER });
    const hexb = (r: Uint8Array, n: number) => [...r.slice(8, 8 + n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const tids = [0x1f, 0x3f, 0xff];
    const gets: CmdName[] = ['getSerial', 'getDpi', 'getPoll', 'getPoll2', 'getBattery'];
    const total = tids.length + gets.length;
    let done = 0;
    let found: number | undefined;
    for (const tid of tids) {
      try {
        const r = await new Link(dev, probe(tid), this.opts.sleep ?? realSleep).send('getFirmware');
        lines.push(`firmware on 0x${tid.toString(16)}: v${arg(r, 0)}.${arg(r, 1)}`);
        found ??= tid;
      } catch (e) {
        lines.push(`firmware on 0x${tid.toString(16)}: ${e instanceof Error ? e.message : String(e)}`);
      }
      onProgress?.(++done, total);
    }
    for (const g of gets) {
      if (found !== undefined) {
        try {
          const r = await new Link(dev, probe(found), this.opts.sleep ?? realSleep).send(g, g === 'getDpi' ? [NOSTORE] : []);
          lines.push(`${g} on 0x${found.toString(16)}: ${hexb(r, CMD[g][2])}`);
        } catch (e) {
          lines.push(`${g} on 0x${found.toString(16)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      onProgress?.(++done, total);
    }
    return lines.join('\n');
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

export const razerFactory: DriverFactory = {
  name: 'Razer',
  // every Razer device: models we know get a driver, any other one shows as "not supported yet"
  filters: [{ vendorId: RAZER_VID }],
  match(d: HIDDevice): boolean {
    if (d.vendorId !== RAZER_VID) return false;
    // known models: only the interface that carries the 90-byte control report
    return d.productId in MODELS ? hasControlReport(d) : true;
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!razerFactory.match(device)) return null;
    if (!(device.productId in MODELS)) return new UnsupportedRazer(device);
    if (!device.opened) await device.open();
    return new RazerDriver(device);
  },
};
