import { describe, expect, it, beforeEach } from 'vitest';
import { FakeMouse, type FakeOpts } from './fakes/fake-mouse';
import type { Setting, Value } from './types';
import { KEEP, WlMouseDriver, lodDecode, lodEncode, openWlMouse, setSkin, wlmouseFactory } from './wlmouse';

// ------------------------------------------------------------------ fake mouse

const noSleep = { sleep: async () => {} };

async function setup(o: FakeOpts = {}) {
  const fake = new FakeMouse(o);
  const drv = (await openWlMouse(fake.asHid(), noSleep))!;
  expect(drv).toBeInstanceOf(WlMouseDriver);
  const settings = await drv.read();
  fake.sent = [];
  return { fake, drv, settings };
}

const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, value: Value): Setting => ({ ...s, value });

// ------------------------------------------------------------------ tests

describe('lod codec', () => {
  it('matches the Rust encoder', () => {
    expect(lodEncode(0.7)).toBe(0x87);
    expect(lodEncode(1.0)).toBe(0x01);
    expect(lodEncode(1.5)).toBe(0x15);
    expect(lodEncode(2.0)).toBe(0x02);
    for (const mm of [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2]) {
      expect(lodDecode(lodEncode(mm))).toBeCloseTo(mm, 2);
    }
  });
});

describe('factory', () => {
  it('filters and match', () => {
    expect(wlmouseFactory.filters).toContainEqual({ vendorId: 0x36a7 });
    expect(wlmouseFactory.filters).toContainEqual({ vendorId: 0x258a, productId: 0x2022 });
    const f = new FakeMouse();
    expect(wlmouseFactory.match(f.asHid())).toBe(true);
    // a non-config interface of the same receiver
    f.collections = [{ usagePage: 0x0001, usage: 2, featureReports: [] } as unknown as HIDCollectionInfo];
    expect(wlmouseFactory.match(f.asHid())).toBe(false);
    f.collections = [{ usagePage: 0xffff, usage: 1, featureReports: [] } as unknown as HIDCollectionInfo];
    expect(wlmouseFactory.match(f.asHid())).toBe(false);
    expect(wlmouseFactory.match(new FakeMouse({ vendorId: 0x258a, productId: 0x1234 }).asHid())).toBe(false);
    expect(wlmouseFactory.match(new FakeMouse({ vendorId: 0x258a, productId: 0x2013 }).asHid())).toBe(true);
  });

  it('identifies with the dongle firmware query (target 0)', async () => {
    const f = new FakeMouse();
    const d = await wlmouseFactory.create(f.asHid());
    expect(d).not.toBeNull();
    expect(f.opened).toBe(true);
    expect(f.sent).toEqual([{ target: 0, len: 0x10, page: 0, cmd: 0x81, payload: Array(16).fill(0) }]);
    expect(d!.kind).toBe('mouse');
    expect(d!.brand()).toBe('WLMouse');
    expect(d!.id).toBe('36a7:a863');
    expect(d!.family).toMatch(/^Compx/);
  });

  it('returns null when the device does not answer', async () => {
    const f = new FakeMouse({ dead: true });
    expect(await openWlMouse(f.asHid(), noSleep)).toBeNull();
    expect(f.opened).toBe(false);
  });
});

