import { createContext, useContext, useEffect, useState } from 'react'
import { isDemo, useDeviceManager, webHidSupported } from '#/devices'
import { ConnectSheet } from '#/components/ConnectSheet'

type Manager = ReturnType<typeof useDeviceManager>

const Ctx = createContext<(Manager & { supported: boolean; requestConnect: () => void }) | null>(null)

/** One device manager for the whole app, so devices stay connected while you move between pages. */
export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const mgr = useDeviceManager()
  // WebHID is checked after mount so the first render matches the prerendered shell.
  const [supported, setSupported] = useState(true)
  const [sheet, setSheet] = useState(false)
  useEffect(() => setSupported(webHidSupported), [])
  // explain which device to pick, then open the browser's own device list
  const requestConnect = () => (isDemo() ? void mgr.connect() : setSheet(true))
  return (
    <Ctx.Provider value={{ ...mgr, supported, requestConnect }}>
      {children}
      <ConnectSheet open={sheet} onOpenChange={setSheet} onContinue={() => { setSheet(false); void mgr.connect() }} />
    </Ctx.Provider>
  )
}

export function useDevices() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDevices outside DeviceProvider')
  return v
}

/** URL-safe id: "36a7:a863" -> "36a7-a863" */
export const slug = (id: string) => id.replace(':', '-')
export const unslug = (s: string) => s.replace('-', ':')
