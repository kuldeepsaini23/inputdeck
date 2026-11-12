import { useRef, useState } from 'react'
import { ImagePlus, Trash2, Upload, X } from 'lucide-react'
import type { DeviceState } from '#/devices'
import { useDevices } from '#/lib/device-context'
import { encodeStill, loadPreviews, readGif, savePreviews, type Draft } from '#/lib/screen-image'
import { cn } from '#/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { Card } from './kit'

const kb = (n: number) => `${Math.ceil(n / 1024)} KB`

/** State for picking, ordering and sending pictures to a device screen. */
export function useScreenEditor(dev: DeviceState) {
  const sc = dev.driver.screen
  const { refresh } = useDevices()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [sent] = useState(() => loadPreviews(dev.id))
  const [lastSent, setLastSent] = useState<string[]>(sent)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  const used = drafts.reduce((n, d) => n + d.image.data.length, 0)

  const add = async (files: FileList | File[]) => {
    if (!sc) return
    setError(undefined)
    const next = [...drafts]
    for (const f of [...files]) {
      if (next.length >= sc.slots) {
        setError(`The screen holds ${sc.slots} pictures at most.`)
        break
      }
      try {
        const d = f.type === 'image/gif' ? await readGif(f, sc.gifSize ?? sc.width) : await encodeStill(f, sc.width, sc.height, sc.round)
        if (next.reduce((n, x) => n + x.image.data.length, 0) + d.image.data.length > sc.maxBytes) {
          setError(`${f.name} doesn't fit: all pictures together must stay under ${kb(sc.maxBytes)}.`)
          continue
        }
        next.push(d)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    setDrafts(next)
  }

  const upload = async () => {
    if (!sc || !drafts.length) return
    setError(undefined)
    setProgress(0)
    try {
      await sc.upload(drafts.map((d) => d.image), (done, total) => setProgress(done / total))
      const previews = drafts.map((d) => d.preview)
      savePreviews(dev.id, previews)
      setLastSent(previews)
      setDrafts([])
      await refresh(dev.id)
    } catch (e) {
      setError(`Sending stopped: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setProgress(null)
    }
  }

  const clear = async () => {
    if (!sc) return
    setError(undefined)
    setProgress(0)
    try {
      await sc.clear()
      savePreviews(dev.id, [])
      setLastSent([])
      await refresh(dev.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const remove = (id: string) => setDrafts((d) => d.filter((x) => x.id !== id))
  const makeMain = (id: string) => setDrafts((d) => [...d.filter((x) => x.id === id), ...d.filter((x) => x.id !== id)])
  const shown = drafts[0]?.preview ?? lastSent[0]
  return { sc, drafts, lastSent, used, progress, error, add, upload, clear, remove, makeMain, shown }
}

export type ScreenEditor = ReturnType<typeof useScreenEditor>

/** The receiver with its round screen, showing the main picture. */
export function Receiver({ picture, round = true }: { picture?: string; round?: boolean }) {
  return (
    <div className="float relative grid aspect-square w-[min(330px,80%)] place-items-center rounded-[56px] border border-white/15 bg-[linear-gradient(180deg,#29292d,#0f0f11)] shadow-[inset_0_2px_1px_rgb(255_255_255/0.1),inset_0_-6px_10px_rgb(0_0_0/0.6),0_40px_60px_rgb(0_0_0/0.8)]">
      <div className={cn('relative size-[76%] overflow-hidden bg-[#020203] shadow-[inset_0_3px_6px_rgb(0_0_0/0.9)]', round ? 'rounded-full' : 'rounded-[30px]')}>
        {picture ? (
          <img key={picture} src={picture} alt="Picture on the receiver screen" className="num-anim size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-center text-[11px] text-[var(--text-3)]">No picture<br />from InputDeck yet</div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgb(255_255_255/0.1),transparent_45%)]" />
      </div>
    </div>
  )
}

export function ScreenCards({ ed }: { ed: ScreenEditor }) {
  const { sc, drafts, lastSent, used, progress, error } = ed
  const input = useRef<HTMLInputElement>(null)
  const [confirm, setConfirm] = useState<'upload' | 'clear' | null>(null)
  const [over, setOver] = useState(false)
  if (!sc) return null
  const busy = progress !== null
  const pct = Math.min(1, used / sc.maxBytes)
  return (
    <>
      <Card title="Pictures" right={<span className="text-[11px] text-[var(--text-3)]">{drafts.length} of {sc.slots}</span>}>
        <div
          className={cn('grid grid-cols-4 gap-2.5 rounded-2xl transition-colors', over && 'bg-white/5')}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void ed.add(e.dataTransfer.files) }}
        >
          {Array.from({ length: sc.slots }, (_, i) => {
            const d = drafts[i]
            if (d) {
              return (
                <div key={d.id} className="group relative aspect-square overflow-hidden rounded-xl border border-white/30 bg-black fade-in">
                  <img src={d.preview} alt={d.name} className={cn('size-full object-cover', sc.round && 'rounded-full')} />
                  {i === 0 && <span className="eyebrow absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-1.5 py-0.5 !text-[7px] !text-white">Main</span>}
                  <div className="absolute inset-0 flex items-start justify-end gap-1 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {i > 0 && <button type="button" data-press className="rounded-full bg-black/75 px-1.5 py-0.5 text-[9px]" onClick={() => ed.makeMain(d.id)} aria-label={`Make ${d.name} the main picture`}>Main</button>}
                    <button type="button" data-press className="grid size-5 place-items-center rounded-full bg-black/75" onClick={() => ed.remove(d.id)} aria-label={`Remove ${d.name}`}><X className="size-3" /></button>
                  </div>
                </div>
              )
            }
            return (
              <button key={i} type="button" data-press disabled={busy} onClick={() => input.current?.click()} aria-label="Add a picture"
                className="grid aspect-square place-items-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-[var(--text-3)] hover:border-white/30 hover:text-[var(--text)] disabled:opacity-40">
                <ImagePlus className="size-4" />
              </button>
            )
          })}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { if (e.target.files) void ed.add(e.target.files); e.target.value = '' }} />
        <div className="mt-4">
          <div className="flex justify-between text-[10.5px] text-[var(--text-3)]"><span>Space used</span><span className="display">{kb(used)} / {kb(sc.maxBytes)}</span></div>
          <div className="recess mt-1.5 h-1.5 overflow-hidden rounded-full"><div className="plat h-full rounded-full transition-[width] duration-300" style={{ width: `${pct * 100}%` }} /></div>
          <p className="hint mt-2 mb-0">
            Drop pictures here or click a slot. Stills are cropped to the {sc.round ? 'round ' : ''}{sc.width}×{sc.height} screen and use {kb(sc.width * sc.height * 2)} each{sc.gifSize ? `; GIFs must be ${sc.gifSize}×${sc.gifSize}` : ''}. The first one is the main picture.
          </p>
        </div>
        {busy ? (
          <div className="mt-4" role="status">
            <div className="flex justify-between text-[11.5px]"><span className="flex items-center gap-2"><span className="blink size-1.5 rounded-full bg-[var(--warn)]" />Sending to the receiver — keep it plugged in</span><span className="display">{Math.round((progress ?? 0) * 100)}%</span></div>
            <div className="recess mt-2 h-2 overflow-hidden rounded-full"><div className="plat h-full rounded-full transition-[width] duration-200" style={{ width: `${(progress ?? 0) * 100}%` }} /></div>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={!drafts.length} onClick={() => setConfirm('upload')}
              className="plat display flex flex-1 items-center justify-center gap-2 rounded-full py-2.5 text-[12px] font-semibold disabled:opacity-40">
              <Upload className="size-3.5" /> Send to receiver
            </button>
            <button type="button" onClick={() => setConfirm('clear')} className="raised grid size-10 place-items-center rounded-full" aria-label="Delete every picture on the receiver" title="Delete every picture on the receiver">
              <Trash2 className="size-4 opacity-70" />
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 mb-0 text-[12px] text-[var(--err)]">{error}</p>}
      </Card>
      {lastSent.length > 0 && (
        <Card title="Last sent from InputDeck">
          <div className="flex gap-2">{lastSent.map((p, i) => <img key={i} src={p} alt={`Sent picture ${i + 1}`} className="size-12 rounded-full object-cover" />)}</div>
        </Card>
      )}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 backdrop-blur-xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="display text-[16px]">{confirm === 'clear' ? 'Delete every picture?' : `Send ${drafts.length} picture${drafts.length === 1 ? '' : 's'}?`}</DialogTitle>
            <DialogDescription className="leading-relaxed">
              {confirm === 'clear'
                ? 'All pictures stored on the receiver are removed. The screen keeps working without them.'
                : `This replaces the pictures stored on the receiver. Sending takes about a minute per still picture — keep the receiver plugged in until it finishes. If it ever gets stuck, the official WLMouse hub can restore the screen.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button type="button" className="rounded-full px-4 py-2 text-[13px] text-[var(--text-2)] hover:text-[var(--text)]" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="plat display rounded-full px-5 py-2 text-[12px] font-semibold"
              onClick={() => { const c = confirm; setConfirm(null); void (c === 'clear' ? ed.clear() : ed.upload()) }}>
              {confirm === 'clear' ? 'Delete all' : 'Send'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
