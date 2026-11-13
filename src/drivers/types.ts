// Generic setting model shared by every driver. The UI renders any brand from this,
// so adding a brand never needs UI work. Mirrors the desktop app's drivers::Value.

export interface KeyCap {
  /** device-specific key index used in protocol packets */
  index: number;
  label: string;
  /** geometry in key units (1 = one 1u key), origin top-left */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Value =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; options: [label: string, value: number][]; current: number }
  | { kind: 'number'; min: number; max: number; current: number; unit: string }
  | { kind: 'float'; min: number; max: number; step: number; current: number; unit: string }
  | { kind: 'toggle'; on: boolean }
  | { kind: 'color'; rgb: number }
  | {
      kind: 'dpi';
      stages: number[];
      /** index into stages */
      active: number;
      min: number;
      max: number;
      step: number;
      /** optional LED colour per stage (0xRRGGBB) */
      colors?: number[];
    }
  | {
      kind: 'perKeyTrigger';
      keys: KeyCap[];
      travel: number[];
      rapid: boolean[];
      sens: number[];
      min: number;
      max: number;
      step: number;
      sensMin: number;
      sensMax: number;
    }
  | { kind: 'perKeyColor'; keys: KeyCap[]; colors: number[] }
  | {
      /** what every key sends, per layer. write() gets the whole map; drivers write only what changed */
      kind: 'keymap';
      keys: KeyCap[];
      /** per layer, per key (same order as keys): the keycode (16-bit QMK keycode for 'qmk-*') */
      layers: number[][];
      /** which keycode numbering `layers` uses (src/lib/keycodes.ts understands these) */
      codes: KeycodeSet;
      /**
       * optional, per layer: positions (in `keys`) the device won't let you change on that layer
       * (e.g. the Fn key, or Fn-layer system keys). The driver refuses changes to them.
       */
      locked?: number[][];
      /**
       * optional driver-specific keycodes outside the QMK numbering (e.g. gamepad buttons), as their own
       * picker categories. `hidden` categories only name codes the keymap may hold (never offered).
       */
      extra?: ExtraCategory[];
      /** optional: the QMK picker categories (keycodes.ts ids, e.g. 'basic', 'media') this device can send; default all */
      cats?: string[];
    }
  | {
      /**
       * The keyboard's macro slots. write() gets every slot; drivers rewrite what changed and
       * read it back. Slot n runs when a key sends that driver's "macro n" keycode.
       */
      kind: 'macros';
      /** slot count (= macros.length) */
      slots: number;
      /** storage all macros share, in bytes, if limited */
      maxBytes?: number;
      /** how macros are stored, for byte counting (src/lib/macros.ts knows these) */
      format?: MacroFormat;
      /** false when the device can't store delay steps */
      delays?: boolean;
      /** longest single delay step (ms) */
      maxDelay?: number;
      /** false when the device can't store text steps (mice: add keys instead) */
      text?: boolean;
      /** true when macros may press mouse buttons and scroll (mice) */
      mouse?: boolean;
      /** bytes one macro may use (macroSize), if each macro has its own limit */
      maxPerMacro?: number;
      /** labels for the slots (default M0, M1, ...) */
      slotNames?: string[];
      macros: MacroStep[][];
    }
  | Socd
  | AdvancedKeys;

/**
 * Advanced key functions of analog (magnetic / Hall-effect) keyboards. Generic: any brand with
 * DKS / Mod-Tap / Toggle keys can use it. write() gets the whole value; drivers rewrite the keys
 * whose entry changed (removed, added, or different) and read them back.
 *
 * - `entries`: at most one per key (`key` = position in `keys`). Keys without an entry are plain keys.
 * - Actions (`hold`, `tap`, `kc`, DKS `kc`) are basic HID keyboard usages, the same numbers as
 *   MacroStep.kc (0x04 A … 0xE7 right Win); 0 = nothing.
 * - `mt` (Mod-Tap): held longer than `delay` ms sends `hold`, a shorter tap sends `tap`.
 * - `tgl` (Toggle): a tap latches `kc` on / off; holding longer than `delay` ms works like a normal key.
 * - `dks` (Dynamic Keystroke): up to `dks.actions` keys, each with a bit mask of `dks.points` points
 *   along the stroke. Bit 2k is stage k (0 press start, 1 bottom out, 2 release from bottom,
 *   3 full release) and bit 2k+1 means "kept held from stage k to stage k+1". A key with mask 0 is unused.
 *
 * Example (A: tap A / hold Left Ctrl after 200 ms; D: DKS sending D through the stroke, then A on
 * release from bottom):
 *   { kind: 'advancedKeys', keys, modes: ['dks', 'mt', 'tgl'], mt: { min: 100, max: 1000, step: 10, default: 200 },
 *     tgl: { min: 200, max: 1000, step: 10, default: 200 }, dks: { actions: 4, points: 7 },
 *     entries: [ { key: posA, mode: 'mt', hold: 0xe0, tap: 0x04, delay: 200 },
 *                { key: posD, mode: 'dks', actions: [{ kc: 0x07, mask: 0x0f }, { kc: 0x04, mask: 0x10 }] } ] }
 */
