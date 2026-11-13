import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeKeyboard, type FakeOpts } from './fakes/fake-keyboard';
import type { Driver, Setting, Value } from './types';
import {
  COLOR_PAGES,
  COLOR_TABLE,
  TRIG_FIXED,
  TRIG_RT,
  TRIG_RT_SPLIT,
  W75_CAPS,
  W75_KEYS,
  allowed,
  applyColors,
  groupKeyTrigs,
  keyRgb,
  parseColorPage,
  parseInfo,
  parseKeyTrig,
  parseLight,
  parseMaxTravel,
  parseModeList,
  sameTrig,
  describeTrig,
  sensMaxUnits,
  perKeyTriggerValue,
  planKeyTrigs,
  readColorsPkt,
  readInfoPkt,
  readPollPkt,
  readMaxTravelPkt,
  readTrigPkt,
  setColorsPkts,
  setLightPkt,
  setPollPkt,
  setTrigPkt,
  wraithFactory,
  keyBitmap,
  parseTravelSample,
  wraithTiming,
  type KeyTrig,
  type Trig,
} from './wraith';
import { SOCD_MAX, SOCD_UNAVAILABLE, W75_HID, parseSocdPage, parseSocdPower, planSocdPairs, readSocdPairsPkt, readSocdPowerPkt, setSocdPairsPkts, setSocdPowerPkt, socdValue } from './wraith';
import type { Socd } from './types';
import {
  KEYMAP_PAGES,
  KEYMAP_SLOTS,
  KEYMAP_TABLE,
  WRAITH_KEY_CATS,
  WR_DEFAULT,
  WR_GP_CLASSIC,
  WR_GP_XBOX,
  WR_OPAQUE,
  codeOfEntry,
  entryOfCode,
  gamepadModeOfPid,
  parseKeymapPage,
  readKeymapPkt,
  setGamepadModePkt,
  setKeymapPkts,
  type Entry,
} from './wraith';
import { categories, describe as describeKc, label, search } from '../lib/keycodes';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const pos = (key: number) => W75_CAPS.findIndex((k) => k.index === key);

// tests shorten the shared timings; put the real ones back afterwards
const realTiming = { ...wraithTiming };
afterAll(() => {
  Object.assign(wraithTiming, realTiming);
});
beforeAll(() => {
  Object.assign(wraithTiming, { reply: 40, colors: 60, keymap: 60, send: 0, page: 0, settle: 0, poll: 0 });
});

// ---------------------------------------------------------------------------------------------
// fake keyboard

