import { describe, expect, it } from 'vitest'
import type { KeyCap, Value } from '#/drivers/types'
import { W75_CAPS, WR_OPAQUE, keymapValue } from '#/drivers/wraith'
import {
  availableRegions, clickSelect, common, copyColor, copyLayer, copyTrigger, defaultCode, invert, pasteColor, pasteTrigger,
  planLayerPaste, rangeBetween, regionKeys, regionOf, sameColorKeys, sameRtKeys, sameTriggerKeys, slotBoundCodes,
} from './key-select'

type PerKeyTrigger = Extract<Value, { kind: 'perKeyTrigger' }>
type Keymap = Extract<Value, { kind: 'keymap' }>

const labels = (idx: number[], keys: KeyCap[] = W75_CAPS) => idx.map((i) => keys[i].label)
const pos = (l: string, nth = 0) => W75_CAPS.map((k, i) => (k.label === l ? i : -1)).filter((i) => i >= 0)[nth]

describe('regions', () => {
  it('finds the number row, arrows and modifiers on the W75', () => {
    expect(labels(regionKeys(W75_CAPS, 'Number row'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
    expect(labels(regionKeys(W75_CAPS, 'Arrows')).sort()).toEqual(['Down', 'Left', 'Right', 'Up'])
    expect(labels(regionKeys(W75_CAPS, 'Mods')).sort()).toEqual(['Alt', 'Alt', 'Ctrl', 'Ctrl', 'Shift', 'Shift', 'Win'])
    expect(regionKeys(W75_CAPS, 'Letters')).toHaveLength(26)
    expect(labels(regionKeys(W75_CAPS, 'WASD')).sort()).toEqual(['A', 'D', 'S', 'W'])
  })
  it('understands other legend styles', () => {
    const keys = ['1 !', '2@', 'F1', '↑', 'Left arrow', 'LShift', 'Right Ctrl', 'Fn', '⌘'].map((label, i) => ({ index: i, label, x: i, y: 0, w: 1, h: 1 }))
    expect(labels(regionKeys(keys, 'Number row'), keys)).toEqual(['1 !', '2@'])
    expect(labels(regionKeys(keys, 'Arrows'), keys)).toEqual(['↑', 'Left arrow'])
    expect(labels(regionKeys(keys, 'Mods'), keys)).toEqual(['LShift', 'Right Ctrl', '⌘'])
  })
  it('offers only regions the layout has and recognises the current one', () => {
    const pad = ['1', '2', 'B'].map((label, i) => ({ index: i, label, x: i, y: 0, w: 1, h: 1 }))
    expect(availableRegions(pad)).toEqual(['All', 'Letters', 'Number row', 'None'])
    expect(regionOf(pad, new Set([0, 1]))).toBe('Number row')
    expect(regionOf(pad, new Set())).toBe('None')
    expect(regionOf(pad, new Set([0, 2]))).toBeUndefined()
  })
  it('inverts', () => {
    expect([...invert(4, new Set([1, 3]))]).toEqual([0, 2])
  })
})

describe('click selection', () => {
  it('toggles with plain and Ctrl clicks and clears on empty space', () => {
    let r = clickSelect(W75_CAPS, new Set(), 5, undefined)
    expect([...r.sel]).toEqual([5])
    r = clickSelect(W75_CAPS, r.sel, 6, r.anchor, { toggle: true })
    expect([...r.sel].sort()).toEqual([5, 6])
    r = clickSelect(W75_CAPS, r.sel, 5, r.anchor, { toggle: true })
    expect([...r.sel]).toEqual([6])
    expect(clickSelect(W75_CAPS, r.sel, -1, r.anchor, { shift: true }).sel.size).toBe(1)
    expect(clickSelect(W75_CAPS, r.sel, -1, r.anchor).sel.size).toBe(0)
  })
  it('Shift-click adds the box between the anchor and the key', () => {
    const q = pos('Q'), f = pos('F')
    const r1 = clickSelect(W75_CAPS, new Set(), q, undefined)
    const r2 = clickSelect(W75_CAPS, r1.sel, f, r1.anchor, { shift: true })
    expect(labels([...r2.sel]).sort()).toEqual(['A', 'D', 'E', 'F', 'Q', 'R', 'S', 'W'])
    expect(r2.anchor).toBe(q)
    expect(labels(rangeBetween(W75_CAPS, pos('1'), pos('3')))).toEqual(['1', '2', '3'])
  })
})

const trig = (travel: number[], rapid: boolean[], sens: number[]): PerKeyTrigger => ({
  kind: 'perKeyTrigger', keys: travel.map((_, i) => ({ index: i, label: `K${i}`, x: i, y: 0, w: 1, h: 1 })),
  travel, rapid, sens, min: 0.1, max: 4, step: 0.01, sensMin: 0.01, sensMax: 2,
})

describe('same configuration', () => {
  it('groups keys by trigger settings (sensitivity only counts when RT is on)', () => {
    const pk = trig([1.2, 1.2, 1.2, 2, 1.2], [false, false, true, false, true], [0.3, 0.5, 0.3, 0.3, 0.4])
    expect(sameTriggerKeys(pk, 0)).toEqual([0, 1])
    expect(sameTriggerKeys(pk, 2)).toEqual([2])
    expect(sameTriggerKeys(pk, 3)).toEqual([3])
    expect(sameRtKeys(pk, 0)).toEqual([0, 1, 3])
    expect(sameRtKeys(pk, 4)).toEqual([4])
  })
  it('groups keys by colour', () => {
    expect(sameColorKeys([0xff0000, 0xff, 0xff0000], 2)).toEqual([0, 2])
  })
  it('reports a common value or mixed', () => {
    expect(common([0, 1], (i) => [1, 1][i])).toBe(1)
    expect(common([0, 1], (i) => [1, 2][i])).toBe('mixed')
    expect(common([], () => 1)).toBeUndefined()
  })
})

describe('copy / paste per-key settings', () => {
  it('pastes actuation + Rapid Trigger, clamped and snapped to the board', () => {
    const pk = trig([1, 1, 1], [false, false, false], [0.5, 0.5, 0.5])
    const clip = copyTrigger(trig([5.004], [true], [0.123]), 0)
    const out = pasteTrigger(pk, [0, 2, 9], clip)
    expect(out.travel).toEqual([4, 1, 4])
    expect(out.rapid).toEqual([true, false, true])
    expect(out.sens).toEqual([0.12, 0.5, 0.12])
    expect(pk.travel).toEqual([1, 1, 1])
  })
  it('pastes a colour', () => {
    const clip = copyColor(undefined, [0x123456], 0)
    expect(clip).toMatchObject({ kind: 'color', rgb: 0x123456 })
    expect(pasteColor([0, 0, 0], [1, 2], 0x123456)).toEqual([0, 0x123456, 0x123456])
  })
})

describe('keymap layers', () => {
  const km = (): Keymap => ({
    kind: 'keymap', keys: trig([1, 1, 1, 1, 1], [], []).keys, codes: 'qmk-v2',
    layers: [[0x04, 0x05, 0x7c02, 0x07, 0x08], [0x01, 0x01, 0x01, 0x7eff, 0x01]],
    locked: [[4], [3]],
    extra: [
      { id: 'default', name: 'Default', codes: [{ code: 0x7eff, id: 'D', label: 'Default', name: 'd' }] },
      { id: 'kept', name: 'Kept as is', hidden: true, codes: [{ code: 0x7c02, id: 'R', label: 'Raw', name: 'r' }] },
    ],
  })
  it('copies base to Fn, skipping locked keys and slot-bound raw codes', () => {
    const k = km()
    const r = planLayerPaste(k, copyLayer(k, 0), 1)
    expect(r.layers[1]).toEqual([0x04, 0x05, 0x01, 0x7eff, 0x01])
    expect(r.changed).toBe(2)
    expect(r.skipped).toEqual([{ pos: 2, reason: 'slot-bound' }, { pos: 3, reason: 'locked' }, { pos: 4, reason: 'source-locked' }])
    expect(r.layers[0]).toBe(k.layers[0])
  })
  it('does not put transparent keys on the base layer', () => {
    const k = km()
    const r = planLayerPaste(k, copyLayer(k, 1), 0)
    expect(r.layers[0]).toEqual([0x04, 0x05, 0x7c02, 0x07, 0x08])
    expect(r.skipped.map((s) => s.reason)).toEqual(['transparent', 'transparent', 'transparent', 'source-locked', 'locked'])
  })
  it('knows slot-bound and default codes', () => {
    expect([...slotBoundCodes(km())]).toEqual([0x7c02])
    expect(defaultCode(km())).toBe(0x7eff)
    expect(defaultCode({ ...km(), extra: undefined })).toBeUndefined()
  })
  it('works with the real W75 keymap value', () => {
    const tables = [new Uint8Array(132 * 4), new Uint8Array(132 * 4)]
    // an entry we can't re-encode on base-layer Q
    tables[0].set([0x7f, 0x7f, 0x7f, 0x7f], W75_CAPS[pos('Q')].index * 4)
    const v = keymapValue(tables, 'off')
    const q = pos('Q')
    expect(v.layers[0][q]).toBeGreaterThanOrEqual(WR_OPAQUE)
    expect(slotBoundCodes(v).has(v.layers[0][q])).toBe(true)
    const r = planLayerPaste(v, copyLayer(v, 0), 1)
    expect(r.skipped.find((s) => s.pos === q)?.reason).toBe('slot-bound')
    expect(r.layers[1][q]).toBe(v.layers[1][q])
  })
})
