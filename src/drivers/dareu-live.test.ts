// Live per-key lighting on DAREU TG boards (effect 18 + FRAME rows), against the firmware-like fake.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeDareu, type FakeDareuOpts } from './fakes/fake-dareu';
import type { Driver, LiveLight, Setting } from './types';
import {
  CLS,
  LED,
  LIVE_CELLS,
  allowed,
  allowedStream,
  dareuFactory,
  dareuTiming,
  frame,
  liveEffectPkt,
  liveFramePkts,
  liveRowPkt,
  setEffectPkt,
} from './dareu';

const hex = (s: string) => s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
const bytes = (f: Uint8Array, n = 64) => Array.from(f.slice(0, n));
const realTiming = { ...dareuTiming };
afterAll(() => {
  Object.assign(dareuTiming, realTiming);
});
beforeAll(() => {
  Object.assign(dareuTiming, { poll: 0, tries: 5, pollSettle: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const ROWS = 5;
const COLS = 15;
const N = ROWS * COLS;
/** distinct bytes per cell: AA = i, BB = i + 100, CC = i + 150 */
const distinct = Array.from({ length: N }, (_, i) => (i << 16) | ((i + 100) << 8) | (i + 150));
const fill = (v: number) => new Array<number>(N).fill(v);

async function connect(o: FakeDareuOpts = { stream: true }, setup?: (f: FakeDareu) => void): Promise<[FakeDareu, Driver, LiveLight, Setting[]]> {
  const f = new FakeDareu(o);
  setup?.(f);
  const d = (await dareuFactory.create(f.asDevice()))!;
  const ss = await d.read();
  return [f, d, d.liveLight!, ss];
}
/** frames sent since `from` (all of them, or one class/command) */
const since = (f: FakeDareu, from: number, cmd?: number) =>
  f.sent.slice(from).filter((x) => cmd === undefined || (x[2] === CLS.LIGHTING && x[3] === cmd));
/** expected row request (first 56 bytes; the rest is zero): region 0, row mode, columns 0..14 */
const rowBytes = (row: number, cells: number[]) => [
  0x00, 0x32, 0x03, 0x04, 0x00, 0x00, 0x00, 0x01, row, 0x00, 0x0e,
  ...cells.slice(row * COLS, row * COLS + COLS).flatMap((c) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]),
];

describe('live lighting: availability', () => {
  it('only when the attribute reply lists effect 18; grid from that reply', async () => {
    const [, d0] = await connect({});
    expect(d0.liveLight).toBeUndefined();
    const [, d, live] = await connect();
    expect(d.liveLight).toBe(live);
    expect(live).toMatchObject({ rows: 5, cols: 15, experimental: true, active: false });
    expect(live.map).toBeUndefined();
    const [, , other] = await connect({ stream: true }, (x) => {
      x.rows = 6;
      x.cols = 21;
      x.matrix = new Array<number>(6 * 21 * 3).fill(0);
    });
    expect(other).toMatchObject({ rows: 6, cols: 21 });
  });

  it('no lighting class: no live lighting', async () => {
    const [, d] = await connect({ stream: true, noLighting: true });
    expect(d.liveLight).toBeUndefined();
  });
});

describe('live lighting: exact bytes', () => {
  it('start: remembers the live effect + brightness, switches to 18 live-only, sends a black frame', async () => {
    const [f, , live] = await connect();
    const from = f.sent.length;
    await live.start();
    expect(live.active).toBe(true);
    const sent = since(f, from).map((x) => bytes(x, 16));
    expect(sent.slice(0, 4)).toEqual([
      hex('00 01 03 82 00 00 00 00 00 00 00 00 00 00 00 00'), // GET effect, profile 0 = live state
      hex('00 02 03 83 01 00 00 00 00 00 00 00 00 00 00 00'), // GET brightness (active profile)
      hex('00 05 03 02 00 00 00 12 00 00 00 00 00 00 00 00'), // SET effect 18, profile 0 (not stored)
      hex('00 01 03 82 00 00 00 00 00 00 00 00 00 00 00 00'), // read back
    ]);
    const rows = since(f, from, 4);
    expect(rows).toHaveLength(5);
    rows.forEach((x, r) => expect(bytes(x, 56)).toEqual(rowBytes(r, fill(0))));
    expect(rows.every((x) => x.length === 64 && x.slice(56).every((b) => b === 0))).toBe(true);
    expect(f.sent.length - from).toBe(4 + 5);
    // the stored effect is untouched; live is 18 on a black matrix
    expect(f.effect.effect).toBe(1);
    expect(f.live?.effect).toBe(18);
    expect(f.cells()).toEqual(fill(0));
  });

  it('frame: one request per row, cells sent as AA BB CC in order', async () => {
    vi.useFakeTimers();
    const [f, , live] = await connect();
    await live.start();
    const from = f.sent.length;
    const p = live.frame(distinct);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    const rows = since(f, from);
    expect(rows).toHaveLength(5);
    rows.forEach((x, r) => expect(bytes(x, 56)).toEqual(rowBytes(r, distinct)));
    // row 1 spelled out: cell 15 = 0f 73 a5, cell 29 = 1d 81 b3
    expect(bytes(rows[1], 17)).toEqual(hex('00 32 03 04 00 00 00 01 01 00 0e 0f 73 a5 10 74 a6'));
    expect(bytes(rows[1], 56).slice(-3)).toEqual(hex('1d 81 b3'));
    expect(rows.every((x) => x.slice(56).every((b) => b === 0))).toBe(true);
    expect(f.cells()).toEqual(distinct);
  });

  it('stop: puts the remembered effect back live-only, reads it back; brightness only if it changed', async () => {
    const [f, , live] = await connect();
    await live.start();
    const from = f.sent.length;
    await live.stop();
    expect(live.active).toBe(false);
    expect(since(f, from).map((x) => bytes(x, 14))).toEqual([
      hex('00 08 03 02 00 00 00 01 00 00 01 ff 00 40'), // SET effect 1 (static ff 00 40), profile 0
      hex('00 01 03 82 00 00 00 00 00 00 00 00 00 00'), // read back
      hex('00 02 03 83 01 00 00 00 00 00 00 00 00 00'), // brightness unchanged: nothing written
    ]);
    expect(f.liveEffect()).toEqual({ effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] });
    // the effect's init redrew the matrix
    expect(f.cells()).toEqual(fill(0xff0040));

    // brightness changed while streaming (Fn key): put back too, and read back
    await live.start();
    f.bri = 50;
    const from2 = f.sent.length;
    await live.stop();
    expect(since(f, from2).map((x) => bytes(x, 8)).slice(2)).toEqual([
      hex('00 02 03 83 01 00 00 00'),
      hex('00 02 03 03 01 00 00 cc'),
      hex('00 02 03 83 01 00 00 00'),
    ]);
    expect(f.bri).toBe(204);
  });

  it('wide boards: rows longer than 17 cells take more than one request', () => {
    const cells = Array.from({ length: 21 }, (_, i) => i + 1);
    const pk = liveFramePkts(1, 21, cells, [0]);
    expect(pk).toHaveLength(2);
    expect(bytes(pk[0], 11)).toEqual(hex('00 38 03 04 00 00 01 01 00 00 10'));
    expect(bytes(pk[1], 11 + 12)).toEqual(hex('00 11 03 04 00 00 01 01 00 11 14 00 00 12 00 00 13 00 00 14 00 00 15'));
    expect(pk.every((x) => allowedStream(x))).toBe(true);
    expect(LIVE_CELLS).toBe(17);
  });
});

describe('live lighting: throttle and coalescing', () => {
  it('sends only the newest frame, never more often than the firmware fps (33)', async () => {
    vi.useFakeTimers();
    const [f, , live] = await connect();
    await live.start();
    const from = f.sent.length;
    const a = live.frame(fill(0x010101));
    const b = live.frame(fill(0x020202));
    const c = live.frame(fill(0x030303));
    await vi.advanceTimersByTimeAsync(30);
    expect(since(f, from)).toHaveLength(0); // 31 ms after the black frame
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b, c]);
    const rows = since(f, from);
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => x[11] === 3 && x[12] === 3 && x[13] === 3)).toBe(true); // only the last one
    expect(f.cells()).toEqual(fill(0x030303));

    // a frame right after waits for the next slot
    const from2 = f.sent.length;
    const d = live.frame(fill(0x040404));
    await vi.advanceTimersByTimeAsync(30);
    expect(since(f, from2)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await d;
    expect(f.cells()).toEqual(fill(0x040404));

    // a page asking 200 times a second for 2 s gets at most 33 frames a second
    const from3 = f.sent.length;
    const all: Promise<void>[] = [];
    for (let i = 0; i < 400; i++) {
      all.push(live.frame(fill(0x100000 + i)));
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(40);
    await Promise.all(all);
    const starts = since(f, from3).filter((x) => x[8] === 0).length; // row 0 = one per frame sent
    expect(starts).toBeGreaterThanOrEqual(60);
    expect(starts).toBeLessThanOrEqual(66);
    expect(f.cells()).toEqual(fill(0x100000 + 399)); // the newest one wins
  });

  it('unchanged rows are skipped, but every row is resent once a second', async () => {
    vi.useFakeTimers();
    const [f, , live] = await connect();
    await live.start();
    const pic = fill(0x0a0b0c);
    let p = live.frame(pic);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    const from = f.sent.length;
    const next = pic.slice();
    next[2 * COLS + 7] = 0xffffff;
    p = live.frame(next);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    expect(since(f, from).map((x) => x[8])).toEqual([2]); // only row 2
    const from2 = f.sent.length;
    p = live.frame(next);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    expect(since(f, from2)).toHaveLength(0); // nothing changed
    await vi.advanceTimersByTimeAsync(1000);
    p = live.frame(next);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    expect(since(f, from2).map((x) => x[8])).toEqual([0, 1, 2, 3, 4]); // keyframe
  });

  it('frames dropped during the power-up animation are repaired by the next full resend', async () => {
    vi.useFakeTimers();
    const [f, , live] = await connect();
    await live.start();
    f.startup = true; // 0x0801f60c: answered "done", data dropped
    let p = live.frame(distinct);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    expect(f.cells()).toEqual(fill(0));
    f.startup = false;
    await vi.advanceTimersByTimeAsync(1000);
    p = live.frame(distinct);
    await vi.advanceTimersByTimeAsync(31);
    await p;
    expect(f.cells()).toEqual(distinct);
  });
});

