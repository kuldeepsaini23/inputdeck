import { describe, expect, it } from 'vitest';
import { allowed, checksum, CMD, entryAllowed, frame, UNBOUND, VgnDriver, vgnFactory } from './vgn';
import { FakeVgn, type FakeVgnOptions } from './fakes/fake-vgn';
import type { Setting, Value } from './types';

async function open(o?: FakeVgnOptions) {
  const fake = new FakeVgn(o);
  await fake.open();
  const drv = new VgnDriver(fake.asHid(), { timeoutMs: 30 });
  return { fake, drv };
}
const find = (l: Setting[], k: string) => l.find((s) => s.key === k)!;
const with_ = (s: Setting, value: Value): Setting => ({ ...s, value });

describe('vgn framing', () => {
  it('builds the hub frame: 55 cmd 00 sum len offLo offHi 00 data', () => {
    // hub getJoystick second chunk: sendCmdWithWait(16, 56, new Uint8Array(8))
    const p = frame(0x10, 56, new Uint8Array(8));
    expect([...p.subarray(0, 8)]).toEqual([0x55, 0x10, 0x00, (8 + 56) & 0xff, 8, 56, 0, 0]);
    expect(p.length).toBe(64);
  });

  it('checksums bytes 4..63 only', () => {
    const p = frame(0x11, 0, [0xaa, 0xbb, 1, 0, 0x1f, 0, 0, 0, 90]);
    let s = 0;
    for (let i = 4; i < 64; i++) s += p[i];
    expect(p[3]).toBe(s & 0xff);
    expect(p[3]).toBe((9 + 0xaa + 0xbb + 1 + 0x1f + 90) & 0xff);
    expect(checksum(p)).toBe(p[3]);
  });

  it('puts the offset little-endian at 5..6', () => {
    const p = frame(0x08, 3 * 2048 + 504, new Uint8Array(8));
    expect(p[5] | (p[6] << 8)).toBe(6648);
  });
});

describe('vgn allowlist', () => {
  it('accepts the reads and writes the driver uses', () => {
    expect(allowed(frame(CMD.getInfo, 0, new Uint8Array(32)))).toBe(true);
    expect(allowed(frame(CMD.getBase, 0, new Uint8Array(32)))).toBe(true);
    expect(allowed(frame(CMD.getGamepad, 0, new Uint8Array(56)))).toBe(true);
    expect(allowed(frame(CMD.getKeys, 2048 + 504, new Uint8Array(8)))).toBe(true);
    expect(allowed(frame(CMD.setKeys, 336, new Uint8Array(48)))).toBe(true);
    const gp = new Uint8Array(56);
    gp.set([0xaa, 0xbb, 1, 0, 0x1f, 0, 0, 0, 90]);
    expect(allowed(frame(CMD.setGamepad, 0, gp))).toBe(true);
  });

  it('refuses factory reset, calibration, profile switch, func writes and bad gamepad blocks', () => {
    expect(allowed(frame(0xee, 0, [0xff]))).toBe(false);
    expect(allowed(frame(0xa8))).toBe(false);
    expect(allowed(frame(0xa9))).toBe(false);
    expect(allowed(frame(0x0e, 0, [1]))).toBe(false);
    expect(allowed(frame(0x06, 0, new Uint8Array(56)))).toBe(false);
    const gp = new Uint8Array(56);
    gp.set([0xaa, 0xbb, 2]); // unknown mode
    expect(allowed(frame(CMD.setGamepad, 0, gp))).toBe(false);
    gp.set([0xaa, 0xbb, 1, 0, 0x20]); // unknown flag bit
    expect(allowed(frame(CMD.setGamepad, 0, gp))).toBe(false);
    gp.set([0xaa, 0xbb, 1, 0, 0, 0, 0, 0, 91]); // angle > 90
    expect(allowed(frame(CMD.setGamepad, 0, gp))).toBe(false);
    expect(allowed(frame(CMD.setKeys, 384, new Uint8Array(56)))).toBe(false); // past the 128 keys
    expect(allowed(frame(CMD.setKeys, 10, new Uint8Array(56)))).toBe(false); // off-chunk
    expect(allowed(frame(CMD.getGamepad, 0, [1]))).toBe(false); // non-zero read payload
    const p = frame(CMD.getGamepad, 0, new Uint8Array(56));
    p[3] ^= 1;
    expect(allowed(p)).toBe(false); // bad checksum
  });

  it('only lets a key take its factory value or a gamepad entry', () => {
    expect(entryAllowed(64, [16, 0, 4])).toBe(true); // A
    expect(entryAllowed(64, [0xf1, 21, 0x0a])).toBe(true);
    expect(entryAllowed(64, [16, 0, 5])).toBe(false);
    expect(entryAllowed(64, [0xf1, 15, 0x0a])).toBe(false); // id not in the hub list
    expect(entryAllowed(43, [0xf1, 21, 0x0a])).toBe(false); // Fn key
  });
});

