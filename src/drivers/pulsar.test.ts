import { describe, expect, it } from 'vitest'
import {
  checksum,
  compxbFactory,
  decodeDpi,
  decodeDpi3955,
  decodeDpi50,
  encodeDpi,
  encodeDpi50,
  frame,
  KEEP,
  MACRO_HELD,
  MACRO_ONCE,
  PulsarDriver,
  writable,
  pulsarFactory,
  resolveVariant,
  stageBytes,
  stageBytes3955,
} from './pulsar'
import { FakePulsar, type FakeCompxbOptions } from './fakes/fake-pulsar'
import type { MacroStep, Setting } from './types'
import { encodeMacro } from '../lib/macros'

const noSleep = () => Promise.resolve()

async function open(o?: FakeCompxbOptions) {
  const fake = new FakePulsar(o)
  await fake.open()
  const drv = new PulsarDriver(fake.asHid(), { sleep: noSleep })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!
type Choice = Extract<Setting['value'], { kind: 'choice' }>
type Dpi = Extract<Setting['value'], { kind: 'dpi' }>

describe('pulsar encoding', () => {
  it('checksum matches the kernel example (battery request 08 04 ... 49)', () => {
    const d = new Uint8Array(16)
    d[0] = 0x04
    expect(checksum(d)).toBe(0x49)
    expect(frame(0x04, 0, [])[15]).toBe(0x49)
  })

  it('decodes the hardware-verified DPI samples', () => {
    expect(decodeDpi(0x27, 0x0)).toBe(400)
    expect(decodeDpi(0x37, 0x2)).toBe(12800)
    expect(decodeDpi(0x77, 0x3)).toBe(32000)
  })

  it('round-trips "pulsar x1" DPI in each of Pulsar\'s ranges', () => {
    for (const dpi of [50, 400, 800, 1600, 10000, 10050, 12800, 25600, 26000, 30000, 30100, 32000]) {
      const [lo, f] = encodeDpi(dpi)
      expect(decodeDpi(lo, f)).toBe(dpi)
    }
    expect(stageBytes(400)).toEqual([0x27, 0x27, 0x00, (0x55 - 0x4e) & 0xff])
    expect(stageBytes(12800).slice(0, 3)).toEqual([0x37, 0x37, 0x22])
    // bit 0 alone doubles (ATK's 3950 Ultra encoding)
    expect(decodeDpi(0x63, 0x1)).toBe(2000)
  })

  it('round-trips 50-step DPI (VGN F2 / 3554 mice), doubling above 30000', () => {
    for (const dpi of [50, 400, 1600, 12800, 26000, 30000, 32000, 50000]) {
      const [lo, f] = encodeDpi50(dpi)
      expect(decodeDpi50(lo, f)).toBe(dpi)
    }
    // 800 DPI = 0f 0f 00 37 (value 15, sealed to 0x55)
    expect(stageBytes(800, 's50')).toEqual([0x0f, 0x0f, 0x00, 0x37])
  })

  it('encodes PAW3955 records like Pulsar\'s app (1600 = 3f 06 3f 06 00 cb)', () => {
    expect(stageBytes3955(1600)).toEqual([0x3f, 0x06, 0x3f, 0x06, 0x00, 0xcb])
    for (const dpi of [50, 1600, 26000, 42000, 50000, 84000]) expect(decodeDpi3955(stageBytes3955(dpi))).toBe(dpi)
  })
})

describe('pulsar driver', () => {
  it('reads the mouse into settings', async () => {
    const { drv } = await open()
    const s = await drv.read()
    expect(drv.brand()).toBe('PULSAR')
    expect(drv.model()).toBe('X2 Crazylight Mini PRX Pacific Gold Edition')
    expect(drv.image()).toBe('https://bbb.pulsar.gg/cMouse/img/devices/mouse/5760.png')
    expect(drv.verified).toBe(true)
    expect(find(s, 'battery').value).toEqual({ kind: 'text', text: '76%' })
    expect(find(s, 'fw').value).toEqual({ kind: 'text', text: 'v3.05' })
    const dpi = find(s, 'dpi').value
    expect(dpi.kind === 'dpi' && dpi.stages).toEqual([400, 800, 1000, 12800])
    expect(dpi.kind === 'dpi' && dpi.active).toBe(1)
    expect(find(s, 'polling').value).toMatchObject({ current: 0x40 })
    const poll = find(s, 'polling').value as Choice
    expect(poll.options.map((o) => o[0])).toContain('8000 Hz')
    expect(find(s, 'lod').value).toMatchObject({ current: 1 })
    expect(find(s, 'motion_sync').value).toEqual({ kind: 'toggle', on: true })
    expect(find(s, 'debounce').value).toMatchObject({ current: 2 })
    expect(find(s, 'sleep').value).toMatchObject({ current: 60 })
    expect(find(s, 'btn1').value).toMatchObject({ current: 0 })
    expect(find(s, 'profile').value).toMatchObject({ current: 1 })
  })

  it('names other Pulsar models from the web app table', async () => {
    const { drv } = await open({ mid: 3 })
    await drv.read()
    expect(drv.model()).toBe('X2 Crazylight Mini')
    expect(resolveVariant(0x3710, 0x5406, 87, 104).model).toBe('X3 LHD Crazylight Medium Desert')
    // "By You" builds borrow the stock model's photo (X2A: Pulsar's store); unreleased mids (silhouette placeholder) get none
    expect(resolveVariant(0x3710, 0x5406, 87, 28).image).toBe('https://bbb.pulsar.gg/cMouse/img/devices/mouse/5701.png')
    expect(resolveVariant(0x3710, 0x5406, 87, 31).image).toBe('https://www.pulsar.gg/cdn/shop/products/X2AgamingMouse_top-234273.png?width=600')
    expect(resolveVariant(0x3710, 0x5406, 87, 108).image).toBeUndefined()
    expect(resolveVariant(0x3710, 0x5406, 87, 250).model).toBe('CrazyLight mouse')
  })

  it('wraps every batch in awake on/off and only sends allowed commands', async () => {
    const { fake, drv } = await open()
    await drv.read()
    expect(fake.sent[0].slice(0, 6)).toEqual([0x03, 0, 0, 0, 0, 1])
    expect(fake.sent.at(-1)!.slice(0, 6)).toEqual([0x03, 0, 0, 0, 0, 0])
    const cmds = new Set(fake.sent.map((d) => d[0]))
    for (const c of cmds) expect([0x01, 0x03, 0x04, 0x08, 0x0e, 0x12, 0x1d]).toContain(c)
  })

  it('writes single settings as (value, 0x55 - value)', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    fake.sent = []
    const lod = find(s, 'lod')
    await drv.write({ ...lod, value: { ...(lod.value as Choice), current: 3 } })
    const w = fake.sent.find((d) => d[0] === 0x07)!
    expect(w.slice(0, 7)).toEqual([0x07, 0, 0, 0x0a, 2, 3, 0x52])
    expect(fake.map[0x0a]).toBe(3)
  })

  it('writes only the DPI stages that changed', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    fake.sent = []
    const dpi = find(s, 'dpi').value as Dpi
    await drv.write({ ...find(s, 'dpi'), value: { ...dpi, stages: [400, 1600, 1000, 12800] } })
    const writes = fake.sent.filter((d) => d[0] === 0x07)
    expect(writes).toHaveLength(1)
    expect(writes[0][3]).toBe(0x10)
    expect(decodeDpi(fake.map[0x10], fake.map[0x12] & 0xf)).toBe(1600)
  })

  it('refuses to remove the last left click', async () => {
    const { drv } = await open()
    const s = await drv.read()
    const b = find(s, 'btn1')
    await expect(drv.write({ ...b, value: { ...(b.value as Choice), current: 6 } })).rejects.toThrow(/Left click/)
  })

  it('reports a switched-off mouse instead of hanging', async () => {
    const { fake, drv } = await open()
    fake.off = true
    await expect(drv.read()).rejects.toThrow(/off or asleep/)
  })

  it('retries a dropped request', async () => {
    const { fake, drv } = await open()
    fake.drop = 2
    await expect(drv.read()).resolves.toBeTruthy()
  })

  it('switches profile', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    const p = find(s, 'profile')
    await drv.write({ ...p, value: { ...(p.value as Choice), current: 3 } })
    expect(fake.profile).toBe(3)
  })

  it('reads and writes Pulsar PAW3955 models at 0x1B00, not the legacy fields', async () => {
    const { fake, drv } = await open({ mid: 133, codec: 's3955', stages: [800, 1600, 3200] })
    const s = await drv.read()
    expect(drv.model()).toBe('ZywOo The Chosen Mouse Gen.3 Mini')
    const dpi = find(s, 'dpi').value as Dpi
    expect(dpi.stages).toEqual([800, 1600, 3200])
    expect(dpi.max).toBe(42000)
    expect(s.some((x) => x.key === 'lod')).toBe(false) // Pulsar's app has no LOD control for the 3955
    fake.sent = []
    await drv.write({ ...find(s, 'dpi'), value: { ...dpi, stages: [800, 2000, 3200] } })
    const w = fake.sent.filter((d) => d[0] === 0x07)
    expect(w).toHaveLength(1)
    expect((w[0][2] << 8) | w[0][3]).toBe(0x1b06)
    expect(decodeDpi3955(fake.map.subarray(0x1b06, 0x1b0c))).toBe(2000)
  })
})

