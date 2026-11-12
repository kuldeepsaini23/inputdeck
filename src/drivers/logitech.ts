// Logitech HID++ 2.0 gaming mice (LIGHTSPEED receivers and wired G mice), over WebHID.
//
// Written from public documentation of the protocol: Solaar (lib/logitech_receiver) and
// libratbag (src/hidpp20.c) were used as references for message layouts; no code was copied.
// NOT verified on real hardware yet.
//
// Frames (after the report id):
//   short 0x10:  [devIdx, featIdx, func<<4 | swId, p0, p1, p2]            (6 bytes)
//   long  0x11:  [devIdx, featIdx, func<<4 | swId, p0 .. p15]             (19 bytes)
// devIdx is 0xFF for a mouse plugged in by cable, 0x01..0x06 for a mouse behind a receiver.
// Feature indexes are looked up per device through the Root feature (index 0, id 0x0000).
// Errors come back as [devIdx, 0xFF, featIdx, funcSw, code] (HID++ 2.0) or
// [devIdx, 0x8F, featIdx, funcSw, code] (HID++ 1.0, e.g. the receiver saying "no such device").
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';

export const VID = 0x046d;
const REPORT_SHORT = 0x10;
const REPORT_LONG = 0x11;
const SHORT_LEN = 6;
const LONG_LEN = 19;
export const WIRED_INDEX = 0xff;

// feature ids
export const F_ROOT = 0x0000;
export const F_FEATURE_SET = 0x0001;
export const F_FW_INFO = 0x0003;
export const F_NAME = 0x0005;
export const F_BATTERY_STATUS = 0x1000;
export const F_BATTERY_VOLTAGE = 0x1001;
export const F_UNIFIED_BATTERY = 0x1004;
export const F_ADJUSTABLE_DPI = 0x2201;
export const F_REPORT_RATE = 0x8060;
export const F_EXT_REPORT_RATE = 0x8061;
export const F_ONBOARD_PROFILES = 0x8100;

/**
 * The only (feature, function) pairs this driver will ever send. Everything else is refused
 * before it reaches the device. Notably absent: DFU / firmware update (0x00C0, 0x00C2, 0x00D0),
 * device reset (0x1802), OOB state (0x1805), change host (0x1814), and every onboard-profile
 * function that changes the mode, the current profile or the profile memory (0x8100 fn 1, 3, 6, 7, 8, 0xC).
 * Receiver registers (HID++ 1.0) are never written; nothing is ever sent to a receiver itself.
 */
export const ALLOWED: ReadonlyMap<number, ReadonlySet<number>> = new Map<number, Set<number>>([
  [F_ROOT, new Set([0 /* getFeature */, 1 /* ping */])],
  [F_FEATURE_SET, new Set([0 /* getCount */])],
  [F_FW_INFO, new Set([0 /* getEntityCount */, 1 /* getFwInfo */])],
  [F_NAME, new Set([0 /* getNameLength */, 1 /* getName */, 2 /* getType */])],
  [F_BATTERY_STATUS, new Set([0 /* getBatteryLevelStatus */])],
  [F_BATTERY_VOLTAGE, new Set([0 /* getBatteryVoltage */])],
  [F_UNIFIED_BATTERY, new Set([1 /* getStatus */])],
  [F_ADJUSTABLE_DPI, new Set([0 /* getSensorCount */, 1 /* getDpiList */, 2 /* getDpi */, 3 /* setDpi */])],
  [F_REPORT_RATE, new Set([0 /* getRateList */, 1 /* getRate */, 2 /* setRate */])],
  [F_EXT_REPORT_RATE, new Set([1 /* getRateList */, 2 /* getRate */, 3 /* setRate */])],
  [F_ONBOARD_PROFILES, new Set([0 /* getDescription */, 2 /* getMode */, 4 /* getCurrentProfile */, 5 /* memoryRead */, 0xb /* getCurrentDpiIndex */])],
]);
/** Belt and braces: never even look these up. */
export const DENIED_FEATURES = new Set([0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00d0, 0x1802, 0x1803, 0x1805, 0x1814, 0x1815, 0x1e00, 0x1e01, 0x1e02, 0x1eb0, 0x1f1f]);

