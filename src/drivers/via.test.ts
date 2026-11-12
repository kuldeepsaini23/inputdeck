import { beforeAll, describe, expect, it } from 'vitest';
import { FAKE_DEF, FakeVia, type FakeViaOpts } from './fakes/fake-via';
import type { Driver, Setting, Value } from './types';
import {
  GENERIC_CAPS,
  allowed,
  customGetPkt,
  customSavePkt,
  customSetPkt,
  getBufferPkt,
  hsvToRgb,
  keycodeLabel,
  parseMenus,
  rgbToHs,
  toCaps,
  unpackLayoutOptions,
  viaConfig,
  viaFactory,
} from './via';

let defs: Record<number, unknown> = {};
const fetched: string[] = [];

beforeAll(() => {
  viaConfig.reply = 40;
  viaConfig.fetch = async (url: string) => {
    fetched.push(url);
    const id = Number(url.match(/(\d+)\.json$/)?.[1]);
    if (!(id in defs)) throw new Error('404');
    return structuredClone(defs[id]);
  };
});

async function connect(o?: FakeViaOpts, def: unknown = FAKE_DEF): Promise<[FakeVia, Driver]> {
  const f = new FakeVia(o);
  defs = def ? { [((f.vendorId << 16) | f.productId) >>> 0]: def } : {};
  const d = await viaFactory.create(f.asDevice());
  expect(d).not.toBeNull();
  return [f, d!];
}
const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, v: Value): Setting => ({ ...s, value: v });

describe('allowlist', () => {
  it('allows only the reads and lighting writes we use', () => {
    expect(allowed([0x01])).toBe(true);
    expect(allowed([0x11])).toBe(true);
    expect(allowed([0x02, 0x02])).toBe(true);
    expect(allowed(getBufferPkt(0, 28))).toBe(true);
    expect(allowed(getBufferPkt(0, 29))).toBe(false);
    expect(allowed(customGetPkt(3, 1))).toBe(true);
    expect(allowed(customSetPkt(3, 4, 10, 20))).toBe(true);
    expect(allowed(customSetPkt(3, 2, 5))).toBe(true);
    expect(allowed(customSavePkt(2))).toBe(true);
    expect(allowed(customSetPkt(5, 4, 1, 1))).toBe(false); // led matrix has no colour
    expect(allowed(customSetPkt(0, 1, 1))).toBe(false); // vendor channel
    expect(allowed(customSetPkt(4, 1, 1))).toBe(false); // audio
    expect(allowed([0x07, 3, 2, 5, 9])).toBe(false); // trailing junk
  });

  it('refuses every dangerous command', () => {
    for (const c of [0x03, 0x04, 0x05, 0x06, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x13, 0x14, 0x15, 0xfe, 0xff]) {
      expect(allowed([c])).toBe(false);
      expect(allowed([c, 0, 0, 1])).toBe(false);
    }
    expect(allowed([0x02, 0x03])).toBe(false); // switch matrix state not needed
    expect(allowed([0x02, 0x05])).toBe(false);
  });
});

