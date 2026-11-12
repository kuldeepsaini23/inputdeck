import { describe, expect, it } from 'vitest';
import type { MacroStep } from '../drivers/types';
import {
  PULSAR_MAX_EVENTS, decodeMacro, encodeMacro, fits, keyOk, macroProblem, macroSize, macroSummary, slotName, stepProblem, stepText,
  type Macros,
} from './macros';

const A = 0x04;
const B = 0x05;
const LSHIFT = 0xe1;

/** every kind of step a mouse macro can hold */
const sample: MacroStep[] = [
  { t: 'down', kc: LSHIFT }, { t: 'tap', kc: A }, { t: 'up', kc: LSHIFT }, { t: 'delay', ms: 20 },
  { t: 'mouse', a: 'tap', btn: 1 }, { t: 'delay', ms: 300 },
  { t: 'mouse', a: 'down', btn: 2 }, { t: 'mouse', a: 'down', btn: 5 }, { t: 'wheel', dir: 1 }, { t: 'mouse', a: 'up', btn: 2 },
  { t: 'mouse', a: 'up', btn: 5 }, { t: 'wheel', dir: -1 }, { t: 'delay', ms: 65535 }, { t: 'tap', kc: 0xa4 },
];

describe('WLMouse macro format (official hub MA / RA)', () => {
  it('encodes keys, modifiers, mouse buttons, wheel and delays like the hub', () => {
    expect(encodeMacro([{ t: 'tap', kc: A }, { t: 'delay', ms: 20 }, { t: 'mouse', a: 'tap', btn: 1 }], 'wlmouse')).toEqual([
      0x02, A, 0x03, A, 0x20, 20, 0x01, 0x01, 0x01, 0x00,
    ]);
    expect(encodeMacro([{ t: 'down', kc: LSHIFT }, { t: 'up', kc: 0xe7 }], 'wlmouse')).toEqual([0x09, 0x02, 0x0a, 0x80]);
    expect(encodeMacro([{ t: 'delay', ms: 300 }, { t: 'delay', ms: 255 }], 'wlmouse')).toEqual([0x21, 0x01, 0x2c, 0x20, 0xff]);
    expect(encodeMacro([{ t: 'wheel', dir: 1 }, { t: 'wheel', dir: -1 }], 'wlmouse')).toEqual([0x10, 0x01, 0x10, 0xff]);
    // the button record holds every button that is down (absolute mask)
    expect(encodeMacro([{ t: 'mouse', a: 'down', btn: 1 }, { t: 'mouse', a: 'down', btn: 4 }, { t: 'mouse', a: 'up', btn: 1 }, { t: 'mouse', a: 'up', btn: 4 }], 'wlmouse'))
      .toEqual([0x01, 0x01, 0x01, 0x09, 0x01, 0x08, 0x01, 0x00]);
  });

  it('round-trips every step kind', () => {
    expect(decodeMacro(encodeMacro(sample, 'wlmouse'), 'wlmouse')).toEqual(sample);
    expect(decodeMacro([], 'wlmouse')).toEqual([]);
  });

  it('reads the hub\'s 24/32-bit delays and stops at an unknown record like the hub', () => {
    expect(decodeMacro([0x22, 0x00, 0x01, 0x00, 0x23, 0, 0, 0, 5], 'wlmouse')).toEqual([{ t: 'delay', ms: 256 }, { t: 'delay', ms: 5 }]);
    expect(decodeMacro([0x02, A, 0x77, 1, 0x03, A], 'wlmouse')).toEqual([{ t: 'down', kc: A }]);
  });

  it('sizes are the exact byte count (no NUL)', () => {
    expect(macroSize([{ t: 'tap', kc: A }], 'wlmouse')).toBe(4);
  });
});

