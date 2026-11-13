#!/usr/bin/env node
// Collects every translatable English string into src/locales/en.json (English -> English).
// Translators copy keys from there into src/locales/<code>.json.
//   - UI code: literal t('...') / t("...") / t(`...`) calls in files that import #/lib/i18n
//   - drivers (src/drivers/*.ts) and src/devices.ts: literal label/hint/confirm/group/title
//     properties, choice option tuples ['Label', n], new Error('...') and error: '...'
// Best effort: strings built at runtime (template literals with ${}) can't be collected and stay English.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const src = join(root, 'src')

const LIT = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\$]|\\.|\$(?!\{))*\`)`

/** Turn a matched JS string literal into its value. */
function unquote(lit) {
  const q = lit[0]
  const body = lit.slice(1, -1)
  if (q === '`' && body.includes('\n')) return null // multi-line templates are not UI strings here
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16))
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16))
    return { n: '\n', t: '\t', r: '\r', 0: '\0' }[e] ?? e
  })
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'locales' && name !== 'fakes') walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|gen)\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

// Driver strings worth translating have at least one letter and aren't identifiers/codes.
const looksLikeText = (s) =>
  /\p{L}/u.test(s) &&
  s.trim() === s &&
  s.length > 1 &&
  !/^[A-Z0-9_]+$/.test(s) && // KC_ESC, F12
  !/^[a-z0-9_]+$/.test(s) && // keys / ids
  !/^#?[0-9a-fA-F]{2,}$/.test(s)

const found = new Map() // text -> first file
const add = (text, file) => {
  if (text == null || text === '') return
  if (!found.has(text)) found.set(text, relative(root, file).split(sep).join('/'))
}

const files = walk(src)
for (const file of files) {
  const code = readFileSync(file, 'utf8')
  const rel = relative(src, file).split(sep).join('/')
  const isDriver = /^drivers\/[^/]+\.ts$/.test(rel) || rel === 'devices.ts'
  if (/from '#\/lib\/i18n'|from '\.\/i18n'/.test(code) || rel === 'lib/i18n.tsx') {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])t\(\s*` + LIT, 'g'))) add(unquote(m[1]), file)
  }
  if (isDriver) {
    const pats = [
      String.raw`\b(?:label|hint|confirm|group|title)\s*:\s*` + LIT,
      String.raw`\[\s*` + LIT + String.raw`\s*,\s*-?(?:0x[0-9a-fA-F]+|\d+)\s*\]`,
      String.raw`new Error\(\s*` + LIT + String.raw`\s*\)`,
      String.raw`\berror\s*:\s*` + LIT,
    ]
    for (const p of pats)
      for (const m of code.matchAll(new RegExp(p, 'g'))) {
        const s = unquote(m[1])
        if (s && looksLikeText(s)) add(s, file)
      }
  }
  // keycode names and picker categories (the UI shows them through t(name))
  if (rel === 'lib/keycodes.ts') {
    const pats = [
      String.raw`\[\s*'[a-z]+'\s*,\s*` + LIT + String.raw`\s*\]`, // ['basic', 'Basic']
      String.raw`\bname\s*:\s*` + LIT,
      String.raw`\[\s*0x[0-9a-fA-F]+\s*,\s*${LIT}\s*,\s*${LIT}\s*,\s*${LIT}`, // [code, id, legend, name
      String.raw`\badd\(\s*[^,()]+\s*,\s*${LIT}\s*,\s*${LIT}\s*,\s*${LIT}`,
    ]
    for (const p of pats)
      for (const m of code.matchAll(new RegExp(p, 'g'))) {
        const s = unquote(m[m.length - 1])
        if (s && looksLikeText(s)) add(s, file)
      }
  }
  // macro problems shown under a macro
  if (rel === 'lib/macros.ts') {
    for (const p of [String.raw`\?\s*undefined\s*:\s*` + LIT, String.raw`\breturn\s+` + LIT + String.raw`\s*;`])
      for (const m of code.matchAll(new RegExp(p, 'g'))) {
        const s = unquote(m[1])
        if (s && looksLikeText(s) && /\s/.test(s)) add(s, file)
      }
  }
}

const sorted = [...found.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const en = Object.fromEntries(sorted.map((k) => [k, k]))
writeFileSync(join(src, 'locales', 'en.json'), JSON.stringify(en, null, 2) + '\n')
console.log(`i18n: ${sorted.length} strings from ${files.length} files -> src/locales/en.json`)
