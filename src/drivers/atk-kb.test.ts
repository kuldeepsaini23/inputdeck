import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAtkKb, type FakeAtkKbOpts } from './fakes/fake-atk-kb';
import type { Driver, Setting, Value } from './types';
import {
  ATK_KEYBOARDS,
  CURVE_PRESETS_UM,
  allowed,
  atkKbConfig,
  atkKbFactory,
  autoRestartPkt,
  getBufferPkt,
  gpAnglePkt,
  gpConfigPkt,
  gpEnabledPkt,
  gpExtremePkt,
  gpGetCurvePkt,
  gpGetMapPkt,
  gpKeyOutputPkt,
  gpModePkt,
  gpSetCurvePkt,
  gpSetMapPkt,
  gpSquarePkt,
  parseConfig,
  parseCurve,
  parseVersion,
  targetOptions,
  versionPkt,
} from './atk-kb';
import { ATK_MICE } from './compxb-atk';
import { FACTORIES } from '../devices';

const real = { ...atkKbConfig };
beforeAll(() => {
  atkKbConfig.reply = 40;
  atkKbConfig.modeReply = 40;
});
afterAll(() => {
  Object.assign(atkKbConfig, real);
});

const pad = (p: number[]) => [...p, ...new Array(32 - p.length).fill(0)];
const B = { rows: 5, cols: 14 };

async function connect(o?: FakeAtkKbOpts): Promise<[FakeAtkKb, Driver]> {
  const f = new FakeAtkKb(o);
  const d = await atkKbFactory.create(f.asDevice());
  expect(d).not.toBeNull();
  return [f, d!];
}
const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, v: Value): Setting => ({ ...s, value: v });

describe('packets match the ATK hub', () => {
  it('builds the same bytes as the hub classes', () => {
    // Ux.get(): [id_get_keyboard_value, customId]
    expect(versionPkt()).toEqual([0x02, 0x96, 0x00]);
    // Il.getConfig(): createBase(get, Sl.CONFIG) -> 02 96 4C row=0 col=0 sub=3
    expect(gpConfigPkt()).toEqual([0x02, 0x96, 0x4c, 0, 0, 3]);
    expect(gpGetMapPkt(2, 3)).toEqual([0x02, 0x96, 0x4c, 2, 3, 1]);
    expect(gpSetMapPkt(2, 3, 64)).toEqual([0x03, 0x96, 0x4c, 2, 3, 1, 64]);
    expect(gpModePkt(1)).toEqual([0x03, 0x96, 0x4c, 0, 0, 0, 1]);
    expect(gpEnabledPkt(true)).toEqual([0x03, 0x96, 0x4c, 0, 0, 8, 1]);
    expect(gpKeyOutputPkt(2)).toEqual([0x03, 0x96, 0x4c, 0, 0, 7, 2]);
    // the stick goes in the row byte
    expect(gpAnglePkt(1, 30)).toEqual([0x03, 0x96, 0x4c, 1, 0, 4, 30]);
    expect(gpSquarePkt(0, true)).toEqual([0x03, 0x96, 0x4c, 0, 0, 5, 1]);
    expect(gpExtremePkt(1, false)).toEqual([0x03, 0x96, 0x4c, 1, 0, 6, 0]);
    expect(gpGetCurvePkt(3)).toEqual([0x02, 0x96, 0x4c, 3, 0, 9]);
    // setCurve: x little-endian then y, per point
    expect(gpSetCurvePkt(2, [100, 1166, 2233, 3300], [20, 85, 170, 255])).toEqual([
      0x03, 0x96, 0x4c, 2, 0, 9, 0x64, 0x00, 20, 0x8e, 0x04, 85, 0xb9, 0x08, 170, 0xe4, 0x0c, 255,
    ]);
    // Td.create(1): restart field 78, status 1
    expect(autoRestartPkt()).toEqual([0x03, 0x96, 0x4e, 1]);
    // wA.get(i*28, 28)
    expect(getBufferPkt(56, 28)).toEqual([0x12, 0x00, 56, 28]);
  });

  it('parses replies the way the hub reads them', () => {
    const v = pad([0x02, 0x96, 0x00, 0, 0, 0x01, 0x20]);
    expect(parseVersion(v)).toBe('1.20');
    expect(parseVersion(pad([0x02, 0x96, 0, 0, 0, 0x02, 0x05]))).toBe('2.05');
    const c = parseConfig(pad([0x02, 0x96, 0x4c, 0, 0, 3, 1, 30, 60, 1, 0, 0, 1, 2, 1]));
    expect(c).toEqual({ mode: 1, angle: [30, 60], square: [true, false], extreme: [false, true], keyOutput: 2, enabled: true });
    expect(parseCurve(pad(gpSetCurvePkt(0, [100, 1166, 2233, 3300], [20, 85, 170, 255])))).toEqual({ x: [100, 1166, 2233, 3300], y: [20, 85, 170, 255] });
  });

  it('turns the hub presets into points like the curve editor does', () => {
    const lin = CURVE_PRESETS_UM.find((p) => p.name === 'Linear')!;
    expect(lin.x).toEqual([100, 1089, 2178, 3300]);
    expect(lin.y).toEqual([20, 85, 170, 255]);
    expect(CURVE_PRESETS_UM.map((p) => p.name)).toEqual(['Linear', 'Aggressive', 'Slow', 'Smooth', 'Steep', 'Instant', 'Turbo']);
    expect(CURVE_PRESETS_UM.find((p) => p.name === 'Instant')!.x).toEqual([100, 165, 264, 3300]);
  });

  it('offers only Xbox targets in Xbox mode', () => {
    const xbox = targetOptions(2).map(([, v]) => v);
    const hid = targetOptions(1).map(([, v]) => v);
    expect(xbox).not.toContain(16);
    expect(hid).toContain(16);
    expect(hid.length).toBe(31);
    // a HID-only target already in use stays visible
    expect(targetOptions(2, [18]).map(([, v]) => v)).toContain(18);
  });
});

