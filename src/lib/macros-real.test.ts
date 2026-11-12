// A real WLMouse HUAN M stored and read back exactly these bytes for "tap A" (slot 4, then deleted).
import { describe, expect, it } from 'vitest'
import { decodeMacro, encodeMacro } from './macros'

describe('WLMouse macro bytes match the real mouse', () => {
  it('"tap A" round-trips as 02 04 03 04', () => {
    const real = [0x02, 0x04, 0x03, 0x04]
    const steps = decodeMacro(real, 'wlmouse')
    expect(encodeMacro(steps, 'wlmouse')).toEqual(real)
    expect(JSON.stringify(steps)).toMatch(/"kc":4/)
  })
})
