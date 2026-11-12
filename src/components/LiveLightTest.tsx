// Guided hardware test for streamed per-key lighting (Driver.liveLight) on boards nobody has checked yet.
// Two pictures: three keys in pure red / green / blue, then one whole row in white. For each the tester
// says whether the keyboard looks exactly like the picture (when the driver knows which cell is which
// key, `map`), and if not, clicks every key that is lit and its colour. Nothing is guessed from it here:
// the report goes to the developer.
import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardCopy, FlaskConical } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { KeyCap, LiveLight } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { useDevices } from '#/lib/device-context'
import { Card } from './kit'
import { KeyboardView, type KeyLook } from './KeyboardView'

export interface ProbeCell {
  row: number
  col: number
  /** 3 bytes as sent (0xAABBCC) */
  value: number
}

export interface Probe {
  cells: ProbeCell[]
  what: string
}

export const COLOURS = ['Red', 'Green', 'Blue', 'White', 'Other'] as const
export type Seen = (typeof COLOURS)[number]
const SWATCH: Record<Seen, string> = { Red: '#ff3b30', Green: '#34c759', Blue: '#3b82f6', White: '#f4f4f5', Other: '#a855f7' }

export interface Answer {
  /** true = looked exactly like the picture; false = different (then `seen` / `none`) */
  match?: boolean
  /** layout position -> colour the tester saw there */
  seen?: Record<number, Seen>
  none?: boolean
}

type Grid = Pick<LiveLight, 'rows' | 'cols' | 'map'>

/** The column at or right of `c` (then left of it) whose cell has a key in `map`; `c` when there's no map. */
function keyed(l: Grid, row: number, c: number): number {
  if (!l.map) return c
  for (let d = 0; d < l.cols; d++) {
    for (const x of [c + d, c - d]) if (x >= 0 && x < l.cols && l.map[row * l.cols + x] !== undefined) return x
  }
  return c
}

/** Three keys in different rows and columns in pure red / green / blue, then a whole row (the top one) in white. */
export function probesFor(l: Grid): Probe[] {
  const row = (k: number) => Math.min(k, l.rows - 1)
  const rgb: ProbeCell[] = [
    { row: row(1), col: Math.min(1, l.cols - 1), value: 0xff0000 },
    { row: row(2), col: Math.floor(l.cols / 3), value: 0x00ff00 },
    { row: row(3), col: Math.floor(l.cols / 2), value: 0x0000ff },
  ].map((c) => ({ ...c, col: keyed(l, c.row, c.col) }))
  const white = Array.from({ length: l.cols }, (_, col) => ({ row: 0, col, value: 0xffffff }))
    .filter((c) => !l.map || l.map[c.col] !== undefined)
  return [
    { cells: rgb, what: 'three keys: red, green, blue' },
    { cells: white, what: 'top row white' },
  ]
}

const hex = (v: number) => v.toString(16).padStart(6, '0').toUpperCase()
const NAMES: Record<number, string> = { 0xff0000: 'red', 0x00ff00: 'green', 0x0000ff: 'blue', 0xffffff: 'white' }

/** layout position of a cell, when the driver knows it */
const keyOf = (l: Grid, c: ProbeCell) => l.map?.[c.row * l.cols + c.col]

export function buildLiveReport(dev: DeviceState, l: Grid, keys: KeyCap[], probes: Probe[], answers: Answer[], err?: string): string {
  const name = (p: number) => `"${keys[p]?.label ?? '?'}" (#${p})`
  const lines = [
    `InputDeck live-lighting test — ${dev.driver.brand()} ${dev.driver.model()} (${dev.id})`,
    `Grid ${l.rows} x ${l.cols}, ${l.map ? 'cell -> key map from the firmware' : 'no cell -> key map'}. Time: ${new Date().toISOString()}`,
  ]
  probes.forEach((p, i) => {
    const a = answers[i] ?? {}
    const sent = p.cells.map((c) => {
      const k = keyOf(l, c)
      return `${k === undefined ? '' : name(k) + ' '}r${c.row}c${c.col}=${hex(c.value)}`
    })
    let got = 'no answer'
    if (a.match) got = 'looked exactly like the picture'
    else if (a.none) got = 'nothing lit'
    else if (a.seen && Object.keys(a.seen).length) {
      got = 'saw ' + Object.entries(a.seen).map(([k, c]) => `${name(Number(k))} ${c}`).join(', ')
    }
    lines.push(`${i + 1}. ${p.what}: sent ${sent.join(', ')} -> ${got}`)
  })
  if (err) lines.push(`Error: ${err}`)
  return lines.join('\n')
}

