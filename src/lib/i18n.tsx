// UI translations. No library: messages are keyed by their English text, so a string
// missing from a dictionary (or text from a driver nobody translated) simply shows in English.
// Dictionaries live in src/locales/<code>.json and load on demand.
import { useEffect, useSyncExternalStore } from 'react'

export const LANGUAGES = [
  ['en', 'English'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['pt-BR', 'Português'],
  ['ru', 'Русский'],
  ['tr', 'Türkçe'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['id', 'Bahasa Indonesia'],
  ['hi', 'हिन्दी'],
] as const

export type Lang = (typeof LANGUAGES)[number][0]
export type Vars = Record<string, string | number>
type Dict = Record<string, string>

const STORAGE_KEY = 'inputdeck.lang'
const codes = LANGUAGES.map(([c]) => c) as readonly Lang[]
export const isLang = (s: unknown): s is Lang => typeof s === 'string' && (codes as readonly string[]).includes(s)
export const nativeName = (l: Lang) => LANGUAGES.find(([c]) => c === l)![1]

// Vite turns this into one lazy chunk per locale. en.json is the extractor's output, not a dictionary.
const loaders = import.meta.glob<{ default: Dict }>(['../locales/*.json', '!../locales/en.json', '!../locales/_*.json'])
const loaderFor = (l: Lang) => loaders[`../locales/${l}.json`]

/** Replace {name} placeholders. Unknown names are left as they are. */
export function format(text: string, vars?: Vars) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** Pick the best supported language for a list like navigator.languages. */
export function matchLanguage(prefs: readonly string[]): Lang {
  for (const raw of prefs) {
    const p = raw.toLowerCase()
    const exact = codes.find((c) => c.toLowerCase() === p)
    if (exact) return exact
    const base = p.split('-')[0]
    if (base === 'zh') {
      // Traditional for Taiwan, Hong Kong, Macau and explicit Hant; Simplified otherwise
      return /-(tw|hk|mo)\b|hant/.test(p) ? 'zh-TW' : 'zh-CN'
    }
    if (base === 'pt') return 'pt-BR'
    if (base === 'in') return 'id' // old code for Indonesian
    const byBase = codes.find((c) => c.split('-')[0].toLowerCase() === base)
    if (byBase) return byBase
  }
  return 'en'
}

// ---- store -----------------------------------------------------------------
// `wanted` is what the user picked; `active` only switches once its dictionary is loaded,
// so the UI never shows a half-translated flash of keys.
let wanted: Lang = 'en'
let active: Lang = 'en'
const dicts: Partial<Record<Lang, Dict>> = { en: {} }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}

function applyHtmlLang(l: Lang) {
  if (typeof document !== 'undefined') document.documentElement.lang = l
}

async function load(l: Lang): Promise<Dict> {
  const have = dicts[l]
  if (have) return have
  const loader = loaderFor(l)
  const d = loader ? (await loader()).default : {}
  dicts[l] = d
  return d
}

export function setLang(l: Lang, opts: { save?: boolean } = {}) {
  wanted = l
  if (opts.save !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* storage blocked: the choice just won't stick */
    }
  }
  emit()
  void load(l)
    .catch(() => ({}) as Dict) // a missing chunk falls back to English
    .then((d) => {
      dicts[l] ??= d
      if (wanted !== l) return
      active = l
      applyHtmlLang(l)
      emit()
    })
}

/** Saved choice, else the browser's languages, else English. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    /* ignore */
  }
  if (typeof navigator !== 'undefined') return matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en'])
  return 'en'
}

export function translate(l: Lang, text: string, vars?: Vars) {
  return format(dicts[l]?.[text] || text, vars)
}

/**
 * Translate outside React (toasts, errors, confirm dialogs). Inside components prefer useT(),
 * which re-renders on a language change.
 */
export function t(text: string, vars?: Vars) {
  return translate(active, text, vars)
}

// The prerendered shell is English, so the server snapshot is always 'en'. React hydrates with
// it and then switches to the client value, which avoids hydration mismatches.
const getActive = () => active
const getWanted = () => wanted
const getEn = (): Lang => 'en'

/** `t` bound to the language currently on screen. */
export function useT() {
  const l = useSyncExternalStore(subscribe, getActive, getEn)
  return (text: string, vars?: Vars) => translate(l, text, vars)
}

/** The language the user picked (may still be loading). */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getWanted, getEn)
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const l = initialLang()
    if (l !== 'en') setLang(l, { save: false })
    else applyHtmlLang('en')
  }, [])
  return <>{children}</>
}