describe('vgn factory', () => {
  it('matches the three product ids on usage page 1 / usage 0', () => {
    for (const pid of [0x2007, 0x2009, 0x2011]) expect(vgnFactory.match(new FakeVgn({ productId: pid }).asHid())).toBe(true);
    const f = new FakeVgn();
    f.productId = 0x2008;
    expect(vgnFactory.match(f.asHid())).toBe(false);
  });
});

describe('vgn driver', () => {
  it('reads identity and the gamepad block', async () => {
    const { drv } = await open({ productId: 0x2009 });
    expect(drv.verified).toBe(false);
    expect(drv.model()).toBe('FLASH68+');
    const s = await drv.read();
    expect(find(s, 'firmware').value).toEqual({ kind: 'text', text: '105' });
    expect(find(s, 'gp.mode').value).toMatchObject({ kind: 'choice', current: 0 });
    expect(find(s, 'gp.mode').group).toBe('Gamepad');
    expect(find(s, 'gp.keyboard').value).toEqual({ kind: 'toggle', on: true });
    expect(find(s, 'gp.override').value).toEqual({ kind: 'toggle', on: false });
    expect(find(s, 'gp.angle').value).toMatchObject({ current: 45, max: 90 });
    expect(find(s, 'gp.bind.21').value).toMatchObject({ current: UNBOUND });
  });

  it('round-trips flags and angle, keeping unknown bytes', async () => {
    const { fake, drv } = await open();
    const s = await drv.read();
    await drv.write(with_(find(s, 'gp.square'), { kind: 'toggle', on: true }));
    await drv.write(with_(find(s, 'gp.angle'), { kind: 'number', min: 0, max: 90, current: 30, unit: '°' }));
    expect(fake.gamepad[4]).toBe(0x09);
    expect(fake.gamepad[8]).toBe(30);
    expect(fake.gamepad[20]).toBe(0x5a);
    expect([fake.gamepad[0], fake.gamepad[1]]).toEqual([0xaa, 0xbb]);
    const again = await drv.read();
    expect(find(again, 'gp.square').value).toEqual({ kind: 'toggle', on: true });
  });

  it('mode change writes the block and then waits for a reconnect', async () => {
    const { fake, drv } = await open({ restartOnMode: true });
    const s = await drv.read();
    const m = find(s, 'gp.mode');
    await drv.write(with_(m, { ...(m.value as Extract<Value, { kind: 'choice' }>), current: 1 }));
    expect(fake.gamepad[2]).toBe(1);
    await expect(drv.read()).rejects.toThrow(/reconnect|restarting/);
  });

  it('maps a key to a gamepad button on the active profile and moves it', async () => {
    const { fake, drv } = await open({ profile: 2 });
    const s = await drv.read();
    const a = find(s, 'gp.bind.21');
    const cv = a.value as Extract<Value, { kind: 'choice' }>;
    await drv.write(with_(a, { ...cv, current: 64 })); // A key -> button 1
    const base = 2 * 2048;
    expect([...fake.matrix.subarray(base + 192, base + 195)]).toEqual([0xf1, 21, 0x0a]);
    expect([...fake.matrix.subarray(192, 195)]).toEqual([16, 0, 4]); // profile 0 untouched
    await drv.write(with_(a, { ...cv, current: 65 })); // move to S
    expect([...fake.matrix.subarray(base + 192, base + 195)]).toEqual([16, 0, 4]);
    expect([...fake.matrix.subarray(base + 195, base + 198)]).toEqual([0xf1, 21, 0x0a]);
    const again = await drv.read();
    expect(find(again, 'gp.bind.21').value).toMatchObject({ current: 65 });
    await drv.write(with_(a, { ...cv, current: UNBOUND }));
    expect([...fake.matrix.subarray(base + 195, base + 198)]).toEqual([16, 0, 22]);
  });

  it('refuses the Fn key and unknown targets', async () => {
    const { drv } = await open();
    const s = await drv.read();
    const a = find(s, 'gp.bind.21');
    await expect(drv.write(with_(a, { ...(a.value as Extract<Value, { kind: 'choice' }>), current: 43 }))).rejects.toThrow();
    await expect(drv.write({ ...a, key: 'gp.bind.15' })).rejects.toThrow(/unknown/);
  });
});
