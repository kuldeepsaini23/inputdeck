import { useEffect, useMemo, useRef, useState } from 'react'
import { Gauge, Keyboard as KeyboardIcon, Lightbulb, Settings2, SlidersHorizontal, Swords, Timer, Zap } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { KeyCap, Setting, Value } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { decodeMacroKey, describe as describeKc, label as kcLabel } from '#/lib/keycodes'
import { usedBytes, type Macros } from '#/lib/macros'
import { KeyboardView, type KeyLook } from './KeyboardView'
import { KeyCard, KeyPicker, effective, type Keymap } from './KeymapCards'
import { MacroEditor, MacroList, UsageBar } from './MacroCards'
import { LiveLightCard } from './LiveLightTest'
import { useLivePaint } from '#/lib/live-paint'
import { useDevices } from '#/lib/device-context'
import { AdvancedCards, MODE_COLOR, MODE_NAME, advancedSummary, entryAt } from './AdvancedCards'
import { SocdCard, socdColor, socdEntryLabel, socdEntryOf, socdPickKey, type SocdPick } from './SocdCards'
import { BigValue, Card, ChoiceSelect, Range, Segmented, SWATCHES, Toggle, hex, type Choice } from './kit'
import { GenericCard, Hero, Pulse, shortHz, type Edit } from './parts'
import { Dock, textOf } from './shell'

type PerKeyTrigger = Extract<Value, { kind: 'perKeyTrigger' }>
type PerKeyColor = Extract<Value, { kind: 'perKeyColor' }>
type Float = Extract<Value, { kind: 'float' }>
type Num = Extract<Value, { kind: 'number' }>

