import { describe, expect, it } from 'vitest';
import {
  allowedCommand,
  allowedReport,
  codeToMm,
  encodePerKey,
  encodeRt,
  frameReport,
  kbBase,
  mid,
  mmToCode,
  modelOf,
  parseKb,
  parsePerKey,
  parseRt,
  pbDecode,
  pbEncode,
  planPerKey,
  REPORT,
  rtOf,
  setField,
  SIXTY_ANSI,
  wootingFactory,
  WootingDriver,
} from './wooting';
import { FakeWooting, KB_DEFAULT, PK_A, RT_WASD, type FakeWootingOptions } from './fakes/fake-wooting';
import type { Setting, Value } from './types';

const h = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
async function open(o?: FakeWootingOptions) {
  const fake = new FakeWooting(o);
  await fake.open();
  const drv = new WootingDriver(fake.asHid(), { timeoutMs: 50 });
  return { fake, drv };
}
const find = (l: Setting[], k: string) => l.find((s) => s.key === k)!;
const with_ = (s: Setting, value: Value): Setting => ({ ...s, value });
type PKT = Extract<Value, { kind: 'perKeyTrigger' }>;
const pos = (label: string) => SIXTY_ANSI.findIndex((k) => k.label === label);

describe('wooting values (eng1n88r captures)', () => {
  it('encodes distances like Wootility', () => {
    expect(mmToCode(1.0)).toBe(0x5000);
    expect(mmToCode(1.6)).toBe(0x5999);
    expect(mmToCode(4.0)).toBe(0x7fff);
    expect(mmToCode(2.5)).toBe(0x67ff);
    expect(codeToMm(0x4f8f)).toBe(0.97);
    expect(codeToMm(127)).toBe(4); // old 8-bit percent form
    expect(codeToMm(0x8000)).toBeUndefined();
  });

  it('round-trips protobuf and patches fields in place', () => {
    const base = kbBase(KB_DEFAULT);
    expect(pbEncode(pbDecode(KB_DEFAULT))).toEqual(KB_DEFAULT);
    const kb = parseKb(base);
    expect(kb).toMatchObject({ act: 0x5999, rt: false, sens: 0x4666, tachyon: false, strict: true, release: undefined });
    // split sensitivity 0.55 adds field 8 between 7 and 9 (capture: ... 38 01 40 cd 91 01 48 00)
    const b2 = setField(setField(base, 3, 1), 8, mmToCode(0.55));
    expect([...pbEncode(b2)].slice(-8)).toEqual([0x38, 0x01, 0x40, 0xcd, 0x91, 0x01, 0x48, 0x00]);
  });

  it('reads per-key actuation and RT lists', () => {
    expect([...parsePerKey(PK_A).map]).toEqual([[0x61, 0x67ff]]);
    expect(encodePerKey(new Map([[0x61, 0x67ff]]))).toEqual(PK_A);
    const g = parseRt(RT_WASD);
    expect(g).toEqual([{ keys: [0x42, 0x61, 0x62, 0x63], enabled: true }]);
    expect(encodeRt(g)).toEqual(RT_WASD);
  });

  it('knows the PIDs and their gamepad alternates', () => {
    expect(modelOf(0x1340)?.name).toBe('60HE v2');
    expect(modelOf(0x1342)?.name).toBe('60HE v2');
    expect(modelOf(0x1322)?.name).toBe('60HE+');
    expect(modelOf(0x1343)).toBeUndefined();
    expect(modelOf(0x1300)).toBeUndefined(); // original 60HE (0x1337 firmware) not supported
  });
});

