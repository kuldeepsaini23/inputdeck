// Key remapping on the keyboard page: the keycode picker and the selected-key card.
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Value } from '#/drivers/types'
import { KC_NO, KC_SPC, KC_TRNS, categories, describe, hexCode, known, label, search, type Keycode } from '#/lib/keycodes'
import { cn } from '#/lib/utils'
import { useT } from '#/lib/i18n'
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
  const t = useT()
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
    <Card className={className} title={sel ? t('Assign to {key} · layer {layer}', { key: keyName, layer }) : t('Assign a key')}
      right={
        <label className="recess flex h-8 w-[200px] max-w-full items-center gap-2 rounded-full px-3">
          <Search className="size-3.5 shrink-0 opacity-50" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search keys or 0x…')} aria-label={t('Search keycodes')}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-4)]" />
        </label>
      }>
      {!q.trim() && (
        <Segmented label={t('Keycode category')} className="no-scrollbar overflow-x-auto [&_button]:!px-1.5 [&_button]:!text-[10.5px]" options={cats.map((c) => [c.name, c.id] as const)} value={cat} onChange={setCat} />
      )}
      {!q.trim() && inCat.id === 'macros' && <p className="hint mt-3 mb-0">{t('Pick a macro to play it from this key. Edit macros in the Macros tab.')}</p>}
      {!q.trim() && inCat.id === 'layers' && km.layers.length > 1 && (
        <div className="mt-3 flex items-center gap-3">
          <span className="eyebrow shrink-0">{t('Target layer')}</span>
          <Segmented label={t('Target layer')} className="flex-1" options={km.layers.map((_, l) => [String(l), l] as const)} value={target} onChange={setTarget} />
        </div>
      )}
      <div className={cn('scroll-thin mt-4 grid max-h-[232px] grid-cols-6 gap-2 overflow-y-auto pr-1', !sel && 'pointer-events-none opacity-40')}
        role="radiogroup" aria-label={sel ? t('Keycode for {key}', { key: keyName }) : t('Keycodes (select a key first)')}>
        {shown.map((k) => {
          const on = k.code === cur
          return (
            <button key={k.code} type="button" role="radio" aria-checked={on} disabled={!sel} title={`${t(k.name)} · ${k.id}`} onClick={() => onPick(k.code)}
              className={cn('flex h-12 min-w-0 flex-col items-start justify-center rounded-[12px] px-2.5 text-left', on ? 'plat' : 'raised text-[var(--text-2)]')}>
              <span className="display w-full truncate text-[11.5px] font-semibold">{k.label || '∅'}</span>
              <span className={cn('w-full truncate text-[9px]', on ? 'opacity-70' : 'text-[var(--text-4)]')}>{t(k.name)}</span>
            </button>
          )
        })}
        {shown.length === 0 && <p className="hint col-span-6 m-0">{t('No key matches “{q}”. Type a QMK name (KC_A, MO(1)) or a hex code.', { q })}</p>}
      </div>
      <p className="hint mt-3 mb-0">{sel ? t('Changes save to the keyboard straight away.') : t('Click a key on the board above to pick it.')}</p>
    </Card>
  )
}

/** What the selected key does now, with quick actions. */
export function KeyCard({ km, layer, keyIndex, original, onPick, defaultCode }: {
  km: Keymap
  layer: number
  keyIndex: number | undefined
  /** codes as first read this session (for "Restore") */
  original?: number[][]
  onPick: (code: number) => void
  /** the driver's "keyboard default" keycode, when it has one (adds Reset to default) */
  defaultCode?: number
}) {
  const t = useT()
  if (keyIndex === undefined) {
    return (
      <Card title={t('Key')}>
        <div className="display text-[17px] font-semibold">{t('No key selected')}</div>
        <p className="hint mt-2 mb-0">{t('Pick a key on the board, then choose what it sends. Each layer has its own map; hold a layer key (MO, LT…) to reach it.')}</p>
        {km.layers.length > 1 && <p className="hint mt-2 mb-0">{t('▽ = transparent: the key does what the layer below says.')}</p>}
      </Card>
    )
  }
  const code = km.layers[layer][keyIndex]
  const was = original?.[layer]?.[keyIndex]
  const eff = effective(km, layer, keyIndex)
  return (
    <Card title={t('Key · layer {layer}', { layer })}>
      <div className="display truncate text-[22px] font-semibold">{label(code, km.codes, km.extra) || t('None')}</div>
      <p className="hint mt-1 mb-0">{t(describe(code, km.codes, km.extra))}</p>
      {code === KC_TRNS && layer > 0 && <p className="hint mt-1 mb-0">{t('Falls through to layer {layer}: {what}', { layer: eff.from, what: t(describe(eff.code, km.codes, km.extra)) })}</p>}
      <dl className="m-0 mt-3">
        {([[t('Keycode'), hexCode(code)], [t('On layer 0'), label(km.layers[0][keyIndex], km.codes, km.extra) || t('None')], ...(was !== undefined && was !== code ? [[t('Was'), label(was, km.codes, km.extra) || hexCode(was)]] : [])] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-white/5 py-1.5 last:border-0">
            <dt className="eyebrow">{k}</dt>
            <dd className="display m-0 text-[11px]">{v}</dd>
          </div>
        ))}
      </dl>
      {!known(code, km.codes, km.extra) && <p className="hint mt-2 mb-0">{t("We don't know this code. It stays as it is unless you pick a new one.")}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {layer > 0 && <button type="button" className="chip" aria-pressed={code === KC_TRNS} onClick={() => onPick(KC_TRNS)}>{t('Transparent')}</button>}
        <button type="button" className="chip" aria-pressed={code === KC_NO} onClick={() => onPick(KC_NO)}>{t('Disable')}</button>
        {defaultCode !== undefined && (
          <button type="button" className="chip" aria-pressed={code === defaultCode} disabled={code === defaultCode} onClick={() => onPick(defaultCode)}
            title={t(describe(defaultCode, km.codes, km.extra))}>{t('Reset to default')}</button>
        )}
        {was !== undefined && was !== code && <button type="button" className="chip" onClick={() => onPick(was)}>{t('Restore')}</button>}
      </div>
    </Card>
  )
}
