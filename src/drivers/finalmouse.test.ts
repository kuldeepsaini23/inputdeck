import { describe, expect, it } from 'vitest'
import { allowed, batteryPct, CMD, FinalmouseDriver, finalmouseFactory, packet, pawLodMm } from './finalmouse'
import { FakeFinalmouse, type FakeFinalmouseOptions } from './fakes/fake-finalmouse'
import type { Setting } from './types'

async function open(o?: FakeFinalmouseOptions) {
  const fake = new FakeFinalmouse(o)
  await fake.open()
  const drv = new FinalmouseDriver(fake.asHid(), { timeout: 200, settle: 5 })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!
const textOf = (list: Setting[], k: string) => { const v = list.find((s) => s.key === k)?.value; return v?.kind === 'text' ? v.text : undefined }

describe('finalmouse protocol', () => {
  it('frames packets like Xpanel ([2+n, 0x80|cmd, n, payload])', () => {
    const p = packet(CMD.DPI, [0x40, 0x06])
    expect(p.length).toBe(63)
    expect([...p.slice(0, 6)]).toEqual([4, 0x90, 2, 0x40, 0x06, 0])
  })

  it('allows only reads and known settings, on the right report id', () => {
    expect(allowed('ulx_dongle', 4, packet(CMD.ALL))).toBe(true)
    expect(allowed('slx_dongle', 1, packet(CMD.ALL))).toBe(true)
    expect(allowed('slx_dongle', 4, packet(CMD.ALL))).toBe(false)
    expect(allowed('ulx_dongle', 2, packet(CMD.DONGLE_USB_FW))).toBe(true)
    expect(allowed('ulx_dongle', 4, packet(CMD.DPI, [0x40, 0x06]))).toBe(true)
    expect(allowed('ulx_dongle', 4, packet(CMD.DPI, [0x41, 0x06]))).toBe(false) // not a multiple of 100
    expect(allowed('ulx_dongle', 4, packet(CMD.POLLING, [0x40, 0x1f]))).toBe(true) // 8000
    expect(allowed('ulx_dongle', 4, packet(CMD.POLLING, [125, 0]))).toBe(false)
    expect(allowed('ulx_dongle', 4, packet(CMD.PAW_LOD, [2]))).toBe(false)
    expect(allowed('slx_mouse', 1, packet(CMD.LOD, [1]))).toBe(false)
    expect(allowed('slx_mouse', 1, packet(CMD.PAW_LOD, [15]))).toBe(true)
    // reset, bootloaders, pairing, FOTA, OTP, calibration, profiles, erase: never
    for (const cmd of [1, 2, 6, 8, 0x1b, 0x1c, 0x28, 0x29, 0x2a, 0x30, 0x31, 0x32, 0x39, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x41, 0x70]) {
      for (const k of ['ulx_dongle', 'slx_dongle', 'slx_mouse'] as const)
        for (const rid of [1, 2, 4]) {
          expect(allowed(k, rid, packet(cmd))).toBe(false)
          expect(allowed(k, rid, packet(cmd, [0]))).toBe(false)
        }
    }
    // the wired UltralightX gets nothing at all
    expect(allowed('ulx_wired', 2, packet(CMD.ALL))).toBe(false)
    // junk after the payload
    const p = packet(CMD.ALL)
    p[10] = 1
    expect(allowed('ulx_dongle', 4, p)).toBe(false)
  })

  it('decodes PAW LOD codes and the battery curve', () => {
    expect(pawLodMm(2)).toBe(1)
    expect(pawLodMm(3)).toBe(2)
    expect(pawLodMm(15)).toBe(1.5)
    expect(pawLodMm(0)).toBe(null)
    expect(batteryPct(4400)).toBe(100)
    expect(batteryPct(2900)).toBe(0)
    expect(batteryPct(3880)).toBe(50)
  })
})

describe('finalmouse factory', () => {
  it('matches the receivers and mice on their vendor interface', () => {
    for (const pid of [0x0100, 0x0102, 0x0300, 0x0301, 0x0310, 0x0311]) expect(finalmouseFactory.match(new FakeFinalmouse({ productId: pid }).asHid())).toBe(true)
    const other = new FakeFinalmouse({ productId: 0x0310 })
    other.collections = [{ usagePage: 1, usage: 2, inputReports: [], outputReports: [], featureReports: [] }] as unknown as HIDCollectionInfo[]
    expect(finalmouseFactory.match(other.asHid())).toBe(false)
    expect(finalmouseFactory.match(new FakeFinalmouse({ productId: 0x0200 }).asHid())).toBe(false) // Centerpiece Pro keyboard
    expect(finalmouseFactory.filters.every((f) => f.vendorId === 0x361d)).toBe(true)
  })
})

describe('finalmouse UltralightX receiver', () => {
  it('reads everything from one "send all"', async () => {
    const { drv, fake } = await open()
    const r = await drv.read()
    expect(drv.verified).toBe(false)
    expect(drv.model()).toBe('UltralightX')
    expect(textOf(r, 'fw')).toBe('8.0.3')
    expect(textOf(r, 'dongle_fw')).toBe('8.0.3')
    expect(textOf(r, 'battery')).toBe('87%')
    expect(find(r, 'dpi').value).toMatchObject({ kind: 'dpi', stages: [1600], active: 0, min: 400, max: 12800, step: 100 })
    expect(find(r, 'polling').value).toMatchObject({ current: 1000 })
    expect((find(r, 'polling').value as { options: [string, number][] }).options.map((o) => o[1])).toEqual([500, 1000, 2000, 4000, 8000])
    expect(find(r, 'lod').value).toMatchObject({ current: 10, options: [['1.0 mm', 10], ['2.0 mm', 20]] })
    expect(find(r, 'motion_sync').value).toEqual({ kind: 'toggle', on: false })
    expect(find(r, 'bhop_window').value).toMatchObject({ current: 500 })
    // only reads went out
    expect(fake.sent.map(([id, d]) => [id, d[1] & 0x7f])).toEqual([[4, 0x60], [4, 0x0c], [2, 0x0a]])
  })

  it('hides 8000 Hz on older firmware and Bhop below 8.0.3', async () => {
    const { drv } = await open({ mouseFw: '7.2.0' })
    const r = await drv.read()
    expect((find(r, 'polling').value as { options: [string, number][] }).options.map((o) => o[1])).toEqual([500, 1000, 2000, 4000])
    expect(r.find((s) => s.key === 'bhop')).toBeUndefined()
  })

  it('writes each setting and reads it back', async () => {
    const { drv, fake } = await open()
    const r = await drv.read()
    await drv.write({ ...find(r, 'dpi'), value: { ...(find(r, 'dpi').value as never as object), stages: [3200] } as never })
    expect(fake.dpi).toBe(3200)
    await drv.write({ ...find(r, 'polling'), value: { ...(find(r, 'polling').value as object), current: 4000 } as never })
    expect(fake.polling).toBe(4000)
    await drv.write({ ...find(r, 'motion_sync'), value: { kind: 'toggle', on: true } })
    expect(fake.msync).toBe(1)
    await drv.write({ ...find(r, 'lod'), value: { ...(find(r, 'lod').value as object), current: 20 } as never })
    expect(fake.lod).toBe(2)
    await drv.write({ ...find(r, 'bhop'), value: { ...(find(r, 'bhop').value as object), current: 3 } as never })
    expect(fake.bhop).toBe(3)
    await drv.write({ ...find(r, 'bhop_window'), value: { ...(find(r, 'bhop_window').value as object), current: 1500 } as never })
    expect(fake.bhopTimeout).toBe(15)
    const sets = fake.sent.map(([id, d]) => [id, d[1] & 0x7f]).filter(([, c]) => c !== 0x60 && c !== 0x0c && c !== 0x0a)
    expect(sets).toEqual([[4, 0x10], [4, 0x11], [4, 0x12], [4, 0x15], [4, 0x17], [4, 0x18]])
  })

  it('fails a write the mouse does not keep', async () => {
    const { drv, fake } = await open({ stubborn: true })
    const r = await drv.read()
    await expect(drv.write({ ...find(r, 'motion_sync'), value: { kind: 'toggle', on: true } })).rejects.toThrow(/did not keep/)
    expect(fake.msync).toBe(0)
  })

  it('says when the mouse is asleep', async () => {
    const { drv } = await open({ asleep: true })
    await expect(drv.read()).rejects.toThrow(/Waiting for the mouse/)
  })

  it('diagnose only reads', async () => {
    const { drv, fake } = await open()
    const rep = await drv.diagnose()
    expect(rep).toMatch(/361d:0100/)
    expect(rep).toMatch(/in 5: /)
    expect(fake.sent.every(([, d]) => [0x60, 0x0c, 0x0a].includes(d[1] & 0x7f))).toBe(true)
  })
})

describe('finalmouse Starlight X', () => {
  it('reads PAW LOD codes and offers custom LOD on 1.1.0+', async () => {
    const { drv } = await open({ productId: 0x0310 })
    const r = await drv.read()
    expect(drv.model()).toBe('Starlight X')
    expect(textOf(r, 'dongle_fw')).toBeUndefined()
    expect(find(r, 'lod').value).toMatchObject({ current: 10 })
    expect((find(r, 'lod').value as { options: [string, number][] }).options.map((o) => o[1])).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 20])
    // 8000 Hz only on the 8.x firmware, as in Xpanel
    expect((find(r, 'polling').value as { options: [string, number][] }).options.map((o) => o[1])).not.toContain(8000)
  })

  it('wired: presets and custom LOD go out as PAW LOD codes on report 1', async () => {
    const { drv, fake } = await open({ productId: 0x0311 })
    const r = await drv.read()
    await drv.write({ ...find(r, 'lod'), value: { ...(find(r, 'lod').value as object), current: 20 } as never })
    expect(fake.lod).toBe(3)
    await drv.write({ ...find(r, 'lod'), value: { ...(find(r, 'lod').value as object), current: 15 } as never })
    expect(fake.lod).toBe(15)
    expect(fake.sent.filter(([, d]) => (d[1] & 0x7f) === 0x19).map(([id, d]) => [id, d[3]])).toEqual([[1, 3], [1, 15]])
  })

  it('receiver: LOD presets go out in millimetres (cmd 0x15), like Xpanel', async () => {
    const { drv, fake } = await open({ productId: 0x0300 })
    const r = await drv.read()
    await drv.write({ ...find(r, 'lod'), value: { ...(find(r, 'lod').value as object), current: 20 } as never })
    expect(fake.lod).toBe(3)
    expect(fake.sent.some(([id, d]) => id === 1 && (d[1] & 0x7f) === 0x15 && d[3] === 2)).toBe(true)
  })
})

describe('finalmouse wired UltralightX', () => {
  it('is recognised but shows the unsupported note and sends nothing', async () => {
    const { drv, fake } = await open({ productId: 0x0102 })
    const r = await drv.read()
    expect(find(r, 'unsupported').label).toMatch(/Not available/)
    expect(find(r, 'unsupported').hint).toMatch(/receiver/)
    await expect(drv.write({ key: 'dpi', label: 'DPI', group: 'DPI', value: { kind: 'dpi', stages: [800], active: 0, min: 400, max: 12800, step: 100 } })).rejects.toThrow()
    const rep = await drv.diagnose()
    expect(rep).toMatch(/nothing sent/)
    expect(fake.sent).toEqual([])
  })
})
