// Macros tab on the keyboard and mouse pages: slot list, step editor (chips) with recording, byte usage.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Circle, Plus, Square, Trash2, X } from 'lucide-react'
import type { MacroFormat, MacroStep } from '#/drivers/types'
import { categories, describe, search, type Keycode } from '#/lib/keycodes'
import {
  MAX_DELAY, MOUSE_BUTTONS, fits, hidFromCode, insertSteps, keyOk, macroProblem, macroSize, macroSummary, moveStep, normalize,
  removeStep, slotName, stepProblem, stepText, stepsFromRecording, textCharOk, usedBytes, withMacro, type Macros, type RecordedKey,
} from '#/lib/macros'
import { cn } from '#/lib/utils'
import { Card, Segmented } from './kit'

/** Keys a macro can press: basic HID usages only (QMK stores 8-bit keycodes in macros). */
const KEY_CATS = ['basic', 'mods', 'nav', 'fkeys', 'numpad', 'media']

/** List of macro slots (M0…, or the device's own slot names). */
export function MacroList({ v, slot, onSelect, hint = 'Put a macro on a key in the Keys tab.' }: { v: Macros; slot: number; onSelect: (n: number) => void; hint?: string }) {
  const named = !!v.slotNames
  return (
    <Card title={`Macros · ${v.slots} slot${v.slots === 1 ? '' : 's'}`}>
      <div className="scroll-thin -mr-1 flex max-h-[300px] flex-col gap-1.5 overflow-y-auto pr-1" role="radiogroup" aria-label="Macro slot">
        {v.macros.map((m, i) => (
          <button key={i} type="button" role="radio" aria-checked={i === slot} onClick={() => onSelect(i)}
            className={cn('flex h-11 shrink-0 items-center gap-3 rounded-[12px] px-3 text-left', i === slot ? 'plat' : 'raised text-[var(--text-2)]')}>
            <span className={cn('display shrink-0 truncate text-[12px] font-semibold', named ? 'max-w-[45%]' : 'w-8')}>{slotName(v, i)}</span>
            <span className={cn('min-w-0 flex-1 truncate text-[11px]', i === slot ? 'opacity-70' : m.length ? '' : 'text-[var(--text-4)]')}>{macroSummary(m)}</span>
          </button>
        ))}
      </div>
      <p className="hint mt-3 mb-0">{hint}</p>
    </Card>
  )
}

/** Bytes used by all macros vs. the keyboard's macro storage. */
export function UsageBar({ v }: { v: Macros }) {
  const used = usedBytes(v)
  if (used === undefined || !v.maxBytes) return null
  const pct = Math.min(100, (used / v.maxBytes) * 100)
  const over = used > v.maxBytes
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Storage</span>
        <span className={cn('display text-[11px]', over ? 'text-[var(--warn)]' : 'text-[var(--text-2)]')}>{used} / {v.maxBytes} bytes</span>
      </div>
      <div className="recess mt-2 h-2 overflow-hidden rounded-full" role="meter" aria-label="Macro storage used" aria-valuemin={0} aria-valuemax={v.maxBytes} aria-valuenow={used}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: over ? 'var(--warn)' : 'linear-gradient(90deg, rgb(193 196 203 / 0.35), var(--plat))' }} />
      </div>
    </div>
  )
}

