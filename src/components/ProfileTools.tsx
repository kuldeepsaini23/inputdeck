// Device page tools, like Wootility: undo / redo (buttons + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) and the
// Profile menu (export to a file, import from a file, copy a share link), plus the "shared profile"
// banner for links opened with #p=... The logic lives in #/lib/profile-io and #/lib/history.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Download, FileUp, Link2, Redo2, Undo2, Upload } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '#/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import type { DeviceState } from '#/devices'
import { useDevices } from '#/lib/device-context'
import { useT } from '#/lib/i18n'
import { cn } from '#/lib/utils'
import {
  decodeLink,
  encodeLink,
  fileName,
  linkPayload,
  matchDevice,
  parseProfileText,
  planImport,
  serialize,
  shareUrl,
  type ProfileFile,
} from '#/lib/profile-io'

type T = ReturnType<typeof useT>

/** profile-io's errors, in the user's language */
function errorText(e: unknown, t: T): string {
  const msg = e instanceof Error ? e.message : String(e)
  const known: Record<string, string> = {
    "This isn't an InputDeck profile.": t("This isn't an InputDeck profile."),
    'This profile was made by a newer InputDeck. Reload the page and try again.': t('This profile was made by a newer InputDeck. Reload the page and try again.'),
    "This profile doesn't say which device it is for.": t("This profile doesn't say which device it is for."),
    'This profile is damaged.': t('This profile is damaged.'),
    'This share link is damaged.': t('This share link is damaged.'),
  }
  return known[msg] ?? msg
}

/** Focus is somewhere typing keys means something else (fields, the key tester). */
function typingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.closest('input, textarea, select, [data-key-tester]')) return true
  return false
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

