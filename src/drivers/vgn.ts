// VGN FLASH68 / FLASH68+ ("arbit" driver in the VGN hub, class `mo` in vgn/index-CXdtZKh9.js).
// Our own code, written from reading the hub as text. Nobody has run it on real hardware:
// verified = false, so the app keeps it read-only until "Allow changes".
//
// Supported: identification (firmware version, active profile), the GAMEPAD block (mode, flags,
// angle) and gamepad keys in the base layer of the active profile. Actuation / Rapid Trigger,
// polling (the "func" block, cmd 5/6) and full key remapping are not decoded here.
//
// Device filter (hub): {vendorId:14621, productId:8199|8209|8201, usagePage:1, usage:0,
//   customDeviceType:"arbit", productName:"VGN FLASH68"/"VGN FLASH68+", reportId:0}
//
// Frame (hub sendFormattedReport), report id 0, 64 bytes:
//   i[0]=85, i[1]=A (cmd), i[2]=0, i[4]=t.length, i[5]=255&e, i[6]=e>>8&255, i[7]=0, i.set(t,8);
//   let a=0; for(let o=4;o<64;o++) a=a+i[o]&255; i[3]=a
//   -> 55 cmd 00 sum(bytes 4..63) len offLo offHi 00 data(<=56)
// Reply (initInputReportListener / sendCmdWithWait): e[0]=170 (0xAA), e[1]=cmd, len at [4], data at [8].
//
// Commands used (hub enum `On`): GetInfo=3, GetBase=4, GetUseKeyMatrix=8, SetUseKeyMatrix=9,
// and the joystick block: getJoystick sendCmdWithWait(16,...) / setJoystick sendCmdWithWait(17,...).
// Refused before reaching the device: everything else, notably FactoryReset=238, Start/EndCalibration
// 168/169, SetFunc=6, SetProfile=14, macros, lighting.
import type { Driver, DriverFactory, Setting, Value } from './types';
import { VGN_GAMEPAD_TAG, VGN_GAMEPAD_TAIL, VGN_GAMEPAD_TARGETS, isVgnGamepadEntry } from '../lib/gamepad-keys-vgn';

export const VID = 0x391d;
export const REPORT_ID = 0;
export const PACKET = 64;
export const MAX_DATA = 56;

export const MODELS: ReadonlyMap<number, string> = new Map([
  [0x2007, 'FLASH68'],
  [0x2011, 'FLASH68'],
  [0x2009, 'FLASH68+'],
]);

export const CMD = {
  getInfo: 0x03,
  getBase: 0x04,
  getKeys: 0x08,
  setKeys: 0x09,
  getGamepad: 0x10,
  setGamepad: 0x11,
} as const;

/** GetUseKeyMatrix: offset = profile*kbProfileBaseIndex(2048) + layer*512 + byte; 3 bytes per key index. */
export const PROFILE_STRIDE = 2048;
export const LAYER_BYTES = 512;
/** SetUseKeyMatrix writes 128 keys * 3 = 384 bytes ("s=new Uint8Array(384) ... for(let A=0;A<384;A+=56)") */
export const KEY_BYTES = 384;
export const PROFILES = 4;

/** Joystick block (hub parseJoystickData / setJoystick). */
export const GP = { magic0: 0, magic1: 1, mode: 2, flags: 4, angle: 8, len: 64 } as const;
/** flag bits: enableKeyboard 1, enableCover 2, enableAngleAdj 4, enableSquareGate 8, enableExtremePriority 16 */
export const GP_FLAG = { keyboard: 0x01, override: 0x02, angleAdj: 0x04, square: 0x08, extreme: 0x10 } as const;
const GP_FLAG_MASK = 0x1f;
/** deviceMode: 0 off, 1 "classicGamepad" (the only handleList entry); setEnableHandel(A) writes A?1:0 */
export const GP_MODES: [string, number][] = [
  ['Off', 0],
  ['Classic gamepad', 1],
];
export const ANGLE_MAX = 90;

