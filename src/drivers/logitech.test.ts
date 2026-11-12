import { describe, expect, it } from 'vitest'
import { ALLOWED, crcCcitt, imageFor, LogitechDriver, logitechFactory, parseDpiList, snapDpi, voltageToPercent } from './logitech'
import { FakeLogitech, type FakeLogitechOptions } from './fakes/fake-logitech'
import type { Setting, Value } from './types'

async function open(o: FakeLogitechOptions = {}) {
  const fake = new FakeLogitech(o)
  await fake.open()
  const drv = new LogitechDriver(fake.asHid(), { timeout: 30 })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!
type Choice = Extract<Value, { kind: 'choice' }>
type Dpi = Extract<Value, { kind: 'dpi' }>

/** decode what was sent into (featureId, func) using the fake's feature table */
function calls(fake: FakeLogitech): [number, number][] {
  return fake.sent.map((f) => [fake.features[f[2]] ?? -1, f[3] >> 4])
}

describe('logitech helpers', () => {
  it('parses DPI ranges and lists', () => {
    expect(parseDpiList([0, 0x00, 0x64, 0xe0, 0x32, 0x7d, 0x00, 0, 0])).toEqual({ min: 100, max: 32000, step: 50, list: [] })
    const l = parseDpiList([0, 0x01, 0x90, 0x03, 0x20, 0x06, 0x40, 0, 0])
    expect(l.list).toEqual([400, 800, 1600])
    expect(snapDpi(l, 1000)).toBe(800)
    expect(snapDpi({ min: 100, max: 32000, step: 50, list: [] }, 1234)).toBe(1250)
    expect(snapDpi({ min: 100, max: 32000, step: 50, list: [] }, 99999)).toBe(32000)
  })

  it('crc and voltage curve', () => {
    expect(crcCcitt([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39], 9)).toBe(0x29b1) // CCITT-FALSE check value
    expect(voltageToPercent(4200)).toBe(100)
    expect(voltageToPercent(3811)).toBe(50)
    expect(voltageToPercent(3400)).toBe(0)
  })

  it('maps names to Logitech-hosted images', () => {
    expect(imageFor('PRO X SUPERLIGHT 2')).toMatch(/^https:\/\/resource\.logitechg\.com\/.*superlight-2-mice-top/)
    expect(imageFor('G502 X PLUS')).toMatch(/g502-x-plus-top/)
    expect(imageFor('Some Other Mouse')).toBeUndefined()
  })

  it('allowlist excludes DFU, reset and profile writes', () => {
    for (const f of [0x00c0, 0x00c2, 0x00d0, 0x1802, 0x1814]) expect(ALLOWED.has(f)).toBe(false)
    const ob = ALLOWED.get(0x8100)!
    for (const fn of [1, 3, 6, 7, 8, 0xc]) expect(ob.has(fn)).toBe(false)
  })
})

describe('logitech driver (receiver)', () => {
  it('finds the mouse behind the receiver and reads it', async () => {
    const { drv } = await open({ slot: 2 })
    const s = await drv.read()
    expect(drv.index).toBe(2)
    expect(drv.verified).toBe(false)
    expect(drv.model()).toBe('PRO X SUPERLIGHT 2')
    expect(drv.image()).toMatch(/resource\.logitechg\.com/)
    expect(find(s, 'model').value).toEqual({ kind: 'text', text: 'PRO X SUPERLIGHT 2' })
    expect(find(s, 'connection').value).toEqual({ kind: 'text', text: 'LIGHTSPEED receiver (slot 2)' })
    expect(find(s, 'fw').value).toEqual({ kind: 'text', text: 'RQR 01.02.B000A' })
    expect(find(s, 'battery').value).toEqual({ kind: 'text', text: '76% (charging)' })
    expect(find(s, 'dpi').value).toEqual({ kind: 'dpi', stages: [800], active: 0, min: 100, max: 32000, step: 50 })
    const poll = find(s, 'polling').value as Choice
    expect(poll.current).toBe(3)
    expect(poll.options.map((o) => o[0])).toEqual(['125 Hz', '250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'])
    expect(find(s, 'onboard_profile').value).toEqual({ kind: 'text', text: 'On — Profile 1' })
    expect(find(s, 'dpi_onboard').value).toEqual({ kind: 'text', text: '400 / [800] / 1600 / 3200 / 6400' })
    expect(find(s, 'protocol').value).toMatchObject({ text: 'HID++ 4.2 · 9 features' })
  })

  it('only sends allowlisted feature functions and never looks up blocked features', async () => {
    const { fake, drv } = await open()
    await drv.read()
    for (const [fid, fn] of calls(fake)) {
      if (fid === -1) continue // pings/lookups to empty receiver slots
      expect(ALLOWED.get(fid)?.has(fn), `${fid.toString(16)}:${fn}`).toBe(true)
    }
    for (const id of fake.lookups) expect([0x00c0, 0x00c2, 0x00d0, 0x1802]).not.toContain(id)
    // nothing ever addressed to the receiver itself
    expect(fake.sent.some((f) => f[1] === 0xff)).toBe(false)
  })

  it('sets DPI via 0x2201, snapped to the sensor step', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    const d = find(s, 'dpi')
    await drv.write({ ...d, value: { ...(d.value as Dpi), stages: [1234] } })
    expect(fake.dpi).toBe(1250)
  })

  it('sets 8K polling via 0x8061 and rejects unsupported values', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    const p = find(s, 'polling')
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 6 } })
    expect(fake.rateIndex).toBe(6)
    await expect(drv.write({ ...p, value: { ...(p.value as Choice), current: 9 } })).rejects.toThrow()
  })

  it('refuses read-only settings', async () => {
    const { drv } = await open()
    const s = await drv.read()
    await expect(drv.write(find(s, 'onboard_profile'))).rejects.toThrow(/can't be changed/)
  })

  it('reports a switched-off mouse instead of hanging', async () => {
    const { fake, drv } = await open()
    fake.off = true
    await expect(drv.read()).rejects.toThrow(/no mouse answered/)
  })

  it('shows host mode without reading profile memory', async () => {
    const { fake, drv } = await open({ mode: 2 })
    const s = await drv.read()
    expect(find(s, 'onboard_profile').value).toEqual({ kind: 'text', text: 'Off (host mode)' })
    expect(s.find((x) => x.key === 'dpi_onboard')).toBeUndefined()
    expect(calls(fake).some(([f, fn]) => f === 0x8100 && fn === 5)).toBe(false)
  })

  it('skips onboard stages when the sector CRC is bad', async () => {
    const { fake, drv } = await open()
    fake.sector[10] ^= 0xff
    const s = await drv.read()
    expect(s.find((x) => x.key === 'dpi_onboard')).toBeUndefined()
  })
})

