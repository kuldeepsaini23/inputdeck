import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLofree, fakeIndex, type FakeLofreeOpts } from './fakes/fake-lofree';
import type { Driver, Setting, Value } from './types';
import {
  ACT_RT,
  CMD,
  DONGLE_BRI,
  DONGLE_MODE,
  DONGLE_RGB,
  DONGLE_SPEED,
  HYZEN_CODES,
  KEY_SLOTS,
  L_BRI,
  L_MODE,
  L_RGB,
  L_SPEED,
  POLL_WIRED,
  POLL_WIRELESS,
  STRIP_BRI,
  STRIP_MODE,
  STRIP_RGB,
  STRIP_SPEED,
  allowed,
  curveDisplay,
  curveLinear,
  describeAct,
  endPkt,
  hyzenCaps,
  keyIndices,
  lofreeFactory,
  lofreeTiming,
  mmToRaw,
  parseTravelSpec,
  rawToMm,
  readFrames,
  startPkt,
  versionNumber,
  writeFrames,
} from './lofree';
import { KEY_NORMAL, KEY_SOCD, LED_BYTES, mirrorMode, parseSocdPairs, rawHex, socdEntries } from './lofree';
import type { Socd } from './types';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const pad = (b: number[], n = 63) => [...b, ...new Array(n - b.length).fill(0)];

// tests shorten the shared timings; put the real ones back afterwards
const realTiming = { ...lofreeTiming };
afterAll(() => {
  Object.assign(lofreeTiming, realTiming);
});
beforeAll(() => {
  Object.assign(lofreeTiming, { reply: 50, settle: 0 });
});

async function connect(o?: FakeLofreeOpts): Promise<[FakeLofree, Driver]> {
  const f = new FakeLofree(o);
  const d = await lofreeFactory.create(f.asDevice());
  expect(d).not.toBeNull();
  return [f, d!];
}
const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, v: Value): Setting => ({ ...s, value: v });
const act16 = (f: FakeLofree, k: number) => f.act[k * 2] | (f.act[k * 2 + 1] << 8);
const W = fakeIndex(HYZEN_CODES.indexOf(0x20001a));

