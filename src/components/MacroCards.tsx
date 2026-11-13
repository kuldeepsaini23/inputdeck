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
import { launchSteps, untypable } from '#/lib/launch-macro'
import { t, useT } from '#/lib/i18n'
import { Card, Segmented } from './kit'

/** Keys a macro can press: basic HID usages only (QMK stores 8-bit keycodes in macros). */
const KEY_CATS = ['basic', 'mods', 'nav', 'fkeys', 'numpad', 'media']

/** Mouse button names from MOUSE_BUTTONS, for display. */
const buttonName = (b: string | undefined) => {
  switch (b) {
    case 'Left': return t('Left')
    case 'Right': return t('Right')
    case 'Middle': return t('Middle')
    case 'Back': return t('Back')
    case 'Forward': return t('Forward')
    default: return b
  }
}

/** List of macro slots (M0…, or the device's own slot names). */
export function MacroList({ v, slot, onSelect, hint }: { v: Macros; slot: number; onSelect: (n: number) => void; hint?: string }) {
  const t = useT()
  const named = !!v.slotNames
  return (
    <Card title={v.slots === 1 ? t('Macros · 1 slot') : t('Macros · {n} slots', { n: v.slots })}>
      <div className="scroll-thin -mr-1 flex max-h-[300px] flex-col gap-1.5 overflow-y-auto pr-1" role="radiogroup" aria-label={t('Macro slot')}>
        {v.macros.map((m, i) => (
          <button key={i} type="button" role="radio" aria-checked={i === slot} onClick={() => onSelect(i)}
            className={cn('flex h-11 shrink-0 items-center gap-3 rounded-[12px] px-3 text-left', i === slot ? 'plat' : 'raised text-[var(--text-2)]')}>
            <span className={cn('display shrink-0 truncate text-[12px] font-semibold', named ? 'max-w-[45%]' : 'w-8')}>{slotName(v, i)}</span>
            <span className={cn('min-w-0 flex-1 truncate text-[11px]', i === slot ? 'opacity-70' : m.length ? '' : 'text-[var(--text-4)]')}>{m.length ? macroSummary(m) : t('Empty')}</span>
          </button>
        ))}
      </div>
      <p className="hint mt-3 mb-0">{hint ?? t('Put a macro on a key in the Keys tab.')}</p>
    </Card>
  )
}

