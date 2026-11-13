// Simulated ATK (BitYuan) Hall-effect keyboard: just the firmware commands the ATK keyboard driver may send.
// Used by the tests and the demo mode. Never talks to a real device.
import { allowed, BUF_CHUNK, CMD_GET, CMD_GET_BUFFER, CUSTOM, F_GAMEPAD, F_RESTART, F_VERSION, GP, REPORT_LEN } from '../atk-kb';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake ATK keyboard: unexpected ' + what);
};

export interface FakeAtkKbOpts {
  productId?: number;
  rows?: number;
  cols?: number;
  /** firmware version bytes [major, minor] as the board reports them (BCD-ish: 0x02,0x05 = "2.05") */
  version?: [number, number];
  /** stop answering after a mode change (like the real board restarting) */
  restartOnMode?: boolean;
  ignoreWrites?: boolean;
}

export class FakeAtkKb {
  vendorId = 0x373b;
  productId: number;
  productName = 'ATK EDGE 60HE ULTIMATE';
  opened = false;
  collections = [{ usagePage: 0xff60, usage: 0x61 }] as unknown as HIDCollectionInfo[];
  sent: number[][] = [];
  readonly rows: number;
  readonly cols: number;
  /** layer 0 keymap, rows x cols, QMK keycodes (0 = no switch) */
  keymap: number[];
  mode = 2;
  angle = [45, 45];
  square = [0, 0];
  extreme = [0, 0];
  keyOutput = 0;
  enabled = 0;
  autoRestart = 0;
  /** gamepad mappings by "row,col" */
  map = new Map<string, number>();
  curves: { x: number[]; y: number[] }[] = Array.from({ length: 4 }, () => ({ x: [100, 1166, 2233, 3300], y: [20, 85, 170, 255] }));
  restarted = false;
  private listeners = new Set<(e: HIDInputReportEvent) => void>();

  constructor(private o: FakeAtkKbOpts = {}) {
    this.productId = o.productId ?? 0x10b0;
    this.rows = o.rows ?? 5;
    this.cols = o.cols ?? 14;
    this.keymap = new Array(this.rows * this.cols).fill(0);
    // row 0: Esc 1 2 3 ..., row 1: Tab Q W E ..., row 2: Caps A S D ..., row 4 col 5: Space
    const set = (r: number, c: number, kc: number) => (this.keymap[r * this.cols + c] = kc);
    set(0, 0, 0x29);
    for (let c = 1; c <= 10; c++) set(0, c, 0x1d + c);
    set(1, 0, 0x2b);
    [0x14, 0x1a, 0x08, 0x15, 0x17].forEach((k, i) => set(1, i + 1, k));
    set(2, 0, 0x39);
    [0x04, 0x16, 0x07, 0x09].forEach((k, i) => set(2, i + 1, k));
    set(3, 0, 0xe1);
    set(4, 0, 0xe0);
    set(4, 5, 0x2c);
    // W A S D already drive the left stick
    this.map.set('1,2', 65);
    this.map.set('2,1', 80);
    this.map.set('2,2', 81);
    this.map.set('2,3', 64);
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
    check(allowed(p, { rows: this.rows, cols: this.cols }), `packet ${p.slice(0, 8).join(',')}`);
    if (this.restarted) return; // gone: restarting with the new USB interface
    this.sent.push(p);
    const r = p.slice();
    const w = !this.o.ignoreWrites;
    if (p[0] === CMD_GET_BUFFER) {
      const off = (p[1] << 8) | p[2];
      for (let i = 0; i < BUF_CHUNK; i++) {
        const b = off + i;
        const kc = this.keymap[b >> 1] ?? 0;
        r[4 + i] = b & 1 ? kc & 0xff : kc >> 8;
      }
      return this.reply(r);
    }
    check(p[1] === CUSTOM, 'command');
    const get = p[0] === CMD_GET;
    if (p[2] === F_VERSION) {
      const [a, b] = this.o.version ?? [0x02, 0x05];
      r[5] = a;
      r[6] = b;
      return this.reply(r);
    }
    if (p[2] === F_RESTART) {
      if (w) this.autoRestart = p[3];
      return this.reply(r);
    }
    check(p[2] === F_GAMEPAD, 'field');
    const [row, col, sub, v] = [p[3], p[4], p[5], p[6]];
    if (get) {
      if (sub === GP.config) {
        r.splice(6, 9, this.mode, this.angle[0], this.angle[1], this.square[0], this.square[1], this.extreme[0], this.extreme[1], this.keyOutput, this.enabled);
      } else if (sub === GP.mapping) r[6] = this.map.get(`${row},${col}`) ?? 0;
      else if (sub === GP.curve) {
        const c = this.curves[row];
        for (let k = 0; k < 4; k++) r.splice(6 + k * 3, 3, c.x[k] & 0xff, c.x[k] >> 8, c.y[k]);
      }
      return this.reply(r);
    }
    if (w)
      switch (sub) {
        case GP.mode:
          this.mode = v;
          if (this.o.restartOnMode && this.autoRestart) {
            this.restarted = true;
            return;
          }
          break;
        case GP.mapping:
          if (v) this.map.set(`${row},${col}`, v);
          else this.map.delete(`${row},${col}`);
          break;
        case GP.enabled:
          this.enabled = v;
          break;
        case GP.keyOutput:
          this.keyOutput = v;
          break;
        case GP.angle:
          this.angle[row] = v;
          break;
        case GP.square:
          this.square[row] = v;
          break;
        case GP.extreme:
          this.extreme[row] = v;
          break;
        case GP.curve:
          this.curves[row] = {
            x: [0, 1, 2, 3].map((k) => p[6 + k * 3] | (p[7 + k * 3] << 8)),
            y: [0, 1, 2, 3].map((k) => p[8 + k * 3]),
          };
          break;
      }
    this.reply(r);
  }

  asDevice() {
    return this as unknown as HIDDevice;
  }
}
