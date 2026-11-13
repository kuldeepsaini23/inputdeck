import { createFileRoute } from '@tanstack/react-router'
import { Gauge, Keyboard, MousePointerClick, Ruler } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Backdrop, Dock, TopBar } from '#/components/shell'
import { BigValue, Card, Segmented } from '#/components/kit'
import { useDevices } from '#/lib/device-context'
import { averageRate, chatterCount, cps, dpiError, dpiOf, fastestRepress, nearestRate, rateOf, type Press } from '#/lib/testers'
import { cn } from '#/lib/utils'

type Tab = 'polling' | 'clicks' | 'dpi' | 'keys'
const TABS: Tab[] = ['polling', 'clicks', 'dpi', 'keys']

export const Route = createFileRoute('/tools')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => (TABS.includes(s.tab as Tab) ? { tab: s.tab as Tab } : {}),
  component: ToolsPage,
})

function ToolsPage() {
  const { tab = 'polling' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <div className="app">
      <Backdrop />
      <TopBar />
      <main className="no-scrollbar relative z-10 h-[calc(100%-76px)] overflow-y-auto px-4 pt-2 pb-36 sm:px-10">
        <div className="mx-auto max-w-[920px]">
          <div className="eyebrow">Tools</div>
          <h1 className="big-num m-0 mt-2 text-[28px]">Check your gear</h1>
          <p className="mt-2 mb-6 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--text-2)]">
            These tests only watch what your browser receives. They work with any mouse or keyboard, connected to InputDeck or not, and never change anything.
          </p>
          {tab === 'polling' && <PollingTest />}
          {tab === 'clicks' && <ClickTest />}
          {tab === 'dpi' && <DpiTest />}
          {tab === 'keys' && <KeyTest />}
        </div>
      </main>
      <Dock
        active={tab}
        onChange={(t) => void navigate({ search: { tab: t as Tab }, replace: true })}
        tabs={[
          { id: 'polling', label: 'Polling rate', icon: <Gauge className="size-4" /> },
          { id: 'clicks', label: 'Clicks', icon: <MousePointerClick className="size-4" /> },
          { id: 'dpi', label: 'DPI check', icon: <Ruler className="size-4" /> },
          { id: 'keys', label: 'Keyboard', icon: <Keyboard className="size-4" /> },
        ]}
      />
    </div>
  )
}

/** Re-render a few times a second while `on` (the tests collect events in refs). */
function useTick(on: boolean, ms = 150) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [on, ms])
}

const fmtHz = (hz?: number) => (hz === undefined ? '—' : hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 2) + 'K' : Math.round(hz).toString())

// ---------------------------------------------------------------- polling rate