describe('packets', () => {
  it('transaction frames', () => {
    expect(startPkt(true)).toEqual(pad(hex('00 00 01 18')));
    expect(endPkt(true)).toEqual(pad(hex('00 00 02 18')));
    expect(startPkt(false)).toEqual(pad(hex('00 00 01')));
    expect(endPkt(false, 31)).toEqual(pad(hex('00 00 02'), 31));
  });

  it('reads split into 56-byte frames (24 via receiver)', () => {
    const f = readFrames(CMD.READ_DEF_MATRIX, 384, 0);
    expect(f.length).toBe(7);
    expect(f[0].slice(0, 7)).toEqual(hex('00 00 07 38 00 00 00'));
    expect(f[6].slice(0, 7)).toEqual(hex('00 00 07 30 50 01 00'));
    expect(readFrames(CMD.READ_FUNC, 64, 128, 31).map((x) => x[3])).toEqual([24, 24, 16]);
  });

  it('writes carry data from byte 7', () => {
    const f = writeFrames(CMD.WRITE_ACT, new Array(256).fill(1), 256);
    expect(f.length).toBe(5);
    expect(f[0].slice(0, 8)).toEqual(hex('00 00 4c 38 00 01 00 01'));
    expect(f[4][3]).toBe(256 - 4 * 56);
    expect(writeFrames(CMD.LIVE_TRAVEL, [], 0)[0].slice(0, 7)).toEqual(hex('00 00 63 00 00 00 00'));
  });

  it('allowlist', () => {
    for (const p of [startPkt(true), endPkt(false), ...readFrames(CMD.READ_RT, 512, 512), ...writeFrames(CMD.WRITE_RT, new Array(512).fill(9), 512)]) {
      expect(allowed(p)).toBe(true);
    }
    // factory reset, calibration start/stop, unknown, bad sizes
    expect(allowed(pad(hex('00 00 0d 01')))).toBe(false);
    expect(allowed(pad(hex('00 00 40')))).toBe(false);
    expect(allowed(pad(hex('00 00 50')))).toBe(false);
    expect(allowed(pad(hex('00 00 aa')))).toBe(false);
    expect(allowed(pad(hex('00 00 1a')))).toBe(false);
    expect(allowed(pad(hex('00 00 09 01 00 00 00 05')))).toBe(false); // keymap write: not used
    expect(allowed(hex('00 00 01 18'))).toBe(false); // short frame
    expect(allowed(pad(hex('01 00 05 01 00 00 00')))).toBe(false);
    // reads must not carry data; writes must stay inside their table
    expect(allowed(pad(hex('00 00 05 01 00 00 00 07')))).toBe(false);
    expect(allowed(writeFrames(CMD.WRITE_FUNC, [1, 2], 447)[0])).toBe(false);
    expect(allowed(readFrames(CMD.READ_FUNC, 1, 448)[0])).toBe(false);
    // polling byte only takes 00 / 04
    expect(allowed(writeFrames(CMD.WRITE_FUNC, [4], POLL_WIRED)[0])).toBe(true);
    expect(allowed(writeFrames(CMD.WRITE_FUNC, [3], POLL_WIRELESS)[0])).toBe(false);
    // live travel: only 63 [01] / 63 []
    expect(allowed(writeFrames(CMD.LIVE_TRAVEL, [1], 0)[0])).toBe(true);
    expect(allowed(writeFrames(CMD.LIVE_TRAVEL, [2], 0)[0])).toBe(false);
    // LED location (1B, 128 bytes) and LED colours (21, 480 bytes): reads only, inside the table
    expect(allowed(readFrames(CMD.READ_LED_MAP, KEY_SLOTS, 0)[2])).toBe(true);
    expect(allowed(readFrames(CMD.READ_LED_COLORS, LED_BYTES, 0)[8])).toBe(true);
    expect(allowed(readFrames(CMD.READ_LED_MAP, 1, KEY_SLOTS)[0])).toBe(false);
    expect(allowed(readFrames(CMD.READ_LED_COLORS, 1, LED_BYTES)[0])).toBe(false);
    expect(allowed(writeFrames(CMD.READ_LED_COLORS, [0xff, 0, 0], 0)[0])).toBe(false);
    expect(allowed(writeFrames(CMD.READ_LED_MAP, [1], 0)[0])).toBe(false);
    // 31-byte receiver frames
    expect(allowed(startPkt(true, 31), 31)).toBe(true);
    expect(allowed(startPkt(true, 31), 63)).toBe(false);
  });

  it('parsers', () => {
    expect(parseTravelSpec([100, 0, 0x48, 0x0d])).toEqual({ minMm: 0.1, maxMm: 3.4 });
    expect(parseTravelSpec([0, 0, 0, 0]).maxMm).toBe(4);
    expect(versionNumber([32, 1])).toBe(132);
    const m = new Array(384).fill(0);
    m.splice(30, 3, 0x20, 0x00, 0x1a);
    const idx = keyIndices(m);
    expect(idx[HYZEN_CODES.indexOf(0x20001a)]).toBe(10);
    expect(idx.filter((i) => i >= 0).length).toBe(1);
  });

  it('layout is a 67-key 65%', () => {
    const caps = hyzenCaps();
    expect(caps.length).toBe(67);
    for (const row of [0, 1, 2, 3, 4]) {
      const r = caps.filter((c) => c.y === row);
      expect(Math.max(...r.map((c) => c.x + c.w))).toBe(16);
    }
    expect(new Set(HYZEN_CODES).size).toBe(67);
  });

  it('mm -> raw matches the official Zx (re-implemented from hyzen-index.js, 0.01..3.40 mm swept)', () => {
    // actuation (curve), calibrated full travel 1000, 3.4 mm max
    expect([0.05, 0.12, 0.3, 0.31, 1.2, 2.0, 3.4].map((mm) => mmToRaw(mm, 1000, 3.4, true))).toEqual([1, 3, 7, 9, 173, 352, 832]);
    // near full travel the official code measures candidates unclamped: 1026, not 1027
    expect(mmToRaw(3.4, 1234, 3.4, true)).toBe(1026);
    expect(mmToRaw(1.5, 3000, 4, true)).toBe(600);
    // RT distances (linear)
    expect([0.01, 0.3, 0.5].map((mm) => mmToRaw(mm, 1000, 3.4, false))).toEqual([3, 88, 147]);
    expect(mmToRaw(1, 1234, 4, false)).toBe(309);
  });

  it('travel curve round-trips', () => {
    expect(curveLinear(0)).toBe(0);
    expect(curveLinear(3.4)).toBeCloseTo(2.827196, 5);
    for (const mm of [0.1, 0.5, 1.2, 2, 3.3]) expect(curveDisplay(curveLinear(mm))).toBeCloseTo(mm, 6);
    // the curve is very flat below 0.3 mm, so the device's raw steps are coarse there
    expect(Math.abs(rawToMm(mmToRaw(0.1, 1000, 3.4, true), 1000, 3.4, true) - 0.1)).toBeLessThan(0.03);
    for (const mm of [0.35, 1.5, 2.2, 3.4]) {
      const raw = mmToRaw(mm, 1000, 3.4, true);
      expect(rawToMm(raw, 1000, 3.4, true)).toBeCloseTo(mm, 2);
    }
    expect(mmToRaw(0.34, 1000, 3.4, false)).toBe(100);
    expect(rawToMm(100 | ACT_RT, 1000, 3.4, false)).toBeCloseTo(0.34, 6);
  });
});

