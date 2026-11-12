// Advanced magnetic key functions: Mod-Tap, Toggle and DKS (dynamic keystroke) for one key at a time.
import type { AdvancedKey, AdvancedKeys, AdvancedMode } from '#/drivers/types'
import { known, label as kcLabel } from '#/lib/keycodes'
import { cn } from '#/lib/utils'
import { Card, ChoiceSelect, Range, Segmented } from './kit'

export const MODE_NAME: Record<AdvancedMode, string> = { mt: 'Mod-Tap', tgl: 'Toggle', dks: 'DKS' }
export const MODE_COLOR: Record<AdvancedMode, string> = { mt: '#5AA9FF', tgl: '#FFB547', dks: '#B98CFF' }
const MODE_HELP: Record<AdvancedMode, string> = {
  mt: 'Tap the key for one key, hold it for another (e.g. tap = Esc, hold = Ctrl).',
  tgl: 'Tap to latch the key down, tap again to release it. Holding works like a normal key.',
  dks: 'Up to four keys fire at different depths of one press: when you press in, bottom out, start to rise and let go.',
}

// QMK basic keycodes are the same numbers as HID usages, so the keycode names can be reused for HID keys
const HID_KEYS: [string, number][] = [['None', 0]]
for (let kc = 0x04; kc <= 0xe7; kc++) if (known(kc)) HID_KEYS.push([kcLabel(kc) || `0x${kc.toString(16)}`, kc])
const hidName = (kc: number) => (kc ? kcLabel(kc) || `0x${kc.toString(16)}` : 'None')

const HidSelect = ({ label, kc, onChange }: { label: string; kc: number; onChange: (kc: number) => void }) => (
  <label className="block">
    <span className="eyebrow mb-2 block">{label}</span>
    <ChoiceSelect label={label} v={{ kind: 'choice', options: HID_KEYS.some(([, k]) => k === kc) ? HID_KEYS : [...HID_KEYS, [hidName(kc), kc]], current: kc }} onChange={onChange} />
  </label>
)

export const entryAt = (v: AdvancedKeys, pos: number) => v.entries.find((e) => e.key === pos)

/** A fresh entry for a key switched to `mode`. */
function fresh(v: AdvancedKeys, key: number, mode: AdvancedMode): AdvancedKey {
  if (mode === 'mt') return { key, mode, hold: 0xe0, tap: 0x29, delay: v.mt?.default ?? 200 }
  if (mode === 'tgl') return { key, mode, kc: 0x04, delay: v.tgl?.default ?? 200 }
  const n = v.dks?.actions ?? 4
  // default: the first key fires at the start of the press and stays held until the key is fully released
  // (stage dot 0 plus the three "held between" bars)
  return { key, mode, actions: Array.from({ length: n }, (_, i) => ({ kc: i === 0 ? 0x04 : 0, mask: i === 0 ? 0b0101011 : 0 })) }
}

const STAGES = ['Press', 'Bottom', 'Rise', 'Release']

