// Simulated DAREU keyboard on TG firmware. Default: A68 (VID 260D PID 0175, magnetic, TravelVersion 2);
// any other product from dareu-products.ts via `pid` (magnetic value layout follows its TravelVersion:
// 0 = one byte per value, 1/2 = big-endian u16). Used by the tests.
import {
  CLS,
  DEV,
  GET,
  KEY,
  LED,
  LED_PROBE,
  LIVE_EFFECT,
  MAG,
  MAX_REQUEST_SIZE,
  MCO,
  PAYLOAD,
  PFL,
  REPORT_SIZE,
  allowed,
  allowedStream,
  capsFor,
  productFor,
} from '../dareu';
import { usageOfKeyId } from '../dareu-keys';

/** Fakes refuse anything the real device wouldn't accept, so bugs surface in tests. */
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake device: unexpected ' + what);
};

export interface FakeDareuOpts {
  pid?: number;
  /** feature report id the board uses (0 for FwType 0/6, 0x0A for FwType 1) */
  reportId?: number;
  /** answer like Windows: 65 bytes with the report id in front */
  windows?: boolean;
  /** report "busy" this many times before each reply */
  busy?: number;
  ignoreWrites?: boolean;
  /** no lighting class */
  noLighting?: boolean;
  /** no magnetic class */
  noMagnetic?: boolean;
  /** firmware without FUNC_AND_SOCD (class 13 cmd 17): never answers it */
  noFuncSocd?: boolean;
  /** firmware without the RT self-adaptive command (class 13 cmd 14) */
  noRtAdaptive?: boolean;
  /** trigger writes (single / RT) only show up after this many later magnetic GETs */
  lag?: number;
  /**
   * how the never-used lighting GETs (03/84..88) answer: 'firmware' (default) = like the A68 0.4.6
   * image (CAL_DATA done with no data, the rest status 5 unsupported); 'silent' = never answer;
   * 'data' = FRAME answers with bytes (to exercise the report)
   */
  ledProbe?: 'firmware' | 'silent' | 'data';
  /** the attribute reply lists the streaming effect 18 (like the real A68 0.4.6) */
  stream?: boolean;
}

/** effect state as the firmware keeps it */
export interface FakeEffect {
  effect: number;
  flag: number;
  speed: number;
  colors: number[][];
}

/** One key's trigger in device units (A68 / TravelVersion 2: travel 0.005 mm, sensitivity 0.005 mm). */
export interface FakeKey {
  func: number;
  travel: number;
  press: number;
  release: number;
}

