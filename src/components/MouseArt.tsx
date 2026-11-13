/**
 * Drawn top-down gaming mouse, shown when a driver has no product photo.
 * Same 300×580 box as the photos so the button markers line up.
 */
import { useT } from '#/lib/i18n'

export function MouseArt({ label }: { label?: string }) {
  const t = useT()
  return (
    <svg viewBox="0 0 300 580" className="size-full drop-shadow-[0_40px_40px_rgb(0_0_0/0.8)]" role="img" aria-label={label ?? t('Mouse')}>
      <defs>
        <linearGradient id="ma-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a3b40" />
          <stop offset="0.45" stopColor="#1d1e21" />
          <stop offset="1" stopColor="#0b0b0c" />
        </linearGradient>
        <radialGradient id="ma-sheen" cx="0.32" cy="0.22" r="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ma-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="ma-wheel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0c0c0d" />
          <stop offset="0.5" stopColor="#5a5c63" />
          <stop offset="1" stopColor="#0c0c0d" />
        </linearGradient>
      </defs>
      {/* body: wider at the back, slight waist for the grip */}
      <path
        d="M150 22 C 218 22 262 70 268 150 C 273 220 262 268 266 330 C 270 450 236 556 150 558 C 64 556 30 450 34 330 C 38 268 27 220 32 150 C 38 70 82 22 150 22 Z"
        fill="url(#ma-body)" stroke="url(#ma-rim)" strokeWidth="1.5"
      />
      <path
        d="M150 22 C 218 22 262 70 268 150 C 273 220 262 268 266 330 C 270 450 236 556 150 558 C 64 556 30 450 34 330 C 38 268 27 220 32 150 C 38 70 82 22 150 22 Z"
        fill="url(#ma-sheen)"
      />
      {/* split between the main buttons, and where they end */}
      <path d="M150 24 L150 200" stroke="#000" strokeOpacity="0.85" strokeWidth="2" />
      <path d="M151.5 24 L151.5 200" stroke="#fff" strokeOpacity="0.07" strokeWidth="1" />
      <path d="M44 214 C 90 236 210 236 256 214" fill="none" stroke="#000" strokeOpacity="0.55" strokeWidth="1.6" />
      <path d="M44 216 C 90 238 210 238 256 216" fill="none" stroke="#fff" strokeOpacity="0.05" strokeWidth="1" />
      {/* scroll wheel */}
      <rect x="138" y="74" width="24" height="64" rx="12" fill="#050506" />
      <rect x="142" y="80" width="16" height="52" rx="8" fill="url(#ma-wheel)" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path key={i} d={`M144 ${88 + i * 7} H156`} stroke="#000" strokeOpacity="0.5" strokeWidth="1.2" />
      ))}
      {/* side buttons on the left */}
      <path d="M33 232 C 30 250 30 268 31 286" stroke="#000" strokeOpacity="0.9" strokeWidth="7" strokeLinecap="round" />
      <path d="M33 232 C 30 250 30 268 31 286" stroke="#6b6d74" strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" />
      <path d="M31 300 C 30 318 31 336 33 352" stroke="#000" strokeOpacity="0.9" strokeWidth="7" strokeLinecap="round" />
      <path d="M31 300 C 30 318 31 336 33 352" stroke="#6b6d74" strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" />
      {/* DPI button */}
      <rect x="143" y="168" width="14" height="22" rx="7" fill="#08080a" stroke="#fff" strokeOpacity="0.1" />
      {/* palm highlight */}
      <ellipse cx="150" cy="420" rx="80" ry="100" fill="#fff" opacity="0.012" />
    </svg>
  )
}
