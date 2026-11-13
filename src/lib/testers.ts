// Pure maths for the tools page (polling rate, DPI check, click and key chatter).
// Nothing here talks to a device: it only looks at the events the browser receives.

export const STANDARD_RATES = [125, 250, 500, 1000, 2000, 4000, 8000]

/** Report rate from event timestamps (ms). Uses the median gap so pauses in movement don't drag it down. */
export function rateOf(times: number[]): number | undefined {
  if (times.length < 8) return undefined
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1]
    if (g > 0 && g < 50) gaps.push(g) // > 50 ms means the mouse stopped, not a slow report
  }
  if (gaps.length < 6) return undefined
  gaps.sort((a, b) => a - b)
  const mid = gaps[gaps.length >> 1]
  return 1000 / mid
}

/** Average rate over the reports in a window (counts every report, so it shows dropped ones). */
export function averageRate(times: number[]): number | undefined {
  if (times.length < 8) return undefined
  const span = times[times.length - 1] - times[0]
  return span > 0 ? ((times.length - 1) * 1000) / span : undefined
}

/** The standard polling rate a measured rate is closest to (on a log scale). */
export function nearestRate(hz: number): number {
  let best = STANDARD_RATES[0]
  for (const r of STANDARD_RATES) if (Math.abs(Math.log(hz / r)) < Math.abs(Math.log(hz / best))) best = r
  return best
}

/** DPI from the counts moved over a known distance. */
export function dpiOf(counts: number, distance: number, unit: 'cm' | 'in'): number | undefined {
  const inches = unit === 'cm' ? distance / 2.54 : distance
  return inches > 0 ? Math.abs(counts) / inches : undefined
}

/** How far a measured DPI is from the DPI the mouse is set to, in percent. */
export const dpiError = (measured: number, set: number) => ((measured - set) / set) * 100

export interface Press {
  down: number
  up?: number
}

/** Presses that started very soon after the previous release of the same button: usually a worn switch (chatter). */
export function chatterCount(presses: Press[], thresholdMs: number): number {
  let n = 0
  for (let i = 1; i < presses.length; i++) {
    const prevUp = presses[i - 1].up
    if (prevUp !== undefined && presses[i].down - prevUp < thresholdMs) n++
  }
  return n
}

/** Shortest gap between letting go and pressing again (how fast Rapid Trigger lets you re-press). */
export function fastestRepress(presses: Press[]): number | undefined {
  let best: number | undefined
  for (let i = 1; i < presses.length; i++) {
    const prevUp = presses[i - 1].up
    if (prevUp === undefined) continue
    const g = presses[i].down - prevUp
    if (g >= 0 && (best === undefined || g < best)) best = g
  }
  return best
}

/** Clicks per second over the last `windowMs`. */
export function cps(downs: number[], now: number, windowMs = 1000): number {
  let n = 0
  for (let i = downs.length - 1; i >= 0 && now - downs[i] <= windowMs; i--) n++
  return (n * 1000) / windowMs
}
