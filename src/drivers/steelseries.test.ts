// Expected bytes are rivalcfg's own test vectors (test/devices/specs, test/devices/old_specs, test/handlers),
// without the leading report-type / report-id bytes of its fake device.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SS_PROFILES } from './steelseries-devices.gen';
import {
  ACT_BUTTON,
  ACT_KEY,
  batteryOf,
  encButtons,
  encGradient,
  encGradientV2,
  encMultiDpi,
  encReactive,
  packet,
  steelseriesFactory,
  timing,
  type SsSetting,
} from './steelseries';
import type { Setting, Value } from './types';
import { FakeSteelSeries } from './fakes/fake-steelseries';

const prof = (id: string) => SS_PROFILES.find((p) => p.id === id)!;
const hex = (s: string) => Array.from(s.trim().split(/\s+/), (x) => parseInt(x, 16));
const bytes = (u: Uint8Array) => Array.from(u);
const zeros = (n: number) => new Array<number>(n).fill(0);

describe('table', () => {
  it('has every rivalcfg family with unique product ids', () => {
    expect(SS_PROFILES.length).toBeGreaterThanOrEqual(33);
    const pids = SS_PROFILES.flatMap((p) => p.models.map((m) => m.pid));
    expect(new Set(pids).size).toBe(pids.length);
    expect(pids).toContain(0x1824); // Rival 3
    expect(pids).toContain(0x1838); // Aerox 3 Wireless (2.4 GHz)
  });
  it('wireless mode commands carry the 0x40 flag and a readback', () => {
    const w = prof('aerox3_wireless_wireless').settings.sensitivity;
    expect(w.command).toEqual([0x6d]);
    expect(w.readback_length).toBe(64);
    expect(prof('aerox3_wireless_wireless').save!.command).toEqual([0x51, 0x00]);
  });
});

