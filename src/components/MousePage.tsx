import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { setSkin } from '#/drivers/wlmouse'
import { Battery, Crosshair, Gauge, Info, Monitor, MousePointerClick, SlidersHorizontal, Mouse } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#/components/ui/dialog'
import type { DeviceState } from '#/devices'
import type { Setting, Value } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { BigValue, Card, ColorPicker, Range, Row, Segmented, Stepper, Toggle, hex, type Choice } from './kit'
import { GenericCard, Hero, MiniStats, Pulse, shortHz, type Edit } from './parts'
import { Dock, textOf } from './shell'
import { Receiver, ScreenCards, useScreenEditor } from './ScreenPanel'

type Dpi = Extract<Value, { kind: 'dpi' }>

const ORDER = ['Performance', 'DPI', 'Buttons', 'Power', 'Dongle screen', 'Advanced']
const ICON: Record<string, React.ReactNode> = {
  Performance: <Gauge className="size-4" />,
  DPI: <Crosshair className="size-4" />,
  Buttons: <MousePointerClick className="size-4" />,
  Power: <Battery className="size-4" />,
  'Dongle screen': <Monitor className="size-4" />,
  Advanced: <SlidersHorizontal className="size-4" />,
}
const TAB_LABEL: Record<string, string> = { 'Dongle screen': 'Screen' }
const HIDDEN_GROUPS = new Set(['Info', 'Profile'])

// button marker positions on the product photo (fractions of the photo box)
const SPOTS: Record<string, { x: number; y: number; n: string; side: 'l' | 'r' }> = {
  btn1: { x: 0.33, y: 0.17, n: '1', side: 'l' },
  btn2: { x: 0.67, y: 0.17, n: '2', side: 'r' },
  btn3: { x: 0.5, y: 0.08, n: '3', side: 'r' },
  btn4: { x: 0.12, y: 0.55, n: '4', side: 'l' },
  btn5: { x: 0.12, y: 0.45, n: '5', side: 'l' },
}

/** "1 mm" -> "1.0", "0.7 mm" -> "0.7" (Figma shows one decimal, no unit) */
const mm1 = (l?: string) => (l === undefined ? undefined : isNaN(parseFloat(l)) ? l : parseFloat(l).toFixed(1))
/** "30 sec" -> "30s", "5 min" -> "5m" */
const shortTime = (l: string) => l.replace(/\s*sec$/, 's').replace(/\s*min$/, 'm')
/** Performance settings that Figma's Performance screen doesn't show: they live on Advanced */
const isExtra = (s: Setting) => s.group === 'Performance' && (s.key === 'angle_tune' || (s.value.kind === 'toggle' && s.key !== 'motion_sync'))
const BTN_SHORT: Record<string, string> = { btn1: 'Left', btn2: 'Right', btn3: 'Wheel', btn4: 'Side rear', btn5: 'Side front' }
const ACTION_GROUPS: [string, RegExp][] = [
  ['Mouse', /click|^back$|^forward$|scroll/i],
  ['DPI', /dpi|profile|polling|lod/i],
  ['Media', /volume|mute|play|track|stop/i],
  ['Off', /disabled/i],
]
const actionGroup = (l: string) => ACTION_GROUPS.find(([, r]) => r.test(l))?.[0] ?? 'Other'
const choiceLabel = (s?: Setting) => (s?.value.kind === 'choice' ? s.value.options.find((o) => o[1] === (s.value as Choice).current)?.[0] : undefined)