describe('other CompX-B brands', () => {
  it('VXE R1 SE+ wired: names it from ATK HUB, 3395SE DPI stays read-only, unverified', async () => {
    const { drv } = await open({ vendorId: 0x3554, productId: 0xf58f, cid: 2, mid: 32, link: 2 })
    const s = await drv.read()
    expect(drv.verified).toBe(false)
    expect(drv.brand()).toBe('VXE')
    expect(drv.model()).toBe('R1SE+')
    expect(drv.image()).toBe('https://bpcdn.atkgear.com/device/ossAssets/r1/black.webp')
    expect(s.some((x) => x.key === 'dpi')).toBe(false)
    expect(find(s, 'dpi_note')).toBeTruthy()
    expect(s.some((x) => x.key === 'btn1')).toBe(false)
    expect(s.some((x) => x.key === 'battery')).toBe(false) // wired
  })

  it('VXE R1 Pro: 50-step DPI from the legacy fields', async () => {
    const { fake, drv } = await open({ vendorId: 0x3554, productId: 0xf58c, cid: 2, mid: 8, link: 2, codec: 's50', stages: [400, 800, 1600] })
    const s = await drv.read()
    expect(drv.model()).toBe('R1 PRO')
    const dpi = find(s, 'dpi').value as Dpi
    expect(dpi.stages).toEqual([400, 800, 1600])
    fake.sent = []
    await drv.write({ ...find(s, 'dpi'), value: { ...dpi, stages: [400, 800, 3200] } })
    expect(decodeDpi50(fake.map[0x14], fake.map[0x16] & 0xf)).toBe(3200)
  })

  it('VXE R1 SE 1K receiver hides the settings that live in its live row', async () => {
    const { drv } = await open({ vendorId: 0x373b, productId: 0x1085, cid: 2, mid: 32, link: 0, codec: 's50' })
    const s = await drv.read()
    for (const k of ['polling', 'lod', 'lod_code', 'debounce', 'angle_snap']) expect(s.some((x) => x.key === k)).toBe(false)
    expect(find(s, 'battery')).toBeTruthy()
    const p = { key: 'polling', label: '', group: '', value: { kind: 'choice', options: [], current: 1 } } as Setting
    await expect(drv.write(p)).rejects.toThrow(/elsewhere/)
  })

  it('ATK Blazing Sky (3950 Ultra) uses the 10-step encoding', () => {
    const v = resolveVariant(0x373b, 0x11e4, 1, 8)
    expect([v.brand, v.model, v.codec]).toEqual(['ATK', 'F1 Ultimate 2.0', 'x1'])
    expect(v.image).toBe('https://bpcdn.atkgear.com/device/ossAssets/f1/sky-f1-v2-blue.webp')
  })

  it('Scyrox: model, photo and 3955 layout by mid; five stages max', async () => {
    const { drv } = await open({ vendorId: 0x3554, productId: 0xf517, cid: 62, mid: 5, codec: 's3955', stages: [400, 1600] })
    const s = await drv.read()
    expect([drv.brand(), drv.model()]).toEqual(['SCYROX', 'V8S'])
    expect(drv.image()).toBe('https://www.scyrox.net/img/devices/mouse/3E05.png')
    expect((find(s, 'dpi').value as Dpi).stages).toEqual([400, 1600])
    expect((find(s, 'dpi_count').value as Choice).options).toHaveLength(5)
    expect((find(s, 'lod').value as Choice).options.map((o) => o[0])).toContain('0.9 mm')
    expect(resolveVariant(0x3554, 0xf5f7, 62, 1).codec).toBe('s50')
  })

  it('Pulsar X2 V2 generation on 3554 is 50-step and named from hid-pulsar', () => {
    const v = resolveVariant(0x3554, 0xf509, 6, 0x0c)
    expect([v.brand, v.model, v.codec]).toEqual(['PULSAR', 'X2H', 's50'])
  })

  it('Lamzu Atlantis: own polling table and 0.7 / 1 / 2 mm lift-off (0.7 = code 3)', async () => {
    const { fake, drv } = await open({ vendorId: 0x3554, productId: 0xf50f, cid: 1, mid: 1, link: 2, codec: 's50' })
    fake.map[0] = 0x10
    fake.map[1] = 0x45
    fake.map[0x0a] = 3
    fake.map[0x0b] = 0x52
    const s = await drv.read()
    const poll = find(s, 'polling').value as Choice
    expect(poll.options.map((o) => o[0])).toEqual(['125 Hz', '250 Hz', '500 Hz', '1000 Hz', '1000 Hz (keep)'])
    const lod = find(s, 'lod').value as Choice
    expect(lod.options).toEqual([['0.7 mm', 3], ['1 mm', 1], ['2 mm', 2]])
    expect(lod.current).toBe(3)
    expect(drv.brand()).toBe('LAMZU')
  })

  it('Kysona M600: brand from its id, no button writes', async () => {
    const { drv } = await open({ vendorId: 0x3554, productId: 0xf57c, cid: 0, mid: 0, link: 0, codec: 's50' })
    const s = await drv.read()
    expect([drv.brand(), drv.model(), drv.verified]).toEqual(['KYSONA', 'M600', false])
    expect(s.some((x) => x.key === 'btn1')).toBe(false)
  })
})

