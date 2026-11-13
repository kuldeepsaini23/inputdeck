import { describe, expect, it } from 'vitest'
import { launchSteps, typeSteps, untypable } from './launch-macro'
import { encodeMacro, decodeMacro } from './macros'

describe('open-an-app macro', () => {
  it('presses Win+R, waits, types, presses Enter', () => {
    expect(launchSteps('calc')).toEqual([
      { t: 'down', kc: 0xe3 }, { t: 'tap', kc: 0x15 }, { t: 'up', kc: 0xe3 }, { t: 'delay', ms: 400 },
      { t: 'tap', kc: 0x06 }, { t: 'tap', kc: 0x04 }, { t: 'tap', kc: 0x0f }, { t: 'tap', kc: 0x06 },
      { t: 'delay', ms: 50 }, { t: 'tap', kc: 0x28 },
    ])
  })
  it('holds Shift for capitals and symbols (US layout)', () => {
    expect(typeSteps('C:')).toEqual([
      { t: 'down', kc: 0xe1 }, { t: 'tap', kc: 0x06 }, { t: 'up', kc: 0xe1 },
      { t: 'down', kc: 0xe1 }, { t: 'tap', kc: 0x33 }, { t: 'up', kc: 0xe1 },
    ])
    expect(typeSteps('\\ ')).toEqual([{ t: 'tap', kc: 0x31 }, { t: 'tap', kc: 0x2c }])
  })
  it('refuses empty targets and characters a macro can not type', () => {
    expect(() => launchSteps('  ')).toThrow()
    expect(untypable('C:\\Program Files\\App\\app.exe')).toBeUndefined()
    expect(untypable('café')).toBe('é')
  })
  it('round-trips through the mouse macro formats', () => {
    for (const f of ['wlmouse', 'pulsar'] as const) {
      const steps = launchSteps('https://example.com')
      const back = decodeMacro(encodeMacro(steps, f), f)
      expect(back.filter((s) => s.t !== 'delay').length).toBeGreaterThan(10)
    }
  })
})
