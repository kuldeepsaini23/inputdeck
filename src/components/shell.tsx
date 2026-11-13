import { Link } from '@tanstack/react-router'
import { Keyboard, Mouse, Plus, RefreshCw } from 'lucide-react'
import { exitDemo, pendingChanges, unitNumber, type DeviceState } from '#/devices'
import { slug, useDevices } from '#/lib/device-context'
import { cn } from '#/lib/utils'
import { usePhoto } from './photo'
import { Segmented, type Choice } from './kit'
import { LanguagePicker } from './LanguagePicker'
import { useT } from '#/lib/i18n'

export function Backdrop() {
  return (
    <>
      <div className="stage-bg" />
      <div className="floor-grid" />
    </>
  )
}

export const textOf = (d: DeviceState | undefined, key: string) => {
  const s = d?.read?.find((x) => x.key === key)
  return s?.value.kind === 'text' ? s.value.text : undefined
}

function DeviceTab({ d, active }: { d: DeviceState; active: boolean }) {
  const img = usePhoto(d.driver.image())
  const t = useT()
  const batt = textOf(d, 'battery')
  const sub = d.busy && !d.read ? t('Reading…') : d.error ? t('Needs attention') : d.driver.kind === 'mouse' ? (batt ? t('Wireless · {battery}', { battery: batt.replace(/ .*/, '') }) : t('Wireless')) : t('Wired')
  return (
    <Link
      to="/d/$id"
      params={{ id: slug(d.id) }}
      className={cn('flex items-center gap-2.5 rounded-full py-1 pr-4 pl-1 no-underline transition-colors', active ? 'border border-white/25 bg-white/10 shadow-[0_0_14px_rgb(230_232_236/0.15)]' : 'border border-transparent hover:bg-white/5')}
      aria-current={active ? 'page' : undefined}
    >
      <span className="grid size-[30px] place-items-center overflow-hidden rounded-full bg-black/40">
        {img.src ? <img src={img.src} onError={img.onError} alt="" className="h-[28px] w-auto object-contain" /> : d.driver.kind === 'mouse' ? <Mouse className="size-4 opacity-70" /> : <Keyboard className="size-4 opacity-70" />}
      </span>
      <span className="min-w-0 leading-tight" title={`${d.driver.brand()} ${d.driver.model()}`}>
        <span className={cn('display block max-w-[118px] truncate text-[10.5px] tracking-wide', active ? 'text-[var(--text)]' : 'text-[var(--text-2)]')}>{d.driver.model()}{unitNumber(d.id) > 1 ? ` #${unitNumber(d.id)}` : ''}</span>
        <span className="display flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-[rgb(242_242_245/0.5)]">
          <span className={cn('size-[5px] rounded-full', d.error ? 'bg-[var(--err)]' : d.busy ? 'bg-[var(--warn)]' : 'bg-[var(--ok)]')} />
          {sub}
        </span>
      </span>
    </Link>
  )
}

export function TopBar({ activeId, profile, onProfile, tools }: { activeId?: string; profile?: Choice; onProfile?: (v: number) => void; tools?: React.ReactNode }) {
  const { devices, requestConnect, scan, scanning, supported, demo } = useDevices()
  const t = useT()
  return (
    <header className="relative z-20 flex h-[76px] items-center justify-between px-10">
      <div className="flex flex-col items-start gap-1.5">
        <div className="flex items-center gap-4">
          <Link to="/" className="display text-[12px] tracking-[0.3em] text-[var(--text)] no-underline">INPUTDECK</Link>
          <Link to="/tools" className="display text-[10.5px] font-semibold text-[var(--text-3)] no-underline hover:text-[var(--text)]" activeProps={{ className: '!text-[var(--text)]' }}>{t('Tools')}</Link>
        </div>
        {demo && (
          <button type="button" onClick={exitDemo} title={t('Leave demo mode and use your real devices')}
            className="display flex items-center gap-1.5 text-[10.5px] font-semibold text-[var(--text-3)] hover:text-[var(--text)]">
            <span className="eyebrow rounded-full border border-white/20 px-1.5 py-0.5 !text-[7px]">{t('Demo')}</span> {t('Exit demo')}
          </button>
        )}
      </div>
      <nav aria-label={t('Devices')} className={cn('pill-glass no-scrollbar absolute left-1/2 flex -translate-x-1/2 items-center gap-1 overflow-x-auto p-1 [&>*]:shrink-0', tools ? 'max-w-[calc(100%-860px)]' : 'max-w-[calc(100%-600px)]')}>
        {devices.map((d) => <DeviceTab key={d.id} d={d} active={d.id === activeId} />)}
        {supported && (
          <button type="button" onClick={requestConnect} aria-label={t('Connect a device')} title={t('Connect a device')}
            className="grid size-10 place-items-center rounded-full border border-dashed border-white/20 text-[var(--text-2)] hover:text-[var(--text)]">
            <Plus className="size-4" />
          </button>
        )}
        {devices.length > 0 && (
          <button type="button" onClick={() => void scan()} aria-label={t('Look for devices again')} title={t('Look for devices again')}
            className="grid size-8 place-items-center rounded-full text-[var(--text-3)] hover:text-[var(--text)]">
            <RefreshCw className={cn('size-3.5', scanning && 'spin')} />
          </button>
        )}
      </nav>
      <div className="relative z-10 flex shrink-0 items-center gap-3">
        <LanguagePicker />
        {tools}
        {profile && onProfile && (
          <Segmented label={t('Profile')} className="pill-glass !p-[3px]" value={profile.current}
            options={profile.options.map(([, v], i) => [`P${i + 1}`, v] as const)} onChange={onProfile} />
        )}
      </div>
    </header>
  )
}

export function Dock({ tabs, active, onChange }: { tabs: { id: string; label: string; icon: React.ReactNode }[]; active: string; onChange: (id: string) => void }) {
  const t = useT()
  if (tabs.length < 2) return null
  return (
    <nav aria-label={t('Sections')} className="pill-glass no-scrollbar absolute bottom-8 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 gap-1 overflow-x-auto p-1.5 [&>*]:shrink-0">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)} aria-current={t.id === active ? 'page' : undefined}
          className={cn('display flex items-center gap-2 whitespace-nowrap rounded-full px-[18px] py-[11px] text-[13px] font-semibold transition-colors', t.id === active ? 'plat' : 'text-[var(--text-2)] hover:text-[var(--text)]')}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </nav>
  )
}

/** Changes are written live; this only says what is happening. */
export function SaveBar({ dev, savedAt }: { dev: DeviceState; savedAt?: number }) {
  const t = useT()
  const pending = pendingChanges(dev).length > 0
  const recent = savedAt && Date.now() - savedAt < 1800
  if (!pending && !dev.saving && !recent) return null
  const saving = pending || dev.saving
  return (
    <div role="status" className="pill-glass fade-in absolute bottom-[104px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-4 py-2 text-[12.5px] text-[var(--text-2)]">
      <span className={cn('size-1.5 rounded-full', saving ? 'blink bg-[var(--warn)]' : 'bg-[var(--ok)]')} />
      {saving ? t('Saving to device…') : t('Saved to device')}
    </div>
  )
}