describe('factories', () => {
  it('pulsar: matches the CrazyLight dongle, not the Sonix-protocol models', () => {
    const f = new FakePulsar()
    expect(pulsarFactory.match(f.asHid())).toBe(true)
    expect(compxbFactory.match(f.asHid())).toBe(false)
    f.productId = 0x5404
    expect(pulsarFactory.match(f.asHid())).toBe(false)
  })

  it('compxb: covers the other brands and never overlaps Pulsar', () => {
    for (const [vendorId, productId] of [[0x3554, 0xf58f], [0x373b, 0x1085], [0x3554, 0xf57c], [0x3554, 0xf5d5], [0x3554, 0xf517], [0x3554, 0xf50f], [0x3554, 0xfb56], [0x373b, 0x11e4]]) {
      const f = new FakePulsar({ vendorId, productId })
      expect(compxbFactory.match(f.asHid())).toBe(true)
      expect(pulsarFactory.match(f.asHid())).toBe(false)
    }
    for (const productId of [0xf507, 0xf508, 0xf509]) expect(pulsarFactory.match(new FakePulsar({ vendorId: 0x3554, productId }).asHid())).toBe(true)
    const keys = (fs: HIDDeviceFilter[]) => fs.map((x) => `${x.vendorId}:${x.productId}`)
    const p = new Set(keys(pulsarFactory.filters))
    expect(keys(compxbFactory.filters).some((k) => p.has(k))).toBe(false)
  })

  it('compxb: drops 3554:F50A when it is not ATK\'s Dragonfly F1S', async () => {
    const f = new FakePulsar({ vendorId: 0x3554, productId: 0xf50a, cid: 87, mid: 1 })
    expect(await compxbFactory.create(f.asHid())).toBeNull()
    const ok = new FakePulsar({ vendorId: 0x3554, productId: 0xf50a, cid: 2, mid: 19 })
    const drv = await compxbFactory.create(ok.asHid())
    expect(drv?.model()).toBe('Dragonfly F1S')
  })
})