describe('allowlist', () => {
  it('allows exactly the known packet shapes', () => {
    for (const p of [
      versionPkt(),
      gpConfigPkt(),
      gpGetMapPkt(4, 13),
      gpSetMapPkt(0, 0, 97),
      gpSetMapPkt(0, 0, 0),
      gpModePkt(1),
      gpModePkt(2),
      autoRestartPkt(),
      gpEnabledPkt(false),
      gpKeyOutputPkt(0),
      gpAnglePkt(0, 90),
      gpSquarePkt(1, true),
      gpExtremePkt(0, true),
      gpGetCurvePkt(0),
      gpSetCurvePkt(3, [0, 0, 3300, 3300], [0, 255, 255, 255]),
      getBufferPkt(112, 28),
    ])
      expect(allowed(pad(p), B), p.join(',')).toBe(true);
  });

  it('refuses everything else', () => {
    const bad = [
      [0x02, 0x96, 0x4c, 0, 0, 2], // gamepad CLEAR (get)
      [0x03, 0x96, 0x4c, 0, 0, 2], // gamepad CLEAR
      [0x03, 0x96, 0x15], // resetAll
      [0x03, 0x96, 0x08, 0], // calibrate
      [0x03, 0x96, 0x18], // calibrationStart
      [0x03, 0x96, 0x98], // iap
      [0x03, 0x96, 0x4e, 0], // auto restart off
      [0x03, 0x96, 0x4e, 2],
      [0x03, 0x96, 0x03, 0, 0, 0x05, 0xdc], // per-key actuation (left out)
      [0x03, 0x96, 0x07, 0, 0, 1], // per-key RT (left out)
      [0x03, 0x96, 0x46, 3], // report rate
      [0x0b], // bootloader jump
      [0x0a], // eeprom reset
      [0x06], // keymap reset
      [0x05, 0, 0, 0, 0, 4], // keymap write
      [0x03, 0x96, 0x4c, 0, 0, 0, 0], // mode 0
      [0x03, 0x96, 0x4c, 0, 0, 0, 3],
      [0x03, 0x96, 0x4c, 1, 0, 0, 1], // mode with a row
      [0x03, 0x96, 0x4c, 0, 0, 1, 21], // unknown target
      [0x03, 0x96, 0x4c, 5, 0, 1, 1], // row outside the matrix
      [0x03, 0x96, 0x4c, 0, 14, 1, 1], // col outside the matrix
      [0x03, 0x96, 0x4c, 2, 0, 4, 45], // stick 2
      [0x03, 0x96, 0x4c, 0, 0, 4, 91], // angle > 90
      [0x03, 0x96, 0x4c, 0, 0, 5, 2],
      [0x03, 0x96, 0x4c, 0, 0, 7, 3],
      [0x03, 0x96, 0x4c, 0, 0, 8, 2],
      [0x03, 0x96, 0x4c, 4, 0, 9], // curve 4
      [0x02, 0x96, 0x4c, 0, 1, 9], // curve with a col
      [0x02, 0x96, 0x4c, 0, 0, 3, 1], // config read with junk
      [0x02, 0x96, 0x00, 1], // version with junk
      [0x12, 0, 0, 27], // keymap read, odd length
      [0x12, 0, 1, 28], // keymap read, unaligned
      [0x12, 0, 168, 28], // keymap read past layer 0 (5x14x2 = 140 -> 168 bytes)
    ];
    for (const p of bad) expect(allowed(pad(p), B), p.join(',')).toBe(false);
    // curve x out of range / going backwards
    expect(allowed(pad(gpSetCurvePkt(0, [100, 2000, 1000, 3300], [0, 0, 0, 0])), B)).toBe(false);
    expect(allowed(pad(gpSetCurvePkt(0, [100, 200, 300, 3301], [0, 0, 0, 0])), B)).toBe(false);
    // curve with junk after the points
    const junk = pad(gpSetCurvePkt(0, [100, 200, 300, 400], [0, 0, 0, 0]));
    junk[20] = 1;
    expect(allowed(junk, B)).toBe(false);
    // matrix reads / writes need the bounds
    expect(allowed(pad(gpGetMapPkt(0, 0)))).toBe(false);
    expect(allowed(pad(getBufferPkt(0, 28)))).toBe(false);
  });
});

