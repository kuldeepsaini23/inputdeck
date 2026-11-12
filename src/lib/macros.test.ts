import { describe, expect, it } from 'vitest';
import type { MacroStep } from '../drivers/types';
import {
  decodeMacro, decodeMacros, encodeMacro, encodeMacros, fits, hidFromCode, insertSteps, macroSize, macroSummary, moveStep,
  normalize, removeStep, splitMacros, stepProblem, stepText, stepsFromRecording, usedBytes, withMacro, type Macros,
} from './macros';

const sample: MacroStep[] = [
  { t: 'down', kc: 0xe0 }, { t: 'tap', kc: 0x06 }, { t: 'up', kc: 0xe0 },
  { t: 'delay', ms: 1500 }, { t: 'text', text: 'Hello, world!\n' }, { t: 'delay', ms: 0 }, { t: 'tap', kc: 0x28 },
];

describe('QMK macro format', () => {
  it('encodes taps, holds, delays and text like QMK SEND_STRING', () => {
    expect(encodeMacro([{ t: 'tap', kc: 0x04 }], 'qmk')).toEqual([1, 1, 0x04]);
    expect(encodeMacro([{ t: 'down', kc: 0xe1 }, { t: 'up', kc: 0xe1 }], 'qmk')).toEqual([1, 2, 0xe1, 1, 3, 0xe1]);
    expect(encodeMacro([{ t: 'delay', ms: 250 }], 'qmk')).toEqual([1, 4, 0x32, 0x35, 0x30, 0x7c]);
    expect(encodeMacro([{ t: 'text', text: 'ab' }], 'qmk')).toEqual([0x61, 0x62]);
    expect(encodeMacro([{ t: 'tap', kc: 0x04 }], 'qmk-legacy')).toEqual([1, 0x04]);
    expect(encodeMacros([[{ t: 'text', text: 'a' }], [], [{ t: 'tap', kc: 5 }]], 'qmk')).toEqual([0x61, 0, 0, 1, 1, 5, 0]);
  });

  it('round-trips (qmk and legacy)', () => {
    expect(decodeMacro(encodeMacro(sample, 'qmk'), 'qmk')).toEqual(sample);
    const legacy = sample.filter((s) => s.t !== 'delay');
    expect(decodeMacro(encodeMacro(legacy, 'qmk-legacy'), 'qmk-legacy')).toEqual(legacy);
    const all = [sample, [], [{ t: 'text', text: '~`|{}' }] as MacroStep[]];
    expect(decodeMacros(encodeMacros(all, 'qmk'), 3, 'qmk')).toEqual(all);
  });

  it('every basic keycode survives a round trip', () => {
    for (let kc = 1; kc <= 0xff; kc++) {
      for (const t of ['tap', 'down', 'up'] as const) {
        expect(decodeMacro(encodeMacro([{ t, kc }], 'qmk'), 'qmk')).toEqual([{ t, kc }]);
        expect(decodeMacro(encodeMacro([{ t, kc }], 'qmk-legacy'), 'qmk-legacy')).toEqual([{ t, kc }]);
      }
    }
  });

  it('refuses what QMK cannot store', () => {
    expect(() => encodeMacro([{ t: 'tap', kc: 0 }], 'qmk')).toThrow(); // NUL would end the macro
    expect(() => encodeMacro([{ t: 'tap', kc: 0x5221 }], 'qmk')).toThrow(); // 16-bit codes: not in send_string
    expect(() => encodeMacro([{ t: 'delay', ms: 10000 }], 'qmk')).toThrow();
    expect(() => encodeMacro([{ t: 'delay', ms: 1.5 }], 'qmk')).toThrow();
    expect(() => encodeMacro([{ t: 'delay', ms: 10 }], 'qmk-legacy')).toThrow(/delays/);
    expect(() => encodeMacro([{ t: 'text', text: 'é' }], 'qmk')).toThrow(/ASCII/);
    expect(() => encodeMacro([{ t: 'text', text: '\x01' }], 'qmk')).toThrow();
    expect(stepProblem({ t: 'text', text: 'ok\t' }, 'qmk')).toBeUndefined();
  });

  it('decodes like send_string: delay ends at the first non-digit, unknown actions skipped', () => {
    expect(decodeMacro([1, 4, 0x31, 0x30, 0x7c, 0x61], 'qmk')).toEqual([{ t: 'delay', ms: 10 }, { t: 'text', text: 'a' }]);
    expect(decodeMacro([1, 9, 0x61], 'qmk')).toEqual([{ t: 'text', text: 'a' }]);
    expect(decodeMacro([1, 1], 'qmk')).toEqual([]); // truncated
    expect(decodeMacro([0x61, 1], 'qmk')).toEqual([{ t: 'text', text: 'a' }]);
  });

  it('splits the buffer into slots, missing ones empty', () => {
    expect(splitMacros([0x61, 0, 0x62, 0, 0x63], 4)).toEqual([[0x61], [0x62], [], []]);
    expect(splitMacros([0, 0, 0, 0, 0x61, 0], 2)).toEqual([[], []]);
  });

  it('counts bytes', () => {
    expect(macroSize([], 'qmk')).toBe(1);
    expect(macroSize([{ t: 'tap', kc: 4 }, { t: 'delay', ms: 50 }], 'qmk')).toBe(3 + 5 + 1);
    expect(macroSize([{ t: 'tap', kc: 0x1234 }], 'qmk')).toBeUndefined();
    const v: Macros = { kind: 'macros', slots: 2, maxBytes: 6, format: 'qmk', macros: [[{ t: 'text', text: 'abc' }], []] };
    expect(usedBytes(v)).toBe(5);
    expect(fits(v)).toBe(true);
    expect(fits(withMacro(v, 1, [{ t: 'text', text: 'xy' }]))).toBe(false);
    expect(usedBytes({ ...v, format: undefined })).toBeUndefined();
  });
});

