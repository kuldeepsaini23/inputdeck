// Simulated HUAN M on its 8K receiver. Used by the tests and the demo mode.

/** Fakes refuse anything the real device wouldn't accept, so bugs surface in tests and demo alike. */
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake device: unexpected ' + what);
};

export interface FakeOpts {
  /** returned feature reports include a leading report-id byte (65 bytes) */
  withReportId?: boolean;
  /** device answers nothing sensible (not ours) */
  dead?: boolean;
  vendorId?: number;
  productId?: number;
  /** product name the browser reports */
  productName?: string;
  /** PID inside the mouse's 00/81 firmware reply (default 0xA859 = HUAN M) */
  mousePid?: number;
  /** target the mouse answers on (default 2; some wired CompX-A mice answer on 0) */
  mouseTarget?: number;
  /** shared receivers: [vid, pid] answered to the read-only 00/8B [02] query on target 1 */
  paired?: [number, number];
}

type Frame = { target: number; len: number; page: number; cmd: number; payload: number[] };

/** Simulates a HUAN M on its 8K receiver (36A7:A863), state kept in plain fields. */
export class FakeMouse {
  opened = false;
  vendorId: number;
  productId: number;
  productName = 'WL HUAN 8K Receiver';
  collections: HIDCollectionInfo[] = [
    { usagePage: 0xffff, usage: 0, featureReports: [{ reportId: 0 }] } as unknown as HIDCollectionInfo,
  ];
  sent: Frame[] = [];
  /** next N receives answer 0xA0 (pending) */
  pending = 0;
  /** next N sends answer 0xA3 (busy -> resend) */
  busy = 0;
  /** next N receives answer a stale frame (different page/cmd) */
  stale = 0;
  asleep = false;
  private reply: Uint8Array = new Uint8Array(64);
  private replyBusy = false;

  // ---- device state
  profile = 2;
  profileCount = 3;
  names: Record<number, string> = { 1: 'Profile 1', 2: 'Aim', 3: 'Profile 3' };
  battery = [0, 37];
  dpiMax = 42000;
  table: Record<number, { count: number; st: [number, number][] }> = {};
  activeStage: Record<number, number> = {};
  colors: Record<number, number[]> = {};
  p1: Record<number, Record<number, number>> = {}; // page-1 per-profile scalars by cmd
  lod: Record<number, [number, number]> = {};
  buttons: Record<number, Record<number, { t: number; d: number[] }>> = {};
  combo: Record<number, number> = {};
  debounce: Record<number, number> = {};
  sleepSecs: Record<number, number> = {};
  screen = { effect: 1, status: 0, voice: 0xff };
  /** hidden RGB light, as read from a real HUAN M: off, red, full brightness */
  light = { effect: 0, speed: 1, rgb: [0xff, 0, 0], bri: 0xff };
  /** upload in progress (05/04 .. 05/05) */
  upload: { head: number[]; data: Uint8Array; got: number }[] | null = null;
  pictures: Uint8Array[] = [];
  slots: (number[] | null)[] = [[0x00, 0x03, 0xf4, 0x80, 0x01, 0x68, 0x01, 0x68, 0x01], null, null, null, null, null, null, null];

