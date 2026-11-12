import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDareu, type FakeDareuOpts } from './fakes/fake-dareu';
import type { Driver, Setting, Value } from './types';
import { DAREU_PRODUCTS } from './dareu-products';
import {
  CLS,
  DEV,
  GET,
  LED,
  MAG,
  REPORT_SIZE,
  activeProfilePkt,
  allowed,
  attributePkt,
  capsFor,
  dareuFactory,
  dareuTiming,
  frame,
  fwVerPkt,
  getBrightnessPkt,
  getEffectPkt,
  getPollPkt,
  getRtPkt,
  getSinglePkt,
  globalTravelPkt,
  keyFuncPkt,
  mergeRegions,
  normalizeReply,
  parseEffectList,
  planKeyTrigs,
  planPackets,
  productFor,
  rangesFor,
  regionChunkPkt,
  regionCountPkt,
  setBrightnessPkt,
  setEffectPkt,
  setPollPkt,
  setRtPkt,
  setSinglePkt,
  unitsFor,
  type KeyTrig,
} from './dareu';
import { SOCD_PIDS, getSocdPkt, planSocd, removeSocdPkt, setSocdPkt } from './dareu';
import type { Socd } from './types';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const head = (f: Uint8Array, n = 12) => Array.from(f.slice(0, n));
const A68 = productFor(0x0175)!;
const U = unitsFor(A68)!;
const R = rangesFor(A68);
const CAPS = capsFor(A68);
const pos = (id: number) => CAPS.findIndex((k) => k.index === id);
const W = 41;
const A = 61;
const FN = 107;

