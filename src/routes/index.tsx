import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Usb } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Backdrop, TopBar } from '#/components/shell'
import { slug, useDevices } from '#/lib/device-context'

export const Route = createFileRoute('/')({ component: Welcome })

function Welcome() {
  const { devices, requestConnect, scanning, supported } = useDevices()
  const navigate = useNavigate()
  // open the first device the first time one shows up (already-allowed devices reconnect by themselves)
  const opened = useRef(false)
  useEffect(() => {
    if (!opened.current && devices[0]) {
      opened.current = true
      void navigate({ to: '/d/$id', params: { id: slug(devices[0].id) } })
    }
  }, [devices, navigate])

  return (
    <div className="app">
      <Backdrop />
      <TopBar />
      <main className="relative z-10 flex h-[calc(100%-76px)] flex-col items-center justify-center px-6 text-center">
        <div className="fade-in flex flex-col items-center">
          <div className="display mb-5 text-[10px] tracking-[0.4em] text-[var(--text-3)]">INPUTDECK</div>
          <h1 className="big-num m-0 text-[clamp(30px,4.4vw,52px)] leading-[1.15]">Tune your gear,<br />right in the browser.</h1>
          <p className="mt-5 max-w-[560px] text-[15px] leading-relaxed text-[var(--text-2)]">
            DPI, polling rate, buttons, per-key actuation, Rapid Trigger and lighting — saved straight to your mouse and keyboard. Nothing to install.
          </p>
          {supported ? (
            <button type="button" onClick={requestConnect} disabled={scanning}
              className="plat display mt-8 flex items-center gap-2.5 rounded-full px-7 py-[15px] text-[13px] font-semibold shadow-[0_0_30px_rgb(230_232_236/0.3)] disabled:opacity-60">
              <Usb className="size-4" /> Connect a device
            </button>
          ) : (
            <div className="glass mt-8 max-w-md px-6 py-4 text-[13.5px] text-[var(--text-2)]">
              Your browser can't talk to USB devices. Open InputDeck in Chrome, Edge or Opera on a computer.
            </div>
          )}
          <ol className="m-0 mt-9 flex list-none flex-wrap justify-center gap-3 p-0">
            {['Plug in your mouse or keyboard', 'Click Connect and pick it', 'Remembered next time'].map((s, i) => (
              <li key={s} className="flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.03] py-2.5 pr-4 pl-3 text-[12.5px] text-[var(--text-2)]">
                <span className="display text-[10px] font-semibold text-[var(--text)]">0{i + 1}</span>{s}
              </li>
            ))}
          </ol>
          <div className="display mt-9 text-[8.5px] tracking-[0.3em] text-[var(--text-4)]">WORKS WITH</div>
          <div className="mt-3 text-[13px] text-[var(--text-3)]">WLMouse · Pulsar · Logitech · Razer · Lamzu · ATK · VXE · Scyrox · Wraith · any VIA keyboard</div>
        </div>
      </main>
    </div>
  )
}
