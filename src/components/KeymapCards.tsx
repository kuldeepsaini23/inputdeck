// Key remapping on the keyboard page: the keycode picker and the selected-key card.
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Value } from '#/drivers/types'
import { KC_NO, KC_SPC, KC_TRNS, categories, describe, hexCode, known, label, search, type Keycode } from '#/lib/keycodes'
import { cn } from '#/lib/utils'
import { Card, Segmented } from './kit'

export type Keymap = Extract<Value, { kind: 'keymap' }>

/** Legend a key really shows on `layer`: transparent keys fall through to the layer below. */
export function effective(km: Keymap, layer: number, i: number): { code: number; from: number } {
  for (let l = layer; l > 0; l--) if (km.layers[l][i] !== KC_TRNS) return { code: km.layers[l][i], from: l }
  return { code: km.layers[0][i], from: 0 }
}

/** Category tabs + search + a grid of keycodes (same look as the mouse ActionPicker). */
export function KeyPicker({ km, layer, keyIndex, onPick, macros = 0, className }: {
  km: Keymap
  layer: number
  keyIndex: number | undefined
  onPick: (code: number) => void
  /** macro slots the keyboard has (adds a Macros category) */
  macros?: number
  className?: string
}) {
  const sel = keyIndex !== undefined
  const cur = sel ? km.layers[layer][keyIndex] : undefined
  const base = sel ? km.layers[0][keyIndex] : KC_SPC
  // layer-tap keys tap what the key sends on layer 0 (or Space)
  const tap = base > KC_TRNS && base < 0x100 ? base : KC_SPC
  const opts = useMemo(() => ({ extra: km.extra, cats: km.cats }), [km.extra, km.cats])
  const cats = useMemo(() => categories(km.codes, km.layers.length, tap, macros, opts), [km.codes, km.layers.length, tap, macros, opts])
  const [cat, setCat] = useState(cats[0].id)
  const [target, setTarget] = useState(Math.min(1, km.layers.length - 1))
  const [q, setQ] = useState('')
  const found = useMemo(() => search(q, km.codes, km.layers.length, tap, macros, opts).slice(0, 48), [q, km.codes, km.layers.length, tap, macros, opts])
  const inCat = cats.find((c) => c.id === cat) ?? cats[0]
  const shown: Keycode[] = q.trim() ? found : inCat.id === 'layers' ? inCat.codes.filter((k) => k.layer === target) : inCat.codes
  const keyName = sel ? km.keys[keyIndex].label || hexCode(base) : ''
  return (
    <Card className={className} title={sel ? `Assign to ${keyName} · layer ${layer}` : 'Assign a key'}
      right={
        <label className="recess flex h-8 w-[200px] items-center gap-2 rounded-full px-3">
          <Search className="size-3.5 shrink-0 opacity-50" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search keys or 0x…" aria-label="Search keycodes"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]" />
        </label>
      }>
      {!q.trim() && (
        <Segmented label="Keycode category" className="[&_button]:!px-1.5 [&_button]:!text-[10.5px]" options={cats.map((c) => [c.name, c.id] as const)} value={cat} onChange={setCat} />
      )}
      {!q.trim() && inCat.id === 'macros' && <p className="hint mt-3 mb-0">Pick a macro to play it from this key. Edit macros in the Macros tab.</p>}
      {!q.trim() && inCat.id === 'layers' && km.layers.length > 1 && (
        <div className="mt-3 flex items-center gap-3">
          <span className="eyebrow shrink-0">Target layer</span>
          <Segmented label="Target layer" className="flex-1" options={km.layers.map((_, l) => [String(l), l] as const)} value={target} onChange={setTarget} />
        </div>
      )}
      <div className={cn('scroll-thin mt-4 grid max-h-[232px] grid-cols-6 gap-2 overflow-y-auto pr-1', !sel && 'pointer-events-none opacity-40')}
        role="radiogroup" aria-label={sel ? `Keycode for ${keyName}` : 'Keycodes (select a key first)'}>
        {shown.map((k) => {
          const on = k.code === cur
          return (
            <button key={k.code} type="button" role="radio" aria-checked={on} disabled={!sel} title={`${k.name} · ${k.id}`} onClick={() => onPick(k.code)}
              className={cn('flex h-12 min-w-0 flex-col items-start justify-center rounded-[12px] px-2.5 text-left', on ? 'plat' : 'raised text-[var(--text-2)]')}>
              <span className="display w-full truncate text-[11.5px] font-semibold">{k.label || '∅'}</span>
              <span className={cn('w-full truncate text-[9px]', on ? 'opacity-70' : 'text-[var(--text-4)]')}>{k.name}</span>
            </button>
          )
        })}
        {shown.length === 0 && <p className="hint col-span-6 m-0">No key matches “{q}”. Type a QMK name (KC_A, MO(1)) or a hex code.</p>}
      </div>
      <p className="hint mt-3 mb-0">{sel ? 'Changes save to the keyboard straight away.' : 'Click a key on the board above to pick it.'}</p>
    </Card>
  )
}

/** What the selected key does now, with quick actions. */
export function KeyCard({ km, layer, keyIndex, original, onPick }: {
  km: Keymap
  layer: number
  keyIndex: number | undefined
  /** codes as first read this session (for "Restore") */
  original?: number[][]
  onPick: (code: number) => void
}) {
  if (keyIndex === undefined) {
    return (
      <Card title="Key">
        <div className="display text-[17px] font-semibold">No key selected</div>
        <p className="hint mt-2 mb-0">Pick a key on the board, then choose what it sends. Each layer has its own map; hold a layer key (MO, LT…) to reach it.</p>
        {km.layers.length > 1 && <p className="hint mt-2 mb-0">▽ = transparent: the key does what the layer below says.</p>}
      </Card>
    )
  }
  const code = km.layers[layer][keyIndex]
  const was = original?.[layer]?.[keyIndex]
  const eff = effective(km, layer, keyIndex)
  return (
    <Card title={`Key · layer ${layer}`}>
      <div className="display truncate text-[22px] font-semibold">{label(code, km.codes, km.extra) || 'None'}</div>
      <p className="hint mt-1 mb-0">{describe(code, km.codes, km.extra)}</p>
      {code === KC_TRNS && layer > 0 && <p className="hint mt-1 mb-0">Falls through to layer {eff.from}: {describe(eff.code, km.codes, km.extra)}</p>}
      <dl className="m-0 mt-3">
        {([['Keycode', hexCode(code)], ['On layer 0', label(km.layers[0][keyIndex], km.codes, km.extra) || 'None'], ...(was !== undefined && was !== code ? [['Was', label(was, km.codes, km.extra) || hexCode(was)]] : [])] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-white/5 py-1.5 last:border-0">
            <dt className="eyebrow">{k}</dt>
            <dd className="display m-0 text-[11px]">{v}</dd>
          </div>
        ))}
      </dl>
      {!known(code, km.codes, km.extra) && <p className="hint mt-2 mb-0">We don't know this code. It stays as it is unless you pick a new one.</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {layer > 0 && <button type="button" className="chip" aria-pressed={code === KC_TRNS} onClick={() => onPick(KC_TRNS)}>Transparent</button>}
        <button type="button" className="chip" aria-pressed={code === KC_NO} onClick={() => onPick(KC_NO)}>Disable</button>
        {was !== undefined && was !== code && <button type="button" className="chip" onClick={() => onPick(was)}>Restore</button>}
      </div>
    </Card>
  )
}
