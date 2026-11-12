import { describe, expect, it } from 'vitest'
import { buildReport } from './FeedbackButton'
import type { DeviceState } from '#/devices'

const dev = {
  id: '3554:f510',
  busy: false,
  driver: { brand: () => 'LAMZU', model: () => 'Atlantis', kind: 'mouse', family: 'CompX-B', verified: false },
  read: [
    { key: 'lod', label: 'Lift-off distance', group: 'Performance', value: { kind: 'choice', options: [['1 mm', 1], ['Code 3', 3]], current: 3 } },
    { key: 'dpi', label: 'DPI stages', group: 'DPI', value: { kind: 'dpi', stages: [400, 1600], active: 1, min: 50, max: 26000, step: 50 } },
    { key: 'fw', label: 'Firmware', group: 'Info', value: { kind: 'text', text: 'v2.17' } },
  ],
} as unknown as DeviceState

describe('feedback report', () => {
  it('holds the device, verdict, note and every raw value', () => {
    const r = buildReport(dev, 'wrong', 'brand app says 0.7 mm')
    expect(r).toContain('SOMETHING IS WRONG')
    expect(r).toContain('LAMZU Atlantis (mouse)')
    expect(r).toContain('USB id: 3554:f510')
    expect(r).toContain('tested on hardware: no')
    expect(r).toContain('brand app says 0.7 mm')
    expect(r).toContain('Lift-off distance (lod): Code 3 (raw 3)')
    expect(r).toContain('[400, 1600] active 2')
    expect(r).toContain('v2.17')
  })
})
