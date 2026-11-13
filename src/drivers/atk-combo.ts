// ATK (BitYuan) HE keyboards speak two protocols on the same raw-HID interface: plain VIA (keymap,
// macros, lighting) and ATK's own 0x96 commands (gamepad). This driver shows both: everything VIA
// knows about the board, plus the gamepad settings from atk-kb.ts. Calls are serialised here so the
// two links never have requests in flight at the same time.
import type { Driver, KeyCap, Setting } from './types';

const isGamepad = (key: string) => key.startsWith('gp_');

export class AtkCombo implements Driver {
  readonly kind = 'keyboard' as const;
  readonly verified = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly atk: Driver,
    private readonly via: Driver,
  ) {}

  get id() { return this.atk.id; }
  get family() { return this.atk.family; }
  get knob() { return this.via.knob ?? this.atk.knob; }
  brand() { return this.atk.brand(); }
  model() { return this.atk.model(); }
  image() { return this.atk.image() ?? this.via.image(); }
  layout(): KeyCap[] {
    // VIA's layout comes from the board's own definition when there is one; ATK's is a plain grid
    const v = this.via.layout?.() ?? [];
    return v.length ? v : this.atk.layout?.() ?? [];
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  read(): Promise<Setting[]> {
    return this.run(async () => {
      const v = await this.via.read();
      const a = await this.atk.read();
      const keys = new Set(v.map((s) => s.key));
      // gamepad from ATK; everything else from VIA (ATK's own fw/model text only if VIA lacks it)
      return [...v, ...a.filter((s) => isGamepad(s.key) || (!keys.has(s.key) && s.group === 'Info'))];
    });
  }

  write(s: Setting): Promise<void> {
    return this.run(() => (isGamepad(s.key) ? this.atk.write(s) : this.via.write(s)));
  }

  async close(): Promise<void> {
    await this.run(async () => {
      await this.via.close().catch(() => undefined);
      await this.atk.close();
    });
  }
}