describe('device identification', () => {
  it('matches ATK keyboards on the raw HID interface only', () => {
    const f = new FakeAtkKb();
    expect(atkKbFactory.match(f.asDevice())).toBe(true);
    const other = new FakeAtkKb();
    other.collections = [{ usagePage: 1, usage: 6 }] as unknown as HIDCollectionInfo[];
    expect(atkKbFactory.match(other.asDevice())).toBe(false);
    const unknownPid = new FakeAtkKb({ productId: 0x0001 });
    expect(atkKbFactory.match(unknownPid.asDevice())).toBe(false);
    // the factory list hands ATK keyboards to this driver, not to generic VIA
    expect(FACTORIES.find((x) => x.match(f.asDevice()))).toBe(atkKbFactory);
  });

  it('has no product id that is also an ATK mouse', () => {
    const mice = new Set(ATK_MICE.filter((m) => m[0] === 0x373b).map((m) => m[1]));
    for (const [pid] of ATK_KEYBOARDS) expect(mice.has(pid), pid.toString(16)).toBe(false);
    expect(new Set(ATK_KEYBOARDS.map((m) => m[0])).size).toBe(ATK_KEYBOARDS.length);
  });

  it('identifies the model and stays view-only', async () => {
    const [, d] = await connect();
    expect(d.brand()).toBe('ATK');
    expect(d.model()).toBe('EDGE 60HE ULTIMATE');
    expect(d.verified).toBe(false);
    expect(d.kind).toBe('keyboard');
  });
});