/** LIGHTSPEED receivers (HID++ 1.0 receiver, mouse behind it at 1..6). */
export const RECEIVER_PIDS = [0xc539, 0xc53a, 0xc53d, 0xc53f, 0xc541, 0xc545, 0xc547, 0xc54d];
/** Wired / cable-connected G mice live in 0xC07D..0xC0FF (plus the G502 Proteus Spectrum). create() confirms. */
/** HID++ device types (0x0005 fn 2) we take: mouse, trackpad, trackball. */
const MOUSE_TYPES = [3, 4, 5];
const isWiredMousePid =(pid: number) => (pid >= 0xc07d && pid <= 0xc0ff) || pid === 0xc332;

const ERRORS_20: Record<number, string> = {
  1: 'unknown error',
  2: 'invalid argument',
  3: 'out of range',
  4: 'hardware error',
  5: 'internal error',
  6: 'invalid feature index',
  7: 'invalid function',
  8: 'busy',
  9: 'unsupported',
};

// ---------------------------------------------------------------- model table / images

const IMG = 'https://resource.logitechg.com/w_600,c_limit,q_auto,f_auto,dpr_1.0/d_transparent.gif/content/dam/gaming/en/products/';
/** Matched against the name the mouse reports (feature 0x0005), most specific first. Images: Logitech's own CDN, top view. */
const MODELS: [RegExp, string | undefined][] = [
  [/SUPERLIGHT 2C/i, IMG + 'pro-x-superlight-2c-pdp/gallery/pro-x-superlight-2c-mouse-top-angle-black-gallery-1.png'],
  [/SUPERLIGHT 2 ?DEX|X2 DEX|2 DEX/i, IMG + 'pro-x-superlight-2-dex/gallery/new-gallery-assets-2025/pro-x-superlight-2-dex-mouse-top-angle-black-gallery-1.png'],
  [/SUPERLIGHT 2/i, IMG + 'pro-x-superlight-2/new-gallery-assets-2025/pro-x-superlight-2-mice-top-angle-black-gallery-1.png'],
  [/G502 X PLUS/i, IMG + 'g502x-plus/2026-update/gallery/g502-x-plus-top-angle-black-gallery-1.png'],
  [/G502 X LIGHTSPEED/i, IMG + 'g502x-lightspeed/gallery/g502-x-lightspeed-mouse-top-angle-black-gallery-1.png'],
  [/G502 X\b/i, IMG + 'g502x-corded/gallery/g502x-corded-gallery-1-black.png'],
  [/G502 LIGHTSPEED/i, IMG + 'g502-lightspeed-gaming-mouse/g502-lightspeed-gallery-1.png'],
  [/G903/i, IMG + 'g903-hero/2025-update/g903-lightspeed-mouse-top-angle-gallery-1.png'],
  [/G309/i, IMG + 'G309-Lightspeed-Gaming-Mouse/gallery/g309-lightspeed-wireless-mouse-black-gallery-1.png'],
  [/G305/i, IMG + 'g305/2025-update/g305-lightspeed-mouse-top-angle-black-gallery-1.png'],
  [/PRO 2 LIGHTSPEED/i, IMG + 'pro-2-lightspeed/gallery/pro2-lightspeed-black-new-gallery1.png'],
];
export function imageFor(name: string): string | undefined {
  return MODELS.find(([re]) => re.test(name))?.[1];
}

// ---------------------------------------------------------------- helpers

const s = (key: string, label: string, group: string, value: Value, hint?: string): Setting => (hint ? { key, label, group, value, hint } : { key, label, group, value });
const text = (key: string, label: string, group: string, t: string, hint?: string) => s(key, label, group, { kind: 'text', text: t }, hint);
const be16 = (d: ArrayLike<number>, o: number) => ((d[o] << 8) | d[o + 1]) & 0xffff;
const le16 = (d: ArrayLike<number>, o: number) => (d[o] | (d[o + 1] << 8)) & 0xffff;
const hex = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');