/**
 * Key index -> name and factory value, from the hub's key table `Gn`
 * ({index:0,name:"M",value:[16,0,16]}, ...). [16, modifier bits, HID usage] is a plain key.
 * Index 43 is the Fn key ([240,255,1]) and 68 a special [240,33,0] entry: neither may become a gamepad key.
 */
export const KEYS: readonly [index: number, name: string, def: [number, number, number]][] = [
  [0, 'M', [16, 0, 16]], [1, 'F', [16, 0, 9]], [2, 'N', [16, 0, 17]], [3, 'Left Alt', [16, 4, 0]],
  [4, 'B', [16, 0, 5]], [5, 'Left Win', [16, 8, 0]], [6, 'Space', [16, 0, 44]], [7, 'Left Ctrl', [16, 1, 0]],
  [8, 'V', [16, 0, 25]], [9, 'Z', [16, 0, 29]], [10, 'C', [16, 0, 6]], [11, 'Left Shift', [16, 2, 0]],
  [12, 'X', [16, 0, 27]], [13, 'Caps Lock', [16, 0, 57]], [14, 'J', [16, 0, 13]], [15, 'H', [16, 0, 11]],
  [16, 'Q', [16, 0, 20]], [17, '3', [16, 0, 32]], [18, 'Tab', [16, 0, 43]], [19, '4', [16, 0, 33]],
  [20, '1', [16, 0, 30]], [21, '5', [16, 0, 34]], [22, 'Esc', [16, 0, 41]], [23, '6', [16, 0, 35]],
  [24, '2', [16, 0, 31]], [25, '7', [16, 0, 36]], [26, 'E', [16, 0, 8]], [27, 'Y', [16, 0, 28]],
  [28, 'R', [16, 0, 21]], [29, 'T', [16, 0, 23]], [30, 'U', [16, 0, 24]], [31, 'G', [16, 0, 10]],
  [32, 'Page Down', [16, 0, 78]], [33, 'K', [16, 0, 14]], [34, 'Enter', [16, 0, 40]], [35, 'Right', [16, 0, 79]],
  [36, 'Up', [16, 0, 82]], [37, 'Down', [16, 0, 81]], [38, 'Right Shift', [16, 32, 0]], [39, 'Left', [16, 0, 80]],
  [40, '/', [16, 0, 56]], [41, 'Right Ctrl', [16, 16, 0]], [42, '.', [16, 0, 55]], [44, ',', [16, 0, 54]],
  [45, 'Right Alt', [16, 64, 0]], [47, ';', [16, 0, 51]], [48, '[', [16, 0, 47]], [49, '0', [16, 0, 39]],
  [50, ']', [16, 0, 48]], [51, '-', [16, 0, 45]], [52, '\\', [16, 0, 49]], [53, '=', [16, 0, 46]],
  [54, 'Page Up', [16, 0, 75]], [55, 'Backspace', [16, 0, 42]], [56, 'I', [16, 0, 12]], [57, 'Delete', [16, 0, 76]],
  [58, '8', [16, 0, 37]], [59, 'P', [16, 0, 19]], [60, '9', [16, 0, 38]], [61, 'O', [16, 0, 18]],
  [63, 'L', [16, 0, 15]], [64, 'A', [16, 0, 4]], [65, 'S', [16, 0, 22]], [66, 'W', [16, 0, 26]], [67, 'D', [16, 0, 7]],
];
const KEY_DEFAULT = new Map(KEYS.map(([i, , d]) => [i, d]));
export const UNBOUND = 255;

// ---------------------------------------------------------------- framing

/** sum of bytes 4..63, & 0xFF (hub: for(let o=4;o<64;o++) a=a+i[o]&255) */
export function checksum(p: ArrayLike<number>): number {
  let a = 0;
  for (let o = 4; o < PACKET; o++) a = (a + (p[o] ?? 0)) & 0xff;
  return a;
}