/** Editor for one macro: step chips, recording, add key / delay / text. */
export function MacroEditor({ v, slot, onChange, className }: {
  v: Macros
  slot: number
  onChange: (v: Macros) => void
  className?: string
}) {
  const steps = v.macros[slot] ?? []
  const format = v.format ?? 'qmk'
  const delays = v.delays !== false
  const texts = v.text !== false
  const mouse = !!v.mouse
  const name = slotName(v, slot)
  const [sel, setSel] = useState<number | undefined>(undefined)
  const [adding, setAdding] = useState<Adding | undefined>(undefined)
  const [recording, setRecording] = useState(false)
  const [recDelays, setRecDelays] = useState(true)
  const [rec, setRec] = useState<RecordedKey[]>([])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const selIdx = sel !== undefined && sel < steps.length ? sel : undefined

  useEffect(() => {
    setSel(undefined)
    setRecording(false)
    setProblem(undefined)
  }, [slot])

  /** Replace this macro's steps, refusing changes that don't fit the keyboard. */
  const commit = (next: MacroStep[], select?: number) => {
    const nv = withMacro(v, slot, next)
    const bad = next.map((s) => stepProblem(s, format)).find(Boolean) ?? macroProblem(next, format)
    if (bad) return setProblem(bad)
    if (!fits(nv)) {
      const per = v.maxPerMacro !== undefined && (macroSize(next, format) ?? 0) > v.maxPerMacro
      return setProblem(per
        ? `That doesn't fit: one macro can use ${v.maxPerMacro} bytes on this ${mouse ? 'mouse' : 'keyboard'}.`
        : `That doesn't fit: the ${mouse ? 'mouse' : 'keyboard'} has room for ${v.maxBytes} bytes of macros.`)
    }
    setProblem(undefined)
    onChange(nv)
    setSel(select)
  }
  const at = selIdx === undefined ? steps.length : selIdx + 1
  const add = (s: MacroStep[]) => commit(insertSteps(steps, at, s), at + s.length - 1)

  // --- recording: listen to the page's key events while Record is on, commit on Stop
  const recRef = useRef<RecordedKey[]>([])
  useEffect(() => {
    if (!recording) return
    recRef.current = []
    setRec([])
    const on = (type: 'down' | 'up') => (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const kc = hidFromCode(e.code)
      if (kc === undefined || !keyOk(kc, format)) return
      recRef.current = [...recRef.current, { type, kc, at: e.timeStamp || performance.now() }]
      setRec(recRef.current)
    }
    const down = on('down')
    const up = on('up')
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [recording, format])
  const recOpts = { delays: delays && recDelays, maxDelay: v.maxDelay ?? MAX_DELAY }
  const recSteps = useMemo(() => stepsFromRecording(rec, recOpts), [rec, recOpts.delays, recOpts.maxDelay]) // eslint-disable-line react-hooks/exhaustive-deps
  const stopRecording = () => {
    setRecording(false)
    if (recSteps.length) add(recSteps)
    recRef.current = []
    setRec([])
  }

  const thisBytes = macroSize(steps, format)
  const shown = recording ? insertSteps(steps, at, recSteps) : steps
  const s = selIdx !== undefined ? steps[selIdx] : undefined

  return (
    <Card className={className} title={`${name} · ${steps.length} step${steps.length === 1 ? '' : 's'}${thisBytes !== undefined ? ` · ${thisBytes} bytes` : ''}`}
      right={
        <span className="flex items-center gap-1.5">
          {delays && (
            <button type="button" className="chip !text-[11px]" aria-pressed={recDelays} disabled={recording} onClick={() => setRecDelays((x) => !x)}
              title="Keep the pauses between key presses as delay steps">
              {recDelays ? 'Timing on' : 'Timing off'}
            </button>
          )}
          <button type="button" className={cn('chip display flex items-center gap-1.5 !text-[11px] font-semibold', recording && 'plat !border-transparent')}
            aria-pressed={recording} onClick={() => (recording ? stopRecording() : (setAdding(undefined), setRecording(true)))}>
            {recording ? <><Square className="size-3" fill="currentColor" /> Stop</> : <><Circle className="size-3 text-[#ff4545]" fill="currentColor" /> Record</>}
          </button>
        </span>
      }>
      <div className={cn('recess scroll-thin flex max-h-[148px] min-h-[64px] flex-wrap content-start gap-1.5 overflow-y-auto rounded-[14px] p-3', recording && 'ring-1 ring-[#ff4545]/50')}
        role="listbox" aria-label={`Steps of macro ${name}`}>
        {shown.length === 0 && <span className="hint self-center">{recording ? 'Recording… press keys on your keyboard, then Stop.' : 'No steps yet. Record keys or add steps below.'}</span>}
        {shown.map((x, i) => {
          const live = recording && i >= at && i < at + recSteps.length
          return (
            <button key={i} type="button" role="option" aria-selected={i === selIdx} disabled={recording}
              onClick={() => setSel(i === selIdx ? undefined : i)} title={stepTitle(x)}
              className={cn('chip display !text-[11px] font-semibold whitespace-nowrap', i === selIdx && 'plat !border-transparent', x.t === 'delay' && 'opacity-70', live && 'border-[#ff4545]/60')}>
              {stepText(x)}
            </button>
          )
        })}
      </div>

      {/* selected step: edit / move / remove */}
      {s && !recording && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">Step {selIdx! + 1}</span>
          {(s.t === 'tap' || s.t === 'down' || s.t === 'up') && (
            <Segmented label="Key action" className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.t}
              options={[['Tap', 'tap'], ['Hold', 'down'], ['Release', 'up']] as const}
              onChange={(t) => commit(steps.map((y, k) => (k === selIdx ? { t, kc: s.kc } : y)), selIdx)} />
          )}
          {s.t === 'mouse' && (
            <Segmented label="Button action" className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.a}
              options={[['Click', 'tap'], ['Hold', 'down'], ['Release', 'up']] as const}
              onChange={(a) => commit(steps.map((y, k) => (k === selIdx ? { t: 'mouse', a, btn: s.btn } : y)), selIdx)} />
          )}
          {s.t === 'wheel' && (
            <Segmented label="Scroll direction" className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.dir}
              options={[['Up', 1], ['Down', -1]] as const}
              onChange={(dir) => commit(steps.map((y, k) => (k === selIdx ? { t: 'wheel', dir } : y)), selIdx)} />
          )}
          {s.t === 'delay' && (
            <NumberField label="Delay (ms)" value={s.ms} max={v.maxDelay ?? MAX_DELAY} onCommit={(ms) => commit(steps.map((y, k) => (k === selIdx ? { t: 'delay', ms } : y)), selIdx)} />
          )}
          {s.t === 'text' && (
            <TextField label="Text" value={s.text} onCommit={(text) => commit(normalize(steps.map((y, k) => (k === selIdx ? { t: 'text', text } : y))), text ? selIdx : undefined)} />
          )}
          <span className="ml-auto flex gap-1.5">
            <button type="button" className="chip !px-2" aria-label="Move step earlier" disabled={selIdx === 0} onClick={() => commit(moveStep(steps, selIdx!, -1), selIdx! - 1)}><ChevronLeft className="size-3.5" /></button>
            <button type="button" className="chip !px-2" aria-label="Move step later" disabled={selIdx === steps.length - 1} onClick={() => commit(moveStep(steps, selIdx!, 1), selIdx! + 1)}><ChevronRight className="size-3.5" /></button>
            <button type="button" className="chip !px-2" aria-label="Remove step" onClick={() => commit(removeStep(steps, selIdx!), selIdx! > 0 ? selIdx! - 1 : undefined)}><Trash2 className="size-3.5" /></button>
          </span>
        </div>
      )}

      {/* add steps */}
      {!recording && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">{selIdx === undefined ? 'Add' : `Add after step ${selIdx + 1}`}</span>
          {(['key', ...(mouse ? ['mouse', 'wheel'] : []), ...(delays ? ['delay'] : []), ...(texts ? ['text'] : [])] as Adding[]).map((k) => (
            <button key={k} type="button" className={cn('chip flex items-center gap-1 !text-[11px]', adding === k && 'plat !border-transparent')} aria-pressed={adding === k}
              onClick={() => setAdding(adding === k ? undefined : k)}>
              <Plus className="size-3" />{ADD_LABEL[k]}
            </button>
          ))}
          {steps.length > 0 && (
            <button type="button" className="chip ml-auto flex items-center gap-1 !text-[11px]" onClick={() => commit([], undefined)}><X className="size-3" />Clear</button>
          )}
        </div>
      )}
      {!recording && adding === 'key' && <MacroKeyPicker format={format} onPick={(kc) => add([{ t: 'tap', kc }])} />}
      {!recording && adding === 'mouse' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {MOUSE_BUTTONS.map((b, i) => <button key={b} type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'mouse', a: 'tap', btn: i + 1 }])}>{b} click</button>)}
        </div>
      )}
      {!recording && adding === 'wheel' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'wheel', dir: 1 }])}>Scroll up</button>
          <button type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'wheel', dir: -1 }])}>Scroll down</button>
        </div>
      )}
      {!recording && adding === 'delay' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {[50, 100, 250, 500, 1000].map((ms) => <button key={ms} type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'delay', ms }])}>{ms} ms</button>)}
          <NumberField label="Custom delay (ms)" value={200} max={v.maxDelay ?? MAX_DELAY} button="Add" onCommit={(ms) => add([{ t: 'delay', ms }])} />
        </div>
      )}
      {!recording && adding === 'text' && (
        <div className="mt-3"><TextField label="Text to type" value="" button="Add" onCommit={(text) => text && add([{ t: 'text', text }])} /></div>
      )}

      {problem && <p className="hint mt-3 mb-0 text-[var(--warn)]">{problem}</p>}
      <p className="hint mt-3 mb-0">
        {recording
          ? 'Every key you press is captured, Esc and Tab too; click Stop when done.'
          : mouse
            ? 'The mouse plays the macro itself, with or without InputDeck open.'
            : `Text is typed as plain ASCII with a US layout.${delays ? '' : " This keyboard's firmware can't store delays."}`}
      </p>
    </Card>
  )
}

