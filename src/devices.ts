// Device manager: finds granted WebHID devices, matches them to drivers, and keeps
// per-device read / edit state. One physical device can expose several HID
// interfaces; we keep one driver per vendor:product pair.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Driver, DriverFactory, Setting } from './drivers/types';
import { wlmouseFactory } from './drivers/wlmouse';
import { wraithFactory } from './drivers/wraith';
import { pulsarFactory } from './drivers/pulsar';

export const FACTORIES: DriverFactory[] = [wlmouseFactory, wraithFactory, pulsarFactory];

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

/** Demo mode: open the app with ?demo once to use simulated devices for this browser tab. */
export function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('demo')) sessionStorage.setItem('inputdeck.demo', '1');
    return sessionStorage.getItem('inputdeck.demo') === '1';
  } catch {
    return false;
  }
}

export const webHidSupported = typeof navigator !== 'undefined' && ('hid' in navigator || isDemo());

async function grantedDevices(): Promise<HIDDevice[]> {
  if (isDemo()) return (await import('./drivers/fakes/demo')).demoDevices();
  return navigator.hid.getDevices();
}

const devId = (d: HIDDevice) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
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

  const patch = useCallback((id: string, p: Partial<DeviceState>) => {
    setDevices((list) => list.map((d) => (d.id === id ? { ...d, ...p } : d)));
  }, []);

  const readDevice = useCallback(
    async (id: string) => {
      const drv = drivers.current.get(id);
      if (!drv) return;
      patch(id, { busy: true, error: undefined });
      try {
        const settings = await drv.read();
        patch(id, { read: settings, edit: settings, busy: false });
      } catch (e) {
        patch(id, { busy: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [patch],
  );

  const scan = useCallback(async () => {
    if (!webHidSupported) return;
    setScanning(true);
    try {
      const granted = await grantedDevices();
      const found: string[] = [];
      for (const hd of granted) {
        const id = devId(hd);
        if (found.includes(id)) continue;
        if (drivers.current.has(id)) {
          found.push(id);
          continue;
        }
        const factory = FACTORIES.find((f) => f.match(hd));
        if (!factory) continue;
        try {
          const drv = await factory.create(hd);
          if (drv) {
            drivers.current.set(id, drv);
            found.push(id);
          }
        } catch {
          /* not ours / busy - ignore */
        }
      }
      // drop devices that disappeared
      for (const id of [...drivers.current.keys()]) {
        if (!found.includes(id)) {
          drivers.current.get(id)?.close().catch(() => {});
          drivers.current.delete(id);
        }
      }
      setDevices((list) => {
        const kept = list.filter((d) => found.includes(d.id));
        const added = found
          .filter((id) => !kept.some((d) => d.id === id))
          .map((id) => ({ id, driver: drivers.current.get(id)!, busy: true }) as DeviceState);
        return [...kept, ...added];
      });
      for (const id of found) {
        if (!devices.some((d) => d.id === id && d.read)) void readDevice(id);
      }
    } finally {
      setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readDevice]);

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

  // Latest state for the background writer (callbacks would otherwise see stale state).
  const latest = useRef<DeviceState[]>([]);
  useEffect(() => {
    latest.current = devices;
  }, [devices]);
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
    [patch],
  );

  /** Change a setting; it is written to the device by itself shortly after. */
  const edit = useCallback(
    (id: string, key: string, value: Setting['value']) => {
      setDevices((list) =>
        list.map((d) => (d.id === id && d.edit ? { ...d, edit: d.edit.map((s) => (s.key === key ? { ...s, value } : s)) } : d)),
      );
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => void apply(id), LIVE_DELAY_MS));
    },
    [apply],
  );

  const discard = useCallback((id: string) => {
    setDevices((list) => list.map((d) => (d.id === id ? { ...d, edit: d.read } : d)));
  }, []);

  return { devices, scanning, connect, scan, refresh: readDevice, edit, discard, apply };
}
