import type { Setting, Value } from '#/drivers/types'
import { BigValue, Card, ChoiceSelect, ColorPicker, Range, Row, Segmented, Toggle } from './kit'

export type Edit = (key: string, v: Value) => void

export const shortHz = (label: string) => label.replace(/\s*Hz/i, '').replace(/^(\d+)000$/, '$1K')

export function Hero({ brand, label, value, unit, sub, size = 112, children, live }: {
  brand: string
  label: string
  value: React.ReactNode
  unit?: string
  sub?: React.ReactNode
  size?: number
  children?: React.ReactNode
  /** value changes many times a second: don't animate it */
  live?: boolean
}) {
  return (
    <div className="fade-in">
      <div className="display text-[10px] tracking-[0.18em] text-[var(--plat)]">{brand}</div>
      <div className="eyebrow mt-6">{label}</div>
      <div className="mt-1 flex items-baseline gap-2.5">
        <span key={live ? 'live' : String(value)} className={live ? 'big-num whitespace-nowrap tabular-nums' : 'big-num num-anim whitespace-nowrap'} style={{ letterSpacing: '-0.04em', fontSize: `clamp(${Math.round(size * 0.55)}px, ${size / 14}vw, ${size}px)` }}>{value}</span>
        {unit && <span className="display text-[16px] font-medium tracking-[0.045em] text-[var(--plat)]">{unit}</span>}
      </div>
      {children}
      {sub && <div className="mt-3 text-[12.5px] leading-relaxed text-[var(--text-3)]">{sub}</div>}
    </div>
  )
}

export function MiniStats({ items }: { items: [string, string | undefined, string?][] }) {
  const shown = items.filter(([, v]) => v)
  if (!shown.length) return null
  return (
    <dl className="m-0 flex flex-wrap gap-9">
      {shown.map(([k, v, u]) => (
        <div key={k}>
          <dt className="eyebrow">{k}</dt>
          <dd className="m-0 mt-1.5 flex items-baseline gap-1">
            <span key={v} className="display num-anim text-[24px] font-medium">{v}</span>
            {u && <span className="unit text-[12px]">{u}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Decorative report pulse: denser bars for a higher rate. */
export function Pulse({ rate, width = 150 }: { rate: number; width?: number }) {
  const n = Math.round(Math.min(48, Math.max(8, Math.log2(Math.max(rate, 125) / 125) * 7 + 10)) * (width / 150))
  const gap = width / n
  return (
    <svg width={width} height={40} viewBox={`0 0 ${width} 40`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const h = 10 + Math.abs(Math.sin(i * 0.9)) * 6 + (i % 3) * 3
        return <rect key={i} x={i * gap} y={40 - h} width={Math.min(2.2, gap * 0.6)} height={h} rx={1} fill="#E6E8EC" fillOpacity={0.2 + (i / n) * 0.75} />
      })}
    </svg>
  )
}

const short = (opts: [string, number][]) => opts.length <= 7 && opts.every(([l]) => l.length <= 8)

/** Renders any driver setting with a fitting control. Used where a screen has no custom card. */
export function SettingControl({ s, onEdit }: { s: Setting; onEdit: Edit }) {
  const v = s.value
  switch (v.kind) {
    case 'toggle':
      return <Row label={s.label} hint={s.hint}><Toggle label={s.label} checked={v.on} onChange={(on) => onEdit(s.key, { ...v, on })} /></Row>
    case 'text':
      return <Row label={s.label}><span className="text-right text-[12.5px] text-[var(--text-2)]">{v.text}</span></Row>
    case 'choice':
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 text-[13px]">{s.label}</div>
          {short(v.options) ? (
            <Segmented label={s.label} options={v.options} value={v.current} onChange={(c) => onEdit(s.key, { ...v, current: c })} />
          ) : (
            <ChoiceSelect label={s.label} v={v} onChange={(c) => onEdit(s.key, { ...v, current: c })} />
          )}
        </div>
      )
    case 'number':
    case 'float': {
      const step = v.kind === 'float' ? v.step : 1
      const fmt = (n: number) => (v.kind === 'float' ? n.toFixed(2) : String(n))
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 flex items-baseline justify-between"><span className="text-[13px]">{s.label}</span><BigValue value={fmt(v.current)} unit={v.unit.trim()} size={16} /></div>
          <Range label={s.label} min={v.min} max={v.max} step={step} value={v.current} onChange={(n) => onEdit(s.key, { ...v, current: n })} />
        </div>
      )
    }
    case 'color':
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 text-[13px]">{s.label}</div>
          <ColorPicker label={s.label} value={v.rgb} onChange={(rgb) => onEdit(s.key, { ...v, rgb })} />
        </div>
      )
    default:
      return null
  }
}

export function GenericCard({ title, settings, onEdit, className }: { title: string; settings: Setting[]; onEdit: Edit; className?: string }) {
  if (!settings.length) return null
  return (
    <Card title={title} className={className}>
      {settings.map((s) => <SettingControl key={s.key} s={s} onEdit={onEdit} />)}
    </Card>
  )
}