describe('logitech driver (wired / variants)', () => {
  it('talks to index 0xFF on a cable with 0x8060 and voltage battery', async () => {
    const { fake, drv } = await open({ wired: true, oldRate: true, battery: 0x1001 })
    const s = await drv.read()
    expect(drv.index).toBe(0xff)
    expect(find(s, 'connection').value).toMatchObject({ text: 'USB cable' })
    expect(find(s, 'battery').value).toMatchObject({ text: '50% (3811 mV, charging)' })
    const p = find(s, 'polling')
    expect((p.value as Choice).options).toEqual([['1000 Hz', 1], ['500 Hz', 2], ['250 Hz', 4], ['125 Hz', 8]])
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 8 } })
    expect(fake.rateMs).toBe(8)
  })

  it('reads 0x1000 battery', async () => {
    const { drv } = await open({ battery: 0x1000 })
    const s = await drv.read()
    expect(find(s, 'battery').value).toMatchObject({ text: '64%' })
  })
})

describe('logitech factory', () => {
  it('matches receivers and wired G mice with the HID++ long report', () => {
    const f = new FakeLogitech()
    expect(logitechFactory.match(f.asHid())).toBe(true)
    expect(logitechFactory.match(new FakeLogitech({ wired: true }).asHid())).toBe(true)
    f.productId = 0xc52b // Unifying receiver: not ours
    expect(logitechFactory.match(f.asHid())).toBe(false)
    const g = new FakeLogitech()
    g.collections = []
    expect(logitechFactory.match(g.asHid())).toBe(false)
  })

  it('creates a driver for a mouse and declines a keyboard', async () => {
    const m = new FakeLogitech({ wired: true })
    expect(await logitechFactory.create(m.asHid())).not.toBeNull()
    const k = new FakeLogitech({ wired: true, type: 0 })
    expect(await logitechFactory.create(k.asHid())).toBeNull()
    expect(k.opened).toBe(false)
  })
})