function PollingTest() {
  const pad = useRef<HTMLDivElement>(null)
  const times = useRef<number[]>([])
  const last = useRef(0)
  const peak = useRef<number>(undefined)
  const history = useRef<number[]>([])
  const lastAvg = useRef<number>(undefined)
  useTick(true, 200)

  useEffect(() => {
    const el = pad.current
    if (!el) return
    const raw = 'onpointerrawupdate' in el
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const list = !raw && e.getCoalescedEvents ? e.getCoalescedEvents() : []
      for (const c of list.length ? list : [e]) times.current.push(c.timeStamp)
      last.current = performance.now()
      if (times.current.length > 4000) times.current.splice(0, times.current.length - 4000)
    }
    const type = raw ? 'pointerrawupdate' : 'pointermove'
    el.addEventListener(type, onMove as EventListener)
    return () => el.removeEventListener(type, onMove as EventListener)
  }, [])

  // keep only the last half second, sample the rate for the graph
  const now = performance.now()
  const isMoving = now - last.current < 120
  const recent = times.current.filter((t) => now - t < 500)
  const hz = isMoving ? rateOf(recent) : undefined
  const avg = isMoving ? averageRate(recent) : undefined
  if (avg !== undefined) lastAvg.current = avg
  if (hz !== undefined) {
    if (history.current.at(-1) !== hz) history.current = [...history.current, hz].slice(-60)
    if (peak.current === undefined || hz > peak.current) peak.current = hz
  }
  const shown = hz ?? history.current.at(-1)
  const max = Math.max(1000, ...history.current)

  return (
    <div className="grid gap-4">
      <Card title="Polling rate" right={<button type="button" className="chip" onClick={() => { peak.current = undefined; lastAvg.current = undefined; history.current = []; times.current = [] }}>Reset</button>}>
        <div className="flex flex-wrap items-end gap-10">
          <div>
            <div className="eyebrow">{isMoving ? 'Now' : 'Last reading'}</div>
            <BigValue value={fmtHz(shown)} unit="Hz" size={56} />
          </div>
          <div>
            <div className="eyebrow">Peak</div>
            <BigValue value={fmtHz(peak.current)} unit="Hz" size={28} />
          </div>
          <div>
            <div className="eyebrow">Average (counts drops)</div>
            <BigValue value={fmtHz(lastAvg.current)} unit="Hz" size={28} />
          </div>
          {peak.current !== undefined && (
            <div className="text-[12.5px] text-[var(--text-2)]">Looks like a <b className="text-[var(--text)]">{fmtHz(nearestRate(peak.current))} Hz</b> mouse</div>
          )}
        </div>
        <svg className="mt-4 block h-[70px] w-full" viewBox="0 0 600 70" preserveAspectRatio="none" aria-hidden="true">
          <polyline fill="none" stroke="#E6E8EC" strokeOpacity={0.8} strokeWidth={2} vectorEffect="non-scaling-stroke"
            points={history.current.map((v, i) => `${(i / 59) * 600},${68 - (v / max) * 64}`).join(' ')} />
        </svg>
      </Card>
      <div ref={pad} className={cn('glass grid h-[260px] cursor-crosshair select-none place-items-center text-center text-[14px] text-[var(--text-2)] transition-colors', isMoving && 'border-white/30')}>
        <div>
          <div className="display text-[13px] text-[var(--text)]">Move your mouse fast in circles here</div>
          <div className="mt-2 text-[12px] text-[var(--text-3)]">Keep moving for a couple of seconds for a steady reading</div>
        </div>
      </div>
      <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
        Browsers can miss reports at very high rates (4K/8K), and a busy PC or a USB hub can lower the reading. If the peak is far below what you set, try a USB port on the back of the PC and close other apps. Use it as a rough check, not a lab measurement.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- clicks

const BUTTONS = ['Left', 'Middle', 'Right', 'Back', 'Forward']

function ClickTest() {
  const presses = useRef<Press[][]>(BUTTONS.map(() => []))
  const downs = useRef<number[]>([])
  const [threshold, setThreshold] = useState(20)
  const [held, setHeld] = useState<number[]>([])
  useTick(true, 200)

  const onDown = (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault()
    const b = e.button
    if (!BUTTONS[b]) return
    presses.current[b].push({ down: e.timeStamp })
    downs.current.push(e.timeStamp)
    setHeld((h) => [...new Set([...h, b])])
  }
  const onUp = (e: React.MouseEvent) => {
    const b = e.button
    const last = presses.current[b]?.at(-1)
    if (last && last.up === undefined) last.up = e.timeStamp
    setHeld((h) => h.filter((x) => x !== b))
  }
  const now = performance.now()

  return (
    <div className="grid gap-4">
      <div
        className="glass grid h-[220px] cursor-pointer select-none place-items-center text-center"
        onMouseDown={onDown}
        onMouseUp={onUp}
        onContextMenu={(e) => e.preventDefault()}
        onAuxClick={(e) => e.preventDefault()}
      >
        <div>
          <div className="display text-[13px] text-[var(--text)]">Click here with any button</div>
          <div className="mt-2 text-[12px] text-[var(--text-3)]">Single clicks only: if one click shows up as two, the switch is chattering (double-clicking)</div>
          <div className="mt-4 flex justify-center gap-2">
            {BUTTONS.map((b, i) => <span key={b} className={cn('chip', held.includes(i) && 'plat')}>{b}</span>)}
          </div>
        </div>
      </div>
      <Card title="Results" right={
        <div className="flex items-center gap-3">
          <span className="text-[11.5px] text-[var(--text-3)]">Count as a double click under</span>
          <Segmented label="Double-click threshold" value={threshold} onChange={setThreshold} options={[['10 ms', 10], ['20 ms', 20], ['40 ms', 40], ['80 ms', 80]]} />
          <button type="button" className="chip" onClick={() => { presses.current = BUTTONS.map(() => []); downs.current = [] }}>Reset</button>
        </div>
      }>
        <div className="mb-4 flex gap-10">
          <div><div className="eyebrow">Clicks per second</div><BigValue value={cps(downs.current, now).toFixed(0)} size={34} /></div>
        </div>
        <table className="w-full text-left text-[13px]">
          <thead className="eyebrow"><tr><th className="pb-2 font-normal">Button</th><th className="font-normal">Clicks</th><th className="font-normal">Last hold</th><th className="font-normal">Fastest gap</th><th className="font-normal">Double clicks</th></tr></thead>
          <tbody>
            {BUTTONS.map((b, i) => {
              const p = presses.current[i]
              const last = p.at(-1)
              const chat = chatterCount(p, threshold)
              const gap = fastestRepress(p)
              return (
                <tr key={b} className="border-t border-white/[0.06]">
                  <td className="py-2 text-[var(--text)]">{b}</td>
                  <td>{p.length}</td>
                  <td>{last?.up !== undefined ? `${(last.up - last.down).toFixed(1)} ms` : '—'}</td>
                  <td>{gap !== undefined ? `${gap.toFixed(1)} ms` : '—'}</td>
                  <td className={chat ? 'text-[var(--err)]' : undefined}>{chat ? `${chat} found` : p.length ? 'none' : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
          A human can't click again within about 20 ms of letting go, so a second click that fast is almost always the switch bouncing. If you see double clicks, raise the mouse's click debounce on its Buttons tab and test again.
        </p>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- DPI check

function useMouseDpi(): number | undefined {
  const { devices } = useDevices()
  for (const d of devices) {
    if (d.driver.kind !== 'mouse') continue
    const v = d.read?.find((s) => s.key === 'dpi')?.value
    if (v?.kind === 'dpi') return v.stages[v.active]
  }
  return undefined
}

function DpiTest() {
  const target = useRef<HTMLDivElement>(null)
  const [unit, setUnit] = useState<'cm' | 'in'>('cm')
  const [distance, setDistance] = useState(10)
  const [running, setRunning] = useState(false)
  const [raw, setRaw] = useState<boolean>()
  const sum = useRef({ x: 0, y: 0 })
  const [result, setResult] = useState<{ x: number; y: number }>()
  const deviceDpi = useMouseDpi()
  const [setDpi, setSetDpi] = useState<number>()
  const expected = setDpi ?? deviceDpi
  useTick(running, 100)

  useEffect(() => {
    if (!running) return
    const onMove = (e: MouseEvent) => {
      sum.current.x += e.movementX
      sum.current.y += e.movementY
    }
    const onLock = () => {
      if (document.pointerLockElement !== target.current) {
        setRunning(false)
        setResult({ ...sum.current })
      }
    }
    const onClick = () => document.exitPointerLock()
    document.addEventListener('mousemove', onMove)
    document.addEventListener('pointerlockchange', onLock)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('pointerlockchange', onLock)
      document.removeEventListener('mousedown', onClick)
    }
  }, [running])

  const start = async () => {
    const el = target.current
    if (!el) return
    sum.current = { x: 0, y: 0 }
    setResult(undefined)
    try {
      // raw counts, without Windows pointer speed or acceleration
      await (el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void)({ unadjustedMovement: true })
      setRaw(true)
    } catch {
      await el.requestPointerLock()
      setRaw(false)
    }
    setRunning(true)
  }

  const measured = result ? dpiOf(result.x, distance, unit) : undefined
  const live = running ? sum.current : result

  return (
    <div className="grid gap-4">
      <Card title="1 · Set up">
        <ol className="m-0 grid gap-2 pl-5 text-[13px] leading-relaxed text-[var(--text-2)]">
          <li>Put a ruler (or a tape measure) on your mouse pad, and line up the front of your mouse with the 0 mark.</li>
          <li>Pick the distance you will move:
            <span className="ml-2 inline-flex items-center gap-2 align-middle">
              <input type="number" min={1} max={100} value={distance} onChange={(e) => setDistance(Math.max(1, Number(e.target.value) || 1))}
                className="recess w-20 rounded-lg px-2 py-1 text-[13px] text-[var(--text)]" aria-label="Distance" />
              <Segmented label="Unit" value={unit} onChange={setUnit} options={[['cm', 'cm'], ['inch', 'in']]} />
            </span>
          </li>
          <li>Press Start, slide the mouse <b className="text-[var(--text)]">straight to the right</b> exactly that far, then click.</li>
        </ol>
      </Card>
      <div ref={target} className={cn('glass grid h-[200px] place-items-center text-center', running && 'border-white/40')}>
        {running ? (
          <div>
            <div className="display text-[13px] text-[var(--text)]">Slide right {distance} {unit}, then click</div>
            <div className="mt-3 text-[12px] tabular-nums text-[var(--text-3)]">{Math.abs(live?.x ?? 0)} counts across · {live?.y ?? 0} up/down</div>
          </div>
        ) : (
          <button type="button" className="plat display rounded-full px-7 py-3 text-[13px] font-semibold" onClick={() => void start()}>Start</button>
        )}
      </div>
      {result && measured !== undefined && (
        <Card title="2 · Result">
          <div className="flex flex-wrap items-end gap-10">
            <div><div className="eyebrow">Real DPI</div><BigValue value={Math.round(measured)} unit="DPI" size={56} /></div>
            <div>
              <div className="eyebrow">Your mouse is set to</div>
              <input type="number" min={50} max={50000} value={expected ?? ''} placeholder="e.g. 800" onChange={(e) => setSetDpi(Number(e.target.value) || undefined)}
                className="recess mt-1 w-28 rounded-lg px-2 py-1.5 text-[15px] text-[var(--text)]" aria-label="DPI the mouse is set to" />
            </div>
            {expected !== undefined && (
              <div>
                <div className="eyebrow">Difference</div>
                <BigValue value={`${dpiError(measured, expected) > 0 ? '+' : ''}${dpiError(measured, expected).toFixed(1)}`} unit="%" size={28} />
              </div>
            )}
          </div>
          <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            Within about ±5% is normal (your hand never moves exactly {distance} {unit}). Repeat it 3 times and look at the middle result.
            {Math.abs(result.y) > Math.abs(result.x) * 0.15 && ' You moved up or down quite a bit: try to keep the mouse straight.'}
            {raw === false && ' Your browser could not read raw movement, so turn off "Enhance pointer precision" in Windows for a fair result.'}
          </p>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- keyboard

interface KeyStat { name: string; presses: Press[] }

function KeyTest() {
  const keys = useRef(new Map<string, KeyStat>())
  const held = useRef(new Set<string>())
  const order = useRef<string[]>([])
  const maxHeld = useRef(0)
  const [focus, setFocus] = useState(false)
  const [threshold, setThreshold] = useState(5)
  const box = useRef<HTMLDivElement>(null)
  useTick(focus, 120)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.repeat) return
      const k = keys.current.get(e.code) ?? { name: e.key.length === 1 ? e.key.toUpperCase() : e.key || e.code, presses: [] }
      k.presses.push({ down: e.timeStamp })
      keys.current.set(e.code, k)
      held.current.add(e.code)
      order.current = [e.code, ...order.current.filter((c) => c !== e.code)].slice(0, 12)
      maxHeld.current = Math.max(maxHeld.current, held.current.size)
    }
    const up = (e: KeyboardEvent) => {
      e.preventDefault()
      const last = keys.current.get(e.code)?.presses.at(-1)
      if (last && last.up === undefined) last.up = e.timeStamp
      held.current.delete(e.code)
    }
    const blur = () => held.current.clear()
    el.addEventListener('keydown', down)
    el.addEventListener('keyup', up)
    el.addEventListener('blur', blur)
    return () => {
      el.removeEventListener('keydown', down)
      el.removeEventListener('keyup', up)
      el.removeEventListener('blur', blur)
    }
  }, [])

  const stats = order.current.map((c) => [c, keys.current.get(c)!] as const)
  const on = (c: string) => held.current.has(c)

  return (
    <div className="grid gap-4">
      <div
        ref={box}
        tabIndex={0}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        className={cn('glass grid min-h-[170px] cursor-text place-items-center p-5 text-center outline-none', focus && 'border-white/40')}
      >
        {focus ? (
          <div>
            <div className="flex min-h-[38px] flex-wrap justify-center gap-2">
              {[...held.current].map((c) => <span key={c} className="plat display rounded-lg px-3 py-2 text-[13px] font-semibold">{keys.current.get(c)?.name ?? c}</span>)}
              {!held.current.size && <span className="text-[13px] text-[var(--text-3)]">Press and hold keys…</span>}
            </div>
            <div className="mt-3 text-[12px] text-[var(--text-3)]">Keys held now: {held.current.size} · most at once: <b className="text-[var(--text)]">{maxHeld.current}</b></div>
          </div>
        ) : (
          <div className="display text-[13px] text-[var(--text)]">Click here, then type. Shortcuts are blocked while this box is selected.</div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="SOCD / Snap Tap check">
          <div className="flex justify-center gap-2 py-2">
            {[['KeyA', 'A'], ['KeyD', 'D']].map(([c, l]) => (
              <span key={c} className={cn('display grid size-14 place-items-center rounded-xl border text-[18px] font-semibold', on(c) ? 'plat border-transparent' : 'border-white/15 text-[var(--text-3)]')}>{l}</span>
            ))}
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            Hold <b>A</b>, then also press <b>D</b>. With SOCD (last input wins) on, A goes dark while D is held, then lights up again when you let D go. If both stay lit, SOCD is off.
          </p>
        </Card>
        <Card title="Rollover">
          <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            Press as many keys at once as you can (for example ASDF + JKL;). <b className="text-[var(--text)]">Most at once</b> above is how many your keyboard sent together. Gaming keyboards should reach 6 or more.
          </p>
        </Card>
      </div>

      <Card title="Per key" right={
        <div className="flex items-center gap-3">
          <span className="text-[11.5px] text-[var(--text-3)]">Count as chatter under</span>
          <Segmented label="Chatter threshold" value={threshold} onChange={setThreshold} options={[['3 ms', 3], ['5 ms', 5], ['10 ms', 10]]} />
          <button type="button" className="chip" onClick={() => { keys.current.clear(); order.current = []; maxHeld.current = 0 }}>Reset</button>
        </div>
      }>
        {stats.length ? (
          <table className="w-full text-left text-[13px]">
            <thead className="eyebrow"><tr><th className="pb-2 font-normal">Key</th><th className="font-normal">Presses</th><th className="font-normal">Last hold</th><th className="font-normal">Fastest re-press</th><th className="font-normal">Chatter</th></tr></thead>
            <tbody>
              {stats.map(([c, k]) => {
                const last = k.presses.at(-1)
                const gap = fastestRepress(k.presses)
                const chat = chatterCount(k.presses, threshold)
                return (
                  <tr key={c} className="border-t border-white/[0.06]">
                    <td className="py-2 text-[var(--text)]">{k.name}</td>
                    <td>{k.presses.length}</td>
                    <td>{last?.up !== undefined ? `${(last.up - last.down).toFixed(1)} ms` : 'held'}</td>
                    <td>{gap !== undefined ? `${gap.toFixed(1)} ms` : '—'}</td>
                    <td className={chat ? 'text-[var(--err)]' : undefined}>{chat ? `${chat} found` : 'none'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="m-0 text-[12.5px] text-[var(--text-3)]">Type in the box above to see each key.</p>
        )}
        <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
          <b className="text-[var(--text-2)]">Fastest re-press</b> is the shortest time between letting a key go and pressing it again. With Rapid Trigger it can be very short, so tap a key quickly to try your RT sensitivity. Chatter is a press that comes back faster than a finger can, which means a faulty switch or a Rapid Trigger setting that's too sensitive.
        </p>
      </Card>
    </div>
  )
}
