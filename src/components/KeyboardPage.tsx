import { useEffect, useMemo, useRef, useState } from 'react'
import { Gamepad2, Gauge, Keyboard as KeyboardIcon, Lightbulb, Settings2, SlidersHorizontal, Swords, Timer, Zap } from 'lucide-react'
import type { DeviceState } from '#/devices'
import type { KeyCap, Setting, Value } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { useT } from '#/lib/i18n'
import {
  availableRegions, common, copyColor, copyLayer, copyTrigger, defaultCode, invert, pasteColor, pasteTrigger, planLayerPaste,
  regionKeys, regionOf, sameColorKeys, sameRtKeys, sameTriggerKeys, type KeyClip, type LayerClip, type Region,
} from '#/lib/key-select'
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
import { CurveCard, GamepadMapCard, mappedKeys, targetColor } from './GamepadCards'
import { Dock, textOf } from './shell'

type PerKeyTrigger = Extract<Value, { kind: 'perKeyTrigger' }>
type PerKeyColor = Extract<Value, { kind: 'perKeyColor' }>
type Float = Extract<Value, { kind: 'float' }>
type Num = Extract<Value, { kind: 'number' }>

// Tabs: each big feature gets its own. Settings from the drivers are sorted into them by key or group.
const ORDER = ['Performance', 'Rapid Trigger', 'SOCD', 'Gamepad', 'Keys', 'Lighting', 'Macros', 'Settings']
const ICON: Record<string, React.ReactNode> = {
  Performance: <Gauge className="size-4" />,
  'Rapid Trigger': <Timer className="size-4" />,
  SOCD: <Swords className="size-4" />,
  Gamepad: <Gamepad2 className="size-4" />,
  Keys: <KeyboardIcon className="size-4" />,
  Lighting: <Lightbulb className="size-4" />,
  Macros: <Zap className="size-4" />,
  Settings: <Settings2 className="size-4" />,
}
/** settings with their own place in a tab (everything else in their group shows as a generic card) */
const OWN = new Set(['rt_adaptive', 'advanced_keys', 'actuation', 'rapid_trigger', 'rt_sens', 'per_key_trigger', 'per_key_color', 'socd', 'keymap', 'macros', 'polling', 'profile', 'fw', 'model', 'gp_map', 'gp_curve_ls', 'gp_curve_rs', 'gp_curve_lt', 'gp_curve_rt'])
/** driver groups that feed a tab of another name */
const GROUP_TAB: Record<string, string> = { Switches: 'Performance', Info: 'Settings', Profile: 'Settings', Profiles: 'Settings' }
/** old ?tab= values */
const TAB_ALIAS: Record<string, string> = { Switches: 'Performance' }
/** lighting settings drawn by the Lighting cards */
const LIGHT_OWN = new Set(['light_mode', 'light_power', 'light_bri', 'light_speed', 'light_color', 'light_rainbow'])
const PRESETS: [string, number][] = [['Speed', 0.4], ['Gaming', 1.2], ['Balanced', 1.7], ['Typing', 2.4]]

type T = ReturnType<typeof useT>
/** Tab names are English ids (some come from driver groups); this is what the dock shows. */
const tabLabel = (t: T, id: string) =>
  ({ Performance: t('Performance'), 'Rapid Trigger': t('Rapid Trigger'), SOCD: 'SOCD', Gamepad: t('Gamepad'), Keys: t('Keys'), Lighting: t('Lighting'), Macros: t('Macros'), Settings: t('Settings') })[id] ?? t(id)
const regionName = (t: T, n: Region) => ({ All: t('All'), WASD: 'WASD', Letters: t('Letters'), 'Number row': t('Number row'), Arrows: t('Arrows'), Mods: t('Mods'), None: t('None') })[n]
const presetName = (t: T, n: string) => ({ Speed: t('Speed'), Gaming: t('Gaming'), Balanced: t('Balanced'), Typing: t('Typing') })[n] ?? n

const choiceLabel = (s?: Setting) => (s?.value.kind === 'choice' ? s.value.options.find((o) => o[1] === (s.value as Choice).current)?.[0] : undefined)
const snap = (n: number, step: number) => Math.round(n / step) * step

