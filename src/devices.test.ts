import { describe, expect, it } from 'vitest'
import { pendingChanges, unitIdFor, unitNumber, withRead, type DeviceState } from './devices'
import type { Driver, Setting } from './drivers/types'

const iface = (pid: number, usagePage: number, reportId = 0) =>
  ({
    vendorId: 0x36a7,
    productId: pid,
    collections: [{ usagePage, usage: 1, inputReports: [{ reportId }], outputReports: [], featureReports: [{ reportId }] }],
  }) as unknown as HIDDevice

describe('unitIdFor: one id per physical unit', () => {
  it('first unit of a model gets the plain id', () => {
    expect(unitIdFor(iface(0xa863, 0xff01), new Map())).toBe('36a7:a863')
  })

  it('another interface of a unit we already drive is skipped', () => {
    const a = iface(0xa863, 0xff01)
    expect(unitIdFor(iface(0xa863, 0x0001), new Map([[a, '36a7:a863']]))).toBeNull()
  })

  it('a second identical unit gets ~2, a third ~3', () => {
    const a = iface(0xa863, 0xff01)
    const b = iface(0xa863, 0xff01)
    expect(unitIdFor(b, new Map([[a, '36a7:a863']]))).toBe('36a7:a863~2')
    expect(unitIdFor(iface(0xa863, 0xff01), new Map([[a, '36a7:a863'], [b, '36a7:a863~2']]))).toBe('36a7:a863~3')
  })

  it('the freed id is reused once a unit is unplugged', () => {
    const b = iface(0xa863, 0xff01)
    expect(unitIdFor(iface(0xa863, 0xff01), new Map([[b, '36a7:a863~2']]))).toBe('36a7:a863')
  })

  it('other models do not interfere', () => {
    expect(unitIdFor(iface(0xa864, 0xff01), new Map([[iface(0xa863, 0xff01), '36a7:a863']]))).toBe('36a7:a864')
  })

  it('unitNumber reads the suffix', () => {
    expect(unitNumber('36a7:a863')).toBe(1)
    expect(unitNumber('36a7:a863~3')).toBe(3)
  })
})

const num = (key: string, current: number): Setting => ({
  key,
  label: key,
  group: 'G',
  value: { kind: 'number', current, min: 0, max: 100, unit: '' },
})

describe('withRead: a fresh read never drops unsaved edits', () => {
  const dev = (read: Setting[], edit: Setting[]): DeviceState => ({ id: 'x', driver: {} as Driver, busy: false, read, edit })

  it('keeps an edit that is not written yet and takes everything else from the device', () => {
    const before = dev([num('dpi', 800), num('rate', 1000)], [num('dpi', 1600), num('rate', 1000)])
    const after = withRead(before, [num('dpi', 800), num('rate', 4000)])
    expect(after.edit).toEqual([num('dpi', 1600), num('rate', 4000)])
    expect(after.read).toEqual([num('dpi', 800), num('rate', 4000)])
    expect(pendingChanges(after)).toEqual([num('dpi', 1600)])
  })

  it('with nothing pending, edit becomes exactly what was read', () => {
    const before = dev([num('dpi', 800)], [num('dpi', 800)])
    const after = withRead(before, [num('dpi', 400)])
    expect(after.edit).toEqual([num('dpi', 400)])
    expect(pendingChanges(after)).toEqual([])
  })

  it('works before the first read', () => {
    const after = withRead({ id: 'x', driver: {} as Driver, busy: true }, [num('dpi', 800)])
    expect(after.edit).toEqual([num('dpi', 800)])
  })
})
