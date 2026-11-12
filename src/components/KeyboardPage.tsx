import { useEffect, useMemo, useRef, useState } from 'react'
import { Gauge, Keyboard as KeyboardIcon, Lightbulb, SlidersHorizontal, ToggleRight } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { KeyCap, Setting, Value } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { describe as describeKc, label as kcLabel } from '#/lib/keycodes'
import { KeyboardView, type KeyLook } from './KeyboardView'
import { KeyCard, KeyPicker, effective, type Keymap } from './KeymapCards'
import { BigValue, Card, ChoiceSelect, Range, Segmented, SWATCHES, Toggle, hex, type Choice } from './kit'
import { GenericCard, Hero, Pulse, shortHz, type Edit } from './parts'
import { Dock, textOf } from './shell'

type PerKeyTrigger = Extract<Value, { kind: 'perKeyTrigger' }>
type PerKeyColor = Extract<Value, { kind: 'perKeyColor' }>
type Float = Extract<Value, { kind: 'float' }>
type Num = Extract<Value, { kind: 'number' }>

const ORDER = ['Switches', 'Lighting', 'Keys', 'Performance']
const ICON: Record<string, React.ReactNode> = {
  Switches: <ToggleRight className="size-4" />,
  Lighting: <Lightbulb className="size-4" />,
  Keys: <KeyboardIcon className="size-4" />,
  Performance: <Gauge className="size-4" />,
}
// per-key settings live on the Switches / Lighting tabs
const MERGED = new Set(['Info', 'Per-key'])
const PRESET_SEL: [string, (l: string) => boolean][] = [
  ['All', () => true],
  ['WASD', (l) => ['W', 'A', 'S', 'D'].includes(l)],
  ['Letters', (l) => /^[A-Z]$/.test(l)],
  ['None', () => false],
]
const PRESETS: [string, number][] = [['Speed', 0.4], ['Gaming', 1.2], ['Balanced', 1.7], ['Typing', 2.4]]

const choiceLabel = (s?: Setting) => (s?.value.kind === 'choice' ? s.value.options.find((o) => o[1] === (s.value as Choice).current)?.[0] : undefined)
const snap = (n: number, step: number) => Math.round(n / step) * step