async function connect(o?: FakeOpts): Promise<[FakeKeyboard, Driver]> {
  const f = new FakeKeyboard(o);
  const d = await wraithFactory.create(f.asDevice());
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
// pure protocol tests (mirrors wraith.rs)

describe('packets', () => {
  it('read packets match the verified probe', () => {
    expect(readPollPkt()).toEqual(hex('21 00 00 00 01 09'));
    expect(readMaxTravelPkt()).toEqual(hex('21 00 00 00 18 04'));
    expect(readTrigPkt(0)).toEqual(hex('21 00 00 00 18 05 00 00'));
    expect(readTrigPkt(46)).toEqual(hex('21 00 00 00 18 05 02 02'));
    expect(readTrigPkt(125)).toEqual(hex('21 00 00 00 18 05 05 0F'));
    expect(readInfoPkt()).toEqual([0x0d]);
  });

  it('poll packet', () => {
    expect(setPollPkt(8)).toEqual(hex('21 00 00 00 00 09 01 08'));
    expect(allowed(setPollPkt(4))).toBe(true);
    expect(allowed(setPollPkt(3))).toBe(false);
  });

  it('light packet roundtrip', () => {
    const l = parseLight(hex('07 00 00 00 0c 0a 04 03 ff aa ff 00 00 00 00 01 01'))!;
    expect(l).toEqual({ mode: 10, bri: 4, speed: 3, fg: [0xff, 0xaa, 0xff], bg: [0, 0, 0], dir: 0, fullColor: 1, power: 1 });
    const p = setLightPkt({ ...l, mode: 0, bri: 2 });
    expect(p).toEqual(hex('07 00 00 00 0e 00 02 03 ff aa ff 00 00 00 00 01 01'));
    expect(allowed(p)).toBe(true);
  });

  it('mode list', () => {
    const [modes, speed, bri] = parseModeList(hex('0a 00 00 00 12 02 01 03 09 04 00 0e 0f 06 07 0b 0c 10 08 a5 5a 04 04'))!;
    expect(modes).toEqual([2, 1, 3, 9, 4, 0, 14, 15, 6, 7, 11, 12, 16, 8, 10]);
    expect([speed, bri]).toEqual([4, 4]);
  });

  it('info', () => {
    const r = [...hex('0d 00 00 00 32'), ...new TextEncoder().encode('W669,34,KB,ML,W75HEARGB,V3.13.03'), 0, 0, 0];
    expect(parseInfo(r)).toEqual(['W75HEARGB', 'V3.13.03']);
  });

  it('trigger packet', () => {
    const p = setTrigPkt(TRIG_RT, 85, 5, 5, [0, 46, 125]);
    expect(p.length).toBe(36);
    expect(p.slice(0, 6)).toEqual(hex('21 00 00 00 18 0c'));
    const bm = new Array(22).fill(0);
    bm[0] = 0x01;
    bm[2] = 0x04;
    bm[15] = 0x20;
    expect(p.slice(6, 28)).toEqual(bm);
    expect(p.slice(28, 36)).toEqual(hex('55 55 05 05 00 00 00 00'));
    expect(allowed(p)).toBe(true);
    expect(setTrigPkt(TRIG_FIXED, 0x0123, 0x0201, 0x0302, [0]).slice(28, 36)).toEqual(hex('23 23 01 02 01 01 02 03'));
  });

  it('all-keys bitmap excludes the knob', () => {
    const p = setTrigPkt(TRIG_FIXED, 85, 1, 1, W75_KEYS);
    const bits = p.slice(6, 28).reduce((n, b) => n + b.toString(2).split('1').length - 1, 0);
    expect(bits).toBe(81);
    expect(W75_KEYS.length).toBe(81);
    expect(p[6 + 15] & 1).toBe(0);
  });

  it('trigger builder refuses reset / calibration ops', () => {
    expect(() => setTrigPkt(0x06, 0, 0, 0, [])).toThrow();
    expect(() => setTrigPkt(0x07, 0, 0, 0, [])).toThrow();
  });

  it('key trig reply', () => {
    const r = hex('21 00 00 00 0a 05 00 55 55 01 01 00 00 00 00');
    expect(parseKeyTrig(r)).toEqual({ mode: 0, travel: 85, press: 1, release: 1 });
    r[6] = 0x0c;
    r[11] = 1;
    r[13] = 2;
    expect(parseKeyTrig(r)).toEqual({ mode: 0x0c, travel: 0x155, press: 0x201, release: 1 });
    expect(parseKeyTrig(r.slice(0, 10))).toBeUndefined();
  });

  it('travel range parsed like the official readHidData', () => {
    // verified W75 probe reply: max 0xAA, unit 2 (0.02 mm), min 5
    expect(parseMaxTravel(hex('21 00 00 00 06 04 aa 02 02 00 05'))).toEqual({ unit: 2, min: 5, max: 170 });
    // official fallbacks: d7 = 0 -> 0.10 mm units; d10 = 0 -> 3 at 0.04 mm units, else 1
    expect(parseMaxTravel(hex('21 00 00 00 06 04 22 00 00 00 00'))).toEqual({ unit: 10, min: 1, max: 34 });
    expect(parseMaxTravel(hex('21 00 00 00 06 04 55 04 00 00 00'))).toEqual({ unit: 4, min: 3, max: 85 });
    expect(parseMaxTravel(hex('21 00 00 00 06 04 55 04 00'))).toBeUndefined();
    // RT press/release sliders: 1 .. ceil(max / 2) units (W75: 85 x 0.02 = 1.70 mm)
    expect(sensMaxUnits({ max: 170 })).toBe(85);
    expect(sensMaxUnits({ max: 35 })).toBe(18);
  });

  it('read-back compares only what the mode uses', () => {
    const fixed = { mode: TRIG_FIXED, travel: 50, press: 5, release: 5 };
    expect(sameTrig({ ...fixed, press: 0, release: 0 }, fixed)).toBe(true);
    expect(sameTrig({ ...fixed, travel: 51 }, fixed)).toBe(false);
    expect(sameTrig({ ...fixed, mode: TRIG_RT }, fixed)).toBe(false);
    const rt = { mode: TRIG_RT, travel: 50, press: 5, release: 5 };
    expect(sameTrig({ ...rt, release: 9 }, rt)).toBe(true);
    expect(sameTrig({ ...rt, press: 6 }, rt)).toBe(false);
    const split = { mode: TRIG_RT_SPLIT, travel: 50, press: 5, release: 7 };
    expect(sameTrig({ ...split }, split)).toBe(true);
    expect(sameTrig({ ...split, release: 5 }, split)).toBe(false);
    expect(describeTrig(rt, 2)).toBe('RT 1.00 mm, RT 0.10/0.10 mm');
    expect(describeTrig({ ...fixed, mode: 0x55 }, 2)).toBe('mode 55 1.00 mm, RT 0.10/0.10 mm');
  });

  it('colour packets', () => {
    expect(COLOR_PAGES).toBe(8);
    const table = new Uint8Array(COLOR_TABLE).map((_, i) => i & 0xff);
    const pk = setColorsPkts(1, table);
    expect(pk.length).toBe(8);
    pk.forEach((p, pg) => {
      const len = pg === 7 ? 18 : 54;
      expect(p.slice(0, 5)).toEqual([0x09, 0x01, 0x00, pg, len]);
      expect(p.length).toBe(5 + len);
      expect(p.slice(5)).toEqual(Array.from(table.subarray(pg * 54, pg * 54 + len)));
      expect(allowed(p)).toBe(true);
    });
    const back = new Uint8Array(COLOR_TABLE);
    for (const p of pk) parseColorPage([p[0], 0x81, ...p.slice(2)], back);
    expect(back).toEqual(table);
    const colors = new Array(W75_CAPS.length).fill(0);
    colors[pos(46)] = 0x123456;
    colors[pos(125)] = 0xabcdef;
    const t = applyColors(table, colors);
    expect(Array.from(t.subarray(46 * 3, 46 * 3 + 3))).toEqual([0x12, 0x34, 0x56]);
    expect(keyRgb(t, 125)).toBe(0xabcdef);
    expect(keyRgb(t, 0)).toBe(0);
    expect(Array.from(t.subarray(45, 48))).toEqual(Array.from(table.subarray(45, 48)));
    expect(readColorsPkt(0)).toEqual(hex('09 80'));
    expect(readColorsPkt(1)).toEqual(hex('09 81'));
  });

  it('layout sanity', () => {
    expect(W75_CAPS.length).toBe(81);
    const idx = [...new Set(W75_CAPS.map((k) => k.index))].sort((a, b) => a - b);
    expect(idx).toEqual([...W75_KEYS].sort((a, b) => a - b));
    expect(idx).not.toContain(15);
    const label = (i: number) => W75_CAPS.find((k) => k.index === i)!.label;
    expect([label(0), label(46), label(116), label(121), label(125)]).toEqual(['Esc', 'W', 'Space', 'Fn', 'Right']);
    const e = 1e-4;
    W75_CAPS.forEach((a, i) => {
      expect(a.x + a.w).toBeLessThanOrEqual(16.25 + e);
      expect(a.y + a.h).toBeLessThanOrEqual(6.5 + e);
      for (const b of W75_CAPS.slice(i + 1)) {
        const overlap = a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
        expect(overlap, `${a.label} overlaps ${b.label}`).toBe(false);
      }
    });
    const rowEnd = (y: number) => Math.max(...W75_CAPS.filter((k) => k.y === y && k.x < 15).map((k) => k.x + k.w));
    expect([rowEnd(1.25), rowEnd(2.25), rowEnd(3.25), rowEnd(5.25)]).toEqual([15, 15, 15, 13]);
  });
});

describe('allowlist', () => {
  it('blocks dangerous commands', () => {
    for (const bad of [
      '14 00 00 00 01 01', '21 00 00 00 18 06', '21 00 00 00 18 07 00 00', '21 00 00 00 18 08', '21 00 00 00 18 09', '21 00 00 00 18 0F', '21 00 00 00 18 02 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 FF', '21 00 00 00 18 03 01',
      '26 00', '26 01', '25 01', '19 00', '22 00', '24 00', '14 01', '14 03', '17 00', '18 00', '18 02',
      '09 00', '09 02', '09 FF', '09 82', '09 80 01', '09 20 00 01', '0D 01', '02', '0E', '',
    ]) {
      expect(allowed(hex(bad)), bad).toBe(false);
    }
    for (const ok of ['0D', '01', '07 01', '0A', '09 20', '09 80', '09 81']) expect(allowed(hex(ok)), ok).toBe(true);
  });

  it('per-key pages and set packets must be exact', () => {
    const pk = setColorsPkts(0, new Uint8Array(COLOR_TABLE).fill(0xff));
    const mut = (p: number[], i: number, v: number) => p.map((b, j) => (j === i ? v : b));
    expect(allowed(mut(pk[0], 1, 2))).toBe(false); // slot
    expect(allowed(mut(pk[0], 3, 8))).toBe(false); // page
    expect(allowed(mut(pk[0], 2, 1))).toBe(false); // page hi
    expect(allowed(mut(pk[0], 4, 58))).toBe(false); // len
    expect(allowed([...pk[7], 1])).toBe(false); // trailing junk
    expect(allowed(mut(pk[7], 4, 54))).toBe(false);
    expect(allowed([...pk[0], ...new Array(64 - pk[0].length).fill(1)])).toBe(false);
    const t = setTrigPkt(TRIG_RT, 50, 5, 5, [46]);
    expect(allowed(t)).toBe(true);
    expect(allowed([...t, 1])).toBe(false);
    const l = setLightPkt({ mode: 10, bri: 4, speed: 3, fg: [1, 2, 3], bg: [0, 0, 0], dir: 0, fullColor: 0, power: 0 });
    expect(allowed(l)).toBe(true);
    expect(allowed([...l, 1])).toBe(false);
  });
});

describe('per-key planning', () => {
  const trig = (): Trig => ({ mode: 0, travel: 85, press: 5, release: 5, unit: 2, min: 5, max: 170 });
  const ui = (keys: KeyTrig[]) => {
    const v = perKeyTriggerValue(trig(), keys);
    if (v.kind !== 'perKeyTrigger') throw new Error();
    expect([v.min, v.max, v.step, v.sensMin]).toEqual([0.1, 3.4, 0.02, 0.02]);
    return [v.travel, v.rapid, v.sens] as const;
  };
  const fill = (k: KeyTrig) => W75_CAPS.map(() => ({ ...k }));

  it('unchanged values plan nothing', () => {
    const old = fill({ mode: TRIG_FIXED, travel: 85, press: 1, release: 1 });
    old[3] = { mode: TRIG_RT_SPLIT, travel: 60, press: 3, release: 7 };
    old[9] = { mode: 0x55, travel: 60, press: 3, release: 7 };
    const [t, r, s] = ui(old);
    expect(planKeyTrigs(old, trig(), t, r, s)).toEqual([]);
    expect(planKeyTrigs(old, trig(), t.map((v) => v + 0.004), r, s)).toEqual([]);
  });

  it('plan and grouping', () => {
    const old = fill({ mode: TRIG_FIXED, travel: 85, press: 1, release: 1 });
    const [t0, r0, s0] = ui(old);
    const t = [...t0], r = [...r0], s = [...s0];
    for (const k of [46, 68, 69, 70]) {
      t[pos(k)] = 1.0;
      r[pos(k)] = true;
      s[pos(k)] = 0.1;
    }
    t[pos(0)] = 2.0;
    t[pos(116)] = 9.0;
    const plan = planKeyTrigs(old, trig(), t, r, s);
    expect(plan.length).toBe(6);
    const rt = { mode: TRIG_RT, travel: 50, press: 5, release: 5 };
    expect(plan).toContainEqual([pos(46), rt]);
    expect(plan).toContainEqual([pos(0), { mode: TRIG_FIXED, travel: 100, press: 1, release: 1 }]);
    expect(plan).toContainEqual([pos(116), { mode: TRIG_FIXED, travel: 170, press: 1, release: 1 }]);
    const g = groupKeyTrigs(plan);
    expect(g.length).toBe(3);
    const wasd = g.find(([k]) => k.mode === TRIG_RT)!;
    expect([...wasd[1]].sort((a, b) => a - b)).toEqual([46, 68, 69, 70]);
    const p = setTrigPkt(rt.mode, rt.travel, rt.press, rt.release, wasd[1]);
    const bm = new Array(22).fill(0);
    bm[2] |= 1 << 2;
    bm[2] |= 1 << 3;
    bm[3] |= 1 << 3;
    bm[4] |= 1 << 3;
    expect(p.slice(6, 28)).toEqual(bm);
    expect(p.slice(28, 36)).toEqual(hex('32 32 05 05 00 00 00 00'));
  });

  it('modes', () => {
    const old = fill({ mode: TRIG_FIXED, travel: 85, press: 1, release: 1 });
    old[0] = { mode: TRIG_RT_SPLIT, travel: 60, press: 3, release: 7 };
    old[1] = { mode: 0x55, travel: 60, press: 3, release: 7 };
    const [t0, r, s] = ui(old);
    const t = [...t0];
    t[0] = 1.0;
    expect(planKeyTrigs(old, trig(), t, [...r], [...s])).toEqual([[0, { mode: TRIG_RT_SPLIT, travel: 50, press: 3, release: 7 }]]);
    const s2 = [...s];
    s2[0] = 0.2;
    expect(planKeyTrigs(old, trig(), t, [...r], s2)).toEqual([[0, { mode: TRIG_RT, travel: 50, press: 10, release: 10 }]]);
    const r2 = [...r];
    r2[0] = false;
    expect(planKeyTrigs(old, trig(), t, r2, [...s])[0][1].mode).toBe(TRIG_FIXED);
    const t3 = [...t];
    t3[1] = 2.0;
    expect(() => planKeyTrigs(old, trig(), t3, [...r], [...s])).toThrow(/special trigger mode/);
    expect(() => planKeyTrigs(old, trig(), t.slice(1), [...r], [...s])).toThrow(/Re-read/);
  });
});

// ---------------------------------------------------------------------------------------------
// driver against the fake keyboard

describe('driver', () => {
  it('match / filters', () => {
    const f = new FakeKeyboard();
    expect(wraithFactory.filters).toEqual([0xc365, 0xc366, 0xc367, 0xc368].map((productId) => ({ vendorId: 0x2e3c, productId, usagePage: 0xff1b })));
    expect(wraithFactory.match(f.asDevice())).toBe(true);
    f.collections = [{ usagePage: 0xff1b, usage: 0x92 }] as unknown as HIDCollectionInfo[];
    expect(wraithFactory.match(f.asDevice())).toBe(false);
    const g = new FakeKeyboard();
    g.productId = 0x1234;
    expect(wraithFactory.match(g.asDevice())).toBe(false);
  });

  it('identifies a verified board', async () => {
    const [f, d] = await connect();
    expect(f.opened).toBe(true);
    expect(f.sent[0].slice(0, 2)).toEqual([0x0d, 0]);
    expect([d.brand(), d.model(), d.kind, d.image(), d.id]).toEqual(['WRAITH', 'W75 V2 HE', 'keyboard', undefined, '2e3c:c365']);
  });

  it('returns null when the board does not answer', async () => {
    const f = new FakeKeyboard();
    f.sendReport = async () => undefined;
    expect(await wraithFactory.create(f.asDevice())).toBeNull();
    expect(f.listenerCount()).toBe(0);
    expect(f.opened).toBe(false);
  });

  it('unknown product is read-only', async () => {
    const [f, d] = await connect({ product: 'OTHERKB' });
    expect(d.model()).toBe('W75 HE');
    const ss = await d.read();
    expect(ss.map((s) => s.key)).toEqual(['model', 'product_id', 'fw', 'unsupported']);
    expect(find(ss, 'product_id').value).toEqual({ kind: 'text', text: 'OTHERKB' });
    f.sent = [];
    await expect(d.write({ key: 'polling', label: '', group: '', value: { kind: 'choice', options: [], current: 1 } })).rejects.toThrow(/read-only/);
    expect(f.sent).toEqual([]);
  });

  it('reads a full snapshot', async () => {
    const [f, d] = await connect();
    f.keys.set(0, { mode: TRIG_RT, travel: 50, press: 10, release: 10 });
    const ss = await d.read();
    expect(ss.map((s) => `${s.group}/${s.key}`)).toEqual([
      'Info/model', 'Info/product_id', 'Info/fw', 'Performance/polling',
      'Switches/actuation', 'Switches/rapid_trigger', 'Switches/rt_sens', 'Per-key/per_key_trigger',
      'Lighting/light_power', 'Lighting/light_mode', 'Lighting/light_bri', 'Lighting/light_speed',
      'Lighting/light_color', 'Lighting/light_rainbow', 'Per-key/per_key_color', 'Keys/keymap',
    ]);
    expect(find(ss, 'model').value).toEqual({ kind: 'text', text: 'W75 V2 HE' });
    expect(find(ss, 'fw').value).toEqual({ kind: 'text', text: 'V3.13.03' });
    const poll = find(ss, 'polling').value;
    expect(poll.kind === 'choice' && poll.current).toBe(8);
    const act = find(ss, 'actuation').value;
    expect(act).toEqual({ kind: 'float', min: 0.1, max: 3.4, step: 0.02, current: 1.7, unit: ' mm' });
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    const pk = find(ss, 'per_key_trigger').value;
    if (pk.kind !== 'perKeyTrigger') throw new Error();
    expect(pk.keys.length).toBe(81);
    expect(pk.travel[0]).toBe(1);
    expect(pk.rapid[0]).toBe(true);
    expect(pk.rapid[1]).toBe(false);
    expect(find(ss, 'light_power').value).toEqual({ kind: 'toggle', on: false }); // power byte 1 = off
    const mode = find(ss, 'light_mode').value;
    expect(mode.kind === 'choice' && mode.current).toBe(10);
    expect(mode.kind === 'choice' && mode.options.length).toBe(15);
    expect(find(ss, 'light_bri').value).toEqual({ kind: 'number', min: 0, max: 4, current: 4, unit: '' });
    expect(find(ss, 'light_color').value).toEqual({ kind: 'color', rgb: 0xffaaff });
    expect(find(ss, 'light_rainbow').value).toEqual({ kind: 'toggle', on: true });
    const pc = find(ss, 'per_key_color').value;
    if (pc.kind !== 'perKeyColor') throw new Error();
    expect(pc.colors[pos(46)]).toBe(keyRgb(f.table, 46));
    expect(f.wrote([0x09, 0x81]).length).toBe(1); // slot 1 reported by 09 20
    // reads never write
    expect(f.sent.every((p) => [0x0d, 0x01, 0x0a, 0x07, 0x09, 0x21].includes(p[0]) || (p[0] === 0x18 && (p[1] === 0x80 || p[1] === 0x82)))).toBe(true);
    expect(f.wrote([0x07, 0, 0, 0, 0x0e]).length + f.wrote([0x21, 0, 0, 0, 0x00]).length).toBe(0);
  });

  it('skips per-key colours without the flag; falls back for silent keys', async () => {
    const [f, d] = await connect({ silentKeys: [0] });
    f.flags = 0;
    f.keys.set(46, { mode: TRIG_FIXED, travel: 100, press: 5, release: 5 });
    const ss = await d.read();
    expect(ss.some((s) => s.key === 'per_key_color')).toBe(false);
    const pk = find(ss, 'per_key_trigger').value;
    if (pk.kind !== 'perKeyTrigger') throw new Error();
    expect(pk.travel[0]).toBe(2); // fallback to global (W)
  });

  it('writes polling with read-back', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const s = find(ss, 'polling');
    await d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'choice' }>), current: 2 }));
    expect(f.poll).toBe(2);
    expect(f.wrote(hex('21 00 00 00 00 09 01 02')).length).toBe(1);
    await expect(d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'choice' }>), current: 3 }))).rejects.toThrow(/unsupported/);
  });

  it('polling read-back failure', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const s = find(await d.read(), 'polling');
    await expect(d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'choice' }>), current: 1 }))).rejects.toThrow(/reads back as code 8/);
  });

  it('writes global actuation / rapid trigger / sensitivity to all 81 keys', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    // the last set packet (every write is followed by 18 05 read-backs)
    const lastSet = () => [...f.sent].reverse().find((q) => q[0] === 0x21 && q[4] === 0x18 && q[5] !== 0x05)!;
    await d.write(withValue(find(ss, 'actuation'), { kind: 'float', min: 0.1, max: 3.4, step: 0.02, current: 1.0, unit: ' mm' }));
    let p = lastSet();
    expect(p.slice(0, 6)).toEqual(hex('21 00 00 00 18 00'));
    expect(p.slice(28, 36)).toEqual(hex('32 32 05 05 00 00 00 00'));
    expect(p.slice(36).every((b) => b === 0)).toBe(true);
    expect([...f.keys.values()].every((k) => k.travel === 50)).toBe(true);
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    p = lastSet();
    expect(p[5]).toBe(TRIG_RT);
    expect(p[28]).toBe(50); // keeps the new travel
    await d.write(withValue(find(ss, 'rt_sens'), { kind: 'float', min: 0.02, max: 1, step: 0.02, current: 0.3, unit: ' mm' }));
    p = lastSet();
    expect([p[5], p[30], p[31]]).toEqual([TRIG_RT, 15, 15]);
    expect(f.keys.get(125)).toEqual({ mode: TRIG_RT, travel: 50, press: 15, release: 15 });
    expect(f.keys.has(15)).toBe(false); // knob untouched
  });

  it('writes per-key triggers grouped, then verifies', async () => {
    const [f, d] = await connect();
    const s = find(await d.read(), 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = [...v.travel], rapid = [...v.rapid], sens = [...v.sens];
    for (const k of [46, 68, 69, 70]) {
      travel[pos(k)] = 1.0;
      rapid[pos(k)] = true;
      sens[pos(k)] = 0.1;
    }
    travel[pos(0)] = 2.0;
    f.sent = [];
    await d.write(withValue(s, { ...v, travel, rapid, sens }));
    const sets = f.sent.filter((p) => p[0] === 0x21 && p[4] === 0x18 && p[5] !== 0x05);
    expect(sets.length).toBe(2);
    const reads = f.sent.filter((p) => p[0] === 0x21 && p[4] === 0x18 && p[5] === 0x05);
    expect(reads.length).toBe(5); // read-back of changed keys only
    expect(f.keys.get(69)).toEqual({ mode: TRIG_RT, travel: 50, press: 5, release: 5 });
    expect(f.keys.get(0)).toEqual({ mode: TRIG_FIXED, travel: 100, press: 5, release: 5 });
    expect(f.keys.get(47)).toEqual({ mode: TRIG_FIXED, travel: 85, press: 5, release: 5 });
    // unchanged -> nothing sent
    f.sent = [];
    await d.write(withValue(s, { ...v, travel, rapid, sens }));
    expect(f.sent).toEqual([]);
  });

  it('per-key trigger read-back failure is reported', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const s = find(await d.read(), 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = [...v.travel];
    travel[pos(46)] = 1.0;
    travel[pos(0)] = 1.0;
    await expect(d.write(withValue(s, { ...v, travel }))).rejects.toThrow(/didn't take the trigger change for: Esc, W/);
  });

  it('per-key read-back failure names sent vs read-back of the first key', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const s = find(await d.read(), 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const rapid = [...v.rapid];
    const sens = [...v.sens];
    rapid[pos(46)] = true;
    sens[pos(46)] = 0.3;
    await expect(d.write(withValue(s, { ...v, rapid, sens }))).rejects.toThrow(
      "keyboard didn't take the trigger change for: W (W: sent RT 1.70 mm, RT 0.30/0.30 mm, reads back fixed 1.70 mm, RT 0.10/0.10 mm)",
    );
  });

  it('round-trips all-keys actuation, Rapid Trigger on/off and sensitivity through a re-read', async () => {
    const [f, d] = await connect();
    let ss = await d.read();
    expect(find(ss, 'rt_sens').value).toMatchObject({ min: 0.02, max: 1.7 });
    const float = (key: string, mm: number): Setting =>
      withValue(find(ss, key), { ...(find(ss, key).value as Extract<Value, { kind: 'float' }>), current: mm });
    const perKey = () => find(ss, 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const cur = (key: string) => (find(ss, key).value as Extract<Value, { kind: 'float' }>).current;

    await d.write(float('actuation', 0.9));
    ss = await d.read();
    expect(cur('actuation')).toBeCloseTo(0.9, 9);
    expect(perKey().travel.every((t) => Math.abs(t - 0.9) < 1e-9)).toBe(true);

    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true });
    expect(perKey().rapid.every(Boolean)).toBe(true);

    await d.write(float('rt_sens', 0.36));
    ss = await d.read();
    expect(cur('rt_sens')).toBeCloseTo(0.36, 9);
    expect(perKey().sens.every((t) => Math.abs(t - 0.36) < 1e-9)).toBe(true);
    expect(f.keys.get(46)).toEqual({ mode: TRIG_RT, travel: 45, press: 18, release: 18 });

    // above the official slider range -> clamped to ceil(max / 2) units
    await d.write(float('rt_sens', 3));
    expect(f.keys.get(46)?.press).toBe(85);

    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: false }));
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    expect(perKey().rapid.some(Boolean)).toBe(false);
    expect(cur('actuation')).toBeCloseTo(0.9, 9);
  });

  it('round-trips per-key actuation / Rapid Trigger / sensitivity through a re-read', async () => {
    const [, d] = await connect();
    const s = find(await d.read(), 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = [...v.travel], rapid = [...v.rapid], sens = [...v.sens];
    travel[pos(68)] = 0.5;
    rapid[pos(68)] = true;
    sens[pos(68)] = 0.06;
    travel[pos(70)] = 2.5;
    await d.write(withValue(s, { ...v, travel, rapid, sens }));
    const got = find(await d.read(), 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;
    got.travel.forEach((t, i) => expect(t).toBeCloseTo(travel[i], 9));
    expect(got.rapid).toEqual(rapid);
    got.sens.forEach((t, i) => expect(t).toBeCloseTo(sens[i], 9));
  });

  it('all-keys writes are read back; a refused one names sent vs read-back', async () => {
    const [f, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    f.sent = [];
    await expect(d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }))).rejects.toThrow(
      /^keyboard didn't take the trigger change for: Esc, F1, .* \(Esc: sent RT 1\.70 mm, RT 0\.10\/0\.10 mm, reads back fixed 1\.70 mm, RT 0\.10\/0\.10 mm\)$/,
    );
    expect(f.sent.filter((p) => p[0] === 0x21 && p[5] === 0x05).length).toBe(81);
    // the cache now holds what the board really has: turning RT off again is a no-op that verifies
    await expect(d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: false }))).resolves.toBeUndefined();
  });

  it("no false \"didn't take\" when the board zeroes the RT distances in fixed mode", async () => {
    const [f, d] = await connect({ storeTrig: (k) => (k.mode === TRIG_FIXED ? { ...k, press: 0, release: 0 } : k) });
    const ss = await d.read();
    await d.write(withValue(find(ss, 'actuation'), { ...(find(ss, 'actuation').value as Extract<Value, { kind: 'float' }>), current: 1.2 }));
    expect(f.keys.get(0)).toEqual({ mode: TRIG_FIXED, travel: 60, press: 0, release: 0 });
    const s = find(await d.read(), 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = [...v.travel];
    travel[pos(46)] = 2.0;
    await d.write(withValue(s, { ...v, travel }));
    expect(f.keys.get(46)?.travel).toBe(100);
  });

  it('all-keys write skips keys that never answer the read-back', async () => {
    const [f, d] = await connect({ silentKeys: [0] });
    const ss = await d.read();
    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    expect(f.keys.get(0)?.mode).toBe(TRIG_RT);
  });

  it('writes lighting with read-back', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: true }));
    expect(f.light[11]).toBe(0);
    await d.write(withValue(find(ss, 'light_mode'), { kind: 'choice', options: [], current: 2 }));
    expect(f.light[0]).toBe(2);
    await d.write(withValue(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 4, current: 9, unit: '' }));
    expect(f.light[1]).toBe(4);
    await d.write(withValue(find(ss, 'light_speed'), { kind: 'number', min: 0, max: 4, current: 1, unit: '' }));
    expect(f.light[2]).toBe(1);
    await d.write(withValue(find(ss, 'light_color'), { kind: 'color', rgb: 0x112233 }));
    expect(f.light.slice(3, 6)).toEqual([0x11, 0x22, 0x33]);
    expect(f.light[10]).toBe(0); // colour pick turns rainbow off
    await d.write(withValue(find(ss, 'light_rainbow'), { kind: 'toggle', on: true }));
    expect(f.light[10]).toBe(1);
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: false }));
    expect(f.light[11]).toBe(1);
    // every set packet is exactly 17 bytes then zeros
    for (const p of f.wrote([0x07, 0, 0, 0, 0x0e])) expect(p.slice(17).every((b) => b === 0)).toBe(true);
  });

  it('lighting read-back failure', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    await expect(d.write(withValue(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 4, current: 1, unit: '' }))).rejects.toThrow(/didn't take the lighting change/);
  });

  it('writes per-key colours, switches to Custom + on, verifies', async () => {
    const [f, d] = await connect();
    f.light = hex('00 04 03 ff aa ff 00 00 00 00 00 01'); // static, off
    const s = find(await d.read(), 'per_key_color');
    const v = s.value as Extract<Value, { kind: 'perKeyColor' }>;
    const colors = [...v.colors];
    colors[pos(46)] = 0x123456;
    const knob = Array.from(f.table.subarray(45, 48));
    f.sent = [];
    await d.write(withValue(s, { ...v, colors }));
    expect(keyRgb(f.table, 46)).toBe(0x123456);
    expect(Array.from(f.table.subarray(45, 48))).toEqual(knob);
    expect(f.wrote([0x09, 0x01, 0x00]).length).toBe(8); // all pages to active slot 1
    expect(f.light[0]).toBe(10);
    expect(f.light[11]).toBe(0);
    expect(f.wrote([0x09, 0x81]).length).toBe(1); // verification read
  });

  it('per-key colour read-back failure', async () => {
    const [f, d] = await connect();
    const s = find(await d.read(), 'per_key_color');
    const v = s.value as Extract<Value, { kind: 'perKeyColor' }>;
    const colors = [...v.colors];
    colors[pos(0)] = 0x010203;
    const orig = f.sendReport.bind(f);
    f.sendReport = async (id, data) => {
      const p = data as Uint8Array;
      if (p[0] === 0x09 && p[1] === 0x01) return; // drop colour pages
      return orig(id, data);
    };
    await expect(d.write(withValue(s, { ...v, colors }))).rejects.toThrow(/didn't take the colour for: Esc/);
    await expect(d.write(withValue(s, { ...v, colors: colors.slice(1) }))).rejects.toThrow(/layout/);
  });

  it('serializes concurrent calls', async () => {
    const [f, d] = await connect();
    const [a, b] = await Promise.all([d.read(), d.read()]);
    expect(a.length).toBe(b.length);
    // each 0x0D is followed by its own full read before the next starts
    const infos = f.sent.map((p, i) => (p[0] === 0x0d ? i : -1)).filter((i) => i >= 0);
    expect(infos.length).toBe(3);
    expect(infos[2] - infos[1]).toBeGreaterThan(81);
  });

  it('rejects unknown keys and close detaches', async () => {
    const [f, d] = await connect();
    await d.read();
    await expect(d.write({ key: 'nope', label: '', group: '', value: { kind: 'toggle', on: true } })).rejects.toThrow(/can't be changed/);
    await d.close();
    expect(f.listenerCount()).toBe(0);
    expect(f.opened).toBe(false);
  });
});

