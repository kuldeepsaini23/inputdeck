// SOCD ("Snap Tap") on the keyboard's Switches tab: pairs / groups as chips, picking keys on the board.
import { Plus, X } from 'lucide-react'
import type { Socd } from '#/drivers/types'
import { cn } from '#/lib/utils'
import { BigValue, Card, Range, Segmented, Toggle } from './kit'

/** Keys being picked on the board: for entry `entry` (-1 = a new pair). */
export interface SocdPick {
  entry: number
  keys: number[]
}

/** Colour of entry i on the board and in the card. */
const COLORS = ['#4587FF', '#FF8C26', '#4DD980', '#B373FF', '#FF66BF', '#40D9E6', '#FFD140', '#FF4545']
export const socdColor = (i: number) => COLORS[i % COLORS.length]

export const socdModeLabel = (v: Socd, m: number) => v.modes.find((x) => x[1] === m)?.[0] ?? `Mode ${m}`
const keyLabel = (v: Socd, p: number) => v.keys[p]?.label || '?'

/** "A ↔ D · Last input" for pairs, "Group 2" for groups. */
export function socdEntryLabel(v: Socd, i: number): string {
  const e = v.entries[i]
  if (v.mode === 'groups') return `Group ${i + 1}`
  const names = e.keys.map((k) => keyLabel(v, k)).join(' ↔ ')
  return v.modes.length > 1 ? `${names} · ${socdModeLabel(v, e.mode)}` : names
}

/** Entry that holds key position p, or -1. */
export const socdEntryOf = (v: Socd, p: number) => v.entries.findIndex((e) => e.keys.includes(p))

/**
 * A key clicked on the board while picking. Pairs: the second key completes the pair (new or
 * re-picked). Groups: the key joins the group, or leaves it when it is already there.
 */
export function socdPickKey(v: Socd, pick: SocdPick, p: number): { value?: Socd; pick?: SocdPick; msg?: string } {
  const name = keyLabel(v, p)
  if (v.unavailable?.includes(p)) return { pick, msg: `${name} can't be used for SOCD` }
  const owner = socdEntryOf(v, p)
  if (v.mode === 'groups') {
    const entries = v.entries.map((e) => ({ ...e, keys: e.keys.slice() }))
    if (owner === pick.entry) {
      if (v.removable === false) return { pick, msg: `This firmware can't take ${name} out of SOCD again` }
      entries[owner].keys = entries[owner].keys.filter((k) => k !== p)
    } else {
      if (owner >= 0) entries[owner].keys = entries[owner].keys.filter((k) => k !== p)
      entries[pick.entry].keys = [...entries[pick.entry].keys, p].sort((a, b) => a - b)
    }
    return { value: { ...v, entries }, pick }
  }
  if (owner >= 0 && owner !== pick.entry) return { pick, msg: `${name} is already in ${socdEntryLabel(v, owner)}` }
  if (pick.keys.includes(p)) return { pick: { ...pick, keys: pick.keys.filter((k) => k !== p) } }
  const keys = [...pick.keys, p]
  if (keys.length < 2) return { pick: { ...pick, keys } }
  if (pick.entry < 0) {
    const e: Socd['entries'][number] = { keys, mode: v.modes[0]?.[1] ?? 0 }
    if (v.travel) e.travel = v.travel.default
    if (v.rapid) e.rapid = false
    return { value: { ...v, entries: [...v.entries, e] } }
  }
  return { value: { ...v, entries: v.entries.map((x, i) => (i === pick.entry ? { ...x, keys } : x)) } }
}

const modeHint = (v: Socd, m: number, keys: number[]) => {
  const [a, b] = keys.map((k) => keyLabel(v, k))
  switch (socdModeLabel(v, m)) {
    case 'Last input': return 'The key pressed last wins (Snap Tap).'
    case 'Key 1 wins': return `${a} always wins over ${b}.`
    case 'Key 2 wins': return `${b} always wins over ${a}.`
    case 'Neutral': return 'Holding both cancels them out: neither counts.'
    default: return undefined
  }
}

const removeBtn = 'raised grid size-6 shrink-0 place-items-center rounded-full text-[var(--text-3)] hover:text-[var(--text)]'