export function KeyboardPage({ dev, tab, setTab, onEdit }: { dev: DeviceState; tab?: string; setTab: (t: string) => void; onEdit: Edit }) {
  const edit = dev.edit
  const get = (k: string) => edit?.find((s) => s.key === k)
  const groups = useMemo(() => {
    const g = [...new Set((edit ?? []).map((s) => s.group))].filter((x) => !MERGED.has(x))
    return g.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
  }, [edit])
  const active = tab && groups.includes(tab) ? tab : groups[0]
  const [sel, setSel] = useState<Set<number>>(new Set())
  // size the board so the cards below still fit above the dock
  const [vh, setVh] = useState(900)
  useEffect(() => {
    const on = () => setVh(window.innerHeight)
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  // live actuation test (keyboards that can stream key travel)
  const [testing, setTesting] = useState(false)
  const [live, setLive] = useState<{ depth: Map<number, number>; last?: number }>({ depth: new Map() })
  const pendingLive = useRef(new Map<number, number>())
  const lastKey = useRef<number | undefined>(undefined)
  const canTest = !!dev.driver.travelTest && !!dev.edit
  useEffect(() => {
    if (!testing || !dev.driver.travelTest) return
    let stop: (() => Promise<void>) | undefined
    let cancelled = false
    let frame = 0
    const flush = () => {
      frame = 0
      setLive({ depth: new Map(pendingLive.current), last: lastKey.current })
    }
    dev.driver
      .travelTest((pos, mm) => {
        pendingLive.current.set(pos, mm)
        if (mm > 0.05) lastKey.current = pos
        if (!frame) frame = requestAnimationFrame(flush)
      })
      .then((s) => (cancelled ? void s() : (stop = s)))
      .catch(() => setTesting(false))
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      void stop?.()
      pendingLive.current = new Map()
      lastKey.current = undefined
      setLive({ depth: new Map() })
    }
  }, [testing, dev.driver])
  useEffect(() => {
    if (tab && tab !== 'Switches') setTesting(false)
  }, [tab])
  const kbMax = Math.round(Math.min(1000, Math.max(640, (vh - 420) / 0.43)))

  const brand = dev.driver.brand().toUpperCase()
  const pkT = get('per_key_trigger')?.value as PerKeyTrigger | undefined
  const pkC = get('per_key_color')?.value as PerKeyColor | undefined
  const keys: KeyCap[] | undefined = pkT?.keys ?? pkC?.keys ?? dev.driver.layout?.()
  const inGroup = (g: string) => (edit ?? []).filter((s) => s.group === g)

  // ---- key remapping (drivers with a keymap setting)
  const kmS = get('keymap')
  const km = kmS?.value.kind === 'keymap' ? kmS.value : undefined
  const [layerPick, setLayer] = useState(0)
  const [kSel, setKSel] = useState<number | undefined>(undefined)
  const layer = km ? Math.min(layerPick, km.layers.length - 1) : 0
  const keySel = km && kSel !== undefined && kSel < km.keys.length ? kSel : undefined
  // the keymap as first read for this device, for the "changed" dots and Restore
  const [original, setOriginal] = useState<{ id: string; n: number; layers: number[][] } | undefined>(undefined)
  useEffect(() => {
    if (km && (original?.id !== dev.id || original.n !== km.keys.length)) setOriginal({ id: dev.id, n: km.keys.length, layers: km.layers.map((l) => l.slice()) })
  }, [km, dev.id, original])
  const origLayers = original?.id === dev.id ? original.layers : undefined
  const onKeys = active === 'Keys' && !!km

  // ---- keyboard looks for the current tab
  let looks: KeyLook[] = []
  let interactive = false
  let boardKeys = keys
  if (onKeys) {
    interactive = true
    boardKeys = km!.keys.map((k, i) => ({ ...k, label: kcLabel(effective(km!, layer, i).code, km!.codes) }))
    looks = km!.keys.map((_, i) => {
      const code = km!.layers[layer][i]
      const was = origLayers?.[layer]?.[i]
      return { dot: was !== undefined && was !== code, dim: code === 1 && layer > 0, title: `${kcLabel(code, km!.codes) || 'None'}: ${describeKc(code, km!.codes)}` }
    })
  } else if (keys && active === 'Switches' && pkT && testing) {
    looks = keys.map((_, i) => {
      const mm = live.depth.get(i) ?? 0
      return { press: mm / (pkT.max || 4), fired: mm >= pkT.travel[i] - 1e-6 && mm > 0.05, rt: pkT.rapid[i] }
    })
  } else if (keys && active === 'Switches' && pkT) {
    interactive = true
    looks = pkT.travel.map((t, i) => ({ tint: Math.pow(1 - (t - pkT.min) / (pkT.max - pkT.min || 1), 2), rt: pkT.rapid[i] }))
  } else if (keys && active === 'Lighting' && pkC) {
    interactive = true
    const on = (get('light_power')?.value as Extract<Value, { kind: 'toggle' }> | undefined)?.on ?? true
    looks = pkC.colors.map((c) => (on ? { color: hex(c) } : {}))
  }
  const selIdx = keys ? [...sel].filter((i) => i < keys.length) : []
  const pickBy = (pred: (l: string) => boolean) => new Set((keys ?? []).map((k, i) => (pred(k.label) ? i : -1)).filter((i) => i >= 0))
  const presetNow = PRESET_SEL.find(([, f]) => { const want = pickBy(f); return want.size === sel.size && [...want].every((i) => sel.has(i)) })?.[0]
  const presetSel = (pred: (l: string) => boolean) => setSel(new Set((keys ?? []).map((k, i) => (pred(k.label) ? i : -1)).filter((i) => i >= 0)))

  let hero: React.ReactNode = null
  let cards: React.ReactNode = null

  if (!edit) {
    hero = <Hero brand={brand} label="Reading settings" value="…" size={64} sub="Talking to the keyboard." />
  } else if (active === 'Switches') {
    ;[hero, cards] = switches()
  } else if (active === 'Lighting') {
    ;[hero, cards] = lighting()
  } else if (onKeys) {
    ;[hero, cards] = keymap()
  } else if (active === 'Performance') {
    const poll = get('polling')
    const label = choiceLabel(poll)
    const rate = parseInt(label ?? '0', 10)
    hero = <Hero brand={brand} label="Polling rate" value={label?.replace(/\s*Hz/i, '') ?? '—'} unit="Hz" size={76}
      sub={rate ? `Reports every ${(1000 / rate).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} ms · wired` : undefined} />
    cards = (
      <>
        {poll?.value.kind === 'choice' && (
          <Card title="Polling rate" className="col-span-2">
            <div className="flex items-end justify-between gap-4">
              <BigValue value={label?.replace(/\s*Hz/i, '') ?? '—'} unit="Hz" size={30} />
              <Pulse rate={rate || 1000} width={240} />
            </div>
            <Segmented className="mt-4" label="Polling rate" options={poll.value.options.map(([l, v]) => [shortHz(l), v] as const)} value={poll.value.current}
              onChange={(c) => onEdit('polling', { ...(poll.value as Choice), current: c })} />
            <p className="hint mt-3 mb-0">Higher rates report key presses sooner and use a little more CPU.</p>
          </Card>
        )}
        <Card title="Device">
          <div className="display text-[17px] font-semibold">{dev.driver.model()}</div>
          <dl className="m-0 mt-3">
            {[['Switches', pkT ? 'Magnetic' : undefined], ['Layout', /75/.test(dev.driver.model()) ? '75%' : undefined], ['Connection', 'Wired'], ['Firmware', textOf(dev, 'fw')]].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-white/5 py-2 last:border-0">
                <dt className="eyebrow">{k}</dt>
                <dd className="display m-0 text-[11px]">{v}</dd>
              </div>
            ))}
          </dl>
          {textOf(dev, 'unsupported') && <p className="hint mt-2 mb-0 text-[var(--warn)]">{textOf(dev, 'unsupported')}</p>}
        </Card>
        <GenericCard title="More" settings={inGroup('Performance').filter((s) => s.key !== 'polling')} onEdit={onEdit} />
      </>
    )
  } else if (active) {
    hero = <Hero brand={brand} label={active} value={dev.driver.model()} size={48} />
    cards = <GenericCard title={active} settings={inGroup(active)} onEdit={onEdit} className="col-span-3" />
  } else {
    hero = <Hero brand={brand} label="Keyboard" value={dev.driver.model()} size={48} sub={textOf(dev, 'unsupported') ?? 'No settings to change on this keyboard yet.'} />
  }

  function switches(): [React.ReactNode, React.ReactNode] {
    const act = get('actuation')?.value as Float | undefined
    const rt = get('rapid_trigger')?.value as Extract<Value, { kind: 'toggle' }> | undefined
    const sens = get('rt_sens')?.value as Float | undefined
    const perKey = !!pkT && selIdx.length > 0
    const first = selIdx[0]
    const range = pkT ?? (act ? { min: act.min, max: act.max, step: act.step } : undefined)
    const travel = perKey ? pkT!.travel[first] : act?.current
    const uniform = !perKey || selIdx.every((i) => Math.abs(pkT!.travel[i] - pkT!.travel[first]) < 1e-6)
    const rtOn = perKey ? selIdx.every((i) => pkT!.rapid[i]) : rt?.on ?? false
    const sensVal = perKey ? pkT!.sens[first] : sens?.current
    const sensRange = pkT ? { min: pkT.sensMin, max: pkT.sensMax, step: pkT.step } : sens

    const setTravel = (n: number) => {
      if (perKey) {
        const t = pkT!.travel.slice()
        for (const i of selIdx) t[i] = snap(n, pkT!.step)
        onEdit('per_key_trigger', { ...pkT!, travel: t })
      } else if (act) onEdit('actuation', { ...act, current: snap(n, act.step) })
    }
    const setRt = (on: boolean) => {
      if (perKey) {
        const r = pkT!.rapid.slice()
        for (const i of selIdx) r[i] = on
        onEdit('per_key_trigger', { ...pkT!, rapid: r })
      } else if (rt) onEdit('rapid_trigger', { kind: 'toggle', on })
    }
    const setSens = (n: number) => {
      if (perKey) {
        const s = pkT!.sens.slice()
        for (const i of selIdx) s[i] = snap(n, pkT!.step)
        onEdit('per_key_trigger', { ...pkT!, sens: s })
      } else if (sens) onEdit('rt_sens', { ...sens, current: snap(n, sens.step) })
    }
    const scope = perKey ? `${selIdx.length} key${selIdx.length === 1 ? '' : 's'}` : 'all keys'

    const lk = live.last
    const liveMm = lk !== undefined ? live.depth.get(lk) ?? 0 : 0
    if (testing) {
      const kname = lk !== undefined && keys?.[lk] ? keys[lk].label : undefined
      const act = lk !== undefined && pkT ? pkT.travel[lk] : travel
      const hTest = (
        <Hero live brand={brand} label={kname ? `Live travel · ${kname}` : 'Live travel'} value={liveMm.toFixed(2)} unit="mm" size={76}
          sub={kname && act !== undefined ? (liveMm >= act ? `Past its ${act.toFixed(2)} mm actuation point — the key fires` : `Fires at ${act.toFixed(2)} mm`) : 'Press any key on the keyboard.'} />
      )
      return [hTest, (
        <>
          <Card title="Key travel · live" className="col-span-2">
            <TravelDiagram max={range?.max ?? 4} act={act ?? 1} sens={undefined} live={liveMm} />
          </Card>
          <Card title="How to read it">
            <p className="hint m-0">Each key fills up as you press it and lights up once it passes its actuation point. Rapid Trigger keys keep their dot.</p>
            <button type="button" className="plat display mt-4 w-full rounded-full py-2.5 text-[12px] font-semibold" onClick={() => setTesting(false)}>Stop test</button>
          </Card>
        </>
      )]
    }
    const h = (
      <Hero brand={brand} label={`Actuation · ${scope}`} value={travel === undefined ? '—' : uniform ? travel.toFixed(2) : 'Mixed'} unit={uniform ? 'mm' : undefined} size={76}
        sub={range ? `Magnetic switches · ${range.min.toFixed(2)} – ${range.max.toFixed(2)} mm` : undefined} />
    )
    if (!range || travel === undefined) return [h, <GenericCard key="g" title="Switches" settings={inGroup('Switches')} onEdit={onEdit} className="col-span-3" />]
    const presets = PRESETS.filter(([, mm]) => mm >= range.min && mm <= range.max)
    const c = (
      <>
        <Card title="Actuation point">
          <BigValue value={uniform ? travel.toFixed(2) : 'Mixed'} unit={uniform ? 'mm' : undefined} size={26} />
          <Range className="mt-3" label={`Actuation, ${scope}`} min={range.min} max={range.max} step={range.step} value={travel} onChange={setTravel} />
          <div className="mt-1 flex justify-between text-[9.5px] text-[var(--text-4)]"><span>{range.min.toFixed(2)}</span><span>{range.max.toFixed(2)}</span></div>
          {presets.length > 0 && (
            <>
              <div className="eyebrow mt-4 mb-2">Presets</div>
              <Segmented label="Actuation presets" options={presets.map(([, mm]) => [`${mm}`, mm] as const)} value={uniform ? presets.find(([, mm]) => Math.abs(mm - travel) < 0.005)?.[1] : undefined}
                onChange={setTravel} />
              <div className="mt-1.5 flex justify-around text-[9.5px] text-[var(--text-4)]">{presets.map(([n]) => <span key={n}>{n}</span>)}</div>
            </>
          )}
        </Card>
        <Card title="Key travel">
          <TravelDiagram max={range.max} act={travel} sens={rtOn ? sensVal : undefined} />
        </Card>
        <Card title="Rapid Trigger" right={<Toggle label={`Rapid Trigger, ${scope}`} checked={rtOn} onChange={setRt} />}>
          <div className="display text-[26px] font-semibold">{rtOn ? 'On' : 'Off'}</div>
          <p className="hint mt-1">Resets the instant a key starts rising.</p>
          {sensRange && sensVal !== undefined && (
            <>
              <div className="mt-3 flex items-baseline justify-between"><span className="eyebrow">Sensitivity</span><BigValue value={sensVal.toFixed(2)} unit="mm" size={13} /></div>
              <Range className="mt-1.5" label="Rapid Trigger sensitivity" min={sensRange.min} max={sensRange.max} step={sensRange.step} value={sensVal} onChange={setSens} />
            </>
          )}
        </Card>
      </>
    )
    return [h, c]
  }

  function keymap(): [React.ReactNode, React.ReactNode] {
    const m = km as Keymap
    const assign = (code: number) => {
      if (keySel === undefined) return
      const layers = m.layers.map((l, li) => {
        if (li !== layer) return l
        const next = l.slice()
        next[keySel] = code
        return next
      })
      onEdit('keymap', { ...m, layers })
    }
    const code = keySel !== undefined ? m.layers[layer][keySel] : undefined
    const legend = code === undefined ? undefined : kcLabel(code, m.codes) || 'None'
    const changed = origLayers ? m.layers.reduce((n, l, li) => n + l.filter((c, i) => origLayers[li]?.[i] !== undefined && origLayers[li][i] !== c).length, 0) : 0
    const h = (
      <Hero brand={brand} label={`Keymap · layer ${layer}`} value={legend ?? `${m.layers.length}`} unit={legend ? undefined : m.layers.length === 1 ? 'layer' : 'layers'}
        size={legend && legend.length > 6 ? Math.max(30, Math.round(400 / legend.length)) : 64}
        sub={code !== undefined ? describeKc(code, m.codes) : changed ? `${changed} key${changed === 1 ? '' : 's'} remapped this session` : 'Click a key to remap it.'} />
    )
    const c = (
      <>
        <KeyPicker km={m} layer={layer} keyIndex={keySel} onPick={assign} className="col-span-2" />
        <KeyCard km={m} layer={layer} keyIndex={keySel} original={origLayers} onPick={assign} />
      </>
    )
    return [h, c]
  }

  function lighting(): [React.ReactNode, React.ReactNode] {
    const mode = get('light_mode')
    const power = get('light_power')?.value as Extract<Value, { kind: 'toggle' }> | undefined
    const bri = get('light_bri')?.value as Num | undefined
    const speed = get('light_speed')?.value as Num | undefined
    const color = get('light_color')?.value as Extract<Value, { kind: 'color' }> | undefined
    const rainbow = get('light_rainbow')?.value as Extract<Value, { kind: 'toggle' }> | undefined
    const perKey = !!pkC && selIdx.length > 0
    const first = selIdx[0]
    const keyColor = perKey ? (selIdx.every((i) => pkC!.colors[i] === pkC!.colors[first]) ? pkC!.colors[first] : null) : color?.rgb ?? null
    const paint = (c: number) => {
      if (perKey) {
        const colors = pkC!.colors.slice()
        for (const i of selIdx) colors[i] = c
        onEdit('per_key_color', { ...pkC!, colors })
      } else if (color) onEdit('light_color', { ...color, rgb: c })
    }
    const steps = (v: Num) => Array.from({ length: v.max - v.min + 1 }, (_, k) => [String(v.min + k), v.min + k] as const)
    const effect = choiceLabel(mode) ?? '—'
    const h = <Hero brand={brand} label="Effect" value={effect} size={effect.length > 9 ? Math.max(26, Math.round(440 / effect.length)) : 64} sub={power && !power.on ? 'Lights are off' : 'Lights on'} />
    const c = (
      <>
        <Card title="Effect">
          {mode?.value.kind === 'choice' && (
            <>
              <ChoiceSelect label="Lighting effect" v={mode.value} onChange={(n) => onEdit('light_mode', { ...(mode.value as Choice), current: n })} />
              <p className="hint mt-3 mb-0">{mode.value.options.length} effects on this keyboard. The list comes from the device itself.</p>
            </>
          )}
          {rainbow && (
            <div className="mt-4 flex items-center justify-between"><span className="text-[13px]">Rainbow colours</span>
              <Toggle label="Rainbow colours" checked={rainbow.on} onChange={(on) => onEdit('light_rainbow', { kind: 'toggle', on })} /></div>
          )}
        </Card>
        <Card title={perKey ? `Colour · ${selIdx.length} key${selIdx.length === 1 ? '' : 's'}` : 'Colour'}>
          <div className="flex items-center gap-4">
            <label className="relative grid size-[112px] shrink-0 cursor-pointer place-items-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-[0_4px_10px_rgb(0_0_0/0.5)]" title="Pick any colour">
              <span className="grid size-[80px] place-items-center rounded-full bg-[#141416]">
                <span className="size-[42px] rounded-full" style={{ background: keyColor === null ? '#333' : hex(keyColor), boxShadow: keyColor === null ? undefined : `0 0 14px ${hex(keyColor)}` }} />
              </span>
              <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label="Pick any colour" value={keyColor === null ? '#ffffff' : hex(keyColor).toLowerCase()} onChange={(e) => paint(parseInt(e.target.value.slice(1), 16))} />
            </label>
            <div className="min-w-0">
              <div className="display text-[12px] font-semibold">{keyColor === null ? 'Mixed' : hex(keyColor)}</div>
              <div className="mt-3 grid w-[78px] grid-cols-3 gap-2">
                {SWATCHES.slice(0, 9).map((c) => (
                  <button key={c} type="button" className="swatch !size-[18px]" style={{ background: hex(c) }} aria-label={`${perKey ? 'Selected keys' : 'Lighting'} colour ${hex(c)}`} aria-pressed={keyColor === c} onClick={() => paint(c)} />
                ))}
              </div>
            </div>
          </div>
          {pkC && !perKey && <p className="hint mt-3 mb-0">Select keys to paint them one by one.</p>}
        </Card>
        <Card title="Lights" right={power && <Toggle label="Lights on" checked={power.on} onChange={(on) => onEdit('light_power', { kind: 'toggle', on })} />}>
          <div className="display text-[26px] font-semibold">{power ? (power.on ? 'On' : 'Off') : '—'}</div>
          {bri && (<><div className="eyebrow mt-3 mb-2">Brightness</div><Segmented label="Brightness" options={steps(bri)} value={bri.current} onChange={(n) => onEdit('light_bri', { ...bri, current: n })} /></>)}
          {speed && (<><div className="eyebrow mt-3 mb-2">Speed</div><Segmented label="Speed" options={steps(speed)} value={speed.current} onChange={(n) => onEdit('light_speed', { ...speed, current: n })} /></>)}
        </Card>
      </>
    )
    return [h, c]
  }

  const showBar = (interactive || testing) && boardKeys
  // keys tab: one key at a time; a click (or drag) picks the newly added key
  const pickKey = (next: Set<number>) => setKSel([...next].find((i) => i !== keySel))
  return (
    <>
      <main className="scroll-thin relative z-10 flex h-[calc(100%-76px)] flex-col items-center overflow-y-auto px-16 pt-2 pb-[130px]">
        <div className="relative w-full" style={{ maxWidth: kbMax }}>
          <div className="pointer-events-none absolute -inset-x-20 -top-10 h-[120%] rounded-full bg-[radial-gradient(ellipse_at_center,rgb(230_232_236/0.08),transparent_65%)]" />
          {boardKeys ? (
            <KeyboardView keys={boardKeys} looks={looks} selected={onKeys ? new Set(keySel === undefined ? [] : [keySel]) : interactive ? sel : new Set()}
              onSelect={onKeys ? pickKey : setSel} interactive={interactive} knob={dev.driver.knob} maxWidth={kbMax} />
          ) : (
            <div className="grid h-64 place-items-center"><KeyboardIcon className="size-40 text-white/10" strokeWidth={0.6} /></div>
          )}
          {onKeys ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className="text-[12px] text-[var(--text-3)]">
                {keySel !== undefined
                  ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{km!.keys[keySel].label || 'Key'}</span>selected · pick what it sends below</>
                  : 'click a key to remap it · dot = remapped this session · faded = from the layer below'}
              </span>
              {km!.layers.length > 1 && (
                <span className="flex items-center gap-2.5">
                  <span className="eyebrow">Layer</span>
                  {km!.layers.length <= 8 ? (
                    <Segmented label="Keymap layer" className="[&_button]:!px-3.5 [&_button]:!py-1.5 [&_button]:!text-[11px]"
                      value={layer} options={km!.layers.map((_, l) => [String(l), l] as const)} onChange={setLayer} />
                  ) : (
                    <ChoiceSelect label="Keymap layer" className="!h-9 !w-28" v={{ kind: 'choice', options: km!.layers.map((_, l) => [`Layer ${l}`, l]), current: layer }} onChange={setLayer} />
                  )}
                </span>
              )}
            </div>
          ) : (
          <div className={cn('mt-3 flex h-9 items-center justify-between', !showBar && 'invisible')}>
            <span className="text-[12px] text-[var(--text-3)]">{!testing && <span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{selIdx.length}</span>}
              {testing ? 'live test · press keys on your keyboard' : <>key{selIdx.length === 1 ? '' : 's'} selected · {selIdx.length === 0 ? 'editing all keys, click or drag to pick some' : 'click or drag over keys'}</>}</span>
            <span className="flex gap-1.5">
              {canTest && active === 'Switches' && (
                <button type="button" className={cn('chip display !text-[11px] font-semibold', testing && 'plat !border-transparent')} aria-pressed={testing} onClick={() => setTesting((t) => !t)}>
                  {testing ? '● Testing' : 'Test keys'}
                </button>
              )}
              {!testing && (
                <Segmented label="Select keys" className="[&_button]:!px-3.5 [&_button]:!py-1.5 [&_button]:!text-[11px]"
                  value={presetNow} options={PRESET_SEL.map(([n]) => [n, n] as const)}
                  onChange={(n) => { const f = PRESET_SEL.find(([x]) => x === n)![1]; presetSel(f) }} />
              )}
            </span>
          </div>
          )}
        </div>
        <div className="mt-4 grid w-full max-w-[1300px] grid-cols-[minmax(240px,0.8fr)_2.6fr] gap-8">
          <div key={active} className="pt-2">{hero}</div>
          <div key={`c-${active}`} className="cascade grid grid-cols-3 items-stretch gap-3.5">{cards}</div>
        </div>
      </main>
      <Dock tabs={groups.map((g) => ({ id: g, label: g, icon: ICON[g] ?? <SlidersHorizontal className="size-4" /> }))} active={active ?? ''} onChange={setTab} />
    </>
  )
}