export function frame(cmd: number, offset = 0, data: ArrayLike<number> = []): Uint8Array<ArrayBuffer> {
  if (data.length > MAX_DATA) throw new Error('payload too long');
  const p = new Uint8Array(PACKET);
  p[0] = 0x55;
  p[1] = cmd;
  p[4] = data.length;
  p[5] = offset & 0xff;
  p[6] = (offset >> 8) & 0xff;
  for (let i = 0; i < data.length; i++) p[8 + i] = data[i] & 0xff;
  p[3] = checksum(p);
  return p;
}

const zeros = (p: Uint8Array, len: number) => p.subarray(8, 8 + len).every((b) => b === 0);

/**
 * Allowlist: true only for frames this driver is meant to send, with the exact chunking the hub uses.
 * Reads carry zero payloads (the hub sends new Uint8Array(n)); writes are checked byte by byte.
 */
export function allowed(p: ArrayLike<number>): boolean {
  if (p.length !== PACKET || p[0] !== 0x55 || p[2] !== 0 || p[7] !== 0 || p[3] !== checksum(p)) return false;
  const b = Uint8Array.from(p as ArrayLike<number>);
  const cmd = b[1];
  const len = b[4];
  const off = b[5] | (b[6] << 8);
  if (len > MAX_DATA || !b.subarray(8 + len).every((x) => x === 0)) return false;
  const prof = Math.floor(off / PROFILE_STRIDE);
  const rel = off % PROFILE_STRIDE;
  switch (cmd) {
    case CMD.getInfo:
    case CMD.getBase:
      return off === 0 && len === 32 && zeros(b, len);
    case CMD.getKeys:
      // layer 0 only: offsets 0..504 step 56, last chunk 8 bytes
      return prof < PROFILES && rel < LAYER_BYTES && rel % MAX_DATA === 0 && len === Math.min(MAX_DATA, LAYER_BYTES - rel) && zeros(b, len);
    case CMD.setKeys:
      // base layer only, first 384 bytes; entry contents are checked by the driver (entryAllowed)
      return prof < PROFILES && rel < KEY_BYTES && rel % MAX_DATA === 0 && len === Math.min(MAX_DATA, KEY_BYTES - rel);
    case CMD.getGamepad:
      return ((off === 0 && len === 56) || (off === 56 && len === 8)) && zeros(b, len);
    case CMD.setGamepad:
      if (off === 56) return len === 8;
      return (
        off === 0 &&
        len === 56 &&
        b[8 + GP.magic0] === 0xaa &&
        b[8 + GP.magic1] === 0xbb &&
        GP_MODES.some(([, v]) => v === b[8 + GP.mode]) &&
        (b[8 + GP.flags] & ~GP_FLAG_MASK) === 0 &&
        b[8 + GP.angle] <= ANGLE_MAX
      );
    default:
      return false;
  }
}

/** Entries a keymap write may put on a key: its factory value, or a known gamepad target. */
export function entryAllowed(keyIndex: number, e: ArrayLike<number>): boolean {
  const d = KEY_DEFAULT.get(keyIndex);
  if (!d) return false;
  return isVgnGamepadEntry(e) || (e[0] === d[0] && e[1] === d[1] && e[2] === d[2]);
}

// ---------------------------------------------------------------- link

class Link {
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: { cmd: number; resolve: (b: Uint8Array) => void } | null = null;

