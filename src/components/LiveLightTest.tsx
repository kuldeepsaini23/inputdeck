// Guided hardware test for streamed per-key lighting (Driver.liveLight) on boards nobody has checked yet:
// light one grid cell at a time with one colour byte set, and ask the tester which key lit and in what colour.
// Five answers give the grid corners/middle (-> grid-to-key map) and the colour byte order.
import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardCopy, FlaskConical } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { KeyCap, LiveLight } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { useDevices } from '#/lib/device-context'
import { Card } from './kit'
import { KeyboardView } from './KeyboardView'

interface Probe {
  row: number
  col: number
  /** 3 bytes as sent */
  value: number
  what: string
}

const COLOURS = ['Red', 'Green', 'Blue', 'White', 'Other colour'] as const
type Seen = (typeof COLOURS)[number]

export function probesFor(l: Pick<LiveLight, 'rows' | 'cols'>): Probe[] {
  const r = l.rows - 1
  const c = l.cols - 1
  const mid = [Math.floor(l.rows / 2), Math.floor(l.cols / 2)]
  return [
    { row: 0, col: 0, value: 0xff0000, what: 'first colour byte only' },
    { row: mid[0], col: mid[1], value: 0x00ff00, what: 'second colour byte only' },
    { row: r, col: c, value: 0x0000ff, what: 'third colour byte only' },
    { row: 0, col: c, value: 0xffffff, what: 'all bytes (white)' },
    { row: r, col: 0, value: 0xffffff, what: 'all bytes (white)' },
  ]
}

interface Answer {
  key?: number
  none?: boolean
  many?: boolean
  colour?: Seen
}

export function buildLiveReport(dev: DeviceState, l: Pick<LiveLight, 'rows' | 'cols'>, keys: KeyCap[], probes: Probe[], answers: Answer[], err?: string): string {
  const hex = (v: number) => v.toString(16).padStart(6, '0').toUpperCase()
  const lines = [
    `InputDeck live-lighting test — ${dev.driver.brand()} ${dev.driver.model()} (${dev.id})`,
    `Grid ${l.rows} x ${l.cols}. Time: ${new Date().toISOString()}`,
  ]
  probes.forEach((p, i) => {
    const a = answers[i] ?? {}
    const where = a.none ? 'nothing lit' : a.many ? 'several keys lit' : a.key !== undefined ? `key "${keys[a.key]?.label}" (layout #${a.key}, x ${keys[a.key]?.x}, y ${keys[a.key]?.y})` : 'no answer'
    lines.push(`${i + 1}. cell row ${p.row} col ${p.col}, sent ${hex(p.value)} (${p.what}) -> ${where}, colour: ${a.colour ?? 'no answer'}`)
  })
  // the first three probes each set one byte: their colours give the byte order
  const order = answers.slice(0, 3).map((a) => (a.colour && ['Red', 'Green', 'Blue'].includes(a.colour) ? a.colour[0] : '?')).join('')
  lines.push(`Byte order (from probes 1-3): ${order}`)
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
        {l.experimental ? ' Before that can be built, a 1-minute guided test has to find out which light is which key: InputDeck lights one key at a time and you say which one lit. Your lighting is put back afterwards.' : ''}
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
    if (i < probes.length) cells[probes[i].row * l.cols + probes[i].col] = probes[i].value
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
  const answered = (a.key !== undefined || a.none || a.many) && (a.none || a.colour)
  const report = step >= probes.length ? buildLiveReport(dev, l, keys, probes, answers, err) : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && void close()}>
      <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[760px]">
        <DialogHeader>
          <div className="eyebrow mb-1">Live lighting test · {dev.driver.model()}</div>
          <DialogTitle className="display text-[18px] font-semibold">
            {step < 0 ? 'Find out which light is which key' : step < probes.length ? `Step ${step + 1} of ${probes.length}: which key lit up?` : err ? 'Test stopped' : 'Done — lighting put back'}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {step < 0
              ? `InputDeck will turn all key lights off and light one key at a time, ${probes.length} times. Look at the keyboard and click the key that lit up, then pick its colour. Your current lighting is restored at the end (or if you close this). Nothing is stored on the keyboard; unplugging it also resets the lights.`
              : step < probes.length
                ? 'Click the key that is lit on your keyboard, then pick the colour you see.'
                : err ? `Something went wrong: ${err}. The lighting was put back. Copy the result and send it to the developer.` : 'Thanks! Copy the result and send it to the developer.'}
          </DialogDescription>
        </DialogHeader>

        {step >= 0 && step < probes.length && (
          <>
            {keys.length > 0 && (
              <KeyboardView keys={keys} looks={keys.map(() => ({}))} interactive maxWidth={700}
                selected={new Set(a.key === undefined ? [] : [a.key])}
                onSelect={(s) => { const k = [...s].find((x) => x !== a.key); setA({ key: k, none: false, many: false }) }} />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={cn('chip !text-[11px]', a.none && 'plat !border-transparent')} onClick={() => setA({ none: true, many: false, key: undefined, colour: undefined })}>Nothing lit</button>
              <button type="button" className={cn('chip !text-[11px]', a.many && 'plat !border-transparent')} onClick={() => setA({ many: true, none: false, key: undefined })}>Several keys lit</button>
            </div>
            {!a.none && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow mr-1">Colour</span>
                {COLOURS.map((c) => (
                  <button key={c} type="button" className={cn('chip !text-[11px]', a.colour === c && 'plat !border-transparent')} onClick={() => setA({ colour: c })}>{c}</button>
                ))}
              </div>
            )}
          </>
        )}

        {step >= probes.length && (
          <pre className="recess scroll-thin max-h-56 overflow-auto rounded-2xl p-4 text-[11px] whitespace-pre-wrap text-[var(--text-2)]">{report}</pre>
        )}

        <div className="flex justify-end gap-2">
          {step < probes.length && <button type="button" className="chip" disabled={busy} onClick={() => void close()}>Cancel</button>}
          {step < 0 && <button type="button" className="plat display rounded-full px-5 py-2.5 text-[12px] font-semibold" disabled={busy} onClick={() => void go(0)}>{busy ? 'Starting…' : 'Start'}</button>}
          {step >= 0 && step < probes.length && (
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