export function MousePage({ dev, tab, setTab, onEdit }: { dev: DeviceState; tab?: string; setTab: (t: string) => void; onEdit: Edit }) {
  const edit = dev.edit
  const get = (k: string) => edit?.find((s) => s.key === k)
  const groups = useMemo(() => {
    const g = [...new Set((edit ?? []).map((s) => s.group))].filter((x) => !HIDDEN_GROUPS.has(x))
    if (!g.includes('Advanced') && (edit ?? []).some(isExtra)) g.push('Advanced')
    return g.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
  }, [edit])
  const active = tab && groups.includes(tab) ? tab : groups[0]
  const [btn, setBtn] = useState('btn1')
  const [stage, setStage] = useState<number | null>(null)
  const screenEd = useScreenEditor(dev)

  const brand = dev.driver.brand().toUpperCase()
  const dpiS = get('dpi')
  const dpi = dpiS?.value.kind === 'dpi' ? dpiS.value : undefined
  const battery = textOf(dev, 'battery')
  const pct = battery ? parseInt(battery, 10) : undefined
  const fw = textOf(dev, 'fw')
  const image = dev.driver.image()
  const inGroup = (g: string) => (edit ?? []).filter((s) => s.group === g)

  let left: React.ReactNode = null
  let right: React.ReactNode = null
  let spots = false
  let spotKeys: string[] = Object.keys(SPOTS)

  const [, setSkinTick] = useState(0)
  const isWl = /wlmouse\.gg/.test(image ?? '')
  const skinN = Number(/Colors\/(\d+)\.png/.exec(image ?? '')?.[1] ?? 1)
  const changeSkin = (d: number) => {
    const n = ((skinN - 1 + d + 12) % 12) + 1
    setSkin(dev.id, n)
    setSkinTick((x) => x + 1)
  }
  if (active === 'Performance') {
    spots = true
    spotKeys = ['btn1', 'btn2', 'btn4']
  }
  if (!edit) {
    left = <Hero brand={brand} label="Reading settings" value="…" sub="Talking to the mouse." />
  } else if (active === 'Performance' || active === 'DPI') {
    const sel = stage ?? dpi?.active ?? 0
    left = (
      <div className={cn('flex h-full flex-col gap-10', active === 'Performance' ? 'justify-start' : 'justify-between')}>
        {dpi ? (
          <Hero brand={brand} label="Sensitivity" value={String(dpi.stages[dpi.active])} unit="DPI"
            sub={`Stage ${dpi.active + 1} of ${dpi.stages.length} · press the DPI button to cycle`}>
            <StageBar dpi={dpi} />
          </Hero>
        ) : (
          <Hero brand={brand} label="Mouse" value={dev.driver.model()} size={56} />
        )}
        {active === 'Performance' ? (
          <div className="mt-[54px]"><MiniStats items={[['Battery', pct !== undefined ? String(pct) : undefined, '%'], ['Lift-off', mm1(choiceLabel(get('lod'))), 'mm'], ['Firmware', fw]]} /></div>
        ) : dpi?.colors ? (
          <div>
            <div className="eyebrow mb-3">Stage {sel + 1} LED colour</div>
            <ColorPicker label={`Stage ${sel + 1} LED colour`} value={dpi.colors[sel] ?? null}
              onChange={(c) => { const colors = dpi.colors!.slice(); colors[sel] = c; onEdit('dpi', { ...dpi, colors }) }} />
          </div>
        ) : null}
      </div>
    )
    right = active === 'Performance' ? <PerformanceCards get={get} settings={inGroup('Performance')} onEdit={onEdit} pct={pct} charging={!!battery?.includes('charg')} /> : (
      <DpiCards dpi={dpi} sel={sel} setSel={setStage} get={get} onEdit={onEdit} rest={inGroup('DPI').filter((s) => !['dpi', 'dpi_count', 'dpi_xy', 'dpi_y'].includes(s.key) && !s.key.startsWith('dpi_color'))} />
    )
  } else if (active === 'Buttons') {
    spots = true
    const btns = inGroup('Buttons').filter((s) => s.key in SPOTS)
    const cur = get(btn) ?? btns[0]
    left = (
      <div className="flex h-full flex-col gap-[90px]">
        <Hero brand={brand} label={cur ? `Button ${SPOTS[cur.key].n} · ${BTN_SHORT[cur.key] ?? cur.label}` : 'Buttons'} value={choiceLabel(cur) ?? '—'} size={68}
          sub="Pick a button on the mouse, then choose what it does." />
        <div>
        <div className="eyebrow mb-3">All buttons</div>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="All buttons">
          {btns.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={() => setBtn(s.key)} aria-pressed={s.key === cur?.key}
                className={cn('flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left', s.key === cur?.key ? 'bg-white/5' : 'hover:bg-white/[0.03]')}>
                <span className={cn('display grid size-[22px] place-items-center rounded-full text-[9px] font-semibold', s.key === cur?.key ? 'plat' : 'bg-white/5 text-[var(--text-2)]')}>{SPOTS[s.key].n}</span>
                <span className="w-[100px] truncate text-[12.5px] text-[var(--text-3)]">{BTN_SHORT[s.key] ?? s.label}</span>
                <span className="display truncate text-[11.5px]">{choiceLabel(s)}</span>
              </button>
            </li>
          ))}
        </ul>
        </div>
      </div>
    )
    const db = get('debounce')
    right = (
      <>
        {cur?.value.kind === 'choice' && (
          <ActionPicker key={cur.key} title={`Action for button ${SPOTS[cur.key].n}`} label={`Action for ${cur.label}`} v={cur.value} onChange={(c) => onEdit(cur.key, { ...(cur.value as Choice), current: c })} />
        )}
        {db?.value.kind === 'number' && (
          <Card title="Click debounce">
            <BigValue value={db.value.current} unit="ms" size={28} />
            <Range className="mt-3" label="Click debounce" min={db.value.min} max={db.value.max} value={db.value.current}
              onChange={(n) => onEdit('debounce', { ...(db.value as Extract<Value, { kind: 'number' }>), current: n })} />
            <p className="hint mt-2 mb-0">Lower is faster. Raise it if a button double-clicks.</p>
          </Card>
        )}
        <GenericCard title="More" settings={inGroup('Buttons').filter((s) => !(s.key in SPOTS) && s.key !== 'debounce')} onEdit={onEdit} />
      </>
    )
  } else if (active === 'Power') {
    const sleep = get('sleep')
    left = (
      <div className="flex h-full flex-col gap-[150px]">
        {pct !== undefined ? (
          <Hero brand={brand} label="Battery" value={pct} unit="%" sub={battery?.includes('charg') ? 'Charging' : 'Wireless'}>
            <Cells pct={pct} />
          </Hero>
        ) : (
          <Hero brand={brand} label="Power" value="—" />
        )}
        <MiniStats items={[['Status', battery?.includes('charg') ? 'Charging' : 'Wireless'], ['Sleep', choiceLabel(sleep)?.split(' ')[0], choiceLabel(sleep)?.split(' ')[1]], ['Firmware', fw]]} />
      </div>
    )
    right = (
      <>
        {sleep?.value.kind === 'choice' && (
          <Card title="Sleep after" className="min-h-[260px]">
            {(() => { const [n, u] = (choiceLabel(sleep) ?? '—').split(' '); return <BigValue value={n} unit={u} size={34} /> })()}
            <Timeline label="Sleep after" options={sleep.value.options} value={sleep.value.current} onChange={(c) => onEdit('sleep', { ...(sleep.value as Choice), current: c })} />
            <p className="hint mt-9 mb-0">The mouse sleeps after this long without movement.</p>
          </Card>
        )}
        {textOf(dev, 'dongle_fw') && (
          <Card title="Receiver" className="min-h-[170px]" right={
            <svg width="40" height="40" viewBox="0 0 56 56" fill="none" aria-hidden="true"><rect x="10" y="14" width="36" height="36" rx="9" fill="#1A1A1D" stroke="#C1C4CB" strokeOpacity="0.35" /><rect x="16" y="20" width="24" height="24" rx="5" fill="#0A0A0B" /><path d="M22 10a10 10 0 0 1 12 0M18 6a16 16 0 0 1 20 0" stroke="#C1C4CB" strokeOpacity="0.6" strokeWidth="1.6" strokeLinecap="round" /></svg>
          }>
            <div className="display text-[16px] font-semibold">{dev.driver.model()} receiver</div>
            <div className="mt-2.5 flex items-center gap-2 text-[12px] text-[var(--text-2)]"><span className="size-1.5 rounded-full bg-[var(--ok)]" />Connected · firmware {textOf(dev, 'dongle_fw')}</div>
            <p className="hint mt-5 mb-0">Plug the receiver in close to the mouse for the best signal.</p>
          </Card>
        )}
        <GenericCard title="More" settings={inGroup('Power').filter((s) => s.key !== 'sleep')} onEdit={onEdit} />
      </>
    )
  } else if (active === 'Dongle screen') {
    const imgs = textOf(dev, 'screen_images')
    const count = imgs && /^(\d+) of (\d+)/.exec(imgs)
    left = (
      <Hero brand={brand} label="Dongle screen" value={String(dev.driver.screen?.width ?? 360)} unit={`× ${dev.driver.screen?.height ?? 360}`}
        sub={<>The screen on your {dev.driver.model()} receiver.<br />{count ? `${count[1]} of ${count[2]} pictures stored now.` : 'Show your own pictures or GIFs.'}</>} />
    )
    right = (
      <>
        <ScreenCards ed={screenEd} />
        <GenericCard title="Screen" settings={inGroup('Dongle screen').filter((s) => s.value.kind !== 'text')} onEdit={onEdit} />
      </>
    )
  } else if (active === 'Advanced') {
    const listOf = (k: string) => { const t = textOf(dev, k); return t ? t.split('|') : [] }
    const missing = listOf('fw_missing')
    const present = listOf('fw_present')
    const hidden = get('rgb_effect') ? 1 : 0
    left = (
      <div className="flex h-full flex-col gap-[90px]">
        <Hero brand={brand} label="Firmware check" value={String(missing.length + present.length + hidden)} unit="features checked"
          sub={<>Read-only check against firmware {fw ?? '—'}.<br />Nothing is changed on your mouse.</>} />
        <MiniStats items={[['Hidden', String(hidden)], ['Not on firmware', String(missing.length)], ['Firmware', fw]]} />
      </div>
    )
    right = <AdvancedCards get={get} onEdit={onEdit} model={dev.driver.model()} missing={missing} present={present} extras={(edit ?? []).filter(isExtra)} rest={inGroup('Advanced').filter((s) => !s.key.startsWith('rgb_') && s.value.kind !== 'text')} />
  } else if (active) {
    left = <Hero brand={brand} label={active} value={dev.driver.model()} size={56} />
    right = <GenericCard title={active} settings={inGroup(active)} onEdit={onEdit} />
  }

  const cur = get(btn)
  const pickable = active === 'Buttons'
  return (
    <>
      <main className={cn('relative z-10 grid h-[calc(100%-76px)] gap-10 pr-10 pl-16 pb-[110px]', spots ? 'grid-cols-[minmax(240px,1fr)_minmax(520px,1.4fr)_360px]' : 'grid-cols-[minmax(260px,1fr)_minmax(300px,0.9fr)_360px]')}>
        <div key={`left-${active}`} className="min-h-0 pt-[74px]">{left}</div>
        <div className="relative grid min-h-0 place-items-center">
          <div className="breathe pointer-events-none absolute top-1/2 left-1/2 size-[min(520px,90%)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgb(230_232_236/0.12),transparent_65%)]" />
          {active === 'Advanced' && [360, 470, 580, 690].map((d, i) => (
            <div key={d} className={cn('pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[56%] rounded-full border', i === 1 ? 'border-dashed border-white/[0.07]' : 'border-white/[0.06]')} style={{ width: d, height: d }} />
          ))}
          <div className="pointer-events-none absolute bottom-[6%] left-1/2 h-12 w-[70%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgb(0_0_0/0.9),transparent)]" />
          {active === 'Dongle screen' && dev.driver.screen ? (
            <Receiver picture={screenEd.shown} round={dev.driver.screen.round} />
          ) : (
          <div className={cn('relative -mt-[60px]', !pickable && 'float')} style={{ height: pickable ? 'min(58vh, 540px)' : 'min(64vh, 580px)', aspectRatio: '300 / 580' }}>
            {image ? (
              <img src={image} alt={`${dev.driver.brand()} ${dev.driver.model()}`} className="size-full object-contain drop-shadow-[0_40px_40px_rgb(0_0_0/0.8)]" />
            ) : (
              <Mouse className="size-full text-white/10" strokeWidth={0.6} />
            )}
            {spots && Object.entries(SPOTS).filter(([k]) => spotKeys.includes(k)).map(([k, p]) => {
              const s = get(k)
              if (!s) return null
              const on = pickable && k === (cur ? btn : 'btn1')
              const pick = () => { setBtn(k); if (!pickable) setTab('Buttons') }
              const left = p.side === 'l'
              // leader line runs from the marker to a label outside the photo
              const line: React.CSSProperties = left
                ? { left: 'calc(-1 * var(--gap))', width: `calc(${p.x * 100}% + var(--gap))` }
                : { left: `${p.x * 100}%`, width: `calc(${(1 - p.x) * 100}% + var(--gap))` }
              return (
                <div key={k} className="pointer-events-none absolute inset-x-0" style={{ top: `${p.y * 100}%`, ['--gap' as string]: '40px' }}>
                  <span className="absolute h-px" style={{ ...line, background: `linear-gradient(${left ? '90deg' : '270deg'}, transparent, rgb(230 232 236 / ${on ? 0.7 : 0.35}))` }} />
                  <button type="button" onClick={pick} aria-label={`Button ${p.n}: ${choiceLabel(s)}`}
                    className="pointer-events-auto absolute" style={{ left: `${p.x * 100}%` }}>
                    <span className={cn('hotspot-ring', on && 'on')} />
                    <span className="hotspot-dot" />
                  </button>
                  <button type="button" onClick={pick} tabIndex={-1}
                    className={cn('pointer-events-auto absolute -top-[17px] max-w-[190px] whitespace-nowrap', left ? 'right-[calc(100%+var(--gap)+8px)] text-right' : 'left-[calc(100%+var(--gap)+8px)] text-left')}>
                    <span className="eyebrow block">Button {p.n}</span>
                    <span className={cn('display mt-0.5 block truncate text-[13px] font-medium', on ? 'font-semibold' : !pickable ? '' : 'opacity-80')}>{choiceLabel(s)}</span>
                  </button>
                </div>
              )
            })}
            {isWl && (
              <div className="absolute -bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-1 text-[11px] whitespace-nowrap text-[var(--text-3)]">
                <button type="button" data-press className="grid size-6 place-items-center rounded-full hover:text-[var(--text)]" onClick={() => changeSkin(-1)} aria-label="Previous photo colour"><ChevronLeft className="size-3.5" /></button>
                Photo colour
                <button type="button" data-press className="grid size-6 place-items-center rounded-full hover:text-[var(--text)]" onClick={() => changeSkin(1)} aria-label="Next photo colour"><ChevronRight className="size-3.5" /></button>
              </div>
            )}
          </div>
          )}
        </div>
        <div key={`right-${active}`} className="cascade scroll-thin -mr-2 flex min-h-0 flex-col gap-3.5 overflow-y-auto pt-11 pr-2 pb-4">{right}</div>
      </main>
      <Dock tabs={groups.map((g) => ({ id: g, label: TAB_LABEL[g] ?? g, icon: ICON[g] ?? <SlidersHorizontal className="size-4" /> }))} active={active ?? ''} onChange={setTab} />
    </>
  )
}

