// "Open an app" for any device with key macros: the macro presses Win+R, types the target into
// Windows' Run box and presses Enter. Works for programs on the PATH or registered with Windows
// (notepad, calc, spotify, discord...), full paths, files, folders and links (https://, steam://,
// ms-settings:). Typed with a US key layout, like every macro text step.
import type { MacroStep } from '#/drivers/types'

const SHIFT = 0xe1
const GUI = 0xe3
const KC_R = 0x15
const ENTER = 0x28

// US layout: character -> [HID usage, needs Shift]
const US: Record<string, [number, boolean]> = {}
for (let i = 0; i < 26; i++) {
  US[String.fromCharCode(97 + i)] = [4 + i, false]
  US[String.fromCharCode(65 + i)] = [4 + i, true]
}
'1234567890'.split('').forEach((c, i) => (US[c] = [0x1e + i, false]))
'!@#$%^&*()'.split('').forEach((c, i) => (US[c] = [0x1e + i, true]))
const PAIRS: [string, string, number][] = [
  ['-', '_', 0x2d], ['=', '+', 0x2e], ['[', '{', 0x2f], [']', '}', 0x30], ['\\', '|', 0x31],
  [';', ':', 0x33], ["'", '"', 0x34], ['`', '~', 0x35], [',', '<', 0x36], ['.', '>', 0x37], ['/', '?', 0x38],
]
for (const [plain, shifted, kc] of PAIRS) {
  US[plain] = [kc, false]
  US[shifted] = [kc, true]
}
US[' '] = [0x2c, false]

/** The first character that can't be typed, if any. */
export function untypable(text: string): string | undefined {
  return [...text].find((c) => !US[c])
}

/** Key presses that type `text` (each character a tap, Shift held around shifted ones). */
export function typeSteps(text: string): MacroStep[] {
  const out: MacroStep[] = []
  for (const c of text) {
    const k = US[c]
    if (!k) throw new Error(`“${c}” can't be typed`)
    if (k[1]) out.push({ t: 'down', kc: SHIFT }, { t: 'tap', kc: k[0] }, { t: 'up', kc: SHIFT })
    else out.push({ t: 'tap', kc: k[0] })
  }
  return out
}

/** Win+R, wait for the Run box, type the target, Enter. */
export function launchSteps(target: string, delays = true): MacroStep[] {
  const what = target.trim()
  if (!what) throw new Error('type an app name, path or link')
  return [
    { t: 'down', kc: GUI },
    { t: 'tap', kc: KC_R },
    { t: 'up', kc: GUI },
    ...(delays ? [{ t: 'delay', ms: 400 } as MacroStep] : []),
    ...typeSteps(what),
    ...(delays ? [{ t: 'delay', ms: 50 } as MacroStep] : []),
    { t: 'tap', kc: ENTER },
  ]
}
