import { describe, expect, it } from 'vitest'
import { issueUrl } from './UnknownDevice'

describe('unknown device request', () => {
  it('pre-fills the public device request form with name and USB ids only', () => {
    const u = new URL(issueUrl({ name: 'Wooting 60HE v2', vid: 0x31e3, pid: 0x1312, collections: ['usage page FF54 usage 0001'] }))
    expect(u.origin + u.pathname).toBe('https://github.com/kuldeepsaini23/inputdeck/issues/new')
    expect(u.searchParams.get('template')).toBe('device.yml')
    expect(u.searchParams.get('ids')).toBe('31E3:1312')
    expect(u.searchParams.get('device')).toBe('Wooting 60HE v2')
  })
})
