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

interface Model {
  name: string;
  /** default transaction id */
  tid: number;
  /** per-feature transaction id overrides (from OpenRazer's per-attribute switch tables) */
  tids?: Partial<Record<Feature, number>>;
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

// OpenRazer wait times: 31 ms "new receiver", 59.9 ms "viper receiver", 400 ms Orochi V2, 0.6 ms wired.
const W_NEW = 31;
const W_VIPER = 60;
const W_WIRED = 1;

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

/** Only these PIDs are claimed. */
export const MODELS: Record<number, Model> = {
  // DeathAdder
  0x00b2: { name: 'DeathAdder V3', tid: 0x1f, maxDpi: 30000, poll: 'hyper', maxHz: 8000, battery: false, receiver: false, waitMs: W_WIRED, image: I.da3 },
  0x00b6: wl('DeathAdder V3 Pro', 30000, I.da3pro, false),
  0x00b7: wl('DeathAdder V3 Pro', 30000, I.da3pro, true),
  0x00c2: wl('DeathAdder V3 Pro', 30000, I.da3pro, false),
  0x00c3: wl('DeathAdder V3 Pro', 30000, I.da3pro, true),
  0x00c4: wl('DeathAdder V3 HyperSpeed', 26000, I.da3hs, false),
  0x00c5: wl('DeathAdder V3 HyperSpeed', 26000, I.da3hs, true),
  0x00be: wl('DeathAdder V4 Pro', 45000, I.da4pro, false, { poll: 'hyper', maxHz: 8000 }),
  0x00bf: wl('DeathAdder V4 Pro', 45000, I.da4pro, true, { poll: 'hyper', maxHz: 8000 }),
  // Viper
  0x00a5: wl('Viper V2 Pro', 30000, I.v2pro, false, { tids: { lowBattery: 0xff } }),
  0x00a6: wl('Viper V2 Pro', 30000, I.v2pro, true, { tids: { lowBattery: 0xff } }),
  0x00c0: wl('Viper V3 Pro', 35000, I.v3pro, false),
  0x00c1: wl('Viper V3 Pro', 35000, I.v3pro, true, { poll: 'hyper', maxHz: 8000, waitMs: W_VIPER }),
  0x00de: wl('Viper V3 Pro SE', 35000, I.v3proSe, false),
  0x00df: wl('Viper V3 Pro SE', 35000, I.v3proSe, true, { waitMs: W_VIPER }),
  0x00b8: wl('Viper V3 HyperSpeed', 30000, I.v3hs, true, { charging: false, waitMs: W_VIPER }),
  // Basilisk
  0x0099: { name: 'Basilisk V3', tid: 0x1f, tids: { stages: 0xff }, maxDpi: 26000, poll: 'classic', maxHz: 1000, battery: false, receiver: false, waitMs: W_WIRED, image: I.bv3 },
  0x00cb: { name: 'Basilisk V3 35K', tid: 0x1f, maxDpi: 35000, poll: 'classic', maxHz: 1000, battery: false, receiver: false, waitMs: W_WIRED, image: I.bv3_35k },
  0x00aa: wl('Basilisk V3 Pro', 30000, I.bv3pro, false, { tids: { lowBattery: 0xff } }),
  0x00ab: wl('Basilisk V3 Pro', 30000, I.bv3pro, true, { tids: { lowBattery: 0xff } }),
  0x00cc: wl('Basilisk V3 Pro 35K', 35000, I.bv3pro35k, false, { tids: { lowBattery: 0xff } }),
  0x00cd: wl('Basilisk V3 Pro 35K', 35000, I.bv3pro35k, true, { tids: { lowBattery: 0xff } }),
  0x00d6: wl('Basilisk V3 Pro 35K Phantom Green', 35000, I.bv3pro35kPg, false, { tids: { lowBattery: 0xff } }),
  0x00d7: wl('Basilisk V3 Pro 35K Phantom Green', 35000, I.bv3pro35kPg, true, { tids: { lowBattery: 0xff } }),
  // Cobra
  0x00a3: { name: 'Cobra', tid: 0xff, maxDpi: 8500, poll: 'classic', maxHz: 1000, battery: false, receiver: false, waitMs: W_WIRED, image: I.cobra },
  0x00af: wl('Cobra Pro', 30000, I.cobraPro, false, { tids: { lowBattery: 0xff } }),
  0x00b0: wl('Cobra Pro', 30000, I.cobraPro, true, { tids: { lowBattery: 0xff } }),
  // Orochi V2 (AA/AAA powered: no charging status). Bluetooth PID 0x0095 is not claimed.
  0x0094: wl('Orochi V2', 18000, I.orochiV2, true, { charging: false, tids: { idle: 0xff, lowBattery: 0xff }, waitMs: 400 }),
  // HyperPolling Wireless Dongle (4K, pairs with DeathAdder V3 Pro / Viper V2 Pro / Cobra Pro...): mouse unknown, no photo.
  0x00b3: {
    name: 'HyperPolling Wireless Dongle',
    tid: 0x1f,
    tids: { lowBattery: 0xff },
    maxDpi: 30000,
    poll: 'hyper',
    maxHz: 4000,
    poll2SecondTid: 0xff,
    battery: true,
    charging: true,
    receiver: true,
    lowBattery: true,
    waitMs: W_VIPER,
  },
};

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

