import type { Setting, Value } from '#/drivers/types'
import { useT } from '#/lib/i18n'
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
  const t = useT()
  const shown = items.filter(([, v]) => v)
  if (!shown.length) return null
  return (
    <dl className="m-0 flex flex-wrap gap-9">
      {shown.map(([k, v, u]) => (
        <div key={k}>
          <dt className="eyebrow">{t(k)}</dt>
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

// decided on the English labels so the control type doesn't change with the language
const short = (opts: [string, number][]) => opts.length <= 7 && opts.every(([l]) => l.length <= 8)

/** Renders any driver setting with a fitting control. Used where a screen has no custom card. */
export function SettingControl({ s, onEdit: edit }: { s: Setting; onEdit: Edit }) {
  const t = useT()
  const v = s.value
  // driver text is English; translate it for display (unknown text stays English)
  const label = t(s.label)
  const hint = s.hint ? t(s.hint) : undefined
  // settings that restart the device etc. ask first
  const onEdit: Edit = (k, nv) => {
    if (s.confirm && !window.confirm(t(s.confirm))) return
    edit(k, nv)
  }
  switch (v.kind) {
    case 'toggle':
      return <Row label={label} hint={hint}><Toggle label={label} checked={v.on} onChange={(on) => onEdit(s.key, { ...v, on })} /></Row>
    case 'text':
      return <Row label={label}><span className="text-right text-[12.5px] text-[var(--text-2)]">{v.text}</span></Row>
    case 'choice':
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 text-[13px]">{label}</div>
          {short(v.options) ? (
            <Segmented label={label} options={v.options} value={v.current} onChange={(c) => onEdit(s.key, { ...v, current: c })} className="no-scrollbar max-w-full overflow-x-auto" />
          ) : (
            <ChoiceSelect label={label} v={v} onChange={(c) => onEdit(s.key, { ...v, current: c })} />
          )}
          {hint && <p className="hint mt-2 mb-0">{hint}</p>}
        </div>
      )
    case 'number':
    case 'float': {
      const step = v.kind === 'float' ? v.step : 1
      const fmt = (n: number) => (v.kind === 'float' ? n.toFixed(2) : String(n))
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 flex items-baseline justify-between"><span className="text-[13px]">{label}</span><BigValue value={fmt(v.current)} unit={v.unit.trim()} size={16} /></div>
          <Range label={label} min={v.min} max={v.max} step={step} value={v.current} onChange={(n) => onEdit(s.key, { ...v, current: n })} />
        </div>
      )
    }
    case 'color':
      return (
        <div className="border-b border-white/5 py-3 last:border-0">
          <div className="mb-2 text-[13px]">{label}</div>
          <ColorPicker label={label} value={v.rgb} onChange={(rgb) => onEdit(s.key, { ...v, rgb })} />
        </div>
      )
    default:
      return null
  }
}

export function GenericCard({ title, settings, onEdit, className }: { title: string; settings: Setting[]; onEdit: Edit; className?: string }) {
  const t = useT()
  if (!settings.length) return null
  return (
    <Card title={t(title)} className={className}>
      {settings.map((s) => <SettingControl key={s.key} s={s} onEdit={onEdit} />)}
    </Card>
  )
}
