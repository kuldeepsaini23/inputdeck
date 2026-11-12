// Simulated Wraith W75 V2 HE. Used by the tests and the demo mode.
import { COLOR_TABLE, TRIG_FIXED, W75_KEYS, allowed, setColorsPkts, type KeyTrig } from '../wraith';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));

/** Fakes refuse anything the real device wouldn't accept, so bugs surface in tests and demo alike. */
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake device: unexpected ' + what);
};

export interface FakeOpts {
  product?: string;
  ignoreWrites?: boolean;
  /** keys that never answer the 18 05 read */
  silentKeys?: number[];
  /** don't answer colour table reads */
  noColorRead?: boolean;
  /** report SOCD support (status F[9] = 1) */
  socd?: boolean;
  /** firmware quirk: how a received trigger is stored (default: as sent) */
  storeTrig?: (k: KeyTrig) => KeyTrig;
}

export class FakeKeyboard {
  vendorId = 0x2e3c;
  productId = 0xc365;
  productName = 'W75 HE';
  opened = false;
  collections = [{ usagePage: 0xff1b, usage: 0x91 }] as unknown as HIDCollectionInfo[];
  sent: number[][] = [];
  poll = 8;
  light = hex('0a 04 03 ff aa ff 00 00 00 00 01 01'); // mode bri speed fg bg dir full power
  keys = new Map<number, KeyTrig>();
  slot = 1;
  table = new Uint8Array(COLOR_TABLE);
  flags = 0x02;
  /** SOCD switch and the raw pair table (20 x [valid, mode, hid1, hid2]) */
  socdOn = 0;
  socdTable = new Array<number>(80).fill(0);
  private listeners = new Set<(e: HIDInputReportEvent) => void>();

