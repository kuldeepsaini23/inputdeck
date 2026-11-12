// Rapid Trigger / actuation writes on DAREU magnetic (FwType 6) boards: exact vendor bytes for the
// A68 "Rapid Trigger (all keys)" action, read-back the way the vendor reads, and a round trip on
// every magnetic product we know (TravelVersion 0 / 1 / 2, narrow and wide values).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDareu, type FakeDareuOpts } from './fakes/fake-dareu';
import type { Driver, Setting, Value } from './types';
import { DAREU_PRODUCTS } from './dareu-products';
import {
  CLS,
  GET,
  MAG,
  allowed,
  capsFor,
  dareuFactory,
  dareuTiming,
  frame,
  funcSocdPkt,
  getRtAdaptivePkt,
  parseFuncSocd,
  productFor,
  rangesFor,
  rtBatch,
  setRtAdaptivePkt,
  setRtPkt,
  unitsFor,
} from './dareu';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const head = (f: Uint8Array, n: number) => Array.from(f.slice(0, n));
const realTiming = { ...dareuTiming };
beforeAll(() => {
  Object.assign(dareuTiming, { poll: 0, tries: 3, pollSettle: 0, verifySettle: 0 });
});
afterAll(() => {
  Object.assign(dareuTiming, realTiming);
});

async function connect(o?: FakeDareuOpts, setup?: (f: FakeDareu) => void): Promise<[FakeDareu, Driver]> {
  const f = new FakeDareu(o);
  setup?.(f);
  const d = await dareuFactory.create(f.asDevice());
  expect(d).not.toBeNull();
  return [f, d!];
}
const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, v: Value): Setting => ({ ...s, value: v });
type Float = Extract<Value, { kind: 'float' }>;
type PerKey = Extract<Value, { kind: 'perKeyTrigger' }>;

const A68 = productFor(0x0175)!;
const U = unitsFor(A68)!;
const CAPS = capsFor(A68);

