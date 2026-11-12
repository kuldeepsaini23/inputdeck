import { describe, expect, it } from 'vitest'
import { buildReport, crc, isAllowed, MODELS, RazerDriver, razerFactory } from './razer'
import { FakeRazer } from './fakes/fake-razer'
import type { Setting } from './types'

const noSleep = () => Promise.resolve()

async function open(pid?: number) {
  const fake = new FakeRazer(pid)
  await fake.open()
  const drv = new RazerDriver(fake.asHid(), { sleep: noSleep })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!
type Choice = Extract<Setting['value'], { kind: 'choice' }>
type Dpi = Extract<Setting['value'], { kind: 'dpi' }>

describe('razer encoding', () => {
  it('builds the OpenRazer example: get firmware, transaction 0x1f', () => {
    const r = buildReport(0x1f, 0x00, 0x81, 0x02)
    expect(r.length).toBe(90)
    expect([...r.slice(0, 8)]).toEqual([0x00, 0x1f, 0, 0, 0, 0x02, 0x00, 0x81])
    expect(r[88]).toBe(0x02 ^ 0x81)
    expect(r[89]).toBe(0)
  })

  it('crc is the XOR of bytes 2..87 (transaction id and status excluded)', () => {
    const r = buildReport(0x3f, 0x04, 0x05, 0x07, [1, 0x03, 0x20, 0x03, 0x20])
    expect(crc(r)).toBe(0x07 ^ 0x04 ^ 0x05 ^ 1 ^ 0x03 ^ 0x20 ^ 0x03 ^ 0x20)
  })

  it('refuses anything not allowlisted, and wrong sizes', () => {
    expect(() => buildReport(0x1f, 0x00, 0x84, 0x02)).toThrow(/blocked/) // device mode
    expect(() => buildReport(0x1f, 0x00, 0x04, 0x02)).toThrow(/blocked/) // set device mode (bootloader)
    expect(() => buildReport(0x1f, 0x0f, 0x02, 0x09)).toThrow(/blocked/) // lighting
    expect(() => buildReport(0x1f, 0x00, 0x81, 0x05)).toThrow(/size/)
    expect(isAllowed(0x07, 0x80)).toBe(true)
  })
})

describe('razer driver', () => {
  it('reads a DeathAdder V3 Pro (receiver)', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    expect(drv.model()).toBe('DeathAdder V3 Pro')
    expect(drv.verified).toBe(false)
    expect(drv.image()).toMatch(/^https:\/\/medias-p1\.phoenix\.razer\.com\/.+\.png$/)
    expect(find(s, 'fw').value).toEqual({ kind: 'text', text: 'v1.4' })
    expect(find(s, 'serial').value).toEqual({ kind: 'text', text: 'PM2318H0000123' })
    expect(find(s, 'battery').value).toEqual({ kind: 'text', text: '75% (charging)' })
    const dpi = find(s, 'dpi').value as Dpi
    expect(dpi.stages).toEqual([400, 800, 1600, 3200])
    expect(dpi.active).toBe(2)
    expect(dpi.max).toBe(30000)
    expect(find(s, 'dpi_count').value).toMatchObject({ current: 4 })
    const poll = find(s, 'polling').value as Choice
    expect(poll.current).toBe(1000)
    expect(poll.options.map((o) => o[1])).toEqual([125, 500, 1000])
    expect(find(s, 'sleep').value).toMatchObject({ current: 300 })
    expect(find(s, 'low_battery').value).toMatchObject({ current: 0x26 })
    // every packet used this model's transaction id
    expect(new Set(fake.sent.map((d) => d[1]))).toEqual(new Set([0x1f]))
  })

  it('accepts replies with a leading report id byte, and retries timeouts', async () => {
    const { drv, fake } = await open()
    fake.prefixId = true
    fake.timeouts = 2
    const s = await drv.read()
    expect(find(s, 'fw').value).toEqual({ kind: 'text', text: 'v1.4' })
    expect(fake.sent.filter((d) => d[6] === 0 && d[7] === 0x81).length).toBe(3)
  })

  it('writes DPI stages in OpenRazer layout and sets the active DPI', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const d = find(s, 'dpi')
    await drv.write({ ...d, value: { ...(d.value as Dpi), stages: [400, 800, 1600, 6400], active: 3 } })
    expect(fake.stages).toEqual([400, 800, 1600, 6400])
    expect(fake.activeStage).toBe(4)
    expect(fake.dpi).toEqual([6400, 6400])
  })

  it('clamps DPI to the model range', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const d = find(s, 'dpi')
    await drv.write({ ...d, value: { ...(d.value as Dpi), stages: [10, 99999], active: 1 } })
    expect(fake.stages).toEqual([100, 30000])
  })

  it('changes the number of stages', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const c = find(s, 'dpi_count')
    await drv.write({ ...c, value: { ...(c.value as Choice), current: 2 } })
    expect(fake.stages).toEqual([400, 800])
    expect(fake.activeStage).toBe(2)
    await drv.write({ ...c, value: { ...(c.value as Choice), current: 3 } })
    expect(fake.stages).toEqual([400, 800, 1600])
  })

  it('writes classic polling, sleep and low-battery threshold', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const p = find(s, 'polling')
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 500 } })
    expect(fake.poll).toBe(0x02)
    await expect(drv.write({ ...p, value: { ...(p.value as Choice), current: 8000 } })).rejects.toThrow()
    const sl = find(s, 'sleep')
    await drv.write({ ...sl, value: { ...(sl.value as Choice), current: 600 } })
    expect(fake.idle).toBe(600)
    await expect(drv.write({ ...sl, value: { ...(sl.value as Choice), current: 30 } })).rejects.toThrow()
    const lb = find(s, 'low_battery')
    await drv.write({ ...lb, value: { ...(lb.value as Choice), current: 0x0c } })
    expect(fake.lowBattery).toBe(0x0c)
    await expect(drv.write({ ...lb, value: { ...(lb.value as Choice), current: 0x80 } })).rejects.toThrow()
  })

  it('HyperPolling dongle: reads/writes extended polling twice (0x1f then 0xff)', async () => {
    const { drv, fake } = await open(0x00b3)
    const s = await drv.read()
    const p = find(s, 'polling').value as Choice
    expect(p.current).toBe(4000)
    expect(p.options.map((o) => o[1])).toEqual([125, 250, 500, 1000, 2000, 4000])
    await drv.write({ ...find(s, 'polling'), value: { ...p, current: 1000 } })
    expect(fake.poll2Writes).toEqual([[0x1f, 0, 0x08], [0xff, 1, 0x08]])
    expect(drv.image()).toBeUndefined()
  })

  it('DeathAdder V4 Pro offers 8000 Hz', async () => {
    const { drv } = await open(0x00bf)
    const p = find(await drv.read(), 'polling').value as Choice
    expect(p.options.at(-1)![1]).toBe(8000)
  })

  it('wired Cobra uses transaction 0xff and has no battery settings', async () => {
    const { drv, fake } = await open(0x00a3)
    const s = await drv.read()
    expect(new Set(fake.sent.map((d) => d[1]))).toEqual(new Set([0xff]))
    expect(s.find((x) => x.key === 'battery')).toBeUndefined()
    expect(s.find((x) => x.key === 'sleep')).toBeUndefined()
    expect((find(s, 'dpi').value as Dpi).max).toBe(8500)
  })

  it('Basilisk V3 uses 0xff only for DPI stages', async () => {
    const { drv, fake } = await open(0x0099)
    await drv.read()
    for (const d of fake.sent) expect(d[1]).toBe(d[6] === 0x04 && (d[7] & 0x7f) === 0x06 ? 0xff : 0x1f)
  })

  it('falls back to single DPI when stages are not supported', async () => {
    const { drv, fake } = await open()
    fake.unsupported.add('4:134')
    const s = await drv.read()
    expect((find(s, 'dpi').value as Dpi).stages).toEqual([1600])
    expect(s.find((x) => x.key === 'dpi_count')).toBeUndefined()
    const d = find(s, 'dpi')
    await drv.write({ ...d, value: { ...(d.value as Dpi), stages: [2400] } })
    expect(fake.dpi).toEqual([2400, 2400])
    expect(fake.sent.some((x) => x[6] === 0x04 && x[7] === 0x06)).toBe(false)
  })

  it('only ever sends allowlisted commands', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    for (const st of s) await drv.write(st).catch(() => undefined)
    for (const d of fake.sent) expect(isAllowed(d[6], d[7])).toBe(true)
  })
})

describe('razer factory', () => {
  it('matches only claimed PIDs on the control interface', () => {
    const f = new FakeRazer()
    expect(razerFactory.match(f.asHid())).toBe(true)
    const other = new FakeRazer(0x0084) // DeathAdder V2: not in our table
    expect(razerFactory.match(other.asHid())).toBe(false)
    const noCtl = new FakeRazer()
    noCtl.collections = [{ usagePage: 1, usage: 2, inputReports: [], outputReports: [], featureReports: [] }] as unknown as HIDCollectionInfo[]
    expect(razerFactory.match(noCtl.asHid())).toBe(false)
    expect(razerFactory.filters.length).toBe(Object.keys(MODELS).length)
    expect(razerFactory.filters.every((x) => x.vendorId === 0x1532)).toBe(true)
  })

  it('creates a driver', async () => {
    const f = new FakeRazer()
    const d = await razerFactory.create(f.asHid())
    expect(d?.brand()).toBe('RAZER')
    expect(f.opened).toBe(true)
  })
})
