import { describe, expect, it } from 'vitest'
import { COALESCE_MS, History, MAX_STEPS } from './history'
import type { Value } from '#/drivers/types'

const n = (current: number): Value => ({ kind: 'number', min: 0, max: 100, current, unit: '' })
const ch = (key: string, a: number, b: number) => [{ key, before: n(a), after: n(b) }]

describe('History', () => {
  it('undoes and redoes a step', () => {
    const h = new History()
    expect(h.canUndo).toBe(false)
    h.record(ch('lod', 1, 2), 0)
    expect(h.canUndo).toBe(true)
    const u = h.undo()!
    expect(u.changes[0].before).toEqual(n(1))
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(true)
    expect(h.redo()!.changes[0].after).toEqual(n(2))
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe(u)
  })

  it('merges quick edits of the same setting (slider drag) into one step', () => {
    const h = new History()
    h.record(ch('dpi', 10, 11), 0)
    h.record(ch('dpi', 11, 12), 300)
    h.record(ch('dpi', 12, 13), 600)
    h.record(ch('dpi', 13, 14), 1300) // 700 ms after the last: still the same drag
    expect(h.size.undo).toBe(1)
    const s = h.undo()!
    expect(s.changes[0].before).toEqual(n(10))
    expect(s.changes[0].after).toEqual(n(14))
  })

  it('starts a new step after a pause or for another setting', () => {
    const h = new History()
    h.record(ch('dpi', 10, 11), 0)
    h.record(ch('dpi', 11, 12), COALESCE_MS + 1)
    h.record(ch('lod', 1, 2), COALESCE_MS + 2)
    h.record(ch('dpi', 12, 13), COALESCE_MS + 3)
    expect(h.size.undo).toBe(4)
  })

  it('drops a step dragged back to where it started, and no-op edits', () => {
    const h = new History()
    h.record(ch('dpi', 10, 10), 0)
    expect(h.canUndo).toBe(false)
    h.record(ch('dpi', 10, 12), 0)
    h.record(ch('dpi', 12, 10), 100)
    expect(h.canUndo).toBe(false)
  })

  it('a new edit clears redo, and never merges into an undone/redone step', () => {
    const h = new History()
    h.record(ch('dpi', 1, 2), 0)
    h.record(ch('dpi', 2, 3), 2000)
    h.undo()
    h.record(ch('dpi', 2, 5), 2100)
    expect(h.canRedo).toBe(false)
    expect(h.size.undo).toBe(2)
    expect(h.undo()!.changes[0]).toEqual({ key: 'dpi', before: n(2), after: n(5) })
  })

  it('keeps multi-setting steps (imports) whole', () => {
    const h = new History()
    h.record([...ch('a', 1, 2), ...ch('b', 3, 4), ...ch('c', 5, 5)], 0)
    h.record(ch('a', 2, 3), 10)
    expect(h.size.undo).toBe(2)
    h.undo()
    expect(h.undo()!.changes.map((c) => c.key)).toEqual(['a', 'b'])
  })

  it('caps the stack and clears', () => {
    const h = new History()
    for (let i = 0; i < MAX_STEPS + 20; i++) h.record(ch('k' + i, 0, 1), i * 1000)
    expect(h.size.undo).toBe(MAX_STEPS)
    h.undo()
    h.clear()
    expect(h.size).toEqual({ undo: 0, redo: 0 })
  })
})