describe('editing helpers', () => {
  const s: MacroStep[] = [{ t: 'tap', kc: 4 }, { t: 'tap', kc: 5 }, { t: 'tap', kc: 6 }];
  it('insert / move / remove', () => {
    expect(insertSteps(s, 1, [{ t: 'delay', ms: 5 }]).map((x) => x.t)).toEqual(['tap', 'delay', 'tap', 'tap']);
    expect(insertSteps(s, 99, [{ t: 'delay', ms: 5 }]).at(-1)).toEqual({ t: 'delay', ms: 5 });
    expect(moveStep(s, 0, 1)).toEqual([s[1], s[0], s[2]]);
    expect(moveStep(s, 0, -1)).toEqual(s);
    expect(removeStep(s, 1)).toEqual([s[0], s[2]]);
    expect(s.length).toBe(3);
  });

  it('normalize merges text', () => {
    expect(normalize([{ t: 'text', text: 'a' }, { t: 'text', text: '' }, { t: 'text', text: 'b' }, { t: 'tap', kc: 4 }]))
      .toEqual([{ t: 'text', text: 'ab' }, { t: 'tap', kc: 4 }]);
  });

  it('labels', () => {
    expect(stepText({ t: 'tap', kc: 0x04 })).toBe('A');
    expect(stepText({ t: 'down', kc: 0xe1 })).toBe('↓ Shift');
    expect(stepText({ t: 'delay', ms: 30 })).toBe('30 ms');
    expect(stepText({ t: 'text', text: 'a\n' })).toBe('“a⏎”');
    expect(macroSummary([])).toBe('Empty');
  });
});

describe('recording', () => {
  it('maps KeyboardEvent.code to HID usages', () => {
    expect(hidFromCode('KeyA')).toBe(0x04);
    expect(hidFromCode('KeyZ')).toBe(0x1d);
    expect(hidFromCode('Digit1')).toBe(0x1e);
    expect(hidFromCode('Digit0')).toBe(0x27);
    expect(hidFromCode('F1')).toBe(0x3a);
    expect(hidFromCode('F12')).toBe(0x45);
    expect(hidFromCode('F13')).toBe(0x68);
    expect(hidFromCode('F24')).toBe(0x73);
    expect(hidFromCode('Numpad1')).toBe(0x59);
    expect(hidFromCode('Numpad0')).toBe(0x62);
    expect(hidFromCode('ShiftLeft')).toBe(0xe1);
    expect(hidFromCode('MetaRight')).toBe(0xe7);
    expect(hidFromCode('Escape')).toBe(0x29);
    expect(hidFromCode('F25')).toBeUndefined();
    expect(hidFromCode('Unidentified')).toBeUndefined();
  });

  it('turns key events into taps, holds and delays', () => {
    const ev = [
      { type: 'down', kc: 0xe1, at: 0 },
      { type: 'down', kc: 0x04, at: 100 },
      { type: 'down', kc: 0x04, at: 130 }, // auto-repeat
      { type: 'up', kc: 0x04, at: 180 },
      { type: 'up', kc: 0xe1, at: 200 },
      { type: 'up', kc: 0x05, at: 210 }, // never pressed
      { type: 'down', kc: 0x06, at: 704 },
      { type: 'up', kc: 0x06, at: 720 },
    ] as const;
    expect(stepsFromRecording([...ev], { delays: true })).toEqual([
      { t: 'down', kc: 0xe1 }, { t: 'delay', ms: 100 }, { t: 'tap', kc: 0x04 }, { t: 'up', kc: 0xe1 },
      { t: 'delay', ms: 500 }, { t: 'tap', kc: 0x06 },
    ]);
    expect(stepsFromRecording([...ev], { delays: false })).toEqual([
      { t: 'down', kc: 0xe1 }, { t: 'tap', kc: 0x04 }, { t: 'up', kc: 0xe1 }, { t: 'tap', kc: 0x06 },
    ]);
    // long pauses are capped, held keys are released at the end
    expect(stepsFromRecording([{ type: 'down', kc: 4, at: 0 }, { type: 'down', kc: 5, at: 60000 }], { delays: true, maxDelay: 9999 }))
      .toEqual([{ t: 'down', kc: 4 }, { t: 'delay', ms: 9999 }, { t: 'down', kc: 5 }, { t: 'up', kc: 4 }, { t: 'up', kc: 5 }]);
  });
});
