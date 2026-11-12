// A real W75 stored exactly this entry for an A <-> D "last input" SOCD pair (written, read back, then removed).
import { describe, expect, it } from 'vitest'
import { setSocdPairsPkts, W75_CAPS, W75_HID } from './wraith'

const hidOf = (label: string) => {
  const cap = W75_CAPS.find((c) => c.label === label)!
  return W75_HID.find(([i]) => i === cap.index)![1]
}

describe('W75 SOCD bytes match the real keyboard', () => {
  it('A and D map to HID 0x04 and 0x07', () => {
    expect([hidOf('A'), hidOf('D')]).toEqual([0x04, 0x07])
  })
  it('A <-> D last input is 01 00 04 07 at the start of page 0; page 1 stays empty', () => {
    const [p0, p1] = setSocdPairsPkts([{ mode: 0, hid1: hidOf('A'), hid2: hidOf('D') }])
    expect(p0.slice(0, 9)).toEqual([0x24, 0x00, 0, 0, 0x28, 0x01, 0x00, 0x04, 0x07])
    expect(p0.slice(9).every((b) => b === 0)).toBe(true)
    expect(p1.slice(5).every((b) => b === 0)).toBe(true)
  })
})
