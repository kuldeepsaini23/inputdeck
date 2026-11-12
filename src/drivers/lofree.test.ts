import { beforeAll, describe, expect, it } from 'vitest';
import { FakeLofree, fakeIndex, type FakeLofreeOpts } from './fakes/fake-lofree';
import type { Driver, Setting, Value } from './types';
import {
  ACT_RT,
  CMD,
  HYZEN_CODES,
  KEY_SLOTS,
  L_BRI,
  L_MODE,
  L_RGB,
  L_SPEED,
  POLL_WIRED,
  POLL_WIRELESS,
  allowed,
  curveDisplay,
  curveLinear,
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

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const pad = (b: number[], n = 63) => [...b, ...new Array(n - b.length).fill(0)];

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
