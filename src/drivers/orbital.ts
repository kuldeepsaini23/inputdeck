// Orbital Pathfinder / Ghost driver ("DMS" protocol, Nordic nRF on the shared 0x1915 vendor id).
// Layout from Orbital's own WebHID configurator (ctrl.orbitalworks.co, "Orbital Control"), checked
// against OpenMouse's notes. Our own code: nothing is copied from either.
//
// Frame: report id 0, 64 bytes
//   [0] command family (|0x40 when the receiver should pass it on to the mouse)
//   [1] sequence (unused here)
//   [2] 0x80 | payload length
//   [3] sub-command
//   [4..62] payload
//   [63] checksum = (0xA1 - (sum of bytes 0..62)) & 0xFF   -> every valid frame sums to 0xA1
// Replies echo [0] (with 0x40 when they came from the mouse through the receiver) and [3].
// Family 0x1F is the firmware's "rejected" reply.
//
// Two generations:
//   'dms'    Pathfinder V1 (0747 mouse, 0746 receiver): one 52-byte settings block (04/81/01 read,
//            04/B5/02 write), read back and compared before the save command.
//   'dms_v2' Pathfinder V2 / Ghost (080C mouse, 080B receiver): a sensor/DPI block (04/81/01 read,
//            04/BC/02 write) and a system block (04/83/03 read, 04/90/04 write).
// Every write is followed by "save" (0A/81/01). Five onboard profiles.
//
// Nobody has run this on real hardware yet: verified = false.
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';
import { sleep as realSleep } from './types';

export const VID = 0x1915;
export const REPORT_ID = 0;
export const PACKET = 64;
/** vendor collection that carries the 64-byte config report */
export const USAGE_PAGE = 0xff0a;

export type Protocol = 'dms' | 'dms_v2';

interface Model {
  name: string;
  protocol: Protocol;
  receiver: boolean;
  pairedPid?: number;
  /** highest polling rate offered */
  maxHz: number;
}

/** Only these product ids: 0x1915 is Nordic's shared vendor id. */
export const MODELS: ReadonlyMap<number, Model> = new Map([
  [0x0747, { name: 'Pathfinder', protocol: 'dms', receiver: false, maxHz: 1000 }],
  [0x0746, { name: 'Pathfinder', protocol: 'dms', receiver: true, pairedPid: 0x0747, maxHz: 1000 }],
  [0x080c, { name: 'Pathfinder V2 / Ghost', protocol: 'dms_v2', receiver: false, maxHz: 8000 }],
  [0x080b, { name: 'Pathfinder V2 / Ghost', protocol: 'dms_v2', receiver: true, pairedPid: 0x080c, maxHz: 8000 }],
]);

/** Top view on a transparent background, from orbitalworks.co (checked: HTTP 200, image/png). */
export const PHOTO = 'https://orbitalworks.co/cdn/shop/files/White_Front_6909c3d1-64c1-49a4-9d7a-940dd2150b54.png?width=600';

// ---------------------------------------------------------------- commands

const F_INFO = 0x01; // handshake / power status
const F_PROFILE = 0x02;
const F_BUTTON = 0x03;
const F_SETTINGS = 0x04;
const F_SAVE = 0x0a;
const F_REJECT = 0x1f;
/** ops of the unsolicited status packets (V1 8E, V2 98/99) */
const LIVE_OPS = new Set([0x8e, 0x98, 0x99]);

/**
 * Every [family, op, sub] this driver may send. Factory reset (09/..), lighting (05/..),
 * macros (07/..), receiver light (00/..), the custom-firmware diagnostics (1E/..) and anything
 * else is refused before it reaches the device.
 */
const ALLOWED = new Set([
  '01:81:01', // handshake (unrouted) / battery + profile (routed)
  '04:81:01', // read settings (V1 block, V2 sensor block)
  '04:83:03', // read V2 system block
  '04:b5:02', // write V1 settings block
  '04:bc:02', // write V2 sensor block
  '04:90:04', // write V2 system block
  '0a:81:01', // save
  '02:82:01', // switch profile (V1)
  '02:82:02', // switch profile (V2)
  '03:82:03', // read button
  '03:81:04', // write button: disabled
  '03:85:04', // write button: 4-byte action
]);
const h2 = (n: number) => n.toString(16).padStart(2, '0');
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const cmdKey = (fam: number, op: number, sub: number) => `${h2(fam)}:${h2(op)}:${h2(sub)}`;