describe('encoders match rivalcfg', () => {
  it('Aerox 3 Wireless DPI (specs/aerox3_wireless_wireless.txt)', () => {
    const s = prof('aerox3_wireless_wireless').settings.sensitivity;
    expect(bytes(packet(s, encMultiDpi(s, [100])))).toEqual(hex('6D 01 00 00'));
    expect(bytes(packet(s, encMultiDpi(s, [18000])))).toEqual(hex('6D 01 00 D6'));
    expect(bytes(packet(s, encMultiDpi(s, [200, 400, 800, 1600, 18000])))).toEqual(hex('6D 05 00 02 04 09 12 D6'));
  });
  it('Aerox 3 Wireless polling and colour', () => {
    const p = prof('aerox3_wireless_wireless');
    const poll = p.settings.polling_rate;
    expect(bytes(packet(poll, [poll.choices!.find(([hz]) => hz === 125)![1]].flat()))).toEqual(hex('6B 03'));
    expect(bytes(packet(p.settings.z1_color, [0xab, 0xcd, 0xef]))).toEqual(hex('61 01 00 AB CD EF'));
  });
  it('Rival 3 DPI, buttons and save (old_specs/test_rival3.py)', () => {
    const p = prof('rival3');
    const s = p.settings.sensitivity;
    expect(bytes(packet(s, encMultiDpi(s, [200])))).toEqual(hex('0b 00 01 01 04'));
    expect(bytes(packet(s, encMultiDpi(s, [200, 400, 800, 1600])))).toEqual(hex('0b 00 04 01 04 08 12 24'));
    const b = p.settings.buttons_mapping;
    // defaults with button2 = button6
    const acts = [0, 5, 2, 3, 4, 0x02 /* dpi */, 6, 7].map((x, i) => (i === 5 ? x : ACT_BUTTON + x));
    expect(bytes(packet(b, encButtons(b, acts)))).toEqual(hex('07 00 01 00 06 00 03 00 04 00 05 00 30 00 31 00 32 00'));
    // scroll up / down swapped
    const sw = [0, 1, 2, 3, 4, 0x02, 7, 6].map((x, i) => (i === 5 ? x : ACT_BUTTON + x));
    expect(bytes(packet(b, encButtons(b, sw)))).toEqual(hex('07 00 01 00 02 00 03 00 04 00 05 00 30 00 32 00 31 00'));
    expect(bytes(packet(p.save!))).toEqual(hex('09 00'));
  });
  it('Rival 3 keyboard key on a button', () => {
    const b = prof('rival3').settings.buttons_mapping;
    const acts = [0, 1, 2, 3, 4, 0, 6, 7].map((x) => ACT_BUTTON + x);
    acts[3] = ACT_KEY | 0x04; // A
    const out = encButtons(b, acts);
    expect(out.slice(6, 8)).toEqual([b.button_keyboard!, 0x04]);
  });
  it('Rival 310 buttons and gradient colour (old_specs/test_rival310.py)', () => {
    const p = prof('rival310');
    const b = p.settings.buttons_mapping;
    const acts = [0, 1, 2, 3, 4, 0x02].map((x, i) => (i === 5 ? x : ACT_BUTTON + x));
    expect(bytes(packet(b, encButtons(b, acts)))).toEqual(hex('31 00 01 00 00 00 00 02 00 00 00 00 03 00 00 00 00 04 00 00 00 00 05 00 00 00 00 30 00 00 00 00'));
    const w = p.settings.wheel_color;
    expect(bytes(packet(w, encGradient(w, [{ pos: 0, color: 0xff1800 }])))).toEqual(
      [...hex('5b 00 01 e8 03 00 00 00'), ...zeros(10), ...hex('00 01 00 00 00 00 00 00 00 01 ff 18 00 ff 18 00 00')],
    );
    expect(p.settings.logo_color.report_type).toBe('feature');
    // the 3-colour gradient from the same test file
    const l = p.settings.logo_color;
    expect(bytes(packet(l, encGradient(l, [{ pos: 0, color: 0xff0000 }, { pos: 33, color: 0x00ff00 }, { pos: 66, color: 0x0000ff }, { pos: 100, color: 0xff0000 }])))).toEqual(
      [...hex('5b 00 00 e8 03 00 00 00'), ...zeros(10), ...hex('00 00 00 00 00 00 00 00 00 04 ff 00 00 ff 00 00 00 00 ff 00 54 00 00 ff 54 ff 00 00 57')],
    );
  });
  it('Rival 310 two DPI stages', () => {
    const s = prof('rival310').settings.sensitivity1 as SsSetting;
    expect(s.command).toEqual([0x53, 0x00, 0x01]);
  });
  it('gradient v2 plain colour (test_rgbgradientv2.py)', () => {
    const s = { value_type: 'rgbgradientv2', rgbgradientv2_header: { color_field_length: 139, duration_length: 2, maxgradient: 14 }, led_id: 2 } as SsSetting;
    const out = encGradientV2(s, [{ pos: 0, color: 0xff2200 }]);
    expect(out.slice(0, 9)).toEqual(hex('02 1D 01 02 31 51 FF C8 00'));
    expect(out.slice(9, 139).every((x) => x === 0)).toBe(true);
    expect(out.slice(139)).toEqual(hex('F0 0F 20 02 00 00 FF 00 DC 05 8A 02 00 00 00 00 01 00 00 00 E8 03'));
  });
  it('reactive colour', () => {
    expect(encReactive(true, 0x112233)).toEqual([1, 0, 0x11, 0x22, 0x33]);
    expect(encReactive(false, 0x112233)).toEqual([0, 0, 0, 0, 0]);
  });
  it('battery formats', () => {
    expect(batteryOf('aerox', Uint8Array.from([0, 0x80 | 21]))).toEqual({ level: 100, charging: true });
    expect(batteryOf('aerox', Uint8Array.from([0, 11]))).toEqual({ level: 50, charging: false });
    expect(batteryOf('rival', Uint8Array.from([77, 0, 1]))).toEqual({ level: 77, charging: true });
    expect(batteryOf('rival', Uint8Array.from([200, 0, 0]))).toBeUndefined();
  });
});

/** a fake that stores like a real mouse (localStorage, mocked below) */
const real = (...a: ConstructorParameters<typeof FakeSteelSeries>) => Object.assign(new FakeSteelSeries(...a), { simulated: false });
const find = (s: Setting[], k: string) => s.find((x) => x.key === k)!;
const withV = (s: Setting, value: Value): Setting => ({ ...s, value });