/** Bytes used by all macros vs. the keyboard's macro storage. */
export function UsageBar({ v }: { v: Macros }) {
  const t = useT()
  const used = usedBytes(v)
  if (used === undefined || !v.maxBytes) return null
  const pct = Math.min(100, (used / v.maxBytes) * 100)
  const over = used > v.maxBytes
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{t('Storage')}</span>
        <span className={cn('display text-[11px]', over ? 'text-[var(--warn)]' : 'text-[var(--text-2)]')}>{t('{used} / {max} bytes', { used, max: v.maxBytes })}</span>
      </div>
      <div className="recess mt-2 h-2 overflow-hidden rounded-full" role="meter" aria-label={t('Macro storage used')} aria-valuemin={0} aria-valuemax={v.maxBytes} aria-valuenow={used}>
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
  const t = useT()
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
        ? mouse
          ? t("That doesn't fit: one macro can use {n} bytes on this mouse.", { n: v.maxPerMacro! })
          : t("That doesn't fit: one macro can use {n} bytes on this keyboard.", { n: v.maxPerMacro! })
        : mouse
          ? t("That doesn't fit: the mouse has room for {n} bytes of macros.", { n: v.maxBytes ?? 0 })
          : t("That doesn't fit: the keyboard has room for {n} bytes of macros.", { n: v.maxBytes ?? 0 }))
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
    <Card className={className} title={`${name} · ${steps.length === 1 ? t('1 step') : t('{n} steps', { n: steps.length })}${thisBytes !== undefined ? ` · ${t('{n} bytes', { n: thisBytes })}` : ''}`}
      right={
        <span className="flex items-center gap-1.5">
          {delays && (
            <button type="button" className="chip !text-[11px]" aria-pressed={recDelays} disabled={recording} onClick={() => setRecDelays((x) => !x)}
              title={t('Keep the pauses between key presses as delay steps')}>
              {recDelays ? t('Timing on') : t('Timing off')}
            </button>
          )}
          <button type="button" className={cn('chip display flex items-center gap-1.5 whitespace-nowrap !text-[11px] font-semibold', recording && 'plat !border-transparent')}
            aria-pressed={recording} onClick={() => (recording ? stopRecording() : (setAdding(undefined), setRecording(true)))}>
            {recording ? <><Square className="size-3" fill="currentColor" /> {t('Stop')}</> : <><Circle className="size-3 text-[#ff4545]" fill="currentColor" /> {t('Record')}</>}
          </button>
        </span>
      }>
      <div className={cn('recess scroll-thin flex max-h-[148px] min-h-[64px] flex-wrap content-start gap-1.5 overflow-y-auto rounded-[14px] p-3', recording && 'ring-1 ring-[#ff4545]/50')}
        role="listbox" aria-label={t('Steps of macro {name}', { name })}>
        {shown.length === 0 && <span className="hint self-center">{recording ? t('Recording… press keys on your keyboard, then Stop.') : t('No steps yet. Record keys or add steps below.')}</span>}
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
          <span className="eyebrow mr-1">{t('Step {n}', { n: selIdx! + 1 })}</span>
          {(s.t === 'tap' || s.t === 'down' || s.t === 'up') && (
            <Segmented label={t('Key action')} className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.t}
              options={[[t('Tap'), 'tap'], [t('Hold'), 'down'], [t('Release'), 'up']] as const}
              onChange={(a) => commit(steps.map((y, k) => (k === selIdx ? { t: a, kc: s.kc } : y)), selIdx)} />
          )}
          {s.t === 'mouse' && (
            <Segmented label={t('Button action')} className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.a}
              options={[[t('Click'), 'tap'], [t('Hold'), 'down'], [t('Release'), 'up']] as const}
              onChange={(a) => commit(steps.map((y, k) => (k === selIdx ? { t: 'mouse', a, btn: s.btn } : y)), selIdx)} />
          )}
          {s.t === 'wheel' && (
            <Segmented label={t('Scroll direction')} className="[&_button]:!px-3 [&_button]:!py-1 [&_button]:!text-[10.5px]" value={s.dir}
              options={[[t('Up'), 1], [t('Down'), -1]] as const}
              onChange={(dir) => commit(steps.map((y, k) => (k === selIdx ? { t: 'wheel', dir } : y)), selIdx)} />
          )}
          {s.t === 'delay' && (
            <NumberField label={t('Delay (ms)')} value={s.ms} max={v.maxDelay ?? MAX_DELAY} onCommit={(ms) => commit(steps.map((y, k) => (k === selIdx ? { t: 'delay', ms } : y)), selIdx)} />
          )}
          {s.t === 'text' && (
            <TextField label={t('Text')} value={s.text} onCommit={(text) => commit(normalize(steps.map((y, k) => (k === selIdx ? { t: 'text', text } : y))), text ? selIdx : undefined)} />
          )}
          <span className="ml-auto flex gap-1.5">
            <button type="button" className="chip !px-2" aria-label={t('Move step earlier')} disabled={selIdx === 0} onClick={() => commit(moveStep(steps, selIdx!, -1), selIdx! - 1)}><ChevronLeft className="size-3.5" /></button>
            <button type="button" className="chip !px-2" aria-label={t('Move step later')} disabled={selIdx === steps.length - 1} onClick={() => commit(moveStep(steps, selIdx!, 1), selIdx! + 1)}><ChevronRight className="size-3.5" /></button>
            <button type="button" className="chip !px-2" aria-label={t('Remove step')} onClick={() => commit(removeStep(steps, selIdx!), selIdx! > 0 ? selIdx! - 1 : undefined)}><Trash2 className="size-3.5" /></button>
          </span>
        </div>
      )}

      {/* add steps */}
      {!recording && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1">{selIdx === undefined ? t('Add') : t('Add after step {n}', { n: selIdx + 1 })}</span>
          {(['key', ...(mouse ? ['mouse', 'wheel'] : []), ...(delays ? ['delay'] : []), ...(texts ? ['text'] : []), 'app'] as Adding[]).map((k) => (
            <button key={k} type="button" className={cn('chip flex items-center gap-1 !text-[11px]', adding === k && 'plat !border-transparent')} aria-pressed={adding === k}
              onClick={() => setAdding(adding === k ? undefined : k)}>
              <Plus className="size-3" />{addLabel(k)}
            </button>
          ))}
          {steps.length > 0 && (
            <button type="button" className="chip ml-auto flex items-center gap-1 !text-[11px]" onClick={() => commit([], undefined)}><X className="size-3" />{t('Clear')}</button>
          )}
        </div>
      )}
      {!recording && adding === 'key' && <MacroKeyPicker format={format} onPick={(kc) => add([{ t: 'tap', kc }])} />}
      {!recording && adding === 'mouse' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {MOUSE_BUTTONS.map((b, i) => <button key={b} type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'mouse', a: 'tap', btn: i + 1 }])}>{t('{button} click', { button: buttonName(b) ?? b })}</button>)}
        </div>
      )}
      {!recording && adding === 'wheel' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'wheel', dir: 1 }])}>{t('Scroll up')}</button>
          <button type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'wheel', dir: -1 }])}>{t('Scroll down')}</button>
        </div>
      )}
      {!recording && adding === 'delay' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {[50, 100, 250, 500, 1000].map((ms) => <button key={ms} type="button" className="chip !text-[11px]" onClick={() => add([{ t: 'delay', ms }])}>{ms} ms</button>)}
          <NumberField label={t('Custom delay (ms)')} value={200} max={v.maxDelay ?? MAX_DELAY} button={t('Add')} onCommit={(ms) => add([{ t: 'delay', ms }])} />
        </div>
      )}
      {!recording && adding === 'app' && (
        <div className="mt-3">
          <AppField onCommit={(target) => add(launchSteps(target, delays))} />
          <p className="hint mt-2 mb-0">{t("Opens it through Windows' Run box (Win+R): an app name like notepad, calc, spotify or discord, a full path to a program or file, or a link (https://, steam://, ms-settings:). Then pick this macro for a button.")}</p>
        </div>
      )}
      {!recording && adding === 'text' && (
        <div className="mt-3"><TextField label={t('Text to type')} value="" button={t('Add')} onCommit={(text) => text && add([{ t: 'text', text }])} /></div>
      )}

      {problem && <p className="hint mt-3 mb-0 text-[var(--warn)]">{t(problem)}</p>}
      <p className="hint mt-3 mb-0">
        {recording
          ? t('Every key you press is captured, Esc and Tab too; click Stop when done.')
          : mouse
            ? t('The device plays the macro itself, with or without InputDeck open.')
            : `${t('Text is typed as plain ASCII with a US layout.')}${delays ? '' : ' ' + t("This keyboard's firmware can't store delays.")}`}
      </p>
    </Card>
  )
}