  constructor(private o: FakeOpts = {}) {
    for (const k of W75_KEYS) this.keys.set(k, { mode: TRIG_FIXED, travel: 85, press: 5, release: 5 });
    for (let i = 0; i < COLOR_TABLE; i++) this.table[i] = i & 0xff;
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  travelTimer: ReturnType<typeof setInterval> | undefined;
  travelT = 0;

  addEventListener(_t: string, l: (e: HIDInputReportEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: string, l: (e: HIDInputReportEvent) => void) {
    this.listeners.delete(l);
  }
  listenerCount() {
    return this.listeners.size;
  }

  private reply(bytes: number[]) {
    const buf = new Uint8Array(63);
    buf.set(bytes.slice(0, 63));
    queueMicrotask(() => {
      const e = { reportId: 1, data: new DataView(buf.buffer) } as unknown as HIDInputReportEvent;
      for (const l of [...this.listeners]) l(e);
    });
  }

  async sendReport(id: number, data: BufferSource) {
    check(id === 1, 'id');
    const p = Array.from(data as Uint8Array);
    check(p.length === 63, 'p.length');
    // the driver must never put a disallowed packet on the wire
    check(allowed(p) === true, 'allowed(p)');
    this.sent.push(p);
    const w = !this.o.ignoreWrites;
    const [c, s1] = p;
    // live travel test: press W down and up again and again until 18 03
    if (c === 0x21 && p[4] === 0x18 && p[5] === 0x02) {
      this.travelTimer ??= setInterval(() => {
        this.travelT += 0.25;
        const raw = Math.round(170 * Math.max(0, Math.sin(this.travelT)));
        this.reply([0x21, 0, 0, 0, 0, 0x01, 2, 2, raw & 0xff, raw >> 8]); // W = index 46 = row 2, col 2
      }, 40);
      return;
    }
    if (c === 0x21 && p[4] === 0x18 && p[5] === 0x03) {
      clearInterval(this.travelTimer);
      this.travelTimer = undefined;
      return;
    }
    if (c === 0x0d) {
      const txt = Array.from(new TextEncoder().encode(`W669,34,KB,ML,${this.o.product ?? 'W75HEARGB'},V3.13.03`));
      this.reply([0x0d, 0, 0, 0, txt.length, ...txt]);
    } else if (c === 0x01) {
      const f = new Array(20).fill(0);
      f[12] = this.flags;
      if (this.o.socd) f[9] = 1;
      this.reply([0x01, 0, 0, 0, 20, ...f]);
    } else if (c === 0x0a) {
      this.reply(hex('0a 00 00 00 12 02 01 03 09 04 00 0e 0f 06 07 0b 0c 10 08 a5 5a 04 04'));
    } else if (c === 0x07 && s1 === 0x01) {
      this.reply([0x07, 0, 0, 0, 0x0c, ...this.light]);
    } else if (c === 0x07) {
      if (w) this.light = p.slice(5, 17);
    } else if (c === 0x21 && p[4] === 0x01 && p[5] === 0x09) {
      this.reply([0x21, 0, 0, 0, 2, 0x09, this.poll]);
    } else if (c === 0x21 && p[4] === 0x00 && p[5] === 0x09) {
      if (w) this.poll = p[7];
    } else if (c === 0x21 && p[4] === 0x18 && p[5] === 0x04) {
      // max 170, unit 2 (0.02 mm), min 5
      this.reply([0x21, 0, 0, 0, 6, 0x04, 0xaa, 0x02, 0, 0x00, 5]);
    } else if (c === 0x21 && p[4] === 0x18 && p[5] === 0x05) {
      const key = p[6] * 22 + p[7];
      if (this.o.silentKeys?.includes(key)) return;
      const k = this.keys.get(key) ?? { mode: 0, travel: 0, press: 0, release: 0 };
      this.reply([
        0x21, 0, 0, 0, 0x0a, 0x05, k.mode, k.travel & 0xff, k.travel & 0xff, k.press & 0xff, k.release & 0xff,
        k.travel >> 8, k.travel >> 8, k.press >> 8, k.release >> 8,
      ]);
    } else if (c === 0x21 && p[4] === 0x18) {
      if (!w) return;
      const k: KeyTrig = { mode: p[5], travel: (p[32] << 8) | p[28], press: (p[34] << 8) | p[30], release: (p[35] << 8) | p[31] };
      for (let col = 0; col < 22; col++)
        for (let row = 0; row < 8; row++) if (p[6 + col] & (1 << row)) this.keys.set(row * 22 + col, this.o.storeTrig ? this.o.storeTrig({ ...k }) : { ...k });
    } else if (c === 0x24 && s1 === 0x02) {
      this.reply([0x24, 0x02, 0, 0, 6, this.socdOn, 0, 0, 0, 0xfa, 0xe5]);
    } else if (c === 0x24 && s1 === 0x03) {
      if (w) this.socdOn = p[5];
    } else if (c === 0x24 && s1 === 0x01) {
      for (let pg = 0; pg < 2; pg++) this.reply([0x24, 0x01, 0, pg, 0x28, ...this.socdTable.slice(pg * 40, pg * 40 + 40)]);
    } else if (c === 0x24 && s1 === 0x00) {
      if (w) this.socdTable.splice(p[3] * 40, 40, ...p.slice(5, 45));
    } else if (c === 0x09 && s1 === 0x20) {
      this.reply([0x09, this.slot]);
    } else if (c === 0x09 && (s1 === 0x80 || s1 === 0x81)) {
      if (this.o.noColorRead) return;
      for (const pk of setColorsPkts(s1 & 1, this.table)) this.reply([0x09, s1, ...pk.slice(2)]);
    } else if (c === 0x09) {
      if (!w) return;
      const pg = p[3];
      this.table.set(p.slice(5, 5 + p[4]), pg * 54);
    }
  }

  asDevice() {
    return this as unknown as HIDDevice;
  }
  wrote(prefix: number[]) {
    return this.sent.filter((p) => prefix.every((b, i) => p[i] === b));
  }
}

