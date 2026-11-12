// Pulsar CrazyLight driver (and the same "report 8, 16 bytes, 0x55 checksum" protocol on
// Pulsar's Nordic models). Layout from Pulsar's own web app (bbb.pulsar.gg/cMouse) and checked
// against pulsar-mouse-linux, which verified it on a real X2 CrazyLight.
//
// Frame (16 data bytes after report id 8):
//   [cmd, status, addrHi, addrLo, len, payload x10, checksum]
//   checksum = 0x55 - (8 + sum of the first 15 bytes)  (mod 256)
// Settings live in a per-profile memory map read with cmd 0x08 and written with cmd 0x07.
// Single-byte settings are stored as (value, 0x55 - value).
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';
import { sleep as realSleep } from './types';

const REPORT_ID = 8;

// cmd bytes
const CMD_IDENTIFY = 0x01;
const CMD_AWAKE = 0x03;
const CMD_BATTERY = 0x04;
const CMD_WRITE = 0x07;
const CMD_READ = 0x08;
const CMD_GET_PROFILE = 0x0e;
const CMD_SET_PROFILE = 0x0f;
const CMD_VERSION = 0x12;
const CMD_DONGLE_VERSION = 0x1d;
const CMD_STATUS_EVENT = 0x0a;

/**
 * The only commands this driver will ever send. Everything else (0x09 factory reset,
 * 0x05 pairing, 0x0B/0x0C identity, 0x0D/0x11 bootloader, firmware upload...) is refused.
 */
const ALLOWED_CMDS = new Set([CMD_IDENTIFY, CMD_AWAKE, CMD_BATTERY, CMD_WRITE, CMD_READ, CMD_GET_PROFILE, CMD_SET_PROFILE, CMD_VERSION, CMD_DONGLE_VERSION]);

// memory map (per profile)
const A_RATE = 0x00;
const A_STAGES = 0x02;
const A_ACTIVE = 0x04;
const A_LOD = 0x0a;
const A_DPI = 0x0c; // + 4i: [xLo, yLo, hi, ck]
const A_COLOR = 0x2c; // + 4i: [R, G, B, ck]
const A_BTN = 0x60; // + 4i: [type, paramHi, paramLo, ck]
const A_DEBOUNCE = 0xa9;
const A_MSYNC = 0xab;
const A_SLEEP = 0xad;
const A_ANGLE = 0xaf;
const A_RIPPLE = 0xb1;

/** Addresses we may write, with their length. Anything else is refused. */
const WRITABLE: [from: number, to: number][] = [
  [A_RATE, A_RATE + 1],
  [A_STAGES, A_STAGES + 1],
  [A_ACTIVE, A_ACTIVE + 1],
  [A_LOD, A_LOD + 1],
  [A_DPI, A_DPI + 4 * 8 - 1],
  [A_BTN, A_BTN + 4 * 5 - 1],
  [A_DEBOUNCE, A_DEBOUNCE + 1],
  [A_MSYNC, A_MSYNC + 1],
  [A_SLEEP, A_SLEEP + 1],
  [A_ANGLE, A_ANGLE + 1],
  [A_RIPPLE, A_RIPPLE + 1],
];
const writable = (addr: number, len: number) => WRITABLE.some(([a, b]) => addr >= a && addr + len - 1 <= b);

const MAP_SIZE = 0x100;

/** 3710 PIDs that use this protocol (Pulsar's web app list). 1401-1404, 3401/3409/3410 and 5402-5404 use a different one. */
const PIDS_3710 = [
  0x5406, 0x5407, 0x5501, 0x5502, 0x5503, 0x5504, 0x5601, 0x5603, 0xf517,
  0x3414, 0x3415, ...range(0x3501, 0x3529), ...range(0x3601, 0x3611), ...range(0x7501, 0x7510), ...range(0x7601, 0x7605),
  0x9502, 0x9503, 0x9601,
];
const PIDS_3554 = [0xf507, 0xf508, 0xf509, 0xf40a];
const WIRELESS = new Set([0x5406, 0x5407, 0x5501, 0x5502, 0x5503, 0x5504, 0x5601, 0x5603, 0xf517, 0xf507, 0xf508, 0xf509]);

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** (cid, mid) -> model name, where known. */
const MODELS: Record<string, string> = {
  '87:3': 'X2 CrazyLight',
  '87:104': 'X3 LHD CrazyLight',
};

// ---------------------------------------------------------------- encoding

export function checksum(d: ArrayLike<number>): number {
  let sum = REPORT_ID;
  for (let i = 0; i < 15; i++) sum += d[i] ?? 0;
  return (0x55 - sum) & 0xff;
}

