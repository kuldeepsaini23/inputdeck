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
    };

/** Keycode numberings: QMK keycodes v2 (QMK 0.19+, VIA protocol 12+) and the older v1. */
export type KeycodeSet = 'qmk-v2' | 'qmk-v1';

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