/** CRC-CCITT (poly 0x1021, init 0xFFFF) as used to protect onboard profile sectors. */
export function crcCcitt(d: ArrayLike<number>, len: number): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    crc ^= d[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export interface DpiRange {
  min: number;
  max: number;
  step: number;
  /** discrete values when the sensor has no step (empty when it is a range) */
  list: number[];
}

/** Parse the getSensorDpiList reply (after the sensor byte): BE words, 0xE000+step means "range with this step", 0 ends. */
export function parseDpiList(p: ArrayLike<number>, from = 1): DpiRange {
  const values: number[] = [];
  let step = 0;
  for (let i = from; i + 1 < p.length; i += 2) {
    const v = be16(p, i);
    if (v === 0) break;
    if (v > 0xe000) step = v - 0xe000;
    else values.push(v);
  }
  if (!values.length) return { min: 100, max: 25600, step: 50, list: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (step) return { min, max, step, list: [] };
  return { min, max, step: 1, list: values.sort((a, b) => a - b) };
}

/** Snap a requested DPI onto what the sensor accepts. */
export function snapDpi(r: DpiRange, dpi: number): number {
  const v = Math.max(r.min, Math.min(r.max, Math.round(dpi)));
  if (r.list.length) return r.list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), r.list[0]);
  return Math.min(r.max, r.min + Math.round((v - r.min) / r.step) * r.step);
}

/** Solaar's voltage -> remaining-charge table for 0x1001 (mV, %). */
const VOLTAGE_CURVE: [number, number][] = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50], [3778, 40], [3751, 30], [3717, 20], [3671, 10], [3646, 5], [3579, 2], [3500, 0],
];
export function voltageToPercent(mv: number): number {
  if (mv >= VOLTAGE_CURVE[0][0]) return 100;
  for (let i = 1; i < VOLTAGE_CURVE.length; i++) {
    const [v1, p1] = VOLTAGE_CURVE[i];
    const [v0, p0] = VOLTAGE_CURVE[i - 1];
    if (mv >= v1) return Math.round(p1 + ((mv - v1) * (p0 - p1)) / (v0 - v1));
  }
  return 0;
}

/** 0x8061 rate index -> Hz (8 ms, 4 ms, 2 ms, 1 ms, 500 us, 250 us, 125 us). */
export const EXT_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

// ---------------------------------------------------------------- transport

export class HidppError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly v1: boolean,
  ) {
    super(message);
  }
}

class Link {
  private waiters: { dev: number; feat: number; fsw: number; resolve: (r: Uint8Array | Error) => void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private sw = 0;

  constructor(
    private readonly hid: HIDDevice,
    private readonly hasShort: boolean,
    private readonly timeout: number,
  ) {
    hid.addEventListener('inputreport', this.onReport);
  }

  detach(): void {
    this.hid.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_SHORT && e.reportId !== REPORT_LONG) return;
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (d.length < 4) return;
    if (d[1] === 0xff || d[1] === 0x8f) {
      const i = this.waiters.findIndex((w) => w.dev === d[0] && w.feat === d[2] && w.fsw === d[3]);
      if (i >= 0) {
        const v1 = d[1] === 0x8f;
        const code = d[4];
        const msg = v1 ? `HID++ 1.0 error ${code}${code === 9 ? ' (no device at this index)' : ''}` : `HID++ error: ${ERRORS_20[code] ?? code}`;
        this.waiters.splice(i, 1)[0].resolve(new HidppError(msg, code, v1));
      }
      return;
    }
    const i = this.waiters.findIndex((w) => w.dev === d[0] && w.feat === d[1] && w.fsw === d[2]);
    if (i < 0) return; // notification or a late answer
    const params = new Uint8Array(16);
    params.set(d.subarray(3, 19));
    this.waiters.splice(i, 1)[0].resolve(params);
  };