export function frame(cmd: number, addr: number, payload: number[], len = payload.length): Uint8Array<ArrayBuffer> {
  if (payload.length > 10) throw new Error('payload too long');
  const d = new Uint8Array(16);
  d[0] = cmd;
  d[2] = (addr >> 8) & 0xff;
  d[3] = addr & 0xff;
  d[4] = len;
  payload.forEach((b, i) => (d[5 + i] = b & 0xff));
  d[15] = checksum(d);
  return d;
}

const comp = (v: number) => (0x55 - v) & 0xff;
const comp3 = (a: number, b: number, c: number) => (0x55 - a - b - c) & 0xff;

/** One DPI axis from its low byte and 4-bit field (2 mode bits + 2 high bits). */
export function decodeDpi(lo: number, field: number): number {
  const mode = field & 3;
  const v = lo | (((field >> 2) & 3) << 8);
  if (mode === 3) return (v + 201) * 100;
  if (mode === 2) return (v + 201) * 50;
  return (v + 1) * 10;
}

/** DPI -> [lo, 4-bit field]. Steps of 10 up to 10240, 50 up to 25600, then 100. */
export function encodeDpi(dpi: number): [number, number] {
  let mode: number;
  let v: number;
  if (dpi <= 10240) {
    mode = 0;
    v = Math.round(dpi / 10) - 1;
  } else if (dpi <= 25600) {
    mode = 2;
    v = Math.round(dpi / 50) - 201;
  } else {
    mode = 3;
    v = Math.round(dpi / 100) - 201;
  }
  v = Math.max(0, Math.min(1023, v));
  return [v & 0xff, mode | ((v >> 8) << 2)];
}

/** Stage block [xLo, yLo, hi, ck] for the same X and Y. */
export function stageBytes(dpi: number): number[] {
  const [lo, f] = encodeDpi(dpi);
  const hi = f | (f << 4);
  return [lo, lo, hi, comp3(lo, lo, hi)];
}

// ---------------------------------------------------------------- tables

const POLLING: [string, number, number][] = [
  // label, code, Hz
  ['125 Hz', 8, 125],
  ['250 Hz', 4, 250],
  ['500 Hz', 2, 500],
  ['1000 Hz', 1, 1000],
  ['2000 Hz', 0x10, 2000],
  ['4000 Hz', 0x20, 4000],
  ['8000 Hz', 0x40, 8000],
];
/** link type from the identify reply -> highest polling rate */
const LINK_MAX: Record<number, number> = { 0: 1000, 1: 4000, 2: 1000, 3: 8000, 4: 2000, 5: 8000 };
const LINK_NAME: Record<number, string> = { 0: 'Wireless', 1: 'Wireless 4K', 2: 'Wired', 3: 'Wired 8K', 4: 'Wireless 2K', 5: 'Wireless 8K' };

const LOD: [string, number][] = [
  ['0.7 mm', 3],
  ['1 mm', 1],
  ['2 mm', 2],
];

/** sleep is stored in steps of 10 s */
const SLEEP: [string, number][] = [
  ['10 sec', 1],
  ['30 sec', 3],
  ['1 min', 6],
  ['2 min', 12],
  ['5 min', 30],
  ['10 min', 60],
  ['20 min', 120],
];

/** [label, type, param] — types from Pulsar's web app (MouseKey 1, DPISwitch 2, Disable 0). */
export const ACTIONS: [string, number, number][] = [
  ['Left click', 1, 0x0100],
  ['Right click', 1, 0x0200],
  ['Middle click', 1, 0x0400],
  ['Back', 1, 0x0800],
  ['Forward', 1, 0x1000],
  ['DPI cycle', 2, 0x0100],
  ['Disabled', 0, 0],
];
export const KEEP = 1000;
const BTN_KEYS = ['btn1', 'btn2', 'btn3', 'btn4', 'btn5'];
const BTN_LABELS = ['Left button', 'Right button', 'Middle button (wheel click)', 'Back side button', 'Forward side button'];

const s = (key: string, label: string, group: string, value: Value): Setting => ({ key, label, group, value });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });
const choice = (options: [string, number][], current: number): Value => ({ kind: 'choice', options, current });
const toggle = (on: boolean): Value => ({ kind: 'toggle', on });

// ---------------------------------------------------------------- transport

type Reply = Uint8Array;