describe('pulsar macros (0x300 + 384 per button)', () => {
  type M = Extract<Setting['value'], { kind: 'macros' }>
  const rec = (fake: FakePulsar, i: number) => fake.map.subarray(0x300 + 384 * i, 0x300 + 384 * (i + 1))

  it('reads one macro per button; erased (FF) records are empty', async () => {
    const { fake, drv } = await open()
    // a record as Pulsar's app writes it: name "ab", 2 events (A down 10 ms, A up), checksum
    const r = rec(fake, 1)
    r.set([2, 0x61, 0x62], 0)
    r.set([2, 0x81, 4, 0, 0, 10, 0x41, 4, 0, 0, 0], 31)
    r[42] = (0x55 - 2 - (0x81 + 4 + 10 + 0x41 + 4)) & 0xff
    const s = await drv.read()
    const v = find(s, 'macros').value as M
    expect(v).toMatchObject({ kind: 'macros', slots: 5, format: 'pulsar', text: false, mouse: true, maxPerMacro: 350, maxDelay: 65535 })
    expect(v.slotNames).toEqual(['M1 · Left', 'M2 · Right', 'M3 · Wheel', 'M4 · Back', 'M5 · Forward'])
    expect(v.macros).toEqual([[], [{ t: 'tap', kc: 4 }], [], [], []])
    const b2 = find(s, 'btn2').value as Choice
    expect(b2.options).toContainEqual(['Macro M2', MACRO_ONCE])
    expect(b2.options).toContainEqual(['Macro M2 (repeat while held)', MACRO_HELD])
    // reading never writes
    expect(fake.sent.some((d) => d[0] === 0x07)).toBe(false)
  })

  it('writes the whole record like the app (name, count, events, checksum) and reads it back', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    fake.sent = []
    const v = find(s, 'macros').value as M
    const steps: MacroStep[] = [{ t: 'tap', kc: 0x05 }, { t: 'delay', ms: 300 }, { t: 'mouse', a: 'tap', btn: 1 }, { t: 'wheel', dir: -1 }]
    await drv.write({ ...find(s, 'macros'), value: { ...v, macros: [[], [], [], steps, []] } })
    const writes = fake.sent.filter((d) => d[0] === 0x07)
    const ev = encodeMacro(steps, 'pulsar')
    expect(writes).toHaveLength(Math.ceil((33 + ev.length) / 10))
    expect(writes.every((d) => { const a = (d[2] << 8) | d[3]; return a >= 0x300 + 384 * 3 && a + d[4] <= 0x300 + 384 * 3 + 383 })).toBe(true)
    const r = rec(fake, 3)
    expect([...r.subarray(0, 8)]).toEqual([7, ...[...'Macro 4'].map((c) => c.charCodeAt(0))])
    expect(r[8]).toBe(0xff) // name padding
    expect(r[31]).toBe(ev.length / 5)
    expect([...r.subarray(32, 32 + ev.length)]).toEqual(ev)
    expect(r[32 + ev.length]).toBe((0x55 - ev.length / 5 - ev.reduce((a, b) => a + b, 0)) & 0xff)
    expect((find(await drv.read(), 'macros').value as M).macros[3]).toEqual(steps)
    // the other records are untouched
    expect([...rec(fake, 0).subarray(0, 40)].every((b) => b === 0xff)).toBe(true)
  })

  it('keeps the name the app gave a record; unchanged macros write nothing; too long is refused', async () => {
    const { fake, drv } = await open()
    rec(fake, 0).set([3, 0x41, 0x42, 0x43], 0)
    rec(fake, 0).set([0, 0x55], 31)
    const s = await drv.read()
    const v = find(s, 'macros').value as M
    fake.sent = []
    await drv.write(find(s, 'macros'))
    expect(fake.sent.some((d) => d[0] === 0x07)).toBe(false)
    await drv.write({ ...find(s, 'macros'), value: { ...v, macros: [[{ t: 'tap', kc: 4 }], [], [], [], []] } })
    expect([...rec(fake, 0).subarray(0, 4)]).toEqual([3, 0x41, 0x42, 0x43])
    fake.sent = []
    const many: MacroStep[] = Array.from({ length: 36 }, () => ({ t: 'tap', kc: 4 }))
    await expect(drv.write({ ...find(s, 'macros'), value: { ...v, macros: [many, [], [], [], []] } })).rejects.toThrow(/at most 70/)
    expect(fake.sent.some((d) => d[0] === 0x07)).toBe(false)
  })

  it('binds a button to its own record: type 6, param (button << 8) | 1 or 254', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    const b4 = find(s, 'btn4')
    await drv.write({ ...b4, value: { ...(b4.value as Choice), current: MACRO_ONCE } })
    expect([...fake.map.subarray(0x6c, 0x70)]).toEqual([6, 3, 1, (0x55 - 6 - 3 - 1) & 0xff])
    expect(find(await drv.read(), 'btn4').value).toMatchObject({ current: MACRO_ONCE })
    await drv.write({ ...b4, value: { ...(b4.value as Choice), current: MACRO_HELD } })
    expect([...fake.map.subarray(0x6c, 0x6f)]).toEqual([6, 3, 254])
    expect(find(await drv.read(), 'btn4').value).toMatchObject({ current: MACRO_HELD })
    // the app's "until any key is pressed" (255) is kept as it is
    fake.map.set([6, 3, 255, (0x55 - 6 - 3 - 255) & 0xff], 0x6c)
    const b = find(await drv.read(), 'btn4').value as Choice
    expect(b.current).toBe(KEEP)
    expect(b.options[0][0]).toBe('Macro M4 (keep)')
  })

  it('allowlist: only the five records, never past byte 382 of a record', () => {
    for (let i = 0; i < 5; i++) {
      const base = 0x300 + 384 * i
      expect(writable(base, 10)).toBe(true)
      expect(writable(base + 373, 10)).toBe(true)
      expect(writable(base + 374, 10)).toBe(false)
      expect(writable(base + 383, 1)).toBe(false)
    }
    expect(writable(0x2ff, 1)).toBe(false)
    expect(writable(0x300 + 384 * 5, 1)).toBe(false)
    expect(writable(0x100, 10)).toBe(false) // ShortcutKey records stay read-only
  })

  it('unverified CompX-B mice get no macros', async () => {
    const { fake, drv } = await open({ vendorId: 0x3554, productId: 0xf5f4, cid: 62, mid: 1, codec: 's50' })
    const s = await drv.read()
    expect(s.some((x) => x.key === 'macros')).toBe(false)
    expect(fake.sent.some((d) => d[0] === 0x08 && ((d[2] << 8) | d[3]) >= 0x300 && ((d[2] << 8) | d[3]) < 0x1b00)).toBe(false)
    expect((find(s, 'btn1').value as Choice).options.some(([l]) => /macro/i.test(l))).toBe(false)
  })
})