type Adding = 'key' | 'mouse' | 'wheel' | 'delay' | 'text'
const ADD_LABEL: Record<Adding, string> = { key: 'Tap key', mouse: 'Mouse click', wheel: 'Scroll', delay: 'Delay', text: 'Text' }

function stepTitle(s: MacroStep): string {
  switch (s.t) {
    case 'tap': return `Tap ${describe(s.kc)}`
    case 'down': return `Hold ${describe(s.kc)} down`
    case 'up': return `Release ${describe(s.kc)}`
    case 'mouse': {
      const b = `${MOUSE_BUTTONS[s.btn - 1] ?? `button ${s.btn}`} mouse button`
      return s.a === 'tap' ? `Click the ${b}` : s.a === 'down' ? `Hold the ${b} down` : `Release the ${b}`
    }
    case 'wheel': return s.dir === 1 ? 'Scroll up one notch' : 'Scroll down one notch'
    case 'delay': return `Wait ${s.ms} ms`
    case 'text': return `Type “${s.text}”`
  }
}

/** Compact keycode grid for macro steps (basic keys only, those the format can store). */
function MacroKeyPicker({ format, onPick }: { format: MacroFormat; onPick: (kc: number) => void }) {
  const macroKeyOk = (k: Keycode) => k.code >= 0x04 && keyOk(k.code, format)
  const cats = useMemo(() => categories('qmk-v2').filter((c) => KEY_CATS.includes(c.id)).map((c) => ({ ...c, codes: c.codes.filter(macroKeyOk) })).filter((c) => c.codes.length), [format]) // eslint-disable-line react-hooks/exhaustive-deps
  const [cat, setCat] = useState(cats[0].id)
  const [q, setQ] = useState('')
  const shown = q.trim() ? search(q).filter(macroKeyOk).slice(0, 36) : cats.find((c) => c.id === cat)?.codes ?? []
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Segmented label="Key category" className="flex-1 [&_button]:!px-1.5 [&_button]:!text-[10px]" options={cats.map((c) => [c.name, c.id] as const)} value={q.trim() ? undefined : cat} onChange={(c) => (setQ(''), setCat(c))} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search keys for the macro"
          className="recess h-8 w-[120px] rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]" />
      </div>
      <div className="scroll-thin mt-2.5 grid max-h-[150px] grid-cols-8 gap-1.5 overflow-y-auto pr-1">
        {shown.map((k) => (
          <button key={k.code} type="button" className="raised display h-9 min-w-0 truncate rounded-[10px] px-1.5 text-[11px] font-semibold text-[var(--text-2)]" title={`Tap ${k.name}`} onClick={() => onPick(k.code)}>
            {k.label}
          </button>
        ))}
        {shown.length === 0 && <p className="hint col-span-8 m-0">No key matches.</p>}
      </div>
    </div>
  )
}