/**
 * Live per-key lighting. The device has a grid of `rows` x `cols` LED cells; `frame()` sets every cell.
 * start() remembers the current lighting and switches to streaming; stop() puts the remembered lighting back.
 * `colorOrder`/`map` start unknown on untested boards and are filled in from a guided test.
 */
export interface LiveLight {
  rows: number;
  cols: number;
  /** cell (row * cols + col) -> layout key position, when known */
  map?: (number | undefined)[];
  /** true until a hardware test confirmed the grid and colour order */
  experimental: boolean;
  start(): Promise<void>;
  /** cells: rows*cols values, each the 3 bytes sent for that cell packed as 0xAABBCC (byte order as sent) */
  frame(cells: number[]): Promise<void>;
  stop(): Promise<void>;
  /** true between start() and stop() */
  readonly active: boolean;
}

export interface AdvancedKeys {
  kind: 'advancedKeys';
  /** the board picture; entry keys are positions in this array */
  keys: KeyCap[];
  /** the functions this device has */
  modes: AdvancedMode[];
  /** positions that can't get an advanced function (e.g. knob, keys in SOCD) */
  unavailable?: number[];
  /** Mod-Tap hold time (ms), when 'mt' is in modes */
  mt?: DelayRange;
  /** Toggle hold time (ms), when 'tgl' is in modes */
  tgl?: DelayRange;
  /** DKS layout, when 'dks' is in modes */
  dks?: { actions: number; points: number };
  entries: AdvancedKey[];
}

export type AdvancedMode = 'dks' | 'mt' | 'tgl';

export interface DelayRange {
  min: number;
  max: number;
  step: number;
  default: number;
}

export type AdvancedKey =
  | { key: number; mode: 'mt'; hold: number; tap: number; delay: number }
  | { key: number; mode: 'tgl'; kc: number; delay: number }
  | { key: number; mode: 'dks'; actions: { kc: number; mask: number }[] };

/**
 * SOCD / "Snap Tap": when two opposite keys (A/D) are held together, decide which one counts.
 * write() gets the whole value; drivers write only what changed and read it back.
 *
 * - `mode: 'pairs'`: every entry is two keys with its own resolution `mode` (one of `modes`).
 *   Order matters: keys[0] is "key 1", keys[1] is "key 2". At most `max` entries.
 * - `mode: 'groups'`: exactly `max` entries, entry i = group i (any number of keys, may be empty).
 *   Within a group only the last-pressed key counts; groups don't affect each other.
 *
 * A key may be in at most one entry.
 */
export interface Socd {
  kind: 'socd';
  mode: 'pairs' | 'groups';
  /** the keys entries refer to (the board picture); entry keys are positions in this array */
  keys: KeyCap[];
  /** master switch, for devices that have one */
  enabled?: boolean;
  /** pairs: most pairs the device stores; groups: number of groups */
  max: number;
  /** resolution modes [label, value]; a single entry means there's nothing to choose */
  modes: [label: string, value: number][];
  /** positions in `keys` that can't be used for SOCD (e.g. Fn, keys with another special function) */
  unavailable?: number[];
  /** false when keys can't be taken out of SOCD again on this device/firmware */
  removable?: boolean;
  /** per-entry actuation point (mm), for devices where each pair has its own */
  travel?: { min: number; max: number; step: number; default: number };
  /** true when each entry has its own Rapid Trigger switch */
  rapid?: boolean;
  entries: SocdEntry[];
}

export interface SocdEntry {
  /** positions in Socd.keys */
  keys: number[];
  /** one of Socd.modes' values */
  mode: number;
  /** actuation point (mm), when Socd.travel is set */
  travel?: number;
  /** Rapid Trigger on, when Socd.rapid is set */
  rapid?: boolean;
}

/**
 * One macro step. `kc` is a basic HID keyboard usage (0x04 A … 0xE7 right Win; same as the QMK
 * basic keycodes). Text is typed as US-layout ASCII. Mouse steps (mice only): `btn` is
 * 1 left, 2 right, 3 middle, 4 back, 5 forward; `dir` 1 scrolls up, -1 down.
 */
export type MacroStep =
  | { t: 'tap' | 'down' | 'up'; kc: number }
  | { t: 'mouse'; a: 'tap' | 'down' | 'up'; btn: number }
  | { t: 'wheel'; dir: 1 | -1 }
  | { t: 'delay'; ms: number }
  | { t: 'text'; text: string };