describe('A68 Rapid Trigger (all keys): vendor bytes', () => {
  // Vendor: module/performance.html QuickSetRt(true) -> rtTravel = [single slider (= GlobalTravel),
  // sensitivity slider (RapidTriggerRange[1][4] = 0.3), same] -> TgRtKeyboard.SetKeysRtTrigger
  // (8 keys per frame when TravelVersion != 0) -> TgRtKeyboardHidDevice.SetRtTrigger, TravelVersion 2
  // branch: init / (RapidTriggerRange[0][5] / 2), press / RapidTriggerRange[1][5],
  // release / RapidTriggerRange[2][5], each big-endian u16; size byte 7n + 1; profile byte 0.
  it('units: start point at half the JSON step, sensitivities at the JSON step', () => {
    expect(U).toMatchObject({ tv: 2, rtInit: 0.005, rtPress: 0.005, rtRelease: 0.005 });
    expect(Math.round(1.2 / (0.01 / 2))).toBe(240); // parseInt((1.2 / (0.01 / 2)).toFixed(0))
    expect(Math.round(0.3 / 0.005)).toBe(60);
  });

  it('one frame: 1.2 mm start, 0.3 mm press / release for Esc', () => {
    expect(head(setRtPkt(U, [1], 1.2, 0.3, 0.3), 14)).toEqual(hex('00 08 0d 03 00 00 01 01 00 f0 00 3c 00 3c'));
  });

  it('turning it on from a fresh board sends exactly what the vendor sends', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    const before = f.sent.length;
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    const sets = f.sent.slice(before).filter((p) => (p[3] & GET) === 0);
    expect(sets).toHaveLength(9); // 68 keys, 8 per frame
    // first frame: Esc 1 2 3 4 5 6 7, each 00 f0 / 00 3c / 00 3c
    const k8 = [1, 18, 19, 20, 21, 22, 23, 24];
    expect(Array.from(sets[0])).toEqual([
      ...hex('00 39 0d 03 00 00 08'),
      ...k8.flatMap((k) => [k, ...hex('00 f0 00 3c 00 3c')]),
      ...new Array(64 - 7 - 56).fill(0),
    ]);
    // last frame: the 4 keys left (Ctrl Left Down Right)
    expect(head(sets[8], 7)).toEqual(hex('00 1d 0d 03 00 00 04'));
    expect(head(sets[8], 14)).toEqual([...hex('00 1d 0d 03 00 00 04'), 109, ...hex('00 f0 00 3c 00 3c')]);
    expect(sets.every((p) => allowed(p))).toBe(true);
    // nothing else is written: no key-function SET, no save command
    expect(sets.every((p) => p[2] === CLS.MAGNETIC && p[3] === MAG.RAPID_TRIGGER)).toBe(true);
    for (const k of CAPS) expect(f.key(k.index), k.label).toEqual({ func: 2, travel: 240, press: 60, release: 60 });
  });

  it('reads back the way the vendor does: functions via FUNC_AND_SOCD, then RT values', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const before = f.sent.length;
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    const gets = f.sent.slice(before).filter((p) => (p[3] & GET) !== 0);
    const fs = gets.filter((p) => p[3] === (MAG.FUNC_AND_SOCD | GET));
    expect(fs).toHaveLength(5); // 68 keys, 14 per frame
    // size byte n + 1, active profile in the header, keys 4 bytes apart (GetFunctionAndSOCD)
    expect(head(fs[0], 15)).toEqual(hex('00 0f 0d 91 01 00 0e 01 00 00 00 12 00 00 00'));
    expect(gets.filter((p) => p[3] === (MAG.RAPID_TRIGGER | GET))).toHaveLength(9);
    expect(gets.filter((p) => p[3] === (MAG.KEY_FUNCTION | GET))).toHaveLength(0);
  });

  it('FUNC_AND_SOCD frames and reply', () => {
    expect(head(funcSocdPkt(1, [61, 63]), 15)).toEqual(hex('00 03 0d 91 01 00 02 3d 00 00 00 3f 00 00 00'));
    expect(allowed(funcSocdPkt(1, [61, 63]))).toBe(true);
    expect(() => funcSocdPkt(1, new Array(15).fill(1))).toThrow();
    const r = new Uint8Array(64);
    r.set([2, 61, 2, 1, 0, 63, 1, 0, 0xff], 6);
    expect(parseFuncSocd(r, 2)).toEqual([{ key: 61, func: 2, socd: 1, group: 0 }, { key: 63, func: 1, socd: 0, group: 0xff }]);
    expect(allowed(frame(13, 17 | GET, 3, 1, [2, 61, 0, 0, 0, 63, 0, 0, 0]))).toBe(true);
    expect(allowed(frame(13, 17 | GET, 3, 1, [2, 61, 1, 0, 0, 63, 0, 0, 0]))).toBe(false);
  });

  it('a change the board ignored says what was sent and what came back (mm and raw)', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    const err = await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^keyboard didn't take the trigger change for: Esc, 1, 2/);
    expect(msg).toContain('Esc #1: sent RT (2) start 1.2 / press 0.3 / release 0.3 mm [raw 240/60/60], reads back normal (0)');
    expect(msg).toContain('TravelVersion 2');
    expect(msg).toContain('fw 0.4.6');
    expect(msg).toContain('RT self-adaptive off');
  });

  it('values that come back different are shown in mm and raw', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    // a firmware that keeps its own press / release (e.g. adapting them)
    const orig = f.sendFeatureReport.bind(f);
    f.sendFeatureReport = async (id, data) => {
      await orig(id, data);
      for (const [k, v] of f.keys) if (v.func === 2) f.keys.set(k, { ...v, press: 50, release: 50 });
    };
    const msg = await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true })).catch((e: Error) => e.message);
    expect(msg).toContain('reads back RT (2) start 1.2 / press 0.25 / release 0.25 mm [raw 240/50/50]');
  });

  it('a board that applies the change a little later passes after a re-read', async () => {
    const [f, d] = await connect({ lag: 12 });
    const ss = await d.read();
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    for (const k of CAPS) expect(f.key(k.index).func).toBe(2);
  });

  it('firmware without FUNC_AND_SOCD: reads functions one key at a time (cmd 0)', async () => {
    const [f, d] = await connect({ noFuncSocd: true });
    const ss = await d.read();
    const before = f.sent.length;
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    const gets = f.sent.slice(before).filter((p) => (p[3] & GET) !== 0);
    expect(gets.filter((p) => p[3] === (MAG.FUNC_AND_SOCD | GET))).toHaveLength(0);
    expect(gets.filter((p) => p[3] === (MAG.KEY_FUNCTION | GET))).toHaveLength(68);
  });

  it('FUNC_AND_SOCD wins over cmd 0; cmd-0 ids >= 7 count as normal (vendor)', async () => {
    const [f, d] = await connect({ noFuncSocd: true }, (x) => x.keys.set(61, { func: 9, travel: 0, press: 0, release: 0 }));
    const ss = await d.read();
    const pk = find(ss, 'per_key_trigger').value as PerKey;
    const a = CAPS.findIndex((k) => k.index === 61);
    expect(pk.travel[a]).toBe(1.2); // global travel: a normal key
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    expect(f.key(61).func).toBe(2);
  });

  it('RT self-adaptive switch (class 13 cmd 14)', async () => {
    expect(head(getRtAdaptivePkt(), 8)).toEqual(hex('00 01 0d 8e 00 00 00 00'));
    expect(head(setRtAdaptivePkt(true), 8)).toEqual(hex('00 01 0d 0e 00 00 01 00'));
    expect(allowed(frame(13, 14, 1, 0, [2]))).toBe(false);
    const [f, d] = await connect();
    const ss = await d.read();
    expect(find(ss, 'rt_adaptive').value).toEqual({ kind: 'toggle', on: false });
    await d.write(withValue(find(ss, 'rt_adaptive'), { kind: 'toggle', on: true }));
    expect(f.rtAdaptive).toBe(1);
    const [, old] = await connect({ noRtAdaptive: true });
    expect((await old.read()).find((s) => s.key === 'rt_adaptive')).toBeUndefined();
    // not offered on boards whose JSON doesn't list it
    const [, ek] = await connect({ pid: 0x0105 });
    expect((await ek.read()).find((s) => s.key === 'rt_adaptive')).toBeUndefined();
  });

  it('knob keys (ids >= 170) are never given a trigger (the vendor hides them too)', async () => {
    const [f, d] = await connect({ pid: 0x0131 });
    const ss = await d.read();
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    const written = f.wrote(CLS.MAGNETIC, MAG.RAPID_TRIGGER).flatMap((p) => Array.from({ length: p[6] }, (_, i) => p[7 + 4 * i]));
    expect(written.some((id) => id >= 170)).toBe(false);
    expect(written.length).toBe(capsFor(productFor(0x0131)!).filter((c) => c.index < 170).length);
    const pk = (await d.read()).find((s) => s.key === 'per_key_trigger')!;
    const v = pk.value as PerKey;
    const knob = v.keys.findIndex((k) => k.index === 171);
    const t = v.travel.slice();
    t[knob] = 2;
    await expect(d.write(withValue(pk, { ...v, travel: t }))).rejects.toThrow(/no adjustable switch/);
  });
});

