// Simulated Wooting 60HE v2 (ARM firmware). Answers feature commands with input reports
// [D1 DA cmd status lenLo lenHi body], keeps per-slot flash copies and a RAM copy, and throws on
// anything the driver's allowlist refuses. Initial data are bytes from eng1n88r/wooting's Wootility
// captures of a 60HE+ (docs/captures/README.md). Used by the tests and ?demo.
import { allowedCommand, allowedReport, REPORT_SIZES, USAGE_PAGE } from '../wooting';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake wooting: unexpected ' + what);
};
const h = (s: string) => Uint8Array.from(s.trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16)));

/** 1.6 mm, RT off, 0.40 mm, Tachyon off ("Omarchy" profile pushed by Wootility v5.4) */
export const KB_DEFAULT = h('0a 14 08 99 b3 01 10 01 18 00 20 e6 8c 01 28 00 30 02 38 01 48 00');
/** W A S D with Rapid Trigger ("Typing" profile) */
export const RT_WASD = h('0a 0a 08 42 08 61 08 62 08 63 18 01');
/** key A at 2.5 mm */
export const PK_A = h('22 06 08 e1 80 fc bf 06');
/** brightness 255, caps / fn lock colours 0xFFFF, plus an effect layer (wave) */
export const CORE = h('0a 0b 08 ff 01 10 ff ff 03 18 ff ff 03 22 0a 0a 08 0a 06 08 00 10 10 18 00');

const meta = (name: string) => {
  const n = new TextEncoder().encode(name);
  return Uint8Array.from([0x0a, n.length, ...n, 0x12, 0x07, 0x08, 0x00, 0x10, 0x00, 0x18, 0xff, 0x01]);
};

export interface FakeWootingOptions {
  productId?: number;
  fw?: [number, number, number];
  slot?: number;
  /** accept writes but keep nothing (read-back must fail) */
  ignoreWrites?: boolean;
  profiles?: string[];
}

interface Slot {
  kb: Uint8Array;
  pk: Uint8Array;
  rt: Uint8Array;
  core: Uint8Array;
}

export class FakeWooting {
  opened = false;
  vendorId = 0x31e3;
  productId: number;
  productName = 'Wooting 60HE v2';
  collections = [
    {
      usagePage: USAGE_PAGE,
      usage: 1,
      inputReports: REPORT_SIZES.map(([reportId]) => ({ reportId })),
      outputReports: REPORT_SIZES.map(([reportId]) => ({ reportId })),
      featureReports: [{ reportId: 1 }],
    },
  ] as unknown as HIDCollectionInfo[];
  /** every feature command / output report the driver sent (data, without report id) */
  sent: number[][] = [];
  fw: [number, number, number];
  slot: number;
  names: string[];
  slots: Slot[];
  ram: Slot;
  config = h('00 00 00 00 11 00 0c');
  private listeners: ((e: HIDInputReportEvent) => void)[] = [];

  constructor(private o: FakeWootingOptions = {}) {
    this.productId = o.productId ?? 0x1340;
    this.fw = o.fw ?? [2, 14, 2];
    this.slot = o.slot ?? 0;
    this.names = o.profiles ?? ['Typing Profile', 'Rapid Profile', 'Racing Profile', 'Mixed Movement'];
    this.slots = this.names.map((_, i) => ({ kb: KB_DEFAULT.slice(), pk: i === 0 ? PK_A.slice() : new Uint8Array(0), rt: i === 0 ? RT_WASD.slice() : new Uint8Array(0), core: CORE.slice() }));
    this.ram = { ...this.slots[this.slot] };
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice;
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) {
    this.listeners.push(fn);
  }
  removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  private reply(cmd: number, body: ArrayLike<number>, status = 0x88) {
    const need = 6 + body.length;
    const [id, size] = REPORT_SIZES.find(([, s]) => s >= need)!;
    const r = new Uint8Array(size);
    r.set([0xd1, 0xda, cmd, status, body.length & 0xff, body.length >> 8]);
    r.set(body, 6);
    const view = new DataView(r.buffer);
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: id, data: view } as unknown as HIDInputReportEvent)));
  }

  async sendFeatureReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed');
    check(id === 1, 'feature id ' + id);
    const d = new Uint8Array(data as ArrayBuffer);
    check(allowedCommand(d), 'command ' + [...d].map((b) => b.toString(16)).join(' '));
    this.sent.push([...d]);
    const cmd = d[2];
    const slot = d[3];
    const s = this.slots[slot];
    switch (cmd) {
      case 1:
        return this.reply(cmd, this.fw);
      case 11:
        return this.reply(cmd, [this.slot, 0, this.slot]);
      case 19:
        return this.reply(cmd, this.config);
      case 55:
        return this.reply(cmd, slot < this.names.length ? meta(this.names[slot]) : []);
      case 62:
        return this.reply(cmd, [], 0x66);
      case 39:
        return this.reply(cmd, s.kb);
      case 49:
        return this.reply(cmd, s.pk);
      case 61:
        return this.reply(cmd, s.rt);
      case 54:
        return this.reply(cmd, []);
      case 50:
        return this.reply(cmd, s.core);
      case 51:
        return this.reply(cmd, h('0a 04 08 05 10 0a 10 00'));
      case 8:
        if (!this.o.ignoreWrites) s.core = this.ram.core.slice();
        return this.reply(cmd, []);
      case 33:
        return this.reply(cmd, []);
      case 23:
        check(slot < this.names.length, 'activate missing profile');
        this.slot = slot;
        return this.reply(cmd, []);
      case 38:
        this.ram = { ...this.slots[slot] };
        return this.reply(cmd, []);
    }
    check(false, 'command ' + cmd);
  }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed');
    const d = new Uint8Array(data as ArrayBuffer);
    check(allowedReport(id, d), 'report ' + [...d.subarray(0, 8)].map((b) => b.toString(16)).join(' '));
    this.sent.push([...d]);
    if (this.o.ignoreWrites) return;
    const type = d[2];
    const flags = d[3];
    const len = d[4] | (d[5] << 8);
    const p = d.slice(6, 6 + len);
    const target = flags === 0 ? this.ram : this.slots[flags >> 1];
    if (type === 0x11) target.kb = p;
    else if (type === 0x15) target.pk = p;
    else if (type === 0x1d) target.rt = p;
    else if (type === 0x16) target.core = p;
  }
}