describe('wooting allowlist', () => {
  it('accepts the reads and writes the driver uses', () => {
    expect(allowedCommand([0xd1, 0xda, 1, 0, 0, 0, 0])).toBe(true);
    expect(allowedCommand([0xd1, 0xda, 39, 3, 0, 0, 0])).toBe(true);
    expect(allowedCommand([0xd1, 0xda, 23, 2, 0, 0, 0])).toBe(true);
    const [id, d] = frameReport(REPORT.keyboardProfile, 7, KB_DEFAULT);
    expect(id).toBe(1);
    expect([...d.subarray(0, 6)]).toEqual([0xd1, 0xda, 0x11, 0x07, KB_DEFAULT.length, 0]);
    expect(allowedReport(id, d)).toBe(true);
    expect(allowedReport(...frameReport(REPORT.perKey, 0, PK_A))).toBe(true);
    expect(allowedReport(...frameReport(REPORT.rtKeys, 1, RT_WASD))).toBe(true);
  });

  it('refuses bootloader, resets, deletes, device config and other reports', () => {
    for (const cmd of [2, 25, 43, 44, 63, 64, 42, 47, 53, 21, 0])
      expect(allowedCommand([0xd1, 0xda, cmd, 0, 0, 0, 0])).toBe(false);
    expect(allowedCommand([0xd1, 0xda, 39, 4, 0, 0, 0])).toBe(false); // slot 5
    expect(allowedCommand([0xd1, 0xda, 1, 0, 0, 1, 0])).toBe(false);
    expect(allowedCommand([0xd0, 0xda, 1, 0, 0, 0, 0])).toBe(false);
    // DeviceConfig (restarts the board), mapping, gamepad, global settings, metadata
    for (const type of [0x07, 0x12, 0x13, 0x14, 0x17, 0x18, 0x1a, 0x1b, 0x28, 0x0b, 0x0e])
      expect(allowedReport(...frameReport(type, 0, KB_DEFAULT))).toBe(false);
    // actuation out of range / not 14-bit
    const bad = pbEncode([{ no: 1, wt: 2, v: 0, b: pbEncode(setField(kbBase(KB_DEFAULT), 1, 0x4000)) }]);
    expect(allowedReport(...frameReport(REPORT.keyboardProfile, 0, bad))).toBe(false);
    // rgb core only to RAM
    expect(allowedReport(...frameReport(REPORT.rgbCore, 1, h('0a 03 08 80 01')))).toBe(false);
    expect(allowedReport(...frameReport(REPORT.rgbCore, 0, h('0a 03 08 80 01')))).toBe(true);
    // padding must be zero, report must be the smallest that fits
    const [id, d] = frameReport(REPORT.perKey, 0, PK_A);
    d[30] = 1;
    expect(allowedReport(id, d)).toBe(false);
    const [, d2] = frameReport(REPORT.perKey, 0, PK_A);
    expect(allowedReport(2, Uint8Array.from([...d2, ...new Uint8Array(30)]))).toBe(false);
  });
});

describe('wooting per-key planning', () => {
  const kb = parseKb(kbBase(KB_DEFAULT));
  const caps = SIXTY_ANSI;
  const travel0 = caps.map(() => kb.act);
  it('keeps the common value global and lists exceptions', () => {
    const t = travel0.slice();
    t[pos('A')] = mmToCode(2.5);
    const p = planPerKey(kb, new Map(), [], caps, t, caps.map(() => false), caps.map(() => kb.sens));
    expect([...p.perKey!]).toEqual([[0x61, 0x67ff]]);
    expect(p.kb).toBeUndefined();
    expect(p.groups).toBeUndefined();
  });

  it('moves the global point when all keys change; space covers three cells', () => {
    const p = planPerKey(kb, new Map(), [], caps, caps.map(() => mmToCode(1.0)), caps.map(() => false), caps.map(() => kb.sens));
    expect(p.kb?.act).toBe(0x5000);
    expect(p.perKey!.size).toBe(0);
    const t = caps.map(() => kb.act);
    t[pos('Space')] = mmToCode(3);
    const p2 = planPerKey(kb, new Map(), [], caps, t, caps.map(() => false), caps.map(() => kb.sens));
    expect([...p2.perKey!.keys()].sort()).toEqual([mid(5, 4), mid(5, 6), mid(5, 8)]);
  });

  it('builds Rapid Trigger groups like Wootility', () => {
    const rapid = caps.map((k) => ['W', 'A', 'S', 'D'].includes(k.label));
    const p = planPerKey(kb, new Map(), [], caps, travel0, rapid, caps.map(() => kb.sens));
    expect(p.kb?.rt ?? kb.rt).toBe(false);
    expect(p.groups).toEqual([{ keys: [0x42, 0x61, 0x62, 0x63], enabled: true }]);
    // all keys on, one with its own sensitivity
    const sens = caps.map(() => kb.sens);
    sens[pos('Q')] = mmToCode(0.15);
    const p2 = planPerKey(kb, new Map(), [], caps, travel0, caps.map(() => true), sens);
    expect(p2.kb?.rt).toBe(true);
    expect(p2.groups).toEqual([{ keys: [mid(2, 1)], config: { primary: mmToCode(0.15), continuous: false } }]);
    for (const [i, k] of caps.entries()) expect(rtOf(k.index, p2.kb!, p2.groups!)).toBe(sens[i]);
  });
});

