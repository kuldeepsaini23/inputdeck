import { describe, expect, it } from 'vitest'
import { buildReport, crc, isAllowed, MODELS, poll2SecondTidFor, RazerDriver, razerFactory, tidFor, UnsupportedRazer } from './razer'
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
    expect(p.options.map((o) => o[1])).toEqual([125, 250, 500, 1000, 2000, 4000, 8000])
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

const noControl = (pid?: number) => {
  const f = new FakeRazer(pid)
  f.collections = [{ usagePage: 1, usage: 2, inputReports: [], outputReports: [], featureReports: [] }] as unknown as HIDCollectionInfo[]
  return f
}

describe('razer factory', () => {
  it('known models: only the control interface', () => {
    expect(razerFactory.match(new FakeRazer().asHid())).toBe(true)
    expect(razerFactory.match(new FakeRazer(0x0084).asHid())).toBe(true) // DeathAdder V2
    expect(razerFactory.match(noControl().asHid())).toBe(false)
    const notRazer = new FakeRazer()
    notRazer.vendorId = 0x046d
    expect(razerFactory.match(notRazer.asHid())).toBe(false)
  })

  it('the chooser lists every Razer device (one vendor-wide filter)', () => {
    expect(razerFactory.filters).toEqual([{ vendorId: 0x1532 }])
  })

  it('creates a driver', async () => {
    const f = new FakeRazer()
    const d = await razerFactory.create(f.asHid())
    expect(d).toBeInstanceOf(RazerDriver)
    expect(d?.brand()).toBe('RAZER')
    expect(f.opened).toBe(true)
  })
})

