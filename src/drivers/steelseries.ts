// SteelSeries mice (Rival, Sensei, Aerox, Prime, Kana, Kinzu). The commands come from rivalcfg
// (https://github.com/flozz/rivalcfg, WTFPL): its device profiles are turned into steelseries-devices.gen.ts by
// scripts/steelseries-table.mjs, and the encoders below port its value handlers byte for byte (checked against
// rivalcfg's own test vectors in steelseries.test.ts).
//
// These mice can't report their settings: every command only sets something. So the values shown are what
// InputDeck last set from this browser (kept in localStorage), or rivalcfg's factory defaults before that.
// Only the firmware version and the battery (wireless models) are read from the mouse.
import { describe as keyName } from '../lib/keycodes';
import { SS_PROFILES } from './steelseries-devices.gen';
import type { Driver, DriverFactory, Setting, Value } from './types';
import { sleep } from './types';

export const SS_VID = 0x1038;
/** pause after each command (rivalcfg's default; tests set 0) and how long to wait for an answer */
export const timing = { gap: 50, answer: 200 };

// ---------- profile types (shape written by scripts/steelseries-table.mjs) ----------
type ReportType = 'output' | 'feature';
export interface SsCmd {
  report_type: ReportType;
  command: number[];
  packet_length?: number;
  readback_length?: number;
  response_length?: number;
}
type Key = string | number;
export interface SsButton {
  id: number;
  offset: number;
  default: string;
}
export interface SsSetting extends SsCmd {
  label: string;
  description: string;
  value_type: string;
  command_suffix?: number[];
  /** output: one byte, or several for a few settings (e.g. Rival 600 start-up lighting) */
  choices?: [Key, number | number[]][];
  input_range?: [number, number, number];
  output_range?: [number, number, number];
  output_choices?: [number, number][];
  range_length_byte?: number;
  dpi_length_byte?: number;
  first_preset?: number;
  max_preset_count?: number;
  count_mode?: 'number' | 'flag';
  xy_mapping?: 'xyxy' | 'xxyy';
  led_id?: number;
  rgbgradient_header?: {
    header_length: number;
    led_id_offsets: number[];
    duration_offset: number;
    duration_length: number;
    repeat_offset: number;
    triggers_offset: number;
    color_count_offset: number;
  };
  rgbgradientv2_header?: { color_field_length: number; duration_length: number; maxgradient: number };
  buttons?: Record<string, SsButton>;
  button_disable?: number | null;
  button_dpi_switch?: number | null;
  button_scroll_up?: number | null;
  button_scroll_down?: number | null;
  button_keyboard?: number | null;
  button_multimedia?: number | null;
  button_field_length?: number;
  default?: unknown;
}
export interface SsProfile {
  id: string;
  name: string;
  models: { name: string; pid: number; endpoint: number }[];
  settings: Record<string, SsSetting>;
  save?: SsCmd;
  firmware?: SsCmd;
  battery?: SsCmd & { format: 'aerox' | 'rival' };
}

// ---------- encoders (ports of rivalcfg/handlers/*.py) ----------
const le = (n: number, size: number): number[] => {
  if (n > 2 ** (8 * size) - 1 || n < 0) throw new Error('value out of range');
  return Array.from({ length: size }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff);
};

/** handlers/range.py: snap to the input range's step, map to the same position in the output range */
export function encRangeValue(s: SsSetting, value: number): number {
  const [a, b, st] = s.input_range!;
  const [oa, , ost] = s.output_range!;
  let v = Math.trunc(value);
  if (v <= a) v = a;
  else if (v >= b) v = b;
  else {
    const d = (v - a) % st;
    if (d) v = d < st / 2 ? v - d : v - d + st;
  }
  return oa + ((v - a) / st) * ost;
}

/** handlers/range_choice.py: nearest listed input value */
export function encRangeChoiceValue(s: SsSetting, value: number): number {
  let best: [number, number] | undefined;
  for (const [k, out] of [...s.output_choices!].sort((x, y) => x[0] - y[0])) {
    if (!best || Math.abs(k - value) < Math.abs(best[0] - value)) best = [k, out];
  }
  return best![1];
}