export function checksum(p: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < PACKET - 1; i++) sum += p[i] ?? 0;
  return (0xa1 - (sum & 0xff)) & 0xff;
}

/** 64-byte frame: route bit first, then the checksum (the receiver rejects the other order). */
export function frame(fam: number, op: number, sub: number, payload: ArrayLike<number> = [], route = false): Uint8Array<ArrayBuffer> {
  if (payload.length > PACKET - 5) throw new Error('payload too long');
  const p = new Uint8Array(PACKET);
  p[0] = fam | (route ? 0x40 : 0);
  p[2] = op;
  p[3] = sub;
  for (let i = 0; i < payload.length; i++) p[4 + i] = payload[i] & 0xff;
  p[63] = checksum(p);
  return p;
}

export const validSum = (b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i];
  return (s & 0xff) === 0xa1;
};

// ---------------------------------------------------------------- tables

/** polling rate raw codes (index i -> i+1, 125 Hz is 0; raw 1 is never used) */
const RATES: [string, number, number][] = [
  ['125 Hz', 0, 125],
  ['500 Hz', 2, 500],
  ['1000 Hz', 3, 1000],
  ['2000 Hz', 4, 2000],
  ['4000 Hz', 5, 4000],
  ['8000 Hz', 6, 8000],
];
const LOD: [string, number][] = [
  ['Low', 0],
  ['Medium', 1],
  ['High', 2],
];
const SLEEP: [string, number][] = [
  ['1 min', 60],
  ['2 min', 120],
  ['5 min', 300],
  ['10 min', 600],
  ['30 min', 1800],
];
/** [label, 32-bit action] from Orbital Control */
export const ACTIONS: [string, number][] = [
  ['Left click', 0x0100f000],
  ['Right click', 0x0100f100],
  ['Middle click', 0x0100f200],
  ['Back', 0x0100f300],
  ['Forward', 0x0100f400],
  ['Double click', 0x0100f900],
  ['DPI cycle', 0x07000300],
  ['DPI up', 0x07000100],
  ['DPI down', 0x07000200],
  ['Volume up', 0x0300e900],
  ['Volume down', 0x0300ea00],
  ['Mute', 0x0300e200],
  ['Play / pause', 0x0300cd00],
  ['Disabled', 0],
];
const LEFT = 0x0100f000;
export const KEEP = 1000;
/** our keys -> device button index (0 L, 1 R, 2 M, 3 front side = forward, 4 rear side = back, 5 DPI) */
const BUTTONS: [key: string, label: string, index: number][] = [
  ['btn1', 'Left button', 0],
  ['btn2', 'Right button', 1],
  ['btn3', 'Middle button (wheel click)', 2],
  ['btn4', 'Back side button', 4],
  ['btn5', 'Forward side button', 3],
  ['btn_dpi', 'DPI button', 5],
];
const PROFILES = 5;
const STAGES = 5;
const DPI_MIN = 50;
const DPI_MAX = 30000;
const DPI_STEP = 50;