/**
 * Macro storage formats: QMK dynamic macros with (VIA protocol 11+) and without delays;
 * WLMouse / CompX-A event records (page 0x04); Pulsar / CompX-B 5-byte event records (0x300);
 * DAREU TG firmware event records (class 6 macro memory).
 */
export type MacroFormat = 'qmk' | 'qmk-legacy' | 'wlmouse' | 'pulsar' | 'dareu';

/** A driver-specific keycode (see the keymap value's `extra`). */
export interface ExtraKeycode {
  code: number;
  /** name accepted by the picker search, e.g. GP_XBOX_A */
  id: string;
  /** short keycap legend */
  label: string;
  /** what it does */
  name: string;
}

export interface ExtraCategory {
  id: string;
  name: string;
  codes: ExtraKeycode[];
  /** names only: not shown in the picker */
  hidden?: boolean;
}

/** Keycode numberings: QMK keycodes v2 (QMK 0.19+, VIA protocol 12+) and the older v1. */
/** QMK keycode numbering: v1 = VIA protocol <= 10, v11 = protocol 11 (v2 layout, macros at 0x7702), v2 = protocol 12+ */
export type KeycodeSet = 'qmk-v2' | 'qmk-v11' | 'qmk-v1';

export interface Setting {
  /** stable id used by write() */
  key: string;
  label: string;
  /** settings are grouped into tabs by this name; "Info" text settings feed the header/live readout */
  group: string;
  value: Value;
  /** optional one-line help shown next to the control */
  hint?: string;
}

export type DeviceKind = 'mouse' | 'keyboard';

/** One picture for a device screen, already encoded for it. */
export interface ScreenImage {
  data: Uint8Array;
  width: number;
  height: number;
  kind: 'still' | 'gif';
}

/** A device with its own small screen (e.g. the WLMouse HUAN 8K receiver). */
export interface ScreenSupport {
  width: number;
  height: number;
  /** round screens show the square picture cropped to a circle */
  round: boolean;
  slots: number;
  /** total bytes all pictures may use together */
  maxBytes: number;
  /** GIFs must have exactly this size, if GIFs are supported */
  gifSize?: number;
  /** Replace every stored picture with these (first = main picture). */
  upload(images: ScreenImage[], onProgress?: (done: number, total: number) => void): Promise<void>;
  /** Remove every stored picture. */
  clear(): Promise<void>;
}

export interface Driver {
  /** stable id for this physical device (e.g. "36a7:a863") */
  readonly id: string;
  readonly family: string;
  readonly kind: DeviceKind;
  /** brand shown small above the model, e.g. "WLMOUSE" */
  brand(): string;
  /** model name, e.g. "HUAN M" (may improve after the first read) */
  model(): string;
  /** official product photo URL if known */
  image(): string | undefined;
  /** keyboards: the board's keys, for drivers whose settings don't already carry them (picture only) */
  layout?(): KeyCap[];
  /** keyboards: position of a rotary knob in key units, if the board has one */
  readonly knob?: { x: number; y: number };
  /**
   * false for drivers nobody has checked on real hardware yet. The app shows them read-only
   * (settings visible, no writes) until the user turns on "Allow changes" for that device.
   */
  readonly verified?: boolean;
  /** set when the device (or its receiver) has a screen you can put pictures on */
  readonly screen?: ScreenSupport;
  /** keyboards with analog switches: stream live key travel (mm) until the returned stop() runs */
  travelTest?(onSample: (pos: number, mm: number) => void): Promise<() => Promise<void>>;
  /**
   * Read-only probe for features we can't confirm without the hardware (e.g. undocumented lighting
   * commands). MUST only send requests that read; never anything that changes the device.
   * Returns a plain-text report the user copies and sends to the developer.
   */
  diagnose?(onProgress?: (done: number, total: number) => void): Promise<string>;
  /**
   * Live per-key lighting streamed from the page (not stored on the device; gone when the page stops or the
   * device is unplugged). Only for firmware with a streaming effect, e.g. DAREU TG boards (effect 18 + FRAME).
   */
  readonly liveLight?: LiveLight;
  read(): Promise<Setting[]>;
  write(s: Setting): Promise<void>;
  close(): Promise<void>;
}

export interface DriverFactory {
  name: string;
  /** filters passed to navigator.hid.requestDevice */
  filters: HIDDeviceFilter[];
  /** does this HIDDevice (one interface) belong to us? Must not do I/O. */
  match(device: HIDDevice): boolean;
  /** open + identify; return null if it turns out not to be ours */
  create(device: HIDDevice): Promise<Driver | null>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