  /** Raw request. Callers must have passed the allowlist. Returns 16 parameter bytes (zero padded). */
  request(dev: number, feat: number, func: number, params: number[], timeout = this.timeout, attempts = 2): Promise<Uint8Array> {
    const run = async () => {
      const long = params.length > 3 || !this.hasShort;
      const id = long ? REPORT_LONG : REPORT_SHORT;
      const buf = new Uint8Array(long ? LONG_LEN : SHORT_LEN);
      for (let attempt = 0; attempt < attempts; attempt++) {
        this.sw = (this.sw + 1) & 7;
        const fsw = ((func & 0x0f) << 4) | (0x08 | this.sw);
        buf.fill(0);
        buf[0] = dev;
        buf[1] = feat;
        buf[2] = fsw;
        params.forEach((b, i) => (buf[3 + i] = b & 0xff));
        const got = new Promise<Uint8Array | Error | null>((resolve) => {
          const w = { dev, feat, fsw, resolve: (r: Uint8Array | Error) => resolve(r) };
          this.waiters.push(w);
          setTimeout(() => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) {
              this.waiters.splice(i, 1);
              resolve(null);
            }
          }, timeout);
        });
        await this.hid.sendReport(id, buf);
        const r = await got;
        if (r instanceof Error) throw r;
        if (r) return r;
      }
      throw new Error('no answer — is the mouse awake?');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface LogitechOptions {
  /** ms to wait for each answer (default 1000) */
  timeout?: number;
}

type RateKind = { feature: typeof F_EXT_REPORT_RATE; options: number[]; current: number } | { feature: typeof F_REPORT_RATE; options: number[]; current: number };

export class LogitechDriver implements Driver {
  readonly id: string;
  readonly family = 'Logitech HID++ 2.0';
  readonly kind: DeviceKind = 'mouse';
  readonly verified = false;
  private link: Link;
  private readonly receiver: boolean;
  private devIndex = -1;
  private features = new Map<number, number>();
  private name = '';
  private deviceType = -1;
  private protocol = '';
  private dpiRange: DpiRange | null = null;
  private sensor = 0;
  private rate: RateKind | null = null;

  constructor(
    private readonly device: HIDDevice,
    opts: LogitechOptions = {},
  ) {
    this.id = `${hex(device.vendorId, 4).toLowerCase()}:${hex(device.productId, 4).toLowerCase()}`;
    this.receiver = RECEIVER_PIDS.includes(device.productId);
    const hasShort = (device.collections ?? []).some((c) => (c.outputReports ?? []).some((r) => r.reportId === REPORT_SHORT));
    this.link = new Link(device, hasShort, opts.timeout ?? 1000);
  }

  brand(): string {
    return 'LOGITECH G';
  }
  model(): string {
    return this.name || (this.receiver ? 'LIGHTSPEED mouse' : 'Logitech G mouse');
  }
  image(): string | undefined {
    return this.name ? imageFor(this.name) : undefined;
  }
  /** device index in use (0xFF wired, 1..6 behind a receiver), -1 before init */
  get index(): number {
    return this.devIndex;
  }
  /** HID++ device type from 0x0005 (3 = mouse), -1 if unknown */
  get type(): number {
    return this.deviceType;
  }

  /** Root ping at one index; returns "major.minor" or throws. */
  private async ping(idx: number, timeout?: number): Promise<string> {
    const r = await this.link.request(idx, 0, 1, [0, 0, 0x5a], timeout, 1);
    if (r[2] !== 0x5a) throw new Error('bad ping');
    if (r[0] < 2) throw new Error('not HID++ 2.0');
    return `${r[0]}.${r[1]}`;
  }

  /** Find the mouse: 0xFF when wired, else the first receiver slot that answers a HID++ 2.0 ping. */
  async init(): Promise<void> {
    if (this.devIndex >= 0) return;
    const slots = this.receiver ? [1, 2, 3, 4, 5, 6] : [WIRED_INDEX];
    let last: unknown = null;
    const found: { idx: number; proto: string }[] = [];
    for (const idx of slots) {
      try {
        found.push({ idx, proto: await this.ping(idx, this.receiver ? 400 : undefined) });
      } catch (e) {
        last = e;
      }
    }
    if (!found.length) {
      throw new Error(this.receiver ? 'no mouse answered behind the receiver — switch it on or move it' : `the mouse did not answer (${(last as Error)?.message ?? 'no reply'})`);
    }
    // behind a receiver, prefer the slot that says it is a mouse
    for (const f of found) {
      await this.identify(f.idx, f.proto);
      if (MOUSE_TYPES.includes(this.deviceType)) return;
    }
    await this.identify(found[0].idx, found[0].proto);
  }

  private async identify(idx: number, proto: string): Promise<void> {
    this.devIndex = idx;
    this.protocol = proto;
    this.features.clear();
    this.features.set(F_ROOT, 0);
    this.name = '';
    this.deviceType = -1;
    if (await this.has(F_NAME).catch(() => false)) {
      this.name = await this.readName().catch(() => '');
      this.deviceType = await this.call(F_NAME, 2, []).then((r) => r[0], () => -1);
    }
  }