  constructor(readonly o: FakeOpts = {}) {
    this.vendorId = o.vendorId ?? 0x36a7;
    this.productId = o.productId ?? 0xa863;
    if (o.productName) this.productName = o.productName;
    for (const p of [1, 2, 3]) {
      this.table[p] = {
        count: 6,
        st: [[400, 400], [800, 800], [1600, 1600], [3200, 3200], [6400, 6400], [30000, 30000]],
      };
      this.activeStage[p] = 3;
      this.colors[p] = [0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0xff, 0, 0xff, 0, 0xff, 0xff];
      this.p1[p] = { 0x00: 0x01, 0x0d: 0, 0x04: 0, 0x09: 0, 0x0a: 0, 0x0b: 0, 0x13: 0, 0x14: 0 };
      this.lod[p] = [0x01, 0x03];
      this.buttons[p] = {
        1: { t: 1, d: [1] }, 2: { t: 1, d: [2] }, 3: { t: 1, d: [3] }, 4: { t: 1, d: [4] }, 5: { t: 4, d: [0x00, 0x04] },
      };
      this.combo[p] = 1;
      this.debounce[p] = 0;
      this.sleepSecs[p] = 60;
    }
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

  async sendFeatureReport(reportId: number, data: BufferSource) {
    if (!this.opened) throw new Error('not opened');
    check(reportId === 0, 'reportId');
    const b = new Uint8Array(data as ArrayBuffer);
    check(b.length === 64, 'b.length');
    const f: Frame = { target: b[2], len: b[3], page: b[4], cmd: b[5], payload: [...b.slice(6, 6 + b[3])] };
    this.sent.push(f);
    if (this.o.dead) {
      this.reply = new Uint8Array(64);
      return;
    }
    this.replyBusy = this.busy > 0;
    if (this.busy > 0) this.busy--;
    let status = 0xa1;
    let pl: number[] = [];
    if (this.asleep && f.target === (this.o.mouseTarget ?? 2)) status = 0xa4;
    else {
      const r = this.handle(f);
      if (r === null) status = 0xa2;
      else pl = r;
    }
    const out = new Uint8Array(64);
    out.set([this.replyBusy ? 0xa3 : status, 0, f.target, pl.length, f.page, f.cmd]);
    out.set(pl.slice(0, 58), 6);
    this.reply = out;
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    check(reportId === 0, 'reportId');
    let r = this.reply;
    if (this.stale > 0) {
      this.stale--;
      r = new Uint8Array(64);
      r.set([0xa1, 0, 2, 0, 0x7e, 0x7e]);
    } else if (this.pending > 0) {
      this.pending--;
      r = r.slice();
      r[0] = 0xa0;
    }
    if (this.o.withReportId) {
      const w = new Uint8Array(65);
      w.set(r, 1);
      return new DataView(w.buffer);
    }
    return new DataView(r.slice().buffer);
  }

  /** returns reply payload, or null = unsupported */
  private handle(f: Frame): number[] | null {
    const get = (f.cmd & 0x80) !== 0;
    const c = f.cmd & 0x7f;
    const a = f.payload;
    const p = a[0];
    const mouse = this.o.mouseTarget ?? 2;
    if (f.target === 1) {
      // read-only "which mouse is paired" query of a shared receiver
      if (f.page === 0 && c === 0x0b && get && a[0] === 0x02 && this.o.paired) {
        const [v, d] = this.o.paired;
        return [0x02, 0, v >> 8, v & 0xff, d >> 8, d & 0xff];
      }
      return null;
    }
    if (f.target === 0 && mouse !== 0) {
      if (f.page === 0 && c === 0x01 && get) return [0, 1, 0, 12, 0xa8, 0x63];
      if (f.page === 5 && c === 0x06) return get ? [this.screen.effect] : ((this.screen.effect = a[0]), []);
      if (f.page === 5 && c === 0x0a) return get ? [this.screen.status] : ((this.screen.status = a[0]), []);
      if (f.page === 6 && c === 0x00) return get ? [this.screen.voice] : ((this.screen.voice = a[0]), []);
      // picture upload: 05/04 start, 05/00 header + data, 05/80 read-back, 05/05 finish, 05/09 delete
      if (f.page === 5 && c === 0x04 && !get) return (this.upload = []), [];
      if (f.page === 5 && c === 0x00 && !get) {
        check(this.upload !== null, 'data before 05/04');
        const off = (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3];
        if (off === 0) {
          const len = (a[4] << 24) | (a[5] << 16) | (a[6] << 8) | a[7];
          this.upload!.push({ head: a.slice(4, 13), data: new Uint8Array(len), got: 0 });
        } else {
          const im = this.upload![this.upload!.length - 1];
          check(!!im && off - 9 === im.got, 'data offset');
          im.data.set(a.slice(4), off - 9);
          im.got += a.length - 4;
        }
        return [];
      }
      if (f.page === 5 && c === 0x00 && get) return [0, 0, 0, 0, 9, ...(this.upload?.at(-1)?.head ?? [])];
      if (f.page === 5 && c === 0x05 && !get) {
        const ups = this.upload ?? [];
        for (const u of ups) check(u.got === u.data.length, 'incomplete picture');
        this.slots = Array.from({ length: 8 }, (_, i) => (ups[i] ? [...ups[i].head] : null));
        this.pictures = ups.map((u) => u.data);
        this.upload = null;
        return [];
      }
      if (f.page === 5 && c === 0x09 && !get) return (this.slots = Array(8).fill(null)), (this.pictures = []), [];
      if (f.page === 5 && c === 0x08 && get) {
        const sl = this.slots[a[1] - 1];
        return [0, a[1], ...(sl ?? Array(9).fill(0xff))];
      }
      return null;
    }
    if (f.target !== mouse) return null;
    if (f.page === 0) {
      switch (c) {
        case 0x01: {
          const mp = this.o.mousePid ?? 0xa859;
          return get ? [0, 1, 0, 12, mp >> 8, mp & 0xff] : null;
        }
        case 0x03: return get ? this.battery : null;
        case 0x05: if (get) return [this.profile]; this.profile = a[0]; return [];
        case 0x06: return get ? [this.profileCount] : null;
        case 0x0e: {
          if (!get) return null;
          const n = this.names[p] ?? '';
          const bytes: number[] = [];
          for (const ch of n) bytes.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
          return [p, bytes.length, ...bytes];
        }
        case 0x07: if (get) return [p, this.sleepSecs[p] >> 8, this.sleepSecs[p] & 0xff]; this.sleepSecs[p] = (a[1] << 8) | a[2]; return [];
        case 0x08: if (get) return [p, this.debounce[p]]; this.debounce[p] = a[1]; return [];
      }
      return null;
    }
    if (f.page === 1) {
      if (c === 0x01) {
        if (get) {
          const t = this.table[p];
          return [p, t.count, ...t.st.flatMap(([x, y]) => [x >> 8, x & 0xff, y >> 8, y & 0xff])];
        }
        check(a.length === 26, 'a.length');
        const st: [number, number][] = [];
        for (let i = 0; i < 6; i++) st.push([(a[2 + i * 4] << 8) | a[3 + i * 4], (a[4 + i * 4] << 8) | a[5 + i * 4]]);
        this.table[p] = { count: a[1], st };
        return [];
      }
      if (c === 0x02) { if (get) return [p, this.activeStage[p]]; this.activeStage[p] = a[1]; return []; }
      if (c === 0x0c) return get ? [this.dpiMax >> 8, this.dpiMax & 0xff] : null;
      if (c === 0x08) { if (get) return [p, ...this.lod[p]]; this.lod[p] = [a[1], a[2]]; return []; }
      if (c in this.p1[p]) { if (get) return [p, this.p1[p][c]]; this.p1[p][c] = a[1]; return []; }
      return null;
    }
    if (f.page === 2 && c === 0x00 && a[0] === 1) {
      if (get) return [1, 0, this.light.effect, 0, 7 - this.light.speed, ...this.light.rgb, ...Array(18).fill(0xff)];
      check(a.length === 8, 'light effect length');
      this.light = { ...this.light, effect: a[2], speed: 7 - a[4], rgb: a.slice(5, 8) };
      return [];
    }
    if (f.page === 2 && c === 0x02 && a[0] === 1) {
      if (get) return [1, 0, this.light.bri];
      this.light.bri = a[2];
      return [];
    }
    if (f.page === 2 && c === 0x01) {
      if (get) return [p, ...this.colors[p]];
      check(a.length === 19, 'a.length');
      this.colors[p] = a.slice(1);
      return [];
    }
    if (f.page === 3) {
      if (c === 0x01) { if (get) return [p, this.combo[p]]; this.combo[p] = a[1]; return []; }
      if (c === 0x00) {
        if (get) {
          const b = this.buttons[p][a[1]];
          return [p, a[1], 0, b.t, b.d.length, ...b.d];
        }
        this.buttons[p][a[1]] = { t: a[3], d: a.slice(5, 5 + a[4]) };
        return [];
      }
    }
    return null;
  }

  sets() {
    return this.sent.filter((f) => (f.cmd & 0x80) === 0);
  }
}

