// Profile export / import / share links, for every driver. A saved profile holds only what the
// user can change (no Info texts, no profile slot, nothing that restarts the device) and only the
// data part of each value (no key layouts, ranges or option lists): importing merges that data
// into the device's own current value, checking it against that device's ranges and options.
import type { AdvancedKey, MacroStep, Setting, SocdEntry, Value } from '#/drivers/types'
import { fits, macroProblem, stepProblem } from './macros'

export const APP = 'inputdeck'
export const VERSION = 1
/** Longest share link hash we hand out; bigger profiles go in a file. */
export const MAX_LINK_CHARS = 8000
/** URL hash key of a shared profile: /d/<id>#p=... */
export const HASH_KEY = 'p'

type Kind = Value['kind']
/** The data part of a Value (always has `kind`); see saveValue. */
export type SavedValue = { kind: Kind } & Record<string, unknown>

export interface ProfileDevice {
  family: string
  brand: string
  model: string
  /** "vvvv:pppp" */
  id: string
}

export interface ProfileFile {
  app: typeof APP
  v: typeof VERSION
  device: ProfileDevice
  settings: { key: string; value: SavedValue }[]
}

/** Keys never saved or loaded: the profile slot itself is where a profile goes, not part of it. */
const SKIP_KEYS = new Set(['profile'])

/** Is this setting part of a saved profile? */
export function exportable(s: Setting): boolean {
  return s.group !== 'Info' && s.value.kind !== 'text' && !SKIP_KEYS.has(s.key) && !s.key.startsWith('screen_') && !s.confirm
}

/** The data of a value worth saving (without key layouts, ranges, option lists). */
export function saveValue(v: Value): SavedValue | null {
  switch (v.kind) {
    case 'text':
      return null
    case 'choice': {
      const label = v.options.find(([, n]) => n === v.current)?.[0]
      return label === undefined ? { kind: v.kind, current: v.current } : { kind: v.kind, current: v.current, label }
    }
    case 'number':
    case 'float':
      return { kind: v.kind, current: v.current }
    case 'toggle':
      return { kind: v.kind, on: v.on }
    case 'color':
      return { kind: v.kind, rgb: v.rgb }
    case 'dpi':
      return v.colors ? { kind: v.kind, stages: v.stages, active: v.active, colors: v.colors } : { kind: v.kind, stages: v.stages, active: v.active }
    case 'perKeyTrigger':
      return { kind: v.kind, travel: v.travel, rapid: v.rapid, sens: v.sens }
    case 'perKeyColor':
      return { kind: v.kind, colors: v.colors }
    case 'keymap':
      return { kind: v.kind, codes: v.codes, layers: v.layers }
    case 'macros':
      return { kind: v.kind, macros: v.macros }
    case 'socd':
      return v.enabled === undefined ? { kind: v.kind, mode: v.mode, entries: v.entries } : { kind: v.kind, mode: v.mode, enabled: v.enabled, entries: v.entries }
    case 'advancedKeys':
      return { kind: v.kind, entries: v.entries }
    case 'perKeyChoice':
      return { kind: v.kind, values: v.values }
    case 'gamepadCurve':
      return { kind: v.kind, points: v.points }
  }
}

export interface DeviceInfo {
  family: string
  brand(): string
  model(): string
}

/** "36a7:a863~2" -> "36a7:a863" */
export const baseId = (id: string) => id.split('~')[0]

/** A profile of everything changeable in `settings`. */
export function serialize(driver: DeviceInfo, id: string, settings: Setting[]): ProfileFile {
  const out: ProfileFile['settings'] = []
  for (const s of settings) {
    if (!exportable(s)) continue
    const value = saveValue(s.value)
    if (value) out.push({ key: s.key, value })
  }
  return { app: APP, v: VERSION, device: { family: driver.family, brand: driver.brand(), model: driver.model(), id: baseId(id) }, settings: out }
}