// ---------------------------------------------------------------------------------------------

const MAGNETIC = DAREU_PRODUCTS.filter((p) => p.fw === 6 && unitsFor(p));

describe('every magnetic product: writes round-trip through the fake', () => {
  it('covers TravelVersion 0, 1 and 2', () => {
    expect(new Set(MAGNETIC.map((p) => unitsFor(p)!.tv))).toEqual(new Set([0, 1, 2]));
    expect(MAGNETIC.length).toBeGreaterThan(40);
  });

  it.each(MAGNETIC.map((p) => [`${p.name} ${p.pid.toString(16).padStart(4, '0')}`, p.pid] as const))('%s', async (_, pid) => {
    const p = productFor(pid)!;
    const u = unitsFor(p)!;
    const r = rangesFor(p);
    const caps = capsFor(p);
    const tv = u.tv;
    const [f, d] = await connect({ pid });
    const editable = caps.filter((c) => c.index < 170);
    let ss = await d.read();
    const snap = (v: number, step: number) => Math.round(v / step) * step;

    // actuation: recommended minimum
    const act = find(ss, 'actuation');
    const a1 = snap(p.gt![1], r.step);
    await d.write(withValue(act, { ...(act.value as Float), current: a1 }));
    ss = await d.read();
    expect((find(ss, 'actuation').value as Float).current).toBeCloseTo(a1, 6);

    // RT on for all keys
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    for (const c of editable) expect(f.key(c.index).func, c.label).toBe(2);
    // frames: batch size and value width follow the TravelVersion
    for (const fr of f.wrote(CLS.MAGNETIC, MAG.RAPID_TRIGGER)) {
      expect(fr[6]).toBeLessThanOrEqual(rtBatch(u));
      expect(fr[1]).toBe((tv === 0 ? 4 : 7) * fr[6] + 1);
    }
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true });

    // sensitivity: recommended minimum of the press range
    const sens = find(ss, 'rt_sens');
    const s1 = Math.max(r.sensMin, snap(p.rt![1][1], u.rtPress));
    await d.write(withValue(sens, { ...(sens.value as Float), current: s1 }));
    ss = await d.read();
    expect((find(ss, 'rt_sens').value as Float).current).toBeCloseTo(s1, 6);

    // actuation again while RT is on (start point of every RT key)
    const a2 = snap(Math.min(p.gt![2], r.rtMax), r.step);
    await d.write(withValue(find(ss, 'actuation'), { ...(find(ss, 'actuation').value as Float), current: a2 }));

    // per-key mixed: single at max travel, RT at min travel + max sensitivity, RT at min sensitivity
    ss = await d.read();
    const pk = find(ss, 'per_key_trigger');
    const v = pk.value as PerKey;
    const [k0, k1, k2] = [0, 1, 2].map((n) => v.keys.findIndex((k) => k.index === editable[n].index));
    const travel = v.travel.slice();
    const rapid = v.rapid.slice();
    const sensA = v.sens.slice();
    travel[k0] = r.travelMax;
    rapid[k0] = false;
    travel[k1] = Math.max(r.travelMin, r.rtMin);
    sensA[k1] = r.sensMax;
    sensA[k2] = r.sensMin;
    await d.write(withValue(pk, { ...v, travel, rapid, sens: sensA }));
    const back = (await d.read()).find((s) => s.key === 'per_key_trigger')!.value as PerKey;
    expect(back.rapid[k0]).toBe(false);
    expect(back.travel[k0]).toBeCloseTo(r.travelMax, 6);
    expect(back.rapid[k1]).toBe(true);
    expect(back.travel[k1]).toBeCloseTo(Math.max(r.travelMin, r.rtMin), 6);
    expect(back.sens[k1]).toBeCloseTo(r.sensMax, 6);
    expect(back.sens[k2]).toBeCloseTo(r.sensMin, 6);
    // values fit the TravelVersion's width
    for (const c of editable) {
      const k = f.key(c.index);
      for (const x of [k.travel, k.press, k.release]) expect(x).toBeLessThan(tv === 0 ? 256 : 65536);
    }

    // RT off again
    ss = await d.read();
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: false }));
    for (const c of editable) expect(f.key(c.index).func, c.label).toBe(1);
    expect(f.sent.every((x) => allowed(x))).toBe(true);
  });
});