describe('fake device round trip', () => {
  it('reads the gamepad settings', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    expect(find(ss, 'fw').value).toEqual({ kind: 'text', text: '2.05' });
    expect(find(ss, 'gp_enabled').value).toEqual({ kind: 'toggle', on: false });
    expect((find(ss, 'gp_mode').value as Extract<Value, { kind: 'choice' }>).current).toBe(2);
    expect((find(ss, 'gp_angle_l').value as Extract<Value, { kind: 'number' }>).current).toBe(45);
    const map = find(ss, 'gp_map').value as Extract<Value, { kind: 'perKeyChoice' }>;
    // only matrix cells with a key: 25 in the fake keymap
    expect(map.keys.length).toBe(25);
    const w = map.keys.findIndex((k) => k.label === 'W');
    expect(map.values[w]).toBe(65);
    expect(map.keys[w]).toMatchObject({ x: 2, y: 1 });
    const ls = find(ss, 'gp_curve_ls').value as Extract<Value, { kind: 'gamepadCurve' }>;
    expect(ls.points).toEqual([{ x: 0.1, y: 20 }, { x: 1.166, y: 85 }, { x: 2.233, y: 170 }, { x: 3.3, y: 255 }]);
    expect(ls.maxX).toBe(3.3);
    expect(ls.presets?.length).toBe(7);
    // reads only: nothing was set
    expect(f.sent.every((p) => p[0] !== 0x03)).toBe(true);
    // one mapping read per key, four curves, keymap in 28-byte chunks
    expect(f.sent.filter((p) => p[0] === 0x02 && p[2] === 0x4c && p[5] === 1).length).toBe(25);
    expect(f.sent.filter((p) => p[0] === 0x12).length).toBe(5);
  });

  it('writes settings and reads them back', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    await d.write(withValue(find(ss, 'gp_enabled'), { kind: 'toggle', on: true }));
    expect(f.enabled).toBe(1);
    await d.write(withValue(find(ss, 'gp_output'), { ...(find(ss, 'gp_output').value as Extract<Value, { kind: 'choice' }>), current: 1 }));
    expect(f.keyOutput).toBe(1);
    await d.write(withValue(find(ss, 'gp_angle_r'), { kind: 'number', min: 0, max: 90, current: 30, unit: '°' }));
    expect(f.angle).toEqual([45, 30]);
    await d.write(withValue(find(ss, 'gp_square_l'), { kind: 'toggle', on: true }));
    await d.write(withValue(find(ss, 'gp_extreme_r'), { kind: 'toggle', on: true }));
    expect(f.square).toEqual([1, 0]);
    expect(f.extreme).toEqual([0, 1]);

    const curve = find(ss, 'gp_curve_rt');
    const turbo = (curve.value as Extract<Value, { kind: 'gamepadCurve' }>).presets!.find((p) => p.name === 'Turbo')!;
    await d.write(withValue(curve, { ...(curve.value as Extract<Value, { kind: 'gamepadCurve' }>), points: turbo.points }));
    expect(f.curves[3]).toEqual({ x: [100, 363, 660, 3300], y: [20, 180, 250, 255] });

    const mapS = find(ss, 'gp_map');
    const map = mapS.value as Extract<Value, { kind: 'perKeyChoice' }>;
    const values = map.values.slice();
    const space = map.keys.findIndex((k) => k.label === 'Space');
    const w = map.keys.findIndex((k) => k.label === 'W');
    values[space] = 1; // A button
    values[w] = 0; // unmap W
    const before = f.sent.length;
    await d.write(withValue(mapS, { ...map, values }));
    expect(f.map.get('4,5')).toBe(1);
    expect(f.map.has('1,2')).toBe(false);
    // only the two changed keys were written (plus a read-back each)
    expect(f.sent.slice(before).filter((p) => p[0] === 0x03).length).toBe(2);

    const again = await d.read();
    expect((find(again, 'gp_map').value as Extract<Value, { kind: 'perKeyChoice' }>).values).toEqual(values);
    expect((find(again, 'gp_curve_rt').value as Extract<Value, { kind: 'gamepadCurve' }>).points).toEqual(turbo.points);
    expect(find(again, 'gp_enabled').value).toEqual({ kind: 'toggle', on: true });
  });

  it('notices when the keyboard does not keep a value', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    await expect(d.write(withValue(find(ss, 'gp_enabled'), { kind: 'toggle', on: true }))).rejects.toThrow(/didn't keep/);
  });

  it('refuses bad curves before sending anything', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const c = find(ss, 'gp_curve_ls');
    const v = c.value as Extract<Value, { kind: 'gamepadCurve' }>;
    const n = f.sent.length;
    await expect(d.write(withValue(c, { ...v, points: [{ x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3.3, y: 0 }] }))).rejects.toThrow();
    await expect(d.write(withValue(c, { ...v, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3.5, y: 0 }] }))).rejects.toThrow();
    expect(f.sent.length).toBe(n);
  });

  it('a mode change arms auto restart first and then needs a reconnect', async () => {
    const [f, d] = await connect({ restartOnMode: true });
    const ss = await d.read();
    const mode = find(ss, 'gp_mode');
    await d.write(withValue(mode, { ...(mode.value as Extract<Value, { kind: 'choice' }>), current: 1 }));
    const sets = f.sent.filter((p) => p[0] === 0x03);
    expect(sets.map((p) => p.slice(0, 7))).toEqual([
      [0x03, 0x96, 0x4e, 1, 0, 0, 0],
      [0x03, 0x96, 0x4c, 0, 0, 0, 1],
    ]);
    expect(f.mode).toBe(1);
    expect((d as unknown as { reconnectNeeded: boolean }).reconnectNeeded).toBe(true);
    // read() doesn't talk to the restarting board; it says what's going on
    const n = f.sent.length;
    const after = await d.read();
    expect(f.sent.length).toBe(n);
    expect(find(after, 'gp_status').value.kind).toBe('text');
    // and nothing else is written until it is back
    await expect(d.write(withValue(find(after, 'gp_enabled'), { kind: 'toggle', on: true }))).rejects.toThrow(/restarting/);
  });

  it('old firmware gets no gamepad reads', async () => {
    const [f, d] = await connect({ version: [0x01, 0x20] });
    const ss = await d.read();
    expect(ss.some((s) => s.key.startsWith('gp_'))).toBe(false);
    expect(find(ss, 'unsupported').value.kind).toBe('text');
    expect(f.sent.some((p) => p[2] === 0x4c)).toBe(false);
  });
});