/** Sends frames on report 8 and pairs each answer with its request. */
class Link {
  private waiters: { cmd: number; addr: number; resolve: (r: Reply) => void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dev: HIDDevice) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach(): void {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (d[0] === CMD_STATUS_EVENT) return; // unsolicited "something changed on the mouse"
    const addr = (d[2] << 8) | d[3];
    const i = this.waiters.findIndex((w) => w.cmd === d[0] && (w.cmd !== CMD_READ && w.cmd !== CMD_WRITE ? true : w.addr === addr));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(d.slice());
  };

  /** one request at a time; resends up to 5 times */
  send(cmd: number, addr: number, payload: number[], len = payload.length): Promise<Reply> {
    if (!ALLOWED_CMDS.has(cmd)) return Promise.reject(new Error(`Pulsar command ${cmd.toString(16)} is blocked`));
    if (cmd === CMD_WRITE && !writable(addr, payload.length)) return Promise.reject(new Error(`address ${addr.toString(16)} is not writable`));
    const run = async () => {
      const f = frame(cmd, addr, payload, len);
      for (let attempt = 0; attempt < 5; attempt++) {
        const got = new Promise<Reply | null>((resolve) => {
          const w = { cmd, addr, resolve: (r: Reply) => resolve(r) };
          this.waiters.push(w);
          // real time, not the injectable delay: answers arrive as events
          setTimeout(() => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) {
              this.waiters.splice(i, 1);
              resolve(null);
            }
          }, 200);
        });
        await this.dev.sendReport(REPORT_ID, f);
        const r = await got;
        if (r) {
          if (r[1] !== 0) throw new Error('not supported');
          return r;
        }
      }
      throw new Error('no answer — is the mouse awake?');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface PulsarOptions {
  sleep?: (ms: number) => Promise<void>;
}

export class PulsarDriver implements Driver {
  readonly id: string;
  readonly family = 'Pulsar (CrazyLight / Nordic)';
  readonly kind: DeviceKind = 'mouse';
  private modelName = 'Pulsar mouse';
  private link: Link;
  private delay: (ms: number) => Promise<void>;
  private linkType: number;
  private map = new Uint8Array(MAP_SIZE);
  private profile = 0;
  private profiles = 0;

  constructor(
    private readonly device: HIDDevice,
    opts: PulsarOptions = {},
  ) {
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.delay = opts.sleep ?? realSleep;
    this.link = new Link(device);
    this.linkType = WIRELESS.has(device.productId) ? 5 : 2;
  }

  brand(): string {
    return 'PULSAR';
  }
  model(): string {
    return this.modelName;
  }
  image(): string | undefined {
    return undefined;
  }

  /** wake the mouse up for a batch of commands (the receiver relays them) */
  private async awake(on: boolean): Promise<void> {
    for (let i = 0; i < 20; i++) {
      // Pulsar's app sends this with len 0 and the flag in the first payload byte
      const r = await this.link.send(CMD_AWAKE, 0, [on ? 1 : 0], 0);
      if (on && r[5] === 0) throw new Error('the mouse is off or asleep — move it and try again');
      if (r[9] !== 1) return;
      await this.delay(10);
    }
  }

  private async batch<T>(fn: () => Promise<T>): Promise<T> {
    await this.awake(true);
    try {
      return await fn();
    } finally {
      await this.awake(false).catch(() => undefined);
    }
  }

  async identify(): Promise<void> {
    const rnd = [0, 0, 0, 0].map(() => Math.floor(Math.random() * 256));
    const r = await this.link.send(CMD_IDENTIFY, 0, [...rnd, 0, 0, 0, 0]);
    const cid = r[9];
    const mid = r[10];
    if (r[11] in LINK_MAX) this.linkType = r[11];
    this.modelName = MODELS[`${cid}:${mid}`] ?? (cid === 87 ? 'CrazyLight mouse' : 'Pulsar mouse');
  }

  private async readMap(): Promise<void> {
    for (let a = 0; a < MAP_SIZE; a += 10) {
      const n = Math.min(10, MAP_SIZE - a);
      const r = await this.link.send(CMD_READ, a, new Array(n).fill(0));
      for (let i = 0; i < n; i++) this.map[a + i] = r[5 + i];
    }
  }