/** A short message under the toolbar for a few seconds. */
function useNote() {
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = useCallback((text: string, bad = false) => {
    clearTimeout(timer.current)
    setNote({ text, bad })
    timer.current = setTimeout(() => setNote(null), bad ? 6000 : 3000)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [note, show] as const
}

const iconBtn = 'grid size-8 place-items-center rounded-full text-[var(--text-2)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30'

/** Undo / redo and the Profile menu, for the top bar of a device page. */
export function DeviceTools({ dev }: { dev: DeviceState }) {
  const mgr = useDevices()
  const t = useT()
  const writable = mgr.canWrite(dev.id)
  const canUndo = writable && mgr.canUndo(dev.id)
  const canRedo = writable && mgr.canRedo(dev.id)
  const [note, show] = useNote()
  const [importing, setImporting] = useState<ProfileFile | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const { undo, redo } = mgr

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (Cmd on a Mac), unless the user is typing somewhere
  useEffect(() => {
    if (!writable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey) || typingTarget(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo(dev.id)
        else undo(dev.id)
      } else if (k === 'y' && !e.shiftKey) {
        e.preventDefault()
        redo(dev.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [writable, undo, redo, dev.id])

  const profile = () => serialize(dev.driver, dev.id, dev.edit ?? [])

  const exportFile = () => {
    const name = fileName(dev.driver.model())
    const blob = new Blob([JSON.stringify(profile(), null, 2) + '\n'], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    show(t('Saved {name}', { name }))
  }

  const copyLink = async () => {
    try {
      const url = shareUrl(window.location.origin, dev.id, await encodeLink(profile()))
      if (!url) return show(t('This profile is too big for a link. Use Export to file instead.'), true)
      const ok = await copyText(url)
      show(ok ? t('Share link copied') : t("Couldn't copy the link."), !ok)
    } catch (e) {
      show(errorText(e, t), true)
    }
  }

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    try {
      if (f.size > 5_000_000) throw new Error("This isn't an InputDeck profile.")
      setImporting(parseProfileText(await f.text()))
    } catch (e) {
      show(t("Couldn't read {file}: {reason}", { file: f.name, reason: errorText(e, t) }), true)
    }
  }

  return (
    <div className="relative">
      <div className="pill-glass flex items-center gap-0.5 p-[3px]">
        {writable && (
          <>
            <button type="button" className={iconBtn} disabled={!canUndo} onClick={() => mgr.undo(dev.id)} aria-label={t('Undo')} title={`${t('Undo')} (Ctrl+Z)`}>
              <Undo2 className="size-3.5" />
            </button>
            <button type="button" className={iconBtn} disabled={!canRedo} onClick={() => mgr.redo(dev.id)} aria-label={t('Redo')} title={`${t('Redo')} (Ctrl+Shift+Z)`}>
              <Redo2 className="size-3.5" />
            </button>
          </>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger disabled={!dev.edit}
            className="display flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[10.5px] font-semibold text-[var(--text-2)] outline-none hover:text-[var(--text)] focus-visible:text-[var(--text)] disabled:opacity-40">
            {t('Profile')} <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[210px] rounded-2xl border-white/10 bg-[#121214]/95 p-1 backdrop-blur-xl">
            <DropdownMenuItem className="rounded-lg py-2 text-[13px]" onSelect={exportFile}>
              <Download /> {t('Export to file')}
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg py-2 text-[13px]" disabled={!writable} onSelect={() => fileInput.current?.click()}>
              <Upload /> {t('Import from file…')}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem className="rounded-lg py-2 text-[13px]" onSelect={() => void copyLink()}>
              <Link2 /> {t('Copy share link')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" tabIndex={-1} aria-hidden
        onChange={(e) => {
          void pickFile(e.target.files?.[0])
          e.target.value = ''
        }} />
      {note && (
        <div role="status" className={cn('pill-glass fade-in absolute top-[calc(100%+8px)] right-0 z-40 w-max max-w-[340px] px-3.5 py-2 text-[12px]', note.bad ? 'text-[var(--text)]' : 'text-[var(--text-2)]')}>
          <span className={cn('mr-2 inline-block size-1.5 rounded-full align-middle', note.bad ? 'bg-[var(--err)]' : 'bg-[var(--ok)]')} />
          {note.text}
        </div>
      )}
      <ImportDialog dev={dev} file={importing} onClose={() => setImporting(null)} onApplied={(n) => show(t('Applied {n} settings', { n }))} />
    </div>
  )
}

const deviceName = (f: ProfileFile) => [f.device.brand, f.device.model].filter(Boolean).join(' ')

/** Confirm an import: what changes, what can't be used here. */
export function ImportDialog({ dev, file, shared, onClose, onApplied }: {
  dev: DeviceState
  file: ProfileFile | null
  shared?: boolean
  onClose: () => void
  onApplied?: (n: number) => void
}) {
  const mgr = useDevices()
  const t = useT()
  const match = file ? matchDevice(file, dev.driver, dev.id) : 'same'
  const plan = useMemo(() => (file && dev.edit ? planImport(file, dev.edit) : null), [file, dev.edit])
  const writable = mgr.canWrite(dev.id)
  const apply = () => {
    if (!plan) return
    mgr.editMany(dev.id, plan.changes.map(({ key, value }) => ({ key, value })))
    onApplied?.(plan.changes.length)
    onClose()
  }
  const shown = plan?.changes.slice(0, 8) ?? []
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[460px]">
        <DialogHeader>
          <div className="eyebrow mb-1">{shared ? t('Shared profile') : t('Import profile')}{file ? ` · ${deviceName(file)}` : ''}</div>
          <DialogTitle className="display text-[18px] font-semibold">
            {match === 'family' ? t("This profile doesn't fit this device") : t('Apply this profile to {device}?', { device: dev.driver.model() })}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {match === 'family'
              ? t('It was made for {device}, which works differently. Open it with that device connected.', { device: file ? deviceName(file) : '' })
              : !plan
                ? t('Reading the device…')
                : plan.changes.length
                  ? t('{n} settings will change. They are written to the device right away; Undo puts them back.', { n: plan.changes.length })
                  : t('Nothing to change: this device already has these settings.')}
          </DialogDescription>
        </DialogHeader>
        {match === 'model' && file && (
          <p className="m-0 flex items-start gap-2 rounded-2xl border border-[var(--warn)]/30 bg-[var(--warn)]/5 px-3.5 py-2.5 text-[12px] text-[var(--text-2)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warn)]" />
            {t('Made on a {model}. Only the settings both devices share are used.', { model: deviceName(file) })}
          </p>
        )}
        {match !== 'family' && plan && plan.changes.length > 0 && (
          <ul className="scroll-thin m-0 flex max-h-[220px] list-none flex-col gap-1 overflow-y-auto p-0">
            {shown.map((c) => (
              <li key={c.key} className="raised rounded-xl px-3.5 py-2 text-[12.5px]">{t(c.label)}</li>
            ))}
            {plan.changes.length > shown.length && (
              <li className="hint px-1">{t('and {n} more', { n: plan.changes.length - shown.length })}</li>
            )}
          </ul>
        )}
        {match !== 'family' && plan && (plan.unchanged > 0 || plan.skipped.length > 0) && (
          <p className="hint m-0">
            {plan.unchanged > 0 && t('{n} already match.', { n: plan.unchanged })}{' '}
            {plan.skipped.length > 0 && t("{n} can't be used on this device: {keys}", { n: plan.skipped.length, keys: plan.skipped.map((s) => s.key).join(', ') })}
          </p>
        )}
        {match !== 'family' && !writable && <p className="hint m-0 text-[var(--warn)]">{t('This device is view-only. Allow changes first.')}</p>}
        <div className="flex gap-2.5">
          <button type="button" onClick={onClose} className="raised display flex-1 rounded-full py-3 text-[13px] font-semibold text-[var(--text-2)]">
            {match === 'family' || !plan?.changes.length ? t('Close') : t('Cancel')}
          </button>
          {match !== 'family' && !!plan?.changes.length && (
            <button type="button" disabled={!writable} onClick={apply} className="plat display flex flex-1 items-center justify-center gap-2 rounded-full py-3 text-[13px] font-semibold disabled:opacity-50">
              <FileUp className="size-4" /> {t('Apply')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Remove "#p=..." from the address bar once the shared profile was used or dismissed. */
function clearHash() {
  const { pathname, search } = window.location
  window.history.replaceState(window.history.state, '', pathname + search)
}

/** The profile in the page's #p=... link, once decoded (read when the page opens and when the hash changes). */
export function useSharedProfile() {
  const [state, setState] = useState<{ file?: ProfileFile; error?: string } | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => {
      const p = linkPayload(window.location.hash)
      if (!p) return
      decodeLink(p).then(
        (file) => alive && setState({ file }),
        (e) => alive && setState({ error: e instanceof Error ? e.message : String(e) }),
      )
    }
    read()
    window.addEventListener('hashchange', read)
    return () => {
      alive = false
      window.removeEventListener('hashchange', read)
    }
  }, [])
  const dismiss = useCallback(() => {
    clearHash()
    setState(null)
  }, [])
  return [state, dismiss] as const
}

/** Banner for a shared profile link opened with its device connected. */
export function SharedProfileBanner({ dev, shared, onDone }: { dev: DeviceState; shared: { file?: ProfileFile; error?: string }; onDone: () => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [applied, setApplied] = useState(false)
  if (applied) return null
  return (
    <>
      <div role="status" className="glass fade-in absolute top-[88px] left-1/2 z-30 flex max-w-xl -translate-x-1/2 items-center gap-3 px-5 py-3 text-[13px] text-[var(--text)]">
        <Link2 className="size-4 shrink-0 text-[var(--text-2)]" />
        <span className="min-w-0">
          {shared.error
            ? errorText(new Error(shared.error), t)
            : t('Someone shared a profile for {device}.', { device: shared.file ? deviceName(shared.file) : '' })}
        </span>
        {shared.file && (
          <button type="button" className="plat display shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-semibold" disabled={!dev.edit} onClick={() => setOpen(true)}>
            {t('Apply shared profile')}
          </button>
        )}
        <button type="button" className="chip shrink-0" onClick={onDone}>{t('Dismiss')}</button>
      </div>
      <ImportDialog dev={dev} file={open && shared.file ? shared.file : null} shared onClose={() => setOpen(false)}
        onApplied={() => {
          setApplied(true)
          onDone()
        }} />
    </>
  )
}

/** For a shared profile link whose device isn't connected: which device it is for. */
export function SharedProfileNote({ file }: { file: ProfileFile }) {
  const t = useT()
  const { requestConnect, supported } = useDevices()
  return (
    <div className="glass mx-auto mt-6 max-w-md px-5 py-4 text-left text-[13px] text-[var(--text-2)]">
      <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Link2 className="size-3" /> {t('Shared profile')}</div>
      <p className="m-0">{t('This link holds a profile for {device}. Connect that device to apply it.', { device: deviceName(file) || file.device.family })}</p>
      {supported && (
        <button type="button" className="chip mt-3" onClick={requestConnect}>{t('Connect a device')}</button>
      )}
    </div>
  )
}
