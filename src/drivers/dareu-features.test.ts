// DAREU TG firmware: key map, MT / TGL / DKS, macros, profiles and lighting extras, against the
// fake board. Byte layouts follow driver.dareu.com/allinone (device/tgdevice.js, device.js,
// subpage/tg/keyfunction.html, macro.html, module/keybinding/{mt,tgl,dks}.html).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeDareu, type FakeDareuOpts } from './fakes/fake-dareu';
import type { AdvancedKeys, Driver, Setting, Value } from './types';
import {
  CLS,
  GET,
  KEY,
  MAG,
  MCO,
  PFL,
  allowed,
  capsFor,
  dareuFactory,
  dareuTiming,
  frame,
  getAssignPkt,
  macroCreatePkt,
  macroDataPkts,
  macroDeletePkt,
  macroNamePkts,
  productFor,
  removeBindingPkt,
  setAssignPkt,
  setDksPkt,
  setMtPkt,
  setProfilePkt,
  setTglPkt,
} from './dareu';
import { OPAQUE_BASE, assignOfCode, codeOfAssign, keyIdOfUsage, usageOfKeyId } from './dareu-keys';
import { decodeMacro, encodeMacro } from '../lib/macros';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const head = (f: Uint8Array, n: number) => Array.from(f.slice(0, n));
const realTiming = { ...dareuTiming };
beforeAll(() => {
  Object.assign(dareuTiming, { poll: 0, tries: 3, pollSettle: 0, verifySettle: 0 });
});
afterAll(() => {
  Object.assign(dareuTiming, realTiming);
});

async function connect(o?: FakeDareuOpts, setup?: (f: FakeDareu) => void): Promise<[FakeDareu, Driver, Setting[]]> {
  const f = new FakeDareu(o);
  setup?.(f);
  const d = await dareuFactory.create(f.asDevice());
  expect(d).not.toBeNull();
  return [f, d!, await d!.read()];
}
const find = (ss: Setting[], key: string) => {
  const s = ss.find((x) => x.key === key);
  if (!s) throw new Error(`missing ${key}`);
  return s;
};
const withValue = (s: Setting, v: Value): Setting => ({ ...s, value: v });
type Keymap = Extract<Value, { kind: 'keymap' }>;
type Macros = Extract<Value, { kind: 'macros' }>;

const CAPS = capsFor(productFor(0x0175)!);
const pos = (id: number) => CAPS.findIndex((k) => k.index === id);
const A = 61;
const S = 62;
const D = 63;
const Z = 80;
const TAB = 39;
const FN = 107;
const sets = (f: FakeDareu, cls: number, before: number) => f.sent.slice(before).filter((p) => p[2] === cls && (p[3] & GET) === 0);

// ---------------------------------------------------------------------------------------------

describe('key ids and assignments', () => {
  it('TG_KEY_MAP: key id <-> HID usage', () => {
    expect([usageOfKeyId(1), usageOfKeyId(41), usageOfKeyId(A), usageOfKeyId(97), usageOfKeyId(102)]).toEqual([0x29, 0x1a, 0x04, 0xe0, 0x2c]);
    expect(usageOfKeyId(170)).toBe(-1); // knob: no usage
    expect([keyIdOfUsage(0x04), keyIdOfUsage(0xe0), keyIdOfUsage(0), keyIdOfUsage(0xa5)]).toEqual([61, 97, 0, -1]);
  });

  it('assignment <-> QMK keycode', () => {
    const z = (fid: number, ...d: number[]) => ({ fid, data: [...d, 0, 0, 0, 0, 0].slice(0, 5) });
    expect(codeOfAssign(z(6, 0, 0x04))).toBe(0x04);
    expect(codeOfAssign(z(6, 2, 0))).toBe(0xe1); // Left Shift alone
    expect(codeOfAssign(z(6, 32, 0))).toBe(0xe5); // Right Shift alone
    expect(codeOfAssign(z(6, 1, 0x06))).toBe(0x0106); // Ctrl+C
    expect(codeOfAssign(z(6, 0x10, 0x06))).toBe(0x1106); // RCtrl+C
    expect(codeOfAssign(z(6, 0x11, 0x06))).toBeUndefined(); // both Ctrls
    expect(codeOfAssign(z(6, 0, 0x04, 0x05))).toBeUndefined(); // two keys
    expect(codeOfAssign(z(8, 0, 0xe9))).toBe(0xa9); // Vol+
    expect(codeOfAssign(z(8, 0x01, 0x92))).toBe(0xb2); // Calculator
    expect(codeOfAssign(z(1, 1))).toBe(0xd1);
    expect(codeOfAssign(z(4, 0xff))).toBe(0xda);
    expect(codeOfAssign(z(12, 1, 0, 1))).toBe(0x7700); // macro 1, play once -> M0
    expect(codeOfAssign(z(12, 1, 0, 5))).toBeUndefined(); // five times: no QMK code
    expect(codeOfAssign(z(10, 0x40))).toBeUndefined(); // Fn
    expect(codeOfAssign(z(0))).toBe(0);
    for (const kc of [0, 0x04, 0xe1, 0xe5, 0x0106, 0x1106, 0xa9, 0xb2, 0xa5, 0xd1, 0xd5, 0xd9, 0xda, 0xdb, 0xdc, 0x7700, 0x777f]) {
      expect(codeOfAssign(assignOfCode(kc)!), kc.toString(16)).toBe(kc);
    }
    expect(assignOfCode(0x5221)).toBeUndefined(); // MO(1): no layers on this firmware
  });
});