  async read(): Promise<Setting[]> {
    return this.batch(async () => {
      await this.identify();
      const out: Setting[] = [];
      out.push(text('model', 'Model', 'Info', this.modelName));
      out.push(text('connection', 'Connection', 'Info', LINK_NAME[this.linkType] ?? 'Unknown'));
      const v = await this.link.send(CMD_VERSION, 0, []).catch(() => null);
      if (v) out.push(text('fw', 'Mouse firmware', 'Info', `v${v[5]}.${v[6].toString(16).padStart(2, '0')}`));
      if (WIRELESS.has(this.device.productId)) {
        const dv = await this.link.send(CMD_DONGLE_VERSION, 0, []).catch(() => null);
        if (dv) out.push(text('dongle_fw', 'Receiver firmware', 'Info', `v${dv[5]}.${dv[6].toString(16).padStart(2, '0')}`));
        const b = await this.link.send(CMD_BATTERY, 0, []).catch(() => null);
        if (b) out.push(text('battery', 'Battery', 'Info', `${b[5]}%${b[6] ? ' (charging)' : ''}`));
      }

      const p = await this.link.send(CMD_GET_PROFILE, 0, []).catch(() => null);
      if (p) {
        this.profile = p[5];
        this.profiles = 4;
        out.push(s('profile', 'Active profile (all settings below belong to it)', 'Profile', choice([0, 1, 2, 3].map((i) => [`Profile ${i + 1}`, i]), this.profile)));
      }

      await this.readMap();
      const m = this.map;

      // DPI
      const count = Math.min(6, Math.max(1, m[A_STAGES]));
      const stages: number[] = [];
      const colors: number[] = [];
      for (let i = 0; i < count; i++) {
        const o = A_DPI + 4 * i;
        stages.push(decodeDpi(m[o], m[o + 2] & 0x0f));
        const c = A_COLOR + 4 * i;
        colors.push((m[c] << 16) | (m[c + 1] << 8) | m[c + 2]);
      }
      const active = Math.min(count - 1, m[A_ACTIVE]);
      out.push(s('dpi', 'DPI stages', 'DPI', { kind: 'dpi', stages, active, min: 50, max: 32000, step: 50, colors }));
      out.push(s('dpi_count', 'Number of DPI stages', 'DPI', choice([1, 2, 3, 4, 5, 6].map((i) => [String(i), i]), count)));

      // performance
      const max = LINK_MAX[this.linkType] ?? 1000;
      const rate = POLLING.filter(([, , hz]) => hz <= max).map(([l, c]) => [l, c] as [string, number]);
      if (!rate.some(([, c]) => c === m[A_RATE])) rate.push([`Code ${m[A_RATE]}`, m[A_RATE]]);
      out.push(s('polling', 'Polling rate', 'Performance', choice(rate, m[A_RATE])));
      const lod = [...LOD];
      if (!lod.some(([, c]) => c === m[A_LOD])) lod.push([`Code ${m[A_LOD]}`, m[A_LOD]]);
      out.push(s('lod', 'Lift-off distance', 'Performance', choice(lod, m[A_LOD])));
      out.push(s('motion_sync', 'Motion sync', 'Performance', toggle(m[A_MSYNC] !== 0)));
      out.push(s('angle_snap', 'Angle snapping', 'Performance', toggle(m[A_ANGLE] !== 0)));
      out.push(s('ripple', 'Ripple control', 'Performance', toggle(m[A_RIPPLE] !== 0)));

      // buttons
      for (let bi = 0; bi < 5; bi++) {
        const o = A_BTN + 4 * bi;
        const type = m[o];
        const param = (m[o + 1] << 8) | m[o + 2];
        const opts: [string, number][] = ACTIONS.map((a, i) => [a[0], i]);
        let current = ACTIONS.findIndex((a) => a[1] === type && (type === 0 || a[2] === param));
        if (current < 0) {
          opts.unshift([`Custom (type ${type}) (keep)`, KEEP]);
          current = KEEP;
        }
        out.push(s(BTN_KEYS[bi], BTN_LABELS[bi], 'Buttons', choice(opts, current)));
      }
      out.push(s('debounce', 'Click debounce', 'Buttons', { kind: 'number', min: 0, max: 15, current: m[A_DEBOUNCE], unit: ' ms' }));

      // power (wireless only)
      if (WIRELESS.has(this.device.productId)) {
        const sl = m[A_SLEEP];
        const opts = SLEEP.map(([l, v]) => [l, v * 10] as [string, number]);
        if (!opts.some(([, v]) => v === sl * 10)) opts.push([`${sl * 10} sec`, sl * 10]);
        out.push(s('sleep', 'Sleep after', 'Power', choice(opts, sl * 10)));
      }
      return out;
    });
  }

  private writeByte(addr: number, v: number): Promise<Reply> {
    return this.link.send(CMD_WRITE, addr, [v & 0xff, comp(v)]);
  }