describe('helpers', () => {
  it('keycode legends', () => {
    expect(keycodeLabel(0x04)).toBe('A');
    expect(keycodeLabel(0x1e)).toBe('1');
    expect(keycodeLabel(0x27)).toBe('0');
    expect(keycodeLabel(0x3a)).toBe('F1');
    expect(keycodeLabel(0x45)).toBe('F12');
    expect(keycodeLabel(0x68)).toBe('F13');
    expect(keycodeLabel(0x2c)).toBe('Space');
    expect(keycodeLabel(0xe1)).toBe('Shift');
    expect(keycodeLabel(0x5221)).toBe('Fn');
    expect(keycodeLabel(0x5101)).toBe('Fn');
    expect(keycodeLabel(0x4129)).toBe('Esc'); // LT(1, Esc)
    expect(keycodeLabel(0x7c00)).toBe('');
  });

  it('colour roundtrip', () => {
    expect(hsvToRgb(0, 255)).toBe(0xff0000);
    expect(hsvToRgb(0, 0)).toBe(0xffffff);
    expect(rgbToHs(0xff0000)).toEqual([0, 255]);
    const [h, s] = rgbToHs(0x00ff00);
    expect(h).toBe(85);
    expect(s).toBe(255);
  });

  it('layout option bits (last label in the low bits)', () => {
    expect(unpackLayoutOptions(0b11, ['a', ['b', 'x', 'y']])).toEqual([1, 1]);
    expect(unpackLayoutOptions(0b10, ['a', ['b', 'x', 'y']])).toEqual([1, 0]);
    expect(unpackLayoutOptions(0b1101, [['m', '1', '2', '3', '4'], 'b', 'c'])).toEqual([3, 0, 1]);
  });

  it('menus', () => {
    const m = parseMenus(['qmk_backlight_rgblight']);
    expect([...m.keys()].sort()).toEqual([1, 2]);
    const c = parseMenus([
      {
        label: 'Lighting',
        content: [
          { label: 'Backlight', content: [
            { label: 'Brightness', type: 'range', options: [0, 200], content: ['id_qmk_rgb_matrix_brightness', 3, 1] },
            { label: 'Effect', type: 'dropdown', content: ['id_qmk_rgb_matrix_effect', 3, 2], options: [['None', 0], ['Solid', 1]] },
            { label: 'Vendor', type: 'toggle', content: ['id_custom', 0, 7] },
          ] },
        ],
      },
    ]);
    expect([...c.keys()]).toEqual([3]);
    expect(c.get(3)!.briMax).toBe(200);
    expect(c.get(3)!.effects).toEqual([['None', 0], ['Solid', 1]]);
    expect([...c.get(3)!.values]).toEqual([1, 2]);
  });

  it('rotated keys keep their centre', () => {
    const { caps } = toCaps([
      { row: 0, col: 0, x: 0, y: 0 },
      { row: 0, col: 1, x: 1, y: 0, r: 90, rx: 0, ry: 0 },
    ], 2);
    // centre (1.5, 0.5) rotated 90deg about origin -> (-0.5, 1.5); normalised by minX = -1
    expect(caps[1]).toMatchObject({ index: 1, x: 0, y: 1 });
    expect(caps[0]).toMatchObject({ x: 1, y: 0 });
  });
});

