// Replays the settings memory read from a real Pulsar X2 CrazyLight Mini PRX (3710:5406, cid 87 / mid 96)
// with the read-only probe, so driver changes can't silently break the hardware-verified device.
import { describe, expect, it } from 'vitest'
import { PulsarDriver } from './pulsar'
import { FakePulsar } from './fakes/fake-pulsar'
import type { Setting, Value } from './types'

const DUMP = `
01 54 06 4f 01 54 00 55 00 55 01 54 27 27 00 07
4f 4f 00 b7 9f 9f 00 17 3f 3f 44 93 7f 7f 88 cf
37 37 22 c5 37 37 22 c5 37 37 22 c5 34 f8 f2 37
00 00 ff 56 00 ff 00 56 ff ff 00 57 ff a3 00 b3
f2 0a ea 6f f2 0a ea 6f f2 0a ea 6f 02 53 80 d5
03 52 00 55 ff 00 ff 57 00 55 80 d5 03 52 00 55
01 01 00 53 01 02 00 52 01 04 00 50 01 08 00 4c
01 10 00 44 02 01 00 52 02 02 00 51 02 03 00 50
07 00 00 4e 08 04 00 49 04 0a 03 44 00 00 00 55
00 00 00 55 00 00 00 55 00 00 00 55 00 00 00 55
01 ff 00 ff 07 09 46 00 55 04 51 00 55 06 4f 00
55 00 55 00 55 00 55 06 4f 00 55 0a 4b 00 55 00
55 00 55 00 00 80 3f 96 00 00 80 3f 96 00 00 80
3f 96 00 00 80 3f 96 00 55 01 54 00 00 00 55 00
55 ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff
ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff`.trim().split(/\s+/).map((h) => parseInt(h, 16))

const find = (l: Setting[], k: string) => l.find((s) => s.key === k)?.value as Value

describe('real Pulsar X2 CrazyLight Mini PRX memory', () => {
  it('decodes exactly what the mouse holds', async () => {
    const fake = new FakePulsar({ mid: 96 })
    fake.map.fill(0)
    fake.map.set(DUMP, 0)
    await fake.open()
    const drv = new PulsarDriver(fake.asHid(), { sleep: () => Promise.resolve() })
    const s = await drv.read()
    expect(drv.verified).not.toBe(false)
    expect(drv.model()).toMatch(/X2 Crazylight Mini/i)
    const dpi = find(s, 'dpi') as Extract<Value, { kind: 'dpi' }>
    expect(dpi.stages).toEqual([400, 800, 1600, 3200, 6400, 12800])
    expect(dpi.active).toBe(1)
    expect(find(s, 'polling')).toMatchObject({ current: 1 })
    expect(find(s, 'lod')).toMatchObject({ current: 1 })
    expect(find(s, 'debounce')).toMatchObject({ current: 4 })
    expect(find(s, 'motion_sync')).toEqual({ kind: 'toggle', on: false })
    expect(find(s, 'sleep')).toMatchObject({ current: 60 })
    expect(find(s, 'btn1')).toMatchObject({ current: 0 })
    // nothing is written while reading
    expect(fake.sent.some((d) => d[0] === 0x07)).toBe(false)
  })
})
