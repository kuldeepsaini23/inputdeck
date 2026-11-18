// Simulated Finalmouse receiver / mouse speaking Xpanel's protocol (see ../finalmouse.ts).
// Defaults to the UltralightX receiver (361d:0100). Used by the tests and demo mode.
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake finalmouse: unexpected ' + what)
}

export interface FakeFinalmouseOptions {
  productId?: number
  productName?: string
  mouseFw?: string
  /** mouse switched off: only the receiver answers */
  asleep?: boolean
  /** device ignores set commands */
  stubborn?: boolean
}

export class FakeFinalmouse {
  opened = false
  vendorId = 0x361d
  productId: number
  productName: string
  collections: HIDCollectionInfo[]
  /** [report id, 63 bytes] of everything the driver sent */
  sent: [number, number[]][] = []
  dpi = 1600
  polling = 1000
  msync = 0
  /** ULX: mm; SLX: PAW LOD code */
  lod: number
  bhop = 0
  bhopTimeout = 5
  soc = 87
  charging = 0
  mouseFw: string
  asleep: boolean
  stubborn: boolean
  private listeners: ((e: HIDInputReportEvent) => void)[] = []

  constructor(o: FakeFinalmouseOptions = {}) {
    this.productId = o.productId ?? 0x0100
    this.productName = o.productName ?? (this.slx ? 'Starlight X' : 'ULX Receiver')
    this.mouseFw = o.mouseFw ?? (this.slx ? '1.1.1' : '8.0.3')
    this.asleep = o.asleep ?? false
    this.stubborn = o.stubborn ?? false
    this.lod = this.slx ? 2 : 1
    this.collections = (this.slx || this.productId === 0x0102
      ? [{ usagePage: 0xff00, usage: 1, inputReports: [{ reportId: this.slx ? 2 : 3 }], outputReports: [{ reportId: this.slx ? 1 : 2 }], featureReports: [] }]
      : [{ usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 5 }], outputReports: [{ reportId: 2 }, { reportId: 4 }], featureReports: [] }]) as unknown as HIDCollectionInfo[]
  }

  get slx() {
    return this.productId >= 0x0300 && this.productId < 0x0400
  }
  get dongle() {
    return this.productId === 0x0100 || this.productId === 0x0300 || this.productId === 0x0301
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners.push(fn) }
  removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) { this.listeners = this.listeners.filter((f) => f !== fn) }

  private reply(cmd: number, payload: number[]) {
    const d = new Uint8Array(63)
    d[0] = 2 + payload.length
    d[1] = cmd
    d[2] = payload.length
    d.set(payload, 3)
    const view = new DataView(d.buffer)
    const reportId = this.slx ? 2 : 5
    queueMicrotask(() => this.listeners.forEach((f) => f({ reportId, data: view } as unknown as HIDInputReportEvent)))
  }

  private str(s: string) {
    return [...s].map((c) => c.charCodeAt(0)).concat(0)
  }

  async sendReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed')
    const d = [...new Uint8Array(data as ArrayBuffer)]
    check(d.length === 63, 'length ' + d.length)
    check((d[1] & 0x80) !== 0 && d[0] === 2 + d[2], 'framing')
    const cmd = d[1] & 0x7f
    const p = d.slice(3, 3 + d[2])
    this.sent.push([id, d])
    if (this.slx) check(id === 1, 'report id ' + id)
    else check(id === (cmd === 0x0a ? 2 : 4), 'report id ' + id)
    const le = (v: number) => [v & 0xff, v >> 8]
    const mouse = !this.dongle || !this.asleep
    switch (cmd) {
      case 0x60:
        this.reply(0x24, [mouse ? 1 : 0])
        if (this.dongle) this.reply(0x0b, this.str('8.0.3'))
        if (!mouse) return
        this.reply(this.slx ? 0x10 : 0x03, le(this.dpi))
        this.reply(this.slx ? 0x11 : 0x04, le(this.polling))
        this.reply(0x12, [this.msync])
        if (this.slx) this.reply(0x19, [this.lod])
        else this.reply(0x15, [this.lod])
        this.reply(0x17, [this.bhop])
        this.reply(0x18, [this.bhopTimeout])
        this.reply(0x26, [this.soc, ...le(3900)])
        this.reply(0x25, [this.charging])
        return
      case 0x0c:
        if (mouse) this.reply(0x0c, this.str(this.mouseFw))
        return
      case 0x0a:
        this.reply(0x0a, this.str('8.0.3'))
        return
    }
    if (!mouse || this.stubborn) return
    switch (cmd) {
      case 0x10: this.dpi = p[0] | (p[1] << 8); break
      case 0x11: this.polling = p[0] | (p[1] << 8); break
      case 0x12: this.msync = p[0]; break
      case 0x15: this.lod = this.slx ? p[0] + 1 : p[0]; break // SLX receiver: 1 / 2 mm -> PAW codes 2 / 3
      case 0x19: check(this.slx, 'PAW LOD on ULX'); this.lod = p[0]; break
      case 0x17: this.bhop = p[0]; break
      case 0x18: this.bhopTimeout = p[0]; break
      default: check(false, 'command ' + cmd)
    }
  }
}