/** "HUAN M" -> "huan-m-inputdeck.json" */
export function fileName(model: string): string {
  const base = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || 'device'}-inputdeck.json`
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Check a parsed file / link payload; throws with a short reason when it isn't an InputDeck profile. */
export function parseProfile(x: unknown): ProfileFile {
  if (!isObj(x) || x.app !== APP) throw new Error("This isn't an InputDeck profile.")
  if (x.v !== VERSION) throw new Error('This profile was made by a newer InputDeck. Reload the page and try again.')
  const d = x.device
  if (!isObj(d) || typeof d.family !== 'string' || typeof d.model !== 'string') throw new Error("This profile doesn't say which device it is for.")
  if (!Array.isArray(x.settings) || x.settings.length > 1000) throw new Error('This profile is damaged.')
  const seen = new Set<string>()
  const settings: ProfileFile['settings'] = []
  for (const s of x.settings) {
    if (!isObj(s) || typeof s.key !== 'string' || !isObj(s.value) || typeof s.value.kind !== 'string') throw new Error('This profile is damaged.')
    if (seen.has(s.key)) continue
    seen.add(s.key)
    settings.push({ key: s.key, value: s.value as SavedValue })
  }
  return {
    app: APP,
    v: VERSION,
    device: { family: d.family, model: d.model, brand: typeof d.brand === 'string' ? d.brand : '', id: typeof d.id === 'string' ? d.id : '' },
    settings,
  }
}

/** Parse the text of a profile file. */
export function parseProfileText(text: string): ProfileFile {
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    throw new Error("This isn't an InputDeck profile.")
  }
  return parseProfile(x)
}

/** 'same': same family and model; 'model': same family, other model (allowed with a warning); 'family': refused. */
export type Match = 'same' | 'model' | 'family'

export function matchDevice(file: ProfileFile, driver: DeviceInfo, id: string): Match {
  if (file.device.family !== driver.family) return 'family'
  if (file.device.model !== driver.model() || (file.device.id && file.device.id !== baseId(id))) return 'model'
  return 'same'
}

// ------------------------------------------------------------------------------------- restore

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const int = (x: unknown): x is number => Number.isInteger(x)
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
/** clamp, then snap to the step grid starting at `lo` (no float noise) */
function snap(x: number, lo: number, hi: number, step: number): number {
  const c = clamp(x, lo, hi)
  if (!(step > 0)) return c
  const n = lo + Math.round((c - lo) / step) * step
  const digits = (String(step).split('.')[1] ?? '').length
  return clamp(Number(n.toFixed(Math.min(10, digits))), lo, hi)
}
const rgbOk = (x: unknown): x is number => int(x) && x >= 0 && x <= 0xffffff
const arr = (x: unknown, len?: number): x is unknown[] => Array.isArray(x) && (len === undefined || x.length === len)

function stepOk(s: unknown): s is MacroStep {
  if (!isObj(s)) return false
  switch (s.t) {
    case 'tap':
    case 'down':
    case 'up':
      return int(s.kc)
    case 'mouse':
      return int(s.btn) && (s.a === 'tap' || s.a === 'down' || s.a === 'up')
    case 'wheel':
      return s.dir === 1 || s.dir === -1
    case 'delay':
      return int(s.ms) && s.ms >= 0
    case 'text':
      return typeof s.text === 'string'
    default:
      return false
  }
}

/**
 * The device's value `cur` with the saved data put in, or null when the data doesn't fit this
 * device (wrong kind, unknown option, different number of keys, ...). Numbers are clamped to
 * the device's range.
 */
export function restoreValue(cur: Value, saved: SavedValue): Value | null {
  if (saved.kind !== cur.kind) return null
  const s = saved as Record<string, unknown>
  switch (cur.kind) {
    case 'text':
      return null
    case 'choice': {
      if (cur.options.some(([, n]) => n === s.current)) return { ...cur, current: s.current as number }
      // same option under another number (other firmware): match by label
      const byLabel = typeof s.label === 'string' ? cur.options.find(([l]) => l === s.label) : undefined
      return byLabel ? { ...cur, current: byLabel[1] } : null
    }
    case 'number':
      return num(s.current) ? { ...cur, current: Math.round(clamp(s.current, cur.min, cur.max)) } : null
    case 'float':
      return num(s.current) ? { ...cur, current: snap(s.current, cur.min, cur.max, cur.step) } : null
    case 'toggle':
      return typeof s.on === 'boolean' ? { ...cur, on: s.on } : null
    case 'color':
      return rgbOk(s.rgb) ? { ...cur, rgb: s.rgb } : null
    case 'dpi': {
      if (!arr(s.stages) || s.stages.length < 1 || s.stages.length > 16 || !s.stages.every(num)) return null
      const stages = (s.stages as number[]).map((d) => snap(d, cur.min, cur.max, cur.step))
      const active = int(s.active) ? clamp(s.active, 0, stages.length - 1) : Math.min(cur.active, stages.length - 1)
      const next: Value = { ...cur, stages, active }
      if (cur.colors) {
        const saved = arr(s.colors) ? s.colors : []
        next.colors = stages.map((_, i) => (rgbOk(saved[i]) ? saved[i] : (cur.colors![i] ?? cur.colors!.at(-1) ?? 0xffffff)))
      }
      return next
    }
    case 'perKeyTrigger': {
      const n = cur.keys.length
      if (!arr(s.travel, n) || !arr(s.rapid, n) || !arr(s.sens, n)) return null
      if (!s.travel.every(num) || !s.sens.every(num) || !s.rapid.every((b) => typeof b === 'boolean')) return null
      return {
        ...cur,
        travel: (s.travel as number[]).map((x) => snap(x, cur.min, cur.max, cur.step)),
        sens: (s.sens as number[]).map((x) => snap(x, cur.sensMin, cur.sensMax, cur.step)),
        rapid: [...(s.rapid as boolean[])],
      }
    }
    case 'perKeyColor':
      return arr(s.colors, cur.keys.length) && s.colors.every(rgbOk) ? { ...cur, colors: [...(s.colors as number[])] } : null
    case 'keymap': {
      if (s.codes !== cur.codes || !arr(s.layers)) return null
      const n = cur.keys.length
      const saved = s.layers as unknown[]
      if (!saved.every((l) => arr(l, n) && l.every((c) => int(c) && c >= 0 && c <= 0xffff))) return null
      // layers the file lacks stay as they are; keys the device locks keep their code
      const layers = cur.layers.map((cl, li) => {
        const sl = saved[li] as number[] | undefined
        if (!sl) return cl
        const locked = new Set(cur.locked?.[li] ?? [])
        return cl.map((c, k) => (locked.has(k) ? c : sl[k]))
      })
      return { ...cur, layers }
    }
    case 'macros': {
      if (!arr(s.macros) || s.macros.length > cur.slots || !s.macros.every((m) => arr(m) && m.every(stepOk))) return null
      const saved = s.macros as MacroStep[][]
      const macros = cur.macros.map((m, i) => saved[i] ?? m)
      if (cur.delays === false && macros.some((m) => m.some((st) => st.t === 'delay'))) return null
      if (cur.text === false && macros.some((m) => m.some((st) => st.t === 'text'))) return null
      if (!cur.mouse && macros.some((m) => m.some((st) => st.t === 'mouse' || st.t === 'wheel'))) return null
      if (cur.maxDelay !== undefined && macros.some((m) => m.some((st) => st.t === 'delay' && st.ms > cur.maxDelay!))) return null
      if (cur.format && macros.some((m) => m.some((st) => stepProblem(st, cur.format!)) || macroProblem(m, cur.format!))) return null
      const next: Value = { ...cur, macros }
      return fits(next) ? next : null
    }
    case 'socd': {
      if (s.mode !== cur.mode || !arr(s.entries)) return null
      const n = cur.keys.length
      const bad = new Set(cur.unavailable ?? [])
      const modes = new Set(cur.modes.map(([, v]) => v))
      const used = new Set<number>()
      const entries: SocdEntry[] = []
      for (const e of s.entries) {
        if (!isObj(e) || !arr(e.keys) || !int(e.mode) || !modes.has(e.mode)) return null
        const keys = e.keys as number[]
        if (cur.mode === 'pairs' && keys.length !== 2) return null
        if (!keys.every((k) => int(k) && k >= 0 && k < n && !bad.has(k) && !used.has(k))) return null
        keys.forEach((k) => used.add(k))
        const entry: SocdEntry = { keys: [...keys], mode: e.mode }
        if (cur.travel) entry.travel = num(e.travel) ? snap(e.travel, cur.travel.min, cur.travel.max, cur.travel.step) : cur.travel.default
        if (cur.rapid) entry.rapid = e.rapid === true
        entries.push(entry)
      }
      if (cur.mode === 'groups' ? entries.length !== cur.max : entries.length > cur.max) return null
      const next: Value = { ...cur, entries }
      if (cur.enabled !== undefined && typeof s.enabled === 'boolean') next.enabled = s.enabled
      return next
    }
    case 'advancedKeys': {
      if (!arr(s.entries)) return null
      const n = cur.keys.length
      const bad = new Set(cur.unavailable ?? [])
      const used = new Set<number>()
      const kc = (x: unknown) => int(x) && x >= 0 && x <= 0xff
      const entries: AdvancedKey[] = []
      for (const e of s.entries) {
        if (!isObj(e) || !int(e.key) || e.key < 0 || e.key >= n || bad.has(e.key) || used.has(e.key)) return null
        if (!cur.modes.includes(e.mode as never)) return null
        used.add(e.key)
        if (e.mode === 'mt' && cur.mt && kc(e.hold) && kc(e.tap) && num(e.delay)) {
          entries.push({ key: e.key, mode: 'mt', hold: e.hold as number, tap: e.tap as number, delay: snap(e.delay, cur.mt.min, cur.mt.max, cur.mt.step) })
        } else if (e.mode === 'tgl' && cur.tgl && kc(e.kc) && num(e.delay)) {
          entries.push({ key: e.key, mode: 'tgl', kc: e.kc as number, delay: snap(e.delay, cur.tgl.min, cur.tgl.max, cur.tgl.step) })
        } else if (e.mode === 'dks' && cur.dks && arr(e.actions) && e.actions.length <= cur.dks.actions) {
          const full = 2 ** cur.dks.points - 1
          if (!e.actions.every((a) => isObj(a) && kc(a.kc) && int(a.mask) && a.mask >= 0 && a.mask <= full)) return null
          entries.push({ key: e.key, mode: 'dks', actions: (e.actions as { kc: number; mask: number }[]).map((a) => ({ kc: a.kc, mask: a.mask })) })
        } else return null
      }
      return { ...cur, entries }
    }
    case 'perKeyChoice': {
      const ok = new Set(cur.options.map(([, v]) => v))
      return arr(s.values, cur.keys.length) && s.values.every((v) => ok.has(v as number)) ? { ...cur, values: [...(s.values as number[])] } : null
    }
    case 'gamepadCurve': {
      if (!arr(s.points, cur.points.length) || !s.points.every((p) => isObj(p) && num(p.x) && num(p.y))) return null
      let last = 0
      const points = (s.points as { x: number; y: number }[]).map((p) => {
        const x = Math.max(last, snap(p.x, 0, cur.maxX, cur.stepX))
        last = x
        return { x, y: Math.round(clamp(p.y, 0, cur.maxY)) }
      })
      return { ...cur, points }
    }
  }
}

// ---------------------------------------------------------------------------------------- plan

export type SkipReason = 'missing' | 'kind' | 'invalid' | 'locked'

export interface ImportPlan {
  /** settings that will change, in the device's order */
  changes: { key: string; label: string; value: Value }[]
  /** settings in the file that can't be used here */
  skipped: { key: string; reason: SkipReason }[]
  /** settings already set like the file */
  unchanged: number
}

const sameValue = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b)

/** What importing `file` into a device whose settings are `settings` would change. */
export function planImport(file: ProfileFile, settings: Setting[]): ImportPlan {
  const byKey = new Map(file.settings.map((s) => [s.key, s.value]))
  const plan: ImportPlan = { changes: [], skipped: [], unchanged: 0 }
  const known = new Set(settings.map((s) => s.key))
  for (const s of file.settings) if (!known.has(s.key)) plan.skipped.push({ key: s.key, reason: 'missing' })
  for (const cur of settings) {
    const saved = byKey.get(cur.key)
    if (!saved) continue
    if (!exportable(cur)) {
      plan.skipped.push({ key: cur.key, reason: 'locked' })
      continue
    }
    if (saved.kind !== cur.value.kind) {
      plan.skipped.push({ key: cur.key, reason: 'kind' })
      continue
    }
    const value = restoreValue(cur.value, saved)
    if (!value) plan.skipped.push({ key: cur.key, reason: 'invalid' })
    else if (sameValue(value, cur.value)) plan.unchanged++
    else plan.changes.push({ key: cur.key, label: cur.label, value })
  }
  return plan
}

// ---------------------------------------------------------------------------------- share links

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('This share link is damaged.')
  const b = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(t).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('This share link is damaged.')
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The profile packed for a URL hash (deflate-raw + base64url). */
export async function encodeLink(file: ProfileFile): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(file))
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))
}

/** Unpack a share link payload; throws when it is damaged or not a profile. */
export async function decodeLink(payload: string): Promise<ProfileFile> {
  let text: string
  try {
    text = new TextDecoder().decode(await pipe(fromBase64Url(payload), new DecompressionStream('deflate-raw'), 2_000_000))
  } catch {
    throw new Error('This share link is damaged.')
  }
  return parseProfileText(text)
}

/** The payload in a location hash ("#p=..."), if any. */
export function linkPayload(hash: string): string | undefined {
  const h = hash.replace(/^#/, '')
  for (const part of h.split('&')) {
    const [k, v] = part.split('=')
    if (k === HASH_KEY && v) return v
  }
  return undefined
}

/** "https://x/d/36a7-a863#p=..." for a payload, or null when it is too long for a link. */
export function shareUrl(origin: string, id: string, payload: string): string | null {
  if (payload.length > MAX_LINK_CHARS) return null
  return `${origin}/d/${baseId(id).replace(':', '-')}#${HASH_KEY}=${payload}`
}