describe('live lighting: failures and restore', () => {
  it('a refused frame rejects, streaming stays on, stop() still restores', async () => {
    vi.useFakeTimers();
    const [f, , live] = await connect();
    await live.start();
    f.rejectFrames = true;
    const p = live.frame(distinct);
    const err = expect(p).rejects.toThrow(/refused a lighting frame \(status 3\)/);
    await vi.advanceTimersByTimeAsync(31);
    await err;
    expect(live.active).toBe(true);
    // the next frame after a failure resends every row, even ones equal to the last good frame
    f.rejectFrames = false;
    const from = f.sent.length;
    const q = live.frame(fill(0));
    await vi.advanceTimersByTimeAsync(31);
    await q;
    expect(since(f, from).map((x) => x[8])).toEqual([0, 1, 2, 3, 4]);
    f.rejectFrames = true;
    const r = live.frame(distinct);
    const err2 = expect(r).rejects.toThrow(/refused/);
    await vi.advanceTimersByTimeAsync(31);
    await err2;
    await live.stop();
    expect(live.active).toBe(false);
    expect(f.liveEffect()).toEqual({ effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] });
  });

  it('a failing black frame on start puts the effect back and leaves streaming off', async () => {
    const [f, , live] = await connect();
    f.rejectFrames = true;
    await expect(live.start()).rejects.toThrow(/refused/);
    expect(live.active).toBe(false);
    expect(f.liveEffect()).toEqual({ effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] });
  });

  it('frame() before start / with the wrong size rejects', async () => {
    const [, , live] = await connect();
    await expect(live.frame(fill(0))).rejects.toThrow(/not running/);
    await live.start();
    await expect(live.frame([1, 2, 3])).rejects.toThrow(/75 cells/);
    await live.stop();
  });

  it('stop() on a closed or unplugged device does not throw', async () => {
    const [f, , live] = await connect();
    await live.start();
    await f.close();
    const from = f.sent.length;
    await expect(live.stop()).resolves.toBeUndefined();
    expect(f.sent.length).toBe(from);
    expect(live.active).toBe(false);

    const [g, , live2] = await connect();
    await live2.start();
    g.sendFeatureReport = async () => {
      g.opened = false;
      throw new Error('device lost');
    };
    await expect(live2.stop()).resolves.toBeUndefined();
    expect(live2.active).toBe(false);
  });

  it('a failed restore on a connected board throws, and stop() can try again', async () => {
    const [f, , live] = await connect();
    await live.start();
    // the board keeps effect 18 whatever we send back
    const orig = f.sendFeatureReport.bind(f);
    f.sendFeatureReport = async (id: number, data: BufferSource) => {
      const x = new Uint8Array(data as Uint8Array).slice();
      if (x[2] === CLS.LIGHTING && x[3] === LED.EFFECT) {
        x.fill(0, 6);
        x[1] = 5;
        x[7] = 18;
      }
      return orig(id, x);
    };
    await expect(live.stop()).rejects.toThrow(/didn't take/);
    expect(live.active).toBe(false);
    f.sendFeatureReport = orig;
    await live.stop();
    expect(f.liveEffect().effect).toBe(1);
  });

  it('left on 18 by an earlier page: restores the stored effect instead', async () => {
    const [f, , live] = await connect(undefined, (x) => (x.live = { effect: 18, flag: 0, speed: 0, colors: [] }));
    await live.start();
    await live.stop();
    expect(f.liveEffect()).toEqual({ effect: 1, flag: 0, speed: 0, colors: [[0xff, 0x00, 0x40]] });
  });

  it('close() while streaming restores first', async () => {
    const [f, d, live] = await connect();
    await live.start();
    await d.close();
    expect(live.active).toBe(false);
    expect(f.liveEffect().effect).toBe(1);
    expect(f.opened).toBe(false);
  });
});

