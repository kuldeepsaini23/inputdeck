import { describe, expect, it } from 'vitest'
import { buildLiveReport, probesFor } from './LiveLightTest'
import type { DeviceState } from '#/devices'
import type { Driver, KeyCap } from '#/drivers/types'
import { A68_LED_KEYS, capsFor, liveMapFor, productFor } from '#/drivers/dareu'

const dev = { id: '260d:0175', busy: false, driver: { brand: () => 'DAREU', model: () => 'A68' } as unknown as Driver } as DeviceState
const keys: KeyCap[] = capsFor(productFor(0x0175)!)
const map = liveMapFor(0x0175, 5, 15, keys)!
const grid = { rows: 5, cols: 15, map }
const label = (r: number, c: number) => keys[map[r * 15 + c]!].label

describe('live lighting test', () => {
  it('A68: Q red, G green, M blue, then the whole top row white', () => {
    expect(A68_LED_KEYS).toHaveLength(75)
    const p = probesFor(grid)
    expect(p).toHaveLength(2)
    expect(p[0].cells.map((c) => [label(c.row, c.col), c.value])).toEqual([['Q', 0xff0000], ['G', 0x00ff00], ['M', 0x0000ff]])
    expect(p[1].cells.map((c) => label(c.row, c.col)).join(' ')).toBe('Esc 1 2 3 4 5 6 7 8 9 0 - = Bksp Ins')
    expect(p[1].cells.every((c) => c.value === 0xffffff)).toBe(true)
  })

  it('without a map: same cells, nothing skipped', () => {
    const p = probesFor({ rows: 5, cols: 15 })
    expect(p[0].cells.map((c) => [c.row, c.col, c.value])).toEqual([[1, 1, 0xff0000], [2, 5, 0x00ff00], [3, 7, 0x0000ff]])
    expect(p[1].cells).toHaveLength(15)
    // a map with a hole where a probe would land moves it to the next key in that row
    const holey = map.slice()
    holey[2 * 15 + 5] = undefined
    expect(probesFor({ ...grid, map: holey })[0].cells[1]).toMatchObject({ row: 2, col: 6 })
  })

  it('the report names what was sent and what the tester saw', () => {
    const p = probesFor(grid)
    const pos = (l: string) => keys.findIndex((k) => k.label === l)
    const r = buildLiveReport(dev, grid, keys, p, [{ match: false, seen: { [pos('W')]: 'Green', [pos('N')]: 'Blue' } }, { match: true }])
    expect(r).toContain('cell -> key map from the firmware')
    expect(r).toContain(`1. three keys: red, green, blue: sent "Q" (#${pos('Q')}) r1c1=FF0000, "G" (#${pos('G')}) r2c5=00FF00, "M" (#${pos('M')}) r3c7=0000FF -> saw "W" (#${pos('W')}) Green, "N" (#${pos('N')}) Blue`)
    expect(r).toContain('2. top row white: sent "Esc" (#0) r0c0=FFFFFF')
    expect(r).toContain('-> looked exactly like the picture')
    const none = buildLiveReport(dev, { rows: 5, cols: 15 }, keys, probesFor({ rows: 5, cols: 15 }), [{ none: true }], 'boom')
    expect(none).toContain('1. three keys: red, green, blue: sent r1c1=FF0000, r2c5=00FF00, r3c7=0000FF -> nothing lit')
    expect(none).toContain('2. top row white: sent r0c0=FFFFFF')
    expect(none).toContain('-> no answer')
    expect(none).toContain('Error: boom')
  })
})
