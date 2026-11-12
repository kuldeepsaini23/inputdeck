import { describe, expect, it } from 'vitest'
import { checksum, decodeDpi, encodeDpi, frame, PulsarDriver, pulsarFactory, stageBytes } from './pulsar'
import { FakePulsar } from './fakes/fake-pulsar'
import type { Setting } from './types'

const noSleep = () => Promise.resolve()

async function open() {
  const fake = new FakePulsar()
  await fake.open()
  const drv = new PulsarDriver(fake.asHid(), { sleep: noSleep })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!

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

  it('round-trips DPI in each range', () => {
    for (const dpi of [50, 400, 800, 1600, 10240, 12800, 25600, 26000, 32000]) {
      const [lo, f] = encodeDpi(dpi)
      expect(decodeDpi(lo, f)).toBe(dpi)
    }
    expect(stageBytes(400)).toEqual([0x27, 0x27, 0x00, (0x55 - 0x4e) & 0xff])
    expect(stageBytes(12800).slice(0, 3)).toEqual([0x37, 0x37, 0x22])
  })
})

describe('pulsar driver', () => {
  it('reads the mouse into settings', async () => {
    const { drv } = await open()
    const s = await drv.read()
    expect(drv.model()).toBe('X2 CrazyLight')
    expect(find(s, 'battery').value).toEqual({ kind: 'text', text: '76%' })
    expect(find(s, 'fw').value).toEqual({ kind: 'text', text: 'v3.05' })
    const dpi = find(s, 'dpi').value
    expect(dpi.kind === 'dpi' && dpi.stages).toEqual([400, 800, 1000, 12800])
    expect(dpi.kind === 'dpi' && dpi.active).toBe(1)
    expect(find(s, 'polling').value).toMatchObject({ current: 0x40 })
    const poll = find(s, 'polling').value as Extract<Setting['value'], { kind: 'choice' }>
    expect(poll.options.map((o) => o[0])).toContain('8000 Hz')
    expect(find(s, 'lod').value).toMatchObject({ current: 1 })
    expect(find(s, 'motion_sync').value).toEqual({ kind: 'toggle', on: true })
    expect(find(s, 'debounce').value).toMatchObject({ current: 2 })
    expect(find(s, 'sleep').value).toMatchObject({ current: 60 })
    expect(find(s, 'btn1').value).toMatchObject({ current: 0 })
    expect(find(s, 'profile').value).toMatchObject({ current: 1 })
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
    await drv.write({ ...lod, value: { ...(lod.value as Extract<Setting['value'], { kind: 'choice' }>), current: 3 } })
    const w = fake.sent.find((d) => d[0] === 0x07)!
    expect(w.slice(0, 7)).toEqual([0x07, 0, 0, 0x0a, 2, 3, 0x52])
    expect(fake.map[0x0a]).toBe(3)
  })

  it('writes only the DPI stages that changed', async () => {
    const { fake, drv } = await open()
    const s = await drv.read()
    fake.sent = []
    const dpi = find(s, 'dpi').value as Extract<Setting['value'], { kind: 'dpi' }>
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
    await expect(drv.write({ ...b, value: { ...(b.value as Extract<Setting['value'], { kind: 'choice' }>), current: 6 } })).rejects.toThrow(/Left click/)
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
    await drv.write({ ...p, value: { ...(p.value as Extract<Setting['value'], { kind: 'choice' }>), current: 3 } })
    expect(fake.profile).toBe(3)
  })
})

describe('pulsar factory', () => {
  it('matches the CrazyLight dongle, not the Sonix-protocol models', () => {
    const f = new FakePulsar()
    expect(pulsarFactory.match(f.asHid())).toBe(true)
    f.productId = 0x5404
    expect(pulsarFactory.match(f.asHid())).toBe(false)
  })
})
