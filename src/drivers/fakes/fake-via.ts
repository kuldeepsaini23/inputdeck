// Simulated VIA (QMK raw HID) keyboard. Used by the tests and the demo mode.
import { CMD, REPORT_LEN, allowed, type ViaDefinition } from '../via';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake VIA device: unexpected ' + what);
};

/** A small 4x4 test board: row 0 = Esc Q W E, row 1 = Tab A S D, ISO Enter, split space option. */
export const FAKE_DEF: ViaDefinition = {
  name: 'Keychron Q0 Test',
  vendorProductId: 0x34340194,
  matrix: { rows: 4, cols: 4 },
  layouts: {
    labels: ['Split Space', ['Enter', 'ANSI', 'ISO']],
    keys: [
      { row: 0, col: 0, x: 0, y: 0 },
      { row: 0, col: 1, x: 1, y: 0 },
      { row: 0, col: 2, x: 2, y: 0 },
      { row: 0, col: 3, x: 3, y: 0, ei: 0 },
      { row: 1, col: 0, x: 0, y: 1, w: 1.5 },
      { row: 1, col: 1, x: 1.5, y: 1 },
      { row: 1, col: 2, x: 2.5, y: 1 },
      { row: -1, col: -1, x: 0, y: 3, d: true },
    ],
    optionKeys: {
      0: {
        0: [{ row: 2, col: 0, x: 0, y: 2, w: 3 }],
        1: [{ row: 2, col: 0, x: 0, y: 2, w: 1.5 }, { row: 2, col: 1, x: 1.5, y: 2, w: 1.5 }],
      },
      1: {
        0: [{ row: 1, col: 3, x: 3.5, y: 1, w: 2.25 }],
        1: [{ row: 1, col: 3, x: 3.75, y: 0, w: 1.25, h: 2 }],
      },
    },
  },
  menus: ['qmk_rgb_matrix'],
};

export interface FakeViaOpts {
  protocol?: number;
  /** channels the firmware handles */
  channels?: number[];
  ignoreWrites?: boolean;
  vendorId?: number;
  productId?: number;
}

export class FakeVia {
  vendorId: number;
  productId: number;
  productName = 'Q0 Test';
  opened = false;
  collections = [{ usagePage: 0xff60, usage: 0x61 }] as unknown as HIDCollectionInfo[];
  sent: number[][] = [];
  /** layout options: split space (bit 1) + ISO enter (bit 0) */
  layoutOptions = 0b11;
  /** values per channel: [bri, effect, speed, hue, sat] */
  values = new Map<number, number[]>();
  saves: number[] = [];
  keymap = new Uint8Array(4 * 4 * 2 * 2);
  private listeners = new Set<(e: HIDInputReportEvent) => void>();

  constructor(private o: FakeViaOpts = {}) {
    this.vendorId = o.vendorId ?? 0x3434;
    this.productId = o.productId ?? 0x0194;
    for (const ch of o.channels ?? [3]) this.values.set(ch, [200, 4, 128, 0, 255]);
    // layer 0: Esc Q W E / Tab A S Enter / Space MO(1)
    const kc: [number, number][] = [[0, 0x29], [1, 0x14], [2, 0x1a], [3, 0x08], [4, 0x2b], [5, 0x04], [6, 0x16], [7, 0x28], [8, 0x2c], [9, 0x5221]];
    for (const [i, k] of kc) {
      this.keymap[i * 2] = k >> 8;
      this.keymap[i * 2 + 1] = k & 0xff;
    }
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
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
    const buf = new Uint8Array(REPORT_LEN);
    buf.set(bytes.slice(0, REPORT_LEN));
    queueMicrotask(() => {
      const e = { reportId: 0, data: new DataView(buf.buffer) } as unknown as HIDInputReportEvent;
      for (const l of [...this.listeners]) l(e);
    });
  }

  async sendReport(id: number, data: BufferSource) {
    check(id === 0, 'report id');
    const p = Array.from(data as Uint8Array);
    check(p.length === REPORT_LEN, 'length');
    check(allowed(p), `packet ${p.slice(0, 6).join(',')}`);
    this.sent.push(p);
    const r = p.slice();
    const w = !this.o.ignoreWrites;
    switch (p[0]) {
      case CMD.protocol:
        r[1] = 0;
        r[2] = this.o.protocol ?? 12;
        break;
      case 0x02: {
        const v = p[1] === 0x01 ? 123456 : p[1] === 0x02 ? this.layoutOptions : 0x00010203;
        r.splice(2, 4, (v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
        break;
      }
      case CMD.layerCount:
        r[1] = 4;
        break;
      case CMD.getBuffer: {
        const off = (p[1] << 8) | p[2];
        for (let i = 0; i < p[3]; i++) r[4 + i] = this.keymap[off + i] ?? 0;
        break;
      }
      case CMD.customGet:
      case CMD.customSet:
      case CMD.customSave: {
        const v = this.values.get(p[1]);
        if (!v) {
          r[0] = CMD.unhandled;
          break;
        }
        if (p[0] === CMD.customSave) this.saves.push(p[1]);
        else if (p[0] === CMD.customGet) {
          if (p[2] === 4) r.splice(3, 2, v[3], v[4]);
          else r[3] = v[p[2] - 1];
        } else if (w) {
          if (p[2] === 4) [v[3], v[4]] = [p[3], p[4]];
          else v[p[2] - 1] = p[3];
        }
        break;
      }
    }
    this.reply(r);
  }

  asDevice() {
    return this as unknown as HIDDevice;
  }
}