export class FakeDareu {
  vendorId = 0x260d;
  productId: number;
  productName = 'DAREU A68';
  opened = false;
  collections: HIDCollectionInfo[];
  sent: Uint8Array[] = [];
  fw = [0, 4, 6];
  profile = 1;
  usbType = 1;
  rate = 8;
  regions = [0, 1];
  effects = [0, 1, 2, 4, 11, 13, 14, 19, 20, 21, 22, 24, 25, 27, 28];
  /** the stored effect of the active profile (also the live one unless `live` is set) */
  effect: FakeEffect = { effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] };
  /** effect applied live only (SET with profile byte 0, firmware 0x08015868): not stored */
  live: FakeEffect | undefined;
  bri = 204;
  /** LED grid of the attribute reply (A68 firmware 0x0801f5c8: 5 x 15) */
  rows = 5;
  cols = 15;
  /** volatile LED matrix (RAM 0x20006b18): 3 bytes per cell at row * cols * 3 + col * 3, as sent */
  matrix: number[] = new Array<number>(5 * 15 * 3).fill(0);
  /** power-up animation still running (0x20007360): FRAME answers "done" but drops the data */
  startup = false;
  /** test hook: FRAME answers status 3 (rejected) */
  rejectFrames = false;
  /** effects whose init redrew the matrix (anything but 18), in order */
  redraws: number[] = [];
  /** global travel, device units */
  global = 240; // 1.2 mm
  /** TravelVersion of the product (0 = 1-byte values) */
  tv: number;
  rtAdaptive = 0;
  keys = new Map<number, FakeKey>();
  /** SOCD group per key id (absent = not SOCD) */
  socd = new Map<number, number>();
  /** profile ids (1-based) */
  profileIds = [1, 2, 3];
  /** key assignment per `${profile}:${layer}:${key}`: [fid, d0..d4] (default: the key's own HID usage) */
  assigns = new Map<string, number[]>();
  /** MT / TGL / DKS parameters per key id, as the GET reply bytes after [1, key] */
  adv = new Map<number, number[]>();
  /** macro bytes per id */
  macros = new Map<number, number[]>();
  macroNames = new Map<number, string>();
  private reply: Uint8Array | undefined;
  private busyLeft = 0;
  private pending: { left: number; apply: () => void }[] = [];

  /** apply a trigger write now, or after `lag` magnetic GETs */
  private later(apply: () => void) {
    if (this.o.lag) this.pending.push({ left: this.o.lag, apply });
    else apply();
  }

  constructor(private o: FakeDareuOpts = {}) {
    this.productId = o.pid ?? 0x0175;
    const p = productFor(this.productId);
    this.tv = p?.tv ?? 1;
    // product default global travel, in device units
    if (p?.gt) this.global = Math.round(p.gt[4] / (p.gt[5] * (this.tv >= 2 ? 0.5 : 1)));
    if (o.stream) this.effects = [...this.effects, LIVE_EFFECT];
    const id = o.reportId ?? 0;
    this.collections = [
      { usagePage: 0x0c, usage: 0x01, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [{ reportId: id, items: [] }] },
    ] as unknown as HIDCollectionInfo[];
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener() {}
  removeEventListener() {}

  /** default assignment: the key's own HID usage; Fn (107) is VendorKey 0x40 on both layers */
  assign(key: number, layer: number, profile = this.profile): number[] {
    const a = this.assigns.get(`${profile}:${layer}:${key}`);
    if (a) return a;
    if (key === 107) return [10, 0x40, 0, 0, 0, 0];
    const u = usageOfKeyId(key);
    return u > 0 ? (u >= 0xe0 && u <= 0xe7 ? [6, 1 << (u - 0xe0), 0, 0, 0, 0] : [6, 0, u, 0, 0, 0]) : [0, 0, 0, 0, 0, 0];
  }

  /** multi-packet GET reply (vendor GetMultiPacketCmd): first = total, then chunks */
  private multi(f: Uint8Array, pre: number, w: number, data: number[]) {
    const pl = Array.from(f.slice(PAYLOAD));
    const num = (v: number) => (w === 1 ? [v & 0xff] : [(v >> 8) & 0xff, v & 0xff]);
    const head = pl.slice(0, pre);
    if (f[1] === 1) return this.answer(f, [...head, ...num(data.length)]);
    const at = (i: number) => (w === 1 ? pl[i] : (pl[i] << 8) | pl[i + 1]);
    const total = at(pre);
    const off = at(pre + w);
    check(total === data.length, 'multi-packet total');
    const n = Math.min(48, total - off);
    check(f[1] === n + pre + 2 * w, 'multi-packet size byte');
    return this.answer(f, [...head, ...num(total), ...num(off), ...data.slice(off, off + n)]);
  }

  /** multi-packet SET (vendor SetMultiPacketCmd): returns the full data once the last chunk is in */
  private partial = new Map<string, number[]>();
  private multiSet(tag: string, pl: number[], pre: number, w: number, size: number): number[] | undefined {
    const at = (i: number) => (w === 1 ? pl[i] : (pl[i] << 8) | pl[i + 1]);
    const total = at(pre);
    const off = at(pre + w);
    const n = Math.min(48, total - off);
    check(size === n + pre + 2 * w, 'multi-packet set size byte');
    const buf = off === 0 ? new Array<number>(total).fill(0) : this.partial.get(tag);
    check(!!buf && buf.length === total, 'multi-packet set order');
    for (let i = 0; i < n; i++) buf![off + i] = pl[pre + 2 * w + i];
    if (off + n < total) {
      this.partial.set(tag, buf!);
      return undefined;
    }
    this.partial.delete(tag);
    return buf;
  }

  liveEffect(): FakeEffect {
    return this.live ?? this.effect;
  }

  /** Effect init (0x0801e464): 18 leaves the matrix alone, 0 clears it, others draw over it. */
  private applied(e: FakeEffect) {
    if (e.effect === LIVE_EFFECT) return;
    this.redraws.push(e.effect);
    const c = e.effect === 0 ? [0, 0, 0] : (e.colors[0] ?? [0x10, 0x20, 0x30]);
    for (let i = 0; i < this.matrix.length; i++) this.matrix[i] = c[i % 3];
  }

  /** FRAME row mode (0x0801eb5c): [region, flags, row, first, last, 3 bytes per cell]; false = rejected */
  private frameWrite(pl: number[]): boolean {
    const [region, flags, row, first, last] = pl;
    if (region !== this.regions[0]) return false;
    check((flags & 0x7f) === 1, 'FRAME mode (only row mode is sent)');
    if (row >= this.rows || first > last || last >= this.cols) return false;
    for (let c = first; c <= last; c++) {
      for (let k = 0; k < 3; k++) this.matrix[row * this.cols * 3 + c * 3 + k] = pl[5 + 3 * (c - first) + k];
    }
    // bit 7: switch to 18 live when another effect runs (0x0801ed78)
    if (flags & 0x80 && this.liveEffect().effect !== LIVE_EFFECT) this.live = { effect: LIVE_EFFECT, flag: 0, speed: 0, colors: [] };
    return true;
  }

  /** the matrix as 0xAABBCC per cell (bytes in the order sent) */
  cells(): number[] {
    return Array.from({ length: this.rows * this.cols }, (_, i) => (this.matrix[3 * i] << 16) | (this.matrix[3 * i + 1] << 8) | this.matrix[3 * i + 2]);
  }

  key(id: number): FakeKey {
    return this.keys.get(id) ?? { func: 0, travel: 0, press: 0, release: 0 };
  }

  private answer(f: Uint8Array, payload: number[], profile?: number) {
    const r = new Uint8Array(REPORT_SIZE);
    r.set(f.slice(0, PAYLOAD));
    r[0] = 0x02; // done
    if (profile !== undefined) r[4] = profile;
    r.set(payload.slice(0, REPORT_SIZE - PAYLOAD), PAYLOAD);
    this.reply = r;
    this.busyLeft = this.o.busy ?? 0;
  }

  async sendFeatureReport(id: number, data: BufferSource) {
    check(id === (this.o.reportId ?? 0), 'report id');
    const f = new Uint8Array(data as Uint8Array);
    check(f.length === REPORT_SIZE, 'length');
    // the driver must never put a disallowed frame on the wire (allowedStream: live-lighting path only)
    check(allowed(f) || allowedStream(f), 'frame ' + Array.from(f.slice(0, 12)).join(' '));
    this.sent.push(f);
    this.reply = undefined;
    const w = !this.o.ignoreWrites;
    const cls = f[2];
    const get = (f[3] & GET) !== 0;
    const cmd = f[3] & 0x7f;
    const pl = Array.from(f.slice(PAYLOAD));
    const wide = this.tv >= 1;
    const u16 = (v: number) => (wide ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff]);
    const val = (at: number) => (wide ? (pl[at] << 8) | pl[at + 1] : pl[at]);
    const vw = wide ? 2 : 1;
    if (cls === CLS.DEVICE && cmd === DEV.FW_VER) return this.answer(f, this.fw);
    if (cls === CLS.PROFILE && cmd === PFL.ACTIVE) {
      if (get) return this.answer(f, [], this.profile);
      check(this.profileIds.includes(f[4]), 'profile id');
      if (w) this.profile = f[4];
      return this.answer(f, [], this.profile);
    }
    if (cls === CLS.PROFILE && cmd === PFL.ID_LIST) return this.multi(f, 0, 1, this.profileIds);
    if (cls === CLS.KEY && cmd === KEY.ASSIGN) {
      const [key, layer] = pl;
      check(f[4] === this.profile, 'key assign profile');
      check(capsFor(productFor(this.productId)!).some((c) => c.index === key), 'key id');
      if (get) return this.answer(f, [key, layer, ...this.assign(key, layer)]);
      if (w) this.assigns.set(`${this.profile}:${layer}:${key}`, pl.slice(2, 8));
      return this.answer(f, []);
    }
    if (cls === CLS.MACRO) {
      const ids = [...this.macros.keys()].sort((a, b) => a - b);
      if (cmd === MCO.ID_LIST && get) return this.multi(f, 0, 1, ids);
      if (cmd === MCO.MEMORY && get) {
        check(this.macros.has(pl[0]), 'macro id');
        return this.multi(f, 1, 2, this.macros.get(pl[0])!);
      }
      if (cmd === MCO.CREATE) {
        if (w) this.macros.set(pl[0], new Array<number>((pl[1] << 8) | pl[2]).fill(0));
        return this.answer(f, []);
      }
      if (cmd === MCO.DELETE) {
        check(f[1] === 0, 'macro delete size byte');
        if (w) this.macros.delete(pl[0]);
        return this.answer(f, []);
      }
      if (cmd === MCO.NAME) {
        const b = this.multiSet(`n${pl[0]}`, pl, 1, 1, f[1]);
        if (b && w) this.macroNames.set(pl[0], new TextDecoder().decode(new Uint8Array(b)));
        return this.answer(f, []);
      }
      if (cmd === MCO.MEMORY) {
        check(!w || this.macros.has(pl[0]), 'macro written before create');
        const b = this.multiSet(`m${pl[0]}`, pl, 1, 2, f[1]);
        if (b && w) {
          check(b.length === this.macros.get(pl[0])!.length, 'macro length = created length');
          if (w) this.macros.set(pl[0], b);
        }
        return this.answer(f, []);
      }
    }
    if (cls === CLS.DEVICE && cmd === DEV.POLLING) {
      check(f[4] === this.profile, 'polling profile');
      if (get) return this.answer(f, [this.usbType, this.rate]);
      if (w) this.rate = pl[1]; // fire-and-forget: no reply expected
      return;
    }
    if (cls === CLS.LIGHTING) {
      if (this.o.noLighting) return;
      if (cmd === LED.ID_LIST) {
        if (f[1] === 1) return this.answer(f, [this.regions.length]);
        const [total, off] = pl;
        return this.answer(f, [total, off, ...this.regions.slice(off, off + 48)]);
      }
      // [region, type 4, fps 33, rows, cols, n, effects] (A68 0.4.6, 0x080154dc)
      if (cmd === LED.ATTRIBUTE) return this.answer(f, [pl[0], 4, 33, this.rows, this.cols, this.effects.length, ...this.effects]);
      if (cmd === LED.EFFECT && get) {
        // profile 0 = the live state (0x0801eacc), otherwise the stored one
        const e = f[4] === 0 ? this.liveEffect() : this.effect;
        return this.answer(f, [pl[0], e.effect, e.flag, e.speed, e.colors.length, ...e.colors.flat()]);
      }
      if (cmd === LED.EFFECT) {
        const n = pl[4];
        check(f[4] <= 3, 'effect profile'); // firmware rejects profile bytes over 3
        if (w) {
          const next = {
            effect: pl[1],
            flag: pl[2],
            speed: pl[3],
            colors: Array.from({ length: n }, (_, i) => pl.slice(5 + 3 * i, 8 + 3 * i)),
          };
          if (f[4] === 0) this.live = next; // live only (0x08015868: no store)
          else {
            this.effect = next;
            this.live = undefined;
          }
          this.applied(next);
        }
        return this.answer(f, []);
      }
      if (cmd === LED_PROBE.FRAME && !get) {
        // dispatcher 0x08014aec, then 0x0801eae0 (row mode only: the driver sends nothing else)
        const ok = f[1] <= MAX_REQUEST_SIZE && (this.startup || this.frameWrite(pl));
        this.answer(f, pl);
        if (!ok || this.rejectFrames) this.reply![0] = 0x03;
        return;
      }
      if (get && (Object.values(LED_PROBE) as number[]).includes(cmd)) {
        const mode = this.o.ledProbe ?? 'firmware';
        if (mode === 'silent') return;
        if (mode === 'data' && cmd === LED_PROBE.FRAME) return this.answer(f, [pl[0], 0, 0, 0, 0xff, 0x00, 0x40]);
        if (cmd === LED_PROBE.CAL_DATA) return this.answer(f, [pl[0]]);
        this.answer(f, [pl[0]]);
        this.reply![0] = 0x05; // unsupported
        return;
      }
      if (cmd === LED.BRIGHTNESS && get) return this.answer(f, [pl[0], this.bri]);
      if (cmd === LED.BRIGHTNESS) {
        if (w) this.bri = pl[1];
        return this.answer(f, []);
      }
    }
    if (cls === CLS.MAGNETIC) {
      if (this.o.noMagnetic) return;
      if (get && this.pending.length) {
        for (const p of this.pending) if (--p.left <= 0) p.apply();
        this.pending = this.pending.filter((p) => p.left > 0);
      }
      if (cmd === MAG.GLOBAL_TRAVEL) {
        check(get && f[1] === (wide ? 2 : 1), 'global travel request');
        return this.answer(f, u16(this.global));
      }
      if (cmd === MAG.RT_ADAPTIVE) {
        if (this.o.noRtAdaptive) return;
        if (get) return this.answer(f, [this.rtAdaptive]);
        if (w) this.rtAdaptive = pl[0];
        return this.answer(f, []);
      }
      if (cmd === MAG.FUNC_AND_SOCD) {
        if (this.o.noFuncSocd) return;
        check(get, 'FUNC_AND_SOCD set');
        const n = pl[0];
        check(f[1] === n + 1 && n <= 14, 'FUNC_AND_SOCD size byte');
        check(f[4] === this.profile, 'FUNC_AND_SOCD profile');
        const out = [n];
        for (let i = 0; i < n; i++) {
          const id = pl[1 + 4 * i];
          const g = this.socd.get(id);
          out.push(id, this.key(id).func, g === undefined ? 0 : 1, g ?? 0xff);
        }
        return this.answer(f, out);
      }
      if (cmd === MAG.MT || cmd === MAG.TGL || cmd === MAG.DKS) {
        const len = cmd === MAG.DKS ? 8 : cmd === MAG.MT ? 4 : 3;
        check(pl[0] === 1 && f[1] === (cmd === MAG.DKS ? 10 : 5), 'MT/TGL/DKS layout');
        const func = cmd === MAG.MT ? 3 : cmd === MAG.TGL ? 4 : 5;
        if (get) return this.answer(f, [1, pl[1], ...(this.key(pl[1]).func === func ? (this.adv.get(pl[1]) ?? []) : new Array(len).fill(0))]);
        if (w) {
          this.adv.set(pl[1], pl.slice(2, 2 + len));
          this.keys.set(pl[1], { func, travel: 0, press: 0, release: 0 });
        }
        return this.answer(f, []);
      }
      if (cmd === MAG.NORMAL_TRIGGER) {
        check(!get && f[1] === pl[0] + 1, 'normal trigger layout');
        for (let i = 0; i < pl[0]; i++) {
          if (!w) continue;
          this.keys.set(pl[1 + i], { func: 0, travel: 0, press: 0, release: 0 });
          this.adv.delete(pl[1 + i]);
        }
        return this.answer(f, []);
      }
      const n = pl[0];
      const stride = (f[1] - 1) / n;
      const ids = Array.from({ length: n }, (_, i) => pl[1 + stride * i]);
      if (cmd === MAG.KEY_FUNCTION) {
        const out = [n];
        for (const id of ids) out.push(id, this.key(id).func);
        return this.answer(f, out);
      }
      if (cmd === MAG.SINGLE_TRIGGER) {
        check(stride === 1 + vw && n <= 18, `TravelVersion ${this.tv} single-trigger layout`);
        if (get) {
          const out = [n];
          for (const id of ids) out.push(id, ...u16(this.key(id).travel));
          return this.answer(f, out);
        }
        if (w) {
          ids.forEach((id, i) => {
            const b = 1 + stride * i;
            const k = { func: 1, travel: val(b + 1), press: 0, release: 0 };
            this.later(() => this.keys.set(id, k));
          });
        }
        return this.answer(f, []);
      }
      if (cmd === MAG.SOCD) {
        if (get) {
          check(f[1] === 3 && n === 1, 'SOCD get layout');
          return this.answer(f, [1, pl[1], this.socd.get(pl[1]) ?? 0xff]);
        }
        if (f[1] === 3 && n === 1) {
          check(pl[2] < 4, 'SOCD group');
          if (w) {
            this.socd.set(pl[1], pl[2]);
            // firmware before 0.3.0: SOCD replaces the key's trigger function
            if ((this.fw[0] << 16 | this.fw[1] << 8 | this.fw[2]) < 0x300) this.keys.set(pl[1], { func: 6, travel: 0, press: 0, release: 0 });
          }
          return this.answer(f, []);
        }
        // RemoveBindingEx: size byte n + 1, then n x (key, FF)
        check(f[1] === n + 1, 'SOCD remove size byte');
        check((this.fw[0] << 16 | this.fw[1] << 8 | this.fw[2]) >= 0x300, 'SOCD remove on old firmware');
        for (let i = 0; i < n; i++) {
          check(pl[2 + 2 * i] === 0xff, 'SOCD remove marker');
          if (w) this.socd.delete(pl[1 + 2 * i]);
        }
        return this.answer(f, []);
      }
      if (cmd === MAG.RAPID_TRIGGER) {
        check(stride === 1 + 3 * vw && n <= (wide ? 8 : 14), `TravelVersion ${this.tv} rapid-trigger layout`);
        if (get) {
          const out = [n];
          for (const id of ids) {
            const k = this.key(id);
            out.push(id, ...u16(k.travel), ...u16(k.press), ...u16(k.release));
          }
          return this.answer(f, out);
        }
        if (w) {
          ids.forEach((id, i) => {
            const b = 1 + stride * i;
            const k = { func: 2, travel: val(b + 1), press: val(b + 1 + vw), release: val(b + 1 + 2 * vw) };
            this.later(() => this.keys.set(id, k));
          });
        }
        return this.answer(f, []);
      }
    }
    check(false, `command ${cls}/${f[3]}`);
  }

  async receiveFeatureReport(id: number): Promise<DataView> {
    check(id === (this.o.reportId ?? 0), 'report id');
    let r: Uint8Array;
    if (!this.reply) {
      r = new Uint8Array(REPORT_SIZE); // nothing to say: status 0
    } else if (this.busyLeft > 0) {
      this.busyLeft--;
      r = this.reply.slice();
      r[0] = 0x01; // busy
    } else {
      r = this.reply.slice();
    }
    if (this.o.windows) {
      const w = new Uint8Array(REPORT_SIZE + 1);
      w[0] = id;
      w.set(r, 1);
      r = w;
    }
    return new DataView(r.buffer);
  }

  asDevice() {
    return this as unknown as HIDDevice;
  }
  /** frames sent with this class/command byte */
  wrote(cls: number, cmdByte: number) {
    return this.sent.filter((f) => f[2] === cls && f[3] === cmdByte);
  }
}