describe('driver', () => {
  let mem: Record<string, string>;
  beforeEach(() => {
    timing.gap = 0;
    timing.answer = 20;
    mem = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => (mem[k] = v),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('matches only the vendor settings interface of a known model', () => {
    const d = real(0x1824);
    expect(steelseriesFactory.match(d as unknown as HIDDevice)).toBe(true);
    d.collections = [{ usagePage: 0x01, usage: 2, inputReports: [], outputReports: [], featureReports: [] }] as unknown as HIDCollectionInfo[];
    expect(steelseriesFactory.match(d as unknown as HIDDevice)).toBe(false);
    expect(steelseriesFactory.match(real(0x9999) as unknown as HIDDevice)).toBe(false);
  });

  it('Rival 3: reads firmware, shows defaults, writes DPI and saves', async () => {
    const dev = real(0x1824, (d) => (d[0] === 0x10 ? [1, 33] : undefined));
    const drv = (await steelseriesFactory.create(dev as unknown as HIDDevice))!;
    expect(drv.verified).toBe(false);
    expect(drv.model()).toBe('Rival 3');
    const s = await drv.read();
    expect((find(s, 'fw').value as { text: string }).text).toBe('1.33');
    expect(find(s, 'dpi').value).toMatchObject({ stages: [800, 1600], active: 0, min: 200, max: 8500 });
    expect(find(s, 'polling').value).toMatchObject({ current: 1000 });
    expect(find(s, 'btn6').value).toMatchObject({ current: 2 });
    expect(s.filter((x) => /^btn\d$/.test(x.key))).toHaveLength(8);
    dev.sent = [];
    await drv.write(withV(find(s, 'dpi'), { ...(find(s, 'dpi').value as Extract<Value, { kind: 'dpi' }>), stages: [400, 800], active: 1 }));
    expect(dev.sent).toEqual([{ type: 'output', data: hex('0b 00 02 02 08 12') }]);
    // remembered for next time
    const again = await drv.read();
    expect(find(again, 'dpi').value).toMatchObject({ stages: [400, 800], active: 1 });
    await drv.close();
    expect(dev.sent.at(-1)).toEqual({ type: 'output', data: hex('09 00') });
    expect(JSON.parse(mem['inputdeck.steelseries.rival3']).sensitivity).toEqual({ stages: [400, 800], active: 1 });
  });

  it('Rival 3: polling, colour, button to key', async () => {
    const dev = real(0x1824);
    const drv = (await steelseriesFactory.create(dev as unknown as HIDDevice))!;
    const s = await drv.read();
    dev.sent = [];
    await drv.write(withV(find(s, 'polling'), { ...(find(s, 'polling').value as Extract<Value, { kind: 'choice' }>), current: 500 }));
    await drv.write(withV(find(s, 'ss_logo_color'), { kind: 'color', rgb: 0x123456 }));
    await drv.write(withV(find(s, 'btn4'), { ...(find(s, 'btn4').value as Extract<Value, { kind: 'choice' }>), current: ACT_KEY | 0x2c }));
    expect(dev.sent.map((x) => x.data)).toEqual([hex('04 00 02'), hex('05 00 04 12 34 56 64'), hex('07 00 01 00 02 00 03 00 33 2c 05 00 30 00 31 00 32 00')]);
    expect(find(await drv.read(), 'btn4').value).toMatchObject({ current: ACT_KEY | 0x2c });
    await drv.close();
  });

  it('Aerox 3 Wireless: battery and readback in 2.4 GHz mode', async () => {
    const dev = real(0x1838, (d) => (d[0] === 0xd2 ? [0, 0x80 | 15] : [0]));
    const drv = (await steelseriesFactory.create(dev as unknown as HIDDevice))!;
    const s = await drv.read();
    expect((find(s, 'battery').value as { text: string }).text).toBe('70% (charging)');
    dev.sent = [];
    await drv.write(withV(find(s, 'sleep'), { ...(find(s, 'sleep').value as Extract<Value, { kind: 'choice' }>), current: 10 }));
    expect(dev.sent[0].data[0] & 0x40).toBe(0x40);
    await drv.close();
  });

  it('two-stage mice write each stage separately and refuse picking the active one', async () => {
    const pid = prof('rival310').models[0].pid;
    const dev = real(pid);
    const drv = (await steelseriesFactory.create(dev as unknown as HIDDevice))!;
    const s = await drv.read();
    const dpi = find(s, 'dpi').value as Extract<Value, { kind: 'dpi' }>;
    expect(dpi.stages).toHaveLength(2);
    dev.sent = [];
    await drv.write(withV(find(s, 'dpi'), { ...dpi, stages: [1000, dpi.stages[1]] }));
    expect(dev.sent.map((x) => x.data)).toEqual([hex('53 00 01 09 00 42')]);
    await expect(drv.write(withV(find(s, 'dpi'), { ...dpi, active: 1 }))).rejects.toThrow();
    await drv.close();
  });

  it('the demo mouse never touches localStorage', async () => {
    const drv = (await steelseriesFactory.create(new FakeSteelSeries().asHid()))!;
    const st = await drv.read();
    await drv.write(withV(find(st, 'ss_logo_color'), { kind: 'color', rgb: 0x00ff00 }));
    expect(mem).toEqual({});
    await drv.close();
  });

  it('every model reads and every setting it shows can be written', async () => {
    for (const p of SS_PROFILES) {
      const dev = real(p.models[0].pid, () => [1, 2, 3]);
      const drv = (await steelseriesFactory.create(dev as unknown as HIDDevice))!;
      const s = await drv.read();
      for (const st of s) {
        if (st.group === 'Info' || st.value.kind === 'text') continue;
        await expect(drv.write(st), `${p.id} ${st.key}`).resolves.toBeUndefined();
      }
      await drv.close();
    }
  }, 60_000);
});