export function LiveLightCard({ dev }: { dev: DeviceState }) {
  const l = dev.driver.liveLight
  const canWrite = useDevices().canWrite(dev.id)
  const [open, setOpen] = useState(false)
  if (!l) return null
  return (
    <Card title="Per-key lighting (live)" className="col-span-3"
      right={<span className="eyebrow rounded-full border border-white/20 px-2 py-0.5 !text-[8px]">{l.experimental ? 'Needs a test' : 'Live'}</span>}>
      <p className="hint m-0">
        This keyboard can show a different colour on every key while InputDeck is open (it can't store them).
        {l.experimental ? ' Before that can be built, a 1-minute guided test has to check that the right keys light up in the right colours: InputDeck shows two pictures and you say whether your keyboard matches. Your lighting is put back afterwards.' : ''}
      </p>
      {l.experimental && (
        <button type="button" disabled={!canWrite} onClick={() => setOpen(true)} title={canWrite ? undefined : 'Press "Allow changes" first'}
          className="plat display mt-4 flex items-center gap-2 rounded-full px-4 py-2.5 text-[12px] font-semibold disabled:opacity-50">
          <FlaskConical className="size-4" /> Start the guided test
        </button>
      )}
      {open && <LiveLightTest dev={dev} l={l} onClose={() => setOpen(false)} />}
    </Card>
  )
}

function LiveLightTest({ dev, l, onClose }: { dev: DeviceState; l: LiveLight; onClose: () => void }) {
  const keys = dev.driver.layout?.() ?? []
  const probes = useRef(probesFor(l)).current
  const [step, setStep] = useState(-1) // -1 intro, probes.length = done
  const [answers, setAnswers] = useState<Answer[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  // always give the lighting back: on close, unmount, or leaving the page
  const stop = useRef(async () => {
    if (!started.current) return
    started.current = false
    try {
      await l.stop()
    } catch {
      /* unplugged: the keyboard resets its lighting by itself */
    }
  }).current
  useEffect(() => {
    const leave = () => void stop()
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      void stop()
    }
  }, [stop])

  const show = async (i: number) => {
    const cells = new Array<number>(l.rows * l.cols).fill(0)
    for (const c of probes[i].cells) cells[c.row * l.cols + c.col] = c.value
    await l.frame(cells)
  }
  const go = async (i: number) => {
    setBusy(true)
    setErr(undefined)
    try {
      if (!started.current) {
        await l.start()
        started.current = true
      }
      if (i < probes.length) await show(i)
      else await stop()
      setStep(i)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      await stop()
      setStep(probes.length)
    } finally {
      setBusy(false)
    }
  }
  const close = async () => {
    await stop()
    onClose()
  }
  const a = answers[step] ?? {}
  const setA = (v: Answer) => setAnswers((all) => { const n = all.slice(); n[step] = { ...all[step], ...v }; return n })
  const seen = a.seen ?? {}
  const hasMap = !!l.map && keys.length > 0
  // with a map: first "does it look like this?"; without one (or after "no"): mark what is lit
  const marking = !hasMap || a.match === false
  const answered = a.match === true || ((a.match === false || !hasMap) && (a.none || Object.keys(seen).length > 0))
  const report = step >= probes.length ? buildLiveReport(dev, l, keys, probes, answers, err) : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const probe = step >= 0 && step < probes.length ? probes[step] : undefined
  const expected: KeyLook[] = keys.map(() => ({}))
  probe?.cells.forEach((c) => {
    const k = keyOf(l, c)
    if (k !== undefined && expected[k]) expected[k] = { color: `#${hex(c.value)}`, title: `${keys[k].label}: ${NAMES[c.value] ?? hex(c.value)}` }
  })
  const marked: KeyLook[] = keys.map((_, i) => (seen[i] ? { color: SWATCH[seen[i]], title: `${keys[i].label}: ${seen[i]}` } : {}))
  // clicking a key cycles it Red -> Green -> Blue -> White -> Other -> not lit
  const mark = (s: Set<number>) => {
    const next = { ...seen }
    for (const k of s) if (!(k in seen)) next[k] = 'Red'
    for (const k of Object.keys(seen).map(Number)) {
      if (s.has(k)) continue
      const c = COLOURS.indexOf(seen[k]) + 1
      if (c < COLOURS.length) next[k] = COLOURS[c]
      else delete next[k]
    }
    setA({ seen: next, none: false })
  }
  const describe = (p: Probe) => {
    const named = p.cells.map((c) => {
      const k = keyOf(l, c)
      return `${k === undefined ? `row ${c.row + 1} key ${c.col + 1}` : keys[k]?.label} ${NAMES[c.value] ?? hex(c.value)}`
    })
    return p.cells.length > 3 ? `the whole ${p.cells[0].row === 0 ? 'top' : `${p.cells[0].row + 1}.`} row in white` : named.join(', ')
  }

  return (
    <Dialog open onOpenChange={(o) => !o && void close()}>
      <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[760px]">
        <DialogHeader>
          <div className="eyebrow mb-1">Live lighting test · {dev.driver.model()}</div>
          <DialogTitle className="display text-[18px] font-semibold">
            {step < 0 ? 'Check which keys light up, and in what colour' : probe ? `Picture ${step + 1} of ${probes.length}: ${describe(probe)}` : err ? 'Test stopped' : 'Done — lighting put back'}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {step < 0
              ? `InputDeck will turn all key lights off and show ${probes.length} pictures on your keyboard. For each, say whether your keyboard looks exactly the same. Your current lighting is restored at the end (or if you close this). Nothing is stored on the keyboard; unplugging it also resets the lights.`
              : probe
                ? marking
                  ? 'Click every key that is lit on your keyboard. Click it again to change its colour (red, green, blue, white, other, off).'
                  : 'Do exactly these keys light up on your keyboard, in these colours, and no others?'
                : err ? `Something went wrong: ${err}. The lighting was put back. Copy the result and send it to the developer.` : 'Thanks! Copy the result and send it to the developer.'}
          </DialogDescription>
        </DialogHeader>

        {probe && (
          <>
            {keys.length > 0 && (marking
              ? <KeyboardView keys={keys} looks={marked} interactive maxWidth={700} selected={new Set(Object.keys(seen).map(Number))} onSelect={mark} />
              : <KeyboardView keys={keys} looks={expected} interactive={false} maxWidth={700} selected={new Set()} />)}
            <div className="flex flex-wrap items-center gap-2">
              {hasMap && (
                <>
                  <button type="button" className={cn('chip !text-[11px]', a.match === true && 'plat !border-transparent')} onClick={() => setA({ match: true, seen: {}, none: false })}>Yes, exactly like this</button>
                  <button type="button" className={cn('chip !text-[11px]', a.match === false && 'plat !border-transparent')} onClick={() => setA({ match: false })}>No, it looks different</button>
                </>
              )}
              {marking && (
                <button type="button" className={cn('chip !text-[11px]', a.none && 'plat !border-transparent')} onClick={() => setA({ none: true, seen: {} })}>Nothing lit</button>
              )}
            </div>
          </>
        )}

        {step >= probes.length && (
          <pre className="recess scroll-thin max-h-56 overflow-auto rounded-2xl p-4 text-[11px] whitespace-pre-wrap text-[var(--text-2)]">{report}</pre>
        )}

        <div className="flex justify-end gap-2">
          {step < probes.length && <button type="button" className="chip" disabled={busy} onClick={() => void close()}>Cancel</button>}
          {step < 0 && <button type="button" className="plat display rounded-full px-5 py-2.5 text-[12px] font-semibold" disabled={busy} onClick={() => void go(0)}>{busy ? 'Starting…' : 'Start'}</button>}
          {probe && (
            <button type="button" className="plat display rounded-full px-5 py-2.5 text-[12px] font-semibold disabled:opacity-50" disabled={busy || !answered} onClick={() => void go(step + 1)}>
              {busy ? '…' : step + 1 < probes.length ? 'Next' : 'Finish and restore lighting'}
            </button>
          )}
          {step >= probes.length && (
            <>
              <button type="button" className="chip" onClick={() => void close()}>Close</button>
              <button type="button" className="plat display flex items-center gap-2 rounded-full px-5 py-2.5 text-[12px] font-semibold" onClick={() => void copy()}>
                {copied ? <><Check className="size-4" /> Copied</> : <><ClipboardCopy className="size-4" /> Copy result</>}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
