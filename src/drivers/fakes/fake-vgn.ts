// Simulated VGN FLASH68 ("arbit" protocol). Accepts only frames the driver's allowlist accepts
// and throws on anything else. Used by the tests.
import { allowed, checksum, CMD, KEYS, LAYER_BYTES, PROFILE_STRIDE, PROFILES } from '../vgn';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake vgn: unexpected ' + what);
};

export interface FakeVgnOptions {
  productId?: number;
  profile?: number;
  /** device restarts (stops answering) after a gamepad mode change */
  restartOnMode?: boolean;
}

export class FakeVgn {
  opened = false;
  vendorId = 0x391d;
  productId: number;
  productName = 'VGN FLASH68';
  collections = [{ usagePage: 0x0001, usage: 0, inputReports: [{ reportId: 0 }], outputReports: [{ reportId: 0 }], featureReports: [] }] as unknown as HIDCollectionInfo[];
  sent: number[][] = [];
  profile: number;
  gamepad = new Uint8Array(64);
  /** 4 profiles x 2048 bytes; layer 0 = first 512 */
  matrix = new Uint8Array(PROFILES * PROFILE_STRIDE);
  dead = false;
  private listeners: ((e: HIDInputReportEvent) => void)[] = [];

  constructor(private o: FakeVgnOptions = {}) {
    this.productId = o.productId ?? 0x2007;
    this.profile = o.profile ?? 0;
    this.gamepad.set([0xaa, 0xbb, 0, 0, 0x01, 0, 0, 0, 45]);
    this.gamepad[20] = 0x5a; // unknown byte the driver must keep
    for (let p = 0; p < PROFILES; p++) for (const [i, , d] of KEYS) this.matrix.set(d, p * PROFILE_STRIDE + 3 * i);
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

  private reply(cmd: number, off: number, data: ArrayLike<number>) {
    const r = new Uint8Array(64);
    r[0] = 0xaa;
    r[1] = cmd;
    r[4] = data.length;
    r[5] = off & 0xff;
    r[6] = off >> 8;
    r.set(data, 8);
    r[3] = checksum(r);
    const view = new DataView(r.buffer);
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: 0, data: view } as unknown as HIDInputReportEvent)));
  }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed');
    check(id === 0, 'report id ' + id);
    const d = new Uint8Array(data as ArrayBuffer);
    check(d.length === 64, 'length');
    check(allowed(d), 'frame ' + [...d.subarray(0, 8)].map((b) => b.toString(16)).join(' '));
    this.sent.push([...d]);
    if (this.dead) return;
    const cmd = d[1];
    const len = d[4];
    const off = d[5] | (d[6] << 8);
    const payload = d.subarray(8, 8 + len);
    switch (cmd) {
      case CMD.getInfo:
        return this.reply(cmd, 0, [0x05, 0x01, 0, 0]);
      case CMD.getBase:
        return this.reply(cmd, 0, [this.profile, 4, 0, 1, 2, 3]);
      case CMD.getKeys:
        check(off % PROFILE_STRIDE < LAYER_BYTES, 'key offset');
        return this.reply(cmd, off, this.matrix.subarray(off, off + len));
      case CMD.setKeys:
        this.matrix.set(payload, off);
        return this.reply(cmd, off, []);
      case CMD.getGamepad:
        return this.reply(cmd, off, this.gamepad.subarray(off, off + len));
      case CMD.setGamepad: {
        const modeBefore = this.gamepad[2];
        this.gamepad.set(payload, off);
        if (this.o.restartOnMode && off === 0 && this.gamepad[2] !== modeBefore) {
          this.dead = true;
          return;
        }
        return this.reply(cmd, off, []);
      }
    }
    check(false, 'command ' + cmd);
  }
}
