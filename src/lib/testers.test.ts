import { describe, expect, it } from 'vitest'
import { averageRate, chatterCount, cps, dpiError, dpiOf, fastestRepress, nearestRate, rateOf } from './testers'

const every = (gap: number, n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i * gap)

describe('polling rate', () => {
  it('reads 1000 Hz and 8000 Hz from steady reports', () => {
    expect(rateOf(every(1, 50))).toBeCloseTo(1000)
    expect(rateOf(every(0.125, 200))).toBeCloseTo(8000)
  })
  it('ignores pauses in movement', () => {
    const t = [...every(1, 30), ...every(1, 30, 500)]
    expect(rateOf(t)).toBeCloseTo(1000)
    expect(averageRate(t)!).toBeLessThan(200)
  })
  it('needs enough reports', () => expect(rateOf([0, 1, 2])).toBeUndefined())
  it('snaps to the nearest standard rate', () => {
    expect(nearestRate(970)).toBe(1000)
    expect(nearestRate(7100)).toBe(8000)
    expect(nearestRate(3000)).toBe(4000)
    expect(nearestRate(2700)).toBe(2000)
  })
})

describe('DPI check', () => {
  it('800 counts over one inch is 800 DPI, in cm too', () => {
    expect(dpiOf(800, 1, 'in')).toBe(800)
    expect(dpiOf(-1600, 5.08, 'cm')).toBeCloseTo(800)
    expect(dpiOf(10, 0, 'cm')).toBeUndefined()
  })
  it('error in percent', () => expect(dpiError(820, 800)).toBeCloseTo(2.5))
})

describe('clicks and keys', () => {
  const p = [{ down: 0, up: 50 }, { down: 55, up: 100 }, { down: 300, up: 340 }, { down: 400 }]
  it('counts presses right after a release as chatter', () => expect(chatterCount(p, 10)).toBe(1))
  it('fastest re-press', () => expect(fastestRepress(p)).toBe(5))
  it('clicks per second', () => expect(cps([0, 100, 600, 900, 1000], 1000)).toBe(5))
})
