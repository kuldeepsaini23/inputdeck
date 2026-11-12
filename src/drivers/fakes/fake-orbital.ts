// Simulated Orbital Pathfinder (V1 'dms') or Pathfinder V2 / Ghost ('dms_v2'), wired or through
// its receiver. Answers only the commands the driver is allowed to send and throws on anything else.
// Used by the tests.
import { checksum, MODELS, validSum } from '../orbital'

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake orbital: unexpected ' + what)
}

export interface FakeOrbitalOptions {
  productId?: number
  /** V2 receiver: product id of the paired mouse (default: the right one) */
  pairedPid?: number
  stages?: [number, number][]
  battery?: number
}

const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff }

export class FakeOrbital {
  opened = false
  vendorId = 0x1915
  productId: number
  productName = 'Orbital mouse'
  collections = [
    { usagePage: 0x0001, usage: 2, inputReports: [], outputReports: [], featureReports: [] },
    { usagePage: 0xff0a, usage: 1, inputReports: [{ reportId: 0 }], outputReports: [{ reportId: 0 }], featureReports: [] },
  ] as unknown as HIDCollectionInfo[]
  readonly v2: boolean
  readonly receiver: boolean
  pairedPid: number
  /** every 64-byte packet the driver sent */
  sent: number[][] = []
  /** next N requests get no answer */
  drop = 0
  /** answer every settings write with the reject family */
  reject = false
  /** V1: the mouse ignores writes (readback differs) */
  ignoreWrites = false
  /** profile switches take effect only after this many requests */
  lazyProfile = 0
  saves = 0
  profile = 0
  battery: number
  /** V1: 52-byte block; V2: 54-byte sensor block */
  sensor: Uint8Array
  system = new Uint8Array(16)
  buttons = [0x0100f000, 0x0100f100, 0x0100f200, 0x0100f400, 0x0100f300, 0x07000300]
  private listeners: ((e: HIDInputReportEvent) => void)[] = []

  constructor(o: FakeOrbitalOptions = {}) {
    this.productId = o.productId ?? 0x080b
    const m = MODELS.get(this.productId)
    check(!!m, 'product id')
    this.v2 = m!.protocol === 'dms_v2'
    this.receiver = m!.receiver
    this.pairedPid = o.pairedPid ?? m!.pairedPid ?? 0
    this.battery = o.battery ?? 82
    const stages = o.stages ?? [[400, 400], [800, 800], [1600, 1600], [3200, 3200], [6400, 6400]]
    if (this.v2) {
      const s = (this.sensor = new Uint8Array(54))
      s[2] = 1 // motion sync
      s[4] = 1 // high performance
      s[7] = 1 // LOD medium
      s[8] = 0xfe // angle -2
      s[9] = 1 // stage 2 active
      s[10] = 0x0f // 4 stages
      stages.forEach(([x, y], i) => { put16(s, 11 + 4 * i, x); put16(s, 13 + 4 * i, y) })
      s.set([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255], 39)
      const y = this.system
      put16(y, 0, 300); put16(y, 2, 300)
      y[4] = 3 // 1000 Hz
      y[5] = 4 // debounce
      y[8] = 1 // move wake-up
      y[12] = 2; y[14] = 1; y[15] = 3 // pass-through bytes
    } else {
      const s = (this.sensor = new Uint8Array(52))
      s[0] = (1 << 5) | (1 << 1) // motion sync + high performance
      s[1] = 3 // 1000 Hz
      s[2] = 0x0f
      s[3] = 1
      stages.forEach(([x, y], i) => { put16(s, 4 + 4 * i, x); put16(s, 6 + 4 * i, y) })
      s[30] = 0x5a // unknown byte the driver must keep
      s[39] = 1
      s[40] = 3
      put16(s, 46, 600); put16(s, 48, 600)
      s[50] = 4
    }
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners.push(fn) }
  removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners = this.listeners.filter((f) => f !== fn) }

  /** push an unsolicited packet (e.g. a live status report) */
  emit(r: Uint8Array) {
    r[63] = checksum(r)
    const view = new DataView(r.buffer)
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: 0, data: view } as unknown as HIDInputReportEvent)))
  }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed')
    check(id === 0, 'report id ' + id)
    const d = new Uint8Array(data as ArrayBuffer)
    check(d.length === 64, 'length ' + d.length)
    check(validSum(d), 'checksum')
    this.sent.push([...d])
    if (this.drop > 0) { this.drop--; return }
    if (this.lazyProfile > 0) this.lazyProfile--
    const routed = (d[0] & 0x40) !== 0
    const fam = d[0] & 0xbf
    const op = d[2]
    const sub = d[3]
    // the handshake goes to the receiver itself; everything else must reach the mouse
    const isHandshake = fam === 1 && sub === 1 && !routed
    check(isHandshake || routed === this.receiver, `routing of ${fam}/${op}/${sub}`)
    const r = new Uint8Array(64)
    r[0] = d[0]
    r[3] = sub
    const reply = (payload: ArrayLike<number>) => { r[2] = 0x80 | payload.length; r.set(payload, 4) }
    const k = `${fam}:${op.toString(16)}:${sub}`
    switch (k) {
      case '1:81:1':
        if (isHandshake && this.receiver && this.v2) {
          const p = new Uint8Array(8); put16(p, 2, 0x1915); put16(p, 4, this.pairedPid); reply(p)
        } else {
          const p = new Uint8Array(12)
          const [so, po, fo] = this.v2 ? [6, 7, 8] : [1, 2, 3]
          p[so] = 0; p[po] = this.battery; p[fo] = this.profile
          reply(p)
        }
        break
      case '4:81:1': reply(this.sensor); break
      case '4:83:3': check(this.v2, 'V2 system read on V1'); reply(this.system); break
      case '4:b5:2':
        check(!this.v2, 'V1 write on V2')
        if (this.reject) { r[0] = 0x1f | (d[0] & 0x40); break }
        if (!this.ignoreWrites) this.sensor.set(d.slice(4, 4 + 51))
        reply([0])
        break
      case '4:bc:2':
        check(this.v2, 'V2 write on V1')
        if (this.reject) { r[0] = 0x1f | (d[0] & 0x40); break }
        check(d.slice(35, 43).every((b) => b === 0), 'reserved bytes')
        this.sensor.set(d.slice(4, 4 + 54))
        reply([0])
        break
      case '4:90:4':
        check(this.v2, 'V2 write on V1')
        this.system.set(d.slice(4, 4 + 16))
        reply([0])
        break
      case '10:81:1': this.saves++; reply([0]); break
      case '2:82:1':
      case '2:82:2':
        check(sub === (this.v2 ? 2 : 1), 'profile sub-command')
        check(d[4] < 5, 'profile')
        if (this.lazyProfile === 0) this.profile = d[4]
        reply([0])
        break
      case '3:82:3': {
        check(d[4] < 6, 'button index')
        const v = this.buttons[d[4]]
        reply([d[4], (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
        break
      }
      case '3:81:4':
      case '3:85:4': {
        check(d[4] < 6, 'button index')
        this.buttons[d[4]] = op === 0x81 ? 0 : ((d[5] << 24) | (d[6] << 16) | (d[7] << 8) | d[8]) >>> 0
        reply([d[4]])
        break
      }
      default:
        check(false, `command ${k}`)
    }
    this.emit(r)
  }
}