function StageBar({ dpi }: { dpi: Dpi }) {
  return (
    <div className="mt-2 flex gap-2.5" aria-hidden="true">
      {dpi.stages.map((v, i) => (
        <div key={i} className="flex w-[54px] flex-col items-center gap-[7px]">
          <span className={cn('h-1 w-full rounded-[2px]', i === dpi.active ? 'bg-[var(--plat)] shadow-[0_0_10px_rgb(193_196_203/0.45)]' : 'bg-white/[0.12]')} />
          <span className={cn('display text-[10.5px] font-medium', i === dpi.active ? 'text-[var(--plat)]' : 'text-[rgb(242_242_245/0.4)]')}>{v >= 10000 ? `${Math.round(v / 1000)}K` : v}</span>
        </div>
      ))}
    </div>
  )
}

function Cells({ pct }: { pct: number }) {
  return (
    <div className="mt-5 flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => {
        const fill = Math.min(1, Math.max(0, pct / 10 - i))
        return (
          <span key={i} className="relative h-11 w-7 overflow-hidden rounded-[5px] bg-white/5 shadow-[inset_0_2px_3px_rgb(0_0_0/0.6)]">
            <span className="plat absolute inset-y-0 left-0" style={{ width: `${fill * 100}%` }} />
          </span>
        )
      })}
      <span className="h-4 w-1.5 rounded-sm bg-white/15" />
    </div>
  )
}

