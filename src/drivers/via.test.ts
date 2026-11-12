import { beforeAll, describe, expect, it } from 'vitest';
import { FAKE_DEF, FakeVia, type FakeViaOpts } from './fakes/fake-via';
import type { Driver, Setting, Value } from './types';
import {
  GENERIC_CAPS,
  allowed,
  macroGetPkt,
  macroSetPkt,
  customGetPkt,
  customSavePkt,
  customSetPkt,
  getBufferPkt,
  hsvToRgb,
  keycodeLabel,
  parseMenus,
  rgbToHs,
  setKeycodePkt,
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
    for (const c of [0x03, 0x04, 0x05, 0x06, 0x0a, 0x0b, 0x0e, 0x0f, 0x10, 0x13, 0x14, 0x15, 0xfe, 0xff]) {
      expect(allowed([c])).toBe(false);
      expect(allowed([c, 0, 0, 1])).toBe(false);
    }
    // macro count / size are plain reads; with arguments they're refused
    expect(allowed([0x0c, 0, 0, 1])).toBe(false);
    expect(allowed([0x0d, 0, 0, 1])).toBe(false);
    // macro reset stays refused even when macro writes are enabled
    expect(allowed([0x10], undefined, { size: 128 })).toBe(false);
    expect(allowed([0x02, 0x03])).toBe(false); // switch matrix state not needed
    expect(allowed([0x02, 0x05])).toBe(false);
    // dangerous commands stay refused even when keymap writes are enabled
    const km = { layers: 4, rows: 4, cols: 4 };
    for (const c of [0x03, 0x06, 0x0a, 0x0b, 0x0d, 0x13, 0x15]) expect(allowed([c, 0, 0, 0, 0, 4], km)).toBe(false);
  });

  it('allows set-keycode only inside the known layers and matrix', () => {
    const km = { layers: 4, rows: 6, cols: 16 };
    expect(allowed(setKeycodePkt(0, 0, 0, 0x04))).toBe(false); // bounds not known yet
    expect(allowed(setKeycodePkt(0, 0, 0, 0x04), km)).toBe(true);
    expect(allowed(setKeycodePkt(3, 5, 15, 0x5221), km)).toBe(true);
    expect(allowed(setKeycodePkt(4, 0, 0, 0x04), km)).toBe(false); // layer
    expect(allowed(setKeycodePkt(0, 6, 0, 0x04), km)).toBe(false); // row
    expect(allowed(setKeycodePkt(0, 0, 16, 0x04), km)).toBe(false); // col
    expect(allowed([0x05, 0, 0, 0, 0], km)).toBe(false); // short
    expect(allowed([...setKeycodePkt(0, 0, 0, 0x04), 1], km)).toBe(false); // trailing junk
    expect(allowed(setKeycodePkt(0, 0, 0, 0x04), { layers: 64, rows: 6, cols: 16 })).toBe(false); // implausible layer count
  });
});

