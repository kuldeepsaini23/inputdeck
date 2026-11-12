import { Link } from '@tanstack/react-router'
import { Keyboard, Mouse, Plus, RefreshCw } from 'lucide-react'
import { pendingChanges, type DeviceState } from '#/devices'
import { slug, useDevices } from '#/lib/device-context'
import { cn } from '#/lib/utils'
import { Segmented, type Choice } from './kit'

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
  const img = d.driver.image()
  const batt = textOf(d, 'battery')
  const sub = d.busy && !d.read ? 'Reading…' : d.error ? 'Needs attention' : d.driver.kind === 'mouse' ? `Wireless${batt ? ' · ' + batt.replace(/ .*/, '') : ''}` : 'Wired'
  return (
    <Link
      to="/d/$id"
      params={{ id: slug(d.id) }}
      className={cn('flex items-center gap-2.5 rounded-full py-1 pr-4 pl-1 no-underline transition-colors', active ? 'border border-white/25 bg-white/10 shadow-[0_0_14px_rgb(230_232_236/0.15)]' : 'border border-transparent hover:bg-white/5')}
      aria-current={active ? 'page' : undefined}
    >
      <span className="grid size-[30px] place-items-center overflow-hidden rounded-full bg-black/40">
        {img ? <img src={img} alt="" className="h-[28px] w-auto object-contain" /> : d.driver.kind === 'mouse' ? <Mouse className="size-4 opacity-70" /> : <Keyboard className="size-4 opacity-70" />}
      </span>
      <span className="leading-tight">
        <span className={cn('display block text-[10.5px] tracking-wide', active ? 'text-[var(--text)]' : 'text-[var(--text-2)]')}>{d.driver.model()}</span>
        <span className="display flex items-center gap-1.5 text-[10.5px] text-[rgb(242_242_245/0.5)]">
          <span className={cn('size-[5px] rounded-full', d.error ? 'bg-[var(--err)]' : d.busy ? 'bg-[var(--warn)]' : 'bg-[var(--ok)]')} />
          {sub}
        </span>
      </span>
    </Link>
  )
}

export function TopBar({ activeId, profile, onProfile }: { activeId?: string; profile?: Choice; onProfile?: (v: number) => void }) {
  const { devices, connect, scan, scanning, supported } = useDevices()
  return (
    <header className="relative z-20 flex h-[76px] items-center justify-between px-10">
      <Link to="/" className="display text-[12px] tracking-[0.3em] text-[var(--text)] no-underline">INPUTDECK</Link>
      <nav aria-label="Devices" className="pill-glass absolute left-1/2 flex -translate-x-1/2 items-center gap-1 p-1">
        {devices.map((d) => <DeviceTab key={d.id} d={d} active={d.id === activeId} />)}
        {supported && (
          <button type="button" onClick={() => void connect()} aria-label="Connect a device" title="Connect a device"
            className="grid size-10 place-items-center rounded-full border border-dashed border-white/20 text-[var(--text-2)] hover:text-[var(--text)]">
            <Plus className="size-4" />
          </button>
        )}
        {devices.length > 0 && (
          <button type="button" onClick={() => void scan()} aria-label="Look for devices again" title="Look for devices again"
            className="grid size-8 place-items-center rounded-full text-[var(--text-3)] hover:text-[var(--text)]">
            <RefreshCw className={cn('size-3.5', scanning && 'spin')} />
          </button>
        )}
      </nav>
      <div className="flex items-center gap-3">
        {profile && onProfile ? (
          <Segmented label="Profile" className="pill-glass !p-[3px]" value={profile.current}
            options={profile.options.map(([, v], i) => [`P${i + 1}`, v] as const)} onChange={onProfile} />
        ) : (
          <span className="text-[12px] text-[var(--text-3)]">Works in Chrome, Edge &amp; Opera</span>
        )}
      </div>
    </header>
  )
}

export function Dock({ tabs, active, onChange }: { tabs: { id: string; label: string; icon: React.ReactNode }[]; active: string; onChange: (id: string) => void }) {
  if (tabs.length < 2) return null
  return (
    <nav aria-label="Sections" className="pill-glass absolute bottom-8 left-1/2 z-20 flex -translate-x-1/2 gap-1 p-1.5">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)} aria-current={t.id === active ? 'page' : undefined}
          className={cn('display flex items-center gap-2 rounded-full px-[18px] py-[11px] text-[13px] font-semibold transition-colors', t.id === active ? 'plat' : 'text-[var(--text-2)] hover:text-[var(--text)]')}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </nav>
  )
}

/** Changes are written live; this only says what is happening. */
export function SaveBar({ dev, savedAt }: { dev: DeviceState; savedAt?: number }) {
  const pending = pendingChanges(dev).length > 0
  const recent = savedAt && Date.now() - savedAt < 1800
  if (!pending && !dev.saving && !recent) return null
  const saving = pending || dev.saving
  return (
    <div role="status" className="pill-glass fade-in absolute bottom-[104px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-4 py-2 text-[12.5px] text-[var(--text-2)]">
      <span className={cn('size-1.5 rounded-full', saving ? 'blink bg-[var(--warn)]' : 'bg-[var(--ok)]')} />
      {saving ? 'Saving to device…' : 'Saved to device'}
    </div>
  )
}
