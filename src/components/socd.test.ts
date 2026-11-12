import { describe, expect, it } from 'vitest'
import type { Socd } from '#/drivers/types'
import { socdEntryLabel, socdPickKey } from './SocdCards'

const keys = ['W', 'A', 'S', 'D', 'Fn'].map((label, i) => ({ index: i, label, x: i, y: 0, w: 1, h: 1 }))
const MODES: [string, number][] = [['Last input', 0], ['Key 1 wins', 1], ['Key 2 wins', 2], ['Neutral', 3]]
const pairs = (entries: Socd['entries'], extra: Partial<Socd> = {}): Socd => ({ kind: 'socd', mode: 'pairs', keys, max: 20, modes: MODES, unavailable: [4], entries, ...extra })
const groups = (entries: number[][], removable = true): Socd => ({
  kind: 'socd', mode: 'groups', keys, max: 4, modes: [['Last input', 0]], removable, entries: entries.map((k) => ({ keys: k, mode: 0 })),
})

describe('SOCD picking', () => {
  it('labels', () => {
    expect(socdEntryLabel(pairs([{ keys: [1, 3], mode: 0 }]), 0)).toBe('A ↔ D · Last input')
    expect(socdEntryLabel(groups([[1, 3], [], [], []]), 0)).toBe('Group 1')
  })

  it('two clicks make a pair with the first mode (and travel / rapid defaults)', () => {
    let r = socdPickKey(pairs([]), { entry: -1, keys: [] }, 1)
    expect(r).toEqual({ pick: { entry: -1, keys: [1] } })
    r = socdPickKey(pairs([]), r.pick!, 3)
    expect(r.value?.entries).toEqual([{ keys: [1, 3], mode: 0 }])
    expect(r.pick).toBeUndefined()
    const lf = pairs([], { travel: { min: 0.1, max: 3.4, step: 0.01, default: 1.2 }, rapid: true })
    expect(socdPickKey(lf, { entry: -1, keys: [1] }, 3).value?.entries).toEqual([{ keys: [1, 3], mode: 0, travel: 1.2, rapid: false }])
  })

  it('refuses unavailable keys and keys of another pair; re-picks an existing pair', () => {
    const v = pairs([{ keys: [1, 3], mode: 2 }])
    expect(socdPickKey(v, { entry: -1, keys: [] }, 4).msg).toMatch(/Fn can't/)
    expect(socdPickKey(v, { entry: -1, keys: [] }, 1).msg).toMatch(/A is already in A ↔ D/)
    expect(socdPickKey(v, { entry: 0, keys: [3] }, 0).value?.entries).toEqual([{ keys: [3, 0], mode: 2 }])
    // clicking the picked key again un-picks it
    expect(socdPickKey(v, { entry: -1, keys: [0] }, 0).pick).toEqual({ entry: -1, keys: [] })
  })

  it('groups: add, move, remove (unless the firmware cannot)', () => {
    const v = groups([[1], [3], [], []])
    expect(socdPickKey(v, { entry: 0, keys: [] }, 0).value?.entries.map((e) => e.keys)).toEqual([[0, 1], [3], [], []])
    expect(socdPickKey(v, { entry: 0, keys: [] }, 3).value?.entries.map((e) => e.keys)).toEqual([[1, 3], [], [], []])
    expect(socdPickKey(v, { entry: 0, keys: [] }, 1).value?.entries.map((e) => e.keys)).toEqual([[], [3], [], []])
    const old = groups([[1], [], [], []], false)
    expect(socdPickKey(old, { entry: 0, keys: [] }, 1)).toMatchObject({ msg: expect.stringMatching(/can't take A out/) })
    expect(socdPickKey(old, { entry: 0, keys: [] }, 1).value).toBeUndefined()
  })
})
