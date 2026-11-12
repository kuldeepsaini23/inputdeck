import { describe, expect, it } from 'vitest'
import { checksum, frame, KEEP, ACTIONS, OrbitalDriver, orbitalFactory, validSum } from './orbital'
import { FakeOrbital, type FakeOrbitalOptions } from './fakes/fake-orbital'
import type { Setting, Value } from './types'

const noSleep = () => Promise.resolve()

async function open(o?: FakeOrbitalOptions) {
  const fake = new FakeOrbital(o)
  await fake.open()
  const drv = new OrbitalDriver(fake.asHid(), { sleep: noSleep, timeoutMs: 30 })
  return { fake, drv }
}
const find = (list: Setting[], k: string) => list.find((s) => s.key === k)!
type Choice = Extract<Value, { kind: 'choice' }>
type Dpi = Extract<Value, { kind: 'dpi' }>
const with_ = (st: Setting, value: Value): Setting => ({ ...st, value })
/** [family, op, sub] of every packet sent */
const cmds = (f: FakeOrbital) => f.sent.map((p) => [p[0] & 0xbf, p[2], p[3]].map((b) => b.toString(16)).join(':'))

describe('orbital framing', () => {
  it('checksums so that the whole frame sums to 0xA1', () => {
    const p = frame(0x0a, 0x81, 0x01)
    expect(p.length).toBe(64)
    expect(p[63]).toBe((0xa1 - 0x0a - 0x81 - 0x01) & 0xff)
    expect(validSum(p)).toBe(true)
  })

  it('sets the receiver bit before the checksum', () => {
    const p = frame(0x04, 0x81, 0x01, [], true)
    expect(p[0]).toBe(0x44)
    expect(p[63]).toBe(checksum(p))
    expect(validSum(p)).toBe(true)
  })
})