// tests shorten the shared timings; put the real ones back afterwards
const realTiming = { ...dareuTiming };
afterAll(() => {
  Object.assign(dareuTiming, realTiming);
});
beforeAll(() => {
  Object.assign(dareuTiming, { poll: 0, tries: 5, pollSettle: 0 });
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

// ---------------------------------------------------------------------------------------------

describe('products', () => {
  it('A68 data from the vendor JSON', () => {
    expect(A68).toMatchObject({ name: 'A68', model: 'TK53H', fw: 6, tv: 2, poll: [[8, 1000], [1, 8000]] });
    expect(CAPS).toHaveLength(68);
    expect(U).toEqual({ tv: 2, global: 0.005, single: 0.005, rtInit: 0.005, rtPress: 0.005, rtRelease: 0.005 });
    expect(CAPS.find((k) => k.label === 'Space')).toMatchObject({ index: 102, x: 3.75, y: 4 });
    // keys don't overlap within a row
    for (const a of CAPS)
      for (const b of CAPS)
        if (a !== b && a.y === b.y) expect(a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true);
    expect(new Set(CAPS.map((k) => k.index)).size).toBe(68);
  });

  it('only TG firmware PIDs, no receivers / other firmware', () => {
    for (const p of DAREU_PRODUCTS) expect([0, 1, 6]).toContain(p.fw);
    for (const pid of [0x0137, 0x0138, 0x0083, 0x0159, 0x0160, 0x0162, 0x0067, 0x0075, 0x0037, 0x0211]) {
      expect(productFor(pid)).toBeUndefined();
    }
    expect(productFor(0x0210)?.fw).toBe(1);
    expect(DAREU_PRODUCTS.every((p) => capsFor(p).length > 0)).toBe(true);
  });

  it('A98 RT bogus step -> no magnetic units', () => {
    expect(unitsFor(productFor(0x0136)!)).toBeUndefined();
    expect(unitsFor(productFor(0x0060)!)).toBeUndefined(); // not magnetic
    expect(unitsFor(productFor(0x0107)!)).toMatchObject({ tv: 0, single: 0.02 });
  });
});

describe('packets', () => {
  it('read frames', () => {
    expect(head(fwVerPkt(), 8)).toEqual(hex('00 03 00 80 00 00 00 00'));
    expect(head(activeProfilePkt(), 6)).toEqual(hex('00 00 05 83 00 00'));
    expect(head(getPollPkt(1), 8)).toEqual(hex('00 02 00 84 01 00 00 00'));
    expect(head(regionCountPkt(), 8)).toEqual(hex('00 01 03 80 00 00 00 00'));
    expect(head(regionChunkPkt(2, 0), 9)).toEqual(hex('00 04 03 80 00 00 02 00 00'));
    expect(head(attributePkt(0), 8)).toEqual(hex('00 01 03 81 00 00 00 00'));
    expect(head(getEffectPkt(1, 0), 8)).toEqual(hex('00 01 03 82 01 00 00 00'));
    expect(head(getBrightnessPkt(1, 0), 8)).toEqual(hex('00 02 03 83 01 00 00 00'));
    expect(head(globalTravelPkt(U), 8)).toEqual(hex('00 02 0d 87 00 00 00 00'));
    expect(head(keyFuncPkt([41]), 10)).toEqual(hex('00 03 0d 80 00 00 01 29 00 00'));
    expect(head(getSinglePkt(U, [41, 61]), 14)).toEqual(hex('00 07 0d 82 00 00 02 29 00 00 3d 00 00 00'));
    expect(head(getRtPkt(U, [41]), 15)).toEqual(hex('00 08 0d 83 00 00 01 29 00 00 00 00 00 00 00'));
    for (const f of [fwVerPkt(), activeProfilePkt(), getPollPkt(1), regionCountPkt(), regionChunkPkt(2, 0), attributePkt(0), getEffectPkt(1, 0),
      getBrightnessPkt(1, 0), globalTravelPkt(U), keyFuncPkt([41]), getSinglePkt(U, [41, 61]), getRtPkt(U, [41])]) {
      expect(f.length).toBe(REPORT_SIZE);
      expect(allowed(f)).toBe(true);
    }
  });

  it('write frames', () => {
    expect(head(setPollPkt(1, 1, 1), 8)).toEqual(hex('00 02 00 04 01 00 01 01'));
    expect(head(setEffectPkt(1, { region: 0, effect: 2, flag: 0, speed: 3, colors: [0x112233] }), 14)).toEqual(
      hex('00 08 03 02 01 00 00 02 00 03 01 11 22 33'),
    );
    expect(head(setBrightnessPkt(1, 0, 255), 8)).toEqual(hex('00 02 03 03 01 00 00 ff'));
    // 1.0 mm at 0.005 mm/unit = 200 = 00 c8
    expect(head(setSinglePkt(U, [41], 1.0), 10)).toEqual(hex('00 04 0d 02 00 00 01 29 00 c8'));
    // init 0.5 mm = 100, press/release 0.1 mm = 20
    expect(head(setRtPkt(U, [41], 0.5, 0.1, 0.1), 14)).toEqual(hex('00 08 0d 03 00 00 01 29 00 64 00 14 00 14'));
    const tv0 = unitsFor(productFor(0x0107)!)!;
    expect(head(setSinglePkt(tv0, [41], 1.0), 9)).toEqual(hex('00 03 0d 02 00 00 01 29 32'));
    expect(head(setRtPkt(tv0, [41], 1.0, 0.1, 0.2), 11)).toEqual(hex('00 05 0d 03 00 00 01 29 32 05 0a'));
    for (const f of [setPollPkt(1, 1, 1), setBrightnessPkt(1, 0, 255), setSinglePkt(U, [41], 1.0), setRtPkt(U, [41], 0.5, 0.1, 0.1),
      setSinglePkt(tv0, [41], 1.0), setRtPkt(tv0, [41], 1.0, 0.1, 0.2)]) {
      expect(allowed(f)).toBe(true);
    }
  });

  it('allowlist refuses dangerous / undocumented frames', () => {
    const no = [
      frame(0, 8, 1, 0, [1]), // factory reset
      frame(0, 8 | GET, 1, 0), // even a "get" of reset
      frame(0, 2 | GET, 3, 0), // serial number (not needed)
      frame(5, 5, 0, 1), // profile reset
      frame(5, 1, 0, 0), // profile create
      frame(5, 3, 0, 0), // profile switch to 'profile 0' (ids are 1-based)
      frame(5, 3, 1, 2, [1]), // profile switch with junk
      frame(9, 5, 0, 0), // DFU entry
      frame(9, 0 | GET, 0, 0),
      frame(10, 0x40, 0, 0), // factory default
      frame(12, 2 | GET, 0, 0), // flash
      frame(13, 10, 1, 0, [1]), // calibration on
      frame(13, 10, 1, 0, [0]), // calibration off
      frame(13, 1, 3, 0, [2, 41, 61]), // normal trigger reset of several keys (only one MT/TGL/DKS key at a time)
      frame(13, 7, 2, 0, [0, 200]), // global travel set
      frame(13, 9 | GET, 1, 0), // travel test
      frame(13, 6, 10, 0, [1, 41]), // DKS
      frame(13, 11, 3, 0, [1, 41, 4]), // SOCD group 5 (doesn't exist)
      frame(1, 3, 6, 1, [41, 0, 4]), // key assign
      frame(3, 4, 4, 1, [0]), // lighting frame
      frame(3, 8, 4, 1, [0]), // custom lighting
      frame(3, 2, 5, 1, [0, 13, 0, 2, 0]), // custom frame effect
      frame(3, 2, 5, 1, [0, 1, 0, 9, 0]), // speed out of range
      frame(3, 2, 8, 1, [0, 1, 0, 2, 2, 1, 2, 3]), // colour count doesn't match size
      frame(0, 4, 2, 1, [1, 3]), // invalid polling id
      frame(13, 2, 4, 0, [1, 41, 0, 0]), // single trigger to 0
      frame(13, 2, 4, 0, [1, 0, 0, 200]), // key id 0
      frame(13, 3, 8, 0, [1, 41, 0, 100, 0, 0, 0, 20]), // RT sensitivity 0
      frame(13, 0 | GET, 3, 1, [1, 41, 0]), // magnetic with a profile
    ];
    for (const f of no) expect(allowed(f), head(f).join(' ')).toBe(false);
    const bad = setSinglePkt(U, [41], 1.0);
    bad[60] = 1; // junk tail
    expect(allowed(bad)).toBe(false);
    const target = fwVerPkt();
    target[0] = 1; // not the wired target
    expect(allowed(target)).toBe(false);
    expect(allowed(new Uint8Array(63))).toBe(false);
  });

  it('reply normalisation (Windows adds the report id)', () => {
    const r = new Uint8Array(REPORT_SIZE);
    r[0] = 2;
    r[6] = 7;
    expect(normalizeReply(r)[6]).toBe(7);
    const w = new Uint8Array(REPORT_SIZE + 1);
    w.set(r, 1);
    expect(normalizeReply(w)[6]).toBe(7);
    expect(normalizeReply(w)[0]).toBe(2);
  });

  it('effect list and regions', () => {
    const r = new Uint8Array(REPORT_SIZE);
    r.set([0, 1, 30, 15, 5, 6, 0, 1, 13, 18, 19, 99], 6);
    expect(parseEffectList(r)).toEqual([0, 1, 19]);
    expect(mergeRegions([0, 1, 2])).toEqual([0, 2]);
    expect(mergeRegions([1, 0])).toEqual([1]);
  });

  it('plans per-key changes and groups packets', () => {
    const old: KeyTrig[] = CAPS.map(() => ({ func: 0, travel: 0, press: 0, release: 0 }));
    old[pos(W)] = { func: 2, travel: 0.5, press: 0.1, release: 0.2 };
    old[pos(FN)] = { func: 5, travel: 0, press: 0, release: 0 }; // DKS
    const labels = CAPS.map((k) => k.label);
    const travel = old.map((k) => (k.func === 2 ? k.travel : 1.2));
    const rapid = old.map((k) => k.func === 2);
    const sens = old.map((k) => (k.func === 2 ? k.press : 0.3));
    expect(planKeyTrigs(old, labels, 1.2, 0.3, U, R, travel, rapid, sens)).toEqual([]);
    // A -> 0.5 mm single, S -> RT, W sensitivity unchanged keeps split release
    const t = travel.slice();
    t[pos(A)] = 0.5;
    t[pos(W)] = 0.6;
    const rp = rapid.slice();
    rp[pos(62)] = true;
    const ch = planKeyTrigs(old, labels, 1.2, 0.3, U, R, t, rp, sens);
    expect(ch).toEqual([
      [pos(W), { func: 2, travel: 0.6, press: 0.1, release: 0.2 }],
      [pos(A), { func: 1, travel: 0.5, press: 0, release: 0 }],
      [pos(62), { func: 2, travel: 1.2, press: 0.3, release: 0.3 }],
    ]);
    const pk = planPackets(ch, CAPS, U);
    expect(pk).toHaveLength(3);
    expect(pk.every((f) => allowed(f))).toBe(true);
    // special key can't be edited here
    const t2 = travel.slice();
    t2[pos(FN)] = 2;
    expect(() => planKeyTrigs(old, labels, 1.2, 0.3, U, R, t2, rapid, sens)).toThrow(/Fn uses a special/);
    expect(() => planKeyTrigs(old, labels, 1.2, 0.3, U, R, [1], rapid, sens)).toThrow(/Re-read/);
    // many keys with the same value: batches of 18 (single) / 8 (RT on TravelVersion 2)
    const all = CAPS.map((_, i) => [i, { func: 1, travel: 1, press: 0, release: 0 }] as [number, KeyTrig]);
    expect(planPackets(all, CAPS, U)).toHaveLength(4);
    const allRt = CAPS.map((_, i) => [i, { func: 2, travel: 1, press: 0.1, release: 0.1 }] as [number, KeyTrig]);
    expect(planPackets(allRt, CAPS, U)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------------------------

const setupKeys = (f: FakeDareu) => {
  f.keys.set(W, { func: 2, travel: 100, press: 20, release: 40 }); // RT 0.5 / 0.1 / 0.2
  f.keys.set(A, { func: 1, travel: 80, press: 0, release: 0 }); // single 0.4 mm
  f.keys.set(FN, { func: 5, travel: 0, press: 0, release: 0 }); // DKS
};

describe('fake A68', () => {
  it('matches only the command collection', () => {
    const f = new FakeDareu();
    expect(dareuFactory.match(f.asDevice())).toBe(true);
    const other = new FakeDareu({ pid: 0x0137 }); // Jm firmware board
    expect(dareuFactory.match(other.asDevice())).toBe(false);
    const wrongId = new FakeDareu({ pid: 0x0210 }); // FwType 1 needs report 0x0A
    expect(dareuFactory.match(wrongId.asDevice())).toBe(false);
    expect(dareuFactory.match(new FakeDareu({ pid: 0x0210, reportId: 0x0a }).asDevice())).toBe(true);
    const kbd = new FakeDareu();
    kbd.collections = [{ usagePage: 0x01, usage: 0x06, featureReports: [] }] as unknown as HIDCollectionInfo[];
    expect(dareuFactory.match(kbd.asDevice())).toBe(false);
  });

  it('reads everything', async () => {
    const [f, d] = await connect({}, setupKeys);
    expect(d.brand()).toBe('DAREU');
    expect(d.model()).toBe('A68');
    expect(d.verified).toBe(false);
    expect(d.layout?.()).toHaveLength(68);
    const ss = await d.read();
    expect((find(ss, 'fw').value as { text: string }).text).toBe('0.4.6');
    expect(find(ss, 'polling').value).toEqual({ kind: 'choice', options: [['1000 Hz', 8], ['8000 Hz', 1]], current: 8 });
    expect(find(ss, 'actuation').value).toMatchObject({ kind: 'float', min: 0.1, max: 3.3, step: 0.01, current: 1.2 });
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    expect(find(ss, 'rt_sens').value).toMatchObject({ current: 0.1 });
    const pk = find(ss, 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;
    expect(pk.keys).toHaveLength(68);
    expect(pk.travel[pos(W)]).toBe(0.5);
    expect(pk.rapid[pos(W)]).toBe(true);
    expect(pk.sens[pos(W)]).toBe(0.1);
    expect(pk.travel[pos(A)]).toBe(0.4);
    expect(pk.travel[pos(62)]).toBe(1.2);
    expect(find(ss, 'light_power').value).toEqual({ kind: 'toggle', on: true });
    const mode = find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>;
    expect(mode.current).toBe(1);
    expect(mode.options.map((o) => o[1])).toEqual([1, 2, 4, 11, 19, 20, 21, 22, 24, 25, 27, 28]);
    expect(find(ss, 'light_bri').value).toMatchObject({ min: 0, max: 100, current: 80 }); // 204 -> floor(204 * 100 / 255)
    expect(find(ss, 'light_speed').value).toMatchObject({ current: 2 });
    expect(find(ss, 'light_color').value).toEqual({ kind: 'color', rgb: 0xff0040 });
    expect(find(ss, 'light_rainbow').value).toEqual({ kind: 'toggle', on: false });
    // reading sends no writes at all
    expect(f.sent.every((p) => (p[3] & GET) !== 0)).toBe(true);
    // one key-function request per key, single/RT values only for those keys
    expect(f.wrote(CLS.MAGNETIC, MAG.KEY_FUNCTION | GET)).toHaveLength(68);
    expect(f.wrote(CLS.MAGNETIC, MAG.SINGLE_TRIGGER | GET)).toHaveLength(1);
    expect(f.wrote(CLS.MAGNETIC, MAG.RAPID_TRIGGER | GET)).toHaveLength(1);
  });

  it('works with Windows-style replies and busy polls', async () => {
    const [, d] = await connect({ windows: true, busy: 2 });
    const ss = await d.read();
    expect((find(ss, 'fw').value as { text: string }).text).toBe('0.4.6');
    expect(find(ss, 'per_key_trigger')).toBeDefined();
    // reads every key through busy polls: slow on a loaded machine
  }, 30000);

  it('a board that never answers is not claimed', async () => {
    const f = new FakeDareu();
    f.receiveFeatureReport = async () => new DataView(new Uint8Array(REPORT_SIZE).buffer);
    expect(await dareuFactory.create(f.asDevice())).toBeNull();
    expect(f.opened).toBe(false);
  });

  it('writes polling rate', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const p = find(ss, 'polling');
    await d.write(withValue(p, { ...(p.value as Extract<Value, { kind: 'choice' }>), current: 1 }));
    expect(f.rate).toBe(1);
    await expect(d.write(withValue(p, { ...(p.value as Extract<Value, { kind: 'choice' }>), current: 2 }))).rejects.toThrow(/unsupported/);
  });

  it('writes lighting with read-back', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    await d.write(withValue(find(ss, 'light_mode'), { ...(find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>), current: 2 }));
    expect(f.effect.effect).toBe(2);
    await d.write(withValue(find(ss, 'light_color'), { kind: 'color', rgb: 0x00ff00 }));
    expect(f.effect.colors).toEqual([[0, 0xff, 0]]);
    await d.write(withValue(find(ss, 'light_rainbow'), { kind: 'toggle', on: true }));
    expect(f.effect.colors).toEqual([]);
    await d.write(withValue(find(ss, 'light_rainbow'), { kind: 'toggle', on: false }));
    expect(f.effect.colors).toEqual([[0, 0xff, 0]]);
    await d.write(withValue(find(ss, 'light_speed'), { kind: 'number', min: 1, max: 3, current: 3, unit: '' }));
    expect(f.effect.speed).toBe(3);
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: false }));
    expect(f.effect.effect).toBe(0);
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: true }));
    expect(f.effect.effect).toBe(2);
    await d.write(withValue(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 100, current: 100, unit: '%' }));
    expect(f.bri).toBe(255);
    await d.write(withValue(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 100, current: 50, unit: '%' }));
    expect(f.bri).toBe(128); // vendor: smallest raw that shows 50 %
    const set = f.wrote(CLS.LIGHTING, LED.EFFECT);
    expect(set.every((p) => p[4] === 1)).toBe(true); // active profile
  });

  it('reports a write the board ignored', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    await expect(d.write(withValue(find(ss, 'light_mode'), { ...(find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>), current: 4 }))).rejects.toThrow(/didn't take/);
    const pk = find(ss, 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const t = pk.travel.slice();
    t[pos(62)] = 2;
    await expect(d.write(withValue(find(ss, 'per_key_trigger'), { ...pk, travel: t }))).rejects.toThrow(/didn't take the trigger change for: S/);
  });

  it('writes per-key triggers', async () => {
    const [f, d] = await connect({}, setupKeys);
    const ss = await d.read();
    const s = find(ss, 'per_key_trigger');
    const pk = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = pk.travel.slice();
    const rapid = pk.rapid.slice();
    const sens = pk.sens.slice();
    travel[pos(62)] = 0.8; // S: normal -> single 0.8
    rapid[pos(63)] = true; // D: RT at 1.2, sens 0.3 default... from W: 0.1
    sens[pos(63)] = 0.05;
    rapid[pos(W)] = false; // W: RT -> single at 0.5
    const before = f.sent.length;
    await d.write(withValue(s, { ...pk, travel, rapid, sens }));
    expect(f.key(62)).toEqual({ func: 1, travel: 160, press: 0, release: 0 });
    expect(f.key(63)).toEqual({ func: 2, travel: 240, press: 10, release: 10 });
    expect(f.key(W)).toEqual({ func: 1, travel: 100, press: 0, release: 0 });
    expect(f.key(A)).toEqual({ func: 1, travel: 80, press: 0, release: 0 }); // untouched
    const writes = f.sent.slice(before).filter((p) => (p[3] & GET) === 0);
    expect(writes).toHaveLength(3);
    // DKS key can't be changed from here
    const t2 = pk.travel.slice();
    t2[pos(FN)] = 2;
    await expect(d.write(withValue(s, { ...pk, travel: t2 }))).rejects.toThrow(/special key function/);
    expect(f.key(FN).func).toBe(5);
  });

  it('global actuation / rapid trigger / sensitivity rewrite every editable key', async () => {
    const [f, d] = await connect({}, setupKeys);
    let ss = await d.read();
    await d.write(withValue(find(ss, 'actuation'), { ...(find(ss, 'actuation').value as Extract<Value, { kind: 'float' }>), current: 1.5 }));
    for (const k of CAPS) {
      if (k.index === FN) continue;
      const fk = f.key(k.index);
      expect(fk.travel, k.label).toBe(300);
      expect(fk.func, k.label).toBe(k.index === W ? 2 : 1);
    }
    expect(f.key(FN).func).toBe(5);
    expect(f.wrote(CLS.MAGNETIC, MAG.GLOBAL_TRAVEL)).toHaveLength(0); // never SET
    ss = await d.read();
    expect(find(ss, 'actuation').value).toMatchObject({ current: 1.5 });
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    for (const k of CAPS) if (k.index !== FN) expect(f.key(k.index), k.label).toMatchObject({ func: 2, travel: 300, press: 20, release: k.index === W ? 40 : 20 });
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true });
    await d.write(withValue(find(ss, 'rt_sens'), { ...(find(ss, 'rt_sens').value as Extract<Value, { kind: 'float' }>), current: 0.25 }));
    for (const k of CAPS) if (k.index !== FN) expect(f.key(k.index)).toMatchObject({ func: 2, press: 50, release: 50 });
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: false }));
    for (const k of CAPS) if (k.index !== FN) expect(f.key(k.index)).toMatchObject({ func: 1, travel: 300 });
  });

  it('never sends a frame outside the allowlist (fake enforces it) and no reset/DFU/calibration', async () => {
    const [f, d] = await connect({}, setupKeys);
    const ss = await d.read();
    for (const s of ss) {
      if (s.value.kind === 'text') {
        await expect(d.write(s)).rejects.toThrow(/can't be changed/);
        continue;
      }
      try {
        await d.write(s);
      } catch {
        // unchanged writes may legitimately fail read-back checks; we only care what went out
      }
    }
    for (const p of f.sent) {
      expect(allowed(p)).toBe(true);
      expect([9, 10, 12]).not.toContain(p[2]);
      expect(p[2] === CLS.DEVICE && (p[3] & 0x7f) === 8).toBe(false);
      expect(p[2] === CLS.MAGNETIC && (p[3] & 0x7f) === 10).toBe(false);
    }
    expect(f.wrote(CLS.DEVICE, DEV.POLLING).length).toBeLessThanOrEqual(1);
  });

  it('non-magnetic FwType 0 board: no switch settings, layout from JSON', async () => {
    const [, d] = await connect({ pid: 0x0060, noMagnetic: true });
    const ss = await d.read();
    expect(ss.find((s) => s.key === 'per_key_trigger')).toBeUndefined();
    expect(ss.find((s) => s.key === 'actuation')).toBeUndefined();
    expect(d.model()).toBe('EK87 PRO');
    expect(d.layout?.().length).toBe(87);
    expect(find(ss, 'light_mode')).toBeDefined();
  });

  it('FwType 1 board uses feature report 0x0A', async () => {
    const [f, d] = await connect({ pid: 0x0210, reportId: 0x0a, noMagnetic: true });
    const ss = await d.read();
    expect(find(ss, 'polling')).toBeDefined();
    expect(f.sent.length).toBeGreaterThan(3);
  });

  it('A98 RT: magnetic settings hidden (unknown step)', async () => {
    const [f, d] = await connect({ pid: 0x0136 });
    const ss = await d.read();
    expect(ss.find((s) => s.key === 'per_key_trigger')).toBeUndefined();
    expect(find(ss, 'unsupported')).toBeDefined();
    expect(f.wrote(CLS.MAGNETIC, MAG.GLOBAL_TRAVEL | GET)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// SOCD (class 13 cmd 11, 4 groups)

describe('SOCD', () => {
  const D = 63;
  const S = 62;

  it('frames match the vendor (incl. the RemoveBindingEx size quirk)', () => {
    expect(head(getSocdPkt(A), 9)).toEqual(hex('00 03 0D 8B 00 00 01 3D 00'));
    expect(head(setSocdPkt(A, 2), 9)).toEqual(hex('00 03 0D 0B 00 00 01 3D 02'));
    expect(head(removeSocdPkt([A, D]), 12)).toEqual(hex('00 03 0D 0B 00 00 02 3D FF 3F FF 00'));
    expect(head(removeSocdPkt([A]), 10)).toEqual(hex('00 02 0D 0B 00 00 01 3D FF 00'));
    expect(() => setSocdPkt(A, 4)).toThrow();
    expect(() => removeSocdPkt([])).toThrow();
    expect(() => removeSocdPkt(Array.from({ length: 11 }, (_, i) => i + 1))).toThrow();
    const ten = removeSocdPkt(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(ten[1]).toBe(11);
    for (const f of [getSocdPkt(A), setSocdPkt(A, 0), setSocdPkt(A, 3), removeSocdPkt([A]), removeSocdPkt([A, D]), ten]) expect(allowed(f), head(f).join(' ')).toBe(true);
  });

  it('allowlist refuses anything else on cmd 11', () => {
    const no = [
      frame(13, 11, 3, 0, [1, A, 4]), // group 5
      frame(13, 11, 3, 0, [1, 0, 1]), // key 0
      frame(13, 11, 3, 1, [1, A, 1]), // profile byte
      frame(13, 11, 4, 0, [1, A, 1, 1]), // junk
      frame(13, 11 | GET, 3, 0, [1, A, 1]), // get with data
      frame(13, 11 | GET, 4, 0, [2, A, 0, D]), // bulk get not used
      frame(13, 11, 5, 0, [2, A, 0xff, D, 0xff]), // "honest" size: not what the vendor sends
      frame(13, 11, 3, 0, [2, A, 0xfe, D, 0xff]), // wrong marker
      frame(13, 11, 3, 0, [2, A, 0xff, D, 0xff, 7]), // trailing junk
      frame(13, 11, 12, 0, [11, ...Array.from({ length: 11 }, (_, i) => [i + 1, 0xff]).flat()]), // > 10 keys
      frame(13, 17, 2, 1, [1, A]), // FUNC_AND_SOCD is read-only
      frame(13, 17 | GET, 5, 1, [1, A, 0, 0, 0]), // FUNC_AND_SOCD with an "honest" size byte
      frame(13, 1, 11, 0, [10, ...Array.from({ length: 10 }, (_, i) => i + 1)]), // bulk normal-trigger reset
    ];
    for (const f of no) expect(allowed(f), head(f).join(' ')).toBe(false);
  });

  it('plan: one group per key', () => {
    const v = (entries: number[][]): Socd => ({ kind: 'socd', mode: 'groups', keys: CAPS, max: 4, modes: [['Last input', 0]], entries: entries.map((keys) => ({ keys, mode: 0 })) });
    const want = planSocd(v([[pos(A), pos(D)], [], [pos(W)], []]), CAPS);
    expect(want[pos(A)]).toBe(0);
    expect(want[pos(W)]).toBe(2);
    expect(want.filter((g) => g >= 0)).toHaveLength(3);
    expect(() => planSocd(v([[pos(A)], [pos(A)], [], []]), CAPS)).toThrow(/A is in two/);
    expect(() => planSocd(v([[pos(A)], [], []]), CAPS)).toThrow(/Re-read/);
    expect(() => planSocd(v([[999], [], [], []]), CAPS)).toThrow(/Re-read/);
  });

  it('reads groups per key with GETs only', async () => {
    const [f, d] = await connect({}, (f) => {
      setupKeys(f);
      f.socd.set(A, 0);
      f.socd.set(D, 0);
      f.socd.set(W, 1);
    });
    const ss = await d.read();
    const v = find(ss, 'socd').value as Socd;
    expect(find(ss, 'socd').group).toBe('Switches');
    expect(v).toMatchObject({ kind: 'socd', mode: 'groups', max: 4, removable: true, modes: [['Last input', 0]] });
    expect(v.entries.map((e) => e.keys)).toEqual([[pos(A), pos(D)].sort((a, b) => a - b), [pos(W)], [], []]);
    expect(v.unavailable).toEqual([pos(FN)]); // DKS key
    expect(f.wrote(CLS.MAGNETIC, MAG.SOCD | GET)).toHaveLength(68);
    expect(f.wrote(CLS.MAGNETIC, MAG.SOCD)).toHaveLength(0);
  });

  it('only on products whose JSON says SupportSOCD', async () => {
    expect(SOCD_PIDS.has(0x0175)).toBe(true);
    expect(SOCD_PIDS.has(0x0107)).toBe(false);
    for (const pid of SOCD_PIDS) expect(productFor(pid)?.fw, pid.toString(16)).toBe(6);
    // the fake only speaks TravelVersion 2 (A68): pretend the A68 JSON lacked the flag
    SOCD_PIDS.delete(0x0175);
    try {
      const [g, e] = await connect();
      expect((await e.read()).some((s) => s.key === 'socd')).toBe(false);
      expect(g.wrote(CLS.MAGNETIC, MAG.SOCD | GET)).toHaveLength(0);
    } finally {
      SOCD_PIDS.add(0x0175);
    }
  });

  it('adds, moves and removes keys, then reads them back', async () => {
    const [f, d] = await connect({}, (f) => {
      setupKeys(f);
      f.socd.set(S, 3);
    });
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ keys: [pos(A), pos(D)], mode: 0 }, { keys: [pos(S)], mode: 0 }, { keys: [], mode: 0 }, { keys: [], mode: 0 }] }));
    expect([...f.socd.entries()].sort((a, b) => a[0] - b[0])).toEqual([[S, 1], [D, 0], [A, 0]].sort((a, b) => a[0] - b[0]));
    expect(f.wrote(CLS.MAGNETIC, MAG.SOCD)).toHaveLength(3);
    // trigger functions are untouched on 0.3.0+ firmware
    expect(f.key(A).func).toBe(1);
    // remove A and S in one RemoveBindingEx frame
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ keys: [pos(D)], mode: 0 }, { keys: [], mode: 0 }, { keys: [], mode: 0 }, { keys: [], mode: 0 }] }));
    const rm = f.wrote(CLS.MAGNETIC, MAG.SOCD);
    expect(rm).toHaveLength(1);
    expect(rm[0][1]).toBe(3); // n + 1, vendor quirk
    expect([...f.socd.keys()]).toEqual([D]);
    expect(f.wrote(CLS.MAGNETIC, MAG.SOCD | GET)).toHaveLength(2); // read back
    // unchanged: nothing sent
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ keys: [pos(D)], mode: 0 }, { keys: [], mode: 0 }, { keys: [], mode: 0 }, { keys: [], mode: 0 }] }));
    expect(f.sent).toHaveLength(0);
  });

  it('refuses keys with another special function and reports ignored writes', async () => {
    const [f, d] = await connect({}, setupKeys);
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    await expect(d.write(withValue(s, { ...v, entries: [{ keys: [pos(FN)], mode: 0 }, ...v.entries.slice(1)] }))).rejects.toThrow(/special function/);
    expect(f.sent).toHaveLength(0);
    const [, e] = await connect({ ignoreWrites: true }, setupKeys);
    const t = find(await e.read(), 'socd');
    await expect(e.write(withValue(t, { ...v, entries: [{ keys: [pos(A)], mode: 0 }, ...v.entries.slice(1)] }))).rejects.toThrow(/didn't take the SOCD change for: A/);
  });

  it('firmware below 0.3.0: can add, never removes (no trigger wipe)', async () => {
    const [f, d] = await connect({}, (f) => {
      setupKeys(f);
      f.fw = [0, 2, 9];
      f.socd.set(D, 0);
    });
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    expect(v.removable).toBe(false);
    expect(s.hint).toMatch(/DAREU app/);
    f.sent = [];
    await expect(d.write(withValue(s, { ...v, entries: [{ keys: [], mode: 0 }, ...v.entries.slice(1)] }))).rejects.toThrow(/can't take keys out/);
    expect(f.sent).toHaveLength(0);
    await d.write(withValue(s, { ...v, entries: [{ keys: [pos(D), pos(A)], mode: 0 }, ...v.entries.slice(1)] }));
    expect(f.socd.get(A)).toBe(0);
    expect(f.sent.some((p) => p[2] === CLS.MAGNETIC && p[3] === 1)).toBe(false); // never the normal-trigger reset
  });
});

