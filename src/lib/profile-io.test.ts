import { describe, expect, it } from 'vitest'
import type { KeyCap, Setting, Value } from '#/drivers/types'
import {
  MAX_LINK_CHARS,
  decodeLink,
  encodeLink,
  exportable,
  fileName,
  linkPayload,
  matchDevice,
  parseProfile,
  parseProfileText,
  planImport,
  restoreValue,
  saveValue,
  serialize,
  shareUrl,
  type ProfileFile,
} from './profile-io'

const keys: KeyCap[] = [0, 1, 2].map((i) => ({ index: i, label: String(i), x: i, y: 0, w: 1, h: 1 }))
const set = (key: string, value: Value, group = 'Performance', extra: Partial<Setting> = {}): Setting => ({ key, label: key, group, value, ...extra })

const settings: Setting[] = [
  set('fw', { kind: 'text', text: '1.0' }, 'Info'),
  set('profile', { kind: 'choice', options: [['1', 0], ['2', 1]], current: 0 }),
  set('polling', { kind: 'choice', options: [['1000 Hz', 1], ['4000 Hz', 4]], current: 1 }),
  set('lod', { kind: 'number', min: 1, max: 2, current: 1, unit: 'mm' }),
  set('debounce', { kind: 'float', min: 0, max: 5, step: 0.5, current: 1, unit: 'ms' }),
  set('motion_sync', { kind: 'toggle', on: false }),
  set('led', { kind: 'color', rgb: 0xff0000 }),
  set('dpi', { kind: 'dpi', stages: [400, 800], active: 0, min: 100, max: 26000, step: 50, colors: [1, 2] }),
  set('mode', { kind: 'choice', options: [['HID', 0], ['Xbox', 1]], current: 0 }, 'Gamepad', { confirm: 'restarts' }),
  set('keymap', { kind: 'keymap', keys, layers: [[4, 5, 6], [7, 8, 9]], codes: 'qmk-v2', locked: [[], [2]] }),
  set('pkc', { kind: 'perKeyColor', keys, colors: [0, 0, 0] }),
]

const drv = { family: 'Test family', brand: () => 'ACME', model: () => 'Rocket X' }

describe('export', () => {
  it('saves only changeable settings, data only', () => {
    const f = serialize(drv, '1234:abcd~2', settings)
    expect(f.app).toBe('inputdeck')
    expect(f.v).toBe(1)
    expect(f.device).toEqual({ family: 'Test family', brand: 'ACME', model: 'Rocket X', id: '1234:abcd' })
    expect(f.settings.map((s) => s.key)).toEqual(['polling', 'lod', 'debounce', 'motion_sync', 'led', 'dpi', 'keymap', 'pkc'])
    expect(f.settings.find((s) => s.key === 'polling')!.value).toEqual({ kind: 'choice', current: 1, label: '1000 Hz' })
    expect(f.settings.find((s) => s.key === 'keymap')!.value).toEqual({ kind: 'keymap', codes: 'qmk-v2', layers: [[4, 5, 6], [7, 8, 9]] })
    expect(exportable(set('screen_effect', { kind: 'toggle', on: true }))).toBe(false)
  })

  it('names the file after the model', () => {
    expect(fileName('HUAN M 8K')).toBe('huan-m-8k-inputdeck.json')
    expect(fileName('  ')).toBe('device-inputdeck.json')
  })
})

