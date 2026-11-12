// Simulated Razer mouse on the 90-byte feature-report protocol. Used by the tests.
// Defaults to a DeathAdder V3 Pro on its receiver (1532:00b7); pass another PID to change model.
import { crc, isAllowed, REPORT_LEN } from '../razer'

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error('fake razer: unexpected ' + what)
}

export class FakeRazer {
  opened = false
  vendorId = 0x1532
  productId: number
  productName = 'Razer mouse'
  collections = [
    {
      usagePage: 0x01,
      usage: 0x02,
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 90 }] }],
    },
  ] as unknown as HIDCollectionInfo[]
  /** every request the driver sent (90 bytes) */
  sent: number[][] = []
  /** prepend a zero report id byte to replies (as some platforms do) */
  prefixId = false
  /** next N replies come back as "busy-timeout" status 0x04 */
  timeouts = 0
  /** commands ("cls:id") that answer "not supported" */
  unsupported = new Set<string>()

  fw = [1, 4]
  serial = 'PM2318H0000123'
  battery = 0xc0 // 75%
  charging = 1
  poll = 0x01 // classic: 1000 Hz
  poll2 = 0x02 // hyper: 4000 Hz
  dpi = [1600, 1600]
  stages = [400, 800, 1600, 3200]
  activeStage = 3 // 1-based
  idle = 300
  lowBattery = 0x26
  /** every (arg0, code) pair received on set polling 2 */
  poll2Writes: [number, number, number][] = []

  private reply: Uint8Array | null = null

  constructor(pid = 0x00b7) {
    this.productId = pid
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice
  }

  async open() { this.opened = true }
  async close() { this.opened = false }
  addEventListener() {}
  removeEventListener() {}

  async sendReport() { check(false, 'output report') }

  async sendFeatureReport(id: number, data: BufferSource) {
    check(this.opened, 'send while closed')
    check(id === 0, 'report id ' + id)
    const d = [...new Uint8Array(data as ArrayBuffer)]
    check(d.length === REPORT_LEN, 'length ' + d.length)
    check(d[88] === crc(d), 'crc')
    check(d[0] === 0 && d[2] === 0 && d[3] === 0 && d[4] === 0 && d[89] === 0, 'header')
    const cls = d[6]
    const cmd = d[7]
    check(isAllowed(cls, cmd), `command ${cls.toString(16)}:${cmd.toString(16)}`)
    this.sent.push(d)
    const r = new Uint8Array(REPORT_LEN)
    r.set(d)
    const a = (i: number) => d[8 + i]
    const out = (i: number, v: number) => (r[8 + i] = v & 0xff)
    r[0] = 0x02
    const key = `${cls}:${cmd}`
    if (this.timeouts > 0) {
      this.timeouts--
      r[0] = 0x04
    } else if (this.unsupported.has(key)) {
      r[0] = 0x05
    } else {
      switch (key) {
        case '0:129': out(0, this.fw[0]); out(1, this.fw[1]); break
        case '0:130': for (let i = 0; i < 22; i++) out(i, this.serial.charCodeAt(i) || 0); break
        case '0:133': out(0, this.poll); break
        case '0:5': check([1, 2, 8].includes(a(0)), 'poll code'); this.poll = a(0); break
        case '0:192': out(1, this.poll2); break
        case '0:64': check([0, 1].includes(a(0)), 'poll2 arg'); this.poll2Writes.push([d[1], a(0), a(1)]); this.poll2 = a(1); break
        case '4:133': out(1, this.dpi[0] >> 8); out(2, this.dpi[0]); out(3, this.dpi[1] >> 8); out(4, this.dpi[1]); break
        case '4:5': check(a(0) === 1, 'varstore'); this.dpi = [(a(1) << 8) | a(2), (a(3) << 8) | a(4)]; break
        case '4:134': {
          out(0, a(0)); out(1, this.activeStage); out(2, this.stages.length)
          this.stages.forEach((v, i) => { const o = 3 + 7 * i; out(o, i + 1); out(o + 1, v >> 8); out(o + 2, v); out(o + 3, v >> 8); out(o + 4, v) })
          break
        }
        case '4:6': {
          const n = a(2)
          check(n >= 1 && n <= 5 && a(1) >= 1 && a(1) <= n, 'stages')
          const st: number[] = []
          for (let i = 0; i < n; i++) { const o = 3 + 7 * i; check(a(o) === i, 'stage index'); st.push((a(o + 1) << 8) | a(o + 2)) }
          this.stages = st
          this.activeStage = a(1)
          break
        }
        case '7:128': out(1, this.battery); break
        case '7:132': out(1, this.charging); break
        case '7:131': out(0, this.idle >> 8); out(1, this.idle); break
        case '7:3': { const s = (a(0) << 8) | a(1); check(s >= 60 && s <= 900, 'idle'); this.idle = s; break }
        case '7:129': out(0, this.lowBattery); break
        case '7:1': check(a(0) >= 0x0c && a(0) <= 0x3f, 'threshold'); this.lowBattery = a(0); break
        default: check(false, 'command ' + key)
      }
    }
    r[88] = crc(r)
    this.reply = r
  }

  async receiveFeatureReport(id: number): Promise<DataView> {
    check(id === 0, 'report id ' + id)
    check(this.reply !== null, 'read without request')
    const r = this.reply!
    this.reply = null
    const buf = this.prefixId ? new Uint8Array([0, ...r]) : r
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
}
