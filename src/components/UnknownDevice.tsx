import { Copy, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import { useT } from '#/lib/i18n'

export interface UnknownInfo {
  name: string
  vid: number
  pid: number
  collections: string[]
}

const h4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase()

export function unknownInfo(d: HIDDevice): UnknownInfo {
  return {
    name: d.productName || 'Unknown device',
    vid: d.vendorId,
    pid: d.productId,
    collections: (d.collections ?? []).map((c) => `usage page ${h4(c.usagePage ?? 0)} usage ${h4(c.usage ?? 0)}`),
  }
}

/** Public issue form, pre-filled with the device's name and USB ids (nothing else about the user). */
export function issueUrl(u: UnknownInfo): string {
  const q = new URLSearchParams({
    template: 'device.yml',
    title: `Support: ${u.name}`,
    device: u.name,
    ids: `${h4(u.vid)}:${h4(u.pid)}`,
    features: `HID interfaces: ${u.collections.join('; ')}`,
  })
  return `https://github.com/kuldeepsaini23/inputdeck/issues/new?${q}`
}

/** A device the user picked from the full list that no driver knows yet. */
export function UnknownDevice({ info, onClose }: { info: UnknownInfo[]; onClose: () => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const text = info.map((u) => `${u.name} ${h4(u.vid)}:${h4(u.pid)}\n  ${u.collections.join('\n  ')}`).join('\n')
  return (
    <Dialog open={info.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 p-7 backdrop-blur-xl sm:max-w-[480px]">
        <DialogHeader>
          <div className="eyebrow mb-1">{t('Not supported yet')}</div>
          <DialogTitle className="display text-[20px] font-semibold">{t("InputDeck doesn't know this device yet")}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t('Send us its details and we can add it. Nothing is changed on the device.')}
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {info.map((u) => (
            <li key={`${u.vid}:${u.pid}`} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
              <span className="display block text-[13px] font-semibold">{u.name}</span>
              <span className="mt-1 block text-[11.5px] tabular-nums text-[var(--text-3)]">USB {h4(u.vid)}:{h4(u.pid)}</span>
              <div className="mt-2 flex gap-2">
                <a href={issueUrl(u)} target="_blank" rel="noreferrer" className="chip flex items-center gap-1.5 !text-[11px] no-underline">
                  <ExternalLink className="size-3" /> {t('Request support on GitHub')}
                </a>
              </div>
            </li>
          ))}
        </ul>
        <button type="button" className="chip flex items-center justify-center gap-1.5 self-start !text-[11px]"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}>
          <Copy className="size-3" /> {copied ? t('Copied') : t('Copy details')}
        </button>
        <p className="hint m-0">{t('Brands we may support under another name: if your mouse uses a wireless receiver, pick the receiver instead.')}</p>
      </DialogContent>
    </Dialog>
  )
}
