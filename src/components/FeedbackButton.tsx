import { useState } from 'react'
import { Check, ClipboardCopy, MessageSquareWarning, Stethoscope, ThumbsUp } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { Setting, Value } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'

type Verdict = 'works' | 'wrong'

/** One setting as plain text, the way a person would check it against the brand's own app. */
function show(v: Value): string {
  switch (v.kind) {
    case 'text':
      return v.text
    case 'choice': {
      const o = v.options.find((x) => x[1] === v.current)
      return `${o ? o[0] : '?'} (raw ${v.current})`
    }
    case 'number':
    case 'float':
      return `${v.current}${v.unit} (range ${v.min}–${v.max})`
    case 'toggle':
      return v.on ? 'on' : 'off'
    case 'color':
      return `#${v.rgb.toString(16).padStart(6, '0')}`
    case 'dpi':
      return `[${v.stages.join(', ')}] active ${v.active + 1}${v.colors ? ` colours ${v.colors.map((c) => c.toString(16).padStart(6, '0')).join(' ')}` : ''}`
    case 'perKeyTrigger': {
      const uniq = [...new Set(v.travel.map((t) => t.toFixed(2)))]
      return `${v.keys.length} keys, travel ${uniq.slice(0, 6).join('/')}${uniq.length > 6 ? '…' : ''} mm, rapid on ${v.rapid.filter(Boolean).length} keys`
    }
    case 'perKeyColor':
      return `${v.keys.length} keys, ${new Set(v.colors).size} colours`
    default:
      return JSON.stringify(v).slice(0, 200)
  }
}

export function buildReport(dev: DeviceState, verdict: Verdict | null, note: string, diag?: string): string {
  const d = dev.driver
  const settings: Setting[] = dev.read ?? []
  const lines = [
    `InputDeck report — ${verdict === 'works' ? 'WORKS' : verdict === 'wrong' ? 'SOMETHING IS WRONG' : 'no verdict'}`,
    `Device: ${d.brand()} ${d.model()} (${d.kind})`,
    `USB id: ${dev.id} · driver: ${d.family} · tested on hardware: ${d.verified === false ? 'no' : 'yes'}`,
    `Browser: ${typeof navigator === 'undefined' ? '?' : navigator.userAgent}`,
    `Page: ${typeof location === 'undefined' ? '?' : location.href}`,
    `Time: ${new Date().toISOString()}`,
  ]
  if (note.trim()) lines.push('', 'Note from tester:', note.trim())
  if (dev.error) lines.push('', `Last error: ${dev.error}`)
  lines.push('', 'Settings as read from the device:')
  for (const s of settings) lines.push(`- [${s.group}] ${s.label} (${s.key}): ${show(s.value)}`)
  if (!settings.length) lines.push('- (nothing could be read)')
  if (diag) lines.push('', 'Diagnostics (read-only):', diag)
  return lines.join('\n')
}

/** "Feedback" on each device page: say whether it works and copy a report for the developer. */
export function FeedbackButton({ dev }: { dev: DeviceState }) {
  const [open, setOpen] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const [diag, setDiag] = useState<string>()
  const [diagPct, setDiagPct] = useState<number | null>(null)
  const runDiag = async () => {
    if (!dev.driver.diagnose || diagPct !== null) return
    setDiagPct(0)
    try {
      setDiag(await dev.driver.diagnose((d, t) => setDiagPct(t ? d / t : 0)))
    } catch (e) {
      setDiag(`diagnostics stopped: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDiagPct(null)
    }
  }
  const copy = async () => {
    const text = buildReport(dev, verdict, note, diag)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard blocked: fall back to a hidden textarea
      const t = document.createElement('textarea')
      t.value = text
      document.body.appendChild(t)
      t.select()
      document.execCommand('copy')
      t.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="pill-glass display absolute right-6 bottom-[34px] z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-[11px] font-semibold text-[var(--text-2)] hover:text-[var(--text)]">
        <MessageSquareWarning className="size-3.5" /> Feedback
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[480px]">
          <DialogHeader>
            <div className="eyebrow mb-1">Feedback · {dev.driver.brand()} {dev.driver.model()}</div>
            <DialogTitle className="display text-[18px] font-semibold">Does this {dev.driver.kind} work?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              Compare the values here with the brand's own app. Then copy the report and send it to the developer — it holds what InputDeck read, so problems can be fixed without the device.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2.5">
            {([['works', 'It works', ThumbsUp], ['wrong', "Something's wrong", MessageSquareWarning]] as const).map(([v, l, Icon]) => (
              <button key={v} type="button" aria-pressed={verdict === v} onClick={() => setVerdict(v)}
                className={cn('display flex h-12 items-center justify-center gap-2 rounded-[14px] text-[12px] font-semibold', verdict === v ? 'plat' : 'raised text-[var(--text-2)]')}>
                <Icon className="size-4" /> {l}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="eyebrow mb-2 block">What did you notice? (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder={verdict === 'wrong' ? 'e.g. lift-off shows "Code 3", the brand app says 0.7 mm' : 'e.g. changed DPI and polling, all saved fine'}
              className="recess w-full resize-none rounded-2xl border-0 bg-transparent px-4 py-3 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]" />
          </label>
          {dev.driver.diagnose && (
            <div className="raised rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="display text-[12px] font-semibold">Diagnostics</div>
                  <p className="hint m-0 mt-1">Asks the {dev.driver.kind} about features we can't confirm yet. Only reads, so nothing on the device changes. Takes a few seconds.</p>
                </div>
                <button type="button" disabled={diagPct !== null || dev.saving} onClick={() => void runDiag()}
                  className="chip display flex shrink-0 items-center gap-1.5 !text-[11px] font-semibold disabled:opacity-50">
                  <Stethoscope className="size-3.5" />
                  {diagPct !== null ? `${Math.round(diagPct * 100)}%` : diag ? 'Run again' : 'Run'}
                </button>
              </div>
              {diag && <p className="hint m-0 mt-2 text-[var(--ok)]">Done, and included in the report below.</p>}
            </div>
          )}
          <button type="button" onClick={() => void copy()} className="plat display flex items-center justify-center gap-2 rounded-full py-3 text-[13px] font-semibold">
            {copied ? <><Check className="size-4" /> Copied — paste it to the developer</> : <><ClipboardCopy className="size-4" /> Copy report</>}
          </button>
        </DialogContent>
      </Dialog>
    </>
  )
}