  async write(st: Setting): Promise<void> {
    const v = st.value;
    await this.batch(async () => {
      switch (st.key) {
        case 'profile':
          if (v.kind !== 'choice' || v.current < 0 || v.current >= Math.max(1, this.profiles)) throw new Error('bad profile');
          await this.link.send(CMD_SET_PROFILE, 0, [v.current]);
          this.profile = v.current;
          return;
        case 'dpi': {
          if (v.kind !== 'dpi') throw new Error('bad value');
          for (let i = 0; i < v.stages.length && i < 6; i++) {
            const b = stageBytes(v.stages[i]);
            const o = A_DPI + 4 * i;
            if (b.some((x, k) => x !== this.map[o + k])) {
              await this.link.send(CMD_WRITE, o, b);
              b.forEach((x, k) => (this.map[o + k] = x));
            }
          }
          if (v.active !== this.map[A_ACTIVE]) {
            await this.writeByte(A_ACTIVE, v.active);
            this.map[A_ACTIVE] = v.active;
          }
          return;
        }
        case 'dpi_count': {
          if (v.kind !== 'choice' || v.current < 1 || v.current > 6) throw new Error('bad value');
          await this.writeByte(A_STAGES, v.current);
          if (this.map[A_ACTIVE] >= v.current) await this.writeByte(A_ACTIVE, 0);
          return;
        }
        case 'polling':
          if (v.kind !== 'choice' || !POLLING.some(([, c]) => c === v.current)) throw new Error('bad value');
          await this.writeByte(A_RATE, v.current);
          return;
        case 'lod':
          if (v.kind !== 'choice' || !LOD.some(([, c]) => c === v.current)) throw new Error('bad value');
          await this.writeByte(A_LOD, v.current);
          return;
        case 'motion_sync':
        case 'angle_snap':
        case 'ripple': {
          if (v.kind !== 'toggle') throw new Error('bad value');
          const a = st.key === 'motion_sync' ? A_MSYNC : st.key === 'angle_snap' ? A_ANGLE : A_RIPPLE;
          await this.writeByte(a, v.on ? 1 : 0);
          return;
        }
        case 'debounce':
          if (v.kind !== 'number' || v.current < 0 || v.current > 15) throw new Error('bad value');
          await this.writeByte(A_DEBOUNCE, v.current);
          return;
        case 'sleep': {
          if (v.kind !== 'choice') throw new Error('bad value');
          const steps = Math.round(v.current / 10);
          if (steps < 1 || steps > 255) throw new Error('bad value');
          await this.writeByte(A_SLEEP, steps);
          return;
        }
        default: {
          const bi = BTN_KEYS.indexOf(st.key);
          if (bi >= 0) {
            if (v.kind !== 'choice') throw new Error('bad value');
            if (v.current === KEEP) return;
            const a = ACTIONS[v.current];
            if (!a) throw new Error('bad action');
            if (bi === 0 && !(a[1] === 1 && a[2] === 0x0100)) {
              // never leave the mouse without a left click
              const leftElsewhere = [1, 2, 3, 4].some((k) => this.map[A_BTN + 4 * k] === 1 && ((this.map[A_BTN + 4 * k + 1] << 8) | this.map[A_BTN + 4 * k + 2]) === 0x0100);
              if (!leftElsewhere) throw new Error('Put Left click on another button first');
            }
            const hi = (a[2] >> 8) & 0xff;
            const lo = a[2] & 0xff;
            const b = [a[1], hi, lo, comp3(a[1], hi, lo)];
            const o = A_BTN + 4 * bi;
            await this.link.send(CMD_WRITE, o, b);
            b.forEach((x, k) => (this.map[o + k] = x));
            return;
          }
          throw new Error(`${st.key} can't be changed`);
        }
      }
    });
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factory

const hasReport8 = (d: HIDDevice) =>
  (d.collections ?? []).some((c) => (c.outputReports ?? []).some((r) => r.reportId === REPORT_ID) && (c.inputReports ?? []).some((r) => r.reportId === REPORT_ID));

export const pulsarFactory: DriverFactory = {
  name: 'Pulsar',
  filters: [...PIDS_3710.map((productId) => ({ vendorId: 0x3710, productId })), ...PIDS_3554.map((productId) => ({ vendorId: 0x3554, productId }))],
  match(d: HIDDevice): boolean {
    const ours = (d.vendorId === 0x3710 && PIDS_3710.includes(d.productId)) || (d.vendorId === 0x3554 && PIDS_3554.includes(d.productId));
    return ours && hasReport8(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!pulsarFactory.match(device)) return null;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const drv = new PulsarDriver(device);
    // the receiver can be plugged in with the mouse switched off: keep it, read() says so
    await drv.identify().catch(() => undefined);
    return drv;
  },
};