export function KeyboardPage({ dev, tab, setTab, onEdit }: { dev: DeviceState; tab?: string; setTab: (t: string) => void; onEdit: Edit }) {
  const t = useT()
  const edit = dev.edit
  const get = (k: string) => edit?.find((s) => s.key === k)
  const groups = useMemo(() => {
    const has = (k: string) => (edit ?? []).some((s) => s.key === k)
    const t = new Set<string>()
    if (has('actuation') || has('per_key_trigger') || has('polling')) t.add('Performance')
    if (has('rapid_trigger') || has('rt_sens') || has('per_key_trigger') || has('rt_adaptive')) t.add('Rapid Trigger')
    if (has('socd')) t.add('SOCD')
    if (has('gp_map')) t.add('Gamepad')
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
  // copied per-key settings (Performance / Rapid Trigger: trigger; Lighting: colour) and a note about the last copy / paste
  const [clip, setClip] = useState<KeyClip | undefined>(undefined)
  const [selMsg, setSelMsg] = useState<string | undefined>(undefined)
  useEffect(() => setSelMsg(undefined), [sel, active])
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
  // a copied keymap layer (for this device and layout only) and a note about the last paste
  const [layerClipAt, setLayerClip] = useState<{ id: string; n: number; clip: LayerClip } | undefined>(undefined)
  const layerClip = km && layerClipAt?.id === dev.id && layerClipAt.n === km.keys.length ? layerClipAt.clip : undefined
  const [kmMsg, setKmMsg] = useState<string | undefined>(undefined)
  useEffect(() => setKmMsg(undefined), [layerPick, kSel, active, dev.id])
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

  // ---- gamepad (drivers with a gp_map setting): click a key, pick what it drives
  const gpS = get('gp_map')
  const gpMap = gpS?.value.kind === 'perKeyChoice' ? gpS.value : undefined
  const [gpPick, setGpPick] = useState<number | undefined>(undefined)
  const gpSel = gpMap && gpPick !== undefined && gpPick < gpMap.keys.length ? gpPick : undefined
  const onGamepad = active === 'Gamepad' && !!gpMap

  // ---- keyboard looks for the current tab
  let looks: KeyLook[] = []
  let interactive = false
  let boardKeys = keys
  if (onKeys) {
    interactive = true
    boardKeys = km!.keys.map((k, i) => ({ ...k, label: kcLabel(effective(km!, layer, i).code, km!.codes, km!.extra) }))
    looks = km!.keys.map((_, i) => {
      const code = km!.layers[layer][i]
      const was = origLayers?.[layer]?.[i]
      if (locked(i)) return { dim: true, title: t("{key}: can't be changed on this keyboard", { key: kcLabel(code, km!.codes, km!.extra) || t('None') }) }
      return { dot: was !== undefined && was !== code, dim: code === 1 && layer > 0, title: `${kcLabel(code, km!.codes, km!.extra) || t('None')}: ${t(describeKc(code, km!.codes, km!.extra))}` }
    })
  } else if (onAdv) {
    interactive = true
    boardKeys = adv!.keys
    looks = adv!.keys.map((k, i) => {
      const e = entryAt(adv!, i)
      if (e) return { color: MODE_COLOR[e.mode], title: `${k.label}: ${t(MODE_NAME[e.mode])}` }
      if (adv!.unavailable?.includes(i)) return { dim: true, title: t("{key}: can't take an advanced function", { key: k.label }) }
      return {}
    })
  } else if (onMacros && km && keys) {
    // keys that play the selected macro (on any layer) get a dot
    looks = km.keys.map((_, i) => {
      const ls = km.layers.map((l, li) => [li, l[i]] as const).filter(([, c]) => decodeMacroKey(c, km.codes) === slot)
      return ls.length ? { dot: true, title: t('Plays M{slot} on layer {layers}', { slot, layers: ls.map(([li]) => li).join(', ') }) } : {}
    })
  } else if (onSocd) {
    // SOCD keys in their pair / group colour; keys that can't be used are faded
    interactive = true
    boardKeys = socd!.keys
    looks = socd!.keys.map((k, p) => {
      const e = socdEntryOf(socd!, p)
      if (e >= 0) return { color: socdColor(e), title: `${k.label}: SOCD ${socdEntryLabel(socd!, e)}` }
      if (socd!.unavailable?.includes(p)) return { dim: true, title: t("{key}: can't be used for SOCD", { key: k.label }) }
      return {}
    })
  } else if (onGamepad) {
    interactive = true
    boardKeys = mappedKeys(gpMap!)
    looks = gpMap!.values.map((tg, i) => {
      if (tg === gpMap!.none) return { title: t('{key}: not mapped', { key: gpMap!.keys[i].label }) }
      const l = boardKeys![i].label
      return { color: targetColor(l), title: `${gpMap!.keys[i].label}: ${l}` }
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
    looks = pkT.rapid.map((on, i) => (on ? { tint: 0.35 + 0.65 * (1 - (pkT.sens[i] - pkT.sensMin) / (pkT.sensMax - pkT.sensMin || 1)), rt: true, title: t('{key}: Rapid Trigger ±{mm} mm', { key: pkT.keys[i]?.label ?? '', mm: pkT.sens[i].toFixed(2) }) } : { dim: true }))
  } else if (keys && active === 'Lighting' && lp.on) {
    interactive = true
    looks = keys.map((_, i) => ({ color: hex(lp.colors[i] ?? 0) }))
  } else if (keys && active === 'Lighting' && pkC) {
    interactive = true
    const on = (get('light_power')?.value as Extract<Value, { kind: 'toggle' }> | undefined)?.on ?? true
    looks = pkC.colors.map((c) => (on ? { color: hex(c) } : {}))
  }
  const selIdx = keys ? [...sel].filter((i) => i < keys.length) : []
  const regions = keys ? availableRegions(keys) : []
  const regionNow = keys ? regionOf(keys, sel, regions) : undefined
  const pickRegion = (r: Region) => setSel(new Set(keys ? regionKeys(keys, r) : []))

  // ---- multi-key tabs: same-config double-click, copy / paste of one key's settings
  const multiTab = !testing && ((active === 'Performance' || active === 'Rapid Trigger') && !!pkT ? 'trigger' : active === 'Lighting' && (lp.on || !!pkC) ? 'color' : undefined)
  const colorsNow = lp.on ? lp.colors : pkC?.colors
  /** double-click on a key: every key set up like it (added to the selection with a modifier) */
  const selectSame = (i: number, add: boolean) => {
    const same = multiTab === 'trigger' ? (active === 'Rapid Trigger' ? sameRtKeys(pkT!, i) : sameTriggerKeys(pkT!, i)) : multiTab === 'color' && colorsNow ? sameColorKeys(colorsNow, i) : [i]
    setSel(new Set(add ? [...sel, ...same] : same))
  }
  /** the selection's settings, when every selected key has the same (copy needs one value) */
  const selConfig = (): KeyClip | undefined => {
    if (!selIdx.length) return undefined
    if (multiTab === 'trigger') {
      const same = sameTriggerKeys(pkT!, selIdx[0])
      return selIdx.every((i) => same.includes(i)) ? copyTrigger(pkT!, selIdx[0]) : undefined
    }
    if (multiTab === 'color' && colorsNow) return common(selIdx, (i) => colorsNow[i]) === 'mixed' ? undefined : copyColor(keys, colorsNow, selIdx[0])
    return undefined
  }
  const canCopy = !!selConfig()
  const canPaste = !!clip && !!multiTab && clip.kind === multiTab && selIdx.length > 0
  const keyName = (c: KeyClip) => c.label || t('Key')
  const doCopy = () => {
    const c = selConfig()
    if (!c) return false
    setClip(c)
    setSelMsg(selIdx.length === 1 ? t('Copied {key}', { key: keyName(c) }) : t('Copied the settings of {n} keys', { n: selIdx.length }))
    return true
  }
  const doPaste = () => {
    if (!canPaste || !clip) return false
    if (clip.kind === 'trigger') onEdit('per_key_trigger', pasteTrigger(pkT!, selIdx, clip))
    else if (lp.on) lp.paint(selIdx, clip.rgb)
    else if (pkC) onEdit('per_key_color', { ...pkC, colors: pasteColor(pkC.colors, selIdx, clip.rgb) })
    const msg = selIdx.length === 1 ? t('Pasted {key} onto {n} key', { key: keyName(clip), n: selIdx.length }) : t('Pasted {key} onto {n} keys', { key: keyName(clip), n: selIdx.length })
    setSelMsg(msg)
    return true
  }
  // Ctrl/Cmd+C, Ctrl/Cmd+V on the board (not while typing, not when text is selected)
  const clipKeys = useRef<{ copy: () => boolean; paste: () => boolean; on: boolean }>({ copy: () => false, paste: () => false, on: false })
  clipKeys.current = { copy: doCopy, paste: doPaste, on: !!multiTab }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!clipKeys.current.on || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k !== 'c' && k !== 'v') return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (k === 'c' && window.getSelection()?.toString()) return
      if ((k === 'c' ? clipKeys.current.copy : clipKeys.current.paste)()) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /** what the selection (or the whole board) is set to, for the bar under the board */
  const selValue = (() => {
    const idx = selIdx.length ? selIdx : keys ? keys.map((_, i) => i) : []
    if (multiTab === 'trigger') {
      if (active === 'Rapid Trigger') {
        const on = common(idx, (i) => pkT!.rapid[i])
        if (on === 'mixed') return t('RT mixed')
        if (!on) return t('RT off')
        const s = common(idx, (i) => pkT!.sens[i], (a, b) => Math.abs(a - b) < 1e-6)
        return s === 'mixed' || s === undefined ? t('RT ±mixed') : t('RT ±{mm} mm', { mm: s.toFixed(2) })
      }
      const v = common(idx, (i) => pkT!.travel[i], (a, b) => Math.abs(a - b) < 1e-6)
      return v === 'mixed' || v === undefined ? t('Mixed') : `${v.toFixed(2)} mm`
    }
    if (multiTab === 'color' && colorsNow) {
      const c = common(idx, (i) => colorsNow[i] ?? 0)
      return c === 'mixed' || c === undefined ? t('Mixed') : hex(c)
    }
    return undefined
  })()

  let hero: React.ReactNode = null
  let cards: React.ReactNode = null

  if (!edit) {
    hero = <Hero brand={brand} label={t('Reading settings')} value="…" size={64} sub={t('Talking to the keyboard.')} />
  } else if (active === 'Performance') {
    ;[hero, cards] = triggers('perf')
  } else if (active === 'Rapid Trigger') {
    ;[hero, cards] = triggers('rt')
  } else if (active === 'SOCD' && socd) {
    ;[hero, cards] = socdTab()
  } else if (active === 'Gamepad') {
    ;[hero, cards] = gamepadTab()
  } else if (active === 'Lighting') {
    ;[hero, cards] = lighting()
  } else if (onAdv) {
    const sm = advancedSummary(adv!, advSel)
    hero = <Hero brand={brand} label={advSel === undefined ? t('Advanced keys') : t('Advanced key')} value={sm.value} size={sm.value.length > 6 ? Math.max(30, Math.round(400 / sm.value.length)) : 64} sub={sm.sub} />
    cards = <AdvancedCards v={adv!} pos={advSel} onChange={(nv) => onEdit('advanced_keys', nv)} />
  } else if (onKeys) {
    ;[hero, cards] = keymap()
  } else if (onMacros) {
    ;[hero, cards] = macros()
  } else if (active === 'Settings') {
    ;[hero, cards] = settingsTab()
  } else if (active) {
    hero = <Hero brand={brand} label={tabLabel(t, active)} value={dev.driver.model()} size={48} />
    cards = <GenericCard title={tabLabel(t, active)} settings={extras(active)} onEdit={onEdit} className="col-span-3" />
  } else {
    hero = <Hero brand={brand} label={t('Keyboard')} value={dev.driver.model()} size={48} sub={textOf(dev, 'unsupported') ? t(textOf(dev, 'unsupported')!) : t('No settings to change on this keyboard yet.')} />
  }

  function pollingCard(wide: boolean) {
    const poll = get('polling')
    if (poll?.value.kind !== 'choice') return null
    const label = choiceLabel(poll)
    const rate = parseInt(label ?? '0', 10)
    return (
      <Card key="poll" title={t('Polling rate')} className={wide ? 'col-span-2' : undefined}>
        <div className="flex items-end justify-between gap-4">
          <BigValue value={label?.replace(/\s*Hz/i, '') ?? '—'} unit="Hz" size={wide ? 30 : 26} />
          {wide && <Pulse rate={rate || 1000} width={240} />}
        </div>
        <Segmented className="mt-4" label={t('Polling rate')} options={poll.value.options.map(([l, v]) => [shortHz(l), v] as const)} value={poll.value.current}
          onChange={(c) => onEdit('polling', { ...(poll.value as Choice), current: c })} />
        <p className="hint mt-3 mb-0">{rate ? t('Reports every {ms} ms.', { ms: (1000 / rate).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') }) + ' ' : ''}{t('Higher rates report presses sooner and use a little more CPU.')}</p>
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
    const scope = perKey ? (selIdx.length === 1 ? t('{n} key', { n: selIdx.length }) : t('{n} keys', { n: selIdx.length })) : t('all keys')
    const more = extras('Performance')

    // ---- live key test
    const lk = live.last
    const liveMm = lk !== undefined ? live.depth.get(lk) ?? 0 : 0
    if (view === 'perf' && testing) {
      const kname = lk !== undefined && keys?.[lk] ? keys[lk].label : undefined
      const a = lk !== undefined && pkT ? pkT.travel[lk] : travel
      const hTest = (
        <Hero live brand={brand} label={kname ? t('Live travel · {key}', { key: kname }) : t('Live travel')} value={liveMm.toFixed(2)} unit="mm" size={76}
          sub={kname && a !== undefined ? (liveMm >= a ? t('Past its {mm} mm actuation point — the key fires', { mm: a.toFixed(2) }) : t('Fires at {mm} mm', { mm: a.toFixed(2) })) : t('Press any key on the keyboard.')} />
      )
      return [hTest, (
        <>
          <Card title={t('Key travel · live')} className="col-span-2">
            <TravelDiagram max={range?.max ?? 4} act={a ?? 1} sens={undefined} live={liveMm} />
          </Card>
          <Card title={t('How to read it')}>
            <p className="hint m-0">{t('Each key fills up as you press it and lights up once it passes its actuation point. Rapid Trigger keys keep their dot.')}</p>
            <button type="button" className="plat display mt-4 w-full rounded-full py-2.5 text-[12px] font-semibold" onClick={() => setTesting(false)}>{t('Stop test')}</button>
          </Card>
        </>
      )]
    }

    // ---- Rapid Trigger tab
    if (view === 'rt') {
      const state = rtAll ? t('On') : rtSome ? t('Mixed') : t('Off')
      const h = (
        <Hero brand={brand} label={t('Rapid Trigger · {scope}', { scope })} value={state} size={76}
          sub={rtSome && sensVal !== undefined ? t('Resets after {mm} mm of upward travel', { mm: sensUniform ? sensVal.toFixed(2) : t('mixed') }) : t('Keys reset only when they rise back past the actuation point.')} />
      )
      return [h, (
        <>
          <Card title={t('Rapid Trigger')} right={<Toggle label={t('Rapid Trigger, {scope}', { scope })} checked={rtAll} onChange={setRt} />}>
            <div className="display text-[26px] font-semibold">{state}</div>
            <p className="hint mt-1 mb-0">{perKey ? t('For the {scope} you picked.', { scope }) : pkT ? t('For every key. Pick keys on the board to set them one by one.') : t('For every key.')}</p>
            {sensRange && sensVal !== undefined && (
              <>
                <div className="mt-4 flex items-baseline justify-between"><span className="eyebrow">{t('Sensitivity')}</span><BigValue value={sensUniform ? sensVal.toFixed(2) : t('Mixed')} unit={sensUniform ? 'mm' : undefined} size={13} /></div>
                <Range className="mt-1.5" label={t('Rapid Trigger sensitivity')} min={sensRange.min} max={sensRange.max} step={sensRange.step} value={sensVal} onChange={setSens} />
                <div className="mt-1 flex justify-between text-[9.5px] text-[var(--text-4)]"><span>{t('{n} · fastest', { n: sensRange.min.toFixed(2) })}</span><span>{t('{n} · steadiest', { n: sensRange.max.toFixed(2) })}</span></div>
              </>
            )}
          </Card>
          {range && travel !== undefined && (
            <Card title={t('Key travel')}>
              <TravelDiagram max={range.max} act={travel} sens={rtSome ? sensVal : undefined} />
            </Card>
          )}
          {get('rt_adaptive') && <GenericCard title={t('Adaptive')} settings={[get('rt_adaptive')!]} onEdit={onEdit} />}
          <Card title={t('How it works')}>
            <p className="hint m-0">{t('A normal key fires and resets at one fixed point. With Rapid Trigger a key resets as soon as it rises by the sensitivity distance, and fires again as soon as it goes back down by the same amount, so quick taps and strafes register instantly.')}</p>
            <p className="hint mt-3 mb-0">{t('Lower sensitivity reacts faster but can misfire if you rest your fingers on the keys.')}</p>
          </Card>
        </>
      )]
    }

    // ---- Performance tab
    const pollLabel = choiceLabel(get('polling'))
    const h = range && travel !== undefined ? (
      <Hero brand={brand} label={t('Actuation · {scope}', { scope })} value={uniform ? travel.toFixed(2) : t('Mixed')} unit={uniform ? 'mm' : undefined} size={76}
        sub={t('Magnetic switches · {min} – {max} mm', { min: range.min.toFixed(2), max: range.max.toFixed(2) })} />
    ) : (
      <Hero brand={brand} label={t('Polling rate')} value={pollLabel?.replace(/\s*Hz/i, '') ?? '—'} unit={pollLabel ? 'Hz' : undefined} size={76} sub={t('Wired')} />
    )
    if (!range || travel === undefined) {
      return [h, <>{pollingCard(true)}{more.length > 0 && <GenericCard title={t('More')} settings={more} onEdit={onEdit} />}</>]
    }
    const presets = PRESETS.filter(([, mm]) => mm >= range.min && mm <= range.max)
    return [h, (
      <>
        <Card title={t('Actuation point')}>
          <BigValue value={uniform ? travel.toFixed(2) : t('Mixed')} unit={uniform ? 'mm' : undefined} size={26} />
          <Range className="mt-3" label={t('Actuation, {scope}', { scope })} min={range.min} max={range.max} step={range.step} value={travel} onChange={setTravel} />
          <div className="mt-1 flex justify-between text-[9.5px] text-[var(--text-4)]"><span>{range.min.toFixed(2)}</span><span>{range.max.toFixed(2)}</span></div>
          {presets.length > 0 && (
            <>
              <div className="eyebrow mt-4 mb-2">{t('Presets')}</div>
              <Segmented label={t('Actuation presets')} options={presets.map(([, mm]) => [`${mm}`, mm] as const)} value={uniform ? presets.find(([, mm]) => Math.abs(mm - travel) < 0.005)?.[1] : undefined}
                onChange={setTravel} />
              <div className="mt-1.5 flex justify-around text-[9.5px] text-[var(--text-4)]">{presets.map(([n]) => <span key={n} className="min-w-0 truncate">{presetName(t, n)}</span>)}</div>
            </>
          )}
        </Card>
        <Card title={t('Key travel')}>
          <TravelDiagram max={range.max} act={travel} sens={rtSome ? sensVal : undefined} />
        </Card>
        {pollingCard(false)}
        {more.length > 0 && <GenericCard title={t('More')} settings={more} onEdit={onEdit} className="col-span-3" />}
      </>
    )]
  }

  function socdTab(): [React.ReactNode, React.ReactNode] {
    const v = socd!
    const used = v.entries.filter((e) => e.keys.length > 0).length
    const h = (
      <Hero brand={brand} label={t('SOCD · Snap Tap')} value={used} unit={v.mode === 'pairs' ? (used === 1 ? t('pair') : t('pairs')) : used === 1 ? t('group') : t('groups')} size={76}
        sub={t('When two opposite keys are held, only one counts, so you never stand still while strafing.')} />
    )
    return [h, (
      <SocdCard key="socd" className="col-span-3" v={v} sel={socdSel} pick={socdPicking}
        onSelect={(i) => { setSocdMsg(undefined); setSocdSel(i) }}
        onPick={(p) => { setSocdMsg(undefined); setSocdPick(p) }}
        onChange={(nv) => onEdit('socd', nv)} />
    )]
  }

  function gamepadTab(): [React.ReactNode, React.ReactNode] {
    const more = extras('Gamepad')
    const stick = (s: Setting) => /^gp_(angle|square|extreme)_/.test(s.key)
    const enabled = get('gp_enabled')?.value
    const on = enabled?.kind === 'toggle' ? enabled.on : true
    const typeEn = choiceLabel(get('gp_mode'))
    const type = typeEn ? t(typeEn) : undefined
    const status = textOf(dev, 'gp_status')
    const used = gpMap ? gpMap.values.filter((t) => t !== gpMap.none).length : 0
    const curves = (edit ?? []).filter((s) => s.value.kind === 'gamepadCurve')
    const h = (
      <Hero brand={brand} label={on ? t('Gamepad') : t('Gamepad · off')} value={type ?? (on ? t('On') : t('Off'))} size={type && type.length > 6 ? Math.max(30, Math.round(400 / type.length)) : 64}
        sub={status ? t(status) : gpMap ? (used === 1 ? t('{n} key mapped to the controller. Keys keep working as keys unless you change Key output.', { n: used }) : t('{n} keys mapped to the controller. Keys keep working as keys unless you change Key output.', { n: used })) : undefined} />
    )
    return [h, (
      <>
        <GenericCard title={t('Controller')} settings={more.filter((s) => !stick(s))} onEdit={onEdit} />
        {gpMap && <GamepadMapCard v={gpMap} sel={gpSel} onChange={(nv) => onEdit('gp_map', nv)} className="col-span-2" />}
        {curves.length > 0 && <CurveCard curves={curves} onEdit={onEdit} className="col-span-2" />}
        <GenericCard title={t('Sticks')} settings={more.filter(stick)} onEdit={onEdit} />
      </>
    )]
  }

  function settingsTab(): [React.ReactNode, React.ReactNode] {
    const more = extras('Settings')
    const model = dev.driver.model()
    const rows: [string, string | undefined][] = [
      [t('Model'), model],
      [t('Brand'), dev.driver.brand()],
      [t('Switches'), pkT ? t('Magnetic') : undefined],
      [t('Keys'), keys ? String(keys.length) : undefined],
      [t('Connection'), t('Wired')],
      [t('Firmware'), textOf(dev, 'fw')],
      [t('USB id'), dev.id],
    ]
    const h = <Hero brand={brand} label={t('Keyboard')} value={model} size={model.length > 8 ? Math.max(30, Math.round(440 / model.length)) : 64} sub={textOf(dev, 'fw') ? t('Firmware {version}', { version: textOf(dev, 'fw')! }) : undefined} />
    return [h, (
      <>
        <Card title={t('Device')}>
          <dl className="m-0">
            {rows.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-white/5 py-2 last:border-0">
                <dt className="eyebrow">{k}</dt>
                <dd className="display m-0 truncate text-[11px]">{v}</dd>
              </div>
            ))}
          </dl>
          {textOf(dev, 'unsupported') && <p className="hint mt-2 mb-0 text-[var(--warn)]">{t(textOf(dev, 'unsupported')!)}</p>}
        </Card>
        {more.length > 0 ? <GenericCard title={t('Settings')} settings={more} onEdit={onEdit} className="col-span-2" /> : (
          <Card title={t('Profiles')} className="col-span-2">
            <p className="hint m-0">{get('profile') ? t('Switch profiles with P1, P2… at the top right. Each profile keeps its own settings on the keyboard.') : t('This keyboard keeps one set of settings, stored on the keyboard itself.')}</p>
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
    const legend = code === undefined ? undefined : kcLabel(code, m.codes, m.extra) || t('None')
    const changed = origLayers ? m.layers.reduce((n, l, li) => n + l.filter((c, i) => origLayers[li]?.[i] !== undefined && origLayers[li][i] !== c).length, 0) : 0
    const h = (
      <Hero brand={brand} label={t('Keymap · layer {layer}', { layer })} value={legend ?? `${m.layers.length}`} unit={legend ? undefined : m.layers.length === 1 ? t('layer') : t('layers')}
        size={legend && legend.length > 6 ? Math.max(30, Math.round(400 / legend.length)) : 64}
        sub={code !== undefined ? t(describeKc(code, m.codes, m.extra)) : changed ? (changed === 1 ? t('{n} key remapped this session', { n: changed }) : t('{n} keys remapped this session', { n: changed })) : t('Click a key to remap it.')} />
    )
    const c = (
      <>
        <KeyPicker km={m} layer={layer} keyIndex={keySel} onPick={assign} macros={mac?.slots} className="col-span-2" />
        <KeyCard km={m} layer={layer} keyIndex={keySel} original={origLayers} onPick={assign} defaultCode={defaultCode(m)} />
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
      <Hero brand={brand} label={t('Macro · M{slot}', { slot })} value={steps.length} unit={steps.length === 1 ? t('step') : t('steps')} size={64}
        sub={<>
          {km ? (bound ? (bound === 1 ? t('On {n} key (dotted above).', { n: bound }) : t('On {n} keys (dotted above).', { n: bound })) : t('Not on a key yet. Put a macro on a key in the Keys tab.')) : t('Put a macro on a key in the Keys tab.')}
          {used !== undefined && v.maxBytes ? ' ' + t('{used} of {max} bytes used.', { used, max: v.maxBytes }) : ''}
        </>}>
        {macS?.hint && <p className="hint mt-3 mb-0">{t(macS.hint)}</p>}
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
    const scope = selIdx.length ? (selIdx.length === 1 ? t('{n} key', { n: selIdx.length }) : t('{n} keys', { n: selIdx.length })) : t('all keys')
    const used = new Set(lp.colors).size
    const h = <Hero brand={brand} label={t('Per-key lighting · live')} value={used} unit={used === 1 ? t('colour') : t('colours')} size={64}
      sub={t('Select keys on the board, then pick a colour. Nothing selected paints every key.')} />
    const c = (
      <>
        <Card title={t('Colour · {scope}', { scope })}>
          <div className="flex items-center gap-4">
            <label className="relative grid size-[112px] shrink-0 cursor-pointer place-items-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-[0_4px_10px_rgb(0_0_0/0.5)]" title={t('Pick any colour')}>
              <span className="grid size-[80px] place-items-center rounded-full bg-[#141416]">
                <span className="size-[42px] rounded-full" style={{ background: keyColor === null ? '#333' : hex(keyColor), boxShadow: keyColor === null ? undefined : `0 0 14px ${hex(keyColor)}` }} />
              </span>
              <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('Pick any colour')} value={keyColor === null ? '#ffffff' : hex(keyColor).toLowerCase()} onChange={(e) => lp.paint(selIdx, parseInt(e.target.value.slice(1), 16))} />
            </label>
            <div className="min-w-0">
              <div className="display text-[12px] font-semibold">{keyColor === null ? t('Mixed') : hex(keyColor)}</div>
              <div className="mt-3 grid w-[78px] grid-cols-3 gap-2">
                {SWATCHES.slice(0, 9).map((sw) => (
                  <button key={sw} type="button" className="swatch !size-[18px]" style={{ background: hex(sw) }} aria-label={t('Paint {scope} {colour}', { scope, colour: hex(sw) })} aria-pressed={keyColor === sw} onClick={() => lp.paint(selIdx, sw)} />
                ))}
              </div>
            </div>
          </div>
          <button type="button" className="chip mt-4 !text-[11px]" onClick={() => lp.paint(selIdx, 0)}>{t('Turn {scope} off', { scope })}</button>
        </Card>
        <Card title={t('Effects paused')} className="col-span-2">
          <p className="hint m-0">{t('While per-key colours are on, the keyboard shows only these colours: effects, colour and brightness changes wait until you switch per-key lighting off below. Brightness set on the keyboard still dims them.')}</p>
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
    const effectEn = choiceLabel(mode)
    const effect = effectEn ? t(effectEn) : '—'
    const h = <Hero brand={brand} label={t('Effect')} value={effect} size={effect.length > 6 ? Math.max(24, Math.round(380 / effect.length)) : 64} sub={power && !power.on ? t('Lights are off') : t('Lights on')} />
    const c = (
      <>
        <Card title={t('Effect')}>
          {mode?.value.kind === 'choice' && (
            <>
              <ChoiceSelect label={t('Lighting effect')} v={mode.value} onChange={(n) => onEdit('light_mode', { ...(mode.value as Choice), current: n })} />
              <p className="hint mt-3 mb-0">{t('{n} effects on this keyboard. The list comes from the device itself.', { n: mode.value.options.length })}</p>
            </>
          )}
          {rainbow && (
            <div className="mt-4 flex items-center justify-between"><span className="text-[13px]">{t('Rainbow colours')}</span>
              <Toggle label={t('Rainbow colours')} checked={rainbow.on} onChange={(on) => onEdit('light_rainbow', { kind: 'toggle', on })} /></div>
          )}
        </Card>
        <Card title={perKey ? (selIdx.length === 1 ? t('Colour · {n} key', { n: selIdx.length }) : t('Colour · {n} keys', { n: selIdx.length })) : t('Colour')}>
          <div className="flex items-center gap-4">
            <label className="relative grid size-[112px] shrink-0 cursor-pointer place-items-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-[0_4px_10px_rgb(0_0_0/0.5)]" title={t('Pick any colour')}>
              <span className="grid size-[80px] place-items-center rounded-full bg-[#141416]">
                <span className="size-[42px] rounded-full" style={{ background: keyColor === null ? '#333' : hex(keyColor), boxShadow: keyColor === null ? undefined : `0 0 14px ${hex(keyColor)}` }} />
              </span>
              <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('Pick any colour')} value={keyColor === null ? '#ffffff' : hex(keyColor).toLowerCase()} onChange={(e) => paint(parseInt(e.target.value.slice(1), 16))} />
            </label>
            <div className="min-w-0">
              <div className="display text-[12px] font-semibold">{keyColor === null ? t('Mixed') : hex(keyColor)}</div>
              <div className="mt-3 grid w-[78px] grid-cols-3 gap-2">
                {SWATCHES.slice(0, 9).map((c) => (
                  <button key={c} type="button" className="swatch !size-[18px]" style={{ background: hex(c) }} aria-label={perKey ? t('Selected keys colour {colour}', { colour: hex(c) }) : t('Lighting colour {colour}', { colour: hex(c) })} aria-pressed={keyColor === c} onClick={() => paint(c)} />
                ))}
              </div>
            </div>
          </div>
          {pkC && !perKey && <p className="hint mt-3 mb-0">{t('Select keys to paint them one by one.')}</p>}
        </Card>
        <Card title={t('Lights')} right={power && <Toggle label={t('Lights on')} checked={power.on} onChange={(on) => onEdit('light_power', { kind: 'toggle', on })} />}>
          <div className="display text-[26px] font-semibold">{power && !power.on ? t('Off') : bri ? `${pctOf(bri)}%` : power ? t('On') : '—'}</div>
          {bri && <Level label={t('Brightness')} v={bri} onChange={(n) => onEdit('light_bri', { ...bri, current: n })} />}
          {speed && <Level label={t('Speed')} v={speed} onChange={(n) => onEdit('light_speed', { ...speed, current: n })} />}
        </Card>
        <LiveLightCard dev={dev} lp={lp} />
        {/* extra light zones (e.g. Lofree Hyzen: bottom strip and receiver) get a card each */}
        {[['strip_', t('Bottom light strip')], ['dongle_', t('Receiver light')]].map(([pre, title]) => {
          const zone = extras('Lighting').filter((x) => x.key.startsWith(pre))
          return zone.length ? <GenericCard key={pre} title={title} settings={zone} onEdit={onEdit} className="col-span-3 xl:col-span-1" /> : null
        })}
        {extras('Lighting').filter((x) => !LIGHT_OWN.has(x.key) && !/^(strip|dongle)_/.test(x.key)).length > 0 && (
          <GenericCard title={t('More lighting')} settings={extras('Lighting').filter((x) => !LIGHT_OWN.has(x.key) && !/^(strip|dongle)_/.test(x.key))} onEdit={onEdit} className="col-span-3" />
        )}
      </>
    )
    return [h, c]
  }

  const showBar = (interactive || testing) && boardKeys
  const copyKmLayer = () => {
    if (!km) return
    setLayerClip({ id: dev.id, n: km.keys.length, clip: copyLayer(km, layer) })
    setKmMsg(t('Copied layer {layer}', { layer }))
  }
  const pasteKmLayer = () => {
    if (!km || !layerClip) return
    const r = planLayerPaste(km, layerClip, layer)
    if (r.changed) onEdit('keymap', { ...km, layers: r.layers })
    const names = r.skipped.map((s) => km.keys[s.pos]?.label || '?')
    const list = names.slice(0, 6).join(', ') + (names.length > 6 ? '…' : '')
    const done = r.changed === 1 ? t('Pasted layer {from} onto layer {to}: {n} key changed.', { from: layerClip.layer, to: layer, n: r.changed }) : t('Pasted layer {from} onto layer {to}: {n} keys changed.', { from: layerClip.layer, to: layer, n: r.changed })
    setKmMsg(r.skipped.length ? `${done} ${t('Skipped (locked, raw or transparent on layer 0): {keys}', { keys: list })}` : done)
  }
  // keys tab: one key at a time; a click (or drag) picks the newly added key
  const pickKey = (next: Set<number>) => {
    const k = [...next].find((i) => i !== keySel)
    setKSel(k !== undefined && locked(k) ? undefined : k)
  }
  const pickAdv = (next: Set<number>) => setAdvPick([...next].find((i) => i !== advSel))
  const pickGp = (next: Set<number>) => setGpPick([...next].find((i) => i !== gpSel))
  const viewSwitch = km && adv && (
    <Segmented label={t('Keys view')} className="shrink-0 [&_button]:!px-3.5 [&_button]:!py-1.5 [&_button]:!text-[11px]" value={keysView}
      options={[[t('Remap'), 'remap'], ['Mod-Tap · Toggle · DKS', 'advanced']] as const} onChange={setKeysView} />
  )
  return (
    <>
      <main className="scroll-thin relative z-10 flex h-[calc(100%-76px)] flex-col items-center overflow-y-auto px-16 pt-2 pb-[130px]">
        <div className="relative w-full" style={{ maxWidth: kbMax }}>
          <div className="pointer-events-none absolute -inset-x-20 -top-10 h-[120%] rounded-full bg-[radial-gradient(ellipse_at_center,rgb(230_232_236/0.08),transparent_65%)]" />
          {boardKeys ? (
            <KeyboardView keys={boardKeys} looks={looks} selected={onKeys ? new Set(keySel === undefined ? [] : [keySel]) : onAdv ? new Set(advSel === undefined ? [] : [advSel]) : onGamepad ? new Set(gpSel === undefined ? [] : [gpSel]) : onSocd ? socdBoardSel : interactive ? sel : new Set()}
              onSelect={onKeys ? pickKey : onAdv ? pickAdv : onGamepad ? pickGp : onSocd ? socdClick : setSel} interactive={interactive} knob={dev.driver.knob} maxWidth={kbMax}
              multi={!!multiTab && !onKeys && !onAdv && !onGamepad && !onSocd} onDouble={multiTab && !onKeys && !onAdv && !onGamepad && !onSocd ? selectSame : undefined} />
          ) : (
            <div className="grid h-64 place-items-center"><KeyboardIcon className="size-40 text-white/10" strokeWidth={0.6} /></div>
          )}
          {onKeys ? (
            <div className="mt-3 flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className={cn('min-w-0 text-[12px] text-[var(--text-3)]', kmMsg && 'text-[var(--text-2)]')} aria-live="polite">
                {kmMsg ? kmMsg : keySel !== undefined
                  ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{km!.keys[keySel].label || t('Key')}</span>{t('selected · pick what it sends below')}</>
                  : t('click a key to remap it · dot = remapped this session · faded = from the layer below')}
              </span>
              {viewSwitch}
              {km!.layers.length > 1 && (
                <span className="flex shrink-0 gap-1.5">
                  <button type="button" className="chip !px-3 !py-1.5 !text-[11px]" onClick={copyKmLayer} title={t('Copy every key of layer {layer}', { layer })}>{t('Copy layer')}</button>
                  <button type="button" className="chip !px-3 !py-1.5 !text-[11px]" disabled={!layerClip} onClick={pasteKmLayer}
                    title={layerClip ? t('Put the keys copied from layer {from} on layer {to}. Locked keys and keys only valid where they are stay as they are.', { from: layerClip.layer, to: layer }) : t('Copy a layer first')}>
                    {layerClip ? t('Paste layer {n}', { n: layerClip.layer }) : t('Paste layer')}
                  </button>
                </span>
              )}
              {km!.layers.length > 1 && (
                <span className="flex shrink-0 items-center gap-2.5">
                  <span className="eyebrow whitespace-nowrap">{t('Layer')}</span>
                  {km!.layers.length <= 8 ? (
                    <Segmented label={t('Keymap layer')} className="[&_button]:!px-3.5 [&_button]:!py-1.5 [&_button]:!text-[11px]"
                      value={layer} options={km!.layers.map((_, l) => [String(l), l] as const)} onChange={setLayer} />
                  ) : (
                    <ChoiceSelect label={t('Keymap layer')} className="!h-9 !w-auto !min-w-28" v={{ kind: 'choice', options: km!.layers.map((_, l) => [t('Layer {n}', { n: l }), l]), current: layer }} onChange={setLayer} />
                  )}
                </span>
              )}
            </div>
          ) : onAdv ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className="text-[12px] text-[var(--text-3)]">
                {advSel !== undefined
                  ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{adv!.keys[advSel]?.label || t('Key')}</span>{t('selected · pick its function below')}</>
                  : t('click a key to give it an advanced function · colour = Mod-Tap / Toggle / DKS')}
              </span>
              {viewSwitch}
            </div>
          ) : onGamepad ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className="text-[12px] text-[var(--text-3)]">
                {gpSel !== undefined
                  ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{gpMap!.keys[gpSel]?.label || t('Key')}</span>{t('selected · pick what it drives below')}</>
                  : t('click a key to map it to the controller · coloured = mapped (sticks blue / purple, triggers orange, D-pad cyan, buttons green)')}
              </span>
              {gpSel !== undefined && <button type="button" className="chip display !text-[11px] font-semibold" onClick={() => setGpPick(undefined)}>{t('Done')}</button>}
            </div>
          ) : onSocd ? (
            <div className="mt-3 flex h-9 items-center justify-between gap-4">
              <span className={cn('text-[12px] text-[var(--text-3)]', socdMsg && 'text-[var(--warn)]')}>
                {socdMsg ? t(socdMsg) : (socdPicking
                  ? socd!.mode === 'pairs'
                    ? socdPicking.keys.length
                      ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{socd!.keys[socdPicking.keys[0]]?.label}</span>{t('picked · click key 2 of the pair')}</>
                      : t('SOCD · click key 1 of the pair')
                    : socd!.removable === false
                      ? t('SOCD · click keys to add them to group {n}', { n: socdPicking.entry + 1 })
                      : t('SOCD · click keys to add them to group {n}, click again to take them out', { n: socdPicking.entry + 1 })
                  : socdSel !== undefined
                    ? <><span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{socdEntryLabel(socd!, socdSel)}</span>{t('selected · coloured keys are in SOCD')}</>
                    : socd!.mode === 'pairs' ? t('coloured keys are in SOCD · click one to select its pair') : t('coloured keys are in SOCD · click one to select its group'))}
              </span>
              {(socdPicking || socdSel !== undefined) && (
                <button type="button" className="chip display !text-[11px] font-semibold" onClick={() => { setSocdPick(undefined); setSocdSel(undefined); setSocdMsg(undefined) }}>
                  {socdPicking && socd!.mode === 'pairs' ? t('Cancel') : t('Done')}
                </button>
              )}
            </div>
          ) : (
          <div className={cn('mt-3 flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2', !showBar && 'invisible')}>
            <span className="min-w-0 text-[12px] text-[var(--text-3)]" aria-live="polite">{!testing && <span className="display mr-1.5 text-[13px] font-semibold text-[var(--text)]">{selIdx.length}</span>}
              {testing ? t('live test · press keys on your keyboard') : <>{selIdx.length === 1 ? t('key selected') : t('keys selected')}
                {selValue !== undefined && <> · <span className="display text-[11.5px] text-[var(--text-2)]">{selValue}</span></>}
                {' · '}{selMsg ?? (selIdx.length === 0 ? t('editing all keys, click or drag to pick some') : multiTab ? t('Shift+click: range · Ctrl+click: toggle · double-click: same settings') : t('click or drag over keys'))}</>}</span>
            <span className="flex shrink-0 flex-wrap items-center gap-1.5">
              {multiTab && (
                <>
                  <button type="button" className="chip !px-3 !py-1.5 !text-[11px]" disabled={!canCopy} onClick={doCopy}
                    title={canCopy ? t('Copy the selected key’s settings (Ctrl+C)') : t('Select one key (or keys set up the same) to copy')}>{t('Copy')}</button>
                  <button type="button" className="chip !px-3 !py-1.5 !text-[11px]" disabled={!canPaste} onClick={doPaste}
                    title={clip && clip.kind === multiTab ? t('Paste {key}’s settings to the selected keys (Ctrl+V)', { key: keyName(clip) }) : t('Copy a key first')}>{t('Paste to selected')}</button>
                </>
              )}
              {canTest && active === 'Performance' && (
                <button type="button" className={cn('chip display whitespace-nowrap !text-[11px] font-semibold', testing && 'plat !border-transparent')} aria-pressed={testing} onClick={() => setTesting((on) => !on)}>
                  {testing ? '● ' + t('Testing') : t('Test keys')}
                </button>
              )}
              {!testing && (
                <>
                  <Segmented label={t('Select keys')} className="[&_button]:!px-2.5 [&_button]:!py-1.5 [&_button]:!text-[11px]"
                    value={regionNow} options={regions.map((n) => [regionName(t, n), n] as const)} onChange={pickRegion} />
                  <button type="button" className="chip !px-3 !py-1.5 !text-[11px]" onClick={() => setSel(invert(keys?.length ?? 0, new Set(selIdx)))}
                    title={t('Select every key that is not selected')}>{t('Invert')}</button>
                </>
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
      <Dock tabs={groups.map((g) => ({ id: g, label: tabLabel(t, g), icon: ICON[g] ?? <SlidersHorizontal className="size-4" /> }))} active={active ?? ''} onChange={setTab} />
    </>
  )
}

/** Side view of a switch: travel scale, actuation line and the Rapid Trigger band. */
function TravelDiagram({ max, act, sens, live }: { max: number; act: number; sens?: number; live?: number }) {
  const t = useT()
  const H = 150, top = 8
  const y = (mm: number) => top + (mm / max) * (H - top - 4)
  const ticks = Array.from({ length: Math.floor(max * 2) + 1 }, (_, i) => i / 2)
  return (
    <svg viewBox="0 0 240 160" className="mx-auto block h-[160px] w-auto max-w-full" role="img" aria-label={sens ? t('Actuation at {act} mm of {max} mm travel, Rapid Trigger {sens} mm', { act: act.toFixed(2), max: max.toFixed(1), sens: sens.toFixed(2) }) : t('Actuation at {act} mm of {max} mm travel', { act: act.toFixed(2), max: max.toFixed(1) })}>
      {ticks.map((tk) => (
        <g key={tk}>
          <rect x={0} y={y(tk)} width={tk % 1 === 0 ? 10 : 5} height={1} fill="rgb(255 255 255 / 0.25)" />
          {tk % 1 === 0 && <text x={14} y={y(tk) + 3} fontSize={7.5} fill="rgb(255 255 255 / 0.35)" fontFamily="Unbounded">{tk}</text>}
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