describe('live lighting: allowlists', () => {
  it('normal write() still refuses SET 4 and effect 18', async () => {
    const row = liveRowPkt(0, 0, 0, fill(0).slice(0, 15));
    expect(allowedStream(row)).toBe(true);
    expect(allowed(row)).toBe(false);
    const fx = liveEffectPkt({ region: 0, effect: 18, flag: 0, speed: 0, colors: [] });
    expect(allowedStream(fx)).toBe(true);
    expect(allowed(fx)).toBe(false);
    expect(allowed(setEffectPkt(1, { region: 0, effect: 18, flag: 0, speed: 0, colors: [] }))).toBe(false);

    const [f, d, , ss] = await connect();
    const from = f.sent.length;
    const mode = ss.find((s) => s.key === 'light_mode')!;
    await expect(d.write({ ...mode, value: { kind: 'choice', options: [], current: 18 } })).rejects.toThrow(/unknown effect/);
    expect(since(f, from, 4)).toHaveLength(0);
    expect(f.sent.slice(from).some((x) => x[3] === LED.EFFECT && x[7] === 18)).toBe(false);
  });

  it('allowedStream: exact row-mode frames and profile-0 effect writes only', () => {
    const ok = liveRowPkt(0, 4, 0, fill(0x123456).slice(0, 15));
    const bad: Uint8Array[] = [];
    const tweak = (i: number, v: number) => {
      const x = ok.slice();
      x[i] = v;
      bad.push(x);
    };
    tweak(7, 0x81); // bit 7 (auto-switch) never sent
    tweak(7, 0x02); // column mode
    tweak(7, 0x00); // fill mode
    tweak(4, 1); // profile byte
    tweak(1, 0x31); // size byte doesn't match
    tweak(10, 0x0d); // last column doesn't match size
    tweak(60, 1); // junk tail
    tweak(0, 1); // not the wired target
    tweak(2, 0); // other class
    bad.push(frame(CLS.LIGHTING, 4, 5 + 3 * 18, 0, [0, 1, 0, 0, 17, ...new Array(54).fill(1)])); // 18 cells
    bad.push(frame(CLS.LIGHTING, 4 | 0x80, 1, 0, [0])); // GET frame (not on this path)
    bad.push(frame(CLS.LIGHTING, 2, 5, 1, [0, 18, 0, 0, 0])); // effect 18 stored to a profile
    bad.push(frame(CLS.LIGHTING, 2, 5, 0, [0, 33, 0, 0, 0])); // unknown effect
    bad.push(frame(CLS.LIGHTING, 3, 2, 0, [0, 255])); // brightness isn't on this list
    bad.push(frame(0, 8, 1, 0, [1])); // factory reset
    expect(allowedStream(ok)).toBe(true);
    for (const x of bad) expect(allowedStream(x), bytes(x, 12).join(' ')).toBe(false);
  });

  it('while streaming, lighting and profile writes are refused; read() keeps the stream', async () => {
    const [f, d, live, ss] = await connect();
    await live.start();
    const bri = ss.find((s) => s.key === 'light_bri')!;
    await expect(d.write({ ...bri, value: { kind: 'number', min: 0, max: 100, current: 10, unit: '%' } })).rejects.toThrow(/stop it first/);
    const again = await d.read();
    expect(d.liveLight).toBe(live);
    expect(live.active).toBe(true);
    // read() shows the stored effect, not 18
    expect(again.find((s) => s.key === 'light_mode')!.value).toMatchObject({ current: 1 });
    expect(f.live?.effect).toBe(18);
    await live.stop();
  });
});
