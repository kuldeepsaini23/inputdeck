// Pure helpers behind the keyboard board's multi-key selection, copy / paste of per-key settings
// and keymap layer copy / paste. Components stay thin; everything here is unit-tested.
import type { KeyCap, Value } from '#/drivers/types'
import { KC_TRNS } from './keycodes'

type PerKeyTrigger = Extract<Value, { kind: 'perKeyTrigger' }>
type Keymap = Extract<Value, { kind: 'keymap' }>

// ---------------------------------------------------------------------------------------------
// regions (quick-select chips), picked by key legend so they work on every layout

export const REGIONS = ['All', 'WASD', 'Letters', 'Number row', 'Arrows', 'Mods', 'None'] as const
export type Region = (typeof REGIONS)[number]

const norm = (l: string) => l.trim().replace(/\s+/g, ' ')
const MATCH: Record<Region, (label: string) => boolean> = {
  All: () => true,
  WASD: (l) => ['W', 'A', 'S', 'D'].includes(norm(l).toUpperCase()),
  Letters: (l) => /^[A-Z]$/i.test(norm(l)),
  // "1", or a two-legend cap like "1 !" / "1!"
  'Number row': (l) => /^[0-9](?:$|\s|[!@#$%^&*()])/.test(norm(l)),
  Arrows: (l) => /^(?:up|down|left|right)(?: arrow)?$|^[↑↓←→]$/i.test(norm(l)),
  Mods: (l) => /^(?:l|r|left |right )?(?:shift|shft|ctrl|control|alt|opt|option|win|gui|cmd|command|super|meta)$|^[⇧⌃⌥⌘]$/i.test(norm(l)),
  None: () => false,
}

/** Positions (in `keys`) whose legend belongs to `region`. */
export function regionKeys(keys: readonly KeyCap[], region: Region): number[] {
  const f = MATCH[region]
  const out: number[] = []
  keys.forEach((k, i) => f(k.label) && out.push(i))
  return out
}

/** Regions that exist on this layout (All / None always; the others only when they match at least one key). */
export function availableRegions(keys: readonly KeyCap[]): Region[] {
  return REGIONS.filter((r) => r === 'All' || r === 'None' || regionKeys(keys, r).length > 0)
}

/** The region the selection is exactly, if any (first match in REGIONS order). */
export function regionOf(keys: readonly KeyCap[], sel: ReadonlySet<number>, regions: readonly Region[] = REGIONS): Region | undefined {
  const n = [...sel].filter((i) => i < keys.length).length
  return regions.find((r) => {
    const want = regionKeys(keys, r)
    if (!want.length && r !== 'None') return false
    return want.length === n && want.every((i) => sel.has(i))
  })
}

/** Every key not in `sel`. */
export function invert(n: number, sel: ReadonlySet<number>): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < n; i++) if (!sel.has(i)) out.add(i)
  return out
}

// ---------------------------------------------------------------------------------------------
// click / shift-click / double-click

/** Keys inside the box spanned by keys `a` and `b` (centre inside the box), like a range in a list. */
export function rangeBetween(keys: readonly KeyCap[], a: number, b: number): number[] {
  const ka = keys[a], kb = keys[b]
  if (!ka || !kb) return kb ? [b] : []
  const x0 = Math.min(ka.x, kb.x), x1 = Math.max(ka.x + ka.w, kb.x + kb.w)
  const y0 = Math.min(ka.y, kb.y), y1 = Math.max(ka.y + ka.h, kb.y + kb.h)
  const out: number[] = []
  keys.forEach((k, i) => {
    const cx = k.x + k.w / 2, cy = k.y + k.h / 2
    if (cx > x0 && cx < x1 && cy > y0 && cy < y1) out.push(i)
  })
  return out
}

export interface ClickMods {
  /** Shift: add the range from the anchor */
  shift?: boolean
  /** Ctrl / Cmd: toggle just this key */
  toggle?: boolean
}

/**
 * The selection after clicking key `i` (or empty space when `i` < 0).
 * Plain and Ctrl/Cmd clicks toggle one key; Shift adds every key between the anchor and `i`.
 * Returns the new selection and the new anchor.
 */
export function clickSelect(keys: readonly KeyCap[], sel: ReadonlySet<number>, i: number, anchor: number | undefined, mods: ClickMods = {}): { sel: Set<number>; anchor: number | undefined } {
  const next = new Set(sel)
  if (i < 0) {
    // empty space: a plain click clears, a modified one keeps what is there
    if (!mods.shift && !mods.toggle) next.clear()
    return { sel: next, anchor: mods.shift || mods.toggle ? anchor : undefined }
  }
  if (mods.shift && anchor !== undefined && anchor < keys.length) {
    for (const k of rangeBetween(keys, anchor, i)) next.add(k)
    return { sel: next, anchor }
  }
  if (next.has(i)) next.delete(i)
  else next.add(i)
  return { sel: next, anchor: i }
}

// ---------------------------------------------------------------------------------------------
// same configuration

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** Do keys `a` and `b` trigger the same (actuation, Rapid Trigger on/off, and sensitivity when it is on)? */
export function sameTrigger(pk: PerKeyTrigger, a: number, b: number): boolean {
  if (!near(pk.travel[a], pk.travel[b]) || pk.rapid[a] !== pk.rapid[b]) return false
  return !pk.rapid[a] || near(pk.sens[a], pk.sens[b])
}

/** Every key configured like key `i` (including `i`). */
export function sameAs(n: number, i: number, eq: (a: number, b: number) => boolean): number[] {
  const out: number[] = []
  for (let k = 0; k < n; k++) if (k === i || eq(i, k)) out.push(k)
  return out
}