describe('Pulsar macro format (web app la / gi)', () => {
  it('encodes 5-byte events: status<<6 | type, value LE, delay-after BE', () => {
    // tap = press, 10 ms (the app's default gap), release; a delay step lands on the event before it
    expect(encodeMacro([{ t: 'tap', kc: A }, { t: 'delay', ms: 50 }], 'pulsar')).toEqual([
      0x81, A, 0, 0, 10, 0x41, A, 0, 0, 50,
    ]);
    expect(encodeMacro([{ t: 'down', kc: LSHIFT }, { t: 'mouse', a: 'up', btn: 5 }, { t: 'wheel', dir: -1 }], 'pulsar')).toEqual([
      0x80, 0x02, 0, 0, 0, 0x44, 0x10, 0, 0, 0, 0x06, 0xff, 0, 0, 0,
    ]);
    expect(encodeMacro([{ t: 'tap', kc: B }, { t: 'delay', ms: 300 }, { t: 'delay', ms: 200 }], 'pulsar').slice(5)).toEqual([0x41, B, 0, 0x01, 0xf4]);
  });

  it('round-trips every step kind that does not start with a delay', () => {
    expect(decodeMacro(encodeMacro(sample, 'pulsar'), 'pulsar')).toEqual(sample);
    // a press with the 10 ms gap but no matching release keeps its gap as a delay
    const odd: MacroStep[] = [{ t: 'down', kc: A }, { t: 'delay', ms: 10 }, { t: 'up', kc: B }];
    expect(decodeMacro(encodeMacro(odd, 'pulsar'), 'pulsar')).toEqual(odd);
  });

  it('decodes a recording from Pulsar\'s app (key down/up with recorded gaps)', () => {
    const rec = [0x81, A, 0, 0, 96, 0x41, A, 0, 0, 120, 0x84, 0x01, 0, 0, 0, 0x44, 0x01, 0, 0, 0];
    expect(decodeMacro(rec, 'pulsar')).toEqual([
      { t: 'down', kc: A }, { t: 'delay', ms: 96 }, { t: 'up', kc: A }, { t: 'delay', ms: 120 },
      { t: 'mouse', a: 'down', btn: 1 }, { t: 'mouse', a: 'up', btn: 1 },
    ]);
    // mouse movement (type 5) and the menu key (type 7) can't be shown and are left out
    expect(decodeMacro([0x05, 3, 0, 0, 0, 0x87, 1, 0, 0, 0, 0x81, B, 0, 0, 10, 0x41, B, 0, 0, 0], 'pulsar')).toEqual([{ t: 'tap', kc: B }]);
  });

  it('refuses what the mouse cannot store', () => {
    expect(macroProblem([{ t: 'delay', ms: 10 }, { t: 'tap', kc: A }], 'pulsar')).toMatch(/start with a delay/);
    expect(macroProblem([{ t: 'tap', kc: A }, { t: 'delay', ms: 65535 }], 'pulsar')).toBeUndefined();
    expect(macroProblem([{ t: 'tap', kc: A }, { t: 'delay', ms: 65535 }, { t: 'delay', ms: 1 }], 'pulsar')).toMatch(/add up/);
    const many: MacroStep[] = Array.from({ length: PULSAR_MAX_EVENTS / 2 }, () => ({ t: 'tap', kc: A }));
    expect(macroProblem(many, 'pulsar')).toBeUndefined();
    expect(macroSize(many, 'pulsar')).toBe(5 * PULSAR_MAX_EVENTS);
    expect(macroProblem([...many, { t: 'down', kc: B }], 'pulsar')).toMatch(/at most 70/);
  });
});

describe('mouse macro rules', () => {
  it('no text on mice, no mouse steps on keyboards, keys limited to HID usages', () => {
    expect(stepProblem({ t: 'text', text: 'hi' }, 'wlmouse')).toMatch(/can't type text/);
    expect(stepProblem({ t: 'mouse', a: 'tap', btn: 1 }, 'qmk')).toMatch(/mouse buttons/);
    expect(stepProblem({ t: 'wheel', dir: 1 }, 'qmk')).toMatch(/scroll/);
    expect(stepProblem({ t: 'mouse', a: 'tap', btn: 6 }, 'pulsar')).toBeTruthy();
    expect(stepProblem({ t: 'delay', ms: 65535 }, 'wlmouse')).toBeUndefined();
    expect(stepProblem({ t: 'delay', ms: 65536 }, 'pulsar')).toBeTruthy();
    expect(stepProblem({ t: 'delay', ms: 10000 }, 'qmk')).toBeTruthy(); // keyboards keep their limit
    expect(keyOk(0xa8, 'qmk')).toBe(true);
    expect(keyOk(0xa8, 'wlmouse')).toBe(false); // QMK media codes are not HID keyboard usages
    expect(keyOk(0xe7, 'pulsar')).toBe(true);
    expect(keyOk(0x03, 'pulsar')).toBe(false);
  });

  it('text, summary and per-macro limits', () => {
    expect(stepText({ t: 'mouse', a: 'tap', btn: 1 })).toBe('Left click');
    expect(stepText({ t: 'mouse', a: 'down', btn: 4 })).toBe('↓ Back click');
    expect(stepText({ t: 'wheel', dir: -1 })).toBe('Scroll ↓');
    expect(macroSummary([{ t: 'mouse', a: 'down', btn: 2 }, { t: 'mouse', a: 'up', btn: 2 }])).toBe('↓ Right click');
    const v: Macros = { kind: 'macros', slots: 2, format: 'pulsar', maxPerMacro: 10, slotNames: ['M1 · Left', 'M2 · Right'], macros: [[{ t: 'tap', kc: A }], []] };
    expect(fits(v)).toBe(true);
    expect(fits({ ...v, macros: [[{ t: 'tap', kc: A }, { t: 'tap', kc: B }], []] })).toBe(false);
    expect(slotName(v, 1)).toBe('M2 · Right');
    expect(slotName({ ...v, slotNames: undefined }, 1)).toBe('M1');
  });
});