describe('razer: unknown PIDs', () => {
  const UNKNOWN = 0x0ffe

  it('are recognized (any interface) as "not supported yet", without opening or sending anything', async () => {
    expect(MODELS[UNKNOWN]).toBeUndefined()
    const f = new FakeRazer(UNKNOWN)
    f.productName = 'Razer Viper V9 Pro'
    expect(razerFactory.match(f.asHid())).toBe(true)
    expect(razerFactory.match(noControl(UNKNOWN).asHid())).toBe(true)
    const d = await razerFactory.create(f.asHid())
    expect(d).toBeInstanceOf(UnsupportedRazer)
    expect(d!.verified).toBe(false)
    expect(d!.model()).toBe('Viper V9 Pro')
    expect(d!.id).toBe('1532:0ffe')
    const s = await d!.read()
    expect(s.find((x) => x.key === 'unsupported')).toMatchObject({ group: 'Status', label: "This Razer model isn't supported yet", value: { kind: 'text', text: '1532:0ffe' } })
    await expect(d!.write(s[0])).rejects.toThrow(/isn't supported yet/)
    expect(f.opened).toBe(false)
    expect(f.sent).toEqual([])
  })

  it('names the USB id when the device has no product name', () => {
    const f = new FakeRazer(UNKNOWN)
    f.productName = ''
    expect(new UnsupportedRazer(f.asHid()).model()).toBe('Unknown model (1532:0ffe)')
  })

  it('diagnose() only sends allowlisted get commands and finds the transaction id', async () => {
    const f = new FakeRazer(UNKNOWN)
    const d = new UnsupportedRazer(f.asHid(), { sleep: noSleep })
    const rep = await d.diagnose()
    expect(rep).toMatch(/firmware on 0x1f: v1\.4/)
    expect(rep).toMatch(/collection 0001:0002/)
    for (const p of f.sent) {
      expect(isAllowed(p[6], p[7])).toBe(true)
      expect(p[7] & 0x80).toBe(0x80) // get commands only
    }
  })

  it('diagnose() sends nothing without the 90-byte report', async () => {
    const f = noControl(UNKNOWN)
    const rep = await new UnsupportedRazer(f.asHid(), { sleep: noSleep }).diagnose()
    expect(rep).toMatch(/nothing sent/)
    expect(f.sent).toEqual([])
  })
})

// Expected transaction ids, from OpenRazer's per-attribute switch tables in driver/razermouse_driver.c
// (razer_attr_read_firmware_version, _read_dpi, _write_dpi_stages, _read_poll_rate, _write_poll_rate,
// _read_charge_level, _read/_write_charge_low_threshold, ...). PIDs from driver/razermouse_driver.h.
describe('razer model table', () => {
  const pidsOf = (name: string) => Object.entries(MODELS).filter(([, m]) => m.name === name).map(([p]) => Number(p)).sort((a, b) => a - b)

  it('covers the current lineup, wired + wireless + receivers', () => {
    const want: [string, number[]][] = [
      ['DeathAdder V2', [0x0084]],
      ['DeathAdder V2 Pro', [0x007c, 0x007d]],
      ['DeathAdder V2 Mini', [0x008c]],
      ['DeathAdder V2 X HyperSpeed', [0x009c]],
      ['DeathAdder V3', [0x00b2]],
      ['DeathAdder V3 Pro', [0x00b6, 0x00b7, 0x00c2, 0x00c3]],
      ['DeathAdder V3 HyperSpeed', [0x00c4, 0x00c5]],
      ['DeathAdder V4 Pro', [0x00be, 0x00bf]],
      ['Viper Mini Signature Edition', [0x009e, 0x009f]],
      ['Viper V2 Pro', [0x00a5, 0x00a6]],
      ['Viper V3 Pro', [0x00c0, 0x00c1]],
      ['Viper V3 HyperSpeed', [0x00b8]],
      ['Viper V4 Pro', [0x00e5, 0x00e6]],
      ['Viper 8K Hz', [0x0091]],
      ['Basilisk V3', [0x0099]],
      ['Basilisk V3 Pro', [0x00aa, 0x00ab]],
      ['Basilisk V3 X HyperSpeed', [0x00b9]],
      ['Basilisk V3 35K', [0x00cb]],
      ['Basilisk V3 Pro 35K', [0x00cc, 0x00cd]],
      ['Cobra', [0x00a3]],
      ['Cobra Pro', [0x00af, 0x00b0]],
      ['Cobra HyperSpeed', [0x00da, 0x00db]],
      ['Orochi V2', [0x0094]],
      ['Naga V2 Pro', [0x00a7, 0x00a8]],
      ['Naga V2 HyperSpeed', [0x00b4]],
      ['Naga Pro', [0x008f, 0x0090]],
      ['Naga X', [0x0096]],
      ['HyperPolling Wireless Dongle', [0x00b3]],
    ]
    for (const [name, pids] of want) expect(pidsOf(name), name).toEqual(pids)
  })

  it('uses the right transaction id per model and command', () => {
    const cases: [pid: number, cmd: Parameters<typeof tidFor>[1], tid: number][] = [
      // 0x3f family (DeathAdder V2 era)
      [0x0084, 'getDpi', 0x3f], [0x0084, 'setPoll', 0x3f], [0x0084, 'getFirmware', 0x3f],
      [0x007d, 'getBattery', 0x3f], [0x007d, 'getStages', 0xff], [0x007d, 'setIdle', 0xff], [0x007d, 'setLowBattery', 0xff],
      [0x008c, 'setDpi', 0x3f], [0x008c, 'setStages', 0xff],
      // 0xff family
      [0x00a3, 'getDpi', 0xff], [0x0078, 'setStages', 0xff], [0x007b, 'getBattery', 0xff], [0x0083, 'getDpi', 0xff],
      // 0x1f family
      [0x00b7, 'getDpi', 0x1f], [0x00b7, 'setLowBattery', 0x1f], [0x00c1, 'setPoll2', 0x1f], [0x00e6, 'getStages', 0x1f],
      [0x00a6, 'getLowBattery', 0xff], [0x00a6, 'setStages', 0x1f], [0x00ab, 'setLowBattery', 0xff], [0x00b0, 'getLowBattery', 0xff],
      [0x009c, 'getIdle', 0x1f], [0x009c, 'setLowBattery', 0xff], [0x00b9, 'getLowBattery', 0x1f], [0x00a8, 'setLowBattery', 0x1f],
      [0x0099, 'getStages', 0xff], [0x0099, 'getDpi', 0x1f], [0x00cb, 'getStages', 0x1f],
      [0x0094, 'getIdle', 0xff], [0x0094, 'getDpi', 0x1f], [0x00e0, 'setLowBattery', 0xff],
      // split get / set, and odd ones
      [0x00b4, 'getLowBattery', 0x1f], [0x00b4, 'setLowBattery', 0xff],
      [0x0088, 'getPoll', 0xff], [0x0088, 'setPoll', 0x1f], [0x0088, 'getIdle', 0xff],
      [0x00da, 'setLowBattery', 0xff], [0x00db, 'setLowBattery', 0x1f],
      [0x0096, 'getSerial', 0x08], [0x0096, 'getFirmware', 0x1f], [0x0096, 'getStages', 0xff],
      [0x006c, 'getFirmware', 0x1f], [0x006c, 'getSerial', 0xff], [0x006c, 'getPoll', 0xff], [0x006c, 'setDpi', 0x1f],
      [0x0091, 'getDpi', 0xff], [0x0091, 'getPoll2', 0x1f], [0x0091, 'setPoll2', 0x1f],
      [0x006f, 'getDpi', 0x3f], [0x006f, 'getBattery', 0x1f], [0x006f, 'getStages', 0xff],
    ]
    for (const [pid, cmd, tid] of cases) expect(tidFor(pid, cmd), `${pid.toString(16)} ${cmd}`).toBe(tid)
    expect(tidFor(0x0ffe, 'getDpi')).toBeUndefined()
  })

  it('extended (HyperPolling) polling: who uses it, and the second packet transaction id', () => {
    const hyper = Object.entries(MODELS).filter(([, m]) => m.poll === 'hyper').map(([p]) => Number(p)).sort((a, b) => a - b)
    expect(hyper).toEqual([0x0091, 0x009e, 0x009f, 0x00b2, 0x00b3, 0x00be, 0x00bf, 0x00c1, 0x00c3, 0x00e5, 0x00e6])
    for (const pid of [0x0091, 0x00b3, 0x00c3]) expect(poll2SecondTidFor(pid)).toBe(0xff)
    for (const pid of [0x009e, 0x009f, 0x00b2, 0x00be, 0x00bf, 0x00c1, 0x00e5, 0x00e6]) expect(poll2SecondTidFor(pid)).toBe(0x1f)
    expect(MODELS[0x009e].maxHz).toBe(1000) // Viper Mini SE on the cable
    expect(MODELS[0x009f].maxHz).toBe(8000)
  })

  it('is consistent', () => {
    for (const [pid, m] of Object.entries(MODELS)) {
      const at = `${Number(pid).toString(16)} ${m.name}`
      for (const t of [m.tid, ...Object.values(m.tids ?? {}), ...Object.values(m.cmdTids ?? {})]) expect([0x08, 0x1f, 0x3f, 0xff], at).toContain(t)
      if (m.receiver) expect(m.battery, at).toBe(true)
      if (m.maxHz > 1000) expect(m.poll, at).toBe('hyper')
      if (m.poll2SecondTid !== undefined) expect(m.poll, at).toBe('hyper')
      expect([1, 31, 60, 400], at).toContain(m.waitMs)
      expect(m.maxDpi % 50 === 0 && m.maxDpi >= 2000, at).toBe(true)
    }
  })
})

describe('razer per-model traffic', () => {
  it('Naga V2 HyperSpeed reads the low-battery warning on 0x1f and writes it on 0xff', async () => {
    const { drv, fake } = await open(0x00b4)
    const s = await drv.read()
    expect(fake.sent.find((d) => d[6] === 7 && d[7] === 0x81)![1]).toBe(0x1f)
    expect(s.find((x) => x.key === 'battery')?.value).toEqual({ kind: 'text', text: '75%' }) // no charging status
    const lb = find(s, 'low_battery')
    await drv.write({ ...lb, value: { ...(lb.value as Choice), current: 0x0c } })
    expect(fake.sent.at(-1)![1]).toBe(0xff)
  })

  it('DeathAdder V2 uses 0x3f and never asks for DPI stages', async () => {
    const { drv, fake } = await open(0x0084)
    const s = await drv.read()
    expect(new Set(fake.sent.map((d) => d[1]))).toEqual(new Set([0x3f]))
    expect(fake.sent.some((d) => d[6] === 4 && d[7] === 0x86)).toBe(false)
    expect((find(s, 'dpi').value as Dpi).stages).toEqual([1600])
    expect((find(s, 'dpi').value as Dpi).max).toBe(20000)
  })

  it('Viper 8K: 0xff except extended polling (0x1f, then 0xff for the second packet)', async () => {
    const { drv, fake } = await open(0x0091)
    const s = await drv.read()
    for (const d of fake.sent) expect(d[1]).toBe(d[6] === 0 && (d[7] & 0x7f) === 0x40 ? 0x1f : 0xff)
    const p = find(s, 'polling')
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 8000 } })
    expect(fake.poll2Writes).toEqual([[0x1f, 0, 0x01], [0xff, 1, 0x01]])
  })

  it('DeathAdder V3 Pro on receiver PID 00c3 uses extended polling (second packet 0xff)', async () => {
    const { drv, fake } = await open(0x00c3)
    const s = await drv.read()
    const p = find(s, 'polling')
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 2000 } })
    expect(fake.poll2Writes).toEqual([[0x1f, 0, 0x04], [0xff, 1, 0x04]])
  })

  it('Naga X reads its serial number on transaction 0x08', async () => {
    const { drv, fake } = await open(0x0096)
    await drv.read()
    expect(fake.sent.find((d) => d[6] === 0 && d[7] === 0x82)![1]).toBe(0x08)
  })
})