describe('parse', () => {
  it('round-trips through JSON', () => {
    const f = serialize(drv, '1234:abcd', settings)
    expect(parseProfileText(JSON.stringify(f))).toEqual(f)
  })

  it('refuses things that are not profiles', () => {
    expect(() => parseProfileText('nope')).toThrow(/isn't an InputDeck profile/)
    expect(() => parseProfile({ app: 'other' })).toThrow(/isn't/)
    expect(() => parseProfile({ app: 'inputdeck', v: 2 })).toThrow(/newer/)
    expect(() => parseProfile({ app: 'inputdeck', v: 1, device: {} })).toThrow(/which device/)
    expect(() => parseProfile({ app: 'inputdeck', v: 1, device: { family: 'a', model: 'b' }, settings: [{ key: 1 }] })).toThrow(/damaged/)
  })

  it('compares devices', () => {
    const f = serialize(drv, '1234:abcd', settings)
    expect(matchDevice(f, drv, '1234:abcd')).toBe('same')
    expect(matchDevice(f, { ...drv, model: () => 'Rocket Y' }, '1234:abce')).toBe('model')
    expect(matchDevice(f, { ...drv, family: 'Other' }, '1234:abcd')).toBe('family')
  })
})

describe('restoreValue', () => {
  const v = (k: string) => settings.find((s) => s.key === k)!.value
  it('clamps numbers and snaps floats to the step', () => {
    expect(restoreValue(v('lod'), { kind: 'number', current: 9 })).toMatchObject({ current: 2 })
    expect(restoreValue(v('debounce'), { kind: 'float', current: 1.3 })).toMatchObject({ current: 1.5 })
    expect(restoreValue(v('debounce'), { kind: 'float', current: -3 })).toMatchObject({ current: 0 })
    expect(restoreValue(v('lod'), { kind: 'number', current: 'x' })).toBeNull()
  })

  it('uses a choice only when the option exists (by value, then by label)', () => {
    expect(restoreValue(v('polling'), { kind: 'choice', current: 4 })).toMatchObject({ current: 4 })
    expect(restoreValue(v('polling'), { kind: 'choice', current: 8 })).toBeNull()
    expect(restoreValue(v('polling'), { kind: 'choice', current: 9, label: '4000 Hz' })).toMatchObject({ current: 4 })
  })

  it('refuses another kind', () => {
    expect(restoreValue(v('lod'), { kind: 'toggle', on: true })).toBeNull()
  })

  it('fits DPI stages to the range and keeps colours per stage', () => {
    const r = restoreValue(v('dpi'), { kind: 'dpi', stages: [30, 1625, 99999], active: 7 }) as Extract<Value, { kind: 'dpi' }>
    expect(r.stages).toEqual([100, 1650, 26000])
    expect(r.active).toBe(2)
    expect(r.colors).toEqual([1, 2, 2])
  })

  it('keeps locked keymap keys and missing layers; refuses another key count or numbering', () => {
    const r = restoreValue(v('keymap'), { kind: 'keymap', codes: 'qmk-v2', layers: [[1, 2, 3], [10, 11, 12]] }) as Extract<Value, { kind: 'keymap' }>
    expect(r.layers).toEqual([[1, 2, 3], [10, 11, 9]])
    const one = restoreValue(v('keymap'), { kind: 'keymap', codes: 'qmk-v2', layers: [[1, 2, 3]] }) as Extract<Value, { kind: 'keymap' }>
    expect(one.layers).toEqual([[1, 2, 3], [7, 8, 9]])
    expect(restoreValue(v('keymap'), { kind: 'keymap', codes: 'qmk-v2', layers: [[1, 2]] })).toBeNull()
    expect(restoreValue(v('keymap'), { kind: 'keymap', codes: 'qmk-v1', layers: [[1, 2, 3]] })).toBeNull()
  })

  it('checks per-key lengths, SOCD keys, macros', () => {
    expect(restoreValue(v('pkc'), { kind: 'perKeyColor', colors: [1, 2] })).toBeNull()
    expect(restoreValue(v('pkc'), { kind: 'perKeyColor', colors: [1, 2, 3] })).toMatchObject({ colors: [1, 2, 3] })
    const socd: Value = { kind: 'socd', mode: 'pairs', keys, max: 1, modes: [['Last', 1]], unavailable: [2], entries: [] }
    expect(restoreValue(socd, { kind: 'socd', mode: 'pairs', entries: [{ keys: [0, 1], mode: 1 }] })).toMatchObject({ entries: [{ keys: [0, 1], mode: 1 }] })
    expect(restoreValue(socd, { kind: 'socd', mode: 'pairs', entries: [{ keys: [0, 2], mode: 1 }] })).toBeNull()
    expect(restoreValue(socd, { kind: 'socd', mode: 'pairs', entries: [{ keys: [0, 1], mode: 1 }, { keys: [0, 1], mode: 1 }] })).toBeNull()
    const macros: Value = { kind: 'macros', slots: 2, format: 'qmk', macros: [[], []] }
    expect(restoreValue(macros, { kind: 'macros', macros: [[{ t: 'tap', kc: 4 }]] })).toMatchObject({ macros: [[{ t: 'tap', kc: 4 }], []] })
    expect(restoreValue(macros, { kind: 'macros', macros: [[{ t: 'mouse', a: 'tap', btn: 1 }]] })).toBeNull()
    expect(restoreValue(macros, { kind: 'macros', macros: [[], [], []] })).toBeNull()
  })

  it('saveValue -> restoreValue gives the same value back', () => {
    for (const s of settings) {
      const saved = saveValue(s.value)
      if (saved) expect(restoreValue(s.value, saved)).toEqual(s.value)
    }
  })
})

describe('planImport', () => {
  it('lists changes, unchanged and skipped settings', () => {
    const f: ProfileFile = {
      app: 'inputdeck', v: 1, device: { family: 'Test family', brand: '', model: 'Rocket X', id: '' },
      settings: [
        { key: 'lod', value: { kind: 'number', current: 2 } },
        { key: 'motion_sync', value: { kind: 'toggle', on: false } },
        { key: 'polling', value: { kind: 'choice', current: 99 } },
        { key: 'led', value: { kind: 'toggle', on: true } },
        { key: 'gone', value: { kind: 'toggle', on: true } },
        { key: 'profile', value: { kind: 'choice', current: 1 } },
        { key: 'mode', value: { kind: 'choice', current: 1 } },
      ],
    }
    const p = planImport(f, settings)
    expect(p.changes.map((c) => [c.key, c.value])).toEqual([['lod', { kind: 'number', min: 1, max: 2, current: 2, unit: 'mm' }]])
    expect(p.unchanged).toBe(1)
    expect(p.skipped).toEqual([
      { key: 'gone', reason: 'missing' },
      { key: 'profile', reason: 'locked' },
      { key: 'polling', reason: 'invalid' },
      { key: 'led', reason: 'kind' },
      { key: 'mode', reason: 'locked' },
    ])
  })
})

describe('share links', () => {
  it('round-trips through the URL hash', async () => {
    const f = serialize(drv, '1234:abcd', settings)
    const payload = await encodeLink(f)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    const url = shareUrl('https://x.dev', '1234:abcd~2', payload)!
    expect(url.startsWith('https://x.dev/d/1234-abcd#p=')).toBe(true)
    const back = await decodeLink(linkPayload(new URL(url).hash)!)
    expect(back).toEqual(f)
  })

  it('refuses damaged links and long payloads', async () => {
    await expect(decodeLink('!!!')).rejects.toThrow(/damaged/)
    await expect(decodeLink('AAAA')).rejects.toThrow(/damaged/)
    expect(shareUrl('https://x', '1:2', 'a'.repeat(MAX_LINK_CHARS + 1))).toBeNull()
    expect(linkPayload('#x=1')).toBeUndefined()
    expect(linkPayload('')).toBeUndefined()
  })
})