const s = (key: string, label: string, group: string, value: Value, hint?: string): Setting => (hint ? { key, label, group, value, hint } : { key, label, group, value });
const text = (key: string, label: string, t: string) => s(key, label, 'Info', { kind: 'text', text: t });
const choice = (options: [string, number][], current: number): Value => ({ kind: 'choice', options, current });
const toggle = (on: boolean): Value => ({ kind: 'toggle', on });
const u16 = (b: ArrayLike<number>, o: number) => b[o] | (b[o + 1] << 8);
const put16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const signed = (v: number) => (v <= 127 ? v : v - 256);
const bits = (v: number) => {
  let n = 0;
  for (let x = v; x; x >>= 1) n += x & 1;
  return n;
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const snapDpi = (v: number) => clamp(Math.round(v / DPI_STEP) * DPI_STEP, DPI_MIN, DPI_MAX);

// ---------------------------------------------------------------- transport

type Pred = (b: Uint8Array) => boolean;

class Link {
  private waiters: { pred: Pred; resolve: (b: Uint8Array) => void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dev: HIDDevice,
    private readonly receiver: boolean,
    private readonly timeoutMs: number,
  ) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach(): void {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
    const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    const i = this.waiters.findIndex((w) => w.pred(b));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(b);
  };

  /**
   * One request at a time. `route` sends it on to the mouse when we're talking to a receiver.
   * The reply must carry the same family (or the reject family) and the same sub-command.
   */
  send(fam: number, op: number, sub: number, payload: ArrayLike<number> = [], o: { route?: boolean; match?: Pred } = {}): Promise<Uint8Array> {
    if (!ALLOWED.has(cmdKey(fam, op, sub))) return Promise.reject(new Error(`command ${cmdKey(fam, op, sub)} is blocked`));
    const route = (o.route ?? true) && this.receiver;
    const run = async () => {
      const f = frame(fam, op, sub, payload, route);
      const fams = [fam, fam | 0x40];
      const got = new Promise<Uint8Array | null>((resolve) => {
        const w = {
          pred: (b: Uint8Array) =>
            b.length === PACKET && ((fams.includes(b[0]) && b[3] === sub && (!o.match || o.match(b))) || (b[0] & 0xbf) === F_REJECT),
          resolve: (b: Uint8Array) => resolve(b),
        };
        this.waiters.push(w);
        setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            resolve(null);
          }
        }, this.timeoutMs);
      });
      await this.dev.sendReport(REPORT_ID, f);
      const r = await got;
      if (!r) throw new Error('no answer — is the mouse awake?');
      if ((r[0] & 0xbf) === F_REJECT) throw new Error(`the mouse rejected this command (code ${r[3]})`);
      return r;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface OrbitalOptions {
  sleep?: (ms: number) => Promise<void>;
  /** per-request answer timeout (ms) */
  timeoutMs?: number;
}

/** V1 settings block: 52 bytes starting at packet byte 4 */
const V1 = { flags: 0, rate: 1, mask: 2, active: 3, dpi: 4, lod: 39, angle: 40, sleepA: 46, sleepB: 48, debounce: 50, len: 52, compare: 51 };
/** V2 sensor block (packet byte 4 on): toggles, lod, angle, active, mask, dpi; stage colours at 39 */
const V2S = { snap: 0, ripple: 1, msync: 2, overclock: 3, perf: 4, liftDown: 5, glass: 6, lod: 7, angle: 8, active: 9, mask: 10, dpi: 11, dpiEnd: 31, colors: 39, len: 54 };
/** V2 system block */
const V2Y = { sleep: 0, bleSleep: 2, rate: 4, debounce: 5, quick: 6, wheelRev: 10, len: 16 };

const V1_FLAG = { snap: 1 << 0, perf: 1 << 1, ripple: 1 << 4, msync: 1 << 5, overclock: 1 << 6, wheelRev: 1 << 7 };

export class OrbitalDriver implements Driver {
  readonly id: string;
  readonly family = 'Orbital (DMS)';
  readonly kind: DeviceKind = 'mouse';
  readonly verified = false;
  readonly spec: Model;
  private link: Link;
  private delay: (ms: number) => Promise<void>;
  /** V1: whole block; V2: sensor block */
  private sensor = new Uint8Array(0);
  private system = new Uint8Array(0);
  private buttons: (number | undefined)[] = [];
  private profile = 0;
  private xy = false;

  constructor(
    private readonly device: HIDDevice,
    opts: OrbitalOptions = {},
  ) {
    const m = MODELS.get(device.productId);
    if (device.vendorId !== VID || !m) throw new Error('not an Orbital device');
    this.spec = m;
    this.id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
    this.delay = opts.sleep ?? realSleep;
    this.link = new Link(device, m.receiver, opts.timeoutMs ?? 1800);
  }

  brand(): string {
    return 'ORBITAL';
  }
  model(): string {
    return this.spec.name;
  }
  image(): string | undefined {
    return PHOTO;
  }
  get protocol(): Protocol {
    return this.spec.protocol;
  }
  private get v2(): boolean {
    return this.spec.protocol === 'dms_v2';
  }

  /** Talks to the USB device itself (never routed). V2 receivers name the mouse they're paired with. */
  async handshake(): Promise<void> {
    // unsolicited live-status packets (ops 8E / 98 / 99) share family 1 and sub 1: skip them
    const r = await this.link.send(F_INFO, 0x81, 0x01, [], { route: false, match: (b) => b[0] === F_INFO && !LIVE_OPS.has(b[2]) });
    if (this.spec.receiver && this.v2) {
      const vid = u16(r, 6);
      const pid = u16(r, 8);
      if (vid !== VID || pid !== this.spec.pairedPid) throw new Error('this receiver is paired with a different mouse');
    }
  }

  /** battery state / percent / active profile */
  private async power(): Promise<{ state: number; percent: number | null; profile: number }> {
    const r = await this.link.send(F_INFO, 0x81, 0x01);
    const [so, po, fo] = this.v2 ? [10, 11, 12] : [5, 6, 7];
    const raw = r[so];
    return {
      state: this.v2 && raw === 3 ? 0 : raw,
      percent: r[po] <= 100 ? r[po] : null,
      profile: r[fo] < PROFILES ? r[fo] : this.profile,
    };
  }

  private async readBlocks(): Promise<void> {
    if (this.v2) {
      const a = await this.link.send(F_SETTINGS, 0x81, 0x01);
      this.sensor = a.slice(4, 4 + V2S.len);
      const b = await this.link.send(F_SETTINGS, 0x83, 0x03);
      this.system = b.slice(4, 4 + V2Y.len);
    } else {
      const r = await this.link.send(F_SETTINGS, 0x81, 0x01, [], {
        match: (b) => (b[2] & 0x80) !== 0 && b[1] === 0 && (b[2] & 0x7f) >= V1.len && (b[2] & 0x7f) <= 60 && validSum(b),
      });
      this.sensor = r.slice(4, 4 + V1.len);
    }
  }

  // ---- field access over both layouts

  private get count(): number {
    return bits(this.sensor[this.v2 ? V2S.mask : V1.mask]) || STAGES;
  }
  private get active(): number {
    return Math.min(this.sensor[this.v2 ? V2S.active : V1.active], STAGES - 1);
  }
  private stage(i: number): [number, number] {
    const o = (this.v2 ? V2S.dpi : V1.dpi) + 4 * i;
    return [u16(this.sensor, o), u16(this.sensor, o + 2)];
  }
  private setStage(i: number, x: number, y: number): void {
    const o = (this.v2 ? V2S.dpi : V1.dpi) + 4 * i;
    put16(this.sensor, o, x);
    put16(this.sensor, o + 2, y);
  }
  private flag(name: 'snap' | 'ripple' | 'msync' | 'overclock' | 'perf' | 'wheelRev'): boolean {
    if (this.v2) {
      if (name === 'wheelRev') return this.system[V2Y.wheelRev] !== 0;
      return this.sensor[V2S[name]] !== 0;
    }
    return (this.sensor[V1.flags] & V1_FLAG[name]) !== 0;
  }
  private setFlag(name: 'snap' | 'ripple' | 'msync' | 'overclock' | 'perf' | 'wheelRev', on: boolean): void {
    if (this.v2) {
      if (name === 'wheelRev') this.system[V2Y.wheelRev] = on ? 1 : 0;
      else this.sensor[V2S[name]] = on ? 1 : 0;
      return;
    }
    const f = V1_FLAG[name];
    this.sensor[V1.flags] = on ? this.sensor[V1.flags] | f : this.sensor[V1.flags] & ~f;
  }
  private get rateRaw(): number {
    return this.v2 ? this.system[V2Y.rate] : this.sensor[V1.rate];
  }
  private get lod(): number {
    return this.sensor[this.v2 ? V2S.lod : V1.lod];
  }
  private get angle(): number {
    return signed(this.sensor[this.v2 ? V2S.angle : V1.angle]);
  }
  private get debounce(): number {
    return this.v2 ? this.system[V2Y.debounce] : this.sensor[V1.debounce];
  }
  private get sleepSec(): number {
    return this.v2 ? u16(this.system, V2Y.sleep) : u16(this.sensor, V1.sleepB);
  }
  private rates(): [string, number, number][] {
    return RATES.filter(([, , hz]) => hz <= this.spec.maxHz);
  }

  async read(): Promise<Setting[]> {
    await this.handshake();
    const out: Setting[] = [];
    out.push(text('model', 'Model', this.spec.name));
    out.push(text('connection', 'Connection', this.spec.receiver ? 'Wireless (receiver)' : 'Wired'));
    const pw = await this.power().catch(() => null);
    if (pw) {
      this.profile = pw.profile;
      if (pw.percent !== null) {
        const st = pw.state === 2 ? ' (full)' : pw.state === 1 || pw.state === 3 ? ' (charging)' : '';
        out.push(text('battery', 'Battery', `${pw.percent}%${st}`));
      }
    }
    out.push(text('protocol', 'Protocol', this.v2 ? 'DMS v2' : 'DMS v1'));
    out.push(s('profile', 'Active profile (all settings below belong to it)', 'Profile', choice(Array.from({ length: PROFILES }, (_, i) => [`Profile ${i + 1}`, i]), this.profile)));

    await this.readBlocks();

    // DPI
    const n = this.count;
    const pairs = Array.from({ length: n }, (_, i) => this.stage(i));
    this.xy = pairs.some(([x, y]) => x !== y) || this.xy;
    const active = Math.min(this.active, n - 1);
    const dpiVal = (stages: number[]): Value => ({ kind: 'dpi', stages, active, min: DPI_MIN, max: DPI_MAX, step: DPI_STEP });
    out.push(s('dpi', this.xy ? 'DPI stages (X)' : 'DPI stages', 'DPI', dpiVal(pairs.map((p) => p[0]))));
    if (this.xy) out.push(s('dpi_y', 'DPI stages (Y)', 'DPI', dpiVal(pairs.map((p) => p[1]))));
    out.push(s('dpi_count', 'Number of DPI stages', 'DPI', choice(Array.from({ length: STAGES }, (_, i) => [String(i + 1), i + 1]), n)));
    out.push(s('dpi_xy', 'Separate X / Y DPI', 'DPI', toggle(this.xy)));

    // performance
    const rate = this.rates().map(([l, c]) => [l, c] as [string, number]);
    const raw = this.rateRaw;
    if (!rate.some(([, c]) => c === raw)) {
      const known = RATES.find(([, c]) => c === raw);
      rate.push([known ? `${known[0]} (keep)` : `Code ${raw} (keep)`, raw]);
    }
    out.push(s('polling', 'Polling rate', 'Performance', choice(rate, raw)));
    const lod = [...LOD];
    if (!lod.some(([, c]) => c === this.lod)) lod.push([`Level ${this.lod}`, this.lod]);
    out.push(s('lod', 'Lift-off distance', 'Performance', choice(lod, this.lod), 'The mouse has three levels, not millimetres'));
    out.push(s('motion_sync', 'Motion sync', 'Performance', toggle(this.flag('msync'))));
    out.push(s('angle_snap', 'Angle snapping', 'Performance', toggle(this.flag('snap'))));
    out.push(s('ripple', 'Ripple control', 'Performance', toggle(this.flag('ripple'))));
    out.push(s('angle_tune', 'Angle tune', 'Performance', { kind: 'number', min: -30, max: 30, current: clamp(this.angle, -30, 30), unit: '°' }));
    out.push(s('high_perf', 'High performance mode', 'Performance', toggle(this.flag('perf')), 'No low-battery throttling, no sensor rest while active'));
    out.push(s('overclock', 'Full-speed (overclock) mode', 'Performance', toggle(this.flag('overclock')), 'Maximum sensor frame rate while active'));
    if (this.v2) out.push(s('quick_response', 'Quick response', 'Performance', toggle(this.system[V2Y.quick] !== 0)));

    // buttons
    for (const [k, label, idx] of BUTTONS) {
      const r = await this.link.send(F_BUTTON, 0x82, 0x03, [idx], { match: (b) => b[4] === idx }).catch(() => null);
      if (!r) {
        this.buttons[idx] = undefined;
        continue;
      }
      const val = ((r[5] << 24) | (r[6] << 16) | (r[7] << 8) | r[8]) >>> 0;
      this.buttons[idx] = val;
      const opts: [string, number][] = ACTIONS.map((a, i) => [a[0], i]);
      let current = ACTIONS.findIndex((a) => a[1] === val);
      if (current < 0) {
        const kind = r[5] === 9 ? 'macro' : `0x${val.toString(16).padStart(8, '0')}`;
        opts.unshift([`Custom (${kind}) (keep)`, KEEP]);
        current = KEEP;
      }
      out.push(s(k, label, 'Buttons', choice(opts, current)));
    }
    out.push(s('debounce', 'Click debounce', 'Buttons', { kind: 'number', min: 0, max: 30, current: clamp(this.debounce, 0, 30), unit: ' ms' }));
    out.push(s('wheel_reverse', 'Reverse scroll wheel', 'Buttons', toggle(this.flag('wheelRev'))));

    // power
    const sl = this.sleepSec;
    const sleepOpts = [...SLEEP];
    if (!sleepOpts.some(([, v]) => v === sl)) sleepOpts.push([`${sl} sec`, sl]);
    out.push(s('sleep', 'Sleep after', 'Power', choice(sleepOpts, sl)));
    return out;
  }

  private save(): Promise<Uint8Array> {
    return this.link.send(F_SAVE, 0x81, 0x01);
  }

  /** V1: write the whole block, read it back, compare, then save (like Orbital Control). */
  private async commitV1(): Promise<void> {
    const want = this.sensor.slice();
    await this.link.send(F_SETTINGS, 0xb5, 0x02, want, { match: (b) => b[1] === 0 && validSum(b) });
    await this.readBlocks();
    for (let i = 0; i < V1.compare; i++) {
      if (this.sensor[i] !== want[i]) throw new Error(`the mouse did not keep the new settings (field ${i})`);
    }
    await this.save();
  }

  private async commitSensor(): Promise<void> {
    if (!this.v2) return this.commitV1();
    // same shape as the read block; bytes 31..38 are sent as zero, as Orbital Control does
    const p = this.sensor.slice();
    p.fill(0, V2S.dpiEnd, V2S.colors);
    await this.link.send(F_SETTINGS, 0xbc, 0x02, p);
    await this.save();
  }

  private async commitSystem(): Promise<void> {
    if (!this.v2) return this.commitV1();
    const p = this.system.slice();
    // Orbital Control stores the same timeout for both radio modes
    p[V2Y.bleSleep] = p[V2Y.sleep];
    p[V2Y.bleSleep + 1] = p[V2Y.sleep + 1];
    await this.link.send(F_SETTINGS, 0x90, 0x04, p);
    await this.save();
  }

  private ensureRead(): void {
    if (!this.sensor.length || (this.v2 && !this.system.length)) throw new Error('read the mouse first');
  }

  private setSleep(sec: number): void {
    if (this.v2) put16(this.system, V2Y.sleep, sec);
    else {
      put16(this.sensor, V1.sleepA, sec);
      put16(this.sensor, V1.sleepB, sec);
    }
  }

  async write(st: Setting): Promise<void> {
    const v = st.value;
    const bad = () => new Error('bad value');
    if (st.key === 'profile') {
      if (v.kind !== 'choice' || !Number.isInteger(v.current) || v.current < 0 || v.current >= PROFILES) throw bad();
      return this.switchProfile(v.current);
    }
    const bi = BUTTONS.find(([k]) => k === st.key);
    if (bi) return this.writeButton(bi[2], v);
    this.ensureRead();
    switch (st.key) {
      case 'dpi':
      case 'dpi_y': {
        if (v.kind !== 'dpi' || v.stages.length < 1 || v.stages.length > STAGES) throw bad();
        const isX = st.key === 'dpi';
        v.stages.forEach((d, i) => {
          const [x, y] = this.stage(i);
          const val = snapDpi(d);
          if (isX) this.setStage(i, val, this.xy && i < this.count ? y : val);
          else this.setStage(i, x, val);
        });
        if (isX) {
          const n = v.stages.length;
          const maskAt = this.v2 ? V2S.mask : V1.mask;
          this.sensor[maskAt] = (1 << n) - 1;
          this.sensor[this.v2 ? V2S.active : V1.active] = clamp(Math.round(v.active), 0, n - 1);
        }
        return this.commitSensor();
      }
      case 'dpi_count': {
        if (v.kind !== 'choice' || v.current < 1 || v.current > STAGES) throw bad();
        const n = v.current;
        for (let i = 0; i < n; i++) {
          const [x, y] = this.stage(i);
          if (!x || !y) this.setStage(i, x || [400, 800, 1600, 3200, 4800][i], y || x || [400, 800, 1600, 3200, 4800][i]);
        }
        this.sensor[this.v2 ? V2S.mask : V1.mask] = (1 << n) - 1;
        const a = this.v2 ? V2S.active : V1.active;
        if (this.sensor[a] >= n) this.sensor[a] = 0;
        return this.commitSensor();
      }
      case 'dpi_xy': {
        if (v.kind !== 'toggle') throw bad();
        this.xy = v.on;
        if (v.on) return;
        for (let i = 0; i < STAGES; i++) {
          const [x] = this.stage(i);
          this.setStage(i, x, x);
        }
        return this.commitSensor();
      }
      case 'polling': {
        if (v.kind !== 'choice' || !this.rates().some(([, c]) => c === v.current)) throw bad();
        if (this.v2) {
          this.system[V2Y.rate] = v.current;
          return this.commitSystem();
        }
        this.sensor[V1.rate] = v.current;
        return this.commitV1();
      }
      case 'lod':
        if (v.kind !== 'choice' || !LOD.some(([, c]) => c === v.current)) throw bad();
        this.sensor[this.v2 ? V2S.lod : V1.lod] = v.current;
        return this.commitSensor();
      case 'angle_tune':
        if (v.kind !== 'number' || !Number.isFinite(v.current)) throw bad();
        this.sensor[this.v2 ? V2S.angle : V1.angle] = clamp(Math.round(v.current), -30, 30) & 0xff;
        return this.commitSensor();
      case 'motion_sync':
      case 'angle_snap':
      case 'ripple':
      case 'high_perf':
      case 'overclock': {
        if (v.kind !== 'toggle') throw bad();
        const name = ({ motion_sync: 'msync', angle_snap: 'snap', ripple: 'ripple', high_perf: 'perf', overclock: 'overclock' } as const)[st.key];
        this.setFlag(name, v.on);
        return this.commitSensor();
      }
      case 'wheel_reverse':
        if (v.kind !== 'toggle') throw bad();
        this.setFlag('wheelRev', v.on);
        return this.v2 ? this.commitSystem() : this.commitV1();
      case 'quick_response':
        if (!this.v2) throw new Error('quick response is a Pathfinder V2 setting');
        if (v.kind !== 'toggle') throw bad();
        this.system[V2Y.quick] = v.on ? 1 : 0;
        return this.commitSystem();
      case 'debounce':
        if (v.kind !== 'number' || !Number.isFinite(v.current)) throw bad();
        if (this.v2) {
          this.system[V2Y.debounce] = clamp(Math.round(v.current), 0, 30);
          return this.commitSystem();
        }
        this.sensor[V1.debounce] = clamp(Math.round(v.current), 0, 30);
        return this.commitV1();
      case 'sleep':
        if (v.kind !== 'choice' || !Number.isInteger(v.current) || v.current < 1 || v.current > 0xffff) throw bad();
        this.setSleep(v.current);
        return this.v2 ? this.commitSystem() : this.commitV1();
      default:
        throw new Error(`${st.key} can't be changed`);
    }
  }

  private async writeButton(idx: number, v: Value): Promise<void> {
    if (v.kind !== 'choice') throw new Error('bad value');
    if (v.current === KEEP) return;
    const a = ACTIONS[v.current];
    if (!a) throw new Error('bad action');
    if (this.buttons[idx] === undefined) throw new Error('read the buttons first');
    if (idx === 0 && a[1] !== LEFT) {
      // never leave the mouse without a left click
      const elsewhere = this.buttons.some((b, i) => i !== 0 && b === LEFT);
      if (!elsewhere) throw new Error('Put Left click on another button first');
    }
    const val = a[1];
    const data = val === 0 ? [] : [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff];
    await this.link.send(F_BUTTON, 0x80 | (data.length + 1), 0x04, [idx, ...data]);
    await this.save();
    this.buttons[idx] = val;
  }

  /** The ack can come before the switch, so check the status packet (3 tries, like Orbital Control). */
  private async switchProfile(p: number): Promise<void> {
    const sub = this.v2 ? 0x02 : 0x01;
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.link.send(F_PROFILE, 0x82, sub, [p]);
        await this.save();
      } catch (e) {
        last = e;
      }
      await this.delay(140 + attempt * 80);
      try {
        const pw = await this.power();
        if (pw.profile === p) {
          this.profile = p;
          return;
        }
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`profile ${p + 1} did not activate${last instanceof Error ? `: ${last.message}` : ''}`);
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factory

const hasConfig = (d: HIDDevice) => (d.collections ?? []).some((c) => c.usagePage === USAGE_PAGE && c.usage === 1);

export const orbitalFactory: DriverFactory = {
  name: 'Orbital (Pathfinder / Ghost)',
  filters: [...MODELS.keys()].map((productId) => ({ vendorId: VID, productId, usagePage: USAGE_PAGE, usage: 1 })),
  match(d: HIDDevice): boolean {
    return d.vendorId === VID && MODELS.has(d.productId) && hasConfig(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!orbitalFactory.match(device)) return null;
    if (!device.opened) await device.open();
    return new OrbitalDriver(device);
  },
};
