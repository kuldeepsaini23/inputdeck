import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { MousePage } from '#/components/MousePage'
import { KeyboardPage } from '#/components/KeyboardPage'
import { Backdrop, SaveBar, TopBar } from '#/components/shell'
import { FeedbackButton } from '#/components/FeedbackButton'
import { unslug, useDevices } from '#/lib/device-context'
import type { Value } from '#/drivers/types'

export const Route = createFileRoute('/d/$id')({
  validateSearch: (s: Record<string, unknown>): { tab?: string } => (typeof s.tab === 'string' ? { tab: s.tab } : {}),
  component: DevicePage,
})

function DevicePage() {
  const { id } = Route.useParams()
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const mgr = useDevices()
  const dev = mgr.devices.find((d) => d.id === unslug(id))

  // keep the "Saved to device" note up for a moment
  const [, tick] = useState(0)
  useEffect(() => {
    if (!dev?.savedAt) return
    const t = setTimeout(() => tick((n) => n + 1), 1900)
    return () => clearTimeout(t)
  }, [dev?.savedAt])

  if (!dev) {
    return (
      <div className="app">
        <Backdrop />
        <TopBar />
        <main className="relative z-10 grid h-[calc(100%-76px)] place-items-center text-center">
          <div className="fade-in">
            <p className="text-[var(--text-2)]">{mgr.scanning ? 'Looking for the device…' : "This device isn't connected."}</p>
            <Link to="/" className="chip mt-4 inline-block no-underline">Back to start</Link>
          </div>
        </main>
      </div>
    )
  }

  const profile = dev.edit?.find((s) => s.key === 'profile')
  const onEdit = (key: string, v: Value) => mgr.edit(dev.id, key, v)
  const setTab = (t: string) => void navigate({ search: { tab: t }, replace: true })

  return (
    <div className="app">
      <Backdrop />
      <TopBar
        activeId={dev.id}
        profile={profile?.value.kind === 'choice' ? profile.value : undefined}
        onProfile={(v) => profile?.value.kind === 'choice' && onEdit('profile', { ...profile.value, current: v })}
      />
      {dev.driver.kind === 'mouse' ? (
        <MousePage dev={dev} tab={tab} setTab={setTab} onEdit={onEdit} />
      ) : (
        <KeyboardPage dev={dev} tab={tab} setTab={setTab} onEdit={onEdit} />
      )}
      {!mgr.canWrite(dev.id) && (
        <div role="status" className="glass absolute bottom-[104px] left-1/2 z-30 flex max-w-2xl -translate-x-1/2 items-center gap-3 px-5 py-3 text-[12.5px] text-[var(--text-2)]">
          <span className="eyebrow shrink-0 rounded-full border border-white/20 px-2 py-0.5 !text-[8px]">Untested</span>
          <span>We haven't tried this {dev.driver.kind} on real hardware yet, so it's view-only. If the values shown match your {dev.driver.kind}, changes are very likely safe.</span>
          <button type="button" className="plat display shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-semibold" onClick={() => mgr.allowChanges(dev.id)}>Allow changes</button>
        </div>
      )}
      {dev.error && mgr.canWrite(dev.id) && (
        <div role="alert" className="glass absolute top-[88px] left-1/2 z-30 max-w-xl -translate-x-1/2 px-5 py-3 text-[13px] text-[var(--text)]">
          <span className="mr-2 text-[var(--err)]">●</span>{dev.error}
          <button type="button" className="chip ml-3" onClick={() => void mgr.refresh(dev.id)}>Read again</button>
        </div>
      )}
      {mgr.isAllowed(dev.id) && (
        <button type="button" onClick={() => mgr.revokeChanges(dev.id)} title="Stop writing to this untested device"
          className="pill-glass display absolute bottom-[104px] left-6 z-30 flex items-center gap-2 rounded-full px-4 py-2.5 text-[11px] font-semibold text-[var(--text-2)] hover:text-[var(--text)]">
          <span className="eyebrow !text-[8px]">Untested · changes on</span> Make view-only
        </button>
      )}
      <SaveBar dev={dev} savedAt={dev.savedAt} />
      <FeedbackButton dev={dev} />
    </div>
  )
}