/** handlers/multidpi_range*.py: [count, selected preset, dpi values...] */
export function encMultiDpi(s: SsSetting, dpis: number[], selected = 0): number[] {
  const max = s.max_preset_count!;
  if (dpis.length < 1 || dpis.length > max) throw new Error(`1 to ${max} DPI stages`);
  if (selected < 0 || selected >= dpis.length) throw new Error('the selected stage is out of range');
  const len = s.dpi_length_byte!;
  const one = (d: number) => le(s.value_type === 'multidpi_range' ? encRangeValue(s, d) : encRangeChoiceValue(s, d), len);
  let body: number[];
  if (s.value_type === 'multidpi_range_choice_xy') {
    const pairs = dpis.map((d) => [one(d), one(d)]);
    if (s.xy_mapping === 'xyxy') body = pairs.flat(2);
    else {
      while (pairs.length < max) pairs.push([le(0, len), le(0, len)]);
      body = [...pairs.flatMap((p) => p[0]), ...pairs.flatMap((p) => p[1])];
    }
  } else body = dpis.flatMap(one);
  const count = s.value_type === 'multidpi_range' && s.count_mode === 'flag' ? 0xff >> (8 - dpis.length) : dpis.length;
  return [count, selected + s.first_preset!, ...body];
}

const rgb3 = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];

/** handlers/rgbgradient.py with one colour (rivalcfg's plain-colour case) or a list of stops */
export function encGradient(s: SsSetting, stops: { pos: number; color: number }[], duration = 1000): number[] {
  const h = s.rgbgradient_header!;
  const isGradient = stops.length > 1;
  if (stops.length < 1 || stops.length > 14) throw new Error('1 to 14 colours');
  const header = new Array<number>(h.header_length).fill(0);
  header[h.repeat_offset] = isGradient ? 0 : 1;
  header[h.triggers_offset] = 0;
  header[h.color_count_offset] = stops.length;
  for (const o of h.led_id_offsets) header[o] = s.led_id!;
  le(duration, h.duration_length).forEach((b, i) => (header[h.duration_offset + i] = b));
  const body = rgb3(stops[0].color);
  let last = 0;
  for (const st of stops) {
    const real = Math.trunc((st.pos * 255) / 100);
    body.push(...rgb3(st.color), real - last);
    last = real;
  }
  return [...header, ...body];
}

/** handlers/rgbgradientv2.py (Rival 500 / 700) */
export function encGradientV2(s: SsSetting, stops: { pos: number; color: number }[], duration = 1000): number[] {
  const h = s.rgbgradientv2_header!;
  if (stops.length < 1 || stops.length > h.maxgradient) throw new Error(`1 to ${h.maxgradient} colours`);
  if (duration < Math.trunc(stops.length * 33.3) || duration > 30000) throw new Error('duration out of range');
  let header = [s.led_id!, 0x1d, 0x01, 0x02, 0x31, 0x51, 0xff, 0xc8, 0x00];
  let last = stops[0].pos;
  const start = rgb3(stops[0].color);
  const old = start.slice();
  const stage: number[] = [];
  stops.slice(1).forEach((st, index) => {
    if (st.pos <= last) throw new Error('colour stops out of order');
    stage.push(index, 0);
    const time = Math.trunc((duration / 100) * (st.pos - last));
    last = st.pos;
    if (time === 0) throw new Error('colour stops too close');
    rgb3(st.color).forEach((c, i) => {
      stage.push(Math.trunc(((c - old[i]) / time) * 16) & 0xff);
      old[i] = c;
    });
    stage.push(0, ...le(time, 2));
  });
  header = [...header, ...stage];
  header.push(...new Array<number>(Math.max(0, h.color_field_length - header.length)).fill(0));
  const split = start.flatMap((c) => [(c & 0x0f) << 4, c >> 4]);
  return [...header, ...split, 0xff, 0x00, ...le(1500, 2), ...le(650, 2), 0, 0, 0, 0, 1, 0, ...le(stops.length - 1, 2), ...le(duration, h.duration_length)];
}

/** handlers/reactive_rgbcolor.py */
export const encReactive = (on: boolean, color: number) => (on ? [0x01, 0x00, ...rgb3(color)] : [0, 0, 0, 0, 0]);

// button actions (the values of the per-button choice settings)
export const ACT_DISABLE = 1;
export const ACT_DPI = 2;
export const ACT_SCROLL_UP = 3;
export const ACT_SCROLL_DOWN = 4;
/** the function of another physical button: ACT_BUTTON + index in the profile's button list */
export const ACT_BUTTON = 0x100;
export const ACT_MEDIA = 0x200;
export const ACT_KEY = 0x300;
/** layout_multimedia.py */
const MEDIA: [string, number][] = [['Mute', 0xe2], ['Next track', 0xb5], ['Play / pause', 0xcd], ['Previous track', 0xb6], ['Volume up', 0xe9], ['Volume down', 0xea]];
/** layout_qwerty.py covers HID usages 0x04..0x65 and the modifiers */
const KEYS = [...Array.from({ length: 0x65 - 0x04 + 1 }, (_, i) => 0x04 + i), ...Array.from({ length: 8 }, (_, i) => 0xe0 + i)];

