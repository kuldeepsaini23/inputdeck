import { describe, expect, it } from 'vitest';
import { categories, decodeLayer, describe as describeKc, hexCode, idOf, known, label, layerKey, parse, search } from './keycodes';
import type { KeycodeSet } from './keycodes';

const SETS: KeycodeSet[] = ['qmk-v2', 'qmk-v1'];

describe('keycode catalogue', () => {
  it('basic legends', () => {
    expect(label(0x04)).toBe('A');
    expect(label(0x1d)).toBe('Z');
    expect(label(0x1e)).toBe('1');
    expect(label(0x27)).toBe('0');
    expect(label(0x3a)).toBe('F1');
    expect(label(0x45)).toBe('F12');
    expect(label(0x68)).toBe('F13');
    expect(label(0x73)).toBe('F24');
    expect(label(0x29)).toBe('Esc');
    expect(label(0xe1)).toBe('Shift');
    expect(describeKc(0xe5)).toBe('Right Shift');
    expect(label(0x00)).toBe('');
    expect(describeKc(0x00)).toMatch(/None/);
    expect(label(0x01)).toBe('▽');
    expect(describeKc(0x01)).toMatch(/Transparent/);
    expect(label(0xa9)).toBe('Vol+');
  });

  it('mouse keys moved between v1 and v2', () => {
    expect(label(0xd1, 'qmk-v2')).toBe('Btn1');
    expect(label(0xf4, 'qmk-v1')).toBe('Btn1');
    expect(label(0xcd, 'qmk-v2')).toBe('Ms Up');
    expect(label(0xf0, 'qmk-v1')).toBe('Ms Up');
    expect(label(0xff, 'qmk-v1')).toBe('Acl2');
    expect(label(0xdf, 'qmk-v2')).toBe('Acl2');
  });

  it('layer keys (v2 and v1 numbering)', () => {
    expect(layerKey('MO', 1)).toBe(0x5221);
    expect(layerKey('TG', 2)).toBe(0x5262);
    expect(layerKey('TO', 3)).toBe(0x5203);
    expect(layerKey('TT', 1)).toBe(0x52c1);
    expect(layerKey('OSL', 1)).toBe(0x5281);
    expect(layerKey('DF', 0)).toBe(0x5240);
    expect(layerKey('LT', 1, 'qmk-v2', 0x29)).toBe(0x4129);
    expect(layerKey('MO', 1, 'qmk-v1')).toBe(0x5101);
    expect(layerKey('TO', 2, 'qmk-v1')).toBe(0x5012);
    expect(layerKey('TG', 3, 'qmk-v1')).toBe(0x5303);
    expect(layerKey('TT', 1, 'qmk-v1')).toBe(0x5801);
    expect(label(0x5221)).toBe('MO1');
    expect(label(0x5101, 'qmk-v1')).toBe('MO1');
    expect(label(0x4129)).toBe('Esc/L1');
    expect(describeKc(0x4129)).toBe('Escape when tapped, layer 1 while held');
    expect(describeKc(0x5262)).toBe('Toggle layer 2 on / off');
    expect(decodeLayer(0x52c3)).toEqual({ fn: 'TT', layer: 3 });
    expect(decodeLayer(0x04)).toBeUndefined();
  });

  it('modifier combos and mod-tap', () => {
    expect(label(0x0106)).toBe('Ctl+C'); // LCTL(KC_C)
    expect(describeKc(0x0106)).toBe('Ctrl + C');
    expect(label(0x0306)).toBe('CS+C'); // C(S(KC_C))
    expect(label(0x1104)).toBe('RCtl+A');
    expect(label(0x021e)).toBe('!'); // KC_EXLM
    expect(label(0x2129, 'qmk-v2')).toBe('Esc/Ctl'); // MT(MOD_LCTL, KC_ESC)
    expect(label(0x6129, 'qmk-v1')).toBe('Esc/Ctl');
    expect(describeKc(0x2129)).toBe('Escape when tapped, Ctrl when held');
  });

  it('unknown codes show as hex', () => {
    expect(label(0x7c00)).toBe('0x7C00'); // QK_BOOT is not offered
    expect(describeKc(0x7c00)).toMatch(/0x7C00.*kept/);
    expect(known(0x7c00)).toBe(false);
    expect(hexCode(0xab)).toBe('0x00AB');
    expect(parse('0x7c00')).toBe(0x7c00);
    expect(idOf(0x7c00)).toBe('0x7C00');
  });

  it('every catalogue entry round-trips through label / id / parse', () => {
    for (const set of SETS) {
      const cats = categories(set, 4, 0x29);
      expect(cats.map((c) => c.name)).toEqual(['Basic', 'Symbols', 'Mods', 'Nav', 'F keys', 'Numpad', 'Media', 'Mouse', 'Layers']);
      const all = cats.flatMap((c) => c.codes);
      const codes = all.map((k) => k.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const k of all) {
        expect(label(k.code, set)).toBe(k.label);
        expect(describeKc(k.code, set)).toBe(k.name);
        expect(idOf(k.code, set)).toBe(k.id);
        expect(parse(k.id, set)).toBe(k.code);
        expect(k.code).toBeGreaterThanOrEqual(0);
        expect(k.code).toBeLessThanOrEqual(0xffff);
        // nothing that resets, reboots or jumps to the bootloader
        expect(k.code < 0x7c00 || k.code > 0x7cff).toBe(true);
      }
      expect(all.filter((k) => k.layer === 3).map((k) => k.id)).toEqual(['MO(3)', 'TG(3)', 'TO(3)', 'TT(3)', 'OSL(3)', 'DF(3)', 'LT(3,KC_ESC)']);
    }
  });

  it('parses QMK names', () => {
    expect(parse('KC_A')).toBe(0x04);
    expect(parse('a')).toBe(0x04);
    expect(parse('kc_exlm')).toBe(0x021e);
    expect(parse('MO(2)')).toBe(0x5222);
    expect(parse('mo(2)', 'qmk-v1')).toBe(0x5102);
    expect(parse('LT(1, KC_SPC)')).toBe(0x412c);
    expect(parse('MO(99)')).toBeUndefined();
    expect(parse('nonsense')).toBeUndefined();
  });

  it('search', () => {
    expect(search('esc')[0].code).toBe(0x29);
    expect(search('volume').map((k) => k.label)).toEqual(['Vol+', 'Vol-']);
    expect(search('0x1234')[0]).toMatchObject({ code: 0x1234 });
    expect(search('')).toEqual([]);
  });
});