describe('fake Hyzen', () => {
  it('matches only the Lofree HUB interface', () => {
    const f = new FakeLofree();
    expect(lofreeFactory.match(f.asDevice())).toBe(true);
    f.collections = [{ usagePage: 0x01, usage: 0x06 }] as unknown as HIDCollectionInfo[];
    expect(lofreeFactory.match(f.asDevice())).toBe(false);
    const g = new FakeLofree({ productId: 0x0030 });
    expect(lofreeFactory.match(g.asDevice())).toBe(false);
    expect(lofreeFactory.filters.every((x) => x.vendorId === 0x388d && x.usagePage === 0xff1c)).toBe(true);
  });

  it('a silent device is not claimed', async () => {
    const f = new FakeLofree({ silent: true });
    expect(await lofreeFactory.create(f.asDevice())).toBeNull();
    expect(f.listenerCount()).toBe(0);
    expect(f.opened).toBe(false);
  });

  it('reads everything with read-only commands', async () => {
    const [f, d] = await connect();
    expect(d.verified).toBe(false);
    expect(d.brand()).toBe('LOFREE');
    expect(d.image()).toBe('https://hyzen.lofree.tech/deviceImage/oe930.webp');
    const ss = await d.read();
    expect(find(ss, 'fw').value).toEqual({ kind: 'text', text: '132' });
    expect(find(ss, 'switches').value).toEqual({ kind: 'text', text: 'Magnetic' });
    expect(find(ss, 'polling').value).toMatchObject({ kind: 'choice', current: 0 });
    const a = find(ss, 'actuation').value as Extract<Value, { kind: 'float' }>;
    expect(a.max).toBe(3.4);
    expect(a.current).toBeCloseTo(rawToMm(500, 1000, 3.4, true), 2);
    expect(find(ss, 'rt_sens').value).toMatchObject({ current: 0.34 });
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    const pk = find(ss, 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;
    expect(pk.keys.length).toBe(67);
    expect(pk.keys.find((k) => k.label === 'W')!.index).toBe(W);
    expect(find(ss, 'light_mode').value).toMatchObject({ current: 0x0a });
    expect(find(ss, 'light_bri').value).toMatchObject({ current: 80 });
    expect(find(ss, 'light_speed').value).toMatchObject({ current: 3 });
    expect(find(ss, 'light_color').value).toEqual({ kind: 'color', rgb: 0x112233 });
    // bottom light strip (preposition light)
    expect(find(ss, 'strip_mode').value).toMatchObject({ current: 0x02 });
    expect(find(ss, 'strip_bri').value).toMatchObject({ current: 80 });
    expect(find(ss, 'strip_speed').value).toMatchObject({ current: 3 }); // SPEED_MAX(4) - byte 1
    expect(find(ss, 'strip_color').value).toEqual({ kind: 'color', rgb: 0x445566 });
    // receiver / dongle light
    expect(find(ss, 'dongle_mode').value).toMatchObject({ current: 0x01 });
    expect(find(ss, 'dongle_bri').value).toMatchObject({ current: 100 }); // 255/255
    expect(find(ss, 'dongle_speed').value).toMatchObject({ current: 2 }); // SPEED_MAX(4) - byte 2
    expect(find(ss, 'dongle_color').value).toEqual({ kind: 'color', rgb: 0x778899 });
    // nothing but reads (and transaction control) went out
    const writes = f.sent.filter((p) => [CMD.WRITE_FUNC, CMD.WRITE_ACT, CMD.WRITE_RT, CMD.LIVE_TRAVEL].includes(p[2] as never));
    expect(writes).toEqual([]);
    expect(f.sent.filter((p) => p[2] === 0x01 && p[3] !== 0x18)).toEqual([]);
    await d.close();
    expect(f.listenerCount()).toBe(0);
  });

  it('mechanical switch mode hides trigger settings', async () => {
    const [, d] = await connect({ switchType: 0x01 });
    const ss = await d.read();
    expect(ss.find((s) => s.key === 'actuation')).toBeUndefined();
    expect(find(ss, 'switches').value).toEqual({ kind: 'text', text: 'Mechanical' });
    await expect(d.write({ key: 'actuation', label: '', group: '', value: { kind: 'float', min: 0, max: 4, step: 0.01, current: 1, unit: '' } })).rejects.toThrow();
  });

  it('receiver uses 31-byte frames and the wireless polling byte', async () => {
    const [f, d] = await connect({ productId: 0x0025 });
    const ss = await d.read();
    expect(f.sent.every((p) => p.length === 31)).toBe(true);
    expect(find(ss, 'polling').value).toMatchObject({ current: 4 });
    expect(find(ss, 'fw_dongle').value).toEqual({ kind: 'text', text: '107' });
    await d.write(withValue(find(ss, 'polling'), { ...(find(ss, 'polling').value as Extract<Value, { kind: 'choice' }>), current: 0 }));
    expect(f.func[POLL_WIRELESS]).toBe(0);
    expect(f.func[POLL_WIRED]).toBe(0);
  });

  it('polling write', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const s = find(ss, 'polling');
    await d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'choice' }>), current: 4 }));
    expect(f.func[POLL_WIRED]).toBe(4);
    await expect(d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'choice' }>), current: 2 }))).rejects.toThrow();
  });

  it('lighting writes the active profile block and verifies', async () => {
    const [f, d] = await connect({ profile: 2 });
    const ss = await d.read();
    const base = 2 * 64;
    await d.write(withValue(find(ss, 'light_mode'), { ...(find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>), current: 1 }));
    expect(f.func[base + L_MODE]).toBe(1);
    await d.write(withValue(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 100, current: 50, unit: '%' }));
    expect(f.func[base + L_BRI]).toBe(63);
    await d.write(withValue(find(ss, 'light_speed'), { kind: 'number', min: 0, max: 4, current: 4, unit: '' }));
    expect(f.func[base + L_SPEED]).toBe(0);
    await d.write(withValue(find(ss, 'light_color'), { kind: 'color', rgb: 0xff8000 }));
    expect(f.func.slice(base + 5, base + 9)).toEqual([1, 0xff, 0x80, 0x00]);
    expect(f.func[L_RGB]).toBe(0); // profile 0 untouched
    expect(f.frames(CMD.WRITE_FUNC).every((p) => (p[4] | (p[5] << 8)) >= base)).toBe(true);
  });

  it('light strip and receiver light write the active profile block with the hub byte map', async () => {
    const [f, d] = await connect({ profile: 1 });
    const ss = await d.read();
    const base = 1 * 64;
    // --- light strip (preposition): mode 38, brightness 31 (raw 0..100), speed 40 (4-ui), colour flag 42 + rgb 43..45
    await d.write(withValue(find(ss, 'strip_mode'), { ...(find(ss, 'strip_mode').value as Extract<Value, { kind: 'choice' }>), current: 5 }));
    expect(f.func[base + STRIP_MODE]).toBe(5);
    await d.write(withValue(find(ss, 'strip_bri'), { kind: 'number', min: 0, max: 100, current: 42, unit: '%' }));
    expect(f.func[base + STRIP_BRI]).toBe(42); // raw percent, no gamma
    await d.write(withValue(find(ss, 'strip_speed'), { kind: 'number', min: 0, max: 4, current: 1, unit: '' }));
    expect(f.func[base + STRIP_SPEED]).toBe(3); // 4 - 1
    await d.write(withValue(find(ss, 'strip_color'), { kind: 'color', rgb: 0x10203040 & 0xffffff }));
    expect(f.func.slice(base + STRIP_RGB - 1, base + STRIP_RGB + 3)).toEqual([1, 0x20, 0x30, 0x40]); // flag @42, rgb @43..45
    // --- receiver light: mode 49, brightness 32 (ceil pct*255/100), speed 52 (4-ui), rgb 10..12 + flag 16
    await d.write(withValue(find(ss, 'dongle_mode'), { ...(find(ss, 'dongle_mode').value as Extract<Value, { kind: 'choice' }>), current: 2 }));
    expect(f.func[base + DONGLE_MODE]).toBe(2);
    await d.write(withValue(find(ss, 'dongle_bri'), { kind: 'number', min: 0, max: 100, current: 50, unit: '%' }));
    expect(f.func[base + DONGLE_BRI]).toBe(128); // ceil(50*255/100)
    await d.write(withValue(find(ss, 'dongle_speed'), { kind: 'number', min: 0, max: 4, current: 4, unit: '' }));
    expect(f.func[base + DONGLE_SPEED]).toBe(0); // 4 - 4
    await d.write(withValue(find(ss, 'dongle_color'), { kind: 'color', rgb: 0xaabbcc }));
    expect(f.func.slice(base + DONGLE_RGB, base + DONGLE_RGB + 3)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(f.func[base + 16]).toBe(1); // dongle colour flag
    // profile 0 untouched, and everything went to the active profile
    expect(f.func[STRIP_MODE]).toBe(0);
    expect(f.frames(CMD.WRITE_FUNC).every((p) => (p[4] | (p[5] << 8)) >= base)).toBe(true);
  });

  it('the wired-only "single" model has no receiver light', async () => {
    const [, d] = await connect({ productId: 0x0029 });
    const ss = await d.read();
    expect(ss.find((s) => s.key === 'strip_mode')).toBeDefined();
    expect(ss.find((s) => s.key === 'dongle_mode')).toBeUndefined();
    await expect(
      d.write({ key: 'dongle_mode', label: '', group: '', value: { kind: 'choice', options: [['Static', 0]], current: 0 } }),
    ).rejects.toThrow(/no receiver light/);
  });

  it('reports ignored writes', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    await expect(d.write(withValue(find(ss, 'light_mode'), { ...(find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>), current: 1 }))).rejects.toThrow(/lighting/);
    await expect(d.write(withValue(find(ss, 'rt_sens'), { ...(find(ss, 'rt_sens').value as Extract<Value, { kind: 'float' }>), current: 0.5 }))).rejects.toThrow(/trigger/);
  });

  it('actuation / rapid trigger / sensitivity for all keys', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const a = find(ss, 'actuation');
    await d.write(withValue(a, { ...(a.value as Extract<Value, { kind: 'float' }>), current: 1.2 }));
    const raw = mmToRaw(1.2, 1000, 3.4, true);
    expect(act16(f, W)).toBe(raw);
    // keys not on the layout keep their value
    const unused = [...Array(KEY_SLOTS).keys()].find((k) => !HYZEN_CODES.some((_, i) => fakeIndex(i) === k))!;
    expect(act16(f, unused)).toBe(500);

    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    expect(act16(f, W)).toBe(raw | ACT_RT);
    expect(act16(f, unused)).toBe(500);

    const s = find(ss, 'rt_sens');
    await d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'float' }>), current: 0.5 }));
    const r = mmToRaw(0.5, 1000, 3.4, false);
    expect(f.rt[W * 4] | (f.rt[W * 4 + 1] << 8)).toBe(r);
    expect(f.rt[W * 4 + 2] | (f.rt[W * 4 + 3] << 8)).toBe(r);

    const again = await d.read();
    expect(find(again, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true });
    expect(find(again, 'actuation').value).toMatchObject({ current: 1.2 });
    expect(find(again, 'rt_sens').value).toMatchObject({ current: 0.5 });
  });

  it('per-key trigger writes only changed keys', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const s = find(ss, 'per_key_trigger');
    const v = s.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const wPos = v.keys.findIndex((k) => k.label === 'W');
    const before = f.act.slice();
    const travel = v.travel.slice();
    const rapid = v.rapid.slice();
    const sens = v.sens.slice();
    travel[wPos] = 0.8;
    rapid[wPos] = true;
    sens[wPos] = 0.2;
    await d.write(withValue(s, { ...v, travel, rapid, sens }));
    expect(act16(f, W)).toBe(mmToRaw(0.8, 1000, 3.4, true) | ACT_RT);
    expect(f.rt[W * 4]).toBe(mmToRaw(0.2, 1000, 3.4, false));
    for (let k = 0; k < KEY_SLOTS; k++) if (k !== W) expect(act16(f, k)).toBe(before[k * 2] | (before[k * 2 + 1] << 8));

    // unchanged -> nothing sent
    const n = f.sent.length;
    const now = find(await d.read(), 'per_key_trigger');
    const m = f.sent.length;
    await d.write(now);
    expect(f.sent.length).toBe(m);
    expect(m).toBeGreaterThan(n);
  });

  it('round-trips Rapid Trigger on/off, actuation and sensitivity (all keys and per key)', async () => {
    const [f, d] = await connect();
    let ss = await d.read();
    const float = (key: string, mm: number) => withValue(find(ss, key), { ...(find(ss, key).value as Extract<Value, { kind: 'float' }>), current: mm });
    const cur = (key: string) => (find(ss, key).value as Extract<Value, { kind: 'float' }>).current;
    const perKey = () => find(ss, 'per_key_trigger').value as Extract<Value, { kind: 'perKeyTrigger' }>;

    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: true }));
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true });
    expect(perKey().rapid.every(Boolean)).toBe(true);

    await d.write(float('actuation', 2.05));
    await d.write(float('rt_sens', 0.15));
    ss = await d.read();
    expect([cur('actuation'), cur('rt_sens')]).toEqual([2.05, 0.15]);
    expect(perKey().travel.every((t) => t === 2.05)).toBe(true);
    expect(perKey().sens.every((t) => t === 0.15)).toBe(true);
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: true }); // actuation kept the RT bit

    await d.write(withValue(find(ss, 'rapid_trigger'), { kind: 'toggle', on: false }));
    ss = await d.read();
    expect(find(ss, 'rapid_trigger').value).toEqual({ kind: 'toggle', on: false });
    expect(perKey().rapid.some(Boolean)).toBe(false);
    expect(cur('actuation')).toBe(2.05);
    expect(act16(f, W) & ACT_RT).toBe(0);

    // per key: two keys changed, everything reads back as written
    const v = perKey();
    const travel = v.travel.slice(), rapid = v.rapid.slice(), sens = v.sens.slice();
    const a = v.keys.findIndex((k) => k.label === 'A');
    const dd = v.keys.findIndex((k) => k.label === 'D');
    travel[a] = 0.4;
    rapid[a] = true;
    sens[a] = 0.05;
    travel[dd] = 3.1;
    await d.write(withValue(find(ss, 'per_key_trigger'), { ...v, travel, rapid, sens }));
    ss = await d.read();
    expect(perKey().travel).toEqual(travel);
    expect(perKey().rapid).toEqual(rapid);
    expect(perKey().sens).toEqual(sens);
  });

  it("a refused trigger write names sent vs read-back of the first key", async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    const s = find(ss, 'rt_sens');
    await expect(d.write(withValue(s, { ...(s.value as Extract<Value, { kind: 'float' }>), current: 0.5 }))).rejects.toThrow(
      /^keyboard didn't take the trigger change for: Esc, 1, .* \(Esc: sent RT 0\.50\/0\.50 mm \(raw 147\/147\), reads back 0\.34\/0\.34 mm \(raw 100\/100\)\)$/,
    );
    const p = find(ss, 'per_key_trigger');
    const v = p.value as Extract<Value, { kind: 'perKeyTrigger' }>;
    const travel = v.travel.slice(), rapid = v.rapid.slice();
    const w = v.keys.findIndex((k) => k.label === 'W');
    travel[w] = 0.8;
    rapid[w] = true;
    await expect(d.write(withValue(p, { ...v, travel, rapid }))).rejects.toThrow(
      `keyboard didn't take the trigger change for: W (W: sent actuation 0.80 mm, RT on (0x405F), reads back ${describeAct(500, 1000, 3.4)})`,
    );
    expect(describeAct(500, 1000, 3.4)).toMatch(/^\d\.\d\d mm \(0x01F4\)$/);
  });

  it('live travel test', async () => {
    const [f, d] = await connect();
    await d.read();
    const got: [number, number][] = [];
    const stop = await d.travelTest!((pos, mm) => got.push([pos, mm]));
    await new Promise((r) => setTimeout(r, 80));
    await stop();
    expect(f.live).toBe(false);
    expect(got.length).toBeGreaterThan(0);
    const wPos = hyzenCaps().findIndex((k) => k.label === 'W');
    expect(got.every(([p]) => p === wPos)).toBe(true);
    expect(Math.max(...got.map(([, mm]) => mm))).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// SOCD (key type table 67/66 + SOCD table 56/46)

describe('SOCD', () => {
  const idx = (label: string) => fakeIndex(hyzenCaps().findIndex((k) => k.label === label));
  const KA = idx('A');
  const KD = idx('D');
  const KW = idx('W');
  const KS = idx('S');
  const posOf = (v: Socd, label: string) => v.keys.findIndex((k) => k.label === label);
  const entryAt = (f: FakeLofree, k: number, profile = 0) => f.socd.slice((profile * KEY_SLOTS + k) * 4, (profile * KEY_SLOTS + k) * 4 + 4);
  const typeAt = (f: FakeLofree, k: number, profile = 0) => f.types[profile * KEY_SLOTS + k];
  const setPair = (f: FakeLofree, k1: number, k2: number, mode: number, rt: boolean, raw: number, profile = 0) => {
    for (const [k, e] of socdEntries({ k1, k2, mode, rt, raw1: raw, raw2: raw })) {
      f.socd.splice((profile * KEY_SLOTS + k) * 4, 4, ...e);
      f.types[profile * KEY_SLOTS + k] = KEY_SOCD;
    }
  };

  it('entries match the official saveSOCDKeyCommand', () => {
    // key 1 = slot 0 with the pair mode, key 2 = slot 1 with the mirrored mode
    expect(socdEntries({ k1: 4, k2: 7, mode: 1, rt: true, raw1: 0x123, raw2: 0x124 })).toEqual([
      [4, [7, 0x11, 0x23, 0x01]],
      [7, [4, 0x29, 0x24, 0x01]],
    ]);
    expect(socdEntries({ k1: 4, k2: 7, mode: 3, rt: false, raw1: 1, raw2: 2 })[1][1][1]).toBe(0x38);
    expect([0, 1, 2, 3].map(mirrorMode)).toEqual([0, 2, 1, 3]);
    // parse back, from either key, and skip broken partners
    const types = new Array(KEY_SLOTS).fill(KEY_NORMAL);
    const table = new Array(KEY_SLOTS * 4).fill(0);
    for (const [k, e] of socdEntries({ k1: 9, k2: 2, mode: 2, rt: true, raw1: 300, raw2: 310 })) {
      table.splice(k * 4, 4, ...e);
      types[k] = KEY_SOCD;
    }
    types[20] = KEY_SOCD; // orphan: partner 0 is not SOCD
    expect(parseSocdPairs(types, table)).toEqual([{ k1: 9, k2: 2, mode: 2, rt: true, raw1: 300, raw2: 310 }]);
  });

  it('allowlist: exact SOCD frames only', () => {
    const ok = [
      ...readFrames(CMD.READ_KEY_TYPE, 128, 128 * 6),
      ...readFrames(CMD.READ_SOCD, 512, 512 * 6),
      ...writeFrames(CMD.WRITE_KEY_TYPE, [KEY_SOCD], 5),
      ...writeFrames(CMD.WRITE_KEY_TYPE, [KEY_NORMAL], 128 * 6 + 127),
      ...writeFrames(CMD.WRITE_SOCD, [7, 0x39, 0xff, 0x3f], 4 * 4),
    ];
    for (const p of ok) expect(allowed(p), p.slice(0, 11).join(',')).toBe(true);
    const no = [
      writeFrames(CMD.WRITE_KEY_TYPE, [0x24], 5)[0], // DKS
      writeFrames(CMD.WRITE_KEY_TYPE, [0x27], 5)[0], // HT
      writeFrames(CMD.WRITE_KEY_TYPE, [0x26, 0x26], 5)[0], // two keys at once
      writeFrames(CMD.WRITE_KEY_TYPE, [0x26], 128 * 7)[0], // past the table
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 1, 0], 4 * 4 + 1)[0], // unaligned
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 1], 4 * 4)[0], // short
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 1, 0, 0], 4 * 4)[0], // long
      writeFrames(CMD.WRITE_SOCD, [7, 0x41, 1, 0], 4 * 4)[0], // priority 4
      writeFrames(CMD.WRITE_SOCD, [7, 0x13, 1, 0], 4 * 4)[0], // unknown flag bit
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 0, 0], 4 * 4)[0], // travel 0
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 0, 0x40], 4 * 4)[0], // travel > 14 bits
      writeFrames(CMD.WRITE_SOCD, [128, 0x11, 1, 0], 4 * 4)[0], // partner out of range
      writeFrames(CMD.WRITE_SOCD, [4, 0x11, 1, 0], 4 * 4)[0], // partner = itself
      writeFrames(CMD.WRITE_SOCD, [7, 0x11, 1, 0], 512 * 7)[0], // past the table
      readFrames(CMD.READ_SOCD, 4, 512 * 7)[0],
      pad(hex('00 00 66 01 05 00 00 26 01')), // trailing junk
    ];
    for (const p of no) expect(allowed(p), p.slice(0, 11).join(',')).toBe(false);
  });

  it('reads pairs of the active profile, marks keys with other advanced functions', async () => {
    const f = new FakeLofree({ profile: 2 });
    setPair(f, KA, KD, 3, true, mmToRaw(1.2, 1000, 3.4, true), 2);
    f.types[2 * KEY_SLOTS + KW] = 0x24; // W is a DKS key
    const d = (await lofreeFactory.create(f.asDevice()))!;
    const ss = await d.read();
    const s = find(ss, 'socd');
    const v = s.value as Socd;
    expect(s.group).toBe('Switches');
    expect(v).toMatchObject({ kind: 'socd', mode: 'pairs', max: 33, rapid: true, travel: { min: 0.1, max: 3.4, step: 0.01 } });
    expect(v.entries).toEqual([{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 3, travel: 1.2, rapid: true }]);
    expect(v.unavailable).toEqual([posOf(v, 'W')]);
    // reads only, at the profile's offsets
    expect(f.frames(CMD.READ_KEY_TYPE).map((p) => p[4] | (p[5] << 8))).toEqual([256, 256 + 56, 256 + 112]);
    expect(f.frames(CMD.READ_SOCD)[0][4] | (f.frames(CMD.READ_SOCD)[0][5] << 8)).toBe(1024);
    expect(f.frames(CMD.WRITE_SOCD).length + f.frames(CMD.WRITE_KEY_TYPE).length).toBe(0);
  });

  it('adds a pair: both entries, then type 26, then reads back', async () => {
    const [f, d] = await connect();
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 1, travel: 0.5, rapid: true }] }));
    const raw = mmToRaw(0.5, 1000, 3.4, true);
    expect(entryAt(f, KA)).toEqual([KD, 0x11, raw & 0xff, raw >> 8]);
    expect(entryAt(f, KD)).toEqual([KA, 0x29, raw & 0xff, raw >> 8]);
    expect(typeAt(f, KA)).toBe(KEY_SOCD);
    expect(typeAt(f, KD)).toBe(KEY_SOCD);
    const order = f.sent.filter((p) => p[2] === CMD.WRITE_SOCD || p[2] === CMD.WRITE_KEY_TYPE).map((p) => [p[2], p[7]]);
    expect(order).toEqual([[CMD.WRITE_SOCD, KA], [CMD.WRITE_SOCD, KD], [CMD.WRITE_KEY_TYPE, KEY_SOCD], [CMD.WRITE_KEY_TYPE, KEY_SOCD]]);
    expect(f.frames(CMD.READ_SOCD).length).toBeGreaterThan(0);
    // re-read shows the same thing, writing it again sends nothing
    const again = find(await d.read(), 'socd');
    expect((again.value as Socd).entries).toEqual([{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 1, travel: 0.5, rapid: true }]);
    f.sent = [];
    await d.write(again);
    expect(f.sent).toEqual([]);
  });

  it('changing the mode rewrites only the entries; deleting puts both keys back to 20', async () => {
    const [f, d] = await connect();
    setPair(f, KA, KD, 0, false, 400);
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ ...v.entries[0], mode: 2 }] }));
    expect(entryAt(f, KA)).toEqual([KD, 0x20, 400 & 0xff, 400 >> 8]); // travel raw kept
    expect(entryAt(f, KD)).toEqual([KA, 0x18, 400 & 0xff, 400 >> 8]);
    expect(f.frames(CMD.WRITE_KEY_TYPE)).toEqual([]);
    f.sent = [];
    await d.write(withValue(s, { ...v, entries: [{ keys: [posOf(v, 'W'), posOf(v, 'S')], mode: 0, travel: 1, rapid: false }] }));
    expect(typeAt(f, KA)).toBe(KEY_NORMAL);
    expect(typeAt(f, KD)).toBe(KEY_NORMAL);
    expect(typeAt(f, KW)).toBe(KEY_SOCD);
    expect(typeAt(f, KS)).toBe(KEY_SOCD);
    // old keys go back to normal before anything else is written
    const first = f.sent.find((p) => p[2] === CMD.WRITE_SOCD || p[2] === CMD.WRITE_KEY_TYPE)!;
    expect([first[2], first[7]]).toEqual([CMD.WRITE_KEY_TYPE, KEY_NORMAL]);
    await d.write(withValue(s, { ...v, entries: [] }));
    expect(typeAt(f, KW)).toBe(KEY_NORMAL);
    expect(typeAt(f, KS)).toBe(KEY_NORMAL);
  });

  it('refuses DKS/RS/HT keys, duplicates and single keys before sending', async () => {
    const [f, d] = await connect();
    f.types[KW] = 0x25; // RS
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    f.sent = [];
    const w = (entries: Socd['entries']) => d.write(withValue(s, { ...v, entries }));
    await expect(w([{ keys: [posOf(v, 'W'), posOf(v, 'S')], mode: 0, travel: 1, rapid: false }])).rejects.toThrow(/W has another advanced function/);
    await expect(w([{ keys: [posOf(v, 'A')], mode: 0, travel: 1, rapid: false }])).rejects.toThrow(/two different keys/);
    await expect(w([{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 0 }, { keys: [posOf(v, 'D'), posOf(v, 'S')], mode: 0 }])).rejects.toThrow(/D is in two/);
    await expect(w([{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 5 }])).rejects.toThrow(/mode/);
    expect(f.sent).toEqual([]);
  });

  it('reports an ignored write', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const s = find(await d.read(), 'socd');
    const v = s.value as Socd;
    await expect(d.write(withValue(s, { ...v, entries: [{ keys: [posOf(v, 'A'), posOf(v, 'D')], mode: 0, travel: 1, rapid: false }] }))).rejects.toThrow(/didn't take the SOCD change for: A, D \(A: sent key type 26, reads back 20\)$/);
  });
});