describe('orbital factory', () => {
  it('matches only the four product ids on the vendor collection', () => {
    expect(orbitalFactory.match(new FakeOrbital({ productId: 0x080b }).asHid())).toBe(true)
    expect(orbitalFactory.match(new FakeOrbital({ productId: 0x0747 }).asHid())).toBe(true)
    const other = new FakeOrbital()
    other.productId = 0x521f // another Nordic-VID device
    expect(orbitalFactory.match(other.asHid())).toBe(false)
    const mouseIf = new FakeOrbital()
    mouseIf.collections = [{ usagePage: 1, usage: 2 }] as unknown as HIDCollectionInfo[]
    expect(orbitalFactory.match(mouseIf.asHid())).toBe(false)
    expect(orbitalFactory.filters).toHaveLength(4)
    expect(orbitalFactory.filters.every((f) => f.vendorId === 0x1915 && f.usagePage === 0xff0a)).toBe(true)
  })

  it('creates an unverified driver', async () => {
    const fake = new FakeOrbital()
    const drv = await orbitalFactory.create(fake.asHid())
    expect(drv).not.toBeNull()
    expect(fake.opened).toBe(true)
    expect(drv!.verified).toBe(false)
    expect(drv!.brand()).toBe('ORBITAL')
    expect(drv!.image()).toMatch(/^https:\/\/orbitalworks\.co\//)
    await drv!.close()
  })
})

describe('orbital V2 (Ghost) through the receiver', () => {
  it('reads everything', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    expect(drv.model()).toBe('Pathfinder V2 / Ghost')
    expect(find(s, 'battery').value).toEqual({ kind: 'text', text: '82%' })
    expect(find(s, 'connection').value).toEqual({ kind: 'text', text: 'Wireless (receiver)' })
    const dpi = find(s, 'dpi').value as Dpi
    expect(dpi.stages).toEqual([400, 800, 1600, 3200])
    expect(dpi.active).toBe(1)
    expect(find(s, 'dpi_count').value).toMatchObject({ current: 4 })
    expect(find(s, 'dpi_xy').value).toEqual({ kind: 'toggle', on: false })
    expect(s.some((x) => x.key === 'dpi_y')).toBe(false)
    const poll = find(s, 'polling').value as Choice
    expect(poll.current).toBe(3)
    expect(poll.options.map((o) => o[0])).toEqual(['125 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'])
    expect(find(s, 'lod').value).toMatchObject({ current: 1 })
    expect(find(s, 'motion_sync').value).toEqual({ kind: 'toggle', on: true })
    expect(find(s, 'high_perf').value).toEqual({ kind: 'toggle', on: true })
    expect(find(s, 'angle_tune').value).toMatchObject({ current: -2 })
    expect(find(s, 'debounce').value).toMatchObject({ current: 4 })
    expect(find(s, 'sleep').value).toMatchObject({ current: 300 })
    expect(find(s, 'quick_response').value).toEqual({ kind: 'toggle', on: false })
    expect(find(s, 'btn1').value).toMatchObject({ current: 0 })
    expect(find(s, 'btn4').value).toMatchObject({ current: 3 }) // rear side = Back
    expect(find(s, 'btn5').value).toMatchObject({ current: 4 }) // front side = Forward
    expect(find(s, 'btn_dpi').value).toMatchObject({ current: 6 })
    // handshake unrouted, the rest routed
    expect(fake.sent[0][0]).toBe(0x01)
    expect(fake.sent.slice(1).every((p) => (p[0] & 0x40) !== 0)).toBe(true)
  })

  it('refuses a receiver paired with another mouse', async () => {
    const { drv } = await open({ pairedPid: 0x1234 })
    await expect(drv.read()).rejects.toThrow(/paired/)
  })

  it('writes DPI through the sensor block and saves, keeping colours and pass-through bytes', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const st = find(s, 'dpi')
    const colors = fake.sensor.slice(39, 54)
    fake.sent = []
    await drv.write(with_(st, { ...(st.value as Dpi), stages: [400, 1234, 1600], active: 2 }))
    expect(cmds(fake)).toEqual(['4:bc:2', 'a:81:1'])
    expect(fake.sensor[10]).toBe(0b111)
    expect(fake.sensor[9]).toBe(2)
    expect(fake.sensor[11 + 4] | (fake.sensor[12 + 4] << 8)).toBe(1250) // snapped to 50
    expect(fake.sensor[13 + 4] | (fake.sensor[14 + 4] << 8)).toBe(1250) // Y follows X
    expect(fake.sensor.slice(39, 54)).toEqual(colors)
    expect(fake.sensor[2]).toBe(1)
  })

  it('writes polling, debounce and sleep through the system block', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    fake.sent = []
    await drv.write(with_(find(s, 'polling'), { ...(find(s, 'polling').value as Choice), current: 6 }))
    expect(cmds(fake)).toEqual(['4:90:4', 'a:81:1'])
    expect(fake.system[4]).toBe(6)
    expect(fake.system[8]).toBe(1) // move wake-up kept
    expect([fake.system[12], fake.system[14], fake.system[15]]).toEqual([2, 1, 3])
    await drv.write(with_(find(s, 'debounce'), { kind: 'number', min: 0, max: 30, current: 8, unit: ' ms' }))
    expect(fake.system[5]).toBe(8)
    await drv.write(with_(find(s, 'sleep'), { ...(find(s, 'sleep').value as Choice), current: 1800 }))
    expect(fake.system[0] | (fake.system[1] << 8)).toBe(1800)
    expect(fake.system[2] | (fake.system[3] << 8)).toBe(1800)
    await expect(drv.write(with_(find(s, 'polling'), { ...(find(s, 'polling').value as Choice), current: 1 }))).rejects.toThrow()
  })

  it('writes toggles, LOD and angle', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    await drv.write(with_(find(s, 'motion_sync'), { kind: 'toggle', on: false }))
    expect(fake.sensor[2]).toBe(0)
    await drv.write(with_(find(s, 'angle_snap'), { kind: 'toggle', on: true }))
    expect(fake.sensor[0]).toBe(1)
    await drv.write(with_(find(s, 'overclock'), { kind: 'toggle', on: true }))
    expect(fake.sensor[3]).toBe(1)
    await drv.write(with_(find(s, 'lod'), { ...(find(s, 'lod').value as Choice), current: 2 }))
    expect(fake.sensor[7]).toBe(2)
    await drv.write(with_(find(s, 'angle_tune'), { kind: 'number', min: -30, max: 30, current: -45, unit: '°' }))
    expect(fake.sensor[8]).toBe(0xe2) // clamped to -30
    await drv.write(with_(find(s, 'wheel_reverse'), { kind: 'toggle', on: true }))
    expect(fake.system[10]).toBe(1)
  })

  it('separate X / Y', async () => {
    const { drv, fake } = await open({ stages: [[400, 400], [800, 1600], [1600, 1600], [3200, 3200], [6400, 6400]] })
    let s = await drv.read()
    expect(find(s, 'dpi_xy').value).toEqual({ kind: 'toggle', on: true })
    const y = find(s, 'dpi_y')
    expect((y.value as Dpi).stages).toEqual([400, 1600, 1600, 3200])
    await drv.write(with_(y, { ...(y.value as Dpi), stages: [400, 2000, 1600, 3200] }))
    expect(fake.sensor[13 + 4] | (fake.sensor[14 + 4] << 8)).toBe(2000)
    expect(fake.sensor[11 + 4] | (fake.sensor[12 + 4] << 8)).toBe(800)
    await drv.write(with_(find(s, 'dpi_xy'), { kind: 'toggle', on: false }))
    expect(fake.sensor[13 + 4] | (fake.sensor[14 + 4] << 8)).toBe(800)
    s = await drv.read()
    expect(s.some((x) => x.key === 'dpi_y')).toBe(false)
  })

  it('remaps buttons but never drops the only left click', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    const b4 = find(s, 'btn4')
    fake.sent = []
    await drv.write(with_(b4, { ...(b4.value as Choice), current: ACTIONS.findIndex((a) => a[0] === 'Mute') }))
    expect(cmds(fake)).toEqual(['3:85:4', 'a:81:1'])
    expect(fake.buttons[4]).toBe(0x0300e200)
    await drv.write(with_(b4, { ...(b4.value as Choice), current: ACTIONS.findIndex((a) => a[0] === 'Disabled') }))
    expect(cmds(fake).slice(-2)).toEqual(['3:81:4', 'a:81:1'])
    expect(fake.buttons[4]).toBe(0)
    const b1 = find(s, 'btn1')
    await expect(drv.write(with_(b1, { ...(b1.value as Choice), current: 1 }))).rejects.toThrow(/Left click/)
    await drv.write(with_(find(s, 'btn5'), { ...(find(s, 'btn5').value as Choice), current: 0 }))
    await drv.write(with_(b1, { ...(b1.value as Choice), current: 1 }))
    expect(fake.buttons[0]).toBe(0x0100f100)
  })

  it('keeps unknown button actions', async () => {
    const fake0 = new FakeOrbital()
    fake0.buttons[2] = 0x09010000
    await fake0.open()
    const drv = new OrbitalDriver(fake0.asHid(), { sleep: noSleep, timeoutMs: 30 })
    const s = await drv.read()
    const b3 = find(s, 'btn3').value as Choice
    expect(b3.current).toBe(KEEP)
    expect(b3.options[0][0]).toMatch(/macro/)
    fake0.sent = []
    await drv.write(with_(find(s, 'btn3'), b3))
    expect(fake0.sent).toEqual([])
  })

  it('switches profile and checks it took', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    fake.lazyProfile = 2 // first switch + save are acked but ignored
    await drv.write(with_(find(s, 'profile'), { ...(find(s, 'profile').value as Choice), current: 3 }))
    expect(fake.profile).toBe(3)
    expect(cmds(fake).filter((c) => c === '2:82:2').length).toBe(2)
  })

  it('reports a rejected write', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    fake.reject = true
    await expect(drv.write(with_(find(s, 'lod'), { ...(find(s, 'lod').value as Choice), current: 0 }))).rejects.toThrow(/rejected/)
  })

  it('times out when nobody answers', async () => {
    const { drv, fake } = await open()
    fake.drop = 1
    await expect(drv.read()).rejects.toThrow(/no answer/)
  })

  it('ignores live status packets while waiting for the handshake', async () => {
    const { drv, fake } = await open()
    const live = new Uint8Array(64)
    live[0] = 0x41; live[2] = 0x98; live[3] = 1
    fake.emit(live)
    await expect(drv.read()).resolves.toBeTruthy()
  })
})

