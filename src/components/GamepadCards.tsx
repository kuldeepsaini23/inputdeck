// Gamepad tab cards: per-key gamepad mapping and the analog response curves (sticks / triggers).
// Generic: any driver with a 'perKeyChoice' mapping or 'gamepadCurve' settings can use them.
import { useRef, useState } from 'react'
import type { GamepadCurve, PerKeyChoice, Setting } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { Card, Segmented } from './kit'
import type { Edit } from './parts'

/** Colour of a mapped key on the board, by what it drives. */
export function targetColor(label: string): string {
  if (/^LS? [↑↓←→]$/.test(label)) return '#4587ff'
  if (/^RS? [↑↓←→]$/.test(label)) return '#b373ff'
  if (/^(LT|RT)$/.test(label)) return '#ff8c26'
  if (/D-pad|Hat/.test(label)) return '#40d9e6'
  return '#4dd980'
}

const optLabel = (v: PerKeyChoice, value: number) => v.options.find((o) => o[1] === value)?.[0] ?? `#${value}`

/** Board labels: mapped keys show their gamepad target instead of the key legend. */
export function mappedKeys(v: PerKeyChoice) {
  return v.keys.map((k, i) => (v.values[i] !== v.none ? { ...k, label: optLabel(v, v.values[i]) } : k))
}

export function GamepadMapCard({ v, sel, onChange, className }: { v: PerKeyChoice; sel?: number; onChange: (nv: PerKeyChoice) => void; className?: string }) {
  const set = (value: number) => {
    if (sel === undefined) return
    const values = v.values.slice()
    values[sel] = value
    onChange({ ...v, values })
  }
  const used = v.values.filter((x) => x !== v.none).length
  const cur = sel === undefined ? undefined : v.values[sel]
  return (
    <Card title={sel === undefined ? 'Gamepad mapping' : `Key ${v.keys[sel]?.label || ''} drives`} className={className}
      right={used > 0 && (
        <button type="button" className="chip !text-[11px]" onClick={() => onChange({ ...v, values: v.values.map(() => v.none) })}>Clear all ({used})</button>
      )}>
      {sel === undefined ? (
        <p className="hint m-0">Click a key on the board, then pick the controller button or stick direction it drives. {used ? `${used} key${used === 1 ? '' : 's'} mapped.` : 'No keys mapped yet.'}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {v.options.map(([l, val]) => (
            <button key={val} type="button" aria-pressed={cur === val} onClick={() => set(val)}
              className={cn('chip !px-2.5 !py-1 !text-[11px]', cur === val && 'plat !border-transparent')}
              style={val !== v.none && cur !== val ? { boxShadow: `inset 3px 0 0 ${targetColor(l)}` } : undefined}>
              {l}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---- curve editor

const W = 320, H = 170, L = 34, R = 10, T = 10, Bm = 26

function CurveChart({ v, onChange }: { v: GamepadCurve; onChange: (pts: GamepadCurve['points']) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<number | undefined>(undefined)
  const px = (x: number) => L + (x / v.maxX) * (W - L - R)
  const py = (y: number) => T + (1 - y / v.maxY) * (H - T - Bm)
  const pts = v.points
  const move = (e: React.PointerEvent) => {
    if (drag === undefined || !svg.current) return
    const r = svg.current.getBoundingClientRect()
    const sx = ((e.clientX - r.left) / r.width) * W
    const sy = ((e.clientY - r.top) / r.height) * H
    const lo = drag > 0 ? pts[drag - 1].x : 0
    const hi = drag < pts.length - 1 ? pts[drag + 1].x : v.maxX
    const raw = ((sx - L) / (W - L - R)) * v.maxX
    const x = Math.min(hi, Math.max(lo, Math.round(raw / v.stepX) * v.stepX))
    const y = Math.round(Math.min(v.maxY, Math.max(0, (1 - (sy - T) / (H - T - Bm)) * v.maxY)))
    const next = pts.map((p, i) => (i === drag ? { x: Number(x.toFixed(3)), y } : p))
    if (next[drag].x !== pts[drag].x || next[drag].y !== pts[drag].y) onChange(next)
  }
  const line = [`M ${px(0)} ${py(0)}`, ...pts.map((p) => `L ${px(p.x)} ${py(p.y)}`), `L ${px(v.maxX)} ${py(pts[pts.length - 1]?.y ?? 0)}`].join(' ')
  const ticks = Array.from({ length: Math.floor(v.maxX) + 1 }, (_, i) => i)
  return (
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" onPointerMove={move} onPointerUp={() => setDrag(undefined)} onPointerLeave={() => setDrag(undefined)}
      role="img" aria-label="Response curve: key travel to output">
      <rect x={L} y={T} width={W - L - R} height={H - T - Bm} rx={6} fill="rgb(255 255 255 / 0.03)" stroke="rgb(255 255 255 / 0.08)" />
      {pts[0] && pts[0].x > 0 && <rect x={L} y={T} width={px(pts[0].x) - L} height={H - T - Bm} fill="rgb(255 255 255 / 0.05)" />}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={px(t)} x2={px(t)} y1={T} y2={H - Bm} stroke="rgb(255 255 255 / 0.06)" />
          <text x={px(t)} y={H - Bm + 13} fontSize={9} textAnchor="middle" fill="rgb(255 255 255 / 0.4)">{t} mm</text>
        </g>
      ))}
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={L - 5} y={py(f * v.maxY) + 3} fontSize={9} textAnchor="end" fill="rgb(255 255 255 / 0.4)">{Math.round(f * v.maxY)}</text>
      ))}
      <path d={`${line} L ${px(v.maxX)} ${py(0)} Z`} fill="rgb(230 232 236 / 0.08)" />
      <path d={line} fill="none" stroke="#E6E8EC" strokeWidth={2} strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={px(p.x)} cy={py(p.y)} r={drag === i ? 7 : 6} fill={drag === i ? '#E6E8EC' : '#141416'} stroke="#E6E8EC" strokeWidth={2} className="cursor-grab"
          onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i) }}>
          <title>{`Point ${i + 1}: ${p.x.toFixed(2)} mm → ${p.y}`}</title>
        </circle>
      ))}
    </svg>
  )
}