function PerformanceCards({ get, settings, onEdit, pct, charging }: { get: (k: string) => Setting | undefined; settings: Setting[]; onEdit: Edit; pct?: number; charging: boolean }) {
  const poll = get('polling')
  const lod = get('lod')
  const lodMode = get('lod_mode')
  const sync = get('motion_sync')
  const used = new Set(['polling', 'lod', 'lod_mode', 'angle_tune', 'motion_sync'])
  const rest = settings.filter((s) => !used.has(s.key) && s.value.kind !== 'toggle')
  const pollLabel = choiceLabel(poll)
  const syncOn = sync?.value.kind === 'toggle' && sync.value.on
  return (
    <>
      {poll?.value.kind === 'choice' && (
        <Card title="Polling rate" className="min-h-[172px]">
          <div className="flex items-end justify-between">
            <BigValue value={pollLabel?.replace(/\s*Hz/i, '') ?? '—'} unit="Hz" size={34} />
            <Pulse rate={parseInt(pollLabel ?? '1000', 10)} width={120} />
          </div>
          <Segmented className="mt-[22px]" label="Polling rate" options={poll.value.options.map(([l, v]) => [shortHz(l), v] as const)} value={poll.value.current}
            onChange={(c) => onEdit('polling', { ...(poll.value as Choice), current: c })} />
        </Card>
      )}
      {lod?.value.kind === 'choice' && (
        <Card title="Lift-off distance" className="min-h-[150px]" right={lodMode?.value.kind === 'choice' ? (
          <Segmented label="Lift-off mode" className="!p-[2px] [&_button]:!px-2.5 [&_button]:!py-1 [&_button]:!text-[9px]" options={lodMode.value.options} value={lodMode.value.current}
            onChange={(c) => onEdit('lod_mode', { ...(lodMode.value as Choice), current: c })} />
        ) : undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <BigValue value={mm1(choiceLabel(lod)) ?? '—'} unit="mm" size={34} />
              <p className="hint mt-7 mb-0 max-w-[150px]">Mouse stops tracking above this height</p>
            </div>
            <div className="flex w-[150px] flex-col gap-[18px] pt-1" role="radiogroup" aria-label="Lift-off distance">
              {[...lod.value.options].reverse().map(([l, v]) => {
                const on = v === (lod.value as Choice).current
                return (
                  <button key={v} type="button" role="radio" aria-checked={on} aria-label={l} onClick={() => onEdit('lod', { ...(lod.value as Choice), current: v })} className="group flex items-center gap-3">
                    <span className={cn('flex-1', on ? 'h-0.5 bg-[var(--plat)] shadow-[0_0_8px_rgb(193_196_203/0.4)]' : 'h-px bg-white/15 group-hover:bg-white/30')} />
                    <span className={cn('display w-6 text-right text-[11px] font-medium', on ? 'text-[var(--plat)]' : 'text-[rgb(242_242_245/0.4)]')}>{mm1(l)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3.5">
        {pct !== undefined && (
          <Card title="Battery" className="min-h-[150px] !px-[19px]">
            <div className="mt-4 flex items-center gap-3">
              <Ring pct={pct} />
              <span className="display text-[11px] text-[rgb(242_242_245/0.45)]">{charging ? 'Charging' : 'Wireless'}</span>
            </div>
          </Card>
        )}
        {sync?.value.kind === 'toggle' && (
          <Card className={cn('min-h-[150px] !px-[19px]', syncOn && '!border-[rgb(193_196_203/0.45)] !bg-[linear-gradient(180deg,rgb(193_196_203/0.14),rgb(193_196_203/0.03))]')}
            title={<span className="block leading-[1.5]">Motion<br />sync</span>}
            right={<Toggle label="Motion sync" checked={syncOn} onChange={(on) => onEdit('motion_sync', { kind: 'toggle', on })} />}>
            <div className={cn('display text-[26px] font-semibold', syncOn ? 'text-[var(--plat)]' : 'text-[var(--text-2)]')}>{syncOn ? 'On' : 'Off'}</div>
            <p className="mt-2 mb-0 text-[11.5px] leading-snug text-[rgb(242_242_245/0.45)]">Sensor reads line up with every report</p>
          </Card>
        )}
      </div>
      <GenericCard title="More" settings={rest} onEdit={onEdit} />
    </>
  )
}

function Ring({ pct }: { pct: number }) {
  const r = 34, c = 2 * Math.PI * r
  return (
    <div className="relative size-[76px] shrink-0" role="img" aria-label={`Battery ${pct}%`}>
      <svg viewBox="0 0 76 76" className="size-full -rotate-90">
        <circle cx="38" cy="38" r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="6" />
        <circle cx="38" cy="38" r={r} fill="none" stroke="#c1c4cb" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} style={{ filter: 'drop-shadow(0 0 5px rgb(193 196 203 / 0.6))', transition: 'stroke-dasharray .4s' }} />
      </svg>
      <span className="display absolute inset-0 grid place-items-center text-[13px] font-semibold">{pct}%</span>
    </div>
  )
}

/** Steps on a line (Figma "Sleep after"): any number of options, the chosen one is a raised knob. */
function Timeline({ options, value, onChange, label }: { options: [string, number][]; value: number; onChange: (v: number) => void; label: string }) {
  const at = Math.max(0, options.findIndex(([, v]) => v === value))
  const pctAt = options.length > 1 ? (at / (options.length - 1)) * 100 : 0
  return (
    <div className="relative mt-6 px-1.5" role="radiogroup" aria-label={label}>
      <div className="absolute top-[6px] right-1.5 left-1.5 h-0.5 rounded bg-white/10" />
      <div className="absolute top-[6px] left-1.5 h-0.5 rounded bg-[var(--plat)] shadow-[0_0_8px_rgb(193_196_203/0.5)] transition-[width] duration-300" style={{ width: `calc(${pctAt}% - ${(pctAt / 100) * 12}px)` }} />
      <div className="relative flex justify-between">
        {options.map(([l, v], i) => {
          const on = i === at
          return (
            <button key={v} type="button" role="radio" aria-checked={on} aria-label={l} onClick={() => onChange(v)} className="group flex w-0 flex-col items-center gap-3">
              <span className={cn('rounded-full transition-all', on ? 'plat -mt-[3px] size-3.5' : i < at ? 'size-2 bg-[var(--plat)]' : 'size-2 bg-white/20 group-hover:bg-white/40')} />
              <span className={cn('display text-[9px] whitespace-nowrap', on ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-3)]')}>{shortTime(l)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DpiCards({ dpi, sel, setSel, get, onEdit, rest }: { dpi?: Dpi; sel: number; setSel: (i: number) => void; get: (k: string) => Setting | undefined; onEdit: Edit; rest: Setting[] }) {
  const count = get('dpi_count')
  const xy = get('dpi_xy')
  const dpiY = get('dpi_y')
  if (!dpi) return <GenericCard title="DPI" settings={rest} onEdit={onEdit} />
  const i = Math.min(sel, dpi.stages.length - 1)
  const setStageVal = (key: 'dpi' | 'dpi_y', v: Dpi, n: number) => {
    const stages = v.stages.slice()
    stages[i] = Math.round(n / v.step) * v.step
    onEdit(key, { ...v, stages })
  }
  return (
    <>
      <Card title="DPI stages" right={<span className="text-[10px] text-[var(--text-3)]">{dpi.stages.length} stages · button cycles</span>}>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="DPI stage to edit">
          {dpi.stages.map((v, k) => (
            <button key={k} type="button" role="radio" aria-checked={k === i} onClick={() => setSel(k)}
              className={cn('flex h-10 items-center gap-3 rounded-xl border px-3.5 text-left', k === i ? 'border-white/30 bg-white/[0.08]' : 'border-transparent hover:bg-white/[0.03]')}>
              <span className="display w-6 text-[9.5px] text-[var(--text-3)]">0{k + 1}</span>
              {dpi.colors && <span className="size-2 rounded-full" style={{ background: hex(dpi.colors[k] ?? 0xffffff), boxShadow: `0 0 6px ${hex(dpi.colors[k] ?? 0xffffff)}` }} />}
              <span className="display text-[15px] font-semibold">{v}</span>
              <span className="unit text-[10px]">DPI</span>
              {k === dpi.active && <span className="eyebrow ml-auto !text-[var(--text-2)]">Active</span>}
            </button>
          ))}
        </div>
        {i !== dpi.active && (
          <button type="button" className="chip mt-3" onClick={() => onEdit('dpi', { ...dpi, active: i })}>Make stage {i + 1} active</button>
        )}
      </Card>
      <Card title={`Stage ${i + 1} sensitivity${dpiY ? ' (X)' : ''}`}>
        <div className="flex items-baseline justify-between">
          <BigValue value={dpi.stages[i].toLocaleString('en-US')} unit="DPI" size={28} />
          <input type="number" aria-label={`Stage ${i + 1} DPI`} min={dpi.min} max={dpi.max} step={dpi.step} value={dpi.stages[i]}
            onChange={(e) => e.target.value && setStageVal('dpi', dpi, Math.min(dpi.max, Math.max(dpi.min, Number(e.target.value))))}
            className="recess display w-24 rounded-lg border-0 px-2.5 py-1.5 text-right text-[12px] text-[var(--text)]" />
        </div>
        <Range className="mt-3" label={`Stage ${i + 1} DPI`} min={dpi.min} max={dpi.max} step={dpi.step} value={dpi.stages[i]} onChange={(n) => setStageVal('dpi', dpi, n)} />
        <div className="mt-1 flex justify-between text-[10px] text-[var(--text-4)]"><span>{dpi.min}</span><span>{dpi.max.toLocaleString('en-US')}</span></div>
        {dpiY?.value.kind === 'dpi' && (
          <>
            <div className="eyebrow mt-4 mb-2">Y axis · {dpiY.value.stages[i]?.toLocaleString('en-US')} DPI</div>
            <Range label={`Stage ${i + 1} DPI, Y axis`} min={dpiY.value.min} max={dpiY.value.max} step={dpiY.value.step} value={dpiY.value.stages[i] ?? dpiY.value.min}
              onChange={(n) => setStageVal('dpi_y', dpiY.value as Dpi, n)} />
          </>
        )}
      </Card>
      <div className="grid grid-cols-2 gap-3.5">
        {count?.value.kind === 'choice' && (
          <Card title="Stages">
            <Stepper label="Stages" value={count.value.current} min={Math.min(...count.value.options.map((o) => o[1]))} max={Math.max(...count.value.options.map((o) => o[1]))}
              onChange={(n) => onEdit('dpi_count', { ...(count.value as Choice), current: n })} />
          </Card>
        )}
        {xy?.value.kind === 'toggle' && (
          <Card title="Separate X / Y">
            <div className="flex items-center justify-between">
              <span className="display text-[22px] font-semibold">{xy.value.on ? 'On' : 'Off'}</span>
              <Toggle label="Separate X / Y" checked={xy.value.on} onChange={(on) => onEdit('dpi_xy', { kind: 'toggle', on })} />
            </div>
          </Card>
        )}
      </div>
      <GenericCard title="More" settings={rest} onEdit={onEdit} />
    </>
  )
}

/** Figma "Action for button": category tabs + a grid of raised action buttons. */
function ActionPicker({ title, label, v, onChange }: { title: string; label: string; v: Choice; onChange: (c: number) => void }) {
  const cur = v.options.find((o) => o[1] === v.current)
  const cats = ACTION_GROUPS.map(([n]) => n).filter((n) => v.options.some(([l]) => actionGroup(l) === n))
  const [cat, setCat] = useState(cur ? actionGroup(cur[0]) : cats[0])
  const shown = v.options.filter(([l]) => actionGroup(l) === cat || (cat === 'Mouse' && actionGroup(l) === 'Other'))
  return (
    <Card title={title}>
      <Segmented label={`${label}: category`} options={cats.map((c) => [c, c] as const)} value={cat} onChange={setCat} />
      <div className="mt-4 grid grid-cols-2 gap-2.5" role="radiogroup" aria-label={label}>
        {shown.map(([l, val]) => {
          const on = val === v.current
          return (
            <button key={val} type="button" role="radio" aria-checked={on} onClick={() => onChange(val)}
              className={cn('display h-11 truncate rounded-[14px] px-3.5 text-left text-[11px] font-medium', on ? 'plat' : 'raised text-[var(--text-2)]')}>
              {l}
            </button>
          )
        })}
      </div>
      <p className="hint mt-4 mb-0">Changes save to the mouse straight away.</p>
    </Card>
  )
}

const EFFECT_NAME: Record<number, string> = { 0: 'Off', 4: 'Single colour', 5: 'Breathing' }

function AdvancedCards({ get, onEdit, model, missing, present, extras, rest }: {
  get: (k: string) => Setting | undefined
  onEdit: Edit
  model: string
  missing: string[]
  present: string[]
  extras: Setting[]
  rest: Setting[]
}) {
  const [confirm, setConfirm] = useState(false)
  const eff = get('rgb_effect')
  const col = get('rgb_color')
  const bri = get('rgb_bri')
  const spd = get('rgb_speed')
  const e = eff?.value.kind === 'choice' ? eff.value : undefined
  const rgb = col?.value.kind === 'color' ? col.value.rgb : 0xff0000
  const on = !!e && e.current !== 0
  const setEffect = (n: number) => e && onEdit('rgb_effect', { ...e, current: n })
  const angle = extras.find((s) => s.key === 'angle_tune')
  return (
    <>
      {e && (
        <Card title="Hidden by maker" right={<Toggle label="Mouse RGB lighting" checked={on} onChange={(v) => (v ? setConfirm(true) : setEffect(0))} />}>
          <div className="display -mt-1 text-[15px] font-semibold">Mouse RGB lighting</div>
          <div className="mt-2 flex items-center gap-3">
            <span className="eyebrow rounded-full border border-white/25 bg-white/[0.08] px-2 py-0.5 !text-[7.5px] !text-[var(--text)]">Hidden</span>
            <span className="size-4 rounded-full border border-white/60" style={{ background: hex(rgb) }} />
            <span className="display text-[10px] text-[var(--text-2)]">{hex(rgb)} · {EFFECT_NAME[e.current] ?? e.options.find((o) => o[1] === e.current)?.[0]}</span>
          </div>
          {on ? (
            <div className="mt-4 flex flex-col gap-3.5">
              <Segmented label="Light effect" options={e.options.filter(([, v]) => v !== 0)} value={e.current} onChange={setEffect} />
              {col?.value.kind === 'color' && <ColorPicker label="Light colour" value={rgb} onChange={(c) => onEdit('rgb_color', { kind: 'color', rgb: c })} />}
              {bri?.value.kind === 'number' && (
                <div>
                  <div className="mb-1.5 flex justify-between"><span className="eyebrow">Brightness</span><span className="display text-[11px]">{bri.value.current}%</span></div>
                  <Range label="Light brightness" min={0} max={100} value={bri.value.current} onChange={(n) => onEdit('rgb_bri', { ...(bri.value as Extract<Value, { kind: 'number' }>), current: n })} />
                </div>
              )}
              {e.current === 5 && spd?.value.kind === 'number' && (
                <div>
                  <div className="mb-1.5 flex justify-between"><span className="eyebrow">Speed</span><span className="display text-[11px]">{spd.value.current}</span></div>
                  <Range label="Breathing speed" min={1} max={6} value={spd.value.current} onChange={(n) => onEdit('rgb_speed', { ...(spd.value as Extract<Value, { kind: 'number' }>), current: n })} />
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="hint mt-4 mb-0">The firmware accepts it, but {model} may have no LED, so turning it on can do nothing. You can turn it off again.</p>
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-[11px] text-[var(--text-2)]"><Info className="size-3.5 shrink-0" />You will be asked to confirm before it is turned on.</div>
            </>
          )}
        </Card>
      )}
      {missing.length > 0 && (
        <Card title="Not on this firmware">
          <div className="flex flex-wrap gap-2">
            {missing.map((m) => <span key={m} className="rounded-full border border-dashed border-white/15 px-2.5 py-1.5 text-[11.5px] text-[var(--text-2)]">{m}</span>)}
          </div>
          <p className="hint mt-4 mb-0">Checked every time you connect. If a firmware update adds one, it unlocks automatically.</p>
        </Card>
      )}
      {present.length > 0 && (
        <Card title="On this firmware, not yet in InputDeck">
          <div className="flex flex-wrap gap-2">{present.map((m) => <span key={m} className="rounded-full border border-white/25 px-2.5 py-1.5 text-[11.5px]">{m}</span>)}</div>
        </Card>
      )}
      {extras.length > 0 && (
        <Card title="More sensor settings">
          {extras.filter((s) => s.value.kind === 'toggle').map((s) => (
            <Row key={s.key} label={s.label}>
              <Toggle label={s.label} checked={(s.value as Extract<Value, { kind: 'toggle' }>).on} onChange={(v) => onEdit(s.key, { kind: 'toggle', on: v })} />
            </Row>
          ))}
          {angle?.value.kind === 'number' && (
            <div className="pt-3">
              <div className="mb-2 flex items-baseline justify-between"><span className="text-[13px]">Angle tune</span><span className="display text-[13px]">{angle.value.current}°</span></div>
              <Range label="Angle tune" min={angle.value.min} max={angle.value.max} value={angle.value.current}
                onChange={(n) => onEdit('angle_tune', { ...(angle.value as Extract<Value, { kind: 'number' }>), current: n })} />
            </div>
          )}
        </Card>
      )}
      <GenericCard title="More" settings={rest} onEdit={onEdit} />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="rounded-3xl border-white/10 bg-[#111113]/95 backdrop-blur-xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="display text-[16px]">Turn on a hidden feature?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              WLMouse hides RGB lighting for {model}. Your firmware accepts it, but the mouse may have no LED, so it might do nothing. You can turn it off again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button type="button" className="rounded-full px-4 py-2 text-[13px] text-[var(--text-2)] hover:text-[var(--text)]" onClick={() => setConfirm(false)}>Cancel</button>
            <button type="button" className="plat display rounded-full px-5 py-2 text-[12px] font-semibold" onClick={() => { setConfirm(false); setEffect(4) }}>Turn on</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