export function SocdCard({ v, sel, pick, onSelect, onPick, onChange, className }: {
  v: Socd
  /** selected pair (pairs mode) */
  sel: number | undefined
  pick: SocdPick | undefined
  onSelect: (i: number | undefined) => void
  onPick: (p: SocdPick | undefined) => void
  onChange: (v: Socd) => void
  className?: string
}) {
  const pairs = v.mode === 'pairs'
  const removable = v.removable !== false
  const e = pairs && sel !== undefined ? v.entries[sel] : undefined
  const setEntry = (i: number, patch: Partial<Socd['entries'][number]>) => onChange({ ...v, entries: v.entries.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const removePair = (i: number) => {
    onChange({ ...v, entries: v.entries.filter((_, j) => j !== i) })
    onSelect(undefined)
    onPick(undefined)
  }
  const used = pairs ? v.entries.length : v.entries.reduce((n, g) => n + g.keys.length, 0)
  return (
    <Card className={className} title="SOCD · Snap Tap"
      right={
        <span className="flex items-center gap-3">
          <span className="text-[10.5px] text-[var(--text-4)]">{pairs ? `${used} of ${v.max} pairs` : `${used} key${used === 1 ? '' : 's'} in ${v.max} groups`}</span>
          {v.enabled !== undefined && <Toggle label="SOCD on" checked={v.enabled} onChange={(on) => onChange({ ...v, enabled: on })} />}
        </span>
      }>
      <p className="hint m-0">
        When both keys are held, only one counts — great for strafing (A/D).
        {!pairs && ' Keys in the same group: the last one pressed wins.'}
        {v.enabled === false && ' SOCD is switched off right now.'}
      </p>

      {pairs ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5" role="list" aria-label="SOCD pairs">
            {v.entries.map((x, i) => (
              <span key={i} role="listitem" className="flex items-center gap-1">
                <button type="button" aria-pressed={sel === i} onClick={() => { onPick(undefined); onSelect(sel === i ? undefined : i) }}
                  className={cn('chip display flex items-center gap-1.5 !text-[11px] font-semibold whitespace-nowrap', sel === i && 'plat !border-transparent')}>
                  <span className="inline-block size-2 rounded-full" style={{ background: socdColor(i) }} />
                  {socdEntryLabel(v, i)}
                </button>
                {removable && (
                  <button type="button" className={removeBtn} aria-label={`Remove SOCD pair ${x.keys.map((k) => keyLabel(v, k)).join(' and ')}`} onClick={() => removePair(i)}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
            <button type="button" disabled={v.entries.length >= v.max && pick?.entry !== -1} aria-pressed={pick?.entry === -1}
              onClick={() => { onSelect(undefined); onPick(pick?.entry === -1 ? undefined : { entry: -1, keys: [] }) }}
              className={cn('chip flex items-center gap-1 !text-[11px] disabled:opacity-40', pick?.entry === -1 && 'plat !border-transparent')}>
              <Plus className="size-3" /> {pick?.entry === -1 ? 'Picking keys…' : 'Add pair'}
            </button>
          </div>
          {pick && (
            <p className="hint mt-3 mb-0">
              Click {pick.keys.length ? 'the second key' : 'two keys'} on the board above{pick.keys.length ? '' : ': key 1, then key 2'}.
            </p>
          )}
          {!pick && !v.entries.length && <p className="hint mt-3 mb-0">No pairs yet. Add one, then click the two keys on the board (e.g. A, then D).</p>}
          {e && sel !== undefined && !pick && (
            <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4 border-t border-white/5 pt-4">
              {v.modes.length > 1 && (
                <div className="min-w-[260px] flex-1">
                  <div className="eyebrow mb-2">When both are held</div>
                  <Segmented label="SOCD mode" className="[&_button]:!px-2.5 [&_button]:!text-[11px]" options={v.modes} value={e.mode} onChange={(m) => setEntry(sel, { mode: m })} />
                  <p className="hint mt-1.5 mb-0">{modeHint(v, e.mode, e.keys)}</p>
                </div>
              )}
              {v.travel && e.travel !== undefined && (
                <div className="w-[200px]">
                  <div className="mb-2 flex items-baseline justify-between"><span className="eyebrow">Actuation</span><BigValue value={e.travel.toFixed(2)} unit="mm" size={13} /></div>
                  <Range label="SOCD pair actuation" min={v.travel.min} max={v.travel.max} step={v.travel.step} value={e.travel}
                    onChange={(n) => setEntry(sel, { travel: Math.round(n / v.travel!.step) * v.travel!.step })} />
                </div>
              )}
              {v.rapid && (
                <div className="flex items-center gap-3">
                  <span className="text-[13px]">Rapid Trigger</span>
                  <Toggle label="SOCD pair Rapid Trigger" checked={!!e.rapid} onChange={(on) => setEntry(sel, { rapid: on })} />
                </div>
              )}
              <button type="button" className="chip !text-[11px]" onClick={() => onPick({ entry: sel, keys: [] })}>Change keys</button>
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2.5 xl:grid-cols-4">
          {v.entries.map((g, i) => {
            const on = pick?.entry === i
            return (
              <div key={i} className={cn('recess flex flex-col rounded-[14px] p-3', on && 'ring-1 ring-white/30')}>
                <div className="flex items-center justify-between">
                  <span className="eyebrow flex items-center gap-1.5"><span className="inline-block size-2 rounded-full" style={{ background: socdColor(i) }} />Group {i + 1}</span>
                  <span className="text-[10px] text-[var(--text-4)]">{g.keys.length} key{g.keys.length === 1 ? '' : 's'}</span>
                </div>
                <div className="mt-2 flex min-h-[26px] flex-1 flex-wrap content-start gap-1">
                  {g.keys.map((k) => (
                    <span key={k} className="chip flex items-center gap-1 !py-0.5 !pr-1 !text-[11px]">
                      {keyLabel(v, k)}
                      {removable && (
                        <button type="button" aria-label={`Take ${keyLabel(v, k)} out of group ${i + 1}`} className="grid size-4 place-items-center rounded-full hover:bg-white/10"
                          onClick={() => onChange({ ...v, entries: v.entries.map((x, j) => (j === i ? { ...x, keys: x.keys.filter((y) => y !== k) } : x)) })}>
                          <X className="size-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                  {!g.keys.length && <span className="hint">Empty</span>}
                </div>
                <button type="button" aria-pressed={on} onClick={() => onPick(on ? undefined : { entry: i, keys: [] })}
                  className={cn('chip mt-2.5 flex items-center justify-center gap-1 !text-[11px]', on && 'plat !border-transparent')}>
                  {on ? 'Done' : <><Plus className="size-3" /> Add to group {i + 1}</>}
                </button>
              </div>
            )
          })}
        </div>
      )}
      {!removable && <p className="hint mt-3 mb-0 text-[var(--warn)]">This firmware can't take keys out of SOCD again — use the maker's app for that.</p>}
    </Card>
  )
}
