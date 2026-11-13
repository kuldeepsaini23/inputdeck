import { createFileRoute } from '@tanstack/react-router'
import { Gamepad2, Gauge, Keyboard, MousePointerClick, Ruler } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Backdrop, Dock, TopBar } from '#/components/shell'
import { BigValue, Card, Segmented } from '#/components/kit'
import { useDevices } from '#/lib/device-context'
import { averageRate, chatterCount, cps, dpiError, dpiOf, fastestRepress, nearestRate, rateOf, type Press } from '#/lib/testers'
import { cn } from '#/lib/utils'
import { useT } from '#/lib/i18n'

/** Put React nodes into a translated sentence: fill(t('Press {key} now'), { key: <b>A</b> }). */
function fill(text: string, parts: Record<string, React.ReactNode>) {
  return text.split(/\{(\w+)\}/).map((s, i) => (i % 2 ? <span key={i}>{s in parts ? parts[s] : `{${s}}`}</span> : s))
}

type Tab = 'polling' | 'clicks' | 'dpi' | 'keys' | 'gamepad'
const TABS: Tab[] = ['polling', 'clicks', 'dpi', 'keys', 'gamepad']

export const Route = createFileRoute('/tools')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => (TABS.includes(s.tab as Tab) ? { tab: s.tab as Tab } : {}),
  component: ToolsPage,
})