type Adding = 'key' | 'mouse' | 'wheel' | 'delay' | 'text' | 'app'
const addLabel = (k: Adding) => ({ key: t('Tap key'), mouse: t('Mouse click'), wheel: t('Scroll'), delay: t('Delay'), text: t('Text'), app: t('Open an app') })[k]

function stepTitle(s: MacroStep): string {
  switch (s.t) {
    case 'tap': return t('Tap {key}', { key: describe(s.kc) })
    case 'down': return t('Hold {key} down', { key: describe(s.kc) })
    case 'up': return t('Release {key}', { key: describe(s.kc) })
    case 'mouse': {
      const b = buttonName(MOUSE_BUTTONS[s.btn - 1]) ?? String(s.btn)
      return s.a === 'tap' ? t('Click the {button} mouse button', { button: b }) : s.a === 'down' ? t('Hold the {button} mouse button down', { button: b }) : t('Release the {button} mouse button', { button: b })
    }
    case 'wheel': return s.dir === 1 ? t('Scroll up one notch') : t('Scroll down one notch')
    case 'delay': return t('Wait {ms} ms', { ms: s.ms })
    case 'text': return t('Type “{text}”', { text: s.text })
  }
}

/** Compact keycode grid for macro steps (basic keys only, those the format can store). */
function MacroKeyPicker({ format, onPick }: { format: MacroFormat; onPick: (kc: number) => void }) {
  const t = useT()
  const macroKeyOk = (k: Keycode) => k.code >= 0x04 && keyOk(k.code, format)
  const cats = useMemo(() => categories('qmk-v2').filter((c) => KEY_CATS.includes(c.id)).map((c) => ({ ...c, codes: c.codes.filter(macroKeyOk) })).filter((c) => c.codes.length), [format]) // eslint-disable-line react-hooks/exhaustive-deps
  const [cat, setCat] = useState(cats[0].id)
  const [q, setQ] = useState('')
  const shown = q.trim() ? search(q).filter(macroKeyOk).slice(0, 36) : cats.find((c) => c.id === cat)?.codes ?? []
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Segmented label={t('Key category')} className="no-scrollbar min-w-0 flex-1 overflow-x-auto [&_button]:!px-1.5 [&_button]:!text-[10px]" options={cats.map((c) => [c.name, c.id] as const)} value={q.trim() ? undefined : cat} onChange={(c) => (setQ(''), setCat(c))} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search…')} aria-label={t('Search keys for the macro')}
          className="recess h-8 w-[120px] shrink-0 rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]" />
      </div>
      <div className="scroll-thin mt-2.5 grid max-h-[150px] grid-cols-8 gap-1.5 overflow-y-auto pr-1">
        {shown.map((k) => (
          <button key={k.code} type="button" className="raised display h-9 min-w-0 truncate rounded-[10px] px-1.5 text-[11px] font-semibold text-[var(--text-2)]" title={t('Tap {key}', { key: k.name })} onClick={() => onPick(k.code)}>
            {k.label}
          </button>
        ))}
        {shown.length === 0 && <p className="hint col-span-8 m-0">{t('No key matches.')}</p>}
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
  const t = useT()
  const [txt, setT] = useState(value)
  useEffect(() => setT(value), [value])
  const bad = [...txt].find((c) => !textCharOk(c.charCodeAt(0)))
  const go = () => !bad && onCommit(txt)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <input type="text" value={txt} aria-label={label} maxLength={500} placeholder={t('Type the text the macro should type')} onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()} onBlur={() => !button && txt !== value && go()}
        className={cn('recess h-8 min-w-0 flex-1 rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]', bad && 'ring-1 ring-[var(--warn)]')} />
      {button && <button type="button" className="chip !text-[11px]" disabled={!!bad || !txt} onClick={go}>{button}</button>}
      {bad && <span className="text-[11px] text-[var(--warn)]">{t("“{char}” can't be typed", { char: bad })}</span>}
    </span>
  )
}

/** Target for the "Open an app" macro: anything Windows' Run box accepts, typed with a US layout. */
function AppField({ onCommit }: { onCommit: (target: string) => void }) {
  const t = useT()
  const [txt, setT] = useState('')
  const bad = untypable(txt)
  const go = () => !bad && txt.trim() && onCommit(txt)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <input type="text" value={txt} aria-label={t('App, file or link to open')} maxLength={200} placeholder={t('e.g. spotify, discord, https://…')}
        onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
        className={cn('recess h-8 min-w-0 flex-1 rounded-full border-0 px-3 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]', bad && 'ring-1 ring-[var(--warn)]')} />
      <button type="button" className="chip !text-[11px]" disabled={!!bad || !txt.trim()} onClick={go}>{t('Add')}</button>
      {bad && <span className="text-[11px] text-[var(--warn)]">{t("“{char}” can't be typed", { char: bad })}</span>}
    </span>
  )
}
