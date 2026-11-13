// Device manager: finds granted WebHID devices, matches them to drivers, and keeps
// per-device read / edit state. One physical device can expose several HID
// interfaces; we keep one driver per vendor:product pair.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Driver, DriverFactory, Setting } from './drivers/types';
import { wlmouseFactory } from './drivers/wlmouse';
import { wraithFactory } from './drivers/wraith';
import { compxbFactory, pulsarFactory } from './drivers/pulsar';
import { logitechFactory } from './drivers/logitech';
import { razerFactory } from './drivers/razer';
import { orbitalFactory } from './drivers/orbital';
import { dareuFactory } from './drivers/dareu';
import { lofreeFactory } from './drivers/lofree';
import { atkKbFactory } from './drivers/atk-kb';
import { viaFactory } from './drivers/via';
import { vgnFactory } from './drivers/vgn';

const ALLOW_KEY = 'inputdeck.allowChanges';

// VIA last: it matches any raw-HID keyboard the brand drivers above don't claim
export const FACTORIES: DriverFactory[] = [wlmouseFactory, wraithFactory, pulsarFactory, compxbFactory, logitechFactory, razerFactory, orbitalFactory, dareuFactory, lofreeFactory, vgnFactory, atkKbFactory, viaFactory];

export interface DeviceState {
  id: string;
  driver: Driver;
  read?: Setting[];
  edit?: Setting[];
  busy: boolean;
  /** live changes are being written to the device */
  saving?: boolean;
  error?: string;
  savedAt?: number;
}

/** How long a control must be still before its change is written (sliders, typed numbers). */
export const LIVE_DELAY_MS = 350;

/** Away from the tab/window at least this long and the devices are read again on return. */
export const AWAY_MS = 2000;

const DEMO_KEY = 'inputdeck.demo';

/** Demo mode: open the app with ?demo once to use simulated devices for this browser tab; ?demo=0 or exitDemo() ends it. */
export function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get('demo');
    if (q === '0') sessionStorage.removeItem(DEMO_KEY);
    else if (q !== null) sessionStorage.setItem(DEMO_KEY, '1');
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

