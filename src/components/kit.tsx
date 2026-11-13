// Concept v3 control kit: glass cards, recessed segmented buttons, metal switches and sliders.
// Built on Radix primitives (via shadcn) for keyboard and screen-reader support.
import { Slider as SliderPrimitive, Switch as SwitchPrimitive } from 'radix-ui'
import { ChevronDown } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select'
import { cn } from '#/lib/utils'
import { useT } from '#/lib/i18n'
import type { Value } from '#/drivers/types'

export type Choice = Extract<Value, { kind: 'choice' }>

export const hex = (n: number) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase()
export const fromHex = (s: string) => parseInt(s.replace('#', ''), 16) >>> 0

export function Card({ title, right, children, className, style }: {
  title?: React.ReactNode
  right?: React.ReactNode
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <section className={cn('glass fade-in p-[21px] pt-[19px]', className)} style={style}>
      {(title || right) && (
        <div className="mb-2.5 flex min-h-[18px] items-center justify-between gap-3">
          {title && <h3 className="eyebrow m-0">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function BigValue({ value, unit, size = 34, className }: { value: React.ReactNode; unit?: string; size?: number; className?: string }) {
  return (
    <div className={cn('flex items-baseline gap-1.5', className)}>
      <span key={String(value)} className="big-num num-anim" style={{ fontSize: size }}>{value}</span>
      {unit && <span className="unit" style={{ fontSize: Math.max(11, Math.round(size * 0.41)) }}>{unit}</span>}
    </div>
  )
}

export function Segmented<T extends string | number>({ options, value, onChange, label, className, disabled }: {
  options: readonly (readonly [string, T])[]
  value: T | undefined
  onChange: (v: T) => void
  label: string
  className?: string
  disabled?: boolean
}) {
  const t = useT()
  return (
    <div role="group" aria-label={label} className={cn('seg recess', className)}>
      {options.map(([l, v]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)} className="whitespace-nowrap">
          {t(l)}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <SwitchPrimitive.Root className="toggle" checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
}

export function Range({ min, max, step = 1, value, onChange, label, className }: {
  min: number
  max: number
  step?: number
  value: number
  onChange: (v: number) => void
  label: string
  className?: string
}) {
  const v = Math.min(max, Math.max(min, value))
  return (
    <SliderPrimitive.Root className={cn('range', className)} min={min} max={max} step={step} value={[v]} onValueChange={([n]) => onChange(n)}>
      <SliderPrimitive.Track className="track">
        <SliderPrimitive.Range className="fill" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="thumb" aria-label={label} />
    </SliderPrimitive.Root>
  )
}

/** Dropdown for a driver "choice" value. Works for any number of options. */
export function ChoiceSelect({ v, onChange, label, className }: { v: Choice; onChange: (c: number) => void; label: string; className?: string }) {
  const t = useT()
  return (
    <Select value={String(v.current)} onValueChange={(s) => onChange(Number(s))}>
      <SelectTrigger aria-label={label} className={cn('select-trigger raised !h-11 !w-full !rounded-[14px] [&>svg:last-child]:hidden', className)}>
        <SelectValue />
        <ChevronDown className="size-4 opacity-60" />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={6} className="scroll-thin max-h-80 rounded-2xl border-white/10 bg-[#121214]/95 backdrop-blur-xl">
        {v.options.map(([l, val]) => (
          <SelectItem key={val} value={String(val)} className="rounded-lg py-2 text-[13px]">
            {t(l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const t = useT()
  const btn = 'raised grid size-8 place-items-center rounded-full text-sm disabled:opacity-30'
  return (
    <div className="flex items-center gap-4" role="group" aria-label={label}>
      <button type="button" className={btn} aria-label={t('Fewer {thing}', { thing: label.toLowerCase() })} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span className="big-num w-7 text-center" style={{ fontSize: 26 }}>{value}</span>
      <button type="button" className={btn} aria-label={t('More {thing}', { thing: label.toLowerCase() })} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  )
}

export const SWATCHES = [0xff4545, 0xff8c26, 0xffd140, 0x4dd980, 0x40d9e6, 0x4587ff, 0xb373ff, 0xff66bf, 0xffffff]

export function ColorPicker({ value, onChange, label }: { value: number | null; onChange: (c: number) => void; label: string }) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {SWATCHES.map((c) => (
        <button key={c} type="button" className="swatch" style={{ background: hex(c), boxShadow: value === c ? `0 0 12px ${hex(c)}` : undefined }}
          aria-label={`${label} ${hex(c)}`} aria-pressed={value === c} onClick={() => onChange(c)} />
      ))}
      <label className="relative ml-1 flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-3)]">
        <span className="swatch inline-block" style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} />
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('Custom {thing}', { thing: label.toLowerCase() })}
          value={value === null ? '#ffffff' : hex(value).toLowerCase()} onChange={(e) => onChange(fromHex(e.target.value))} />
        {value === null ? t('Mixed') : hex(value)}
      </label>
    </div>
  )
}

/** A label + hint on the left, a control on the right. Used for lists of switches. */
export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-2.5 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}