function NumberField({ label, value, max, button, onCommit }: { label: string; value: number; max: number; button?: string; onCommit: (n: number) => void }) {
  const [t, setT] = useState(String(value))
  useEffect(() => setT(String(value)), [value])
  const n = Math.round(Number(t))
  const ok = t.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max
  const go = () => ok && onCommit(n)
  return (
    <span className="flex items-center gap-1.5">
      <input type="number" min={0} max={max} step={10} value={t} aria-label={label} onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()} onBlur={() => !button && n !== value && go()}
        className={cn('recess h-8 w-[84px] rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none', !ok && 'ring-1 ring-[var(--warn)]')} />
      <span className="text-[11px] text-[var(--text-3)]">ms</span>
      {button && <button type="button" className="chip !text-[11px]" disabled={!ok} onClick={go}>{button}</button>}
    </span>
  )
}

function TextField({ label, value, button, onCommit }: { label: string; value: string; button?: string; onCommit: (s: string) => void }) {
  const [t, setT] = useState(value)
  useEffect(() => setT(value), [value])
  const bad = [...t].find((c) => !textCharOk(c.charCodeAt(0)))
  const go = () => !bad && onCommit(t)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <input type="text" value={t} aria-label={label} maxLength={500} placeholder="Type the text the macro should type" onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()} onBlur={() => !button && t !== value && go()}
        className={cn('recess h-8 min-w-0 flex-1 rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]', bad && 'ring-1 ring-[var(--warn)]')} />
      {button && <button type="button" className="chip !text-[11px]" disabled={!!bad || !t} onClick={go}>{button}</button>}
      {bad && <span className="text-[11px] text-[var(--warn)]">“{bad}” can't be typed</span>}
    </span>
  )
}