describe('fake VIA keyboard', () => {
  it('matches the VIA collection but not other drivers\' devices', () => {
    const f = new FakeVia();
    expect(viaFactory.match(f.asDevice())).toBe(true);
    for (const [vid, pid] of [[0x36a7, 1], [0x373e, 1], [0x37b0, 1], [0x3710, 1], [0x3554, 1], [0x2e3c, 0xc365]]) {
      expect(viaFactory.match(new FakeVia({ vendorId: vid, productId: pid }).asDevice())).toBe(false);
    }
    const other = new FakeVia();
    other.collections = [{ usagePage: 0xff1b, usage: 0x91 }] as unknown as HIDCollectionInfo[];
    expect(viaFactory.match(other.asDevice())).toBe(false);
    expect(viaFactory.filters).toEqual([{ usagePage: 0xff60, usage: 0x61 }]);
  });

  it('reads info, layout (with options, ISO enter, knob) and legends', async () => {
    const [, d] = await connect();
    const ss = await d.read();
    expect(d.verified).toBe(false);
    expect(d.brand()).toBe('KEYCHRON');
    expect(d.model()).toBe('Q0 Test');
    expect(fetched.at(-1)).toBe(`https://usevia.app/definitions/v3/${0x34340194}.json`);
    expect((find(ss, 'protocol').value as { text: string }).text).toContain('12');
    expect((find(ss, 'layers').value as { text: string }).text).toBe('4');
    expect((find(ss, 'fw').value as { text: string }).text).toBe('0x00010203');
    expect(d.knob).toEqual({ x: 3, y: 0 });
    expect(ss.some((x) => x.key === 'per_key_color')).toBe(false);
    const caps = d.layout!();
    expect(caps.map((c) => c.label)).toEqual(['Esc', 'Q', 'W', 'Tab', 'A', 'S', 'Space', 'Fn', 'Enter']);
    // split space (option 1) and ISO enter (2u tall)
    expect(caps.find((c) => c.label === 'Fn')).toMatchObject({ x: 1.5, y: 2, w: 1.5 });
    expect(caps.find((c) => c.label === 'Enter')).toMatchObject({ x: 3.75, y: 0, w: 1.25, h: 2 });
    expect(caps.find((c) => c.label === 'Tab')).toMatchObject({ index: 4, w: 1.5 });
  });

  it('reads and writes rgb matrix lighting with custom save', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const mode = find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>;
    expect(mode.current).toBe(4);
    expect(mode.options[4][0]).toBe('Gradient Left/Right');
    const bri = find(ss, 'light_bri');
    expect(bri.value).toMatchObject({ min: 0, max: 10, current: 8 });
    expect((find(ss, 'light_power').value as { on: boolean }).on).toBe(true);

    await d.write(withValue(bri, { ...(bri.value as Extract<Value, { kind: 'number' }>), current: 5 }));
    expect(f.values.get(3)![0]).toBe(128);
    await d.write(withValue(find(ss, 'light_mode'), { ...mode, current: 1 }));
    expect(f.values.get(3)![1]).toBe(1);
    await d.write(withValue(find(ss, 'light_color'), { kind: 'color', rgb: 0x00ff00 }));
    expect(f.values.get(3)!.slice(3)).toEqual([85, 255]);
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: false }));
    expect(f.values.get(3)![1]).toBe(0);
    await d.write(withValue(find(ss, 'light_power'), { kind: 'toggle', on: true }));
    expect(f.values.get(3)![1]).toBe(1);
    expect(f.saves.length).toBe(5);
    expect(f.saves.every((c) => c === 3)).toBe(true);
  });

  it('reports a write the board ignores', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    const bri = find(ss, 'light_bri');
    await expect(d.write(withValue(bri, { ...(bri.value as Extract<Value, { kind: 'number' }>), current: 2 }))).rejects.toThrow(/didn't take/);
  });

  it('without a definition: probes channels and draws the generic board', async () => {
    const [f, d] = await connect({ channels: [2] }, null);
    const ss = await d.read();
    expect(d.brand()).toBe('KEYCHRON');
    expect(d.model()).toBe('Q0 Test');
    expect(d.layout!()).toBe(GENERIC_CAPS);
    expect((find(ss, 'light_mode').value as Extract<Value, { kind: 'choice' }>).options[1][0]).toBe('Solid Color');
    // probed 3, 5 (unhandled) then 2 and 1
    expect(f.sent.filter((p) => p[0] === 0x08 && p[2] === 1).map((p) => p[1]).slice(0, 4)).toEqual([3, 5, 2, 1]);
    expect(f.sent.some((p) => p[0] === 0x12)).toBe(false);
  });

  it('old protocol: no lighting, still identifies', async () => {
    const [, d] = await connect({ protocol: 9 });
    const ss = await d.read();
    expect(ss.some((s) => s.key === 'light_mode')).toBe(false);
    await expect(d.write(withValue(find(ss, 'layers'), { kind: 'text', text: '1' }))).rejects.toThrow();
  });

  it('never sends a packet outside the allowlist', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    for (const s of ss) await d.write(s).catch(() => undefined);
    expect(f.sent.every((p) => allowed(p))).toBe(true);
    expect(f.sent.some((p) => [0x03, 0x05, 0x06, 0x0a, 0x0b, 0x10, 0x13].includes(p[0]))).toBe(false);
  });

  it('close detaches', async () => {
    const [f, d] = await connect();
    await d.close();
    expect(f.listenerCount()).toBe(0);
    expect(f.opened).toBe(false);
  });
});