/** rivalcfg's action names (button defaults) -> our action values */
function actionFromName(s: SsSetting, name: string): number {
  const n = name.toLowerCase();
  const names = Object.keys(s.buttons!).map((b) => b.toLowerCase());
  if (names.includes(n)) return ACT_BUTTON + names.indexOf(n);
  if (n === 'disable' || n === 'disabled') return ACT_DISABLE;
  if (n === 'dpi') return ACT_DPI;
  if (n === 'scrollup') return ACT_SCROLL_UP;
  if (n === 'scrolldown') return ACT_SCROLL_DOWN;
  if (n === 'pageup') return ACT_KEY | 0x4b;
  if (n === 'pagedown') return ACT_KEY | 0x4e;
  throw new Error('unknown default ' + name);
}

/** handlers/buttons/buttons.py: one field per button at its offset */
export function encButtons(s: SsSetting, actions: number[]): number[] {
  const btns = Object.values(s.buttons!);
  const out = new Array<number>(btns.length * s.button_field_length!).fill(0);
  btns.forEach((b, i) => {
    const a = actions[i];
    const special = (v: number | null | undefined) => {
      if (v === null || v === undefined) throw new Error("this button can't do that");
      out[b.offset] = v;
    };
    if (a >= ACT_BUTTON && a < ACT_BUTTON + btns.length) out[b.offset] = btns[a - ACT_BUTTON].id;
    else if (a === ACT_DISABLE) special(s.button_disable);
    else if (a === ACT_DPI) special(s.button_dpi_switch);
    else if (a === ACT_SCROLL_UP) special(s.button_scroll_up);
    else if (a === ACT_SCROLL_DOWN) special(s.button_scroll_down);
    else if ((a & 0xff00) === ACT_MEDIA && MEDIA.some(([, c]) => c === (a & 0xff))) {
      special(s.button_multimedia);
      out[b.offset + 1] = a & 0xff;
    } else if ((a & 0xff00) === ACT_KEY && KEYS.includes(a & 0xff)) {
      special(s.button_keyboard);
      out[b.offset + 1] = a & 0xff;
    } else throw new Error('unknown button action');
  });
  return out;
}

/** command + value + suffix, padded to packet_length (rivalcfg Mouse._hid_write without the report id) */
export function packet(c: SsCmd & { command_suffix?: number[] }, data: number[] = []): Uint8Array<ArrayBuffer> {
  const b = [...c.command, ...data, ...(c.command_suffix ?? [])];
  while (c.packet_length && b.length < c.packet_length) b.push(0);
  return Uint8Array.from(b);
}

// ---------- defaults ----------
const NAMED: Record<string, number> = { white: 0xffffff, black: 0, off: 0, red: 0xff0000, lime: 0x00ff00, blue: 0x0000ff, purple: 0x800080 };
/** rivalcfg colour strings ("red", "#FF1800", "rgbgradient(...; colors=0%: #ff0000, ...)") -> first colour */
export function parseColor(v: unknown): number {
  const str = String(v ?? '').trim().toLowerCase();
  if (str in NAMED) return NAMED[str];
  const m = /#?([0-9a-f]{6})\b/.exec(str);
  return m ? parseInt(m[1], 16) : 0xffffff;
}
const parseDpis = (v: unknown): number[] => String(v).split(',').map((x) => parseInt(x.split(':')[0], 10)).filter((n) => !isNaN(n));
/** "buttons(button1=button1; button6=dpi; ...)" -> per button action */
function defaultButtons(s: SsSetting): number[] {
  const m = /\((.*)\)/.exec(String(s.default ?? ''));
  const given = new Map<string, string>();
  for (const part of (m?.[1] ?? '').split(';')) {
    const [k, v] = part.split('=').map((x) => x.trim().toLowerCase());
    if (k && v) given.set(k, v);
  }
  return Object.entries(s.buttons!).map(([name, b]) => actionFromName(s, given.get(name.toLowerCase()) ?? b.default));
}