  /** stop listening without closing the HID device */
  release(): void {
    this.link.detach();
  }

  /** feature index (0 = absent), cached */
  private async indexOf(id: number): Promise<number> {
    if (DENIED_FEATURES.has(id) || !ALLOWED.has(id)) throw new Error(`HID++ feature ${hex(id, 4)} is blocked`);
    const known = this.features.get(id);
    if (known !== undefined) return known;
    const r = await this.link.request(this.devIndex, 0, 0, [id >> 8, id & 0xff]);
    const idx = id === F_ROOT ? 0 : r[0];
    this.features.set(id, idx);
    return idx;
  }

  private async has(id: number): Promise<boolean> {
    return (await this.indexOf(id)) !== 0;
  }

  /** The only way a feature request leaves this driver. */
  private async call(id: number, func: number, params: number[]): Promise<Uint8Array> {
    if (!ALLOWED.get(id)?.has(func)) throw new Error(`HID++ ${hex(id, 4)} function ${func} is blocked`);
    const idx = await this.indexOf(id);
    if (idx === 0 && id !== F_ROOT) throw new Error(`feature ${hex(id, 4)} not supported`);
    return this.link.request(this.devIndex, idx, func, params);
  }

  private async readName(): Promise<string> {
    const len = Math.min(64, (await this.call(F_NAME, 0, []))[0]);
    let out = '';
    while (out.length < len) {
      const r = await this.call(F_NAME, 1, [out.length]);
      let chunk = '';
      for (const b of r) {
        if (b === 0 || out.length + chunk.length >= len) break;
        chunk += String.fromCharCode(b);
      }
      if (!chunk) break;
      out += chunk;
    }
    return out.trim();
  }

  private async readFirmware(): Promise<string | null> {
    const n = Math.min(8, (await this.call(F_FW_INFO, 0, []))[0]);
    for (let i = 0; i < n; i++) {
      const r = await this.call(F_FW_INFO, 1, [i]);
      if ((r[0] & 0x0f) !== 0) continue; // 0 = main application
      const prefix = String.fromCharCode(r[1], r[2], r[3]).replace(/\0/g, '').trim();
      const build = be16(r, 6);
      return `${prefix ? prefix + ' ' : ''}${hex(r[4], 2)}.${hex(r[5], 2)}${build ? `.B${hex(build, 4)}` : ''}`;
    }
    return null;
  }

  private async readBattery(): Promise<string | null> {
    if (await this.has(F_UNIFIED_BATTERY)) {
      const r = await this.call(F_UNIFIED_BATTERY, 1, []);
      const approx: Record<number, number> = { 8: 100, 4: 50, 2: 20, 1: 5 };
      const pct = r[0] || approx[r[1]] || 0;
      const st = r[2] === 1 || r[2] === 2 ? ' (charging)' : r[2] === 3 ? ' (charged)' : '';
      return `${pct}%${r[0] ? '' : ' (approx.)'}${st}`;
    }
    if (await this.has(F_BATTERY_STATUS)) {
      const r = await this.call(F_BATTERY_STATUS, 0, []);
      const st = r[2] === 1 || r[2] === 2 || r[2] === 4 ? ' (charging)' : r[2] === 3 ? ' (charged)' : '';
      return `${r[0]}%${st}`;
    }
    if (await this.has(F_BATTERY_VOLTAGE)) {
      const r = await this.call(F_BATTERY_VOLTAGE, 0, []);
      const mv = be16(r, 0);
      const charging = (r[2] & 0x80) !== 0;
      return `${voltageToPercent(mv)}% (${mv} mV${charging ? ', charging' : ''})`;
    }
    return null;
  }

