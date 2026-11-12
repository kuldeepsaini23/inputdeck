import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { isDemo, useDeviceManager, webHidSupported } from '#/devices'
import { ConnectSheet } from '#/components/ConnectSheet'

type Manager = ReturnType<typeof useDeviceManager>

const Ctx = createContext<(Manager & { supported: boolean; demo: boolean; requestConnect: () => void }) | null>(null)

/** One device manager for the whole app, so devices stay connected while you move between pages. */
export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const mgr = useDeviceManager()
  // WebHID is checked after mount so the first render matches the prerendered shell.
  const [supported, setSupported] = useState(true)
  const [demo, setDemo] = useState(false)
  const [sheet, setSheet] = useState(false)
  useEffect(() => {
    setSupported(webHidSupported)
    setDemo(isDemo())
  }, [])
  // explain which device to pick, then open the browser's own device list
  // A device that wasn't here before (picked in the browser list or plugged in) opens straight away.
  // Devices found by the first scan, and ones that only reconnect, don't move the page.
  const navigate = useNavigate()
  const seen = useRef<Set<string> | null>(null)
  const sawScan = useRef(false)
  useEffect(() => {
    if (mgr.scanning) {
      sawScan.current = true
      return
    }
    const ids = mgr.devices.map((d) => d.id)
    if (!seen.current) {
      if (sawScan.current) seen.current = new Set(ids)
      return
    }
    const added = ids.filter((id) => !seen.current!.has(id))
    for (const id of added) seen.current.add(id)
    if (added.length) void navigate({ to: '/d/$id', params: { id: slug(added[added.length - 1]) } })
  }, [mgr.devices, mgr.scanning, navigate])
  const requestConnect = () => (isDemo() ? void mgr.connect() : setSheet(true))
  return (
    <Ctx.Provider value={{ ...mgr, supported, demo, requestConnect }}>
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
