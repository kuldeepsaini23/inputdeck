import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGUAGES, format, matchLanguage } from './i18n'

const dir = join(__dirname, '..', 'locales')
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>
const en = read('en.json')
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const locales = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json' && !f.startsWith('_'))

describe('locale files', () => {
  it('has a file for every language', () => {
    expect(locales.map((f) => f.replace('.json', '')).sort()).toEqual(LANGUAGES.map(([c]) => c).filter((c) => c !== 'en').sort())
  })

  it('en.json maps every string to itself', () => {
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k)
  })

  for (const f of locales) {
    describe(f, () => {
      const dict = read(f)
      it('only has keys that exist in en.json (run npm run i18n:extract)', () => {
        expect(Object.keys(dict).filter((k) => !(k in en))).toEqual([])
      })
      it('keeps the same {placeholders} as the English text', () => {
        const bad = Object.entries(dict).filter(([k, v]) => typeof v !== 'string' || placeholders(k).join() !== placeholders(v).join())
        expect(bad).toEqual([])
      })
    })
  }

  it('lists short strings that exist', () => {
    const short = JSON.parse(readFileSync(join(dir, '_short.json'), 'utf8')) as string[]
    expect(short.filter((k) => !(k in en))).toEqual([])
  })
})

describe('i18n helpers', () => {
  it('fills placeholders', () => {
    expect(format('{n} keys selected', { n: 3 })).toBe('3 keys selected')
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}')
  })

  it('matches browser languages', () => {
    expect(matchLanguage(['de-AT', 'en'])).toBe('de')
    expect(matchLanguage(['zh-HK'])).toBe('zh-TW')
    expect(matchLanguage(['zh-Hant'])).toBe('zh-TW')
    expect(matchLanguage(['zh'])).toBe('zh-CN')
    expect(matchLanguage(['pt-PT'])).toBe('pt-BR')
    expect(matchLanguage(['nl', 'fr-CA'])).toBe('fr')
    expect(matchLanguage(['nl'])).toBe('en')
    expect(matchLanguage([])).toBe('en')
  })
})
