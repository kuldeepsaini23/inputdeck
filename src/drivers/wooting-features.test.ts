import { describe, expect, it } from 'vitest';
import {
  advView,
  allowedReport,
  dksMasks,
  dksPoints,
  frameConfig,
  frameMapping,
  hidToWoot,
  mid,
  parseAkc,
  parseGpMap,
  parseMapping,
  qmkToWoot,
  RAPPY,
  SIXTY_ANSI,
  WootingDriver,
  wootToHid,
  wootToQmk,
  WT_BASE,
  encodeMapping,
  defaultMapping,
} from './wooting';
import { FakeWooting } from './fakes/fake-wooting';
import type { Setting, Value } from './types';

const h = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
async function open() {
  const fake = new FakeWooting();
  await fake.open();
  const drv = new WootingDriver(fake.asHid(), { timeoutMs: 50 });
  const ss = await drv.read();
  return { fake, drv, ss };
}
const find = (l: Setting[], k: string) => l.find((s) => s.key === k)!;
const pos = (label: string) => SIXTY_ANSI.findIndex((k) => k.label === label);
type V<K extends Value['kind']> = Extract<Value, { kind: K }>;

describe('wooting codecs', () => {
  it('translates key codes (HID - 3, keypad - 2, modifiers, media, own keys)', () => {
    expect(wootToHid(0x01)).toBe(0x04); // A
    expect(wootToHid(0x4f)).toBe(0x52); // Up
    expect(wootToHid(0x51)).toBe(0x53); // Num Lock
    expect(wootToHid(0x63)).toBe(0xe0); // LCtrl
    expect(wootToHid(0x6b)).toBe(0x68); // F13
    for (let k = 0x04; k <= 0xe7; k++) {
      const w = hidToWoot(k);
      if (w !== undefined) expect(wootToHid(w)).toBe(k);
    }
    expect(wootToQmk(0xc3)).toBe(0xa8); // mute
    expect(qmkToWoot(0xa8)).toBe(0xc3);
    expect(wootToQmk(0xe7)).toBe(WT_BASE | 0xe7);
    expect(qmkToWoot(WT_BASE | 0xe7)).toBe(0xe7);
    expect(wootToQmk(0xff)).toBe(0);
    expect(qmkToWoot(0xcd)).toBeUndefined(); // mouse cursor: not on this keyboard
  });

  it('DKS bitmaps match the Wootility capture (W through the press, Shift at bottom out)', () => {
    // capture masks a9 a4 a8 aa for codes [W, LShift, -, -]
    const masks = dksMasks([0xa9, 0xa4, 0xa8, 0xaa]);
    expect(masks[0]).toBe(0b0101011); // fires at press, held to the release
    expect(masks[1]).toBe(0b0001100); // fires at bottom out, held until it rises
    expect(dksPoints(masks)).toEqual([0xa9, 0xa4, 0xa8, 0xaa]);
  });

  it('frames the mapping and device config reports like the captures', () => {
    const [id, d] = frameMapping(7, 1, new Uint8Array(150));
    expect(id).toBe(3);
    expect([...d.subarray(0, 9)]).toEqual([0xd1, 0xda, 0x14, 0x07, 0x01, 0, 0, 0x96, 0]);
    expect(allowedReport(...frameMapping(0, 0, encodeMapping(defaultMapping(0))))).toBe(true);
    expect(allowedReport(...frameMapping(0, 4, encodeMapping(defaultMapping(0))))).toBe(false);
    const [cid, c] = frameConfig([0x10, 0, 0, 0, 0, 0, 0x0c]);
    expect(cid).toBe(1);
    expect([...c.subarray(0, 10)]).toEqual([0xd1, 0xda, 0x07, 0x10, 0, 0, 0, 0, 0, 0x0c]);
    expect(allowedReport(cid, c)).toBe(true);
    expect(allowedReport(...frameConfig([0x10, 0, 0, 0, 0x11, 0, 0x0c]))).toBe(false); // read-only byte
    expect(allowedReport(...frameConfig([0x01, 0, 0, 0, 0, 0, 0x0c]))).toBe(false); // unknown bit
  });

  it('reads the capture formats', () => {
    expect(parseGpMap(h('0a 06 12 04 08 82 f1 01 10 00')).keys.get(0x82)).toBe(0x78); // A on Z
    expect(parseGpMap(h('0a 0a 12 08 0a 06 83 a1 02 82 f1 01 10 01'))).toMatchObject({ override: true });
    expect(parseGpMap(h('0a 0a 12 08 0a 06 83 a1 02 82 f1 01 10 01')).keys.size).toBe(2);
    expect(parseMapping(new Uint8Array(0))).toBeNull();
    const akc = parseAkc(h('0a 0a 22 04 08 63 10 00 40 61 48 00 0a 0d 2a 07 08 a2 01 10 00 18 01 40 40 48 00 10 00 18 02'));
    expect(akc.items.map((i) => [i.kind, i.key, i.other])).toEqual([['rappy', 0x61, 0x63], ['socd', 0x40, 0xa2]]);
    const v = advView(akc, SIXTY_ANSI);
    expect(v.entries).toEqual([]);
    expect(v.unavailable).toContain(pos('A'));
  });
});