/** Keys whose trigger settings match key `i`. */
export const sameTriggerKeys = (pk: PerKeyTrigger, i: number) => sameAs(pk.travel.length, i, (a, b) => sameTrigger(pk, a, b))
/** Keys whose Rapid Trigger matches key `i` (on/off, and sensitivity when on); actuation is ignored. */
export const sameRtKeys = (pk: PerKeyTrigger, i: number) =>
  sameAs(pk.rapid.length, i, (a, b) => pk.rapid[a] === pk.rapid[b] && (!pk.rapid[a] || near(pk.sens[a], pk.sens[b])))
/** Keys with the same colour as key `i`. */
export const sameColorKeys = (colors: readonly number[], i: number) => sameAs(colors.length, i, (a, b) => colors[a] === colors[b])

/** The one value every key in `idx` has, 'mixed' when they differ, undefined for no keys. */
export function common<T>(idx: readonly number[], at: (i: number) => T, eq: (a: T, b: T) => boolean = Object.is): T | 'mixed' | undefined {
  if (!idx.length) return undefined
  const first = at(idx[0])
  return idx.every((i) => eq(at(i), first)) ? first : 'mixed'
}

// ---------------------------------------------------------------------------------------------
// copy / paste per-key settings

export type KeyClip =
  | { kind: 'trigger'; label: string; travel: number; rapid: boolean; sens: number }
  | { kind: 'color'; label: string; rgb: number }

export const copyTrigger = (pk: PerKeyTrigger, i: number): Extract<KeyClip, { kind: 'trigger' }> => ({ kind: 'trigger', label: pk.keys[i]?.label ?? '', travel: pk.travel[i], rapid: pk.rapid[i], sens: pk.sens[i] })
export const copyColor = (keys: readonly KeyCap[] | undefined, colors: readonly number[], i: number): Extract<KeyClip, { kind: 'color' }> => ({ kind: 'color', label: keys?.[i]?.label ?? '', rgb: colors[i] })

const fit = (n: number, min: number, max: number, step: number) => {
  const s = step > 0 ? Math.round(n / step) * step : n
  return Math.min(max, Math.max(min, +s.toFixed(6)))
}

/** The per-key trigger value with the copied settings on every key in `idx` (clamped to this board's ranges). */
export function pasteTrigger(pk: PerKeyTrigger, idx: readonly number[], clip: Extract<KeyClip, { kind: 'trigger' }>): PerKeyTrigger {
  const travel = pk.travel.slice(), rapid = pk.rapid.slice(), sens = pk.sens.slice()
  const tv = fit(clip.travel, pk.min, pk.max, pk.step)
  const sv = fit(clip.sens, pk.sensMin, pk.sensMax, pk.step)
  for (const i of idx) {
    if (i < 0 || i >= travel.length) continue
    travel[i] = tv
    rapid[i] = clip.rapid
    sens[i] = sv
  }
  return { ...pk, travel, rapid, sens }
}

/** Colours with `rgb` on every key in `idx`. */
export function pasteColor(colors: readonly number[], idx: readonly number[], rgb: number): number[] {
  const out = colors.slice()
  for (const i of idx) if (i >= 0 && i < out.length) out[i] = rgb
  return out
}

// ---------------------------------------------------------------------------------------------
// keymap: copy / paste a layer, reset a key

export type SkipReason = 'locked' | 'source-locked' | 'slot-bound' | 'transparent'

/** Extra keycodes that only mean something at the very key they were read from (raw entries kept as is). */
export function slotBoundCodes(km: Keymap): Set<number> {
  const out = new Set<number>()
  for (const c of km.extra ?? []) if (c.hidden && c.id === 'kept') for (const k of c.codes) out.add(k.code)
  return out
}

/** The keyboard's "default" keycode for a key, when the driver offers one. */
export function defaultCode(km: Keymap): number | undefined {
  return km.extra?.find((c) => c.id === 'default' && !c.hidden)?.codes[0]?.code
}

export interface LayerClip {
  /** where it was copied from */
  layer: number
  codes: number[]
  /** positions locked on the source layer (system keys: never copied) */
  locked: number[]
}

export const copyLayer = (km: Keymap, layer: number): LayerClip => ({ layer, codes: km.layers[layer].slice(), locked: (km.locked?.[layer] ?? []).slice() })

/**
 * Paste a copied layer onto layer `to`. Locked keys (on either side) are left alone, raw slot-bound
 * codes are not moved to another key or layer, and transparent is not put on the base layer.
 * Returns the new layers, how many keys changed and the keys skipped (that would have changed).
 */
export function planLayerPaste(km: Keymap, clip: LayerClip, to: number): { layers: number[][]; changed: number; skipped: { pos: number; reason: SkipReason }[] } {
  const bound = slotBoundCodes(km)
  const dstLocked = new Set(km.locked?.[to] ?? [])
  const srcLocked = new Set(clip.locked)
  const cur = km.layers[to]
  const next = cur.slice()
  const skipped: { pos: number; reason: SkipReason }[] = []
  let changed = 0
  const n = Math.min(cur.length, clip.codes.length)
  for (let i = 0; i < n; i++) {
    const code = clip.codes[i]
    if (code === cur[i]) continue
    let reason: SkipReason | undefined
    if (dstLocked.has(i)) reason = 'locked'
    else if (srcLocked.has(i)) reason = 'source-locked'
    else if (bound.has(code) && clip.layer !== to) reason = 'slot-bound'
    else if (code === KC_TRNS && to === 0) reason = 'transparent'
    if (reason) {
      skipped.push({ pos: i, reason })
      continue
    }
    next[i] = code
    changed++
  }
  return { layers: km.layers.map((l, li) => (li === to ? next : l)), changed, skipped }
}
