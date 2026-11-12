// Simulated DAREU A68 (VID 260D PID 0175, TG magnetic firmware, TravelVersion 2). Used by the tests.
import { CLS, DEV, GET, LED, MAG, PAYLOAD, PFL, REPORT_SIZE, allowed } from '../dareu';

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
}

/** One key's trigger in device units (TravelVersion 2: travel 0.005 mm, sensitivity 0.005 mm). */
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
  effect = { effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] as number[][] };
  bri = 204;
  /** global travel, device units */
  global = 240; // 1.2 mm
  keys = new Map<number, FakeKey>();
  /** SOCD group per key id (absent = not SOCD) */
  socd = new Map<number, number>();
  private reply: Uint8Array | undefined;
  private busyLeft = 0;

  constructor(private o: FakeDareuOpts = {}) {
    this.productId = o.pid ?? 0x0175;
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
    // the driver must never put a disallowed frame on the wire
    check(allowed(f), 'frame ' + Array.from(f.slice(0, 12)).join(' '));
    this.sent.push(f);
    this.reply = undefined;
    const w = !this.o.ignoreWrites;
    const cls = f[2];
    const get = (f[3] & GET) !== 0;
    const cmd = f[3] & 0x7f;
    const pl = Array.from(f.slice(PAYLOAD));
    const wide = (stride: number) => stride === 3 || stride === 7;
    if (cls === CLS.DEVICE && cmd === DEV.FW_VER) return this.answer(f, this.fw);
    if (cls === CLS.PROFILE && cmd === PFL.ACTIVE) return this.answer(f, [], this.profile);
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
      if (cmd === LED.ATTRIBUTE) return this.answer(f, [pl[0], 1, 30, 15, 5, this.effects.length, ...this.effects]);
      if (cmd === LED.EFFECT && get) {
        const e = this.effect;
        return this.answer(f, [pl[0], e.effect, e.flag, e.speed, e.colors.length, ...e.colors.flat()]);
      }
      if (cmd === LED.EFFECT) {
        const n = pl[4];
        if (w) {
          this.effect = {
            effect: pl[1],
            flag: pl[2],
            speed: pl[3],
            colors: Array.from({ length: n }, (_, i) => pl.slice(5 + 3 * i, 8 + 3 * i)),
          };
        }
        return this.answer(f, []);
      }
      if (cmd === LED.BRIGHTNESS && get) return this.answer(f, [pl[0], this.bri]);
      if (cmd === LED.BRIGHTNESS) {
        if (w) this.bri = pl[1];
        return this.answer(f, []);
      }
    }
    if (cls === CLS.MAGNETIC) {
      if (this.o.noMagnetic) return;
      if (cmd === MAG.GLOBAL_TRAVEL) {
        check(get && f[1] === 2, 'global travel request');
        return this.answer(f, [this.global >> 8, this.global & 0xff]);
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
        check(wide(stride), 'TravelVersion 2 single-trigger layout');
        if (get) {
          const out = [n];
          for (const id of ids) out.push(id, this.key(id).travel >> 8, this.key(id).travel & 0xff);
          return this.answer(f, out);
        }
        if (w) {
          ids.forEach((id, i) => {
            const b = 1 + stride * i;
            this.keys.set(id, { func: 1, travel: (pl[b + 1] << 8) | pl[b + 2], press: 0, release: 0 });
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
        check(wide(stride), 'TravelVersion 2 rapid-trigger layout');
        if (get) {
          const out = [n];
          for (const id of ids) {
            const k = this.key(id);
            out.push(id, k.travel >> 8, k.travel & 0xff, k.press >> 8, k.press & 0xff, k.release >> 8, k.release & 0xff);
          }
          return this.answer(f, out);
        }
        if (w) {
          ids.forEach((id, i) => {
            const b = 1 + stride * i;
            const u16 = (at: number) => (pl[b + at] << 8) | pl[b + at + 1];
            this.keys.set(id, { func: 2, travel: u16(1), press: u16(3), release: u16(5) });
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