// ---------- remembered values ----------
const STORE = 'inputdeck.steelseries.';
type Saved = Record<string, unknown>;
const family = (p: SsProfile) => p.id.replace(/_(wired|wireless)$/, '');
/** the simulated demo mouse remembers in memory only, so it never mixes into a real mouse's values */
const demoMem = new Map<string, Saved>();
function loadSaved(p: SsProfile, demo = false): Saved {
  if (demo) return demoMem.get(family(p)) ?? {};
  try {
    return JSON.parse(localStorage.getItem(STORE + family(p)) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
function storeSaved(p: SsProfile, v: Saved, demo = false) {
  if (demo) return void demoMem.set(family(p), v);
  try {
    localStorage.setItem(STORE + family(p), JSON.stringify(v));
  } catch {
    /* private window: values just aren't remembered */
  }
}

// ---------- UI mapping ----------
/** rivalcfg's named choices (lighting effects, zones, brightness levels) */
const CHOICE_NAMES: Record<string, { label: string }> = {
  all: { label: 'All zones' }, top: { label: 'Top' }, middle: { label: 'Middle' }, bottom: { label: 'Bottom' },
  'bottom-middle': { label: 'Bottom and middle' }, 'middle-top': { label: 'Middle and top' }, 'bottom-top': { label: 'Bottom and top' },
  off: { label: 'Off' }, reactive: { label: 'Reactive' }, rainbow: { label: 'Rainbow' }, 'reactive-rainbow': { label: 'Reactive rainbow' },
  low: { label: 'Low' }, medium: { label: 'Medium' }, high: { label: 'High' },
  steady: { label: 'Steady' }, breath: { label: 'Breathing' }, trigger: { label: 'Flash on click' },
  'rainbow-shift': { label: 'Rainbow shift' }, 'breath-fast': { label: 'Breathing (fast)' }, 'breath-slow': { label: 'Breathing (slow)' },
  'rainbow-breath': { label: 'Rainbow breathing' }, disco: { label: 'Disco' },
};
/** Rival 100 / 110 / Sensei Raw effects 1-4 (rivalcfg docs: steady, slow / medium / fast breathing) */
const EFFECT_N: Record<number, { label: string }> = { 1: { label: 'Steady' }, 2: { label: 'Breathing (slow)' }, 3: { label: 'Breathing' }, 4: { label: 'Breathing (fast)' } };
const pretty = (k: Key, setting: string) =>
  typeof k === 'number' ? (/brightness/.test(setting) ? `${k}%` : (EFFECT_N[k]?.label ?? String(k))) : (CHOICE_NAMES[k]?.label ?? k);
/** choices with the same output bytes as an earlier one are aliases in rivalcfg: offer each once */
const uniqueChoices = (s: SsSetting) => s.choices!.filter(([, out], i) => s.choices!.findIndex(([, o]) => String(o) === String(out)) === i);
/** a choice's bytes */
export const choiceBytes = (s: SsSetting, i: number): number[] => [s.choices![i][1]].flat();

const LABELS: Record<string, { label: string }> = {
  color: { label: 'Colour' }, logo_color: { label: 'Logo colour' }, wheel_color: { label: 'Wheel colour' }, reactive_color: { label: 'Reactive colour' },
  z1_color: { label: 'Zone 1 colour' }, z2_color: { label: 'Zone 2 colour' }, z3_color: { label: 'Zone 3 colour' }, z4_color: { label: 'Zone 4 colour' },
  z5_color: { label: 'Zone 5 colour' }, z6_color: { label: 'Zone 6 colour' }, z7_color: { label: 'Zone 7 colour' }, z8_color: { label: 'Zone 8 colour' },
  z9_color: { label: 'Zone 9 colour' }, light_effect: { label: 'Light effect' }, logo_light_effect: { label: 'Logo light effect' },
  wheel_light_effect: { label: 'Wheel light effect' }, led_brightness: { label: 'Brightness' }, led_brightness1: { label: 'Brightness on DPI stage 1' },
  led_brightness2: { label: 'Brightness on DPI stage 2' }, rainbow_effect: { label: 'Rainbow effect' }, default_lighting: { label: 'Lighting at start-up' },
  btn6_mode: { label: 'Button under the wheel' }, lift_off_distance: { label: 'Lift-off distance' }, dim_timer: { label: 'Dim the lights after' },
};
const labelOf = (k: string, st: SsSetting) => LABELS[k]?.label ?? st.label;
const BTN_LABELS: Record<string, { label: string }> = {
  button1: { label: 'Left click' }, button2: { label: 'Right click' }, button3: { label: 'Middle click' }, button4: { label: 'Back' },
  button5: { label: 'Forward' }, scrollup: { label: 'Scroll up' }, scrolldown: { label: 'Scroll down' }, tiltleft: { label: 'Tilt left' },
  tiltright: { label: 'Tilt right' },
};
const btnLabel = (name: string) => BTN_LABELS[name.toLowerCase()]?.label ?? name.replace(/^Button(\d+)$/, 'Button $1');

const s = (key: string, label: string, group: string, value: Value, hint?: string): Setting => ({ key, label, group, value, ...(hint ? { hint } : {}) });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });

class SteelSeriesDriver implements Driver {
  readonly id: string;
  readonly family = 'steelseries';
  readonly kind = 'mouse' as const;
  /** nobody has tried this on real hardware with InputDeck yet */
  readonly verified = false;
  private saved: Saved;
  private readonly demo: boolean;
  private inbox: ((d: Uint8Array) => void)[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private device: HIDDevice,
    private p: SsProfile,
    private modelName: string,
  ) {
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.demo = (device as { simulated?: boolean }).simulated === true;
    this.saved = loadSaved(p, this.demo);
    device.addEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const f = this.inbox.shift();
    if (f) f(d.slice());
  };

  brand() {
    return 'SteelSeries';
  }
  model() {
    return this.modelName.replace(/^SteelSeries /, '');
  }
  image() {
    return undefined;
  }

  /** one command at a time, with rivalcfg's 50 ms pause after each (some mice hang when rushed) */
  private send(c: SsCmd & { command_suffix?: number[] }, data: number[] = [], answer = 0): Promise<Uint8Array | undefined> {
    const run = async () => {
      const bytes = packet(c, data) as Uint8Array<ArrayBuffer>;
      const want = answer || c.readback_length || 0;
      const got = want ? this.next(timing.answer) : undefined;
      if (c.report_type === 'feature') await this.device.sendFeatureReport(0, bytes);
      else await this.device.sendReport(0, bytes);
      const r = got ? await got : undefined;
      if (timing.gap) await sleep(timing.gap);
      return r;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private next(ms: number): Promise<Uint8Array | undefined> {
    return new Promise((res) => {
      const f = (d: Uint8Array) => {
        clearTimeout(t);
        res(d);
      };
      const t = setTimeout(() => {
        this.inbox = this.inbox.filter((x) => x !== f);
        res(undefined);
      }, ms);
      this.inbox.push(f);
    });
  }

  // ----- current values: remembered, else rivalcfg's default -----
  private val<T>(key: string, def: () => T): T {
    return (key in this.saved ? this.saved[key] : def()) as T;
  }
  private dpiCfg(): { stages: number[]; active: number } {
    const st = this.p.settings.sensitivity;
    return this.val('sensitivity', () => ({ stages: parseDpis(st.default).slice(0, st.max_preset_count), active: 0 }));
  }
  private choiceIdx(k: string): number {
    const c = this.p.settings[k];
    return this.val(k, () => Math.max(0, c.choices!.findIndex(([key]) => String(key) === String(c.default))));
  }
  private num(k: string): number {
    return this.val(k, () => Number(this.p.settings[k].default));
  }
  private color(k: string): number {
    return this.val(k, () => parseColor(this.p.settings[k].default));
  }
  private buttons(): number[] {
    const b = this.p.settings.buttons_mapping;
    const v = this.val<number[]>('buttons_mapping', () => defaultButtons(b));
    return v.length === Object.keys(b.buttons!).length ? v : defaultButtons(b);
  }

  async read(): Promise<Setting[]> {
    const p = this.p;
    const out: Setting[] = [text('model', 'Model', 'Info', this.model())];
    if (p.firmware) {
      const r = await this.send(p.firmware, [], p.firmware.response_length ?? 2).catch(() => undefined);
      if (r && r.length) out.push(text('fw', 'Firmware', 'Info', Array.from(r.slice(0, p.firmware.response_length ?? 2)).join('.')));
    }
    if (p.battery) {
      const r = await this.send(p.battery, [], p.battery.response_length ?? 64).catch(() => undefined);
      const b = r && batteryOf(p.battery.format, r);
      if (b) out.push(text('battery', 'Battery', 'Info', `${b.level}%${b.charging ? ' (charging)' : ''}`));
    }
    out.push({
      key: 'note',
      label: 'Values shown',
      group: 'Performance',
      value: { kind: 'text', text: 'Last set here' },
      hint: "SteelSeries mice can't report their settings, so this shows what InputDeck last set from this browser (or the factory defaults). Changing a value sends it to the mouse and saves it there.",
    });

    for (const [k, st] of Object.entries(p.settings)) {
      const vt = st.value_type;
      if (k === 'sensitivity' && vt.startsWith('multidpi')) {
        const [min, max, step] = st.input_range!;
        const d = this.dpiCfg();
        out.push(s('dpi', 'DPI', 'DPI', { kind: 'dpi', stages: d.stages, active: Math.min(d.active, d.stages.length - 1), min, max, step }));
        const n = st.max_preset_count!;
        if (n > 1) out.push(s('dpi_count', 'Number of DPI stages', 'DPI', { kind: 'choice', options: Array.from({ length: n }, (_, i) => [String(i + 1), i + 1]), current: d.stages.length }));
      } else if (k === 'sensitivity1') {
        const s2 = p.settings.sensitivity2;
        const lim = (x: SsSetting) => (x.input_range ?? [Math.min(...x.choices!.map(([c]) => Number(c))), Math.max(...x.choices!.map(([c]) => Number(c))), 0]);
        const [min, max, step] = lim(st);
        const stages = [this.stageVal('sensitivity1'), ...(s2 ? [this.stageVal('sensitivity2')] : [])];
        out.push(s('dpi', 'DPI', 'DPI', { kind: 'dpi', stages, active: 0, min, max, step: step || 50 }, 'Press the button under the wheel to switch between the two stages.'));
      } else if (k === 'sensitivity2') {
        continue;
      } else if (k === 'polling_rate') {
        const opts = uniqueChoices(st).map(([hz]) => [`${hz} Hz`, Number(hz)] as [string, number]);
        out.push(s('polling', 'Polling rate', 'Performance', { kind: 'choice', options: opts, current: Number(st.choices![this.choiceIdx(k)][0]) }));
      } else if (k === 'sleep_timer') {
        const [a, b, step] = st.input_range!;
        const opts: [string, number][] = [];
        for (let m = a; m <= b; m += step) opts.push([m === 0 ? 'Never' : `${m} min`, m]);
        out.push(s('sleep', 'Sleep after', 'Power', { kind: 'choice', options: opts, current: this.num(k) }));
      } else if (k === 'dim_timer') {
        const [a, b] = st.input_range!;
        out.push(s('dim', LABELS.dim_timer.label, 'Power', { kind: 'number', min: a, max: b, current: this.num(k), unit: 's' }, '0 = never'));
      } else if (k === 'buttons_mapping') {
        const acts = this.buttons();
        const names = Object.keys(st.buttons!);
        const opts = this.actionOptions(st);
        names.forEach((name, i) => out.push(s(`btn${i + 1}`, btnLabel(name), 'Buttons', { kind: 'choice', options: opts, current: acts[i] })));
      } else if (k === 'btn6_mode') {
        out.push(s(k, LABELS[k].label, 'Buttons', { kind: 'choice', options: uniqueChoices(st).map(([c]) => [c === 'os' ? 'Button 6 (set in your OS)' : 'DPI switch', st.choices!.findIndex(([x]) => x === c)]), current: this.choiceIdx(k) }));
      } else if (vt === 'choice') {
        const group = k === 'lift_off_distance' ? 'Performance' : 'Lighting';
        out.push(s('ss_' + k, labelOf(k, st), group, { kind: 'choice', options: uniqueChoices(st).map(([c]) => [pretty(c, k), st.choices!.findIndex(([x]) => x === c)]), current: this.choiceIdx(k) }));
      } else if (vt === 'range' || vt === 'range_choice') {
        const [a, b] = st.input_range!;
        const group = k === 'lift_off_distance' ? 'Performance' : 'Lighting';
        out.push(s('ss_' + k, labelOf(k, st), group, { kind: 'number', min: a, max: b, current: this.num(k), unit: k === 'led_brightness' && b === 100 ? '%' : '' }));
      } else if (vt === 'rgbcolor' || vt === 'rgbgradient' || vt === 'rgbgradientv2') {
        out.push(s('ss_' + k, labelOf(k, st), 'Lighting', { kind: 'color', rgb: this.color(k) }));
      } else if (vt === 'reactive_rgbcolor') {
        const r = this.val('reactive_color', () => ({ on: !/^(off|disable)?$/i.test(String(st.default ?? '')), rgb: parseColor(st.default) }));
        out.push(s('reactive_on', 'Reactive lighting (flash on click)', 'Lighting', { kind: 'toggle', on: r.on }));
        out.push(s('ss_reactive_color', LABELS.reactive_color.label, 'Lighting', { kind: 'color', rgb: r.rgb }));
      } else if (vt === 'none') {
        out.push(s('ss_' + k, labelOf(k, st), 'Lighting', { kind: 'toggle', on: this.val(k, () => false) }, 'On: rainbow lighting. Off: back to the colours above.'));
      }
    }
    return out;
  }

  private stageVal(k: string): number {
    const st = this.p.settings[k];
    if (st.value_type === 'choice') return Number(st.choices![this.choiceIdx(k)][0]);
    return this.num(k);
  }

  private actionOptions(st: SsSetting): [string, number][] {
    const names = Object.keys(st.buttons!);
    const opts: [string, number][] = names.map((n, i) => [btnLabel(n), ACT_BUTTON + i]);
    const has = (x: number | null | undefined) => x !== null && x !== undefined;
    if (has(st.button_disable)) opts.push(['Disabled', ACT_DISABLE]);
    if (has(st.button_dpi_switch)) opts.push(['DPI switch', ACT_DPI]);
    if (has(st.button_scroll_up) && !names.some((n) => n.toLowerCase() === 'scrollup')) opts.push(['Scroll up', ACT_SCROLL_UP]);
    if (has(st.button_scroll_down) && !names.some((n) => n.toLowerCase() === 'scrolldown')) opts.push(['Scroll down', ACT_SCROLL_DOWN]);
    if (has(st.button_multimedia)) for (const [l, c] of MEDIA) opts.push([l, ACT_MEDIA | c]);
    if (has(st.button_keyboard)) for (const c of KEYS) opts.push([`Key ${keyName(c)}`, ACT_KEY | c]);
    return opts;
  }

  /** set the value on the mouse, remember it, and save to the mouse's memory a moment later */
  private async set(k: string, data: number[], keep: unknown): Promise<void> {
    await this.send(this.p.settings[k], data);
    this.saved = { ...this.saved, [k]: keep };
    storeSaved(this.p, this.saved, this.demo);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.p.save) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1500);
  }

  /** rivalcfg's "save" command: write the current settings to the mouse's flash */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.p.save) return;
    this.dirty = false;
    await this.send(this.p.save);
  }

  async write(st: Setting): Promise<void> {
    const p = this.p;
    const v = st.value;
    if (st.key === 'dpi' && v.kind === 'dpi') {
      if (p.settings.sensitivity) {
        const sens = p.settings.sensitivity;
        const stages = v.stages.map((d) => Math.round(d));
        return this.set('sensitivity', encMultiDpi(sens, stages, v.active), { stages, active: v.active });
      }
      if (v.active !== 0) throw new Error('Press the button under the wheel to switch stages on this mouse.');
      const keys = ['sensitivity1', 'sensitivity2'].filter((k) => p.settings[k]);
      if (v.stages.length !== keys.length) throw new Error(`This mouse has ${keys.length} DPI stages.`);
      for (const [i, k] of keys.entries()) {
        const x = p.settings[k];
        if (v.stages[i] === this.stageVal(k)) continue;
        if (x.value_type === 'choice') {
          // nearest DPI the mouse offers
          let idx = 0;
          x.choices!.forEach(([c], j) => {
            if (Math.abs(Number(c) - v.stages[i]) < Math.abs(Number(x.choices![idx][0]) - v.stages[i])) idx = j;
          });
          await this.set(k, choiceBytes(x, idx), idx);
        } else {
          const raw = x.value_type === 'range' ? encRangeValue(x, v.stages[i]) : encRangeChoiceValue(x, v.stages[i]);
          await this.set(k, le(raw, x.range_length_byte ?? 1), v.stages[i]);
        }
      }
      return;
    }
    if (st.key === 'dpi_count' && v.kind === 'choice') {
      const sens = p.settings.sensitivity;
      if (!sens) throw new Error("can't change the number of stages");
      const d = this.dpiCfg();
      const def = parseDpis(sens.default);
      const stages = Array.from({ length: v.current }, (_, i) => d.stages[i] ?? def[i] ?? d.stages[d.stages.length - 1]);
      const active = Math.min(d.active, stages.length - 1);
      return this.set('sensitivity', encMultiDpi(sens, stages, active), { stages, active });
    }
    if (st.key === 'polling' && v.kind === 'choice') {
      const x = p.settings.polling_rate;
      const idx = x.choices!.findIndex(([hz]) => Number(hz) === v.current);
      if (idx < 0) throw new Error('unsupported polling rate');
      return this.set('polling_rate', choiceBytes(x, idx), idx);
    }
    if (st.key === 'sleep' && v.kind === 'choice') {
      const x = p.settings.sleep_timer;
      return this.set('sleep_timer', le(encRangeValue(x, v.current), x.range_length_byte ?? 1), v.current);
    }
    if (st.key === 'dim' && v.kind === 'number') {
      const x = p.settings.dim_timer;
      return this.set('dim_timer', le(encRangeValue(x, v.current), x.range_length_byte ?? 1), v.current);
    }
    const btn = /^btn(\d+)$/.exec(st.key);
    if (btn && v.kind === 'choice' && p.settings.buttons_mapping) {
      const x = p.settings.buttons_mapping;
      const acts = this.buttons().slice();
      const i = Number(btn[1]) - 1;
      if (i < 0 || i >= acts.length) throw new Error('unknown button');
      acts[i] = v.current;
      return this.set('buttons_mapping', encButtons(x, acts), acts);
    }
    if (st.key === 'btn6_mode' && v.kind === 'choice') {
      const x = p.settings.btn6_mode;
      if (!x.choices![v.current]) throw new Error('unknown mode');
      return this.set('btn6_mode', choiceBytes(x, v.current), v.current);
    }
    if (st.key === 'reactive_on' || st.key === 'ss_reactive_color') {
      const cur = this.val('reactive_color', () => ({ on: false, rgb: parseColor(p.settings.reactive_color.default) }));
      const next = st.key === 'reactive_on' && v.kind === 'toggle' ? { ...cur, on: v.on } : v.kind === 'color' ? { on: true, rgb: v.rgb & 0xffffff } : cur;
      return this.set('reactive_color', encReactive(next.on, next.rgb), next);
    }
    const k = st.key.replace(/^ss_/, '');
    const x = p.settings[k];
    if (!x || !st.key.startsWith('ss_')) throw new Error(`${st.key} can't be changed`);
    switch (x.value_type) {
      case 'choice':
        if (v.kind !== 'choice' || !x.choices![v.current]) break;
        return this.set(k, choiceBytes(x, v.current), v.current);
      case 'range':
      case 'range_choice': {
        if (v.kind !== 'number') break;
        const raw = x.value_type === 'range' ? encRangeValue(x, v.current) : encRangeChoiceValue(x, v.current);
        return this.set(k, le(raw, x.range_length_byte ?? 1), v.current);
      }
      case 'rgbcolor':
        if (v.kind !== 'color') break;
        return this.set(k, rgb3(v.rgb), v.rgb & 0xffffff);
      case 'rgbgradient':
        if (v.kind !== 'color') break;
        return this.set(k, encGradient(x, [{ pos: 0, color: v.rgb }]), v.rgb & 0xffffff);
      case 'rgbgradientv2':
        if (v.kind !== 'color') break;
        return this.set(k, encGradientV2(x, [{ pos: 0, color: v.rgb }]), v.rgb & 0xffffff);
      case 'none': {
        if (v.kind !== 'toggle') break;
        if (v.on) return this.set(k, [], true);
        // off: put the remembered colours back (a colour command clears the rainbow)
        this.saved = { ...this.saved, [k]: false };
        storeSaved(p, this.saved, this.demo);
        for (const [ck, cs] of Object.entries(p.settings)) {
          if (cs.value_type === 'rgbcolor') await this.set(ck, rgb3(this.color(ck)), this.color(ck));
          else if (cs.value_type === 'rgbgradient') await this.set(ck, encGradient(cs, [{ pos: 0, color: this.color(ck) }]), this.color(ck));
          else if (cs.value_type === 'rgbgradientv2') await this.set(ck, encGradientV2(cs, [{ pos: 0, color: this.color(ck) }]), this.color(ck));
        }
        return;
      }
    }
    throw new Error(`${st.key} can't be changed`);
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    this.device.removeEventListener('inputreport', this.onReport);
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

/** rivalcfg's two battery formats */
export function batteryOf(format: 'aerox' | 'rival', d: Uint8Array): { level: number; charging: boolean } | undefined {
  const level = format === 'aerox' ? ((d[1] & 0x7f) - 1) * 5 : d[0];
  const charging = format === 'aerox' ? (d[1] & 0x80) !== 0 : d[2] !== 0;
  if (level === undefined || isNaN(level) || level < 0 || level > 100) return undefined;
  return { level, charging };
}

const BY_PID = new Map<number, { p: SsProfile; name: string }>();
for (const p of SS_PROFILES) for (const m of p.models) BY_PID.set(m.pid, { p, name: m.name });
export const ssModel = (pid: number) => BY_PID.get(pid);

/**
 * rivalcfg picks the USB interface by number, which WebHID doesn't show. The settings interface is the one with a
 * vendor-defined collection (usage page 0xFF00+) that has output or feature reports.
 */
function settingsInterface(d: HIDDevice): boolean {
  return (d.collections ?? []).some((c) => (c.usagePage ?? 0) >= 0xff00 && ((c.outputReports ?? []).length > 0 || (c.featureReports ?? []).length > 0));
}

export const steelseriesFactory: DriverFactory = {
  name: 'SteelSeries',
  filters: [...BY_PID.keys()].map((productId) => ({ vendorId: SS_VID, productId })),
  match(d: HIDDevice): boolean {
    return d.vendorId === SS_VID && BY_PID.has(d.productId) && settingsInterface(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!steelseriesFactory.match(device)) return null;
    const m = BY_PID.get(device.productId)!;
    if (!device.opened) await device.open();
    return new SteelSeriesDriver(device, m.p, m.name);
  },
};
