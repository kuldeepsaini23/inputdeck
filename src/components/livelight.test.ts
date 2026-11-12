import { describe, expect, it } from 'vitest'
import { buildLiveReport, probesFor } from './LiveLightTest'
import type { DeviceState } from '#/devices'
import type { Driver, KeyCap } from '#/drivers/types'

const dev = { id: '260d:0175', busy: false, driver: { brand: () => 'DAREU', model: () => 'A68' } as unknown as Driver } as DeviceState
const keys: KeyCap[] = [{ index: 1, label: 'Esc', x: 0, y: 0, w: 1, h: 1 }, { index: 2, label: 'G', x: 6, y: 2, w: 1, h: 1 }, { index: 3, label: 'Right', x: 14, y: 4, w: 1, h: 1 }]

describe('live lighting test', () => {
  it('probes the corners and middle, one colour byte at a time first', () => {
    const p = probesFor({ rows: 5, cols: 15 })
    expect(p.map((x) => [x.row, x.col, x.value])).toEqual([[0, 0, 0xff0000], [2, 7, 0x00ff00], [4, 14, 0x0000ff], [0, 14, 0xffffff], [4, 0, 0xffffff]])
  })
  it('the report gives the byte order and where each cell lit', () => {
    const p = probesFor({ rows: 5, cols: 15 })
    const r = buildLiveReport(dev, { rows: 5, cols: 15 }, keys, p, [{ key: 0, colour: 'Green' }, { key: 1, colour: 'Red' }, { key: 2, colour: 'Blue' }, { none: true }, { many: true, colour: 'White' }])
    expect(r).toContain('Byte order (from probes 1-3): GRB')
    expect(r).toContain('1. cell row 0 col 0, sent FF0000 (first colour byte only) -> key "Esc"')
    expect(r).toContain('4. cell row 0 col 14, sent FFFFFF (all bytes (white)) -> nothing lit')
    expect(r).toContain('5. cell row 4 col 0, sent FFFFFF (all bytes (white)) -> several keys lit, colour: White')
  })
})