/** Leave demo mode and reload with the real devices. */
export function exitDemo(): void {
  try {
    sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* storage unavailable: ?demo=0 below still ends it */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('demo', '0');
  window.location.replace(url.toString());
}

export const webHidSupported = typeof navigator !== 'undefined' && ('hid' in navigator || isDemo());

async function grantedDevices(): Promise<HIDDevice[]> {
  if (isDemo()) return (await import('./drivers/fakes/demo')).demoDevices();
  return navigator.hid.getDevices();
}

const devId = (d: HIDDevice) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;

/** What an interface looks like: two units of the same model have identical ones, two interfaces of one unit don't. */
const shape = (d: HIDDevice) =>
  JSON.stringify(
    (d.collections ?? []).map((c) => [
      c.usagePage,
      c.usage,
      (c.inputReports ?? []).map((r) => r.reportId),
      (c.outputReports ?? []).map((r) => r.reportId),
      (c.featureReports ?? []).map((r) => r.reportId),
    ]),
  );

/**
 * The id to use for an unclaimed interface, or null when it is just another interface of a device we already drive.
 * The first unit of a model is "vvvv:pppp"; more identical units plugged in at once get "vvvv:pppp~2", "~3", ...
 * `claimed` maps each interface we drive to its id (only interfaces that are still connected).
 */
export function unitIdFor(hd: HIDDevice, claimed: ReadonlyMap<HIDDevice, string>): string | null {
  const base = devId(hd);
  const sameModel = [...claimed].filter(([c]) => devId(c) === base);
  // same model but a different interface: part of a unit we already have
  if (sameModel.length && !sameModel.some(([c]) => shape(c) === shape(hd))) return null;
  const used = new Set(claimed.values());
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}~${n}`)) return `${base}~${n}`;
}

/** "36a7:a863~2" -> 2; the first unit is 1. */
export const unitNumber = (id: string) => Number(id.split('~')[1] ?? 1);

/**
 * New settings read from a device. Changes the user made that are not written yet stay in `edit`,
 * so a read (on reconnect, on returning to the tab) never throws away an edit.
 */
export function withRead(d: DeviceState, settings: Setting[]): DeviceState {
  const pending = pendingChanges(d);
  const edit = settings.map((s) => pending.find((p) => p.key === s.key) ?? s);
  return { ...d, read: settings, edit };
}
const same = (a: Setting, b: Setting) => JSON.stringify(a.value) === JSON.stringify(b.value);

export function pendingChanges(s: DeviceState): Setting[] {
  if (!s.read || !s.edit) return [];
  return s.edit.filter((e) => {
    const r = s.read!.find((x) => x.key === e.key);
    return r && !same(e, r);
  });
}

export function useDeviceManager() {
  const [devices, setDevices] = useState<DeviceState[]>([]);
  const [scanning, setScanning] = useState(false);
  const drivers = useRef(new Map<string, Driver>());
  /** each HID interface we drive -> its device id (WebHID hands back the same object while it stays connected) */
  const claimed = useRef(new Map<HIDDevice, string>());
  // Latest state for callbacks that outlive a render (the background writer, scans, focus handling).
  const latest = useRef<DeviceState[]>([]);
  useEffect(() => {
    latest.current = devices;
  }, [devices]);
  /** devices whose driver may hold outdated values (the user was away, maybe in the brand's own app) */
  const stale = useRef(new Set<string>());

  const patch = useCallback((id: string, p: Partial<DeviceState>) => {
    setDevices((list) => list.map((d) => (d.id === id ? { ...d, ...p } : d)));
  }, []);

  /** Store a fresh read in React state and in `latest` at once, keeping unwritten edits. */
  const storeRead = useCallback((id: string, settings: Setting[], extra: Partial<DeviceState> = {}) => {
    const upd = (d: DeviceState) => (d.id === id ? { ...withRead(d, settings), ...extra } : d);
    setDevices((list) => list.map(upd));
    latest.current = latest.current.map(upd);
  }, []);

  const readDevice = useCallback(
    async (id: string) => {
      const drv = drivers.current.get(id);
      if (!drv) return;
      stale.current.delete(id);
      patch(id, { busy: true, error: undefined });
      try {
        const settings = await drv.read();
        // the device may have been replaced (unplugged and back) while reading
        if (drivers.current.get(id) === drv) storeRead(id, settings, { busy: false });
      } catch (e) {
        patch(id, { busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [patch, storeRead],
  );

  const scanOnce = useCallback(async () => {
    if (!webHidSupported) return;
    setScanning(true);
    try {
      const granted = await grantedDevices();
      // forget interfaces that are gone; their drivers are closed below
      for (const hd of [...claimed.current.keys()]) if (!granted.includes(hd)) claimed.current.delete(hd);
      const fresh: string[] = [];
      for (const hd of granted) {
        if (claimed.current.has(hd)) continue;
        const id = unitIdFor(hd, claimed.current);
        if (!id) continue;
        const factory = FACTORIES.find((f) => f.match(hd));
        if (!factory) continue;
        try {
          const drv = await factory.create(hd);
          if (!drv) continue;
          // same id but a new interface object: the device was unplugged and came back
          const old = drivers.current.get(id);
          if (old && old !== drv) old.close().catch(() => {});
          drivers.current.set(id, drv);
          claimed.current.set(hd, id);
          fresh.push(id);
        } catch {
          /* not ours / busy - ignore */
        }
      }
      const found = new Set(claimed.current.values());
      // drop devices that disappeared
      for (const id of [...drivers.current.keys()]) {
        if (!found.has(id)) {
          drivers.current.get(id)?.close().catch(() => {});
          drivers.current.delete(id);
          stale.current.delete(id);
        }
      }
      const update = (list: DeviceState[]) => {
        const kept = list.filter((d) => found.has(d.id) && !fresh.includes(d.id));
        const added = [...found]
          .filter((id) => !kept.some((d) => d.id === id))
          .map((id) => ({ id, driver: drivers.current.get(id)!, busy: true }) as DeviceState);
        // keep the order devices were first seen in; a unit's number decides between twins
        return [...kept, ...added];
      };
      setDevices(update);
      latest.current = update(latest.current);
      // only newly opened devices need reading: a scan must never reset the others (it would drop unsaved edits)
      for (const id of fresh) void readDevice(id);
    } finally {
      setScanning(false);
    }
  }, [readDevice]);

  // one scan at a time: connect/disconnect events come in bursts, and two scans at once would open the same interface twice
  const scanQueue = useRef<Promise<void>>(Promise.resolve());
  const scan = useCallback(() => {
    const run = scanQueue.current.then(scanOnce, scanOnce);
    scanQueue.current = run.catch(() => undefined);
    return run;
  }, [scanOnce]);

  const connect = useCallback(async () => {
    if (!webHidSupported) return;
    if (isDemo()) return void (await scan());
    try {
      await navigator.hid.requestDevice({ filters: FACTORIES.flatMap((f) => f.filters) });
    } catch {
      /* user closed the picker */
    }
    await scan();
  }, [scan]);

  useEffect(() => {
    if (!webHidSupported) return;
    void scan();
    if (isDemo()) return;
    const onChange = () => void scan();
    navigator.hid.addEventListener('connect', onChange);
    navigator.hid.addEventListener('disconnect', onChange);
    return () => {
      navigator.hid.removeEventListener('connect', onChange);
      navigator.hid.removeEventListener('disconnect', onChange);
    };
  }, [scan]);

  // Coming back to the tab or window: the device may have been changed elsewhere (e.g. in the brand's own app).
  // Read idle devices again; a device with edits waiting is re-read just before its next write instead.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let awaySince: number | null = null;
    const leave = () => {
      awaySince ??= Date.now();
    };
    const back = () => {
      if (awaySince === null || document.visibilityState === 'hidden') return;
      const away = Date.now() - awaySince;
      awaySince = null;
      if (away < AWAY_MS) return;
      for (const d of latest.current) {
        if (!d.read) continue;
        stale.current.add(d.id);
        if (!d.busy && !d.saving && !pendingChanges(d).length) void readDevice(d.id);
      }
    };
    const vis = () => (document.visibilityState === 'hidden' ? leave() : back());
    window.addEventListener('blur', leave);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [readDevice]);

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const running = useRef(new Set<string>());
  const again = useRef(new Set<string>());

  /** Write every pending change of one device. Changes made meanwhile are picked up by a follow-up run. */
  const apply = useCallback(
    async (id: string) => {
      const drv = drivers.current.get(id);
      if (!drv) return;
      if (running.current.has(id)) {
        again.current.add(id);
        return;
      }
      running.current.add(id);
      try {
        // the driver's copy may be out of date (user was away): read first, so nothing old is written back
        if (stale.current.delete(id)) {
          patch(id, { saving: true });
          storeRead(id, await drv.read());
        }
        for (;;) {
          const state = latest.current.find((d) => d.id === id);
          if (!state) break;
          const changes = pendingChanges(state);
          if (!changes.length) break;
          patch(id, { saving: true, error: undefined });
          // switching profile changes what every other setting refers to: write it alone, then re-read
          const profile = changes.find((c) => c.key === 'profile');
          if (profile) {
            await drv.write(profile);
            const settings = await drv.read();
            setDevices((list) => list.map((d) => (d.id === id ? { ...d, read: settings, edit: settings, saving: false, savedAt: Date.now() } : d)));
            latest.current = latest.current.map((d) => (d.id === id ? { ...d, read: settings, edit: settings } : d));
            continue;
          }
          for (const c of changes) {
            await drv.write(c);
            // mark as written: the device now holds this value (later edits stay pending)
            const mark = (d: DeviceState) => (d.id === id && d.read ? { ...d, read: d.read.map((r) => (r.key === c.key ? c : r)) } : d);
            setDevices((list) => list.map(mark));
            latest.current = latest.current.map(mark);
          }
          patch(id, { saving: false, savedAt: Date.now() });
          if (!again.current.delete(id)) break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // show what the device really holds after a failed write
        try {
          const settings = await drv.read();
          patch(id, { read: settings, edit: settings, saving: false, error: msg });
        } catch {
          patch(id, { saving: false, error: msg });
        }
      } finally {
        running.current.delete(id);
        if (again.current.delete(id)) void apply(id);
      }
    },
    [patch, storeRead],
  );

  /** Untested drivers stay view-only until the user allows changes for that device (remembered). */
  const [allowed, setAllowed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(ALLOW_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const canWrite = useCallback(
    (id: string) => drivers.current.get(id)?.verified !== false || allowed.includes(id),
    [allowed],
  );
  const setAllowedFor = useCallback((id: string, on: boolean) => {
    setAllowed((a) => {
      const next = on ? (a.includes(id) ? a : [...a, id]) : a.filter((x) => x !== id);
      try {
        localStorage.setItem(ALLOW_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: applies to this visit only */
      }
      return next;
    });
  }, []);
  const allowChanges = useCallback((id: string) => setAllowedFor(id, true), [setAllowedFor]);
  /** Make an untested device view-only again. Unwritten edits are dropped so nothing is written later. */
  const revokeChanges = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id));
      setDevices((list) => list.map((d) => (d.id === id ? { ...d, edit: d.read } : d)));
      setAllowedFor(id, false);
    },
    [setAllowedFor],
  );
  /** true when this device is untested and the user allowed changes (so it can be made view-only again) */
  const isAllowed = useCallback((id: string) => drivers.current.get(id)?.verified === false && allowed.includes(id), [allowed]);

  /** Change a setting; it is written to the device by itself shortly after. */
  const edit = useCallback(
    (id: string, key: string, value: Setting['value']) => {
      if (!canWrite(id)) {
        patch(id, { error: 'This device is view-only until you allow changes.' });
        return;
      }
      setDevices((list) =>
        list.map((d) => (d.id === id && d.edit ? { ...d, edit: d.edit.map((s) => (s.key === key ? { ...s, value } : s)) } : d)),
      );
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => void apply(id), LIVE_DELAY_MS));
    },
    [apply, canWrite, patch],
  );

  const discard = useCallback((id: string) => {
    setDevices((list) => list.map((d) => (d.id === id ? { ...d, edit: d.read } : d)));
  }, []);

  return { devices, scanning, connect, scan, refresh: readDevice, edit, discard, apply, canWrite, allowChanges, revokeChanges, isAllowed };
}
