import { describe, expect, it } from 'vitest'
import { AtkCombo } from './atk-combo'
import type { Driver, Setting } from './types'

const stub = (name: string, settings: Setting[], log: string[]): Driver => ({
  id: '373b:0001', family: name, kind: 'keyboard', brand: () => name, model: () => name + ' model', image: () => undefined,
  layout: () => [],
  read: async () => settings,
  write: async (s) => void log.push(`${name}:${s.key}`),
  close: async () => void log.push(`${name}:close`),
})
const t = (key: string, group = 'Settings'): Setting => ({ key, label: key, group, value: { kind: 'toggle', on: true } })

describe('ATK keyboard = VIA + ATK gamepad', () => {
  it('shows VIA settings plus the gamepad ones, and sends each write to the right protocol', async () => {
    const log: string[] = []
    const c = new AtkCombo(stub('ATK', [t('fw', 'Info'), t('gp_enabled', 'Gamepad'), t('unsupported')], log), stub('VIA', [t('keymap', 'Keys'), t('fw', 'Info')], log))
    expect((await c.read()).map((s) => s.key)).toEqual(['keymap', 'fw', 'gp_enabled'])
    await c.write(t('gp_enabled'))
    await c.write(t('keymap'))
    await c.close()
    expect(log).toEqual(['ATK:gp_enabled', 'VIA:keymap', 'VIA:close', 'ATK:close'])
    expect(c.verified).toBe(false)
    expect(c.brand()).toBe('ATK')
  })
})