  private async readRate(): Promise<RateKind | null> {
    if (await this.has(F_EXT_REPORT_RATE)) {
      const list = await this.call(F_EXT_REPORT_RATE, 1, []);
      const flags = be16(list, 0);
      const options = EXT_RATES.map((_, i) => i).filter((i) => flags & (1 << i));
      const cur = (await this.call(F_EXT_REPORT_RATE, 2, []))[0];
      if (options.length) return { feature: F_EXT_REPORT_RATE, options, current: cur };
    }
    if (await this.has(F_REPORT_RATE)) {
      const flags = (await this.call(F_REPORT_RATE, 0, []))[0];
      const options = [1, 2, 3, 4, 5, 6, 7, 8].filter((ms) => flags & (1 << (ms - 1)));
      const cur = (await this.call(F_REPORT_RATE, 1, []))[0];
      if (options.length) return { feature: F_REPORT_RATE, options, current: cur };
    }
    return null;
  }

  /** Read-only look at onboard memory: mode, active profile and (if its sector checks out) its DPI stages. */
  private async readOnboard(out: Setting[]): Promise<boolean> {
    if (!(await this.has(F_ONBOARD_PROFILES))) return false;
    const desc = await this.call(F_ONBOARD_PROFILES, 0, []);
    const mode = (await this.call(F_ONBOARD_PROFILES, 2, []))[0];
    if (mode !== 1) {
      out.push(text('onboard_profile', 'Onboard memory', 'Performance', mode === 2 ? 'Off (host mode)' : `Mode ${mode}`));
      return false;
    }
    const cur = await this.call(F_ONBOARD_PROFILES, 4, []);
    const sector = be16(cur, 0);
    const label = sector >= 0x100 ? `Built-in profile ${sector & 0xff}` : `Profile ${sector}`;
    out.push(
      text('onboard_profile', 'Onboard memory', 'Performance', `On — ${label}`, 'Settings saved in the mouse (e.g. by G HUB) can override DPI and polling changes made here. Profile contents are not edited.'),
    );

    const memModel = desc[0];
    const format = desc[1];
    const sectorSize = be16(desc, 7);
    if (memModel !== 1 || format < 1 || format > 5 || sectorSize < 32 || sectorSize > 1024 || sector === 0) return true;
    const data = new Uint8Array(sectorSize);
    for (let off = 0; off < sectorSize; off += 16) {
      const o = Math.min(off, sectorSize - 16); // the mouse refuses reads that run past the end
      const r = await this.call(F_ONBOARD_PROFILES, 5, [sector >> 8, sector & 0xff, o >> 8, o & 0xff]);
      data.set(r.subarray(0, 16), o);
    }
    if (crcCcitt(data, sectorSize - 2) !== be16(data, sectorSize - 2)) return true;
    const stages: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = le16(data, 3 + 2 * i);
      if (v && v !== 0xffff) stages.push(v);
    }
    if (!stages.length) return true;
    let active = data[1];
    const idx = await this.call(F_ONBOARD_PROFILES, 0xb, []).then((r) => r[0], () => -1);
    if (idx >= 0 && idx < stages.length) active = idx;
    const list = stages.map((v, i) => (i === active ? `[${v}]` : String(v))).join(' / ');
    out.push(text('dpi_onboard', 'DPI stages in the active onboard profile', 'DPI', list, 'Read-only. The DPI button cycles through these; [ ] marks the current stage.'));
    return true;
  }

