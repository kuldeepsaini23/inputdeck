// Simulated Pulsar X2 CrazyLight on its 8K receiver (3710:5406). Used by the tests and demo mode.
import { checksum } from '../pulsar'

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake pulsar: unexpected ' + what)
}

export class FakePulsar {
  opened = false
  vendorId = 0x3710
  productId = 0x5406
  productName = 'Pulsar 8K Dongle'
  collections = [
    { usagePage: 0xff02, usage: 1, inputReports: [{ reportId: 8 }], outputReports: [{ reportId: 8 }], featureReports: [] },
  ] as unknown as HIDCollectionInfo[]
  /** every frame the driver sent (16 data bytes) */
  sent: number[][] = []
  /** mouse switched off: awake answers "offline" */
  off = false
  /** next N requests get no answer */
  drop = 0
  profile = 1
  map = new Uint8Array(0x100)
  private listeners: ((e: HIDInputReportEvent) => void)[] = []

  constructor() {
    const m = this.map
    const set = (a: number, v: number) => { m[a] = v; m[a + 1] = (0x55 - v) & 0xff }
    set(0x00, 0x40) // 8000 Hz
    set(0x02, 4) // 4 stages
    set(0x04, 1) // stage 2 active
    set(0x0a, 1) // 1 mm
    const stages: [number, number, number][] = [[0x27, 0x27, 0x00], [0x4f, 0x4f, 0x00], [0x63, 0x63, 0x00], [0x37, 0x37, 0x22]] // 400 800 1000 12800
    stages.forEach(([a, b, h], i) => { const o = 0x0c + 4 * i; m[o] = a; m[o + 1] = b; m[o + 2] = h; m[o + 3] = (0x55 - a - b - h) & 0xff })
    ;[0xff0000, 0x00ff00, 0x0000ff, 0xffffff].forEach((c, i) => { const o = 0x2c + 4 * i; m[o] = c >> 16; m[o + 1] = (c >> 8) & 0xff; m[o + 2] = c & 0xff })
    const btn = (i: number, t: number, p: number) => { const o = 0x60 + 4 * i; m[o] = t; m[o + 1] = p >> 8; m[o + 2] = p & 0xff; m[o + 3] = (0x55 - t - (p >> 8) - (p & 0xff)) & 0xff }
    btn(0, 1, 0x0100); btn(1, 1, 0x0200); btn(2, 1, 0x0400); btn(3, 1, 0x0800); btn(4, 1, 0x1000)
    set(0xa9, 2) // debounce 2 ms
    set(0xab, 1) // motion sync on
    set(0xad, 6) // sleep 1 min
    set(0xaf, 0)
    set(0xb1, 0)
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners.push(fn) }
  removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners = this.listeners.filter((f) => f !== fn) }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed')
    check(id === 8, 'report id ' + id)
    const d = [...new Uint8Array(data as ArrayBuffer)]
    check(d.length === 16, 'length ' + d.length)
    check(d[15] === checksum(d), 'checksum')
    this.sent.push(d)
    if (this.drop > 0) { this.drop--; return }
    const r = d.slice()
    r[1] = 0
    const addr = (d[2] << 8) | d[3]
    const len = d[4]
    switch (d[0]) {
      case 0x01: r[9] = 87; r[10] = 3; r[11] = 5; break
      case 0x03: r[5] = this.off ? 0 : 1; r[9] = 0; break
      case 0x04: r[5] = 76; r[6] = 0; break
      case 0x08:
        check(addr + len <= 0x100 && len <= 10, 'read range')
        for (let i = 0; i < len; i++) r[5 + i] = this.map[addr + i]
        break
      case 0x07:
        check(addr + len <= 0x100 && len <= 10, 'write range')
        for (let i = 0; i < len; i++) this.map[addr + i] = d[5 + i]
        break
      case 0x0e: r[5] = this.profile; break
      case 0x0f: check(d[5] < 4, 'profile'); this.profile = d[5]; break
      case 0x12: r[5] = 3; r[6] = 0x05; break
      case 0x1d: r[5] = 2; r[6] = 0x25; break
      default: check(false, 'command ' + d[0])
    }
    r[15] = checksum(r)
    const view = new DataView(new Uint8Array(r).buffer)
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: 8, data: view } as unknown as HIDInputReportEvent)))
  }
}
