// Finalmouse driver: UltralightX (ULX family: ULX Prophecy, ULX Pro Series, ULX Competition) through
// its wireless receiver, and Starlight X (SLX) through its receiver or the USB cable.
//
// Source: Finalmouse's own web configurator Xpanel (https://xpanel.finalmouse.com, a SvelteKit app
// using WebHID), read statically from its public JS bundles (Nov 2026):
//   _app/immutable/chunks/YNk7IF1T.js   USB ids, device types, battery curve, LOD codes
//   _app/immutable/chunks/BhIB3vuQ.js   command ids (CMD_ID_*), packet framing, report ids, parsers
//   _app/immutable/chunks/C3Dnzky7.js   which interface / usage page belongs to which device type
//   _app/immutable/nodes/11, 14, 19, 27  DPI (400-12800 step 100), LOD, polling (500-8000 Hz), Bhop pages
// linux-hardware.org lists 361d:0100 as "UltralightX dongle" (independent check of the vendor id).
// TechPowerUp's UltralightX review: Xpanel only works through the dongle, not in wired mode.
//
// Packet (63 data bytes after the report id), both directions:
//   [2 + n, 0x80 | cmd, n, payload x n, 0...]          (replies: cmd = byte1 & 0x7f)
// Output / input report ids: SLX 1 / 2, ULX receiver 4 / 5 (cmd 0x0A, the receiver's USB firmware
// version, goes out on report 2). The ULX receiver answers "get DPI" as cmd 3 and "get polling" as
// cmd 4; Xpanel treats them as 16 / 17.
// Xpanel reads everything with one "send all" request (cmd 0x60) and the device answers with one
// report per setting; a set command is confirmed when the device reports the new value. We do the
// same: every write is followed by a fresh "send all" and the value must come back.
//
// Never sent (refused by allowed()): reset / bootloader (1, 2, 6, 8), pairing (40-42), FOTA (48, 49),
// OTP provisioning (50), calibration (27, 28, 60), profiles (57, 58, 62, 63), signing (64-67),
// erase (0x70). Nothing has been checked on real hardware: verified = false (read-only until allowed).
//
// Not covered: older Finalmouse mice (Starlight-12, Starlight Pro / TenZ, Air58, Ultralight 2) have
// no configurator and no published USB ids; Centerpiece Pro (361d:0200 / 0202) is a keyboard.
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';

export const FM_VID = 0x361d;
const PACKET = 63;

type Kind = 'ulx_dongle' | 'ulx_wired' | 'slx_dongle' | 'slx_mouse';

interface Product {
  kind: Kind;
  model: string;
  connection: string;
}

/** Product ids from Xpanel (YNk7IF1T.js). Bootloader ids (0x0101, 0x0111, 1fc9:0022) are left out on purpose. */
export const PRODUCTS: Record<number, Product> = {
  0x0100: { kind: 'ulx_dongle', model: 'UltralightX', connection: 'Receiver' },
  0x0102: { kind: 'ulx_wired', model: 'UltralightX', connection: 'USB cable' },
  0x0300: { kind: 'slx_dongle', model: 'Starlight X', connection: 'Receiver' },
  0x0301: { kind: 'slx_dongle', model: 'Starlight X', connection: 'Receiver' },
  0x0310: { kind: 'slx_mouse', model: 'Starlight X', connection: 'USB cable' },
  0x0311: { kind: 'slx_mouse', model: 'Starlight X', connection: 'USB cable' },
};

/** Xpanel's own pictures (COw4jiW6.js: mouseSLX.webp for SLX, Mouse.webp otherwise). */
const PHOTO_ULX = 'https://xpanel.finalmouse.com/images/Mouse.webp';
const PHOTO_SLX = 'https://xpanel.finalmouse.com/images/mouseSLX.webp';
export const photoOf = (pid: number): string | undefined => {
  const p = PRODUCTS[pid];
  if (!p) return undefined;
  return p.kind.startsWith('slx') ? PHOTO_SLX : PHOTO_ULX;
};