describe('live travel test', () => {
  it('builds the official start/stop packets and they pass the allowlist', () => {
    const start = [0x21, 0, 0, 0, 0x18, 0x02, ...keyBitmap([46, 0, 125])];
    expect(start.length).toBe(28);
    expect(allowed(start)).toBe(true);
    expect(allowed([0x21, 0, 0, 0, 0x18, 0x03])).toBe(true);
    expect(allowed([0x21, 0, 0, 0, 0x18, 0x03, 1])).toBe(false);
    // W = index 46 -> row 2, col 2 -> byte 2 bit 2
    expect(keyBitmap([46])[2]).toBe(4);
    expect(parseTravelSample([0x21, 0, 0, 0, 0, 1, 2, 2, 0xaa, 0])).toEqual({ key: 46, raw: 170 });
    expect(parseTravelSample([0x21, 0, 0, 0, 1, 9, 8])).toBeUndefined();
  });

  it('streams samples until stopped', async () => {
    const [f, d] = await connect();
    await d.read();
    const got: [number, number][] = [];
    const stop = await d.travelTest!((pos, mm) => got.push([pos, mm]));
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    const n = got.length;
    expect(n).toBeGreaterThan(1);
    expect(got.every(([pos]) => W75_CAPS[pos]?.label === 'W')).toBe(true);
    expect(Math.max(...got.map(([, mm]) => mm))).toBeLessThanOrEqual(3.4);
    expect(f.wrote([0x21, 0, 0, 0, 0x18, 0x03]).length).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(got.length).toBe(n);
  });
});

