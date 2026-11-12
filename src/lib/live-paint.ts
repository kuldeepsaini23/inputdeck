// Per-key colours painted on the page and streamed to boards with Driver.liveLight.
// The keyboard can't store them, so the design is remembered here (per device, in this browser)
// and sent again whenever the page opens the device with live painting switched on.
import { useEffect, useMemo, useState } from 'react'
import type { DeviceState } from '#/devices'
import type { LiveLight } from '#/drivers/types'

export interface LiveDesign {
  on: boolean
  /** colour per layout key position (0 = off) */
  colors: number[]
}

const KEY = 'inputdeck.livepaint.'

export function loadDesign(id: string, n: number): LiveDesign {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + id) ?? 'null') as Partial<LiveDesign> | null
    if (v && Array.isArray(v.colors)) {
      const colors = Array.from({ length: n }, (_, i) => (typeof v.colors![i] === 'number' ? v.colors![i] & 0xffffff : 0))
      return { on: !!v.on, colors }
    }
  } catch {
    /* storage blocked or bad data: start fresh */
  }
  return { on: false, colors: new Array<number>(n).fill(0xffffff) }
}

function saveDesign(id: string, d: LiveDesign) {
  try {
    localStorage.setItem(KEY + id, JSON.stringify(d))
  } catch {
    /* storage blocked: the design lasts for this visit only */
  }
}

/** The frame for the device: each grid cell gets the colour of the key it lights (0 for cells without a key). */
export function cellsFor(l: Pick<LiveLight, 'rows' | 'cols' | 'map'>, colors: number[]): number[] {
  return Array.from({ length: l.rows * l.cols }, (_, c) => {
    const pos = l.map?.[c]
    return pos === undefined ? 0 : colors[pos] ?? 0
  })
}

// one queue per device so start/frame/stop never overlap (fast clicks, re-renders)
const queues = new WeakMap<LiveLight, Promise<unknown>>()
function enqueue(l: LiveLight, fn: () => Promise<void>): Promise<void> {
  const run = (queues.get(l) ?? Promise.resolve()).then(fn, fn)
  queues.set(l, run.catch(() => undefined))
  return run
}

export function useLivePaint(dev: DeviceState, canWrite: boolean) {
  const l = dev.driver.liveLight
  const usable = !!l && !l.experimental && !!l.map
  const n = dev.driver.layout?.().length ?? 0
  const [state, setState] = useState<{ id: string; d: LiveDesign } | undefined>(undefined)
  const loaded = useMemo(() => loadDesign(dev.id, n), [dev.id, n])
  const d = state?.id === dev.id ? state.d : loaded
  const [err, setErr] = useState<string>()

  useEffect(() => {
    if (!l || !usable || !canWrite) return
    void enqueue(l, async () => {
      try {
        if (d.on) {
          if (!l.active) await l.start()
          await l.frame(cellsFor(l, d.colors))
        } else if (l.active) {
          await l.stop()
        }
        setErr(undefined)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })
  }, [l, usable, canWrite, d])

  const update = (next: LiveDesign) => {
    setState({ id: dev.id, d: next })
    saveDesign(dev.id, next)
  }
  return {
    usable,
    on: usable && d.on,
    colors: d.colors,
    err,
    setOn: (on: boolean) => update({ ...d, on }),
    /** colour some keys (all keys when `keys` is empty) */
    paint: (keys: number[], rgb: number) => {
      const colors = d.colors.slice()
      for (const k of keys.length ? keys : colors.map((_, i) => i)) colors[k] = rgb & 0xffffff
      update({ ...d, colors })
    },
  }
}
export type LivePaint = ReturnType<typeof useLivePaint>