describe('orbital V1 (Pathfinder)', () => {
  it('reads the wired mouse with polling up to 1000 Hz', async () => {
    const { drv, fake } = await open({ productId: 0x0747 })
    const s = await drv.read()
    expect(drv.model()).toBe('Pathfinder')
    expect(find(s, 'connection').value).toEqual({ kind: 'text', text: 'Wired' })
    expect((find(s, 'polling').value as Choice).options.map((o) => o[1])).toEqual([0, 2, 3])
    expect((find(s, 'dpi').value as Dpi).stages).toEqual([400, 800, 1600, 3200])
    expect(find(s, 'motion_sync').value).toEqual({ kind: 'toggle', on: true })
    expect(find(s, 'ripple').value).toEqual({ kind: 'toggle', on: false })
    expect(find(s, 'angle_tune').value).toMatchObject({ current: 3 })
    expect(find(s, 'sleep').value).toMatchObject({ current: 600 })
    expect(s.some((x) => x.key === 'quick_response')).toBe(false)
    expect(fake.sent.every((p) => (p[0] & 0x40) === 0)).toBe(true)
  })

  it('writes the whole block, reads it back, then saves', async () => {
    const { drv, fake } = await open({ productId: 0x0746 })
    const s = await drv.read()
    fake.sent = []
    await drv.write(with_(find(s, 'ripple'), { kind: 'toggle', on: true }))
    expect(cmds(fake)).toEqual(['4:b5:2', '4:81:1', 'a:81:1'])
    expect(fake.sent.every((p) => (p[0] & 0x40) !== 0)).toBe(true)
    expect(fake.sensor[0] & (1 << 4)).not.toBe(0)
    expect(fake.sensor[0] & (1 << 5)).not.toBe(0) // motion sync kept
    expect(fake.sensor[30]).toBe(0x5a) // unknown byte kept
    await drv.write(with_(find(s, 'polling'), { ...(find(s, 'polling').value as Choice), current: 2 }))
    expect(fake.sensor[1]).toBe(2)
    await drv.write(with_(find(s, 'sleep'), { ...(find(s, 'sleep').value as Choice), current: 120 }))
    expect(fake.sensor[46] | (fake.sensor[47] << 8)).toBe(120)
    expect(fake.sensor[48] | (fake.sensor[49] << 8)).toBe(120)
    await drv.write(with_(find(s, 'debounce'), { kind: 'number', min: 0, max: 30, current: 12, unit: ' ms' }))
    expect(fake.sensor[50]).toBe(12)
    await drv.write(with_(find(s, 'wheel_reverse'), { kind: 'toggle', on: true }))
    expect(fake.sensor[0] & 0x80).toBe(0x80)
    await drv.write(with_(find(s, 'dpi_count'), { ...(find(s, 'dpi_count').value as Choice), current: 2 }))
    expect(fake.sensor[2]).toBe(0b11)
    await expect(drv.write(with_(find(s, 'polling'), { ...(find(s, 'polling').value as Choice), current: 6 }))).rejects.toThrow()
  })

  it('does not save when the readback differs', async () => {
    const { drv, fake } = await open({ productId: 0x0747 })
    const s = await drv.read()
    fake.ignoreWrites = true
    const saves = fake.saves
    await expect(drv.write(with_(find(s, 'lod'), { ...(find(s, 'lod').value as Choice), current: 2 }))).rejects.toThrow(/did not keep/)
    expect(fake.saves).toBe(saves)
  })

  it('uses the V1 profile sub-command', async () => {
    const { drv, fake } = await open({ productId: 0x0747 })
    const s = await drv.read()
    await drv.write(with_(find(s, 'profile'), { ...(find(s, 'profile').value as Choice), current: 4 }))
    expect(fake.profile).toBe(4)
    expect(cmds(fake)).toContain('2:82:1')
  })
})

describe('orbital allowlist', () => {
  it('only ever sends allowlisted commands', async () => {
    const { drv, fake } = await open()
    const s = await drv.read()
    for (const st of s) {
      if (st.value.kind === 'text') continue
      await drv.write(st).catch(() => undefined)
    }
    const allowed = new Set(['1:81:1', '4:81:1', '4:83:3', '4:bc:2', '4:90:4', 'a:81:1', '2:82:2', '3:82:3', '3:81:4', '3:85:4'])
    expect(cmds(fake).every((c) => allowed.has(c))).toBe(true)
    // nothing from the factory-reset (9), lighting (5), macro (7) or diagnostics (1e) families
    expect(fake.sent.some((p) => [0x09, 0x05, 0x07, 0x1e, 0x00].includes(p[0] & 0xbf))).toBe(false)
  })
})