const samePts = (a: GamepadCurve['points'], b: GamepadCurve['points']) => a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && p.y === b[i].y)

/** One card for every 'gamepadCurve' setting: pick a curve, drag its points or apply a preset. */
export function CurveCard({ curves, onEdit, className }: { curves: Setting[]; onEdit: Edit; className?: string }) {
  const [pick, setPick] = useState(0)
  const i = Math.min(pick, curves.length - 1)
  const s = curves[i]
  if (!s || s.value.kind !== 'gamepadCurve') return null
  const v = s.value
  const set = (points: GamepadCurve['points']) => onEdit(s.key, { ...v, points })
  const preset = v.presets?.find((p) => samePts(p.points, v.points))?.name
  return (
    <Card title="Response curve" className={className}
      right={curves.length > 1 && (
        <Segmented label="Curve" className="[&_button]:!px-2.5 [&_button]:!py-1 [&_button]:!text-[11px]" value={i}
          options={curves.map((c, n) => [c.label.replace(/ curve$/, ''), n] as const)} onChange={setPick} />
      )}>
      <CurveChart v={v} onChange={set} />
      <div className="mt-2 grid grid-cols-4 gap-2 text-center">
        {v.points.map((p, n) => (
          <div key={n} className="recess rounded-xl px-1 py-1.5">
            <div className="eyebrow !text-[9px]">{n === 0 ? 'Start' : `P${n + 1}`}</div>
            <div className="display text-[11px]">{p.x.toFixed(2)} mm · {p.y}</div>
          </div>
        ))}
      </div>
      {v.presets && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {v.presets.map((p) => (
            <button key={p.name} type="button" aria-pressed={preset === p.name} onClick={() => set(p.points)}
              className={cn('chip !px-2.5 !py-1 !text-[11px]', preset === p.name && 'plat !border-transparent')}>{p.name}</button>
          ))}
        </div>
      )}
      <p className="hint mt-3 mb-0">Key press depth (mm) → output (0–{v.maxY}). Before the first point the key does nothing (start dead zone).</p>
    </Card>
  )
}