export function AdvancedCards({ v, pos, onChange }: { v: AdvancedKeys; pos: number | undefined; onChange: (v: AdvancedKeys) => void }) {
  const e = pos === undefined ? undefined : entryAt(v, pos)
  const blocked = pos !== undefined && v.unavailable?.includes(pos)
  const set = (next: AdvancedKey | undefined) => {
    if (pos === undefined) return
    const rest = v.entries.filter((x) => x.key !== pos)
    onChange({ ...v, entries: next ? [...rest, next] : rest })
  }
  const keyName = pos !== undefined ? v.keys[pos]?.label || `Key ${pos + 1}` : undefined

  const fnCard = (
    <Card title={keyName ? `Function · ${keyName}` : 'Function'}>
      {pos === undefined ? (
        <p className="hint m-0">Click a key on the board to give it an advanced function.</p>
      ) : blocked ? (
        <p className="hint m-0">This key can't take an advanced function (for example it's a knob or used by SOCD).</p>
      ) : (
        <>
          <Segmented label="Key function" value={e?.mode ?? 'none'}
            options={[['Normal', 'none'] as const, ...v.modes.map((m) => [MODE_NAME[m], m] as const)]}
            onChange={(m) => set(m === 'none' ? undefined : e?.mode === m ? e : fresh(v, pos, m as AdvancedMode))} />
          <p className="hint mt-3 mb-0">{e ? MODE_HELP[e.mode] : 'Works like a normal key.'}</p>
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {v.modes.map((m) => {
          const n = v.entries.filter((x) => x.mode === m).length
          return <span key={m} className="chip !text-[10.5px]"><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: MODE_COLOR[m] }} />{MODE_NAME[m]} · {n}</span>
        })}
      </div>
    </Card>
  )

  let editor: React.ReactNode
  if (!e || blocked) {
    editor = (
      <Card title="How these work" className="col-span-2">
        <dl className="m-0 grid gap-3">
          {v.modes.map((m) => (
            <div key={m} className="flex gap-3">
              <dt className="display w-[74px] shrink-0 text-[11px] font-semibold" style={{ color: MODE_COLOR[m] }}>{MODE_NAME[m]}</dt>
              <dd className="hint m-0">{MODE_HELP[m]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    )
  } else if (e.mode === 'mt') {
    const r = v.mt ?? { min: 100, max: 1000, step: 10, default: 200 }
    editor = (
      <Card title="Mod-Tap" className="col-span-2">
        <div className="grid grid-cols-2 gap-4">
          <HidSelect label="Tap sends" kc={e.tap} onChange={(tap) => set({ ...e, tap })} />
          <HidSelect label="Hold sends" kc={e.hold} onChange={(hold) => set({ ...e, hold })} />
        </div>
        <div className="mt-4 flex items-baseline justify-between"><span className="eyebrow">Hold after</span><span className="display text-[12px]">{e.delay} ms</span></div>
        <Range className="mt-1.5" label="Mod-Tap hold time" min={r.min} max={r.max} step={r.step} value={e.delay} onChange={(delay) => set({ ...e, delay })} />
      </Card>
    )
  } else if (e.mode === 'tgl') {
    const r = v.tgl ?? { min: 200, max: 1000, step: 10, default: 200 }
    editor = (
      <Card title="Toggle" className="col-span-2">
        <HidSelect label="Key to latch" kc={e.kc} onChange={(kc) => set({ ...e, kc })} />
        <div className="mt-4 flex items-baseline justify-between"><span className="eyebrow">Counts as a hold after</span><span className="display text-[12px]">{e.delay} ms</span></div>
        <Range className="mt-1.5" label="Toggle hold time" min={r.min} max={r.max} step={r.step} value={e.delay} onChange={(delay) => set({ ...e, delay })} />
      </Card>
    )
  } else {
    const points = v.dks?.points ?? 7
    const flip = (ai: number, bit: number) =>
      set({ ...e, actions: e.actions.map((a, i) => (i === ai ? { ...a, mask: a.mask ^ (1 << bit) } : a)) })
    editor = (
      <Card title="DKS · dynamic keystroke" className="col-span-2">
        <div className="grid grid-cols-[150px_1fr] items-center gap-x-4 gap-y-2.5">
          <span />
          <div className="grid text-center" style={{ gridTemplateColumns: `repeat(${points}, 1fr)` }}>
            {Array.from({ length: points }, (_, b) => <span key={b} className="eyebrow !text-[8px]">{b % 2 === 0 ? STAGES[b / 2] : ''}</span>)}
          </div>
          {e.actions.map((a, ai) => (
            <div key={ai} className="contents">
              <ChoiceSelect label={`DKS key ${ai + 1}`} className="!h-9" v={{ kind: 'choice', options: HID_KEYS, current: a.kc }}
                onChange={(kc) => set({ ...e, actions: e.actions.map((x, i) => (i === ai ? { ...x, kc } : x)) })} />
              <div className="relative grid items-center" style={{ gridTemplateColumns: `repeat(${points}, 1fr)` }}>
                <span className="absolute inset-x-[7%] top-1/2 h-px bg-white/10" />
                {Array.from({ length: points }, (_, b) => {
                  const on = (a.mask >> b) & 1
                  const stage = b % 2 === 0
                  return (
                    <button key={b} type="button" disabled={!a.kc} onClick={() => flip(ai, b)}
                      aria-pressed={!!on} aria-label={`${hidName(a.kc)} ${stage ? `fires at ${STAGES[b / 2]}` : `held between ${STAGES[(b - 1) / 2]} and ${STAGES[(b + 1) / 2]}`}`}
                      className={cn('relative z-[1] mx-auto disabled:opacity-30', stage ? 'size-4 rounded-full border' : 'h-1.5 w-full rounded-full',
                        on ? 'border-transparent' : stage ? 'border-white/25 bg-[#141416]' : 'bg-white/5')}
                      style={on ? { background: MODE_COLOR.dks, boxShadow: `0 0 8px ${MODE_COLOR.dks}` } : undefined} />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="hint mt-4 mb-0">Dots fire the key at that point of the press; bars keep it held between two points.</p>
      </Card>
    )
  }
  return <>{fnCard}{editor}</>
}

export function advancedSummary(v: AdvancedKeys, pos: number | undefined): { value: string; sub: string } {
  const e = pos === undefined ? undefined : entryAt(v, pos)
  if (pos === undefined) return { value: String(v.entries.length), sub: v.entries.length ? 'Coloured keys have an advanced function. Click one to edit it.' : 'Click a key to give it Mod-Tap, Toggle or DKS.' }
  const name = v.keys[pos]?.label || `Key ${pos + 1}`
  if (!e) return { value: name, sub: 'Normal key' }
  if (e.mode === 'mt') return { value: name, sub: `Mod-Tap · tap ${hidName(e.tap)}, hold ${hidName(e.hold)}` }
  if (e.mode === 'tgl') return { value: name, sub: `Toggle · latches ${hidName(e.kc)}` }
  return { value: name, sub: `DKS · ${e.actions.filter((a) => a.kc).map((a) => hidName(a.kc)).join(', ') || 'no keys yet'}` }
}
