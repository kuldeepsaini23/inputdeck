import { createContext, useContext, useEffect, useState } from 'react'
import { useDeviceManager, webHidSupported } from '#/devices'

type Manager = ReturnType<typeof useDeviceManager>

const Ctx = createContext<(Manager & { supported: boolean }) | null>(null)

/** One device manager for the whole app, so devices stay connected while you move between pages. */
export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const mgr = useDeviceManager()
  // WebHID is checked after mount so the first render matches the prerendered shell.
  const [supported, setSupported] = useState(true)
  useEffect(() => setSupported(webHidSupported), [])
  return <Ctx.Provider value={{ ...mgr, supported }}>{children}</Ctx.Provider>
}

export function useDevices() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDevices outside DeviceProvider')
  return v
}

/** URL-safe id: "36a7:a863" -> "36a7-a863" */
export const slug = (id: string) => id.replace(':', '-')
export const unslug = (s: string) => s.replace('-', ':')
