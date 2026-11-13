import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyCap } from '#/drivers/types'
import { useT } from '#/lib/i18n'

const U = 44 // px per key unit before scaling
const PAD = 22
const GAP = 5

export interface KeyLook {
  /** keycap colour (lighting); undefined = plain dark cap */
  color?: string
  /** 0..1 brightness of a travel tint (switches view) */
  tint?: number
  rt?: boolean
  /** live test: 0..1 of full travel */
  press?: number
  /** live test: pressed past its actuation point */
  fired?: boolean
  /** small corner dot (e.g. key remapped this session) */
  dot?: boolean
  /** faded legend (e.g. a transparent key showing the layer below) */
  dim?: boolean
  /** tooltip */
  title?: string
}

/**
 * The real key layout from the driver, drawn as sculpted keycaps and scaled to fit.
 * Click toggles a key, dragging selects a box of keys.
 */
export function KeyboardView({ keys, looks, selected, onSelect, interactive, knob, maxWidth }: {
  keys: KeyCap[]
  looks: KeyLook[]
  selected: Set<number>
  onSelect?: (s: Set<number>) => void
  interactive: boolean
  knob?: { x: number; y: number }
  maxWidth: number
}) {
  const t = useT()
  const wrap = useRef<HTMLDivElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(maxWidth)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const cols = Math.max(...keys.map((k) => k.x + k.w))
  const rows = Math.max(...keys.map((k) => k.y + k.h))
  const w = Math.max(cols, knob ? knob.x + 1 : 0) * U + PAD * 2
  const h = rows * U + PAD * 2
  const keyRect = (k: KeyCap) => ({ left: k.x * U + PAD, top: k.y * U + PAD, width: k.w * U - GAP, height: k.h * U - GAP })

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setFit(Math.min(maxWidth, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxWidth])
  const scale = fit / w

  const local = (e: React.PointerEvent) => {
    const r = board.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const onDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0) return
    const p = local(e)
    setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    board.current!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!box) return
    const p = local(e)
    setBox({ ...box, x1: p.x, y1: p.y })
  }
  const onUp = () => {
    if (!box || !onSelect) return setBox(null)
    const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)]
    const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)]
    const next = new Set(selected)
    if (x1 - x0 < 4 && y1 - y0 < 4) {
      const i = keys.findIndex((k) => {
        const r = keyRect(k)
        return x0 >= r.left && x0 <= r.left + r.width && y0 >= r.top && y0 <= r.top + r.height
      })
      if (i < 0) next.clear()
      else if (next.has(i)) next.delete(i)
      else next.add(i)
    } else {
      keys.forEach((k, i) => {
        const r = keyRect(k)
        if (r.left < x1 && r.left + r.width > x0 && r.top < y1 && r.top + r.height > y0) next.add(i)
      })
    }
    setBox(null)
    onSelect(next)
  }
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (!interactive || !onSelect || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    onSelect(next)
  }

  return (
    <div ref={wrap} className="w-full" style={{ maxWidth, height: h * scale }}>
      <div
        ref={board}
        className="kb origin-top-left"
        style={{ width: w, height: h, transform: `scale(${scale})`, cursor: interactive ? 'crosshair' : 'default' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        role={interactive ? 'group' : undefined}
        aria-label={interactive ? t('Keyboard keys, select keys to edit') : t('Keyboard')}
      >
        <div className="plate" style={{ left: PAD - 6, top: PAD - 6, width: cols * U - GAP + 12, height: rows * U - GAP + 12 }} />
        {keys.map((k, i) => {
          const look = looks[i] ?? {}
          const r = keyRect(k)
          const style: React.CSSProperties = { ...r }
          if (look.color) {
            style.background = `linear-gradient(180deg, ${look.color}, color-mix(in srgb, ${look.color} 62%, #000))`
            style.boxShadow = `inset 0 -5px 3px rgb(0 0 0 / 0.45), inset 0 1px 0 rgb(255 255 255 / 0.25), 0 1.5px 1px rgb(0 0 0 / 0.9), 0 2px 12px color-mix(in srgb, ${look.color} 55%, transparent)`
            style.color = lightColour(look.color) ? '#111' : '#fff'
          } else if (look.tint !== undefined) {
            const a = (0.04 + 0.4 * look.tint).toFixed(3)
            style.background = `linear-gradient(180deg, rgb(201 206 214 / ${a}), rgb(201 206 214 / ${(+a * 0.5).toFixed(3)})), linear-gradient(180deg, #26262b, #161619)`
          }
          return (
            <div
              key={i}
              className={'key' + (selected.has(i) ? ' sel' : '') + (look.fired ? ' fired' : '')}
              style={style}
              tabIndex={interactive ? 0 : -1}
              role={interactive ? 'checkbox' : undefined}
              aria-checked={interactive ? selected.has(i) : undefined}
              aria-label={look.title ?? k.label}
              title={look.title}
              onKeyDown={(e) => onKey(e, i)}
            >
              {look.press !== undefined && look.press > 0.01 && <span className="press" style={{ height: `${Math.min(1, look.press) * 100}%` }} />}
              <span className="relative" style={look.dim ? { opacity: 0.35 } : undefined}>{k.label}</span>
              {(look.rt || look.dot) && <span className="rt" />}
            </div>
          )
        })}
        {knob && <div className="knob" style={{ left: knob.x * U + PAD + 2, top: knob.y * U + PAD, width: U - GAP - 4, height: U - GAP - 4 }} />}
        {box && (
          <div className="marquee" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />
        )}
      </div>
    </div>
  )
}

/** true for bright keycap colours (white, yellow, cyan…) that need a dark legend */
export function lightColour(css: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  return 0.299 * r + 0.587 * g + 0.114 * b > 170
}