  constructor(
    private readonly dev: HIDDevice,
    private readonly timeoutMs: number,
  ) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach() {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
    const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    if (this.waiter && b[0] === 0xaa && b[1] === this.waiter.cmd) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(b);
    }
  };

  /** One request at a time; returns the reply's data (len at [4], data at [8]). */
  xfer(cmd: number, offset = 0, data: ArrayLike<number> = []): Promise<Uint8Array> {
    const f = frame(cmd, offset, data);
    if (!allowed(f)) return Promise.reject(new Error(`command 0x${cmd.toString(16)} @${offset} is blocked`));
    const run = async () => {
      const got = new Promise<Uint8Array | null>((resolve) => {
        const w = { cmd, resolve: (b: Uint8Array) => resolve(b) };
        this.waiter = w;
        setTimeout(() => {
          if (this.waiter === w) {
            this.waiter = null;
            resolve(null);
          }
        }, this.timeoutMs);
      });
      if (!this.dev.opened) await this.dev.open();
      await this.dev.sendReport(REPORT_ID, f);
      const r = await got;
      if (!r) throw new Error('no answer from the keyboard');
      const n = Math.min(r[4], r.length - 8);
      return r.slice(8, 8 + n);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface VgnOptions {
  timeoutMs?: number;
}

const text = (key: string, label: string, t: string): Setting => ({ key, label, group: 'Info', value: { kind: 'text', text: t } });
const G = 'Gamepad';

export class VgnDriver implements Driver {
  readonly id: string;
  readonly family = 'VGN (FLASH68)';
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  private readonly link: Link;
  private readonly name: string;
  private profile = 0;
  private gp: Uint8Array | null = null;
  private keys: Uint8Array | null = null;
  /** set after a mode change: the keyboard restarts and has to be reconnected */
  private restarting = false;

  constructor(
    private readonly device: HIDDevice,
    o: VgnOptions = {},
  ) {
    this.id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;
    this.name = MODELS.get(device.productId) ?? 'FLASH68';
    this.link = new Link(device, o.timeoutMs ?? 1000);
  }

  brand() {
    return 'VGN';
  }
  model() {
    return this.name;
  }
  image() {
    return undefined;
  }

  /** hub getVersion: t=A[0], i=A[1]; appVersion = `${i.toString(16)}${t.toString(16).padStart(2,"0")}` */
  private async version(): Promise<string> {
    const d = await this.link.xfer(CMD.getInfo, 0, new Uint8Array(32));
    if (d.length < 2) throw new Error('short version reply');
    return `${d[1].toString(16)}${d[0].toString(16).padStart(2, '0')}`;
  }

  /** hub GetBase: profile=t[0] */
  private async readProfile(): Promise<number> {
    const d = await this.link.xfer(CMD.getBase, 0, new Uint8Array(32));
    const p = d[0] ?? 0;
    if (p >= PROFILES) throw new Error(`unexpected profile ${p}`);
    return p;
  }

  /** hub getJoystick: for(e=0;e<64;e+=56) sendCmdWithWait(16,e,new Uint8Array(min(56,64-e))); A.set(a.subarray(8,8+a[4]),e) */
  private async readGamepad(): Promise<Uint8Array> {
    const b = new Uint8Array(GP.len);
    for (let off = 0; off < GP.len; off += MAX_DATA) {
      const n = Math.min(MAX_DATA, GP.len - off);
      const d = await this.link.xfer(CMD.getGamepad, off, new Uint8Array(n));
      b.set(d.subarray(0, n), off);
    }
    return b;
  }

  /** hub setJoystick: for(A=0;A<64;A+=56) sendCmdWithWait(17,A,joystickBuff.subarray(A,A+min(56,64-A))) */
  private async writeGamepad(b: Uint8Array, expectRestart: boolean): Promise<void> {
    for (let off = 0; off < GP.len; off += MAX_DATA) {
      const chunk = b.subarray(off, off + Math.min(MAX_DATA, GP.len - off));
      try {
        await this.link.xfer(CMD.setGamepad, off, chunk);
      } catch (e) {
        // the keyboard may drop off the bus as soon as the mode byte lands (hub tip3: "your device
        // must restart ... Please reconnect your device"), so a missing answer is expected here
        if (expectRestart) return;
        throw e;
      }
    }
  }

  /** hub GetUseKeyMatrix, layer 0 (fn1) of the active profile: 512 bytes in 56-byte chunks */
  private async readKeys(): Promise<Uint8Array> {
    const b = new Uint8Array(LAYER_BYTES);
    const base = this.profile * PROFILE_STRIDE;
    for (let a = 0; a < LAYER_BYTES; a += MAX_DATA) {
      const n = Math.min(MAX_DATA, LAYER_BYTES - a);
      const d = await this.link.xfer(CMD.getKeys, base + a, new Uint8Array(n));
      b.set(d.subarray(0, n), a);
    }
    return b;
  }

  /** hub setKeyMatrix: for(A=0;A<384;A+=56) sendCmdWithWait(On.SetUseKeyMatrix, e+512*t+A, s.slice(A,A+56)) */
  private async writeKeys(b: Uint8Array): Promise<void> {
    const base = this.profile * PROFILE_STRIDE;
    for (let a = 0; a < KEY_BYTES; a += MAX_DATA) await this.link.xfer(CMD.setKeys, base + a, b.subarray(a, Math.min(KEY_BYTES, a + MAX_DATA)));
  }

  private entry(keys: Uint8Array, i: number) {
    return keys.subarray(3 * i, 3 * i + 3);
  }

  private bindings(keys: Uint8Array): Map<number, number> {
    const m = new Map<number, number>();
    for (const [i] of KEYS) {
      const e = this.entry(keys, i);
      if (isVgnGamepadEntry(e) && !m.has(e[1])) m.set(e[1], i);
    }
    return m;
  }

  async read(): Promise<Setting[]> {
    if (this.restarting) throw new Error('the keyboard is restarting after the gamepad mode change - unplug it, plug it back in and connect it again');
    const out: Setting[] = [text('model', 'Model', `VGN ${this.name}`)];
    out.push(text('firmware', 'Firmware', await this.version().catch(() => '?')));
    this.profile = await this.readProfile();
    out.push(text('profile', 'Profile', String(this.profile + 1)));

    const gp = (this.gp = await this.readGamepad());
    const mode = gp[GP.mode];
    const modes: [string, number][] = GP_MODES.some(([, v]) => v === mode) ? GP_MODES : [...GP_MODES, [`Unknown (${mode})`, mode]];
    out.push({
      key: 'gp.mode',
      label: 'Gamepad mode',
      group: G,
      value: { kind: 'choice', options: modes, current: mode },
      hint: 'Changing it restarts the keyboard; reconnect it afterwards',
    });
    const flag = (key: keyof typeof GP_FLAG, label: string, hint?: string): Setting => ({
      key: `gp.${key}`,
      label,
      group: G,
      value: { kind: 'toggle', on: (gp[GP.flags] & GP_FLAG[key]) !== 0 },
      ...(hint ? { hint } : {}),
    });
    out.push(flag('keyboard', 'Keyboard keys still type', 'Keys without a gamepad mapping keep working as a keyboard'));
    out.push(flag('override', 'Gamepad keys only', 'Keys mapped to the gamepad stop sending their keyboard key'));
    out.push(flag('angleAdj', 'Angle adjust'));
    out.push({ key: 'gp.angle', label: 'Diagonal angle', group: G, value: { kind: 'number', min: 0, max: ANGLE_MAX, current: Math.min(gp[GP.angle], ANGLE_MAX), unit: 'Â°' } });
    out.push(flag('square', 'Square gate'));
    out.push(flag('extreme', 'Extreme priority', 'The stronger of two opposite directions wins'));

    const keys = (this.keys = await this.readKeys());
    const bound = this.bindings(keys);
    const options: [string, number][] = [['Not mapped', UNBOUND], ...KEYS.map(([i, n]) => [n, i] as [string, number])];
    for (const t of VGN_GAMEPAD_TARGETS) {
      out.push({ key: `gp.bind.${t.id}`, label: t.name, group: G, value: { kind: 'choice', options, current: bound.get(t.id) ?? UNBOUND } });
    }
    return out;
  }

  async write(st: Setting): Promise<void> {
    if (this.restarting) throw new Error('reconnect the keyboard first');
    const v: Value = st.value;
    const bad = () => new Error('bad value');
    if (st.key.startsWith('gp.bind.')) return this.writeBinding(Number(st.key.slice(8)), v);
    if (!this.gp) throw new Error('press Re-read first');
    const b = this.gp.slice();
    if (b[GP.magic0] !== 0xaa || b[GP.magic1] !== 0xbb) {
      // hub: if no buffer yet, joystickBuff[0]=170, [1]=187
      b[GP.magic0] = 0xaa;
      b[GP.magic1] = 0xbb;
    }
    let restart = false;
    if (st.key === 'gp.mode') {
      if (v.kind !== 'choice' || !GP_MODES.some(([, m]) => m === v.current)) throw bad();
      if (v.current === b[GP.mode]) return;
      b[GP.mode] = v.current;
      restart = true;
    } else if (st.key === 'gp.angle') {
      if (v.kind !== 'number' || !Number.isInteger(v.current) || v.current < 0 || v.current > ANGLE_MAX) throw bad();
      b[GP.angle] = v.current;
    } else {
      const k = st.key.slice(3) as keyof typeof GP_FLAG;
      if (!st.key.startsWith('gp.') || !(k in GP_FLAG) || v.kind !== 'toggle') throw new Error(`unknown setting ${st.key}`);
      b[GP.flags] = (b[GP.flags] & ~GP_FLAG[k]) | (v.on ? GP_FLAG[k] : 0);
    }
    b[GP.flags] &= GP_FLAG_MASK;
    if (restart) {
      this.restarting = true;
      await this.writeGamepad(b, true);
      this.gp = b;
      return;
    }
    await this.writeGamepad(b, false);
    const got = await this.readGamepad();
    this.gp = got;
    if (got[GP.mode] !== b[GP.mode] || got[GP.flags] !== b[GP.flags] || got[GP.angle] !== b[GP.angle]) throw new Error("the keyboard didn't keep the gamepad setting");
  }

  private async writeBinding(id: number, v: Value): Promise<void> {
    if (!VGN_GAMEPAD_TARGETS.some((t) => t.id === id)) throw new Error(`unknown gamepad target ${id}`);
    if (v.kind !== 'choice') throw new Error('bad value');
    if (!this.keys) throw new Error('press Re-read first');
    const want = v.current;
    if (want !== UNBOUND && !KEY_DEFAULT.has(want)) throw new Error(`key ${want} can't be a gamepad key`);
    const b = this.keys.slice();
    // take the target off every key that has it now (back to the key's factory value)
    for (const [i, , d] of KEYS) {
      const e = this.entry(b, i);
      if (isVgnGamepadEntry(e) && e[1] === id && i !== want) e.set(d);
    }
    if (want !== UNBOUND) this.entry(b, want).set([VGN_GAMEPAD_TAG, id, VGN_GAMEPAD_TAIL]);
    // only factory values or gamepad entries may change
    for (let i = 0; i < KEY_BYTES / 3; i++) {
      const before = this.entry(this.keys, i);
      const after = this.entry(b, i);
      if (before.every((x, j) => x === after[j])) continue;
      if (!entryAllowed(i, after)) throw new Error(`refusing to change key ${i}`);
    }
    if (b.every((x, i) => x === this.keys![i])) return;
    await this.writeKeys(b);
    const got = await this.readKeys();
    this.keys = got;
    for (let i = 0; i < KEY_BYTES; i++) if (got[i] !== b[i]) throw new Error("the keyboard didn't keep the gamepad key");
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factory

/** hub filter: usagePage 1, usage 0 */
const hasConfig = (d: HIDDevice) => (d.collections ?? []).some((c) => c.usagePage === 0x0001 && c.usage === 0);

export const vgnFactory: DriverFactory = {
  name: 'VGN FLASH68',
  filters: [...MODELS.keys()].map((productId) => ({ vendorId: VID, productId, usagePage: 0x0001, usage: 0 })),
  match(d: HIDDevice): boolean {
    return d.vendorId === VID && MODELS.has(d.productId) && hasConfig(d);
  },
  async create(device: HIDDevice): Promise<Driver | null> {
    if (!vgnFactory.match(device)) return null;
    if (!device.opened) await device.open();
    return new VgnDriver(device);
  },
};