function ToolsPage() {
  const { tab = 'polling' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const t = useT()
  return (
    <div className="app">
      <Backdrop />
      <TopBar />
      <main className="no-scrollbar relative z-10 h-[calc(100%-76px)] overflow-y-auto px-4 pt-2 pb-36 sm:px-10">
        <div className="mx-auto max-w-[920px]">
          <div className="eyebrow">{t('Tools')}</div>
          <h1 className="big-num m-0 mt-2 text-[28px]">{t('Check your gear')}</h1>
          <p className="mt-2 mb-6 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--text-2)]">
            {t('These tests only watch what your browser receives. They work with any mouse or keyboard, connected to InputDeck or not, and never change anything.')}
          </p>
          {tab === 'polling' && <PollingTest />}
          {tab === 'clicks' && <ClickTest />}
          {tab === 'dpi' && <DpiTest />}
          {tab === 'keys' && <KeyTest />}
          {tab === 'gamepad' && <GamepadTest />}
        </div>
      </main>
      <Dock
        active={tab}
        onChange={(id) => void navigate({ search: { tab: id as Tab }, replace: true })}
        tabs={[
          { id: 'polling', label: t('Polling rate'), icon: <Gauge className="size-4" /> },
          { id: 'clicks', label: t('Clicks'), icon: <MousePointerClick className="size-4" /> },
          { id: 'dpi', label: t('DPI check'), icon: <Ruler className="size-4" /> },
          { id: 'keys', label: t('Keyboard'), icon: <Keyboard className="size-4" /> },
          { id: 'gamepad', label: t('Gamepad'), icon: <Gamepad2 className="size-4" /> },
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
    const timer = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(timer)
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
  const t = useT()
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
  const recent = times.current.filter((x) => now - x < 500)
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
      <Card title={t('Polling rate')} right={<button type="button" className="chip" onClick={() => { peak.current = undefined; lastAvg.current = undefined; history.current = []; times.current = [] }}>{t('Reset')}</button>}>
        <div className="flex flex-wrap items-end gap-10">
          <div>
            <div className="eyebrow">{isMoving ? t('Now') : t('Last reading')}</div>
            <BigValue value={fmtHz(shown)} unit="Hz" size={56} />
          </div>
          <div>
            <div className="eyebrow">{t('Peak')}</div>
            <BigValue value={fmtHz(peak.current)} unit="Hz" size={28} />
          </div>
          <div>
            <div className="eyebrow">{t('Average (counts drops)')}</div>
            <BigValue value={fmtHz(lastAvg.current)} unit="Hz" size={28} />
          </div>
          {peak.current !== undefined && (
            <div className="text-[12.5px] text-[var(--text-2)]">{fill(t('Looks like a {rate} mouse'), { rate: <b className="text-[var(--text)]">{fmtHz(nearestRate(peak.current))} Hz</b> })}</div>
          )}
        </div>
        <svg className="mt-4 block h-[70px] w-full" viewBox="0 0 600 70" preserveAspectRatio="none" aria-hidden="true">
          <polyline fill="none" stroke="#E6E8EC" strokeOpacity={0.8} strokeWidth={2} vectorEffect="non-scaling-stroke"
            points={history.current.map((v, i) => `${(i / 59) * 600},${68 - (v / max) * 64}`).join(' ')} />
        </svg>
      </Card>
      <div ref={pad} className={cn('glass grid h-[260px] cursor-crosshair select-none place-items-center text-center text-[14px] text-[var(--text-2)] transition-colors', isMoving && 'border-white/30')}>
        <div>
          <div className="display text-[13px] text-[var(--text)]">{t('Move your mouse fast in circles here')}</div>
          <div className="mt-2 text-[12px] text-[var(--text-3)]">{t('Keep moving for a couple of seconds for a steady reading')}</div>
        </div>
      </div>
      <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
        {t('Browsers can miss reports at very high rates (4K/8K), and a busy PC or a USB hub can lower the reading. If the peak is far below what you set, try a USB port on the back of the PC and close other apps. Use it as a rough check, not a lab measurement.')}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- clicks

const BUTTONS = ['Left', 'Middle', 'Right', 'Back', 'Forward']
const buttonNames = (t: (s: string) => string) => [t('Left'), t('Middle'), t('Right'), t('Back'), t('Forward')]

function ClickTest() {
  const presses = useRef<Press[][]>(BUTTONS.map(() => []))
  const downs = useRef<number[]>([])
  const [threshold, setThreshold] = useState(20)
  const [held, setHeld] = useState<number[]>([])
  const t = useT()
  const names = buttonNames(t)
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
          <div className="display text-[13px] text-[var(--text)]">{t('Click here with any button')}</div>
          <div className="mt-2 text-[12px] text-[var(--text-3)]">{t('Single clicks only: if one click shows up as two, the switch is chattering (double-clicking)')}</div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {BUTTONS.map((b, i) => <span key={b} className={cn('chip', held.includes(i) && 'plat')}>{names[i]}</span>)}
          </div>
        </div>
      </div>
      <Card title={t('Results')} right={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-[11.5px] text-[var(--text-3)]">{t('Count as a double click under')}</span>
          <Segmented label={t('Double-click threshold')} value={threshold} onChange={setThreshold} options={[['10 ms', 10], ['20 ms', 20], ['40 ms', 40], ['80 ms', 80]]} />
          <button type="button" className="chip" onClick={() => { presses.current = BUTTONS.map(() => []); downs.current = [] }}>{t('Reset')}</button>
        </div>
      }>
        <div className="mb-4 flex gap-10">
          <div><div className="eyebrow">{t('Clicks per second')}</div><BigValue value={cps(downs.current, now).toFixed(0)} size={34} /></div>
        </div>
        <div className="no-scrollbar overflow-x-auto"><table className="w-full text-left text-[13px]">
          <thead className="eyebrow"><tr><th className="pb-2 pr-3 font-normal">{t('Button')}</th><th className="pr-3 font-normal">{t('Clicks')}</th><th className="pr-3 font-normal">{t('Last hold')}</th><th className="pr-3 font-normal">{t('Fastest gap')}</th><th className="font-normal">{t('Double clicks')}</th></tr></thead>
          <tbody>
            {BUTTONS.map((b, i) => {
              const p = presses.current[i]
              const last = p.at(-1)
              const chat = chatterCount(p, threshold)
              const gap = fastestRepress(p)
              return (
                <tr key={b} className="border-t border-white/[0.06]">
                  <td className="py-2 text-[var(--text)]">{names[i]}</td>
                  <td>{p.length}</td>
                  <td>{last?.up !== undefined ? `${(last.up - last.down).toFixed(1)} ms` : '—'}</td>
                  <td>{gap !== undefined ? `${gap.toFixed(1)} ms` : '—'}</td>
                  <td className={chat ? 'text-[var(--err)]' : undefined}>{chat ? t('{n} found', { n: chat }) : p.length ? t('none') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
        <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
          {t("A human can't click again within about 20 ms of letting go, so a second click that fast is almost always the switch bouncing. If you see double clicks, raise the mouse's click debounce on its Buttons tab and test again.")}
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
  const t = useT()
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
      <Card title={`1 · ${t('Set up')}`}>
        <ol className="m-0 grid gap-2 pl-5 text-[13px] leading-relaxed text-[var(--text-2)]">
          <li>{t('Put a ruler (or a tape measure) on your mouse pad, and line up the front of your mouse with the 0 mark.')}</li>
          <li>{t('Pick the distance you will move:')}
            <span className="ml-2 inline-flex items-center gap-2 align-middle">
              <input type="number" min={1} max={100} value={distance} onChange={(e) => setDistance(Math.max(1, Number(e.target.value) || 1))}
                className="recess w-20 rounded-lg px-2 py-1 text-[13px] text-[var(--text)]" aria-label={t('Distance')} />
              <Segmented label={t('Unit')} value={unit} onChange={setUnit} options={[['cm', 'cm'], [t('inch'), 'in']]} />
            </span>
          </li>
          <li>{fill(t('Press Start, slide the mouse {direction} exactly that far, then click.'), { direction: <b className="text-[var(--text)]">{t('straight to the right')}</b> })}</li>
        </ol>
      </Card>
      <div ref={target} className={cn('glass grid h-[200px] place-items-center text-center', running && 'border-white/40')}>
        {running ? (
          <div>
            <div className="display text-[13px] text-[var(--text)]">{t('Slide right {distance} {unit}, then click', { distance, unit })}</div>
            <div className="mt-3 text-[12px] tabular-nums text-[var(--text-3)]">{t('{x} counts across · {y} up/down', { x: Math.abs(live?.x ?? 0), y: live?.y ?? 0 })}</div>
          </div>
        ) : (
          <button type="button" className="plat display rounded-full px-7 py-3 text-[13px] font-semibold" onClick={() => void start()}>{t('Start')}</button>
        )}
      </div>
      {result && measured !== undefined && (
        <Card title={`2 · ${t('Result')}`}>
          <div className="flex flex-wrap items-end gap-10">
            <div><div className="eyebrow">{t('Real DPI')}</div><BigValue value={Math.round(measured)} unit="DPI" size={56} /></div>
            <div>
              <div className="eyebrow">{t('Your mouse is set to')}</div>
              <input type="number" min={50} max={50000} value={expected ?? ''} placeholder={t('e.g. {value}', { value: 800 })} onChange={(e) => setSetDpi(Number(e.target.value) || undefined)}
                className="recess mt-1 w-28 rounded-lg px-2 py-1.5 text-[15px] text-[var(--text)]" aria-label={t('DPI the mouse is set to')} />
            </div>
            {expected !== undefined && (
              <div>
                <div className="eyebrow">{t('Difference')}</div>
                <BigValue value={`${dpiError(measured, expected) > 0 ? '+' : ''}${dpiError(measured, expected).toFixed(1)}`} unit="%" size={28} />
              </div>
            )}
          </div>
          <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            {t('Within about ±5% is normal (your hand never moves exactly {distance} {unit}). Repeat it 3 times and look at the middle result.', { distance, unit })}
            {Math.abs(result.y) > Math.abs(result.x) * 0.15 && ' ' + t('You moved up or down quite a bit: try to keep the mouse straight.')}
            {raw === false && ' ' + t('Your browser could not read raw movement, so turn off "Enhance pointer precision" in Windows for a fair result.')}
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
  const t = useT()
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
              {!held.current.size && <span className="text-[13px] text-[var(--text-3)]">{t('Press and hold keys…')}</span>}
            </div>
            <div className="mt-3 text-[12px] text-[var(--text-3)]">{fill(t('Keys held now: {n} · most at once: {max}', { n: held.current.size }), { max: <b className="text-[var(--text)]">{maxHeld.current}</b> })}</div>
          </div>
        ) : (
          <div className="display text-[13px] text-[var(--text)]">{t('Click here, then type. Shortcuts are blocked while this box is selected.')}</div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('SOCD / Snap Tap check')}>
          <div className="flex justify-center gap-2 py-2">
            {[['KeyA', 'A'], ['KeyD', 'D']].map(([c, l]) => (
              <span key={c} className={cn('display grid size-14 place-items-center rounded-xl border text-[18px] font-semibold', on(c) ? 'plat border-transparent' : 'border-white/15 text-[var(--text-3)]')}>{l}</span>
            ))}
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            {fill(t('Hold {a}, then also press {d}. With SOCD (last input wins) on, A goes dark while D is held, then lights up again when you let D go. If both stay lit, SOCD is off.'), { a: <b>A</b>, d: <b>D</b> })}
          </p>
        </Card>
        <Card title={t('Rollover')}>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--text-3)]">
            {fill(t('Press as many keys at once as you can (for example ASDF + JKL;). {mostAtOnce} above is how many your keyboard sent together. Gaming keyboards should reach 6 or more.'), { mostAtOnce: <b className="text-[var(--text)]">{t('Most at once')}</b> })}
          </p>
        </Card>
      </div>

      <Card title={t('Per key')} right={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-[11.5px] text-[var(--text-3)]">{t('Count as chatter under')}</span>
          <Segmented label={t('Chatter threshold')} value={threshold} onChange={setThreshold} options={[['3 ms', 3], ['5 ms', 5], ['10 ms', 10]]} />
          <button type="button" className="chip" onClick={() => { keys.current.clear(); order.current = []; maxHeld.current = 0 }}>{t('Reset')}</button>
        </div>
      }>
        {stats.length ? (
          <div className="no-scrollbar overflow-x-auto"><table className="w-full text-left text-[13px]">
            <thead className="eyebrow"><tr><th className="pb-2 pr-3 font-normal">{t('Key')}</th><th className="pr-3 font-normal">{t('Presses')}</th><th className="pr-3 font-normal">{t('Last hold')}</th><th className="pr-3 font-normal">{t('Fastest re-press')}</th><th className="font-normal">{t('Chatter')}</th></tr></thead>
            <tbody>
              {stats.map(([c, k]) => {
                const last = k.presses.at(-1)
                const gap = fastestRepress(k.presses)
                const chat = chatterCount(k.presses, threshold)
                return (
                  <tr key={c} className="border-t border-white/[0.06]">
                    <td className="py-2 text-[var(--text)]">{k.name}</td>
                    <td>{k.presses.length}</td>
                    <td>{last?.up !== undefined ? `${(last.up - last.down).toFixed(1)} ms` : t('held')}</td>
                    <td>{gap !== undefined ? `${gap.toFixed(1)} ms` : '—'}</td>
                    <td className={chat ? 'text-[var(--err)]' : undefined}>{chat ? t('{n} found', { n: chat }) : t('none')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        ) : (
          <p className="m-0 text-[12.5px] text-[var(--text-3)]">{t('Type in the box above to see each key.')}</p>
        )}
        <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
          <b className="text-[var(--text-2)]">{t('Want to see how far each key is pressed?')}</b>{' '}
          {fill(t('On a Wraith W75 HE or Lofree Hyzen, open the keyboard, go to Performance and press {testKeys}.'), { testKeys: <b className="text-[var(--text-2)]">{t('Test keys')}</b> })}{' '}
          {fill(t("{fastest} is the shortest time between letting a key go and pressing it again. With Rapid Trigger it can be very short, so tap a key quickly to try your RT sensitivity. Chatter is a press that comes back faster than a finger can, which means a faulty switch or a Rapid Trigger setting that's too sensitive."), { fastest: <b className="text-[var(--text-2)]">{t('Fastest re-press')}</b> })}
        </p>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- gamepad

const STD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home']

interface PadSnap { id: string; mapping: string; axes: number[]; buttons: number[] }

function snap(): PadSnap[] {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
  return [...pads].filter((p): p is Gamepad => !!p).map((p) => ({ id: p.id, mapping: p.mapping, axes: [...p.axes], buttons: p.buttons.map((b) => b.value) }))
}

function Stick({ x, y, label }: { x: number; y: number; label: string }) {
  const mag = Math.min(1, Math.hypot(x, y))
  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={120} height={120} viewBox="-60 -60 120 120" aria-label={`${label}: ${x.toFixed(2)}, ${y.toFixed(2)}`}>
        <circle r={54} fill="none" stroke="#fff" strokeOpacity={0.15} />
        <rect x={-54} y={-54} width={108} height={108} fill="none" stroke="#fff" strokeOpacity={0.06} />
        <line x1={-54} x2={54} y1={0} y2={0} stroke="#fff" strokeOpacity={0.08} />
        <line y1={-54} y2={54} x1={0} x2={0} stroke="#fff" strokeOpacity={0.08} />
        <line x1={0} y1={0} x2={x * 54} y2={y * 54} stroke="#E6E8EC" strokeOpacity={0.5} />
        <circle cx={x * 54} cy={y * 54} r={7} fill="#E6E8EC" />
      </svg>
      <div className="eyebrow">{label}</div>
      <div className="text-[11.5px] tabular-nums text-[var(--text-3)]">{x.toFixed(2)}, {y.toFixed(2)} · {(mag * 100).toFixed(0)}%</div>
    </div>
  )
}

function Bar({ v, label }: { v: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-12 whitespace-nowrap text-[12px] text-[var(--text-2)]">{label}</span>
      <div className="recess h-2.5 flex-1 overflow-hidden rounded-full">
        <div className="h-full rounded-full bg-[var(--plat)]" style={{ width: `${Math.round(Math.min(1, Math.abs(v)) * 100)}%` }} />
      </div>
      <span className="w-12 text-right text-[11.5px] tabular-nums text-[var(--text-3)]">{(v * 100).toFixed(0)}%</span>
    </div>
  )
}

function GamepadTest() {
  const [pads, setPads] = useState<PadSnap[]>([])
  const t = useT()
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setPads(snap())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (!pads.length) {
    return (
      <Card title={t('Gamepad tester')}>
        <p className="m-0 text-[13.5px] leading-relaxed text-[var(--text-2)]">
          {fill(t('No controller found yet. Plug in a controller, or switch a keyboard that supports it into gamepad mode, then {press} (browsers only show a controller after its first button press).'), { press: <b className="text-[var(--text)]">{t('press any button')}</b> })}
        </p>
        <p className="mt-3 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
          {t("Keyboards with a gamepad mode include ATK HE boards (EDGE, RS, ATK68), VGN FLASH68, and some Wraith-family HE boards. Turn it on from the keyboard's Gamepad tab in InputDeck.")}
        </p>
      </Card>
    )
  }

  return (
    <div className="grid gap-4">
      {pads.map((p, i) => {
        const std = p.mapping === 'standard'
        const ax = (n: number) => p.axes[n] ?? 0
        return (
          <Card key={i} title={t('Controller {n}', { n: i + 1 })} right={<span className="max-w-[60%] truncate text-[11.5px] text-[var(--text-3)]" title={p.id}>{p.id}</span>}>
            {std ? (
              <>
                <div className="flex flex-wrap justify-around gap-6 py-2">
                  <Stick x={ax(0)} y={ax(1)} label={t('Left stick')} />
                  <Stick x={ax(2)} y={ax(3)} label={t('Right stick')} />
                  <div className="grid min-w-[220px] flex-1 content-center gap-3">
                    <Bar v={p.buttons[6] ?? 0} label="LT" />
                    <Bar v={p.buttons[7] ?? 0} label="RT" />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {STD_BUTTONS.map((b, n) => n < p.buttons.length && (
                    <span key={b} className={cn('chip tabular-nums', (p.buttons[n] ?? 0) > 0.1 && 'plat !border-transparent')}>{b}</span>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2.5">
                  {p.axes.map((v, n) => <Bar key={n} v={v} label={t('Axis {n}', { n: n + 1 })} />)}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {p.buttons.map((v, n) => <span key={n} className={cn('chip tabular-nums', v > 0.1 && 'plat !border-transparent')}>{n + 1}</span>)}
                </div>
              </>
            )}
            <p className="mt-4 mb-0 text-[12px] leading-relaxed text-[var(--text-3)]">
              {std
                ? t('Press a key half way: an analog keyboard should move the stick part of the way, not jump straight to the edge. If the stick reaches the corner when you press two directions, square output is on.')
                : t('This controller uses a classic (DirectInput) layout, so axes and buttons are shown by number.')}
            </p>
          </Card>
        )
      })}
    </div>
  )
}
