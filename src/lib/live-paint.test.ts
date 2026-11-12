import { afterEach, describe, expect, it } from 'vitest'
import { cellsFor, loadDesign } from './live-paint'

describe('live per-key painting', () => {
  it('each grid cell gets the colour of the key it lights; cells without a key stay off', () => {
    // 1 x 4 grid: cell 0 -> key 2, cell 1 -> no LED, cell 2 -> key 0, cell 3 -> key 1
    const l = { rows: 1, cols: 4, map: [2, undefined, 0, 1] }
    expect(cellsFor(l, [0xff0000, 0x00ff00, 0x0000ff])).toEqual([0x0000ff, 0, 0xff0000, 0x00ff00])
  })

  describe('design storage', () => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    afterEach(() => store.clear())

    it('a new device starts off, all keys white', () => {
      expect(loadDesign('260d:0175', 3)).toEqual({ on: false, colors: [0xffffff, 0xffffff, 0xffffff] })
    })
    it('a saved design comes back, resized to the layout', () => {
      store.set('inputdeck.livepaint.260d:0175', JSON.stringify({ on: true, colors: [0x112233, 'x', 0x1ffffff] }))
      expect(loadDesign('260d:0175', 4)).toEqual({ on: true, colors: [0x112233, 0, 0xffffff, 0] })
    })
    it('bad data is ignored', () => {
      store.set('inputdeck.livepaint.260d:0175', '{oops')
      expect(loadDesign('260d:0175', 2).on).toBe(false)
    })
  })
})
