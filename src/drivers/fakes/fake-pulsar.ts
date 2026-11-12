// Simulated CompX-B mouse. Defaults to the hardware-verified Pulsar X2 CrazyLight Mini (PRX edition,
// cid 87 / mid 96) on its 8K receiver (3710:5406); other brands are the same protocol with other ids.
// Used by the tests and demo mode.
import { checksum, stageBytes, stageBytes3955 } from '../pulsar'

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake pulsar: unexpected ' + what)
}

export interface FakeCompxbOptions {
  vendorId?: number
  productId?: number
  productName?: string
  cid?: number
  mid?: number
  /** identify byte 11: 0 1K, 1 4K, 2 wired, 3 wired 8K, 4 2K, 5 8K */
  link?: number
  /** how the DPI stages are stored */
  codec?: 'x1' | 's50' | 's3955'
  stages?: number[]
}

export class FakePulsar {
  opened = false
  vendorId: number
  productId: number
  productName: string
  cid: number
  mid: number
  link: number
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
  /** covers the per-profile map and the PAW3955 DPI records at 0x1B00 */
  map = new Uint8Array(0x1c00)
  private listeners: ((e: HIDInputReportEvent) => void)[] = []

  constructor(o: FakeCompxbOptions = {}) {
    this.vendorId = o.vendorId ?? 0x3710
    this.productId = o.productId ?? 0x5406
    this.productName = o.productName ?? 'Pulsar 8K Dongle'
    this.cid = o.cid ?? 87
    this.mid = o.mid ?? 96
    this.link = o.link ?? 5
    const m = this.map
    // macro records (one per button at 0x300 + 384 i) are erased flash on a real mouse
    m.fill(0xff, 0x300, 0x300 + 384 * 5)
    const set =(a: number, v: number) => { m[a] = v; m[a + 1] = (0x55 - v) & 0xff }
    const stages = o.stages ?? [400, 800, 1000, 12800]
    set(0x00, 0x40) // 8000 Hz
    set(0x02, stages.length)
    set(0x04, 1) // stage 2 active
    set(0x0a, 1) // 1 mm
    const codec = o.codec ?? 'x1'
    stages.forEach((dpi, i) => {
      if (codec === 's3955') m.set(stageBytes3955(dpi), 0x1b00 + 6 * i)
      // the 3955 firmware leaves factory values in the legacy fields
      m.set(stageBytes(codec === 's3955' ? 400 : dpi, codec === 's50' ? 's50' : 'x1'), 0x0c + 4 * i)
    })
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
    const inMap = addr + len <= this.map.length && len <= 10
    switch (d[0]) {
      case 0x01: r[9] = this.cid; r[10] = this.mid; r[11] = this.link; break
      case 0x03: r[5] = this.off ? 0 : 1; r[9] = 0; break
      case 0x04: r[5] = 76; r[6] = 0; break
      case 0x08:
        check(inMap, 'read range')
        for (let i = 0; i < len; i++) r[5 + i] = this.map[addr + i]
        break
      case 0x07:
        check(inMap, 'write range')
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

/** Same simulator, named for the other CompX-B brands. */
export const FakeCompxb = FakePulsar