describe('macro allowlist', () => {
  it('allows count / size reads and buffer reads / writes only inside the buffer', () => {
    const mb = { size: 100 };
    expect(allowed([0x0c])).toBe(true);
    expect(allowed([0x0d])).toBe(true);
    expect(allowed(macroGetPkt(0, 28))).toBe(false); // size not known yet
    expect(allowed(macroSetPkt(0, [1, 2]))).toBe(false);
    expect(allowed(macroGetPkt(0, 28), undefined, mb)).toBe(true);
    expect(allowed(macroGetPkt(72, 28), undefined, mb)).toBe(true);
    expect(allowed(macroGetPkt(73, 28), undefined, mb)).toBe(false); // past the end
    expect(allowed(macroGetPkt(0, 29), undefined, mb)).toBe(false); // chunk too big
    expect(allowed(macroGetPkt(0, 0), undefined, mb)).toBe(false);
    expect(allowed([...macroGetPkt(0, 4), 9], undefined, mb)).toBe(false); // trailing junk
    expect(allowed(macroSetPkt(99, [0xff]), undefined, mb)).toBe(true);
    expect(allowed(macroSetPkt(100, [0]), undefined, mb)).toBe(false);
    expect(allowed(macroSetPkt(90, new Array(11).fill(0x41)), undefined, mb)).toBe(false);
    expect(allowed(macroSetPkt(0, new Array(28).fill(0x41)), undefined, mb)).toBe(true);
    expect(allowed([...macroSetPkt(0, [0x41, 0x42]), 7], undefined, mb)).toBe(false); // data past its length
    expect(allowed(macroSetPkt(0, [1]), undefined, { size: 0x10000 })).toBe(false); // implausible size
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
    expect(f.sent.every((p) => allowed(p, undefined, { size: f.macros.length }))).toBe(true);
    expect(f.sent.some((p) => [0x03, 0x05, 0x06, 0x0a, 0x0b, 0x10, 0x13].includes(p[0]))).toBe(false);
  });

  it('reads every keymap layer', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const km = find(ss, 'keymap');
    expect(km.group).toBe('Keys');
    const v = km.value as Extract<Value, { kind: 'keymap' }>;
    expect(v.codes).toBe('qmk-v2');
    expect(v.layers.length).toBe(4);
    expect(v.keys.map((k) => k.index)).toEqual(d.layout!().map((k) => k.index));
    // Esc Q W / Tab A S / Space MO(1) / Enter
    expect(v.layers[0]).toEqual([0x29, 0x14, 0x1a, 0x2b, 0x04, 0x16, 0x2c, 0x5221, 0x28]);
    expect(v.layers[1]).toEqual([1, 0x3a, 0x3b, 1, 1, 1, 0xaa, 0xa9, 1]);
    expect(v.layers[3].every((k) => k === 0)).toBe(true);
    // 4 layers x 16 keys x 2 bytes = 128 bytes in <= 28-byte reads
    const reads = f.sent.filter((p) => p[0] === 0x12);
    expect(reads.every((p) => p[3] <= 28)).toBe(true);
    expect(reads.reduce((n, p) => n + p[3], 0)).toBe(128);
  });

  it('keycode numbering follows the VIA app tables: <=10 v1, 11 v11, 12+ v2', async () => {
    for (const [protocol, codes] of [[10, 'qmk-v1'], [11, 'qmk-v11'], [12, 'qmk-v2']] as const) {
      const [, d] = await connect({ protocol });
      const v = find(await d.read(), 'keymap').value as Extract<Value, { kind: 'keymap' }>;
      expect(v.codes).toBe(codes);
    }
  });

  it('writes only the changed keys with set-keycode and reads them back', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const km = find(ss, 'keymap');
    const v = km.value as Extract<Value, { kind: 'keymap' }>;
    const layers = v.layers.map((l) => l.slice());
    layers[0][1] = 0x08; // Q -> E (row 0, col 1)
    layers[2][8] = 0x5260; // layer 2, Enter (row 1, col 3) -> TG(0)
    f.sent = [];
    await d.write(withValue(km, { ...v, layers }));
    expect(f.keyWrites).toEqual([[0, 0, 1, 0x08], [2, 1, 3, 0x5260]]);
    expect(f.key(0, 0, 1)).toBe(0x08);
    expect(f.key(2, 1, 3)).toBe(0x5260);
    // each write is read back (2 bytes at that key's offset)
    expect(f.sent.filter((p) => p[0] === 0x12).map((p) => [(p[1] << 8) | p[2], p[3]])).toEqual([[2, 2], [(2 * 16 + 7) * 2, 2]]);
    expect(d.layout!().find((c) => c.index === 1)!.label).toBe('E');
    // same map again: nothing sent
    f.sent = [];
    await d.write(withValue(km, { ...v, layers }));
    expect(f.sent.length).toBe(0);
    const again = find(await d.read(), 'keymap').value as Extract<Value, { kind: 'keymap' }>;
    expect(again.layers).toEqual(layers);
  });

  it('unknown keycodes are kept and can be written back unchanged', async () => {
    const [f, d] = await connect();
    f.setKey(1, 0, 0, 0x7e05);
    const ss = await d.read();
    const km = find(ss, 'keymap');
    const v = km.value as Extract<Value, { kind: 'keymap' }>;
    expect(v.layers[1][0]).toBe(0x7e05);
    const layers = v.layers.map((l) => l.slice());
    layers[1][1] = 0x04;
    await d.write(withValue(km, { ...v, layers }));
    expect(f.keyWrites).toEqual([[1, 0, 1, 0x04]]);
    expect(f.key(1, 0, 0)).toBe(0x7e05);
  });

  it('reports a key change the board ignores', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const ss = await d.read();
    const km = find(ss, 'keymap');
    const v = km.value as Extract<Value, { kind: 'keymap' }>;
    const layers = v.layers.map((l) => l.slice());
    layers[0][0] = 0x04;
    await expect(d.write(withValue(km, { ...v, layers }))).rejects.toThrow(/didn't take/);
  });

  it('refuses keymaps that do not fit the board', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const km = find(ss, 'keymap');
    const v = km.value as Extract<Value, { kind: 'keymap' }>;
    await expect(d.write(withValue(km, { ...v, layers: [...v.layers, v.layers[0]] }))).rejects.toThrow(/match/);
    await expect(d.write(withValue(km, { ...v, keys: v.keys.slice(1) }))).rejects.toThrow(/match/);
    const bad = v.layers.map((l) => l.slice());
    bad[0][0] = 0x10000;
    await expect(d.write(withValue(km, { ...v, layers: bad }))).rejects.toThrow(/bad keycode/);
    expect(f.keyWrites).toEqual([]);
  });

  it('no definition: no keymap setting and no keymap writes', async () => {
    const [, d] = await connect({}, null);
    const ss = await d.read();
    expect(ss.some((s) => s.key === 'keymap')).toBe(false);
  });

  it('reads the macro slots', async () => {
    const [f, d] = await connect();
    const ss = await d.read();
    const m = find(ss, 'macros');
    expect(m.group).toBe('Macros');
    const v = m.value as Extract<Value, { kind: 'macros' }>;
    expect(v).toMatchObject({ slots: 4, maxBytes: 128, format: 'qmk', delays: true });
    expect(v.macros[0]).toEqual([{ t: 'text', text: 'hi' }, { t: 'tap', kc: 0x28 }]);
    expect(v.macros.slice(1)).toEqual([[], [], []]);
    const reads = f.sent.filter((p) => p[0] === 0x0e);
    expect(reads.every((p) => p[3] <= 28)).toBe(true);
    expect(reads.reduce((n, p) => n + p[3], 0)).toBe(128);
  });

  it('old protocol macros have no delays', async () => {
    const [f, d] = await connect({ protocol: 10 });
    f.macros.fill(0);
    f.macros.set([0x02, 0xe1, 0x61, 0x03, 0xe1, 0x00]);
    const v = find(await d.read(), 'macros').value as Extract<Value, { kind: 'macros' }>;
    expect(v).toMatchObject({ format: 'qmk-legacy', delays: false });
    expect(v.macros[0]).toEqual([{ t: 'down', kc: 0xe1 }, { t: 'text', text: 'a' }, { t: 'up', kc: 0xe1 }]);
  });

  it('writes macros, keeps untouched slots byte for byte, and reads them back', async () => {
    const [f, d] = await connect();
    // M1 holds bytes we decode lossily (prefix + unknown action 0x09)
    f.macros.set([0x01, 0x09, 0x41, 0x00], 6);
    const ss = await d.read();
    const m = find(ss, 'macros');
    const v = m.value as Extract<Value, { kind: 'macros' }>;
    const macros = v.macros.map((x) => x.slice());
    macros[2] = [{ t: 'down', kc: 0xe0 }, { t: 'tap', kc: 0x06 }, { t: 'up', kc: 0xe0 }, { t: 'delay', ms: 250 }, { t: 'text', text: 'ok' }];
    f.sent = [];
    await d.write(withValue(m, { ...v, macros }));
    const want = [0x68, 0x69, 1, 1, 0x28, 0, 0x01, 0x09, 0x41, 0, 1, 2, 0xe0, 1, 1, 0x06, 1, 3, 0xe0, 1, 4, 0x32, 0x35, 0x30, 0x7c, 0x6f, 0x6b, 0, 0];
    expect(Array.from(f.macros.subarray(0, want.length))).toEqual(want);
    expect(f.macros.subarray(want.length).every((b) => b === 0)).toBe(true);
    // in-progress flag first, cleared last; only changed chunks in between; never a reset
    const sets = f.macroWrites;
    expect(sets[0]).toEqual([127, [0xff]]);
    expect(sets.at(-1)).toEqual([127, [0]]);
    expect(sets.slice(1, -1).map(([o]) => o)).toEqual([0]);
    expect(f.sent.some((p) => p[0] === 0x10)).toBe(false);
    // read back (whole buffer)
    expect(f.sent.filter((p) => p[0] === 0x0e).reduce((n, p) => n + p[3], 0)).toBe(128);
    const again = find(await d.read(), 'macros').value as Extract<Value, { kind: 'macros' }>;
    expect(again.macros[2]).toEqual(macros[2]);
    // writing the same thing again sends nothing
    f.macroWrites = [];
    await d.write(withValue(m, { ...again }));
    expect(f.macroWrites).toEqual([]);
  });

  it('refuses macros that do not fit or cannot be stored', async () => {
    const [f, d] = await connect({ macroSize: 32 });
    const ss = await d.read();
    const m = find(ss, 'macros');
    const v = m.value as Extract<Value, { kind: 'macros' }>;
    const big = v.macros.map((x) => x.slice());
    big[1] = [{ t: 'text', text: 'x'.repeat(40) }];
    await expect(d.write(withValue(m, { ...v, macros: big }))).rejects.toThrow(/room for 32/);
    const bad = v.macros.map((x) => x.slice());
    bad[1] = [{ t: 'tap', kc: 0x5221 }];
    await expect(d.write(withValue(m, { ...v, macros: bad }))).rejects.toThrow(/M1/);
    await expect(d.write(withValue(m, { ...v, macros: v.macros.slice(1) }))).rejects.toThrow(/match/);
    expect(f.macroWrites).toEqual([]);
  });

  it('old protocol refuses delay steps', async () => {
    const [, d] = await connect({ protocol: 10 });
    const m = find(await d.read(), 'macros');
    const v = m.value as Extract<Value, { kind: 'macros' }>;
    const macros = v.macros.map((x) => x.slice());
    macros[1] = [{ t: 'delay', ms: 10 }];
    await expect(d.write(withValue(m, { ...v, macros }))).rejects.toThrow(/delays/);
  });

  it('reports a macro write the board ignores', async () => {
    const [, d] = await connect({ ignoreWrites: true });
    const m = find(await d.read(), 'macros');
    const v = m.value as Extract<Value, { kind: 'macros' }>;
    const macros = v.macros.map((x) => x.slice());
    macros[3] = [{ t: 'text', text: 'x' }];
    await expect(d.write(withValue(m, { ...v, macros }))).rejects.toThrow(/didn't take the macro/);
  });

  it('firmware without macros: no macros setting, no macro buffer access', async () => {
    const [f, d] = await connect({ macroCount: 0 });
    const ss = await d.read();
    expect(ss.some((s) => s.key === 'macros')).toBe(false);
    expect(f.sent.some((p) => p[0] === 0x0e || p[0] === 0x0f)).toBe(false);
  });

  it('close detaches', async () => {
    const [f, d] = await connect();
    await d.close();
    expect(f.listenerCount()).toBe(0);
    expect(f.opened).toBe(false);
  });
});
