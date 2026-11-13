import { Keyboard, Mouse, Usb } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { useT } from '#/lib/i18n'

/** What each supported device is called in Chrome's device list. */
// device names inside the notes are what the browser shows, so they stay as they are
const guide = (t: (s: string, v?: Record<string, string>) => string): { icon: React.ReactNode; brand: string; pick: string; note: string }[] => [
  { icon: <Mouse className="size-4" />, brand: t('Wireless mice'), pick: t('the receiver'), note: t('e.g. {names}. Turn the mouse on first.', { names: '"HUAN 8K Receiver", "Pulsar 8K Dongle", "USB Receiver" (Logitech), "Razer … Dongle"' }) },
  { icon: <Mouse className="size-4" />, brand: t('Wired mice'), pick: t('the mouse name'), note: t('e.g. {names}.', { names: '"PRO X SUPERLIGHT 2", "DeathAdder V3", "Maya X"' }) },
  { icon: <Keyboard className="size-4" />, brand: t('Keyboards'), pick: t('the keyboard name'), note: t('e.g. {names}. Plug it in with its cable.', { names: '"Wraith W75", "Keychron Q1"' }) },
]

/**
 * Shown before Chrome's own device list (which no website can restyle):
 * tells people which name to pick, then opens that list.
 */
export function ConnectSheet({ open, onOpenChange, onContinue }: { open: boolean; onOpenChange: (o: boolean) => void; onContinue: () => void }) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[460px]">
        <DialogHeader>
          <div className="eyebrow mb-1">{t('Connect a device')}</div>
          <DialogTitle className="display text-[20px] font-semibold">{t('Pick your device in the next window')}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t('Your browser shows its own list of USB devices. Look for these names:')}
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {guide(t).map((g) => (
            <li key={g.brand} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-black/40 text-[var(--text-2)]">{g.icon}</span>
              <span className="min-w-0">
                <span className="eyebrow block">{g.brand}</span>
                <span className="display mt-1 block text-[13px] font-semibold">“{g.pick}”</span>
                <span className="mt-1 block text-[11.5px] text-[var(--text-3)]">{g.note}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="hint m-0">{t('If a name shows up twice, either one works. You only do this once — next time InputDeck reconnects by itself.')}</p>
        <button type="button" onClick={onContinue} className="plat display flex items-center justify-center gap-2 rounded-full py-3 text-[13px] font-semibold">
          <Usb className="size-4" /> {t('Continue')}
        </button>
      </DialogContent>
    </Dialog>
  )
}
