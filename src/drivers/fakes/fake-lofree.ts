// Simulated Lofree Hyzen (Lofree HUB protocol, report 4 transactions). Used by the tests.
import {
  CMD,
  HYZEN_CODES,
  KEY_SLOTS,
  LED_BYTES,
  L_BRI,
  L_MODE,
  L_RGB,
  L_SPEED,
  POLL_WIRED,
  POLL_WIRELESS,
  PROFILE_SIZE,
  PROFILES,
  SWITCH_TYPE,
  allowed,
  frameSize,
} from '../lofree';

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake device: unexpected ' + what);
};

export interface FakeLofreeOpts {
  productId?: number;
  /** 01 mechanical, 02 magnetic */
  switchType?: number;
  ignoreWrites?: boolean;
  /** don't answer at all (not a Hyzen / asleep) */
  silent?: boolean;
  profile?: number;
  /** commands whose data frames get no reply (firmware without them) */
  unanswered?: number[];
}

/** Key index the fake gives layout position i (scrambled a bit, like a real matrix). */
export const fakeIndex = (i: number) => (i * 7 + 3) % KEY_SLOTS;

export class FakeLofree {
  vendorId = 0x388d;
  productId: number;
  productName = 'HYZEN';
  opened = false;
  collections = [{ usagePage: 0xff1c, usage: 0x92 }] as unknown as HIDCollectionInfo[];
  /** every frame sent (report 4 payload) */
  sent: number[][] = [];
  size: number;
  func = new Array<number>(PROFILE_SIZE * PROFILES).fill(0);
  matrix = new Array<number>(KEY_SLOTS * 3).fill(0);
  keySpec = new Array<number>(KEY_SLOTS * 2).fill(0);
  act = new Array<number>(KEY_SLOTS * 2 * PROFILES).fill(0);
  rt = new Array<number>(KEY_SLOTS * 4 * PROFILES).fill(0);
  travelSpec = new Array<number>(56).fill(0);
  /** key type per profile x key (20 normal, 24 DKS, 25 RS, 26 SOCD, 27 HT) */
  types = new Array<number>(KEY_SLOTS * PROFILES).fill(0x20);
  /** SOCD table per profile x key: [partner, flags, travel lo, travel hi] */
  socd = new Array<number>(KEY_SLOTS * 4 * PROFILES).fill(0);
  /** 1B: LED index of every key index (read-only; layout key i -> LED i, others FF) */
  ledMap = new Array<number>(KEY_SLOTS).fill(0xff);
  /** 21: current colour of every LED, R,G,B (read-only, like the firmware's frame) */
  leds = new Array<number>(LED_BYTES).fill(0);
  live = false;
  liveTimer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(e: HIDInputReportEvent) => void>();
  private tx: 'read' | 'write' | undefined;