describe('diagnose', () => {
  /** commands a read-only probe may send (data frames) */
  const READ_CMDS = [CMD.READ_VERSION, CMD.READ_DONGLE_VERSION, CMD.READ_FUNC, CMD.READ_DEF_MATRIX, CMD.READ_LED_MAP, CMD.READ_LED_COLORS] as number[];
  const onlyReads = (sent: number[][]) => {
    for (const p of sent) {
      if (p[2] === 0x01 || p[2] === 0x02) expect(p[3]).toBe(0x18); // START / END of a read
      else {
        expect(READ_CMDS).toContain(p[2]);
        expect(p.slice(7).every((b) => b === 0)).toBe(true); // no payload
      }
    }
  };

  it('rawHex folds trailing zeros', () => {
    expect(rawHex(pad(hex('00 00 21 38')))).toBe('00 00 21 38 +59x00');
    expect(rawHex([0, 0])).toBe('+2x00');
    expect(rawHex([1, 2])).toBe('01 02');
  });

  it('sends only read transactions, with the exact 1B / 21 frames, and reports raw replies', async () => {
    const [f, d] = await connect();
    f.sent = [];
    const progress: [number, number][] = [];
    const r = await d.diagnose!((done, total) => progress.push([done, total]));
    onlyReads(f.sent);
    // exactly the probe's commands, in order (START / END left out)
    const cmds = f.sent.filter((p) => p[2] > 2).map((p) => p[2]);
    expect([...new Set(cmds)]).toEqual([CMD.READ_VERSION, CMD.READ_FUNC, CMD.READ_DEF_MATRIX, CMD.READ_LED_MAP, CMD.READ_LED_COLORS]);
    // 1B: 128 bytes in 56/56/16 frames; 21 (twice): 480 bytes = 8 x 56 + 32
    expect(f.frames(CMD.READ_LED_MAP)).toEqual([pad(hex('00 00 1b 38 00 00 00')), pad(hex('00 00 1b 38 38 00 00')), pad(hex('00 00 1b 10 70 00 00'))]);
    const c = f.frames(CMD.READ_LED_COLORS);
    expect(c.length).toBe(18);
    expect(c.slice(0, 9).map((p) => [p[3], p[4] | (p[5] << 8)])).toEqual([
      [56, 0], [56, 56], [56, 112], [56, 168], [56, 224], [56, 280], [56, 336], [56, 392], [32, 448],
    ]);
    expect(progress.at(-1)).toEqual([7, 7]);
    expect(progress.map(([n]) => n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // raw frames and their interpretation
    expect(r).toContain('> 00 00 21 38 +59x00');
    expect(r).toContain('< 00 00 21 38 00 00 00 00 80 FF 01 80 FE');
    expect(r).toContain('firmware 132');
    expect(r).toContain('effect 0A (Wave)');
    expect(r).toContain('colour #112233');
    expect(r).toContain('67/67 layout keys found');
    // Esc is layout position 0 -> key index fakeIndex(0) = 3 -> LED 0 -> R 00, G 80, B FF
    expect(r).toContain(' Esc:3->0 ');
    expect(r).toContain(' Esc:#0080FF ');
    expect(r).toContain('67 distinct LEDs for 67 keys; LED range 0..66');
    expect(r).toMatch(/light strip \(90 LEDs from byte 210\): #4680B9 /);
    expect(r).toContain('identical to the first read');
    expect(r).not.toContain('FAILED');
    // nothing changed on the device and the driver still works
    await d.read();
    await d.close();
  });

  it('sees a live frame when the colours change between reads', async () => {
    const [f, d] = await connect();
    let n = 0;
    const send = f.sendReport.bind(f);
    f.sendReport = async (id, data) => {
      const p = data as Uint8Array;
      if (p[2] === CMD.READ_LED_COLORS && (p[4] | (p[5] << 8)) === 0 && n++ === 1) f.leds[0] ^= 0xff;
      return send(id, data);
    };
    const r = await d.diagnose!();
    expect(r).toContain('1 of 480 bytes changed between the two reads');
    await d.close();
  });

  it('receiver: 31-byte frames and the receiver version', async () => {
    const [f, d] = await connect({ productId: 0x0025 });
    f.sent = [];
    const progress: [number, number][] = [];
    const r = await d.diagnose!((done, total) => progress.push([done, total]));
    onlyReads(f.sent);
    expect(f.sent.every((p) => p.length === 31)).toBe(true);
    expect(f.frames(CMD.READ_LED_COLORS).length).toBe(40); // 2 x 480 / 24
    expect(progress.at(-1)).toEqual([8, 8]);
    expect(r).toContain('receiver firmware 107');
    await d.close();
  });

  it('firmware without 1B / 21: reports the failure, closes the read and carries on', async () => {
    const [f, d] = await connect({ unanswered: [CMD.READ_LED_MAP, CMD.READ_LED_COLORS] });
    f.sent = [];
    const r = await d.diagnose!();
    onlyReads(f.sent);
    expect(r.match(/FAILED: no answer \(read 1B\)/g)?.length).toBe(1);
    expect(r.match(/FAILED: no answer \(read 21\)/g)?.length).toBe(2);
    // after the unanswered frame the read is closed with END 02 18
    const i = f.sent.findIndex((p) => p[2] === CMD.READ_LED_MAP);
    expect(f.sent[i + 1]).toEqual(pad(hex('00 00 02 18')));
    expect(r).toContain('closing the read:');
    expect(r).toContain('firmware 132');
    // the keyboard is still usable afterwards
    expect(find(await d.read(), 'fw').value).toEqual({ kind: 'text', text: '132' });
    await d.close();
  });
});