describe('read', () => {
  for (const withReportId of [false, true]) {
    it(`full snapshot (report id byte: ${withReportId})`, async () => {
      const { drv, settings } = await setup({ withReportId });
      expect(drv.reportOffset).toBe(withReportId ? 1 : 0);
      const v = (k: string) => find(settings, k).value;
      expect(drv.model()).toBe('HUAN M');
      expect(v('model')).toEqual({ kind: 'text', text: 'HUAN M' });
      expect(v('ui_folder')).toEqual({ kind: 'text', text: 'WLX_HUANM' });
      expect(v('fw')).toEqual({ kind: 'text', text: '0.1.0.12' });
      expect(v('dongle_fw')).toEqual({ kind: 'text', text: '0.1.0.12' });
      expect(v('battery')).toEqual({ kind: 'text', text: '37%' });
      expect(find(settings, 'battery').group).toBe('Info');
      expect(v('profile')).toEqual({
        kind: 'choice', options: [['Profile 1', 1], ['2: Aim', 2], ['Profile 3', 3]], current: 2,
      });
      expect(v('profile_name')).toEqual({ kind: 'text', text: 'Aim' });
      expect(v('dpi')).toEqual({
        kind: 'dpi', stages: [400, 800, 1600, 3200, 6400, 30000], active: 2, min: 50, max: 42000, step: 1,
        colors: [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff],
      });
      expect(settings.some((s) => s.key === 'dpi_y')).toBe(false);
      expect(v('dpi_count')).toMatchObject({ kind: 'choice', current: 6 });
      expect(v('dpi_xy')).toEqual({ kind: 'toggle', on: false });
      expect(v('dpi_color3')).toEqual({ kind: 'color', rgb: 0x0000ff });
      expect(v('polling')).toMatchObject({ kind: 'choice', current: 1 });
      expect(v('lod_mode')).toMatchObject({ current: 3 });
      expect(v('lod')).toEqual({ kind: 'choice', options: [['0.7 mm', 0x87], ['1 mm', 1], ['2 mm', 2]], current: 1 });
      for (const k of ['hyper', 'turbo', 'motion_sync', 'angle_snap', 'ripple']) expect(v(k)).toEqual({ kind: 'toggle', on: false });
      expect(v('angle_tune')).toMatchObject({ kind: 'number', current: 0, min: -30, max: 30 });
      expect(v('combo')).toEqual({ kind: 'toggle', on: true });
      expect(v('btn1')).toMatchObject({ current: 0 });
      expect(v('btn4')).toMatchObject({ current: 3 });
      const b5 = v('btn5');
      expect(b5).toMatchObject({ kind: 'choice', current: KEEP });
      if (b5.kind === 'choice') expect(b5.options[0]).toEqual(['Keyboard key (usage 04) (keep)', KEEP]);
      expect(v('debounce')).toMatchObject({ kind: 'number', current: 0, max: 15 });
      expect(v('sleep')).toMatchObject({ kind: 'choice', current: 60 });
      expect(v('screen_effect')).toEqual({ kind: 'toggle', on: true });
      expect(v('screen_status')).toEqual({ kind: 'toggle', on: false });
      expect(v('voice')).toEqual({ kind: 'toggle', on: true });
      expect(v('screen_images')).toEqual({ kind: 'text', text: '1 of 8: image 360×360' });
      const groups = new Set(settings.map((s) => s.group));
      expect([...groups]).toEqual(['Info', 'Profile', 'DPI', 'Performance', 'Buttons', 'Power', 'Advanced', 'Dongle screen']);
    });
  }

  it('image uses the model folder + stored skin', async () => {
    const store: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
    };
    try {
      const { drv } = await setup();
      expect(drv.image()).toBe('https://gm.wlmouse.gg/Config/WLX_HUANM/Colors/1.png');
      setSkin(drv.id, 3);
      expect(drv.image()).toBe('https://gm.wlmouse.gg/Config/WLX_HUANM/Colors/3.png');
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('battery charging, separate X/Y, sleep never, precise LOD, angle tune negative', async () => {
    const fake = new FakeMouse();
    fake.battery = [1, 80];
    fake.p1[2][0x0d] = 1;
    fake.table[2].st[0] = [400, 800];
    fake.sleepSecs[2] = 0xffff;
    fake.lod[2] = [0x15, 0x0b];
    fake.p1[2][0x14] = 0xfb;
    const drv = (await openWlMouse(fake.asHid(), noSleep))!;
    const ss = await drv.read();
    expect(find(ss, 'battery').value).toEqual({ kind: 'text', text: '80% (charging)' });
    expect(find(ss, 'dpi').label).toBe('DPI stages (X)');
    expect(find(ss, 'dpi_y').value).toMatchObject({ stages: [800, 800, 1600, 3200, 6400, 30000] });
    expect(find(ss, 'sleep').value).toMatchObject({ current: 0xffff });
    expect(find(ss, 'lod').value).toMatchObject({ current: 0x15 });
    const lod = find(ss, 'lod').value;
    if (lod.kind === 'choice') expect(lod.options).toHaveLength(11);
    expect(find(ss, 'angle_tune').value).toMatchObject({ current: -5 });
  });

  it('reports an asleep mouse clearly', async () => {
    const fake = new FakeMouse();
    const drv = (await openWlMouse(fake.asHid(), noSleep))!;
    fake.asleep = true;
    await expect(drv.read()).rejects.toThrow(/Mouse isn't answering \(mouse is asleep\)/);
  });
});

describe('write round-trips', () => {
  let fake: FakeMouse;
  let drv: WlMouseDriver;
  let settings: Setting[];
  beforeEach(async () => {
    ({ fake, drv, settings } = await setup());
  });
  const reread = () => drv.read();

  const roundTrip = async (key: string, value: Value) => {
    await drv.write(withValue(find(settings, key), value));
    const after = await reread();
    return find(after, key).value;
  };

  it('polling', async () => {
    expect(await roundTrip('polling', { ...(find(settings, 'polling').value as Extract<Value, { kind: 'choice' }>), current: 0x80 })).toMatchObject({ current: 0x80 });
    expect(fake.sent.find((f) => f.page === 1 && f.cmd === 0x00)?.payload).toEqual([2, 0x80]);
  });

  it('toggles', async () => {
    for (const k of ['motion_sync', 'angle_snap', 'ripple', 'combo', 'screen_effect', 'screen_status']) {
      expect(await roundTrip(k, { kind: 'toggle', on: k === 'screen_effect' ? false : true })).toEqual({
        kind: 'toggle', on: k !== 'screen_effect',
      });
    }
    expect(await roundTrip('voice', { kind: 'toggle', on: false })).toEqual({ kind: 'toggle', on: false });
  });

  it('hyper + turbo rule', async () => {
    await expect(drv.write(withValue(find(settings, 'turbo'), { kind: 'toggle', on: true }))).rejects.toThrow(/High-speed/);
    expect(fake.sets()).toHaveLength(0);
    expect(await roundTrip('hyper', { kind: 'toggle', on: true })).toEqual({ kind: 'toggle', on: true });
    expect(await roundTrip('turbo', { kind: 'toggle', on: true })).toEqual({ kind: 'toggle', on: true });
    await drv.write(withValue(find(settings, 'hyper'), { kind: 'toggle', on: false }));
    const ss = await reread();
    expect(find(ss, 'turbo').value).toEqual({ kind: 'toggle', on: false });
  });

  it('numbers: debounce, angle tune', async () => {
    expect(await roundTrip('debounce', { kind: 'number', min: 0, max: 15, current: 4, unit: ' ms' })).toMatchObject({ current: 4 });
    expect(await roundTrip('angle_tune', { kind: 'number', min: -30, max: 30, current: -12, unit: '°' })).toMatchObject({ current: -12 });
    expect(fake.p1[2][0x14]).toBe(0xf4);
  });

  it('sleep incl. Never', async () => {
    const base = find(settings, 'sleep').value as Extract<Value, { kind: 'choice' }>;
    expect(await roundTrip('sleep', { ...base, current: 300 })).toMatchObject({ current: 300 });
    expect(await roundTrip('sleep', { ...base, current: 0xffff })).toMatchObject({ current: 0xffff });
  });

  it('LOD mode + LOD', async () => {
    const lm = find(settings, 'lod_mode').value as Extract<Value, { kind: 'choice' }>;
    await drv.write(withValue(find(settings, 'lod_mode'), { ...lm, current: 0x0b }));
    expect(fake.lod[2]).toEqual([0x01, 0x0b]);
    let ss = await reread();
    const lod = find(ss, 'lod');
    await drv.write(withValue(lod, { ...(lod.value as Extract<Value, { kind: 'choice' }>), current: 0x15 }));
    ss = await reread();
    expect(find(ss, 'lod').value).toMatchObject({ current: 0x15 });
    // a value from the other mode is ignored
    fake.sent = [];
    await drv.write(withValue(lod, { ...(lod.value as Extract<Value, { kind: 'choice' }>), current: 0x99 }));
    expect(fake.sets()).toHaveLength(0);
  });

  it('dpi table + active stage + colours', async () => {
    const dpi = find(settings, 'dpi').value as Extract<Value, { kind: 'dpi' }>;
    const colors = [...dpi.colors!];
    colors[1] = 0x123456;
    const v = await roundTrip('dpi', { ...dpi, stages: [400, 900, 1600, 3200, 6400, 30000], active: 0, colors });
    expect(v).toMatchObject({ stages: [400, 900, 1600, 3200, 6400, 30000], active: 0 });
    expect((v as Extract<Value, { kind: 'dpi' }>).colors![1]).toBe(0x123456);
    expect(fake.table[2].st[1]).toEqual([900, 900]);
    // unchanged colours are not rewritten
    fake.sent = [];
    const ss = await reread();
    fake.sent = [];
    await drv.write(find(ss, 'dpi'));
    expect(fake.sets().map((f) => `${f.page}/${f.cmd}`)).toEqual(['1/1', '1/2']);
  });

  it('dpi: fewer stages via the value, clamp to max', async () => {
    const dpi = find(settings, 'dpi').value as Extract<Value, { kind: 'dpi' }>;
    const v = await roundTrip('dpi', { ...dpi, stages: [400, 99999], active: 5 });
    expect(v).toMatchObject({ stages: [400, 42000], active: 1 });
    expect(find(await reread(), 'dpi_count').value).toMatchObject({ current: 2 });
  });

  it('dpi count + separate X/Y + dpi_y', async () => {
    const cnt = find(settings, 'dpi_count').value as Extract<Value, { kind: 'choice' }>;
    expect(await roundTrip('dpi_count', { ...cnt, current: 2 })).toMatchObject({ current: 2 });
    expect(fake.activeStage[2]).toBe(2);
    let ss = await reread();
    expect(find(ss, 'dpi').value).toMatchObject({ stages: [400, 800], active: 1 });
    await drv.write(withValue(find(ss, 'dpi_xy'), { kind: 'toggle', on: true }));
    ss = await reread();
    const y = find(ss, 'dpi_y');
    await drv.write(withValue(y, { ...(y.value as Extract<Value, { kind: 'dpi' }>), stages: [500, 1000] }));
    ss = await reread();
    expect(find(ss, 'dpi_y').value).toMatchObject({ stages: [500, 1000] });
    expect(find(ss, 'dpi').value).toMatchObject({ stages: [400, 800] });
    // zero stages are filled with defaults when the count grows
    fake.table[2].st[2] = [0, 0];
    ss = await reread();
    await drv.write(withValue(find(ss, 'dpi_count'), { ...cnt, current: 3 }));
    expect(fake.table[2].st[2]).toEqual([1600, 1600]);
  });

  it('stage colour setting', async () => {
    expect(await roundTrip('dpi_color6', { kind: 'color', rgb: 0xabcdef })).toEqual({ kind: 'color', rgb: 0xabcdef });
  });

  it('button mapping + keep', async () => {
    const b4 = find(settings, 'btn4').value as Extract<Value, { kind: 'choice' }>;
    const volUp = b4.options.find((o) => o[0] === 'Volume up')![1];
    expect(await roundTrip('btn4', { ...b4, current: volUp })).toMatchObject({ current: volUp });
    expect(fake.sets()[0].payload).toEqual([2, 4, 0, 5, 2, 0x00, 0xe9]);
    fake.sent = [];
    await drv.write(find(settings, 'btn5')); // KEEP -> nothing sent
    expect(fake.sets()).toHaveLength(0);
  });

  it('profile switch', async () => {
    const p = find(settings, 'profile').value as Extract<Value, { kind: 'choice' }>;
    expect(await roundTrip('profile', { ...p, current: 1 })).toMatchObject({ current: 1 });
    expect(fake.profile).toBe(1);
  });

  it('read-only settings refuse', async () => {
    await expect(drv.write(find(settings, 'fw'))).rejects.toThrow(/can't be changed/);
    await expect(drv.write(find(settings, 'profile_name'))).rejects.toThrow(/can't be changed/);
  });
});

describe('safety', () => {
  it('never sends the bootloader page or blocked commands', async () => {
    const { fake, drv } = await setup();
    await expect(drv.xfer(2, 0xb0, 0x01, 0, [], 0)).rejects.toThrow(/bootloader/);
    await expect(drv.get(2, 0xb0, 0x01, 0)).rejects.toThrow(/bootloader/);
    for (const [page, cmd] of [[0xb0, 1], [0, 0], [0, 0x0d], [0, 0x0a], [0, 0x26], [0, 0x0b], [0, 0x0f], [4, 1], [5, 0], [5, 4], [5, 9]]) {
      await expect(drv.setTo(2, page, cmd, [0xc0, 1], 0)).rejects.toThrow(/blocked/);
    }
    expect(fake.sent).toHaveLength(0);
  });

  it('a full read + writes never touch forbidden commands', async () => {
    const fake = new FakeMouse();
    const drv = (await openWlMouse(fake.asHid(), noSleep))!;
    const ss = await drv.read();
    for (const s of ss) await drv.write(s).catch(() => undefined);
    for (const f of fake.sent) {
      expect(f.page).not.toBe(0xb0);
      if ((f.cmd & 0x80) === 0) {
        expect(f.page === 0 && [0, 0x0a, 0x0b, 0x0d, 0x0f, 0x26].includes(f.cmd)).toBe(false);
        expect(f.page).not.toBe(4);
      }
    }
  });

  it('refuses leaving no button on Left click', async () => {
    const { fake, drv, settings } = await setup();
    const b1 = find(settings, 'btn1');
    const opts = b1.value as Extract<Value, { kind: 'choice' }>;
    const right = opts.options.find((o) => o[0] === 'Right click')![1];
    await expect(drv.write(withValue(b1, { ...opts, current: right }))).rejects.toThrow(/Left click/);
    expect(fake.sets()).toHaveLength(0);
    // map button 2 to Left first, then button 1 may change
    const left = opts.options.find((o) => o[0] === 'Left click')![1];
    await drv.write(withValue(find(settings, 'btn2'), { ...opts, current: left }));
    await drv.write(withValue(b1, { ...opts, current: right }));
    expect(fake.buttons[2][1]).toEqual({ t: 1, d: [2] });
    expect(fake.buttons[2][2]).toEqual({ t: 1, d: [1] });
  });
});

describe('transport', () => {
  it('detects offset 0 and 1', async () => {
    for (const withReportId of [false, true]) {
      const fake = new FakeMouse({ withReportId });
      const drv = (await openWlMouse(fake.asHid(), noSleep))!;
      expect(drv.reportOffset).toBe(withReportId ? 1 : 0);
      expect(await drv.get(2, 0, 0x03, 2)).toEqual([0, 37]);
    }
  });

  it('polls again while pending, ignores stale frames', async () => {
    const { fake, drv } = await setup({ withReportId: true });
    fake.pending = 4;
    fake.stale = 2;
    expect(await drv.get(2, 0, 0x03, 2)).toEqual([0, 37]);
    expect(fake.sent).toHaveLength(1);
  });

  it('resends when busy', async () => {
    const { fake, drv } = await setup();
    fake.busy = 2;
    expect(await drv.get(2, 0, 0x03, 2)).toEqual([0, 37]);
    expect(fake.sent).toHaveLength(3);
    fake.sent = [];
    fake.busy = 5;
    await expect(drv.get(2, 0, 0x03, 2)).rejects.toThrow(/no answer/);
    expect(fake.sent).toHaveLength(3);
  });

  it('unsupported -> error, setting omitted', async () => {
    const { drv } = await setup();
    await expect(drv.get(2, 1, 0x15, 2, [2])).rejects.toThrow(/not supported/);
  });

  it('serializes concurrent transfers', async () => {
    const fake = new FakeMouse();
    let inFlight = 0;
    let maxInFlight = 0;
    const send = fake.sendFeatureReport.bind(fake);
    const recv = fake.receiveFeatureReport.bind(fake);
    fake.sendFeatureReport = async (id, d) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return send(id, d);
    };
    fake.receiveFeatureReport = async (id) => {
      const r = await recv(id);
      inFlight--;
      return r;
    };
    const drv = (await openWlMouse(fake.asHid(), { sleep: () => new Promise((r) => setTimeout(r, 1)) }))!;
    const results = await Promise.all([drv.read(), drv.get(2, 0, 3, 2), drv.get(0, 0, 1, 0x10), drv.read()]);
    expect(maxInFlight).toBe(1);
    expect(results[1]).toEqual([0, 37]);
    expect(find(results[3], 'model').value).toEqual({ kind: 'text', text: 'HUAN M' });
  });
});

describe('receiver screen pictures', () => {
  it('uploads stills in the official frame order and the receiver stores them', async () => {
    const { fake, drv } = await setup();
    expect(drv.screen).toBeDefined();
    const px = new Uint8Array(360 * 360 * 2).map((_, i) => i & 0xff);
    const seen: number[] = [];
    await drv.uploadScreen([{ data: px, width: 360, height: 360, kind: 'still' }], (d, t) => seen.push(d / t));
    const sets = fake.sent.filter((f) => f.page === 5 && f.target === 0);
    expect(sets[0]).toMatchObject({ cmd: 0x04, payload: [2] });
    expect(sets[1]).toMatchObject({ cmd: 0x00, len: 13, payload: [0, 0, 0, 0, 0x00, 0x03, 0xf4, 0x80, 0x01, 0x68, 0x01, 0x68, 1] });
    expect(sets[2].payload.slice(0, 4)).toEqual([0, 0, 0, 9]);
    expect(sets[2].len).toBe(36);
    expect(sets.at(-1)).toMatchObject({ cmd: 0x05, payload: [0] });
    expect(sets.some((f) => f.cmd === 0x80)).toBe(true);
    expect(fake.pictures[0]).toEqual(px);
    expect(fake.slots[0]).toEqual([0x00, 0x03, 0xf4, 0x80, 0x01, 0x68, 0x01, 0x68, 0x01]);
    expect(fake.slots[1]).toBeNull();
    expect(seen.at(-1)).toBe(1);
  });

  it('refuses wrong sizes and too much data before sending anything', async () => {
    const { fake, drv } = await setup();
    const still = { data: new Uint8Array(360 * 360 * 2), width: 360, height: 360, kind: 'still' as const };
    await expect(drv.uploadScreen([{ ...still, width: 300 }])).rejects.toThrow(/360/);
    await expect(drv.uploadScreen([still, still, still])).rejects.toThrow(/too big/);
    expect(fake.sent.length).toBe(0);
  });

  it('clears every picture', async () => {
    const { fake, drv } = await setup();
    await drv.clearScreen();
    expect(fake.slots.every((s) => s === null)).toBe(true);
  });
});

describe('hidden RGB lighting', () => {
  it('reads it into the Advanced group and lists missing features', async () => {
    const { settings } = await setup();
    expect(find(settings, 'rgb_effect').value).toMatchObject({ kind: 'choice', current: 0 });
    expect(find(settings, 'rgb_color').value).toEqual({ kind: 'color', rgb: 0xff0000 });
    expect(find(settings, 'rgb_bri').value).toMatchObject({ current: 100 });
    expect(find(settings, 'rgb_effect').group).toBe('Advanced');
    const missing = find(settings, 'fw_missing').value;
    expect(missing.kind === 'text' && missing.text.split('|')).toContain('Adaptive DPI');
  });

  it('writes brightness then effect in the official frame layout', async () => {
    const { fake, drv, settings } = await setup();
    const e = find(settings, 'rgb_effect');
    await drv.write(withValue(e, { ...(e.value as Extract<Value, { kind: 'choice' }>), current: 4 }));
    const w = fake.sets().filter((f) => f.page === 2);
    expect(w[0]).toMatchObject({ target: 2, cmd: 0x02, payload: [1, 0, 0xff] });
    expect(w[1]).toMatchObject({ target: 2, cmd: 0x00, payload: [1, 0, 4, 0, 6, 0xff, 0, 0] });
    expect(fake.light.effect).toBe(4);
  });
});