// ---------------------------------------------------------------------------------------------

describe('diagnose (read-only lighting probe)', () => {
  const allGets = (f: FakeDareu, from: number) => {
    const frames = f.sent.slice(from);
    expect(frames.length).toBeGreaterThan(0);
    for (const fr of frames) expect(fr[3] & GET, `frame ${head(fr, 8).join(' ')}`).toBe(GET);
    return frames;
  };

  it('A68 0.4.6: only GET frames, probes 03/84..88, reports firmware answers', async () => {
    const [f, d] = await connect();
    await d.read();
    const from = f.sent.length;
    const progress: [number, number][] = [];
    const rep = await d.diagnose!((a, b) => progress.push([a, b]));
    const frames = allGets(f, from);
    // the never-used lighting ids, GET form only, [region] payload, profile byte 0
    for (const cmd of [0x84, 0x85, 0x86, 0x87, 0x88]) {
      const fr = f.wrote(CLS.LIGHTING, cmd);
      expect(fr).toHaveLength(1);
      expect(head(fr[0], 8)).toEqual([0, 1, 3, cmd, 0, 0, 0, 0]);
    }
    // nothing outside the GET ids we name
    const seen = new Set(frames.map((fr) => `${fr[2]}/${fr[3]}`));
    expect([...seen].sort()).toEqual(['0/128', '3/128', '3/129', '3/130', '3/131', '3/132', '3/133', '3/134', '3/135', '3/136', '5/131'].sort());
    expect(rep).toMatch(/GET FRAME \(03\/84\) r0: 00 01 03 84 00 00 00 00 -> unsupported: 05 01 03 84/);
    expect(rep).toMatch(/GET CAL_DATA \(03\/85\) r0: .* -> done: 02 01 03 85 00 00 = answered, no data/);
    expect(rep).toMatch(/GET CUSTOM \(03\/88\) r0: .* -> unsupported/);
    expect(rep).toContain('firmware: 00 03 00 80 00 00 00 00 -> done: 02 03 00 80 00 00 00 04 06 = version 0.4.6');
    expect(rep).toContain('custom frame effect(s) 13, 14 PRESENT');
    expect(rep).toContain('no streaming effect 18');
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last[0]).toBe(last[1]);
    // diagnose leaves the device usable: a normal read afterwards still works
    await expect(d.read()).resolves.toBeTruthy();
  });

  it('other firmware build: undocumented ids are not sent', async () => {
    const [f, d] = await connect(undefined, (x) => (x.fw = [0, 4, 7]));
    const from = f.sent.length;
    const rep = await d.diagnose!();
    allGets(f, from);
    for (const cmd of [0x84, 0x85, 0x86, 0x87, 0x88]) expect(f.wrote(CLS.LIGHTING, cmd)).toHaveLength(0);
    expect(rep).toContain('not sent');
  });

  it('silent / missing lighting: no throw, reports no answer', async () => {
    for (const o of [{ ledProbe: 'silent' as const }, { noLighting: true }]) {
      const [f, d] = await connect(o);
      const from = f.sent.length;
      const rep = await d.diagnose!();
      allGets(f, from);
      expect(rep).toContain('no answer');
    }
  });

  it('busy replies and Windows framing are handled; data answers are flagged', async () => {
    const [f, d] = await connect({ busy: 2, windows: true, ledProbe: 'data' });
    const from = f.sent.length;
    const rep = await d.diagnose!();
    allGets(f, from);
    expect(rep).toMatch(/GET FRAME \(03\/84\).*ANSWERED WITH DATA/);
  });

  it('allowlist: SET forms of the probe ids are refused', () => {
    for (const cmd of [4, 5, 6, 7, 8]) {
      expect(allowed(frame(CLS.LIGHTING, cmd, 1, 0, [0]))).toBe(false);
      expect(allowed(frame(CLS.LIGHTING, cmd | GET, 1, 0, [0]))).toBe(true);
      expect(allowed(frame(CLS.LIGHTING, cmd | GET, 1, 1, [0]))).toBe(false);
      expect(allowed(frame(CLS.LIGHTING, cmd | GET, 2, 0, [0, 1]))).toBe(false);
    }
    expect(allowed(frame(CLS.LIGHTING, 9 | GET, 1, 0, [0]))).toBe(false);
  });
});