describe('wooting driver: everything Wootility does', () => {
  it('remaps a key on the main and Fn layer, and keeps one Fn key', async () => {
    const { drv, fake, ss } = await open();
    const km = find(ss, 'keymap').value as V<'keymap'>;
    expect(km.layers.length).toBe(3);
    expect(km.layers[0][pos('Caps')]).toBe(0x39);
    expect(km.layers[0][pos('Fn')]).toBe(WT_BASE | 0xe7);
    const layers = km.layers.map((l) => l.slice());
    layers[0][pos('Caps')] = 0x29; // Esc
    await drv.write({ ...find(ss, 'keymap'), value: { ...km, layers } });
    expect(fake.slots[0].maps[0].length).toBe(150);
    expect(parseMapping(fake.slots[0].maps[0])![3][0]).toBe(0x26);
    const again = find(await drv.read(), 'keymap').value as V<'keymap'>;
    expect(again.layers[0][pos('Caps')]).toBe(0x29);
    const noFn = again.layers.map((l) => l.slice());
    noFn[0][pos('Fn')] = 0x04;
    await expect(drv.write({ ...find(ss, 'keymap'), value: { ...again, layers: noFn } })).rejects.toThrow(/Fn key/);
  });

  it('adds Mod-Tap, Toggle and DKS keys and keeps the existing entry byte for byte', async () => {
    const { drv, fake, ss } = await open();
    const adv = find(ss, 'advanced_keys').value as V<'advancedKeys'>;
    const shift = SIXTY_ANSI.findIndex((k) => k.index === mid(4, 13));
    expect(adv.entries).toEqual([{ key: shift, mode: 'mt', tap: 0x52, hold: 0xe5, delay: 200 }]);
    const entries = [
      ...adv.entries,
      { key: pos('Caps'), mode: 'tgl' as const, kc: 0xe0, delay: 200 },
      { key: pos('W'), mode: 'dks' as const, actions: [{ kc: 0x1a, mask: 0b0101011 }, { kc: 0xe1, mask: 0b0001100 }, { kc: 0, mask: 0 }, { kc: 0, mask: 0 }] },
    ];
    await drv.write({ ...find(ss, 'advanced_keys'), value: { ...adv, entries } });
    const items = parseAkc(fake.slots[0].akc).items;
    expect(items[0].raw).toEqual(parseAkc(h('0a 0b 12 04 08 4f 10 68 40 8d 01 48 00')).items[0].raw);
    const dks = items.find((i) => i.kind === 'dks')!;
    expect(dks.codes).toEqual([0x17, 0x64, 0xff, 0xff]); // W, LShift (Wooting codes)
    expect(dks.points).toEqual([0xa9, 0xa4, 0xa8, 0xaa]); // same bytes as Wootility
    expect(items.find((i) => i.kind === 'tgl')).toMatchObject({ key: mid(3, 0), code: 0x63 });
    const back = find(await drv.read(), 'advanced_keys').value as V<'advancedKeys'>;
    expect(back.entries.length).toBe(3);
  });

  it('writes Snappy Tappy and Rappy Snappy pairs', async () => {
    const { drv, fake, ss } = await open();
    const socd = find(ss, 'socd').value as V<'socd'>;
    expect(socd.unavailable).toContain(SIXTY_ANSI.findIndex((k) => k.index === mid(4, 13)));
    await drv.write({ ...find(ss, 'socd'), value: { ...socd, entries: [{ keys: [pos('A'), pos('D')], mode: 4 }, { keys: [pos('W'), pos('S')], mode: RAPPY }] } });
    const items = parseAkc(fake.slots[0].akc).items;
    expect(items.find((i) => i.kind === 'socd')).toMatchObject({ key: mid(3, 1), other: mid(3, 3), socd: 4, both: false });
    expect(items.find((i) => i.kind === 'rappy')).toMatchObject({ key: mid(2, 2), other: mid(3, 2) });
    expect(items.some((i) => i.kind === 'mt')).toBe(true);
    const adv = find(await drv.read(), 'advanced_keys').value as V<'advancedKeys'>;
    expect(adv.unavailable).toEqual(expect.arrayContaining([pos('A'), pos('D'), pos('W'), pos('S')]));
  });

  it('maps controller buttons, override, curve and stick options', async () => {
    const { drv, fake, ss } = await open();
    const map = find(ss, 'gp_map').value as V<'perKeyChoice'>;
    const values = map.values.slice();
    values[pos('Z')] = 0x78; // A
    await drv.write({ ...find(ss, 'gp_map'), value: { ...map, values } });
    expect(parseGpMap(fake.slots[0].gpMap).keys.get(mid(4, 2))).toBe(0x78);
    await drv.write({ ...find(ss, 'gp_override'), value: { kind: 'toggle', on: true } });
    expect(parseGpMap(fake.slots[0].gpMap).override).toBe(true);
    const curve = find(ss, 'gp_curve').value as V<'gamepadCurve'>;
    await drv.write({ ...find(ss, 'gp_curve'), value: { ...curve, points: curve.presets![1].points } });
    await drv.write({ ...find(ss, 'gp_angle_deg'), value: { kind: 'number', min: 0, max: 90, current: 77, unit: '°' } });
    const r = await drv.read();
    expect((find(r, 'gp_curve').value as V<'gamepadCurve'>).points.map((p) => p.y)).toEqual([33, 114, 231, 255]);
    expect(find(r, 'gp_angle_deg').value).toMatchObject({ current: 77 });
    expect(find(r, 'gp_keys').value).toEqual({ kind: 'toggle', on: true });
  });

  it('changes polling / rollover / controller with DeviceConfig + SoftReset only', async () => {
    const { drv, fake, ss } = await open();
    const nk = find(ss, 'nkro');
    expect(nk.confirm).toBeTruthy();
    fake.sent = [];
    await drv.write({ ...nk, value: { ...(nk.value as V<'choice'>), current: 1 } });
    expect([...fake.config]).toEqual([0x10, 0, 0, 0, 0, 0, 0x0c]);
    expect(fake.resets).toBe(1);
    expect(fake.sent.at(-1)![2]).toBe(25);
    await expect(drv.write(nk)).rejects.toThrow(/restarting/);
  });

  it('paints keys, sets an effect and global settings, all read back', async () => {
    const { drv, fake, ss } = await open();
    const pk = find(ss, 'per_key_color').value as V<'perKeyColor'>;
    expect(pk.colors[pos('Q')]).toBe(0xff0000);
    const colors = pk.colors.slice();
    colors[pos('Q')] = 0x00ff00;
    await drv.write({ ...find(ss, 'per_key_color'), value: { ...pk, colors } });
    expect((find(await drv.read(), 'per_key_color').value as V<'perKeyColor'>).colors[pos('Q')]).toBe(0x00ff00);
    const fx = find(ss, 'light_mode');
    expect((fx.value as V<'choice'>).current).toBe(1); // wave in the capture
    await drv.write({ ...fx, value: { ...(fx.value as V<'choice'>), current: 3 } });
    expect((find(await drv.read(), 'light_mode').value as V<'choice'>).current).toBe(3);
    await drv.write({ ...find(ss, 'debounce'), value: { kind: 'toggle', on: true } });
    expect(find(await drv.read(), 'debounce').value).toEqual({ kind: 'toggle', on: true });
    expect([...fake.global]).toEqual([0x0a, 0x04, 0x08, 0x05, 0x10, 0x0a, 0x10, 0x00, 0x18, 0x01]);
  });

  it('streams live key travel', async () => {
    const { drv, fake } = await open();
    fake.analog.set(mid(2, 2), 255);
    const seen = new Map<number, number>();
    const stop = await drv.travelTest!((p, mm) => seen.set(p, mm));
    await stop();
    expect(seen.get(pos('W'))).toBe(4);
    expect(seen.get(pos('A'))).toBe(0);
    fake.analogOk = false;
    await expect(drv.travelTest!(() => undefined)).rejects.toThrow();
  });
});