  send(name: CmdName, feature: Feature, args: number[] = [], tidOverride?: number): Promise<Uint8Array> {
    const [cls, id, size] = CMD[name];
    const tid = tidOverride ?? this.model.tids?.[feature] ?? this.model.tid;
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
    const tryGet = (name: CmdName, f: Feature, args: number[] = []) => L.send(name, f, args).catch(() => null);

    out.push(text('model', 'Model', 'Info', m.name));
    out.push(text('connection', 'Connection', 'Info', m.receiver ? 'Wireless' : 'Wired'));
    const fw = await tryGet('getFirmware', 'info');
    if (fw) out.push(text('fw', 'Firmware', 'Info', `v${arg(fw, 0)}.${arg(fw, 1)}`));
    const sn = await tryGet('getSerial', 'info');
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
      const b = await tryGet('getBattery', 'battery');
      if (b) {
        const pct = Math.round((arg(b, 1) / 255) * 100);
        let charging = false;
        if (m.charging) {
          const c = await tryGet('getCharging', 'charging');
          charging = !!c && arg(c, 1) === 1;
        }
        out.push(text('battery', 'Battery', 'Info', `${pct}%${charging ? ' (charging)' : ''}`));
      }
    }

    // DPI: stages if the mouse has them, else just the current DPI
    const dpiMax = m.maxDpi;
    const st = await tryGet('getStages', 'stages', [VARSTORE]);
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
      const d = await tryGet('getDpi', 'dpi', [NOSTORE]);
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
      const p = await tryGet('getPoll2', 'poll');
      if (p) hz = POLL_HYPER.find(([, c]) => c === arg(p, 1))?.[0];
    } else {
      const p = await tryGet('getPoll', 'poll');
      if (p) hz = POLL_CLASSIC.find(([, c]) => c === arg(p, 0))?.[0];
    }
    if (hz !== undefined) {
      const opts = table.map(([h]) => [`${h} Hz`, h] as [string, number]);
      if (!opts.some(([, h]) => h === hz)) opts.push([`${hz} Hz`, hz]);
      out.push(s('polling', 'Polling rate', 'Performance', choice(opts, hz), m.receiver && m.poll === 'hyper' ? 'Above 1000 Hz needs the HyperPolling dongle' : undefined));
    }

    // power
    if (m.battery) {
      const idle = await tryGet('getIdle', 'idle');
      if (idle) {
        const sec = be16(arg(idle, 0), arg(idle, 1));
        const opts = [...IDLE];
        if (!opts.some(([, v]) => v === sec)) opts.push([`${sec} sec`, sec]);
        opts.sort((a, b) => a[1] - b[1]);
        out.push(s('sleep', 'Sleep after', 'Power', choice(opts, sec)));
      }
      if (m.lowBattery) {
        const lb = await tryGet('getLowBattery', 'lowBattery');
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
    await this.link.send('setStages', 'stages', args);
    this.stages = [...stages];
    this.active = active;
  }

  private async writeDpi(d: number): Promise<void> {
    await this.link.send('setDpi', 'dpi', [VARSTORE, d >> 8, d & 0xff, d >> 8, d & 0xff, 0, 0]);
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
          await this.link.send('setPoll2', 'poll', [0x00, row[1]]);
          await this.link.send('setPoll2', 'poll', [0x01, row[1]], m.poll2SecondTid);
        } else {
          await this.link.send('setPoll', 'poll', [row[1]]);
        }
        return;
      }
      case 'sleep': {
        if (!m.battery || v.kind !== 'choice') throw new Error('bad value');
        const sec = v.current;
        if (!Number.isInteger(sec) || sec < 60 || sec > 900) throw new Error('sleep must be 1-15 minutes');
        await this.link.send('setIdle', 'idle', [sec >> 8, sec & 0xff]);
        return;
      }
      case 'low_battery': {
        if (!m.lowBattery || v.kind !== 'choice') throw new Error('bad value');
        const x = v.current;
        if (!Number.isInteger(x) || x < 0x0c || x > 0x3f) throw new Error('bad value');
        await this.link.send('setLowBattery', 'lowBattery', [x]);
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

export const razerFactory: DriverFactory = {
  name: 'Razer',
  filters: Object.keys(MODELS).map((pid) => ({ vendorId: RAZER_VID, productId: Number(pid) })),
  match(d: HIDDevice): boolean {
    return d.vendorId === RAZER_VID && d.productId in MODELS && hasControlReport(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!razerFactory.match(device)) return null;
    if (!device.opened) await device.open();
    return new RazerDriver(device);
  },
};