// command ids (Xpanel's CMD_ID_* enum)
export const CMD = {
  DONGLE_USB_FW: 0x0a,
  DONGLE_RF_FW: 0x0b,
  MOUSE_FW: 0x0c,
  VBAT: 0x05,
  DPI: 0x10,
  POLLING: 0x11,
  MOTION_SYNC: 0x12,
  LOD: 0x15,
  PAW_LOD: 0x19,
  BHOP_MODE: 0x17,
  BHOP_TIMEOUT: 0x18,
  LINK_STATE: 0x24,
  CHARGING: 0x25,
  BATTERY: 0x26,
  ALL: 0x60,
} as const;

const isSlx = (k: Kind) => k === 'slx_dongle' || k === 'slx_mouse';
const outReport = (k: Kind, cmd: number) => (isSlx(k) ? 1 : cmd === CMD.DONGLE_USB_FW ? 2 : 4);

export const POLLING_HZ = [500, 1000, 2000, 4000, 8000];
const DPI_MIN = 400;
const DPI_MAX = 12800;
const DPI_STEP = 100;
/** Bhop pass-through window choices (ms), sent in steps of 100 ms */
const BHOP_WINDOWS = [100, 500, 1000, 1500];
/** SLX PAW LOD codes: 1/2/3 = 0.7/1/2 mm, 7..17 = tenths of a mm (Xpanel's V()) */
export function pawLodMm(code: number): number | null {
  const fixed: Record<number, number> = { 1: 0.7, 2: 1, 3: 2 };
  if (code in fixed) return fixed[code];
  return code >= 7 && code <= 20 ? code / 10 : null;
}

/** Build one 63-byte packet. */
export function packet(cmd: number, payload: number[] = []): Uint8Array<ArrayBuffer> {
  const p = new Uint8Array(PACKET);
  p[0] = 2 + payload.length;
  p[1] = 0x80 | cmd;
  p[2] = payload.length;
  p.set(payload, 3);
  return p;
}

/**
 * Allowlist for everything this driver sends: (device kind, report id, 63 bytes). Only "send all",
 * the version reads and the settings below, with values Xpanel itself offers.
 */
export function allowed(kind: Kind, reportId: number, p: ArrayLike<number>): boolean {
  if (kind === 'ulx_wired' || p.length !== PACKET) return false;
  const n = p[2];
  if (p[0] !== 2 + n || (p[1] & 0x80) === 0 || n > 2) return false;
  for (let i = 3 + n; i < PACKET; i++) if (p[i] !== 0) return false;
  const cmd = p[1] & 0x7f;
  if (reportId !== outReport(kind, cmd)) return false;
  const b = p[3];
  const u16 = p[3] | (p[4] << 8);
  switch (cmd) {
    case CMD.ALL:
    case CMD.MOUSE_FW:
      return n === 0;
    case CMD.DONGLE_USB_FW:
      return n === 0 && kind === 'ulx_dongle';
    case CMD.DPI:
      return n === 2 && u16 >= DPI_MIN && u16 <= DPI_MAX && u16 % DPI_STEP === 0;
    case CMD.POLLING:
      return n === 2 && POLLING_HZ.includes(u16);
    case CMD.MOTION_SYNC:
      return n === 1 && (b === 0 || b === 1);
    case CMD.LOD:
      return n === 1 && (b === 1 || b === 2) && (kind === 'ulx_dongle' || kind === 'slx_dongle');
    case CMD.PAW_LOD:
      return n === 1 && isSlx(kind) && (b === 2 || b === 3 || (b >= 11 && b <= 17));
    case CMD.BHOP_MODE:
      return n === 1 && b <= 3;
    case CMD.BHOP_TIMEOUT:
      return n === 1 && BHOP_WINDOWS.includes(b * 100);
    default:
      return false;
  }
}