  async read(): Promise<Setting[]> {
    await this.init();
    const out: Setting[] = [];
    out.push(text('model', 'Model', 'Info', this.model()));
    out.push(text('connection', 'Connection', 'Info', this.devIndex === WIRED_INDEX ? 'USB cable' : `LIGHTSPEED receiver (slot ${this.devIndex})`));
    const fw = await this.has(F_FW_INFO).then((h) => (h ? this.readFirmware() : null)).catch(() => null);
    if (fw) out.push(text('fw', 'Firmware', 'Info', fw));
    const bat = await this.readBattery().catch(() => null);
    if (bat) out.push(text('battery', 'Battery', 'Info', bat));
    const count = await this.has(F_FEATURE_SET).then((h) => (h ? this.call(F_FEATURE_SET, 0, []).then((r) => r[0]) : null)).catch(() => null);
    out.push(text('protocol', 'Protocol', 'Info', `HID++ ${this.protocol}${count ? ` · ${count} features` : ''}`));

    // DPI (0x2201): the current sensor DPI as a single stage
    if (await this.has(F_ADJUSTABLE_DPI)) {
      const n = (await this.call(F_ADJUSTABLE_DPI, 0, []))[0];
      if (n > 0) {
        this.sensor = 0;
        const list = await this.call(F_ADJUSTABLE_DPI, 1, [this.sensor]);
        this.dpiRange = parseDpiList(list);
        const cur = await this.call(F_ADJUSTABLE_DPI, 2, [this.sensor]);
        const dpi = be16(cur, 1);
        const r = this.dpiRange;
        out.push(
          s('dpi', 'DPI', 'DPI', { kind: 'dpi', stages: [dpi || be16(cur, 3) || r.min], active: 0, min: r.min, max: r.max, step: r.list.length ? 1 : r.step }, 'Current sensor DPI. Values snap to what the sensor supports.'),
        );
      }
    }

    // polling rate (0x8061 preferred, then 0x8060)
    this.rate = await this.readRate().catch(() => null);
    if (this.rate) {
      const rt = this.rate;
      const opts: [string, number][] =
        rt.feature === F_EXT_REPORT_RATE ? rt.options.map((i) => [`${EXT_RATES[i]} Hz`, i]) : rt.options.map((ms) => [`${Math.round(1000 / ms)} Hz`, ms]);
      if (!opts.some(([, v]) => v === rt.current)) opts.push([`Code ${rt.current}`, rt.current]);
      out.push(s('polling', 'Polling rate', 'Performance', { kind: 'choice', options: opts, current: rt.current }));
    }

    await this.readOnboard(out).catch(() => false);
    // keep the model text in sync with what we learned
    out[0] = text('model', 'Model', 'Info', this.model());
    return out;
  }

  async write(st: Setting): Promise<void> {
    await this.init();
    const v = st.value;
    switch (st.key) {
      case 'dpi': {
        if (v.kind !== 'dpi' || !v.stages.length) throw new Error('bad value');
        const r = this.dpiRange;
        if (!r) throw new Error('DPI is not adjustable on this mouse');
        const want = v.stages[Math.min(Math.max(0, v.active), v.stages.length - 1)];
        if (!Number.isFinite(want)) throw new Error('bad DPI');
        const dpi = snapDpi(r, want);
        await this.call(F_ADJUSTABLE_DPI, 3, [this.sensor, dpi >> 8, dpi & 0xff]);
        return;
      }
      case 'polling': {
        const rt = this.rate;
        if (v.kind !== 'choice' || !rt || !rt.options.includes(v.current)) throw new Error('bad value');
        if (rt.feature === F_EXT_REPORT_RATE) await this.call(F_EXT_REPORT_RATE, 3, [v.current]);
        else await this.call(F_REPORT_RATE, 2, [v.current]);
        rt.current = v.current;
        return;
      }
      default:
        throw new Error(`${st.key} can't be changed`);
    }
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factory

const hasHidpp = (d: HIDDevice) =>
  (d.collections ?? []).some((c) => (c.usagePage ?? 0) === 0xff00 && (c.outputReports ?? []).some((r) => r.reportId === REPORT_LONG)) &&
  (d.collections ?? []).some((c) => (c.inputReports ?? []).some((r) => r.reportId === REPORT_LONG));

export const logitechFactory: DriverFactory = {
  name: 'Logitech G (HID++)',
  filters: [{ vendorId: VID, usagePage: 0xff00 }],
  match(d: HIDDevice): boolean {
    if (d.vendorId !== VID) return false;
    if (!RECEIVER_PIDS.includes(d.productId) && !isWiredMousePid(d.productId)) return false;
    return hasHidpp(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!logitechFactory.match(device)) return null;
    const openedHere = !device.opened;
    if (openedHere) await device.open();
    const drv = new LogitechDriver(device);
    const receiver = RECEIVER_PIDS.includes(device.productId);
    try {
      await drv.init();
    } catch {
      // a receiver may be plugged in with the mouse off: keep it, read() says so
      if (receiver) return drv;
      drv.release();
      if (openedHere) await device.close().catch(() => undefined);
      return null;
    }
    // keyboards / headsets also speak HID++: only take mice, trackballs and trackpads (or unknown)
    if (drv.type >= 0 && !MOUSE_TYPES.includes(drv.type)) {
      drv.release();
      if (openedHere) await device.close().catch(() => undefined);
      return null;
    }
    return drv;
  },
};