  constructor(private o: FakeLofreeOpts = {}) {
    this.productId = o.productId ?? 0x0024;
    this.size = frameSize(this.productId === 0x0025);
    const p = o.profile ?? 0;
    this.func[0] = p;
    const b = p * PROFILE_SIZE;
    this.func[b + L_MODE] = 0x0a;
    this.func[b + L_SPEED] = 1;
    this.func[b + 5] = 1;
    this.func[b + L_RGB] = 0x11;
    this.func[b + L_RGB + 1] = 0x22;
    this.func[b + L_RGB + 2] = 0x33;
    this.func[b + L_BRI] = 100;
    this.func[b + SWITCH_TYPE] = o.switchType ?? 0x02;
    this.func[POLL_WIRED] = 0x00;
    this.func[POLL_WIRELESS] = 0x04;
    HYZEN_CODES.forEach((c, i) => {
      const k = fakeIndex(i);
      this.matrix.splice(k * 3, 3, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
      this.ledMap[k] = i;
    });
    for (let l = 0; l < LED_BYTES / 3; l++) this.leds.splice(l * 3, 3, l, 0x80, 0xff - l);
    for (let k = 0; k < KEY_SLOTS; k++) {
      this.keySpec[k * 2] = 1000 & 0xff;
      this.keySpec[k * 2 + 1] = 1000 >> 8;
      // every key: raw 500 actuation, RT press/release raw 100
      for (let q = 0; q < PROFILES; q++) {
        const a = (q * KEY_SLOTS + k) * 2;
        this.act[a] = 500 & 0xff;
        this.act[a + 1] = 500 >> 8;
        const r = (q * KEY_SLOTS + k) * 4;
        this.rt[r] = 100;
        this.rt[r + 2] = 100;
      }
    }
    // min 0.1 mm, max 3.4 mm
    this.travelSpec[0] = 100;
    this.travelSpec[2] = 3400 & 0xff;
    this.travelSpec[3] = 3400 >> 8;
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

  private emit(reportId: number, bytes: number[], size = this.size) {
    const buf = new Uint8Array(size);
    buf.set(bytes.slice(0, size));
    queueMicrotask(() => {
      const e = { reportId, data: new DataView(buf.buffer) } as unknown as HIDInputReportEvent;
      for (const l of [...this.listeners]) l(e);
    });
  }

  private table(cmd: number): number[] | undefined {
    switch (cmd) {
      case CMD.READ_FUNC:
      case CMD.WRITE_FUNC:
        return this.func;
      case CMD.READ_DEF_MATRIX:
        return this.matrix;
      case CMD.READ_VERSION:
        return [32, 1];
      case CMD.READ_DONGLE_VERSION:
        return [7, 1];
      case CMD.READ_TRAVEL_SPEC:
        return this.travelSpec;
      case CMD.READ_KEY_SPEC:
        return this.keySpec;
      case CMD.READ_ACT:
      case CMD.WRITE_ACT:
        return this.act;
      case CMD.READ_RT:
      case CMD.WRITE_RT:
        return this.rt;
      case CMD.READ_KEY_TYPE:
      case CMD.WRITE_KEY_TYPE:
        return this.types;
      case CMD.READ_SOCD:
      case CMD.WRITE_SOCD:
        return this.socd;
      case CMD.READ_LED_MAP:
        return this.ledMap;
      case CMD.READ_LED_COLORS:
        return this.leds;
      default:
        return undefined;
    }
  }

  async sendReport(id: number, data: BufferSource) {
    check(id === 4, 'report id');
    const p = Array.from(data as Uint8Array);
    check(p.length === this.size, 'frame size');
    check(allowed(p, this.size), 'disallowed frame ' + p.slice(0, 8).join(','));
    this.sent.push(p);
    if (this.o.silent) return;
    const cmd = p[2];
    if (cmd === 0x01) {
      check(this.tx === undefined, 'nested transaction');
      this.tx = p[3] === 0x18 ? 'read' : 'write';
      this.emit(4, [0, 0, 0x01]);
      return;
    }
    if (cmd === 0x02) {
      check(this.tx === (p[3] === 0x18 ? 'read' : 'write'), 'end without start');
      this.tx = undefined;
      this.emit(4, [0, 0, 0x02]);
      return;
    }
    check(this.tx !== undefined, 'frame outside a transaction');
    const len = p[3];
    const off = p[4] | (p[5] << 8);
    if (cmd === CMD.LIVE_TRAVEL) {
      check(this.tx === 'write', 'live travel as read');
      if (len === 1) this.startLive();
      else this.stopLive();
      this.emit(4, [0, 0, cmd, len, p[4], p[5], 0]);
      return;
    }
    if (this.o.unanswered?.includes(cmd)) return;
    const t = this.table(cmd);
    check(t !== undefined, 'command ' + cmd.toString(16));
    const isWrite = [CMD.WRITE_FUNC, CMD.WRITE_ACT, CMD.WRITE_RT, CMD.WRITE_KEY_TYPE, CMD.WRITE_SOCD].includes(cmd as never);
    check(this.tx === (isWrite ? 'write' : 'read'), 'command in the wrong transaction');
    if (isWrite) {
      if (!this.o.ignoreWrites) for (let i = 0; i < len; i++) t![off + i] = p[7 + i];
      this.emit(4, [0, 0, cmd, len, p[4], p[5], 0]);
    } else {
      this.emit(4, [0, 0, cmd, len, p[4], p[5], 0, ...t!.slice(off, off + len)]);
    }
  }

  private startLive() {
    this.live = true;
    let t = 0;
    const w = fakeIndex(HYZEN_CODES.indexOf(0x20001a));
    this.liveTimer ??= setInterval(() => {
      t += 0.3;
      const cur = Math.round(3400 * Math.max(0, Math.sin(t)));
      this.emit(6, [w, cur & 0xff, cur >> 8, 3400 & 0xff, 3400 >> 8], 30);
    }, 10);
  }

  private stopLive() {
    this.live = false;
    clearInterval(this.liveTimer);
    this.liveTimer = undefined;
  }

  asDevice() {
    return this as unknown as HIDDevice;
  }
  /** data frames (not START/END) of command `cmd` */
  frames(cmd: number) {
    return this.sent.filter((p) => p[2] === cmd);
  }
}