/** Xpanel's battery curve (YNk7IF1T.js is()): millivolts -> percent. */
export function batteryPct(mv: number): number {
  const v = mv / 1000;
  const volts = [3, 3.62, 3.66, 3.74, 3.88, 4.17, 4.38];
  const pct = [0.2, 5, 10, 25, 50, 75, 100];
  if (v > 4.38) return 100;
  if (v < 3) return 0;
  for (let i = 0; i < volts.length - 1; i++) {
    if (v >= volts[i] && v <= volts[i + 1]) {
      const f = (v - volts[i]) / (volts[i + 1] - volts[i]);
      return Math.round(pct[i] + (pct[i + 1] - pct[i]) * f);
    }
  }
  return 100;
}

/** "1.1.0" >= "1.0.9" */
function atLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const u16 = (p: Uint8Array) => p[0] | (p[1] << 8);
const ascii = (p: Uint8Array) => {
  let s = '';
  for (const c of p) {
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};
/** firmware string, or undefined for empty / 0.0.0 (Xpanel's ie()) */
const version = (p?: Uint8Array) => {
  const s = p ? ascii(p) : '';
  return s && !/^0\.0\.0(-|$)/.test(s) ? s : undefined;
};

const s = (key: string, label: string, group: string, value: Value): Setting => ({ key, label, group, value });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });

type Listener = (reportId: number, data: Uint8Array) => void;

export interface FinalmouseOptions {
  /** how long to wait for the answers to one "send all" (ms) */
  timeout?: number;
  /** quiet time after the needed answers arrived, for the optional ones (ms) */
  settle?: number;
}

export class FinalmouseDriver implements Driver {
  readonly id: string;
  readonly family = 'Finalmouse (Xpanel)';
  readonly kind: DeviceKind = 'mouse';
  readonly verified = false;
  private readonly product: Product;
  private listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = new Map<number, Uint8Array>();
  private timeout: number;
  private settle: number;

  constructor(
    private readonly device: HIDDevice,
    opts: FinalmouseOptions = {},
  ) {
    this.id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
    this.product = PRODUCTS[device.productId] ?? { kind: 'ulx_wired', model: 'Finalmouse mouse', connection: 'Unknown' };
    this.timeout = opts.timeout ?? 1500;
    this.settle = opts.settle ?? 120;
    device.addEventListener('inputreport', this.onReport);
  }

  brand(): string {
    return 'FINALMOUSE';
  }
  model(): string {
    return this.product.model;
  }
  image(): string | undefined {
    return photoOf(this.device.productId);
  }

  private get k(): Kind {
    return this.product.kind;
  }

  private onReport = (e: HIDInputReportEvent) => {
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    for (const l of this.listeners) l(e.reportId, d);
  };

  /** cmd + payload of a reply, with the ULX receiver's get-DPI / get-polling ids mapped like Xpanel does */
  private parse(d: Uint8Array): [number, Uint8Array] | null {
    if (d.length < 3) return null;
    let cmd = d[1] & 0x7f;
    if (!isSlx(this.k)) {
      if (cmd === 3) cmd = CMD.DPI;
      else if (cmd === 4) cmd = CMD.POLLING;
    }
    const n = d[2];
    if (d.length < 3 + n) return null;
    return [cmd, d.slice(3, 3 + n)];
  }

  private async send(cmd: number, payload: number[] = []): Promise<void> {
    const rid = outReport(this.k, cmd);
    const p = packet(cmd, payload);
    if (!allowed(this.k, rid, p)) throw new Error(`refusing to send command ${hex2(cmd)}`);
    await this.device.sendReport(rid, p);
  }