describe('key map (class 1 cmd 3)', () => {
  it('frames: [key, layer, function, d0..d4], 1-based profile in the header', () => {
    expect(head(getAssignPkt(1, A, 0), 14)).toEqual(hex('00 08 01 83 01 00 3d 00 00 00 00 00 00 00'));
    expect(head(setAssignPkt(1, A, 0, { fid: 6, data: [0, 5, 0, 0, 0] }), 14)).toEqual(hex('00 08 01 03 01 00 3d 00 06 00 05 00 00 00'));
    expect(allowed(setAssignPkt(1, A, 1, { fid: 8, data: [0, 0xe9, 0, 0, 0] }))).toBe(true);
    // never: factory/settings reset, pairing, RF test etc. as a key function; layer 2; key 0
    for (const fid of [44, 41, 42, 217, 59, 10]) expect(allowed(setAssignPkt(1, A, 0, { fid, data: [3, 0, 0, 0, 0] })), String(fid)).toBe(false);
    expect(allowed(frame(CLS.KEY, KEY.ASSIGN, 8, 1, [A, 2, 6, 0, 4]))).toBe(false);
    expect(allowed(frame(CLS.KEY, KEY.ASSIGN, 8, 1, [0, 0, 6, 0, 4]))).toBe(false);
    expect(allowed(frame(CLS.KEY, KEY.ASSIGN | GET, 8, 1, [A, 0, 6]))).toBe(false);
  });

  it('reads both layers; Fn and Fn-layer system keys are locked', async () => {
    const [, , ss] = await connect({}, (f) => f.assigns.set(`1:1:${TAB}`, [44, 3, 0, 0, 0, 0]));
    const km = find(ss, 'keymap');
    expect(km.group).toBe('Keys');
    const v = km.value as Keymap;
    expect(v.codes).toBe('qmk-v2');
    expect(v.layers).toHaveLength(2);
    expect(v.layers[0][pos(1)]).toBe(0x29);
    expect(v.layers[0][pos(78)]).toBe(0xe1);
    // Fn (VendorKey) and settings reset on Fn+Tab have no QMK code: kept as they are
    expect(v.layers[0][pos(FN)]).toBe(OPAQUE_BASE);
    expect(v.layers[1][pos(TAB)]).toBe(OPAQUE_BASE + 1);
    expect(v.locked![0]).toEqual([pos(FN)]);
    expect(v.locked![1]).toEqual([pos(TAB), pos(FN)].sort((a, b) => a - b));
  });

  it('remaps base and Fn layer keys and reads them back', async () => {
    const [f, d, ss] = await connect();
    const km = find(ss, 'keymap');
    const v = km.value as Keymap;
    const layers = v.layers.map((l) => l.slice());
    layers[0][pos(A)] = 0x05; // A -> B
    layers[0][pos(S)] = 0x0106; // S -> Ctrl+C
    layers[1][pos(Z)] = 0xa9; // Fn+Z -> Vol+
    layers[1][pos(D)] = 0x7700; // Fn+D -> macro M0 (id 1, play once)
    const before = f.sent.length;
    await d.write(withValue(km, { ...v, layers }));
    const w = sets(f, CLS.KEY, before);
    expect(w.map((p) => head(p, 14))).toEqual([
      hex('00 08 01 03 01 00 3d 00 06 00 05 00 00 00'),
      hex('00 08 01 03 01 00 3e 00 06 01 06 00 00 00'),
      hex('00 08 01 03 01 00 3f 01 0c 01 00 01 00 00'),
      hex('00 08 01 03 01 00 50 01 08 00 e9 00 00 00'),
    ]);
    expect(f.assign(A, 0)).toEqual([6, 0, 5, 0, 0, 0]);
    expect(((await d.read()).find((s) => s.key === 'keymap')!.value as Keymap).layers[1][pos(Z)]).toBe(0xa9);
  });

  it('refuses locked keys, codes the firmware has no function for, and reports ignored writes', async () => {
    const [, d, ss] = await connect();
    const km = find(ss, 'keymap');
    const v = km.value as Keymap;
    const l1 = v.layers.map((l) => l.slice());
    l1[0][pos(FN)] = 0x04;
    await expect(d.write(withValue(km, { ...v, layers: l1 }))).rejects.toThrow(/Fn can't be changed/);
    const l2 = v.layers.map((l) => l.slice());
    l2[0][pos(A)] = 0x5221; // MO(1)
    await expect(d.write(withValue(km, { ...v, layers: l2 }))).rejects.toThrow(/can't send keycode 0x5221/);
    const [, e, ss2] = await connect({ ignoreWrites: true });
    const k2 = find(ss2, 'keymap');
    const l3 = (k2.value as Keymap).layers.map((l) => l.slice());
    l3[0][pos(A)] = 0x05;
    await expect(e.write(withValue(k2, { ...(k2.value as Keymap), layers: l3 }))).rejects.toThrow(/didn't take the key change for: A reads back 6:\[0 4 0 0 0\]/);
  });

  it('an opaque function can be copied to another key only if it is a safe one', async () => {
    const [f, d, ss] = await connect({}, (x) => {
      x.assigns.set(`1:0:${A}`, [12, 2, 0, 5, 0, 0]); // macro 2, five times
      x.assigns.set(`1:1:${TAB}`, [44, 3, 0, 0, 0, 0]); // settings reset
    });
    const km = find(ss, 'keymap');
    const v = km.value as Keymap;
    const macro5 = v.layers[0][pos(A)];
    expect(macro5).toBeGreaterThanOrEqual(OPAQUE_BASE);
    const layers = v.layers.map((l) => l.slice());
    layers[0][pos(S)] = macro5;
    await d.write(withValue(km, { ...v, layers }));
    expect(f.assign(S, 0)).toEqual([12, 2, 0, 5, 0, 0]);
    const l2 = v.layers.map((l) => l.slice());
    l2[0][pos(D)] = v.layers[1][pos(TAB)];
    await expect(d.write(withValue(km, { ...v, layers: l2 }))).rejects.toThrow(/can't send/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('advanced keys: MT / TGL / DKS (class 13 cmd 4 / 5 / 6)', () => {
  it('frames (TravelVersion 2: delay big-endian; TravelVersion 0: little-endian)', () => {
    // MT: size byte 5 although 6 bytes follow (vendor SetMtParameters)
    expect(head(setMtPkt(2, A, 97, A, 200), 12)).toEqual(hex('00 05 0d 04 00 00 01 3d 61 3d 00 c8'));
    expect(head(setMtPkt(0, A, 97, A, 200), 12)).toEqual(hex('00 05 0d 04 00 00 01 3d 61 3d c8 00'));
    expect(head(setTglPkt(2, S, S, 300), 11)).toEqual(hex('00 05 0d 05 00 00 01 3e 3e 01 2c'));
    expect(head(setDksPkt(D, [D, A], [15, 16]), 16)).toEqual(hex('00 0a 0d 06 00 00 01 3f 3f 3d 00 00 0f 10 00 00'));
    expect(head(removeBindingPkt(A), 8)).toEqual(hex('00 02 0d 01 00 00 01 3d'));
    for (const p of [setMtPkt(2, A, 97, A, 200), setTglPkt(2, S, S, 300), setDksPkt(D, [D, A], [15, 16]), removeBindingPkt(A)]) expect(allowed(p)).toBe(true);
    expect(allowed(setDksPkt(D, [0, 0], [15, 16]))).toBe(false); // no key at all
    expect(allowed(frame(CLS.MAGNETIC, MAG.DKS, 10, 0, [1, D, D, 0, 0, 0, 0x80, 0, 0, 0]))).toBe(false); // 8th condition bit
  });

  it('reads, adds, changes and removes them', async () => {
    const [f, d, ss] = await connect({}, (x) => {
      x.keys.set(D, { func: 5, travel: 0, press: 0, release: 0 });
      x.adv.set(D, [D, A, 0, 0, 15, 16, 0, 0]); // vendor "A emergency" style preset
    });
    const s = find(ss, 'advanced_keys');
    expect(s.group).toBe('Keys');
    const v = s.value as AdvancedKeys;
    expect(v.modes).toEqual(['dks', 'mt', 'tgl']);
    expect(v.mt).toEqual({ min: 100, max: 1000, step: 10, default: 200 });
    expect(v.entries).toEqual([{ key: pos(D), mode: 'dks', actions: [{ kc: 0x07, mask: 15 }, { kc: 0x04, mask: 16 }] }]);
    expect(v.unavailable).not.toContain(pos(A));
    // add MT on A (tap A, hold Left Ctrl after 200 ms), TGL on S, and turn D's DKS into a toggle
    const before = f.sent.length;
    await d.write(
      withValue(s, {
        ...v,
        entries: [
          { key: pos(A), mode: 'mt', hold: 0xe0, tap: 0x04, delay: 200 },
          { key: pos(S), mode: 'tgl', kc: 0x16, delay: 300 },
          { key: pos(D), mode: 'tgl', kc: 0x07, delay: 200 },
        ],
      }),
    );
    const w = sets(f, CLS.MAGNETIC, before).map((p) => head(p, 12));
    expect(w).toEqual([
      hex('00 02 0d 01 00 00 01 3f 00 00 00 00'), // D: remove the DKS first (vendor: delete, then pick another)
      hex('00 05 0d 04 00 00 01 3d 61 3d 00 c8'),
      hex('00 05 0d 05 00 00 01 3e 3e 01 2c 00'),
      hex('00 05 0d 05 00 00 01 3f 3f 00 c8 00'),
    ]);
    expect(f.key(A).func).toBe(3);
    expect(f.key(D).func).toBe(4);
    const back = (await d.read()).find((x) => x.key === 'advanced_keys')!.value as AdvancedKeys;
    expect(back.entries.map((e) => [e.key, e.mode])).toEqual([[pos(A), 'mt'], [pos(S), 'tgl'], [pos(D), 'tgl']]);
    // Rapid Trigger for all keys leaves them alone
    const ss2 = await d.read();
    await d.write(withValue(find(ss2, 'rapid_trigger'), { kind: 'toggle', on: true }));
    expect(f.key(A).func).toBe(3);
    // remove all three
    await d.write(withValue(find(ss2, 'advanced_keys'), { ...back, entries: [] }));
    expect([f.key(A).func, f.key(S).func, f.key(D).func]).toEqual([0, 0, 0]);
  });

  it('refuses what the firmware can not hold and keys in SOCD / without a usage', async () => {
    const [f, d, ss] = await connect({}, (x) => {
      x.socd.set(A, 0);
      x.keys.set(S, { func: 3, travel: 0, press: 0, release: 0 });
      x.adv.set(S, [170, S, 0, 200]); // hold = knob key: no HID usage
    });
    const s = find(ss, 'advanced_keys');
    const v = s.value as AdvancedKeys;
    expect(v.unavailable).toContain(pos(A));
    expect(v.unavailable).toContain(pos(S));
    expect(v.entries).toEqual([]);
    await expect(d.write(withValue(s, { ...v, entries: [{ key: pos(A), mode: 'tgl', kc: 4, delay: 200 }] }))).rejects.toThrow(/A can't get/);
    await expect(d.write(withValue(s, { ...v, entries: [{ key: pos(D), mode: 'mt', hold: 0xe0, tap: 4, delay: 50 }] }))).rejects.toThrow(/100-1000 ms/);
    await expect(d.write(withValue(s, { ...v, entries: [{ key: pos(D), mode: 'mt', hold: 0xa5, tap: 4, delay: 200 }] }))).rejects.toThrow(/can't be used/);
    await expect(d.write(withValue(s, { ...v, entries: [{ key: pos(D), mode: 'dks', actions: [] }] }))).rejects.toThrow(/at least one key/);
    // writing the value back unchanged never touches S's unknown MT
    await d.write(s);
    expect(f.key(S).func).toBe(3);
  });

  it('TravelVersion 0 board: delay little-endian', async () => {
    const [f, d, ss] = await connect({ pid: 0x0105 });
    const s = find(ss, 'advanced_keys');
    await d.write(withValue(s, { ...(s.value as AdvancedKeys), entries: [{ key: capsFor(productFor(0x0105)!).findIndex((k) => k.index === A), mode: 'mt', hold: 0xe0, tap: 4, delay: 300 }] }));
    expect(f.wrote(CLS.MAGNETIC, MAG.MT).map((p) => head(p, 12))).toEqual([hex('00 05 0d 04 00 00 01 3d 61 3d 2c 01')]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('macros (class 6)', () => {
  it("'dareu' format: key make / break, delays, mouse, wheel", () => {
    expect(encodeMacro([{ t: 'down', kc: 4 }, { t: 'delay', ms: 50 }, { t: 'up', kc: 4 }], 'dareu')).toEqual(hex('04 04 0a 32 05 04'));
    expect(encodeMacro([{ t: 'tap', kc: 0xe1 }, { t: 'delay', ms: 300 }], 'dareu')).toEqual(hex('04 e1 05 e1 0b 01 2c'));
    expect(encodeMacro([{ t: 'mouse', a: 'tap', btn: 2 }, { t: 'wheel', dir: -1 }], 'dareu')).toEqual(hex('01 02 01 00 02 ff'));
    expect(() => encodeMacro([{ t: 'text', text: 'hi' }], 'dareu')).toThrow(/keyboard can't type text/);
    expect(decodeMacro(hex('04 04 0a 32 05 04 04 05 05 05 0c 01 00 00'), 'dareu')).toEqual([
      { t: 'down', kc: 4 }, { t: 'delay', ms: 50 }, { t: 'up', kc: 4 }, { t: 'tap', kc: 5 }, { t: 'delay', ms: 65535 },
    ]);
    // unknown records (media 08) end the macro like 00 / FE
    expect(decodeMacro(hex('04 04 05 04 08 00 e9 04 05'), 'dareu')).toEqual([{ t: 'tap', kc: 4 }]);
  });

  it('frames: create, name "Macro <id>", memory in 48-byte chunks, delete with size byte 0', () => {
    expect(head(macroCreatePkt(1, 6), 9)).toEqual(hex('00 03 06 02 00 00 01 00 06'));
    expect(macroNamePkts(1).map((p) => head(p, 16))).toEqual([hex('00 0a 06 04 00 00 01 07 00 4d 61 63 72 6f 20 31')]);
    expect(macroDataPkts(1, hex('04 04 0a 32 05 04')).map((p) => head(p, 17))).toEqual([hex('00 0b 06 05 00 00 01 00 06 00 00 04 04 0a 32 05 04')]);
    const long = macroDataPkts(2, new Array(60).fill(4));
    expect(long.map((p) => head(p, 11))).toEqual([hex('00 35 06 05 00 00 02 00 3c 00 00'), hex('00 11 06 05 00 00 02 00 3c 00 30')]);
    expect(head(macroDeletePkt(3), 8)).toEqual(hex('00 00 06 03 00 00 03 00'));
    for (const p of [macroCreatePkt(1, 6), ...macroNamePkts(1), ...long, macroDeletePkt(3)]) expect(allowed(p)).toBe(true);
    expect(allowed(macroDeletePkt(0))).toBe(false);
    expect(allowed(frame(CLS.MACRO, MCO.CREATE, 3, 1, [1, 0, 6]))).toBe(false); // profile byte
    expect(allowed(frame(CLS.MACRO, 0 | GET, 0, 0))).toBe(false); // storage info: never used by the vendor
  });

  it('reads, writes, rewrites and deletes macros', async () => {
    const [f, d, ss] = await connect({}, (x) => x.macros.set(2, hex('04 05 05 05')));
    const s = find(ss, 'macros');
    expect(s.group).toBe('Macros');
    const v = s.value as Macros;
    expect(v).toMatchObject({ slots: 16, format: 'dareu', delays: true, maxDelay: 65535, text: false, mouse: true });
    expect(v.macros[1]).toEqual([{ t: 'tap', kc: 5 }]);
    const macros = v.macros.map((m) => m.slice());
    macros[0] = [{ t: 'down', kc: 4 }, { t: 'delay', ms: 50 }, { t: 'up', kc: 4 }];
    macros[1] = [];
    const before = f.sent.length;
    await d.write(withValue(s, { ...v, macros }));
    const w = sets(f, CLS.MACRO, before).map((p) => head(p, 17));
    expect(w).toEqual([
      hex('00 03 06 02 00 00 01 00 06 00 00 00 00 00 00 00 00'),
      hex('00 0a 06 04 00 00 01 07 00 4d 61 63 72 6f 20 31 00'),
      hex('00 0b 06 05 00 00 01 00 06 00 00 04 04 0a 32 05 04'),
      hex('00 00 06 03 00 00 02 00 00 00 00 00 00 00 00 00 00'),
    ]);
    expect(f.macros.get(1)).toEqual(hex('04 04 0a 32 05 04'));
    expect(f.macros.has(2)).toBe(false);
    expect(f.macroNames.get(1)).toBe('Macro 1');
    // unchanged write sends nothing
    const again = (await d.read()).find((x) => x.key === 'macros')!;
    const n = f.sent.length;
    await d.write(again);
    expect(sets(f, CLS.MACRO, n)).toHaveLength(0);
    const [, e, ss2] = await connect({ ignoreWrites: true });
    const m2 = find(ss2, 'macros');
    const mm = (m2.value as Macros).macros.map((m) => m.slice());
    mm[3] = [{ t: 'tap', kc: 4 }];
    await expect(e.write(withValue(m2, { ...(m2.value as Macros), macros: mm }))).rejects.toThrow(/didn't take the macro change for: M3/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('profiles (class 5)', () => {
  it('switches profiles; ids are 1-based and go in the header', async () => {
    expect(head(setProfilePkt(2), 8)).toEqual(hex('00 00 05 03 02 00 00 00'));
    expect(allowed(setProfilePkt(2))).toBe(true);
    expect(allowed(frame(CLS.PROFILE, PFL.ID_LIST | GET, 1, 0))).toBe(true);
    for (const cmd of [1, 2, 4, 5]) expect(allowed(frame(CLS.PROFILE, cmd, 0, 2)), `cmd ${cmd}`).toBe(false); // create / delete / name / reset
    const [f, d, ss] = await connect();
    const p = find(ss, 'profile');
    expect(p.group).toBe('Settings');
    expect(p.value).toEqual({ kind: 'choice', options: [['Profile 1', 1], ['Profile 2', 2], ['Profile 3', 3]], current: 1 });
    await d.write(withValue(p, { ...(p.value as Extract<Value, { kind: 'choice' }>), current: 2 }));
    expect(f.profile).toBe(2);
    // per-profile settings now come from profile 2
    const ss2 = await d.read();
    expect((find(ss2, 'profile').value as { current: number }).current).toBe(2);
    expect(f.sent.slice(-200).filter((x) => x[2] === CLS.KEY).every((x) => x[4] === 2)).toBe(true);
    await expect(d.write(withValue(p, { ...(p.value as Extract<Value, { kind: 'choice' }>), current: 7 }))).rejects.toThrow(/doesn't exist/);
  });
});

describe('lighting extras', () => {
  it('reverse direction (flag 0x02, Wave only) and percent brightness', async () => {
    const [f, d, ss] = await connect({}, (x) => x.effects.push(5));
    const r = find(ss, 'light_reverse');
    expect(r.value).toEqual({ kind: 'toggle', on: false });
    await d.write(withValue(r, { kind: 'toggle', on: true }));
    expect(f.effect.flag).toBe(2);
    const [, , plain] = await connect();
    expect(plain.find((x) => x.key === 'light_reverse')).toBeUndefined(); // A68 list has no Wave
  });
});