describe('wooting driver', () => {
  it('matches only the ARM config interface of known boards', () => {
    const f = new FakeWooting();
    expect(wootingFactory.match(f.asHid())).toBe(true);
    expect(wootingFactory.match({ ...f, collections: [{ usagePage: 0x1337 }] } as unknown as HIDDevice)).toBe(false);
    expect(wootingFactory.match({ ...f, productId: 0x1300 } as unknown as HIDDevice)).toBe(false);
    expect(wootingFactory.filters).toEqual([{ vendorId: 0x31e3, usagePage: 0xff55 }]);
  });

  it('reads model, firmware, profiles, triggers and brightness', async () => {
    const { drv } = await open();
    expect(drv.verified).toBe(false);
    const ss = await drv.read();
    expect(find(ss, 'fw').value).toEqual({ kind: 'text', text: '2.14.2' });
    expect(find(ss, 'profile').value).toMatchObject({ current: 0, options: [['Typing Profile', 0], ['Rapid Profile', 1], ['Racing Profile', 2], ['Mixed Movement', 3]] });
    const pk = find(ss, 'per_key_trigger').value as PKT;
    expect(pk.travel[pos('A')]).toBe(2.5);
    expect(pk.travel[pos('B')]).toBe(1.6);
    expect(pk.keys.filter((_, i) => pk.rapid[i]).map((k) => k.label)).toEqual(['W', 'A', 'S', 'D']);
    expect(pk.sens[pos('W')]).toBe(0.4);
    expect(find(ss, 'light_bri').value).toMatchObject({ current: 100 });
    expect(find(ss, 'usb_speed').value).toEqual({ kind: 'text', text: '8000 Hz' });
    expect(ss.some((s) => s.key === 'unsupported')).toBe(false);
  });

  it('writes per-key actuation and RT to RAM and the active slot, then reads back', async () => {
    const { drv, fake } = await open();
    const ss = await drv.read();
    const pk = find(ss, 'per_key_trigger');
    const v = pk.value as PKT;
    const travel = v.travel.slice();
    travel[pos('S')] = 1.2;
    const rapid = v.rapid.slice();
    rapid[pos('Q')] = true;
    fake.sent = [];
    await drv.write(with_(pk, { ...v, travel, rapid }));
    expect(parsePerKey(fake.slots[0].pk).map.get(mid(3, 2))).toBe(mmToCode(1.2));
    expect(parsePerKey(fake.ram.pk).map.get(mid(3, 2))).toBe(mmToCode(1.2));
    expect(parseRt(fake.slots[0].rt).flatMap((g) => g.keys)).toContain(mid(2, 1));
    const again = find(await drv.read(), 'per_key_trigger').value as PKT;
    expect(again.travel[pos('S')]).toBe(1.2);
    expect(again.rapid[pos('Q')]).toBe(true);
    // never anything else than the allowlisted reports
    expect(fake.sent.filter((d) => d.length > 7).map((d) => d[2])).toEqual([0x15, 0x15, 0x1d, 0x11, 0x1d, 0x11]);
  });

  it('writes Tachyon, continuous RT and split release', async () => {
    const { drv, fake } = await open();
    const ss = await drv.read();
    await drv.write(with_(find(ss, 'tachyon'), { kind: 'toggle', on: true }));
    await drv.write(with_(find(ss, 'rt_continuous'), { kind: 'toggle', on: true }));
    await drv.write(with_(find(ss, 'rt_split'), { kind: 'toggle', on: true }));
    const r = find(await drv.read(), 'rt_release');
    await drv.write(with_(r, { ...(r.value as Extract<Value, { kind: 'float' }>), current: 0.55 }));
    const kb = parseKb(kbBase(fake.slots[0].kb));
    expect(kb).toMatchObject({ tachyon: true, tmode: 1, strict: false, release: mmToCode(0.55) });
    // per-key RT list resent unchanged before every KeyboardProfile
    expect(parseRt(fake.slots[0].rt)).toEqual(parseRt(RT_WASD));
  });

  it('writes brightness through SaveRgbProfile and keeps the effect', async () => {
    const { drv, fake } = await open();
    const ss = await drv.read();
    await drv.write(with_(find(ss, 'light_bri'), { kind: 'number', min: 0, max: 100, current: 50, unit: '%' }));
    expect(find(await drv.read(), 'light_bri').value).toMatchObject({ current: 50 });
    expect(pbDecode(fake.slots[0].core).some((f) => f.no === 4)).toBe(true);
  });

  it('switches profiles', async () => {
    const { drv, fake } = await open();
    const ss = await drv.read();
    await drv.write(with_(find(ss, 'profile'), { ...(find(ss, 'profile').value as Extract<Value, { kind: 'choice' }>), current: 2 }));
    expect(fake.slot).toBe(2);
    expect(find(await drv.read(), 'profile').value).toMatchObject({ current: 2 });
  });

  it('fails when the keyboard does not keep a write', async () => {
    const { drv } = await open({ ignoreWrites: true });
    const ss = await drv.read();
    await expect(drv.write(with_(find(ss, 'tachyon'), { kind: 'toggle', on: true }))).rejects.toThrow(/didn't keep/);
  });

  it('is read-only on firmware before 2.13', async () => {
    const { drv, fake } = await open({ fw: [2, 12, 0] });
    const ss = await drv.read();
    expect(ss.some((s) => s.key === 'unsupported')).toBe(true);
    fake.sent = [];
    await expect(drv.write(with_(find(ss, 'tachyon'), { kind: 'toggle', on: true }))).rejects.toThrow(/firmware/);
    expect(fake.sent.length).toBe(0);
  });

  it('shows global settings on boards without a picture (80HE)', async () => {
    const { drv } = await open({ productId: 0x1400 });
    const ss = await drv.read();
    expect(drv.layout).toBeUndefined();
    expect(ss.some((s) => s.key === 'per_key_trigger')).toBe(false);
    const act = find(ss, 'actuation');
    await drv.write(with_(act, { ...(act.value as Extract<Value, { kind: 'float' }>), current: 2.0 }));
    expect(find(await drv.read(), 'actuation').value).toMatchObject({ current: 2 });
  });

  it('diagnose only reads', async () => {
    const { drv, fake } = await open();
    const rep = await drv.diagnose();
    expect(rep).toContain('## keyboard profile');
    expect(rep).toContain('(1.6 mm)');
    expect(fake.sent.every((d) => d.length === 7 && [1, 11, 19, 62, 55, 39, 49, 61, 54, 50, 51].includes(d[2]))).toBe(true);
  });
});