  /** "Send all" (plus the version reads) and collect the answers until `need` are in, then a short quiet time. */
  private collect(need: number[]): Promise<Map<number, Uint8Array>> {
    const run = async () => {
      const got = new Map<number, Uint8Array>();
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const l: Listener = (_rid, d) => {
        const r = this.parse(d);
        if (!r) return;
        got.set(r[0], r[1]);
        if (need.every((c) => got.has(c))) {
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(done, this.settle);
        }
      };
      this.listeners.add(l);
      const deadline = setTimeout(done, this.timeout);
      try {
        await this.send(CMD.ALL);
        await this.send(CMD.MOUSE_FW).catch(() => undefined);
        if (this.k === 'ulx_dongle') await this.send(CMD.DONGLE_USB_FW).catch(() => undefined);
        await finished;
      } finally {
        clearTimeout(deadline);
        if (quiet) clearTimeout(quiet);
        this.listeners.delete(l);
      }
      for (const [c, p] of got) this.last.set(c, p);
      return got;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private lodCmd(): number {
    return isSlx(this.k) ? CMD.PAW_LOD : CMD.LOD;
  }

  /** lift-off as tenths of a mm from the last answers */
  private lodTenths(m: Map<number, Uint8Array>): number | undefined {
    const p = m.get(this.lodCmd());
    if (!p || p.length < 1) return undefined;
    const mm = isSlx(this.k) ? pawLodMm(p[0]) : p[0];
    return mm === null ? undefined : Math.round(mm * 10);
  }

  async read(): Promise<Setting[]> {
    const pr = this.product;
    const out: Setting[] = [text('model', 'Model', 'Info', pr.model), text('connection', 'Connection', 'Info', pr.connection)];
    if (this.k === 'ulx_wired') {
      out.push(
        {
          key: 'unsupported',
          label: 'Not available over the cable',
          group: 'Settings',
          value: { kind: 'text', text: '' },
          hint: "Finalmouse's own Xpanel changes UltralightX settings only through the wireless receiver. Plug the receiver in and connect it here. If your mouse should work over the cable, tell us with the Feedback button.",
        },
      );
      return out;
    }
    const m = await this.collect([CMD.DPI, CMD.POLLING, CMD.MOTION_SYNC, this.lodCmd()]);
    const fw = version(m.get(CMD.MOUSE_FW));
    const dongleFw = version(m.get(CMD.DONGLE_USB_FW)) ?? version(m.get(CMD.DONGLE_RF_FW));
    if (fw) out.push(text('fw', 'Mouse firmware', 'Info', fw));
    if (dongleFw && pr.connection === 'Receiver') out.push(text('dongle_fw', 'Receiver firmware', 'Info', dongleFw));

    const dpi = m.get(CMD.DPI);
    if (!dpi || dpi.length < 2) {
      const link = m.get(CMD.LINK_STATE);
      if (link && link[0] === 0) throw new Error('Waiting for the mouse. Move it to wake it up, or switch it on.');
      throw new Error('The mouse did not answer. Move it to wake it up, or switch it on.');
    }

    const bat = m.get(CMD.BATTERY);
    const vbat = m.get(CMD.VBAT);
    let pct: number | undefined;
    if (bat && bat.length >= 1 && bat[0] <= 100) pct = bat[0];
    else if (vbat && vbat.length >= 2 && u16(vbat) !== 0 && u16(vbat) !== 0xffff) pct = batteryPct(u16(vbat));
    if (pct !== undefined) {
      const chg = m.get(CMD.CHARGING);
      out.push(text('battery', 'Battery', 'Info', `${pct}%${chg && chg[0] ? ' (charging)' : ''}`));
    }

    const cur = u16(dpi);
    out.push(s('dpi', 'DPI', 'DPI', { kind: 'dpi', stages: [cur], active: 0, min: DPI_MIN, max: Math.max(DPI_MAX, cur), step: DPI_STEP }));

    const poll = m.get(CMD.POLLING);
    if (poll && poll.length >= 2) {
      const hz = u16(poll);
      // Xpanel only offers 8000 Hz on the "8K" firmware (mouse firmware 8.x)
      const rates = POLLING_HZ.filter((r) => r !== 8000 || fw?.startsWith('8.') || hz === 8000);
      const opts: [string, number][] = rates.map((r) => [`${r} Hz`, r]);
      if (!rates.includes(hz)) opts.push([`${hz} Hz`, hz]);
      out.push({ key: 'polling', label: 'Polling rate', group: 'Performance', value: { kind: 'choice', options: opts, current: hz } });
    }

    const lod = this.lodTenths(m);
    if (lod !== undefined) {
      const tenths = [10, 20];
      // SLX: custom 1.1-1.7 mm on mouse firmware 1.1.0 or newer (Xpanel's LOD page)
      if (isSlx(this.k) && atLeast(fw, '1.1.0')) tenths.push(11, 12, 13, 14, 15, 16, 17);
      if (!tenths.includes(lod)) tenths.push(lod);
      tenths.sort((a, b) => a - b);
      out.push({ key: 'lod', label: 'Lift-off distance', group: 'Performance', value: { kind: 'choice', options: tenths.map((t) => [`${(t / 10).toFixed(1)} mm`, t]), current: lod } });
    }

    const ms = m.get(CMD.MOTION_SYNC);
    if (ms && ms.length >= 1) out.push({ key: 'motion_sync', label: 'Motion sync', group: 'Performance', value: { kind: 'toggle', on: ms[0] !== 0 } });

    // Bhop mode: wheel filter (Xpanel: ULX needs mouse firmware 8.0.3+)
    const bm = m.get(CMD.BHOP_MODE);
    const bt = m.get(CMD.BHOP_TIMEOUT);
    if (bm && bm.length >= 1 && bm[0] <= 3 && (isSlx(this.k) || atLeast(fw, '8.0.3'))) {
      out.push(
        {
          key: 'bhop',
          label: 'Bhop mode (ignore the first scroll step)',
          group: 'Buttons',
          value: { kind: 'choice', options: [['Off', 0], ['Scroll up', 1], ['Scroll down', 2], ['Both directions', 3]], current: bm[0] },
          hint: 'Filters the first wheel step so a stray scroll does nothing; more steps within the window pass through.',
        },
      );
      if (bt && bt.length >= 1) {
        const ms100 = bt[0] * 100;
        const opts: [string, number][] = BHOP_WINDOWS.map((w) => [`${w} ms`, w]);
        if (!BHOP_WINDOWS.includes(ms100)) opts.push([`${ms100} ms`, ms100]);
        out.push({ key: 'bhop_window', label: 'Bhop pass-through window', group: 'Buttons', value: { kind: 'choice', options: opts, current: ms100 } });
      }
    }
    return out;
  }

  /** send a set command, then "send all" again and check the device kept the value */
  private async setAndCheck(cmd: number, payload: number[], readCmd: number, ok: (p: Uint8Array) => boolean): Promise<void> {
    await this.send(cmd, payload);
    const m = await this.collect([readCmd]);
    const p = m.get(readCmd);
    if (!p || !ok(p)) throw new Error('The mouse did not keep the new value');
  }

  async write(st: Setting): Promise<void> {
    if (this.k === 'ulx_wired') throw new Error(`${st.key} can't be changed`);
    const v = st.value;
    switch (st.key) {
      case 'dpi': {
        if (v.kind !== 'dpi') break;
        const dpi = Math.round(v.stages[v.active ?? 0] / DPI_STEP) * DPI_STEP;
        if (dpi < DPI_MIN || dpi > DPI_MAX) throw new Error('DPI out of range');
        return this.setAndCheck(CMD.DPI, [dpi & 0xff, dpi >> 8], CMD.DPI, (p) => p.length >= 2 && u16(p) === dpi);
      }
      case 'polling': {
        if (v.kind !== 'choice') break;
        if (!POLLING_HZ.includes(v.current)) throw new Error('unsupported polling rate');
        return this.setAndCheck(CMD.POLLING, [v.current & 0xff, v.current >> 8], CMD.POLLING, (p) => p.length >= 2 && u16(p) === v.current);
      }
      case 'motion_sync': {
        if (v.kind !== 'toggle') break;
        return this.setAndCheck(CMD.MOTION_SYNC, [v.on ? 1 : 0], CMD.MOTION_SYNC, (p) => p.length >= 1 && (p[0] !== 0) === v.on);
      }
      case 'lod': {
        if (v.kind !== 'choice') break;
        const t = v.current;
        const check = (p: Uint8Array) => p.length >= 1 && this.lodTenths(new Map([[this.lodCmd(), p]])) === t;
        if (t === 10 || t === 20) {
          // presets as Xpanel sends them: receivers take millimetres on cmd 0x15, the wired SLX a PAW LOD code
          if (this.k === 'slx_mouse') return this.setAndCheck(CMD.PAW_LOD, [t === 10 ? 2 : 3], CMD.PAW_LOD, check);
          return this.setAndCheck(CMD.LOD, [t / 10], this.lodCmd(), check);
        }
        if (isSlx(this.k) && t >= 11 && t <= 17) return this.setAndCheck(CMD.PAW_LOD, [t], CMD.PAW_LOD, check);
        throw new Error('unsupported lift-off distance');
      }
      case 'bhop': {
        if (v.kind !== 'choice') break;
        return this.setAndCheck(CMD.BHOP_MODE, [v.current], CMD.BHOP_MODE, (p) => p.length >= 1 && p[0] === v.current);
      }
      case 'bhop_window': {
        if (v.kind !== 'choice') break;
        const n = Math.round(v.current / 100);
        return this.setAndCheck(CMD.BHOP_TIMEOUT, [n], CMD.BHOP_TIMEOUT, (p) => p.length >= 1 && p[0] === n);
      }
    }
    throw new Error(`${st.key} can't be changed`);
  }

  /** Read-only report: the HID descriptor summary and the raw answers to "send all" / version reads. */
  async diagnose(onProgress?: (done: number, total: number) => void): Promise<string> {
    const d = this.device;
    const lines = [
      `Finalmouse ${hex4(d.vendorId)}:${hex4(d.productId)} "${d.productName}" type ${this.k}`,
      ...(d.collections ?? []).map(
        (c) =>
          `collection page ${hex4(c.usagePage ?? 0)} usage ${hex4(c.usage ?? 0)} in [${(c.inputReports ?? []).map((r) => r.reportId).join(',')}] out [${(c.outputReports ?? []).map((r) => r.reportId).join(',')}] feature [${(c.featureReports ?? []).map((r) => r.reportId).join(',')}]`,
      ),
    ];
    if (this.k === 'ulx_wired') {
      lines.push('Wired UltralightX: nothing sent (Xpanel only talks to it for firmware updates).');
      onProgress?.(1, 1);
      return lines.join('\n');
    }
    const raw: string[] = [];
    const l: Listener = (rid, data) => {
      if (raw.length < 200) raw.push(`in ${rid}: ${Array.from(data.slice(0, 3 + Math.min(data[2] ?? 0, 60)), hex2).join(' ')}`);
    };
    this.listeners.add(l);
    try {
      onProgress?.(0, 2);
      await this.collect([CMD.DPI, CMD.POLLING, CMD.MOTION_SYNC, this.lodCmd()]).catch((e) => raw.push(`error: ${e instanceof Error ? e.message : e}`));
      onProgress?.(1, 2);
    } finally {
      this.listeners.delete(l);
    }
    lines.push(...raw);
    onProgress?.(2, 2);
    return lines.join('\n');
  }

  async close(): Promise<void> {
    this.device.removeEventListener('inputreport', this.onReport);
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

/** The vendor interface Xpanel uses: usage page 0xFF00 (SLX, wired ULX); the ULX receiver's interface with output report 4. */
function rightInterface(d: HIDDevice): boolean {
  const p = PRODUCTS[d.productId];
  if (!p) return false;
  const cols = d.collections ?? [];
  if (p.kind === 'ulx_dongle') return cols.some((c) => (c.outputReports ?? []).some((r) => r.reportId === 4) || (c.usagePage ?? 0) >= 0xff00);
  return cols.some((c) => c.usagePage === 0xff00);
}

export const finalmouseFactory: DriverFactory = {
  name: 'Finalmouse',
  filters: Object.keys(PRODUCTS).map((pid) => ({ vendorId: FM_VID, productId: Number(pid) })),
  match(d: HIDDevice): boolean {
    return d.vendorId === FM_VID && rightInterface(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!finalmouseFactory.match(device)) return null;
    if (!device.opened) await device.open();
    return new FinalmouseDriver(device);
  },
};