// ---------------------------------------------------------------------------------------------
// SOCD (official "PRCS", cmd 0x24)

describe('SOCD', () => {
  const at = (label: string) => W75_CAPS.findIndex((k) => k.label === label);
  const hx = (p: number[]) => p.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const A = at('A');
  const D = at('D');
  const Wk = at('W');
  const S = at('S');

  it('every W75 key except Fn has a HID usage from the vendor layout', () => {
    const hid = new Map(W75_HID);
    const missing = W75_CAPS.filter((c) => !hid.has(c.index)).map((c) => c.label);
    expect(missing).toEqual(['Fn']);
    expect(SOCD_UNAVAILABLE).toEqual([at('Fn')]);
    expect(hid.get(46)).toBe(0x1a); // W
    expect(hid.get(68)).toBe(0x04); // A
    expect(hid.get(70)).toBe(0x07); // D
    expect(new Set(W75_HID.map(([, h]) => h)).size).toBe(W75_HID.length);
    expect(W75_HID.every(([k]) => W75_CAPS.some((c) => c.index === k))).toBe(true);
  });

  it('frames match the official driver', () => {
    expect(readSocdPowerPkt()).toEqual(hex('24 02'));
    expect(readSocdPairsPkt()).toEqual(hex('24 01'));
    expect(setSocdPowerPkt(true)).toEqual(hex('24 03 00 00 01 01'));
    expect(setSocdPowerPkt(false)).toEqual(hex('24 03 00 00 01 00'));
    const pk = setSocdPairsPkts([{ mode: 0, hid1: 0x04, hid2: 0x07 }, { mode: 3, hid1: 0x1a, hid2: 0x16 }]);
    expect(pk).toHaveLength(2);
    expect(pk[0].slice(0, 13)).toEqual(hex('24 00 00 00 28 01 00 04 07 01 03 1A 16'));
    expect(pk[0].length).toBe(45);
    expect(pk[0].slice(13).every((b) => b === 0)).toBe(true);
    expect(pk[1]).toEqual([...hex('24 00 00 01 28'), ...new Array(40).fill(0)]);
    for (const p of [...pk, readSocdPowerPkt(), readSocdPairsPkt(), setSocdPowerPkt(true), setSocdPowerPkt(false)]) expect(allowed(p), hx(p)).toBe(true);
    // 11 pairs: the 11th lands on page 1
    const many = setSocdPairsPkts(Array.from({ length: 11 }, () => ({ mode: 1, hid1: 0x04, hid2: 0x07 })));
    expect(many[1].slice(5, 9)).toEqual(hex('01 01 04 07'));
    expect(() => setSocdPairsPkts(Array.from({ length: 21 }, () => ({ mode: 0, hid1: 4, hid2: 7 })))).toThrow(/20/);
  });

  it('allowlist takes only exact SOCD frames', () => {
    const page = (entries: number[]) => [...hex('24 00 00 00 28'), ...entries, ...new Array(40 - entries.length).fill(0)];
    expect(allowed(page(hex('01 00 04 07')))).toBe(true);
    for (const bad of [
      page(hex('01 04 04 07')), // mode 4
      page(hex('02 00 04 07')), // valid byte
      page(hex('01 00 04 04')), // same key twice
      page(hex('01 00 04 00')), // missing key
      page(hex('01 00 04 FA')), // not a W75 key
      page(hex('00 01 00 00')), // junk in an empty entry
      [...page([]), 1], // trailing junk
      hex('24 00 00 02 28').concat(new Array(40).fill(0)), // page 2
      hex('24 00 00 00 27').concat(new Array(40).fill(0)), // length
      hex('24 00 01 00 28').concat(new Array(40).fill(0)), // page hi
      hex('24 00 00 00 28'), // short
      hex('24 03 00 00 01 02'),
      hex('24 03 00 00 02 01 00'),
      hex('24 03 00 00 01 01 FA E5'), // the hotkey is never written
      hex('24 02 01'),
      hex('24 01 00 01'),
      hex('24 04'),
      hex('24 00'),
    ]) {
      expect(allowed(bad), hx(bad)).toBe(false);
    }
  });

  it('parses the probe replies', () => {
    // real W75 probe: 24 02 00 00 06 | 00 00 00 00 FA E5
    expect(parseSocdPower(hex('24 02 00 00 06 00 00 00 00 FA E5'))).toEqual({ on: false, hotkey: [0xfa, 0xe5] });
    expect(parseSocdPower(hex('24 02 00 00 06 01 00 00 00 FA E5'))?.on).toBe(true);
    const pg = [...hex('24 01 00 01 28 01 02 04 07 07 FF FF FF 00 03 1A 16'), ...new Array(28).fill(0)];
    expect(parseSocdPage(pg)).toEqual({ page: 1, pairs: [{ mode: 2, hid1: 4, hid2: 7 }] });
  });

  it('value / plan round-trip; unknown pairs are kept', () => {
    const { value, foreign } = socdValue(true, [{ mode: 0, hid1: 0x04, hid2: 0x07 }, { mode: 1, hid1: 0x04, hid2: 0x99 }]);
    expect(foreign).toEqual([{ mode: 1, hid1: 0x04, hid2: 0x99 }]);
    expect(value).toMatchObject({ kind: 'socd', mode: 'pairs', enabled: true, max: 19, entries: [{ keys: [A, D], mode: 0 }] });
    expect(planSocdPairs(value, foreign)).toEqual([{ mode: 0, hid1: 0x04, hid2: 0x07 }, { mode: 1, hid1: 0x04, hid2: 0x99 }]);
    const v = (entries: Socd['entries']): Socd => ({ ...value, entries });
    expect(() => planSocdPairs(v([{ keys: [A], mode: 0 }]), [])).toThrow(/two different keys/);
    expect(() => planSocdPairs(v([{ keys: [A, A], mode: 0 }]), [])).toThrow(/two different keys/);
    expect(() => planSocdPairs(v([{ keys: [A, D], mode: 0 }, { keys: [D, Wk], mode: 0 }]), [])).toThrow(/D is in two/);
    expect(() => planSocdPairs(v([{ keys: [A, at('Fn')], mode: 0 }]), [])).toThrow(/Fn can't/);
    expect(() => planSocdPairs(v([{ keys: [A, D], mode: 7 }]), [])).toThrow(/mode/);
    const full = Array.from({ length: 20 }, (_, i) => ({ keys: [2 * i, 2 * i + 1], mode: 0 }));
    expect(() => planSocdPairs(v(full), [{ mode: 0, hid1: 1, hid2: 2 }])).toThrow(/at most 20/);
    expect(SOCD_MAX).toBe(20);
  });

  it('is only read when the status says so, and reads never write', async () => {
    const [f, d] = await connect();
    expect((await d.read()).find((s) => s.key === 'socd')).toBeUndefined();
    expect(f.wrote([0x24])).toEqual([]);
    const [g, e] = await connect({ socd: true });
    g.socdTable.splice(0, 4, 1, 3, 0x04, 0x07);
    const ss = await e.read();
    const s = find(ss, 'socd');
    expect(s.group).toBe('Switches');
    expect(s.value).toMatchObject({ kind: 'socd', enabled: false, max: 20, entries: [{ keys: [A, D], mode: 3 }] });
    expect(g.sent.filter((p) => p[0] === 0x24).map((p) => p[1])).toEqual([0x02, 0x01]);
  });

  it('writes the switch and pairs, then reads them back', async () => {
    const [f, d] = await connect({ socd: true });
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    await d.write(withValue(s, { ...v, enabled: true }));
    expect(f.socdOn).toBe(1);
    expect(f.sent.map((p) => p.slice(0, 2))).toEqual([hex('24 03'), hex('24 02')]);
    f.sent = [];
    const next: Socd = { ...v, enabled: true, entries: [{ keys: [A, D], mode: 0 }, { keys: [Wk, S], mode: 2 }] };
    await d.write(withValue(s, next));
    expect(f.socdTable.slice(0, 8)).toEqual(hex('01 00 04 07 01 02 1A 16'));
    expect(f.wrote([0x24, 0x00]).map((p) => p[3])).toEqual([0, 1]);
    expect(f.wrote([0x24, 0x01])).toHaveLength(1);
    expect(f.wrote([0x24, 0x03])).toHaveLength(0); // switch unchanged
    // unchanged: nothing written
    f.sent = [];
    await d.write(withValue(s, next));
    expect(f.sent).toEqual([]);
    // remove one pair
    await d.write(withValue(s, { ...next, entries: [next.entries[1]] }));
    expect(f.socdTable.slice(0, 8)).toEqual(hex('01 02 1A 16 00 00 00 00'));
  });

  it('reports an ignored write', async () => {
    const [, d] = await connect({ socd: true, ignoreWrites: true });
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    await expect(d.write(withValue(s, { ...v, enabled: true }))).rejects.toThrow(/didn't take the SOCD switch/);
    await expect(d.write(withValue(s, { ...v, entries: [{ keys: [A, D], mode: 0 }] }))).rejects.toThrow(/didn't take the SOCD change/);
  });

  it('refuses invalid pairs before sending anything', async () => {
    const [f, d] = await connect({ socd: true });
    const s = find(await d.read(), 'socd');
    f.sent = [];
    await expect(d.write(withValue(s, { ...(s.value as Socd), entries: [{ keys: [A, at('Fn')], mode: 0 }] }))).rejects.toThrow(/Fn/);
    expect(f.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// key map + gamepad mode

describe('keymap packets', () => {
  it('read / write frames match the official setKeyValue / setFnKeyValue', () => {
    expect(readKeymapPkt(0)).toEqual(hex('18 80'));
    expect(readKeymapPkt(1)).toEqual(hex('18 82'));
    expect(KEYMAP_PAGES).toBe(10);
    const table = new Uint8Array(KEYMAP_TABLE).map((_, i) => (i % 4 === 0 ? i % 0x1a : i & 0xff));
    for (const layer of [0, 1]) {
      const pk = setKeymapPkts(layer, table);
      expect(pk.length).toBe(10);
      pk.forEach((p, pg) => {
        const len = pg === 9 ? 0x18 : 0x38;
        expect(p.slice(0, 5)).toEqual([0x18, layer ? 0x02 : 0x00, 0, pg, len]);
        expect(p.slice(5)).toEqual(Array.from(table.subarray(pg * 56, pg * 56 + len)));
        expect(allowed(p)).toBe(true);
        expect(allowed([...p, ...new Array(63 - p.length).fill(0)])).toBe(true);
      });
      const back = new Uint8Array(KEYMAP_TABLE);
      for (const p of pk) parseKeymapPage([0x18, layer ? 0x82 : 0x80, ...p.slice(2)], back);
      expect(back).toEqual(table);
    }
    expect(() => setKeymapPkts(0, new Uint8Array(10))).toThrow();
  });

  it('allowlist takes only exact keymap frames', () => {
    for (const ok of ['18 80', '18 82']) expect(allowed(hex(ok)), ok).toBe(true);
    for (const bad of ['18 80 01', '18 81', '18 83', '18 01', '18 03', '18 04', '18 00', '18 02 00 00 38']) expect(allowed(hex(bad)), bad).toBe(false);
    const pk = setKeymapPkts(0, new Uint8Array(KEYMAP_TABLE));
    const mut = (p: number[], i: number, v: number) => p.map((b, j) => (j === i ? v : b));
    expect(allowed(mut(pk[0], 1, 1))).toBe(false); // layer
    expect(allowed(mut(pk[0], 2, 1))).toBe(false); // page hi
    expect(allowed([...pk[9].slice(0, 3), 10, ...pk[9].slice(4)])).toBe(false); // page 10
    expect(allowed(mut(pk[0], 4, 0x18))).toBe(false); // short length on a middle page
    expect(allowed(mut(pk[9], 4, 0x38))).toBe(false); // long last page
    expect(allowed([...pk[9], 1])).toBe(false); // trailing junk
    expect(allowed(mut(pk[0], 5, 0x1a))).toBe(false); // code1 the vendor never uses
    expect(allowed(mut(pk[0], 5, 0x19))).toBe(true);
    expect(allowed(mut(pk[0], 6, 0xff))).toBe(true); // other bytes are data
  });

  it('gamepad mode frame is the only 14 frame', () => {
    expect(setGamepadModePkt(0)).toEqual(hex('14 03 00 00 01 00'));
    expect(setGamepadModePkt(1)).toEqual(hex('14 03 00 00 01 01'));
    expect(setGamepadModePkt(2)).toEqual(hex('14 03 00 00 01 02'));
    expect(() => setGamepadModePkt(3)).toThrow();
    expect(() => setGamepadModePkt(-1)).toThrow();
    for (const m of [0, 1, 2]) expect(allowed(setGamepadModePkt(m))).toBe(true);
    for (const bad of [
      '14 03 00 00 01 03', '14 03 00 00 01 FF', '14 00 00 00 01 01', '14 00 00 00 01 00', '14 01 00 00 01 01', '14 02',
      '14 03 00 00 02 01', '14 03 01 00 01 01', '14 03 00 01 01 01', '14 03 00 00 01 01 01', '14 03 00 00 01', '14 03 00 00 00 01',
    ]) {
      expect(allowed(hex(bad)), bad).toBe(false);
    }
  });

  it('PID -> gamepad mode', () => {
    expect([0xc365, 0xc366, 0xc367, 0xc368].map(gamepadModeOfPid)).toEqual(['off', 'xbox', 'classic', 'unknown']);
  });
});

describe('keymap codes', () => {
  const A = 68; // device slot of A
  it('decodes what we can encode, everything else is opaque', () => {
    expect(codeOfEntry([0, 0, 0, 0], 0, A)).toBe(0x04); // default = the key itself
    expect(codeOfEntry([0, 0, 0, 0], 1, A)).toBe(WR_DEFAULT);
    expect(codeOfEntry([0, 0x05, 0, 0], 0, A)).toBe(0x05);
    expect(codeOfEntry([0, 0xe1, 0, 0], 1, A)).toBe(0xe1);
    expect(codeOfEntry([0x07, 0x10, 0, 0], 1, A)).toBe(0xa9); // Vol+
    expect(codeOfEntry([0x07, 0x32, 0, 0], 1, A)).toBe(0xb2); // Calculator
    expect(codeOfEntry([0x13, 0xe0, 0x06, 0], 0, A)).toBe(0x0106); // Copy = Ctrl+C
    expect(codeOfEntry([0x13, 0xe5, 0x1e, 0], 0, A)).toBe(0x121e); // RShift+1
    expect(codeOfEntry([0x18, 0x11, 0, 0], 0, A)).toBe(WR_GP_CLASSIC + 0x11);
    expect(codeOfEntry([0x19, 0x0a, 0, 0], 0, A)).toBe(WR_GP_XBOX + 0x0a);
    const opaque: Entry[] = [
      [0x10, 0x04, 0x02, 0], [0x17, 0x03, 0, 0], [0x12, 0, 1, 0], [0x01, 0, 0, 0], [0x07, 0x24, 0, 0],
      [0x19, 0x30, 0, 0], [0x18, 0x21, 0, 0], [0, 0x01, 0, 0], [0, 0x04, 1, 0], [0x13, 0xe0, 0x06, 0x07],
    ];
    for (const raw of opaque) expect(codeOfEntry(raw, 1, A), raw.join(' ')).toBe(WR_OPAQUE + KEYMAP_SLOTS + A);
  });

  it('encodes like the vendor', () => {
    expect(entryOfCode(0x04, 0, A)).toEqual([0, 0, 0, 0]); // back to default
    expect(entryOfCode(0x04, 1, A)).toEqual([0, 0x04, 0, 0]);
    expect(entryOfCode(0x05, 0, A)).toEqual([0, 0x05, 0, 0]);
    expect(entryOfCode(WR_DEFAULT, 1, A)).toEqual([0, 0, 0, 0]);
    expect(entryOfCode(0xa8, 0, A)).toEqual([0x07, 0x12, 0, 0]); // Mute
    expect(entryOfCode(0x0106, 0, A)).toEqual([0x13, 0xe0, 0x06, 0]);
    expect(entryOfCode(0x021e, 0, A)).toEqual([0x13, 0xe1, 0x1e, 0]); // ! = Shift+1
    expect(entryOfCode(WR_GP_XBOX + 0x18, 0, A)).toEqual([0x19, 0x18, 0, 0]);
    expect(entryOfCode(WR_GP_CLASSIC + 0x20, 0, A)).toEqual([0x18, 0x20, 0, 0]);
    // can't: none, transparent, mouse, layers, multi-mod combos, unknown gamepad ids, opaque codes, eject
    for (const c of [0x00, 0x01, 0xd1, 0x5221, 0x0306, WR_GP_XBOX + 0x19, WR_GP_CLASSIC + 0x21, WR_OPAQUE + A, 0xb0]) {
      expect(entryOfCode(c, 0, A), c.toString(16)).toBeUndefined();
    }
  });
});

describe('keymap driver', () => {
  const slotOf = (label: string) => W75_CAPS.find((c) => c.label === label)!.index;
  const posOf = (label: string) => W75_CAPS.findIndex((c) => c.label === label);
  const km = (ss: Setting[]) => {
    const s = find(ss, 'keymap');
    if (s.value.kind !== 'keymap') throw new Error();
    return [s, s.value] as const;
  };
  const setEntry = (t: Uint8Array, slot: number, e: number[]) => t.set(e, slot * 4);
  const entry = (t: Uint8Array, slot: number) => Array.from(t.subarray(slot * 4, slot * 4 + 4));

  it('reads both layers; Fn is locked; unknown entries are named and kept', async () => {
    const [f, d] = await connect();
    setEntry(f.keymaps[0], slotOf('Q'), [0x10, 0x14, 0x02, 0]); // macro 3
    setEntry(f.keymaps[1], slotOf('F2'), [0x07, 0x11, 0, 0]); // Vol-
    setEntry(f.keymaps[1], slotOf('E'), [0x17, 0x05, 0, 0]); // advanced key
    const [s, v] = km(await d.read());
    expect(s.group).toBe('Keys');
    expect(v.keys).toBe(W75_CAPS);
    expect(v.layers.length).toBe(2);
    expect(v.layers[0][posOf('A')]).toBe(0x04);
    expect(v.layers[1][posOf('A')]).toBe(WR_DEFAULT);
    expect(v.layers[1][posOf('F2')]).toBe(0xaa);
    expect(v.locked).toEqual([[posOf('Fn')], [posOf('Fn')]]);
    expect(v.cats).not.toContain('mouse');
    expect(v.cats).not.toContain('layers');
    const q = v.layers[0][posOf('Q')];
    expect(q).toBe(WR_OPAQUE + slotOf('Q'));
    expect(label(q, v.codes, v.extra)).toBe('M3');
    expect(describeKc(q, v.codes, v.extra)).toMatch(/kept as it is/);
    expect(label(v.layers[1][posOf('E')], v.codes, v.extra)).toBe('Adv');
    expect(label(v.layers[0][posOf('Fn')], v.codes, v.extra)).toBe('Fn');
    // C365 (gamepad off): no gamepad keys in the picker
    expect(categories(v.codes, 2, 0x2c, 0, { extra: v.extra, cats: v.cats }).map((c) => c.id)).toEqual([...WRAITH_KEY_CATS, 'default']);
  });

  it('writes the whole changed layer, keeps every other entry byte for byte, round-trips', async () => {
    const [f, d] = await connect();
    setEntry(f.keymaps[0], slotOf('Q'), [0x10, 0x14, 0x02, 0]);
    setEntry(f.keymaps[0], 16, [0x07, 0x12, 0, 0]); // knob slots (not on the layout)
    setEntry(f.keymaps[0], 17, [0x02, 0x02, 0, 0]);
    setEntry(f.keymaps[1], slotOf('E'), [0x17, 0x05, 0x01, 0x02]);
    const before = f.keymaps.map((t) => new Uint8Array(t));
    const [s, v] = km(await d.read());
    f.sent = [];
    const layers = v.layers.map((l) => l.slice());
    layers[0][posOf('A')] = 0x05; // A -> B
    layers[0][posOf('Caps')] = 0x0106; // Caps -> Ctrl+C
    await d.write(withValue(s, { ...v, layers }));
    // only the base layer was written: 10 pages, then read back
    expect(f.wrote([0x18, 0x00]).length).toBe(10);
    expect(f.wrote([0x18, 0x02]).length).toBe(0);
    expect(f.sent[f.sent.length - 1].slice(0, 2)).toEqual([0x18, 0x80]);
    expect(entry(f.keymaps[0], slotOf('A'))).toEqual([0, 0x05, 0, 0]);
    expect(entry(f.keymaps[0], slotOf('Caps'))).toEqual([0x13, 0xe0, 0x06, 0]);
    const expected = new Uint8Array(before[0]);
    expected.set([0, 0x05, 0, 0], slotOf('A') * 4);
    expected.set([0x13, 0xe0, 0x06, 0], slotOf('Caps') * 4);
    expect(f.keymaps[0]).toEqual(expected); // macro, knob slots and Fn untouched
    expect(f.keymaps[1]).toEqual(before[1]);

    // Fn layer: F1 -> Vol+, then a re-read shows exactly what we wrote
    const [s2, v2] = km(await d.read());
    expect(v2.layers[0]).toEqual(layers[0]);
    const l2 = v2.layers.map((l) => l.slice());
    l2[1][posOf('F1')] = 0xa9;
    l2[0][posOf('A')] = 0x04; // A back to default -> all zero
    f.sent = [];
    await d.write(withValue(s2, { ...v2, layers: l2 }));
    expect(f.wrote([0x18, 0x00]).length).toBe(10);
    expect(f.wrote([0x18, 0x02]).length).toBe(10);
    expect(entry(f.keymaps[1], slotOf('F1'))).toEqual([0x07, 0x10, 0, 0]);
    expect(entry(f.keymaps[0], slotOf('A'))).toEqual([0, 0, 0, 0]);
    expect(entry(f.keymaps[1], slotOf('E'))).toEqual([0x17, 0x05, 0x01, 0x02]);
    const [, v3] = km(await d.read());
    expect(v3.layers).toEqual(l2);

    // nothing changed: nothing sent
    f.sent = [];
    await d.write(withValue(s2, { ...v3 }));
    expect(f.sent).toEqual([]);
  });

  it('refuses what it can not encode before sending anything', async () => {
    const [f, d] = await connect();
    setEntry(f.keymaps[0], slotOf('Q'), [0x10, 0x14, 0x02, 0]);
    const [s, v] = km(await d.read());
    f.sent = [];
    const tryWrite = (layer: number, label: string, code: number) => {
      const layers = v.layers.map((l) => l.slice());
      layers[layer][posOf(label)] = code;
      return d.write(withValue(s, { ...v, layers }));
    };
    await expect(tryWrite(0, 'Fn', 0x04)).rejects.toThrow(/Fn can't be changed/);
    await expect(tryWrite(1, 'Fn', 0x04)).rejects.toThrow(/Fn \(Fn layer\) can't be changed/);
    await expect(tryWrite(0, 'A', 0x00)).rejects.toThrow(/can't be disabled/);
    await expect(tryWrite(1, 'A', 0x01)).rejects.toThrow(/transparent/);
    await expect(tryWrite(0, 'A', 0xd1)).rejects.toThrow(/can't send keycode 0x00d1/); // mouse button
    await expect(tryWrite(0, 'A', v.layers[0][posOf('Q')])).rejects.toThrow(/can't send/); // a macro entry moved elsewhere
    await expect(d.write(withValue(s, { ...v, layers: [v.layers[0]] }))).rejects.toThrow(/Re-read/);
    expect(f.sent).toEqual([]);
  });

  it('reports a write the board did not take, naming sent vs read-back', async () => {
    const [, d0] = await connect({ ignoreWrites: true });
    const [s0, v0] = km(await d0.read());
    const l0 = v0.layers.map((l) => l.slice());
    l0[0][posOf('A')] = 0x05;
    await expect(d0.write(withValue(s0, { ...v0, layers: l0 }))).rejects.toThrow(/didn't take the key map change: A sent 00 05 00 00, reads back 00 00 00 00/);

    // a board that clobbers another entry is reported too
    // Q (slot 45) is on page 3, A (slot 68) on page 4
    const [f, d] = await connect({ storeKeymap: (_l, pg, b) => (pg === 3 ? b.map(() => 0) : b) });
    setEntry(f.keymaps[0], slotOf('Q'), [0x10, 0x14, 0x02, 0]);
    const [s, v] = km(await d.read());
    const layers = v.layers.map((l) => l.slice());
    layers[0][posOf('A')] = 0x05;
    await expect(d.write(withValue(s, { ...v, layers }))).rejects.toThrow(/Q sent 10 14 02 00, reads back 00 00 00 00 \(not changed\)/);
  });

  it('leaves the key map out when the board does not answer', async () => {
    const [, d] = await connect({ noKeymapRead: true });
    expect((await d.read()).some((s) => s.key === 'keymap')).toBe(false);
  });

  it('unknown products stay read-only (no key map, no gamepad mode), in every PID', async () => {
    for (const productId of [0xc365, 0xc366]) {
      const [f, d] = await connect({ product: 'OTHERKB', gamepad: true, productId });
      const ss = await d.read();
      expect(ss.map((x) => x.key)).toEqual(['model', 'product_id', 'fw', 'unsupported']);
      f.sent = [];
      await expect(d.write({ key: 'gamepad_mode', label: '', group: '', value: { kind: 'choice', options: [], current: 1 } })).rejects.toThrow(/read-only/);
      await expect(d.write({ key: 'keymap', label: '', group: '', value: { kind: 'keymap', keys: [], layers: [], codes: 'qmk-v2' } })).rejects.toThrow(/read-only/);
      expect(f.sent).toEqual([]);
    }
  });
});

describe('gamepad mode', () => {
  type Choice = Extract<Value, { kind: 'choice' }>;
  type Keymap = Extract<Value, { kind: 'keymap' }>;
  const gp = (ss: Setting[]) => ss.find((s) => s.key === 'gamepad_mode');

  it('is hidden unless the status flag F[13] & 0x04 is set', async () => {
    const [, d] = await connect();
    expect(gp(await d.read())).toBeUndefined();
    const [, d2] = await connect({ gamepad: true });
    const s = gp(await d2.read())!;
    expect(s).toBeDefined();
    expect(s.hint).toBe('The keyboard restarts and reconnects');
    expect(s.value).toEqual({ kind: 'choice', options: [['Off', 0], ['Xbox', 1], ['Classic', 2]], current: 0 });
  });

  it('sends exactly 14 03 00 00 01 <mode>, waits for nothing, then reports the restart', async () => {
    const [f, d] = await connect({ gamepad: true });
    const s = gp(await d.read())!;
    f.sent = [];
    await d.write(withValue(s, { ...(s.value as Choice), current: 1 }));
    expect(f.sent).toEqual([[...hex('14 03 00 00 01 01'), ...new Array(57).fill(0)]]);
    expect(f.gamepadMode).toBe(1);
    await expect(d.read()).rejects.toThrow(/restarting/);
    await expect(d.write(s)).rejects.toThrow(/restarting/);
    expect(f.sent.length).toBe(1);
  });

  it('writing the current mode sends nothing; other modes are refused', async () => {
    const [f, d] = await connect({ gamepad: true });
    const s = gp(await d.read())!;
    const v = s.value as Choice;
    f.sent = [];
    await d.write(withValue(s, { ...v, current: 0 }));
    await expect(d.write(withValue(s, { ...v, current: 3 }))).rejects.toThrow(/unknown gamepad mode/);
    expect(f.sent).toEqual([]);
    // no capability bit: refused even if asked
    const [f2, d2] = await connect();
    await d2.read();
    f2.sent = [];
    await expect(d2.write(withValue(s, { ...v, current: 1 }))).rejects.toThrow(/doesn't have a gamepad mode/);
    expect(f2.sent).toEqual([]);
  });

  it('Xbox PID (C366): mode from the PID, Xbox keys in the palette, decoded on read, writable', async () => {
    const [f, d] = await connect({ gamepad: true, productId: 0xc366 });
    expect(d.id).toBe('2e3c:c366');
    expect(wraithFactory.match(f.asDevice())).toBe(true);
    f.keymaps[0].set([0x19, 0x0a, 0, 0], 46 * 4); // W = A button
    f.keymaps[0].set([0x18, 0x11, 0, 0], 68 * 4); // A = Classic button 1 (other mode)
    const ss = await d.read();
    expect((gp(ss)!.value as Choice).current).toBe(1);
    const s = find(ss, 'keymap');
    const v = s.value as Keymap;
    expect(label(v.layers[0][pos(46)], v.codes, v.extra)).toBe('A');
    expect(describeKc(v.layers[0][pos(46)], v.codes, v.extra)).toBe('Gamepad (Xbox): A button');
    expect(label(v.layers[0][pos(68)], v.codes, v.extra)).toBe('B1');
    const opts = { extra: v.extra, cats: v.cats };
    const pad = categories(v.codes, 2, 0x2c, 0, opts).find((c) => c.id === 'gamepad')!;
    expect(pad.name).toBe('Gamepad');
    expect(pad.codes.length).toBe(25);
    expect(pad.codes.every((k) => k.code >= WR_GP_XBOX && k.code <= WR_GP_XBOX + 0x18)).toBe(true);
    expect(search('right bumper', v.codes, 2, 0x2c, 0, opts).map((k) => k.code)).toEqual([WR_GP_XBOX + 0x18]);
    const layers = v.layers.map((l) => l.slice());
    layers[0][pos(69)] = WR_GP_XBOX + 0x08; // S = LT
    await d.write(withValue(s, { ...v, layers }));
    expect(Array.from(f.keymaps[0].subarray(69 * 4, 69 * 4 + 4))).toEqual([0x19, 0x08, 0, 0]);
    expect(Array.from(f.keymaps[0].subarray(68 * 4, 68 * 4 + 4))).toEqual([0x18, 0x11, 0, 0]);
  });

  it('Classic PID (C367) offers the Classic keys; C368 is gamepad-capable with an unknown mode', async () => {
    const [, d] = await connect({ gamepad: true, productId: 0xc367 });
    const ss = await d.read();
    expect((gp(ss)!.value as Choice).current).toBe(2);
    const v = find(ss, 'keymap').value as Keymap;
    const pad = categories(v.codes, 2, 0x2c, 0, { extra: v.extra, cats: v.cats }).find((c) => c.id === 'gamepad')!;
    expect(pad.codes.length).toBe(33);
    expect(pad.codes[0]).toMatchObject({ code: WR_GP_CLASSIC, label: 'X-' });

    const [f3, d3] = await connect({ gamepad: true, productId: 0xc368 });
    expect(wraithFactory.match(f3.asDevice())).toBe(true);
    const s3 = await d3.read();
    const g3 = gp(s3)!;
    expect(g3.value).toEqual({ kind: 'choice', options: [['Off', 0], ['Xbox', 1], ['Classic', 2], ['Unknown (PID C368)', -1]], current: -1 });
    const v3 = find(s3, 'keymap').value as Keymap;
    expect(categories(v3.codes, 2, 0x2c, 0, { extra: v3.extra, cats: v3.cats }).some((c) => c.id === 'gamepad')).toBe(false);
    f3.sent = [];
    await d3.write(withValue(g3, { ...(g3.value as Choice), current: 2 }));
    expect(f3.sent.map((p) => p.slice(0, 6))).toEqual([hex('14 03 00 00 01 02')]);
  });
});