/** Side view of a switch: travel scale, actuation line and the Rapid Trigger band. */
function TravelDiagram({ max, act, sens, live }: { max: number; act: number; sens?: number; live?: number }) {
  const H = 150, top = 8
  const y = (mm: number) => top + (mm / max) * (H - top - 4)
  const ticks = Array.from({ length: Math.floor(max * 2) + 1 }, (_, i) => i / 2)
  return (
    <svg viewBox="0 0 240 160" className="mx-auto block h-[160px] w-auto max-w-full" role="img" aria-label={`Actuation at ${act.toFixed(2)} mm of ${max.toFixed(1)} mm travel${sens ? `, Rapid Trigger ${sens.toFixed(2)} mm` : ''}`}>
      {ticks.map((t) => (
        <g key={t}>
          <rect x={0} y={y(t)} width={t % 1 === 0 ? 10 : 5} height={1} fill="rgb(255 255 255 / 0.25)" />
          {t % 1 === 0 && <text x={14} y={y(t) + 3} fontSize={7.5} fill="rgb(255 255 255 / 0.35)" fontFamily="Unbounded">{t}</text>}
        </g>
      ))}
      <rect x={52} y={6} width={90} height={H - 4} rx={8} fill="rgb(0 0 0 / 0.4)" />
      <rect x={92} y={y(live ?? act)} width={10} height={Math.max(0, H - y(live ?? act))} fill="rgb(255 255 255 / 0.12)" />
      <rect x={62} y={y(live ?? act) - 24} width={70} height={24} rx={6} fill={live !== undefined && live >= act ? '#E6E8EC' : 'url(#cap)'} style={{ transition: 'y .05s linear' }} />
      {sens !== undefined && <rect x={40} y={y(act) - (sens / max) * (H - 12)} width={160} height={Math.max(3, (2 * sens / max) * (H - 12))} fill="rgb(230 232 236 / 0.12)" />}
      <rect x={40} y={y(act) - 1} width={160} height={2} fill="#E6E8EC" style={{ filter: 'drop-shadow(0 0 4px #E6E8EC)' }} />
      <text x={238} y={y(act) - 6} fontSize={8} fill="#F2F2F4" fontFamily="Unbounded" fontWeight={600} textAnchor="end">ACT {act.toFixed(2)}</text>
      {sens !== undefined && <text x={238} y={y(act) + 14} fontSize={7.5} fill="rgb(255 255 255 / 0.55)" fontFamily="Unbounded" textAnchor="end">RT ±{sens.toFixed(2)}</text>}
      <rect x={40} y={y(max)} width={160} height={1} fill="rgb(255 255 255 / 0.15)" />
      <defs>
        <linearGradient id="cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#38383d" /><stop offset="1" stopColor="#1e1e21" /></linearGradient>
      </defs>
    </svg>
  )
}
