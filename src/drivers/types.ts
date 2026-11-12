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
  | Socd;

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
 * WLMouse / CompX-A event records (page 0x04); Pulsar / CompX-B 5-byte event records (0x300).
 */
export type MacroFormat = 'qmk' | 'qmk-legacy' | 'wlmouse' | 'pulsar';

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