// Tabs: each big feature gets its own. Settings from the drivers are sorted into them by key or group.
const ORDER = ['Performance', 'Rapid Trigger', 'SOCD', 'Keys', 'Lighting', 'Macros', 'Settings']
const ICON: Record<string, React.ReactNode> = {
  Performance: <Gauge className="size-4" />,
  'Rapid Trigger': <Timer className="size-4" />,
  SOCD: <Swords className="size-4" />,
  Keys: <KeyboardIcon className="size-4" />,
  Lighting: <Lightbulb className="size-4" />,
  Macros: <Zap className="size-4" />,
  Settings: <Settings2 className="size-4" />,
}
/** settings with their own place in a tab (everything else in their group shows as a generic card) */
const OWN = new Set(['rt_adaptive', 'advanced_keys', 'actuation', 'rapid_trigger', 'rt_sens', 'per_key_trigger', 'per_key_color', 'socd', 'keymap', 'macros', 'polling', 'profile', 'fw', 'model'])
/** driver groups that feed a tab of another name */
const GROUP_TAB: Record<string, string> = { Switches: 'Performance', Info: 'Settings', Profile: 'Settings', Profiles: 'Settings' }
/** old ?tab= values */
const TAB_ALIAS: Record<string, string> = { Switches: 'Performance' }
/** lighting settings drawn by the Lighting cards */
const LIGHT_OWN = new Set(['light_mode', 'light_power', 'light_bri', 'light_speed', 'light_color', 'light_rainbow'])
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
    const has = (k: string) => (edit ?? []).some((s) => s.key === k)
    const t = new Set<string>()
    if (has('actuation') || has('per_key_trigger') || has('polling')) t.add('Performance')
    if (has('rapid_trigger') || has('rt_sens') || has('per_key_trigger') || has('rt_adaptive')) t.add('Rapid Trigger')
    if (has('socd')) t.add('SOCD')
    for (const s of edit ?? []) {
      if (OWN.has(s.key) || s.group === 'Per-key') continue
      t.add(GROUP_TAB[s.group] ?? s.group)
    }
    if (has('keymap') || has('advanced_keys')) t.add('Keys')
    if (has('macros')) t.add('Macros')
    if (edit) t.add('Settings')
    return [...t].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
  }, [edit])
  const want = tab ? TAB_ALIAS[tab] ?? tab : undefined
  const active = want && groups.includes(want) ? want : groups[0]
  /** generic settings that belong on a tab (not drawn by a dedicated card) */
  const extras = (t: string) => (edit ?? []).filter((s) => !OWN.has(s.key) && s.group !== 'Per-key' && (GROUP_TAB[s.group] ?? s.group) === t)
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
    if (active !== 'Performance') setTesting(false)
  }, [active])
  const kbMax = Math.round(Math.min(1000, Math.max(640, (vh - 420) / 0.43)))

  const brand = dev.driver.brand().toUpperCase()
  const pkT = get('per_key_trigger')?.value as PerKeyTrigger | undefined
  const pkC = get('per_key_color')?.value as PerKeyColor | undefined
  // live per-key colours (boards that stream them; the design lives in this browser)
  const lp = useLivePaint(dev, useDevices().canWrite(dev.id))
  const keys: KeyCap[] | undefined = pkT?.keys ?? pkC?.keys ?? dev.driver.layout?.()

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
  // ---- advanced key functions (Mod-Tap / Toggle / DKS), the second half of the Keys tab
  const advS = get('advanced_keys')
  const adv = advS?.value.kind === 'advancedKeys' ? advS.value : undefined
  const [keysView, setKeysView] = useState<'remap' | 'advanced'>('remap')
  const [advPick, setAdvPick] = useState<number | undefined>(undefined)
  const advSel = adv && advPick !== undefined && advPick < adv.keys.length ? advPick : undefined
  const onAdv = active === 'Keys' && !!adv && (keysView === 'advanced' || !km)
  const locked = (i: number) => !!km?.locked?.[layer]?.includes(i)
  const onKeys = active === 'Keys' && !!km && !onAdv

  // ---- macros (drivers with a macros setting)
  const macS = get('macros')
  const mac = macS?.value.kind === 'macros' ? macS.value : undefined
  const [slotPick, setSlot] = useState(0)
  const slot = mac ? Math.min(slotPick, Math.max(0, mac.slots - 1)) : 0
  const onMacros = active === 'Macros' && !!mac

  // ---- SOCD (drivers with an socd setting): the card takes over the board while it is in use
  const socdS = get('socd')
  const socd = socdS?.value.kind === 'socd' ? socdS.value : undefined
  const [socdPick, setSocdPick] = useState<SocdPick | undefined>(undefined)
  const [socdSelPick, setSocdSel] = useState<number | undefined>(undefined)
  const [socdMsg, setSocdMsg] = useState<string | undefined>(undefined)
  const socdSel = socd?.mode === 'pairs' && socdSelPick !== undefined && socdSelPick < socd.entries.length ? socdSelPick : undefined
  const socdPicking = socd && socdPick && (socdPick.entry < socd.entries.length) ? socdPick : undefined
  const onSocd = active === 'SOCD' && !!socd
  useEffect(() => {
    setSocdPick(undefined)
    setSocdSel(undefined)
    setSocdMsg(undefined)
  }, [active, dev.id])
  const socdBoardSel = !onSocd ? new Set<number>() : socdPicking ? new Set(socd!.mode === 'pairs' ? socdPicking.keys : socd!.entries[socdPicking.entry].keys) : socdSel !== undefined ? new Set(socd!.entries[socdSel].keys) : new Set<number>()
  /** board clicks while the SOCD card is active */
  const socdClick = (next: Set<number>) => {
    if (!socd) return
    const added = [...next].filter((i) => !socdBoardSel.has(i))
    const removed = [...socdBoardSel].filter((i) => !next.has(i))
    // a click next to the keys clears the whole selection: not a request to drop every key
    if (!added.length && removed.length > 1) return
    const changed = added.concat(removed)
    if (!socdPicking) {
      // not picking: clicking a key in a pair selects that pair
      const p = changed[0]
      const e = p === undefined ? -1 : socdEntryOf(socd, p)
      setSocdSel(e >= 0 ? e : undefined)
      return
    }
    let v = socd
    let pick: SocdPick | undefined = socdPicking
    let msg: string | undefined
    let edited = false
    for (const p of changed) {
      if (!pick) break
      const r = socdPickKey(v, pick, p)
      msg = r.msg
      if (r.value) {
        v = r.value
        edited = true
      }
      pick = r.pick
    }
    if (edited) onEdit('socd', v)
    setSocdMsg(msg)
    setSocdPick(pick)
    // a finished pair stays selected for its mode / travel
    if (!pick && socd.mode === 'pairs') setSocdSel(socdPicking.entry < 0 ? v.entries.length - 1 : socdPicking.entry)
  }

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
      if (locked(i)) return { dim: true, title: `${kcLabel(code, km!.codes) || 'None'}: can't be changed on this keyboard` }
      return { dot: was !== undefined && was !== code, dim: code === 1 && layer > 0, title: `${kcLabel(code, km!.codes) || 'None'}: ${describeKc(code, km!.codes)}` }
    })
  } else if (onAdv) {
    interactive = true
    boardKeys = adv!.keys
    looks = adv!.keys.map((k, i) => {
      const e = entryAt(adv!, i)
      if (e) return { color: MODE_COLOR[e.mode], title: `${k.label}: ${MODE_NAME[e.mode]}` }
      if (adv!.unavailable?.includes(i)) return { dim: true, title: `${k.label}: can't take an advanced function` }
      return {}
    })
  } else if (onMacros && km && keys) {
    // keys that play the selected macro (on any layer) get a dot
    looks = km.keys.map((_, i) => {
      const ls = km.layers.map((l, li) => [li, l[i]] as const).filter(([, c]) => decodeMacroKey(c, km.codes) === slot)
      return ls.length ? { dot: true, title: `Plays M${slot} on layer ${ls.map(([li]) => li).join(', ')}` } : {}
    })
  } else if (onSocd) {
    // SOCD keys in their pair / group colour; keys that can't be used are faded
    interactive = true
    boardKeys = socd!.keys
    looks = socd!.keys.map((k, p) => {
      const e = socdEntryOf(socd!, p)
      if (e >= 0) return { color: socdColor(e), title: `${k.label}: SOCD ${socdEntryLabel(socd!, e)}` }
      if (socd!.unavailable?.includes(p)) return { dim: true, title: `${k.label}: can't be used for SOCD` }
      return {}
    })
  } else if (keys && active === 'Performance' && pkT && testing) {
    looks = keys.map((_, i) => {
      const mm = live.depth.get(i) ?? 0
      return { press: mm / (pkT.max || 4), fired: mm >= pkT.travel[i] - 1e-6 && mm > 0.05, rt: pkT.rapid[i] }
    })
  } else if (keys && active === 'Performance' && pkT) {
    interactive = true
    looks = pkT.travel.map((t, i) => ({ tint: Math.pow(1 - (t - pkT.min) / (pkT.max - pkT.min || 1), 2), rt: pkT.rapid[i] }))
  } else if (keys && active === 'Rapid Trigger' && pkT) {
    interactive = true
    // Rapid Trigger keys glow; the more sensitive, the brighter
    looks = pkT.rapid.map((on, i) => (on ? { tint: 0.35 + 0.65 * (1 - (pkT.sens[i] - pkT.sensMin) / (pkT.sensMax - pkT.sensMin || 1)), rt: true, title: `${pkT.keys[i]?.label}: Rapid Trigger ±${pkT.sens[i].toFixed(2)} mm` } : { dim: true }))
  } else if (keys && active === 'Lighting' && lp.on) {
    interactive = true
    looks = keys.map((_, i) => ({ color: hex(lp.colors[i] ?? 0) }))
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
  } else if (active === 'Performance') {
    ;[hero, cards] = triggers('perf')
  } else if (active === 'Rapid Trigger') {
    ;[hero, cards] = triggers('rt')
  } else if (active === 'SOCD' && socd) {
    ;[hero, cards] = socdTab()
  } else if (active === 'Lighting') {
    ;[hero, cards] = lighting()
  } else if (onAdv) {
    const sm = advancedSummary(adv!, advSel)
    hero = <Hero brand={brand} label={advSel === undefined ? 'Advanced keys' : 'Advanced key'} value={sm.value} size={sm.value.length > 6 ? Math.max(30, Math.round(400 / sm.value.length)) : 64} sub={sm.sub} />
    cards = <AdvancedCards v={adv!} pos={advSel} onChange={(nv) => onEdit('advanced_keys', nv)} />
  } else if (onKeys) {
    ;[hero, cards] = keymap()
  } else if (onMacros) {
    ;[hero, cards] = macros()
  } else if (active === 'Settings') {
    ;[hero, cards] = settingsTab()
  } else if (active) {
    hero = <Hero brand={brand} label={active} value={dev.driver.model()} size={48} />
    cards = <GenericCard title={active} settings={extras(active)} onEdit={onEdit} className="col-span-3" />
  } else {
    hero = <Hero brand={brand} label="Keyboard" value={dev.driver.model()} size={48} sub={textOf(dev, 'unsupported') ?? 'No settings to change on this keyboard yet.'} />
  }

  function pollingCard(wide: boolean) {
    const poll = get('polling')
    if (poll?.value.kind !== 'choice') return null
    const label = choiceLabel(poll)
    const rate = parseInt(label ?? '0', 10)
    return (
      <Card key="poll" title="Polling rate" className={wide ? 'col-span-2' : undefined}>
        <div className="flex items-end justify-between gap-4">
          <BigValue value={label?.replace(/\s*Hz/i, '') ?? '—'} unit="Hz" size={wide ? 30 : 26} />
          {wide && <Pulse rate={rate || 1000} width={240} />}
        </div>
        <Segmented className="mt-4" label="Polling rate" options={poll.value.options.map(([l, v]) => [shortHz(l), v] as const)} value={poll.value.current}
          onChange={(c) => onEdit('polling', { ...(poll.value as Choice), current: c })} />
        <p className="hint mt-3 mb-0">{rate ? `Reports every ${(1000 / rate).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} ms. ` : ''}Higher rates report presses sooner and use a little more CPU.</p>
      </Card>
    )
  }

  /** Performance (actuation, polling, live test) and Rapid Trigger share the per-key selection. */
  function triggers(view: 'perf' | 'rt'): [React.ReactNode, React.ReactNode] {
    const act = get('actuation')?.value as Float | undefined
    const rt = get('rapid_trigger')?.value as Extract<Value, { kind: 'toggle' }> | undefined
    const sens = get('rt_sens')?.value as Float | undefined
    const perKey = !!pkT && selIdx.length > 0
    const first = selIdx[0]
    const range = pkT ?? (act ? { min: act.min, max: act.max, step: act.step } : undefined)
    // with no keys picked, describe the whole board from the per-key data when there is some
    // (a driver's "all keys" value may come from a single reference key)
    const scopeIdx = perKey ? selIdx : pkT ? pkT.travel.map((_, i) => i) : []
    const first0 = scopeIdx[0] ?? 0
    const travel = pkT && scopeIdx.length ? pkT.travel[first0] : act?.current
    const uniform = !pkT || scopeIdx.every((i) => Math.abs(pkT.travel[i] - pkT.travel[first0]) < 1e-6)
    const rtAll = pkT && scopeIdx.length ? scopeIdx.every((i) => pkT.rapid[i]) : rt?.on ?? false
    const rtSome = pkT && scopeIdx.length ? scopeIdx.some((i) => pkT.rapid[i]) : rtAll
    const firstRt = pkT ? pkT.rapid.findIndex(Boolean) : -1
    const sensVal = perKey ? pkT!.sens[first] : sens?.current ?? (pkT && firstRt >= 0 ? pkT.sens[firstRt] : undefined)
    const sensUniform = !perKey || selIdx.every((i) => Math.abs(pkT!.sens[i] - pkT!.sens[first]) < 1e-6)
    const sensRange = pkT ? { min: pkT.sensMin, max: pkT.sensMax, step: pkT.step } : sens

    const setTravel = (n: number) => {
      if (perKey) {
        const t = pkT!.travel.slice()
        for (const i of selIdx) t[i] = snap(n, pkT!.step)
        onEdit('per_key_trigger', { ...pkT!, travel: t })
      } else if (act) onEdit('actuation', { ...act, current: snap(n, act.step) })
    }
    const setRt = (on: boolean) => {
      if (perKey || (!rt && pkT)) {
        const r = pkT!.rapid.slice()
        for (const i of perKey ? selIdx : r.map((_, i) => i)) r[i] = on
        onEdit('per_key_trigger', { ...pkT!, rapid: r })
      } else if (rt) onEdit('rapid_trigger', { kind: 'toggle', on })
    }
    const setSens = (n: number) => {
      if (perKey || (!sens && pkT)) {
        const s = pkT!.sens.slice()
        for (const i of perKey ? selIdx : s.map((_, i) => i)) s[i] = snap(n, pkT!.step)
        onEdit('per_key_trigger', { ...pkT!, sens: s })
      } else if (sens) onEdit('rt_sens', { ...sens, current: snap(n, sens.step) })
    }
    const scope = perKey ? `${selIdx.length} key${selIdx.length === 1 ? '' : 's'}` : 'all keys'
    const more = extras('Performance')

    // ---- live key test
    const lk = live.last
    const liveMm = lk !== undefined ? live.depth.get(lk) ?? 0 : 0
    if (view === 'perf' && testing) {
      const kname = lk !== undefined && keys?.[lk] ? keys[lk].label : undefined
      const a = lk !== undefined && pkT ? pkT.travel[lk] : travel
      const hTest = (
        <Hero live brand={brand} label={kname ? `Live travel · ${kname}` : 'Live travel'} value={liveMm.toFixed(2)} unit="mm" size={76}
          sub={kname && a !== undefined ? (liveMm >= a ? `Past its ${a.toFixed(2)} mm actuation point — the key fires` : `Fires at ${a.toFixed(2)} mm`) : 'Press any key on the keyboard.'} />
      )
      return [hTest, (
        <>
          <Card title="Key travel · live" className="col-span-2">
            <TravelDiagram max={range?.max ?? 4} act={a ?? 1} sens={undefined} live={liveMm} />
          </Card>
          <Card title="How to read it">
            <p className="hint m-0">Each key fills up as you press it and lights up once it passes its actuation point. Rapid Trigger keys keep their dot.</p>
            <button type="button" className="plat display mt-4 w-full rounded-full py-2.5 text-[12px] font-semibold" onClick={() => setTesting(false)}>Stop test</button>
          </Card>
        </>
      )]
    }

    // ---- Rapid Trigger tab
    if (view === 'rt') {
      const state = rtAll ? 'On' : rtSome ? 'Mixed' : 'Off'
      const h = (
        <Hero brand={brand} label={`Rapid Trigger · ${scope}`} value={state} size={76}
          sub={rtSome && sensVal !== undefined ? `Resets after ${sensUniform ? sensVal.toFixed(2) : 'mixed'} mm of upward travel` : 'Keys reset only when they rise back past the actuation point.'} />
      )
      return [h, (
        <>
          <Card title="Rapid Trigger" right={<Toggle label={`Rapid Trigger, ${scope}`} checked={rtAll} onChange={setRt} />}>
            <div className="display text-[26px] font-semibold">{state}</div>
            <p className="hint mt-1 mb-0">{perKey ? `For the ${scope} you picked.` : pkT ? 'For every key. Pick keys on the board to set them one by one.' : 'For every key.'}</p>
            {sensRange && sensVal !== undefined && (
              <>
                <div className="mt-4 flex items-baseline justify-between"><span className="eyebrow">Sensitivity</span><BigValue value={sensUniform ? sensVal.toFixed(2) : 'Mixed'} unit={sensUniform ? 'mm' : undefined} size={13} /></div>
                <Range className="mt-1.5" label="Rapid Trigger sensitivity" min={sensRange.min} max={sensRange.max} step={sensRange.step} value={sensVal} onChange={setSens} />
                <div className="mt-1 flex justify-between text-[9.5px] text-[var(--text-4)]"><span>{sensRange.min.toFixed(2)} · fastest</span><span>{sensRange.max.toFixed(2)} · steadiest</span></div>
              </>
            )}
          </Card>
          {range && travel !== undefined && (
            <Card title="Key travel">
              <TravelDiagram max={range.max} act={travel} sens={rtSome ? sensVal : undefined} />
            </Card>
          )}
          {get('rt_adaptive') && <GenericCard title="Adaptive" settings={[get('rt_adaptive')!]} onEdit={onEdit} />}
          <Card title="How it works">
            <p className="hint m-0">A normal key fires and resets at one fixed point. With Rapid Trigger a key resets as soon as it rises by the sensitivity distance, and fires again as soon as it goes back down by the same amount, so quick taps and strafes register instantly.</p>
            <p className="hint mt-3 mb-0">Lower sensitivity reacts faster but can misfire if you rest your fingers on the keys.</p>
          </Card>
        </>
      )]
    }

    // ---- Performance tab
    const pollLabel = choiceLabel(get('polling'))
    const h = range && travel !== undefined ? (
      <Hero brand={brand} label={`Actuation · ${scope}`} value={uniform ? travel.toFixed(2) : 'Mixed'} unit={uniform ? 'mm' : undefined} size={76}
        sub={`Magnetic switches · ${range.min.toFixed(2)} – ${range.max.toFixed(2)} mm`} />
    ) : (
      <Hero brand={brand} label="Polling rate" value={pollLabel?.replace(/\s*Hz/i, '') ?? '—'} unit={pollLabel ? 'Hz' : undefined} size={76} sub="Wired" />
    )
    if (!range || travel === undefined) {
      return [h, <>{pollingCard(true)}{more.length > 0 && <GenericCard title="More" settings={more} onEdit={onEdit} />}</>]
    }
    const presets = PRESETS.filter(([, mm]) => mm >= range.min && mm <= range.max)
    return [h, (
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
          <TravelDiagram max={range.max} act={travel} sens={rtSome ? sensVal : undefined} />
        </Card>
        {pollingCard(false)}
        {more.length > 0 && <GenericCard title="More" settings={more} onEdit={onEdit} className="col-span-3" />}
      </>
    )]
  }

  function socdTab(): [React.ReactNode, React.ReactNode] {
    const v = socd!
    const used = v.entries.filter((e) => e.keys.length > 0).length
    const h = (
      <Hero brand={brand} label="SOCD · Snap Tap" value={used} unit={v.mode === 'pairs' ? (used === 1 ? 'pair' : 'pairs') : used === 1 ? 'group' : 'groups'} size={76}
        sub="When two opposite keys are held, only one counts, so you never stand still while strafing." />
    )
    return [h, (
      <SocdCard key="socd" className="col-span-3" v={v} sel={socdSel} pick={socdPicking}
        onSelect={(i) => { setSocdMsg(undefined); setSocdSel(i) }}
        onPick={(p) => { setSocdMsg(undefined); setSocdPick(p) }}
        onChange={(nv) => onEdit('socd', nv)} />
    )]
  }

  function settingsTab(): [React.ReactNode, React.ReactNode] {
    const more = extras('Settings')
    const model = dev.driver.model()
    const rows: [string, string | undefined][] = [
      ['Model', model],
      ['Brand', dev.driver.brand()],
      ['Switches', pkT ? 'Magnetic' : undefined],
      ['Keys', keys ? String(keys.length) : undefined],
      ['Connection', 'Wired'],
      ['Firmware', textOf(dev, 'fw')],
      ['USB id', dev.id],
    ]
    const h = <Hero brand={brand} label="Keyboard" value={model} size={model.length > 8 ? Math.max(30, Math.round(440 / model.length)) : 64} sub={textOf(dev, 'fw') ? `Firmware ${textOf(dev, 'fw')}` : undefined} />
    return [h, (
      <>
        <Card title="Device">
          <dl className="m-0">
            {rows.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-white/5 py-2 last:border-0">
                <dt className="eyebrow">{k}</dt>
                <dd className="display m-0 truncate text-[11px]">{v}</dd>
              </div>
            ))}
          </dl>
          {textOf(dev, 'unsupported') && <p className="hint mt-2 mb-0 text-[var(--warn)]">{textOf(dev, 'unsupported')}</p>}
        </Card>
        {more.length > 0 ? <GenericCard title="Settings" settings={more} onEdit={onEdit} className="col-span-2" /> : (
          <Card title="Profiles" className="col-span-2">
            <p className="hint m-0">{get('profile') ? 'Switch profiles with P1, P2… at the top right. Each profile keeps its own settings on the keyboard.' : 'This keyboard keeps one set of settings, stored on the keyboard itself.'}</p>
          </Card>
        )}
      </>
    )]
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
        <KeyPicker km={m} layer={layer} keyIndex={keySel} onPick={assign} macros={mac?.slots} className="col-span-2" />
        <KeyCard km={m} layer={layer} keyIndex={keySel} original={origLayers} onPick={assign} />
      </>
    )
    return [h, c]
  }

  function macros(): [React.ReactNode, React.ReactNode] {
    const v = mac as Macros
    const steps = v.macros[slot] ?? []
    const used = usedBytes(v)
    const bound = km ? km.keys.filter((_, i) => km.layers.some((l) => decodeMacroKey(l[i], km.codes) === slot)).length : 0
    const h = (
      <Hero brand={brand} label={`Macro · M${slot}`} value={steps.length} unit={steps.length === 1 ? 'step' : 'steps'} size={64}
        sub={<>
          {km ? (bound ? `On ${bound} key${bound === 1 ? '' : 's'} (dotted above).` : 'Not on a key yet. Put a macro on a key in the Keys tab.') : 'Put a macro on a key in the Keys tab.'}
          {used !== undefined && v.maxBytes ? ` ${used} of ${v.maxBytes} bytes used.` : ''}
        </>}>
        {macS?.hint && <p className="hint mt-3 mb-0">{macS.hint}</p>}
      </Hero>
    )
    const c = (
      <>
        <div className="flex flex-col gap-3.5">
          <MacroList v={v} slot={slot} onSelect={setSlot} />
          {v.maxBytes !== undefined && <section className="glass fade-in p-[21px] pt-[19px]"><UsageBar v={v} /></section>}
        </div>
        <MacroEditor v={v} slot={slot} onChange={(nv) => onEdit('macros', nv)} className="col-span-2" />
      </>
    )
    return [h, c]
  }

  /** Lighting tab while live per-key colours are on: paint keys, everything else is paused. */
  function liveLighting(): [React.ReactNode, React.ReactNode] {
    const idx = selIdx.length ? selIdx : lp.colors.map((_, i) => i)
    const first = lp.colors[idx[0]] ?? 0
    const keyColor = idx.every((i) => lp.colors[i] === first) ? first : null
    const scope = selIdx.length ? `${selIdx.length} key${selIdx.length === 1 ? '' : 's'}` : 'all keys'
    const used = new Set(lp.colors).size
    const h = <Hero brand={brand} label="Per-key lighting · live" value={used} unit={used === 1 ? 'colour' : 'colours'} size={64}
      sub="Select keys on the board, then pick a colour. Nothing selected paints every key." />
    const c = (
      <>
        <Card title={`Colour · ${scope}`}>
          <div className="flex items-center gap-4">
            <label className="relative grid size-[112px] shrink-0 cursor-pointer place-items-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-[0_4px_10px_rgb(0_0_0/0.5)]" title="Pick any colour">
              <span className="grid size-[80px] place-items-center rounded-full bg-[#141416]">
                <span className="size-[42px] rounded-full" style={{ background: keyColor === null ? '#333' : hex(keyColor), boxShadow: keyColor === null ? undefined : `0 0 14px ${hex(keyColor)}` }} />
              </span>
              <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label="Pick any colour" value={keyColor === null ? '#ffffff' : hex(keyColor).toLowerCase()} onChange={(e) => lp.paint(selIdx, parseInt(e.target.value.slice(1), 16))} />
            </label>
            <div className="min-w-0">
              <div className="display text-[12px] font-semibold">{keyColor === null ? 'Mixed' : hex(keyColor)}</div>
              <div className="mt-3 grid w-[78px] grid-cols-3 gap-2">
                {SWATCHES.slice(0, 9).map((sw) => (
                  <button key={sw} type="button" className="swatch !size-[18px]" style={{ background: hex(sw) }} aria-label={`Paint ${scope} ${hex(sw)}`} aria-pressed={keyColor === sw} onClick={() => lp.paint(selIdx, sw)} />
                ))}
              </div>
            </div>
          </div>
          <button type="button" className="chip mt-4 !text-[11px]" onClick={() => lp.paint(selIdx, 0)}>Turn {scope} off</button>
        </Card>
        <Card title="Effects paused" className="col-span-2">
          <p className="hint m-0">While per-key colours are on, the keyboard shows only these colours: effects, colour and brightness changes wait until you switch per-key lighting off below. Brightness set on the keyboard still dims them.</p>
        </Card>
        <LiveLightCard dev={dev} lp={lp} />
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
    if (lp.on) return liveLighting()
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
    const effect = choiceLabel(mode) ?? '—'
    const h = <Hero brand={brand} label="Effect" value={effect} size={effect.length > 6 ? Math.max(24, Math.round(380 / effect.length)) : 64} sub={power && !power.on ? 'Lights are off' : 'Lights on'} />
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
          <div className="display text-[26px] font-semibold">{power && !power.on ? 'Off' : bri ? `${pctOf(bri)}%` : power ? 'On' : '—'}</div>
          {bri && <Level label="Brightness" v={bri} onChange={(n) => onEdit('light_bri', { ...bri, current: n })} />}
          {speed && <Level label="Speed" v={speed} onChange={(n) => onEdit('light_speed', { ...speed, current: n })} />}
        </Card>
        <LiveLightCard dev={dev} lp={lp} />
        {/* extra light zones (e.g. Lofree Hyzen: bottom strip and receiver) get a card each */}
        {[['strip_', 'Bottom light strip'], ['dongle_', 'Receiver light']].map(([pre, title]) => {
          const zone = extras('Lighting').filter((x) => x.key.startsWith(pre))
          return zone.length ? <GenericCard key={pre} title={title} settings={zone} onEdit={onEdit} className="col-span-3 xl:col-span-1" /> : null
        })}
        {extras('Lighting').filter((x) => !LIGHT_OWN.has(x.key) && !/^(strip|dongle)_/.test(x.key)).length > 0 && (
          <GenericCard title="More lighting" settings={extras('Lighting').filter((x) => !LIGHT_OWN.has(x.key) && !/^(strip|dongle)_/.test(x.key))} onEdit={onEdit} className="col-span-3" />
        )}
      </>
    )
    return [h, c]
  }

  const showBar = (interactive || testing) && boardKeys
  // keys tab: one key at a time; a click (or drag) picks the newly added key
  const pickKey = (next: Set<number>) => {
    const k = [...next].find((i) => i !== keySel)
    setKSel(k !== undefined && locked(k) ? undefined : k)
  }
  const pickAdv = (next: Set<number>) => setAdvPick([...next].find((i) => i !== advSel))
  const viewSwitch = km && adv && (
    <Segmented label="Keys view" className="[&_button]:!px-3.5 [&_button]:!py-1.5 [&_button]:!text-[11px]" value={keysView}
      options={[['Remap', 'remap'], ['Mod-Tap · Toggle · DKS', 'advanced']] as const} onChange={setKeysView} />
  )
  return (
    <>
      <main className="scroll-thin relative z-10 flex h-[calc(100%-76px)] flex-col items-center overflow-y-auto px-16 pt-2 pb-[130px]">
        <div className="relative w-full" style={{ maxWidth: kbMax }}>
          <div className="pointer-events-none absolute -inset-x-20 -top-10 h-[120%] rounded-full bg-[radial-gradient(ellipse_at_center,rgb(230_232_236/0.08),transparent_65%)]" />
          {boardKeys ? (
            <KeyboardView keys={boardKeys} looks={looks} selected={onKeys ? new Set(keySel === undefined ? [] : [keySel]) : onAdv ? new Set(advSel === undefined ? [] : [advSel]) : onSocd ? socdBoardSel : interactive ? sel : new Set()}
              onSelect={onKeys ? pickKey : onAdv ? pickAdv : onSocd ? socdClick : setSel} interactive={interactive} knob={dev.driver.knob} maxWidth={kbMax} />
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
              {viewSwitch}
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
          ) : onAdv ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className="text-[12px] text-[var(--text-3)]">
                {advSel !== undefined
                  ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{adv!.keys[advSel]?.label || 'Key'}</span>selected · pick its function below</>
                  : 'click a key to give it an advanced function · colour = Mod-Tap / Toggle / DKS'}
              </span>
              {viewSwitch}
            </div>
          ) : onSocd ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className={cn('text-[12px] text-[var(--text-3)]', socdMsg && 'text-[var(--warn)]')}>
                {socdMsg ?? (socdPicking
                  ? socd!.mode === 'pairs'
                    ? socdPicking.keys.length
                      ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{socd!.keys[socdPicking.keys[0]]?.label}</span>picked · click key 2 of the pair</>
                      : 'SOCD · click key 1 of the pair'
                    : `SOCD · click keys to add them to group ${socdPicking.entry + 1}${socd!.removable === false ? '' : ', click again to take them out'}`
                  : socdSel !== undefined
                    ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{socdEntryLabel(socd!, socdSel)}</span>selected · coloured keys are in SOCD</>
                    : 'coloured keys are in SOCD · click one to select its ' + (socd!.mode === 'pairs' ? 'pair' : 'group'))}
              </span>
              {(socdPicking || socdSel !== undefined) && (
                <button type="button" className="chip display !text-[11px] font-semibold" onClick={() => { setSocdPick(undefined); setSocdSel(undefined); setSocdMsg(undefined) }}>
                  {socdPicking && socd!.mode === 'pairs' ? 'Cancel' : 'Done'}
                </button>
              )}
            </div>
          ) : (
          <div className={cn('mt-3 flex h-9 items-center justify-between', !showBar && 'invisible')}>
            <span className="text-[12px] text-[var(--text-3)]">{!testing && <span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{selIdx.length}</span>}
              {testing ? 'live test · press keys on your keyboard' : <>key{selIdx.length === 1 ? '' : 's'} selected · {selIdx.length === 0 ? 'editing all keys, click or drag to pick some' : 'click or drag over keys'}</>}</span>
            <span className="flex gap-1.5">
              {canTest && active === 'Performance' && (
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

const pctOf = (v: Num) => (v.max > v.min ? Math.round(((v.current - v.min) / (v.max - v.min)) * 100) : 0)

/** A few steps as buttons; long ranges (e.g. brightness 0-125) as a slider. */
function Level({ label, v, onChange }: { label: string; v: Num; onChange: (n: number) => void }) {
  const n = v.max - v.min + 1
  return (
    <>
      <div className="mt-3 mb-2 flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        {n > 11 && <span className="display text-[11px] text-[var(--text-2)]">{pctOf(v)}%</span>}
      </div>
      {n <= 11 ? (
        <Segmented label={label} options={Array.from({ length: n }, (_, k) => [String(v.min + k), v.min + k] as const)} value={v.current} onChange={onChange} />
      ) : (
        <Range label={label} min={v.min} max={v.max} value={v.current} onChange={onChange} />
      )}
    </>
  )
}
