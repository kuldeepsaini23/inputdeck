// Simulated Logitech HID++ 2.0 mouse: either a PRO X SUPERLIGHT 2 behind a LIGHTSPEED receiver
// (046d:c547, mouse at index 1) or the same mouse on a cable (index 0xFF). Used by the tests.
import { crcCcitt } from '../logitech'

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake logitech: unexpected ' + what)
}

export interface FakeLogitechOptions {
  wired?: boolean
  /** use 0x8060 instead of 0x8061 */
  oldRate?: boolean
  /** battery feature to expose */
  battery?: 0x1000 | 0x1001 | 0x1004
  /** onboard memory mode (1 onboard, 2 host) */
  mode?: number
  /** HID++ device type from 0x0005 (3 = mouse) */
  type?: number
  /** receiver slot the mouse sits in */
  slot?: number
}

export const SECTOR_SIZE = 255

export class FakeLogitech {
  opened = false
  vendorId = 0x046d
  productId: number
  productName: string
  collections = [
    { usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 0x10 }], outputReports: [{ reportId: 0x10 }], featureReports: [] },
    { usagePage: 0xff00, usage: 2, inputReports: [{ reportId: 0x11 }], outputReports: [{ reportId: 0x11 }], featureReports: [] },
  ] as unknown as HIDCollectionInfo[]
  /** every frame sent: [reportId, ...data] */
  sent: number[][] = []
  /** feature ids the driver looked up through Root */
  lookups: number[] = []
  /** mouse switched off: nothing answers at its index */
  off = false
  name = 'PRO X SUPERLIGHT 2'
  dpi = 800
  rateIndex = 3 // 0x8061: 1000 Hz
  rateMs = 1 // 0x8060
  mode: number
  dpiIndex = 1
  slot: number
  index: number
  features: number[]
  sector = new Uint8Array(SECTOR_SIZE)
  private type: number
  private battery: number
  private listeners: ((e: HIDInputReportEvent) => void)[] = []

  constructor(o: FakeLogitechOptions = {}) {
    this.productId = o.wired ? 0xc09b : 0xc547
    this.productName = o.wired ? 'PRO X SUPERLIGHT 2' : 'USB Receiver'
    this.slot = o.slot ?? 1
    this.index = o.wired ? 0xff : this.slot
    this.mode = o.mode ?? 1
    this.type = o.type ?? 3
    this.battery = o.battery ?? 0x1004
    this.features = [0x0000, 0x0001, 0x0003, 0x0005, this.battery, 0x2201, o.oldRate ? 0x8060 : 0x8061, 0x8100, 0x00c2, 0x1802]
    // profile 1: report rate 1 ms, default stage 1, stages 400 800 1600 3200 6400
    const sct = this.sector
    sct.fill(0xff)
    sct[0] = 1
    sct[1] = 1
    sct[2] = 0
    ;[400, 800, 1600, 3200, 6400].forEach((v, i) => { sct[3 + 2 * i] = v & 0xff; sct[4 + 2 * i] = v >> 8 })
    const crc = crcCcitt(sct, SECTOR_SIZE - 2)
    sct[SECTOR_SIZE - 2] = crc >> 8
    sct[SECTOR_SIZE - 1] = crc & 0xff
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners.push(fn) }
  removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners = this.listeners.filter((f) => f !== fn) }

  private reply(id: number, bytes: number[]) {
    const len = id === 0x10 ? 6 : 19
    const d = new Uint8Array(len)
    d.set(bytes.slice(0, len))
    const view = new DataView(d.buffer)
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: id, data: view } as unknown as HIDInputReportEvent)))
  }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed')
    const d = [...new Uint8Array(data as ArrayBuffer)]
    check((id === 0x10 && d.length === 6) || (id === 0x11 && d.length === 19), `report ${id} length ${d.length}`)
    this.sent.push([id, ...d])
    const [dev, feat, fsw] = d
    const func = fsw >> 4
    check((fsw & 0x0f) !== 0, 'software id 0')
    const p = d.slice(3)
    const ok = (params: number[]) => this.reply(params.length > 3 ? 0x11 : id, [dev, feat, fsw, ...params])
    const err = (code: number) => this.reply(0x11, [dev, 0xff, feat, fsw, code])

    if (dev !== this.index) {
      // the receiver answers for empty slots (and for itself) with a HID++ 1.0 error
      if (this.index !== 0xff) this.reply(0x10, [dev, 0x8f, feat, fsw, 0x09])
      return
    }
    if (this.off) return
    const fid = this.features[feat]
    if (fid === undefined) return err(6)
    switch (fid) {
      case 0x0000:
        if (func === 0) {
          const want = (p[0] << 8) | p[1]
          this.lookups.push(want)
          const i = this.features.indexOf(want)
          return ok([i < 0 ? 0 : i, 0, 0])
        }
        if (func === 1) return ok([4, 2, p[2]])
        break
      case 0x0001:
        if (func === 0) return ok([this.features.length - 1])
        break
      case 0x0003:
        if (func === 0) return ok([2])
        if (func === 1) {
          if (p[0] === 0) return ok([0, 0x52, 0x51, 0x52, 0x01, 0x02, 0x00, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]) // main app RQR 01.02.B000A
          return ok([1, 0x42, 0x4f, 0x54, 0x00, 0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        }
        break
      case 0x0005:
        if (func === 0) return ok([this.name.length])
        if (func === 1) {
          const chunk = [...this.name.slice(p[0], p[0] + 16)].map((c) => c.charCodeAt(0))
          while (chunk.length < 16) chunk.push(0)
          return ok(chunk)
        }
        if (func === 2) return ok([this.type])
        break
      case 0x1000:
        if (func === 0) return ok([64, 50, 0])
        break
      case 0x1001:
        if (func === 0) return ok([3811 >> 8, 3811 & 0xff, 0x80])
        break
      case 0x1004:
        if (func === 1) return ok([76, 4, 1, 1])
        break
      case 0x2201:
        if (func === 0) return ok([1])
        if (func === 1) return ok([0, 0x00, 0x64, 0xe0, 0x32, 0x7d, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]) // 100..32000 step 50
        if (func === 2) return ok([0, this.dpi >> 8, this.dpi & 0xff, 0x03, 0x20])
        if (func === 3) { this.dpi = (p[1] << 8) | p[2]; return ok([p[0], p[1], p[2]]) }
        break
      case 0x8060:
        if (func === 0) return ok([0x8b]) // 1, 2, 4, 8 ms
        if (func === 1) return ok([this.rateMs])
        if (func === 2) { this.rateMs = p[0]; return ok([]) }
        break
      case 0x8061:
        if (func === 1) return ok([0x00, 0x7f])
        if (func === 2) return ok([this.rateIndex])
        if (func === 3) { this.rateIndex = p[0]; return ok([]) }
        break
      case 0x8100:
        if (func === 0) return ok([1, 4, 1, 5, 1, 5, 16, SECTOR_SIZE >> 8, SECTOR_SIZE & 0xff, 0, 2, 0, 0, 0, 0, 0])
        if (func === 2) return ok([this.mode])
        if (func === 4) return ok([0x00, 0x01])
        if (func === 5) {
          check(id === 0x11, 'short memory read')
          const sector = (p[0] << 8) | p[1]
          const off = (p[2] << 8) | p[3]
          check(sector === 1, 'sector ' + sector)
          if (off + 16 > SECTOR_SIZE) return err(2)
          return ok([...this.sector.slice(off, off + 16)])
        }
        if (func === 0xb) return ok([this.dpiIndex])
        break
    }
    check(false, `feature ${fid.toString(16)} function ${func}`)
  }
}
