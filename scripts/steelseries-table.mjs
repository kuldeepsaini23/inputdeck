// Builds src/drivers/steelseries-devices.gen.ts from a rivalcfg checkout (https://github.com/flozz/rivalcfg, WTFPL).
// rivalcfg's device profiles are Python dict literals; this reads them as TEXT with a tiny parser for that
// literal subset (no Python is run). Usage: node scripts/steelseries-table.mjs <path to rivalcfg checkout>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: node scripts/steelseries-table.mjs <rivalcfg checkout>');
const dev = join(root, 'rivalcfg', 'devices');

// ---------- tokenizer ----------
function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length, s = '';
      while (!src.startsWith(q, j)) {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++];
        if (j > src.length) throw new Error('unterminated string');
      }
      t.push({ k: 'str', v: s });
      i = j + q.length;
      continue;
    }
    const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d+)?)/.exec(src.slice(i));
    if (num) {
      const s = num[0].replace(/_/g, '');
      t.push({ k: 'num', v: s.includes('.') ? parseFloat(s) : Number(s) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { t.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    t.push({ k: 'op', v: c });
    i++;
  }
  return t;
}

// ---------- parser (AST) ----------
function parser(toks) {
  let p = 0;
  const peek = (v) => toks[p] && (v === undefined || toks[p].v === v) ? toks[p] : null;
  const eat = (v) => {
    const x = toks[p];
    if (!x || (v !== undefined && x.v !== v)) throw new Error(`expected ${v} at token ${p}: got ${x && x.v}`);
    p++;
    return x;
  };
  function expr() {
    if (peek('lambda')) {
      eat('lambda');
      const arg = eat().v;
      eat(':');
      return { t: 'lambda', arg, body: expr() };
    }
    let l = unary();
    while (peek('|') || peek('&') || peek('-') || peek('*') || peek('+')) {
      const op = eat().v;
      l = { t: 'bin', op, l, r: unary() };
    }
    return l;
  }
  function unary() {
    if (peek('~')) { eat(); return { t: 'inv', e: unary() }; }
    if (peek('-')) { eat(); return { t: 'neg', e: unary() }; }
    return postfix();
  }
  function postfix() {
    let e = atom();
    for (;;) {
      if (peek('.')) { eat(); e = { t: 'attr', e, name: eat().v }; }
      else if (peek('[')) { eat('['); const i = expr(); eat(']'); e = { t: 'index', e, i }; }
      else if (peek('(')) { eat('('); const args = []; while (!peek(')')) { args.push(expr()); if (peek(',')) eat(','); } eat(')'); e = { t: 'call', e, args }; }
      else return e;
    }
  }
  function atom() {
    const x = eat();
    if (x.k === 'num') return { t: 'lit', v: x.v };
    if (x.k === 'str') { let s = x.v; while (peek() && toks[p].k === 'str') s += eat().v; return { t: 'lit', v: s }; }
    if (x.k === 'id') {
      if (x.v === 'True') return { t: 'lit', v: true };
      if (x.v === 'False') return { t: 'lit', v: false };
      if (x.v === 'None') return { t: 'lit', v: null };
      return { t: 'name', v: x.v };
    }
    if (x.v === '{') {
      const items = [];
      if (peek('}')) { eat(); return { t: 'dict', items }; }
      const k = expr();
      eat(':');
      const v = expr();
      if (peek('for')) {
        eat('for');
        const names = [eat().v];
        while (peek(',')) { eat(','); names.push(eat().v); }
        eat('in');
        const src = expr();
        eat('}');
        return { t: 'dictcomp', k, v, names, src };
      }
      items.push([k, v]);
      while (peek(',')) { eat(','); if (peek('}')) break; const k2 = expr(); eat(':'); items.push([k2, expr()]); }
      eat('}');
      return { t: 'dict', items };
    }
    if (x.v === '[' || x.v === '(') {
      const close = x.v === '[' ? ']' : ')';
      const items = [];
      let tuple = false;
      while (!peek(close)) {
        if (peek('*')) { eat('*'); items.push({ t: 'spread', e: expr() }); } else items.push(expr());
        if (peek(',')) { eat(','); tuple = true; }
      }
      eat(close);
      if (x.v === '(' && !tuple && items.length === 1) return items[0];
      return { t: 'list', items };
    }
    throw new Error('unexpected token ' + x.v);
  }
  return { expr, peek, eat, done: () => p >= toks.length, skipLine: () => p };
}

// ---------- module loading ----------
const USBHID = { HID_REPORT_TYPE_OUTPUT: 'output', HID_REPORT_TYPE_FEATURE: 'feature' };
const modules = new Map();
const WIRELESS = Symbol('patch');

function loadModule(file) {
  if (modules.has(file)) return modules.get(file);
  const src = readFileSync(file, 'utf8');
  const env = { usbhid: USBHID };
  // strip the module docstring, imports and the one helper function (_patch_command), keep assignments
  const lines = src.split('\n');
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^from \.(dpi)? import (\w+)/.exec(l))) {
      const dir = m[1] ? join(dev, 'dpi') : dev;
      env[m[2]] = loadModule(join(dir, m[2] + '.py'));
      continue;
    }
    if (/^from \.\. import usbhid/.test(l)) continue;
    if (/^def _patch_command/.test(l)) {
      const fn = lines.slice(i).join('\n').split(/\n(?=\S)/)[0];
      if (!/\| _WIRELESS_FLAG/.test(fn) || !/readback_length/.test(fn)) throw new Error('unknown _patch_command in ' + file);
      env._patch_command = WIRELESS;
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) i++;
      continue;
    }
    if (/^(def|class|import) /.test(l)) throw new Error('unexpected ' + l + ' in ' + file);
    body += l + '\n';
  }
  body = body.replace(/^\s*"""[\s\S]*?"""/, '');
  const toks = tokenize(body);
  const ps = parser(toks);
  const out = {};
  while (!ps.done()) {
    const name = ps.eat().v;
    ps.eat('=');
    const ast = ps.expr();
    out[name] = env[name] = evaluate(ast, env);
  }
  modules.set(file, out);
  return out;
}

function patchWireless(info, env) {
  const r = { ...info, command: [...info.command] };
  r.command[0] |= env._WIRELESS_FLAG;
  r.readback_length = env._READBACK_LENGTH;
  return r;
}

function evaluate(a, env) {
  switch (a.t) {
    case 'lit': return a.v;
    case 'name':
      if (!(a.v in env)) throw new Error('unknown name ' + a.v);
      return env[a.v];
    case 'list': return a.items.flatMap((x) => (x.t === 'spread' ? evaluate(x.e, env) : [evaluate(x, env)]));
    case 'dict': {
      const o = {};
      for (const [k, v] of a.items) o[evaluate(k, env)] = evaluate(v, env);
      return o;
    }
    case 'dictcomp': {
      const src = evaluate(a.src, env);
      if (!Array.isArray(src)) throw new Error('comprehension over non-items');
      const o = {};
      for (const pair of src) {
        const e2 = { ...env };
        a.names.forEach((n, i) => (e2[n] = pair[i]));
        o[evaluate(a.k, e2)] = evaluate(a.v, e2);
      }
      return o;
    }
    case 'attr': {
      const o = evaluate(a.e, env);
      if (a.name === 'items') return { items: o };
      if (!(a.name in o)) throw new Error('no attribute ' + a.name);
      return o[a.name];
    }
    case 'index': return evaluate(a.e, env)[evaluate(a.i, env)];
    case 'call': {
      const f = evaluate(a.e, env);
      if (f && f.items) return Object.entries(f.items);
      if (f === WIRELESS) return patchWireless(evaluate(a.args[0], env), env);
      throw new Error('unknown call');
    }
    case 'bin': {
      const l = evaluate(a.l, env), r = evaluate(a.r, env);
      if (a.op === '|') return l | r;
      if (a.op === '&') return l & r;
      if (a.op === '-') return l - r;
      if (a.op === '+') return l + r;
      if (a.op === '*') return Array.isArray(l) ? Array.from({ length: r }, () => l).flat() : l * r;
      break;
    }
    case 'inv': return ~evaluate(a.e, env);
    case 'neg': return -evaluate(a.e, env);
    // battery parsers: keep the shape, the driver implements the two known formats
    case 'lambda': return { lambda: lambdaKind(a) };
  }
  throw new Error('cannot evaluate ' + a.t);
}

/** the two battery formats rivalcfg knows: Aerox/Prime (byte 1: bit 7 charging, (rest-1)*5 %) and Rival (byte 0 %, byte 2 charging) */
function lambdaKind(a) {
  const s = JSON.stringify(a.body);
  if (s.includes('"_BATTERY_CHARGING_FLAG"') && s.includes('"v":1')) return s.includes('"op":"*"') ? 'aerox_level' : 'aerox_charging';
  if (s.includes('"v":0') && !s.includes('"op"')) return 'rival_level';
  if (s.includes('"v":2')) return 'rival_charging';
  throw new Error('unknown battery lambda ' + s);
}

// ---------- build ----------
const KEEP = new Set([
  'label', 'description', 'report_type', 'command', 'command_suffix', 'value_type', 'choices', 'input_range', 'output_range',
  'output_choices', 'range_length_byte', 'dpi_length_byte', 'first_preset', 'max_preset_count', 'count_mode', 'xy_mapping',
  'led_id', 'rgbgradient_header', 'rgbgradientv2_header', 'packet_length', 'readback_length', 'buttons', 'button_disable',
  'button_dpi_switch', 'button_scroll_up', 'button_scroll_down', 'button_keyboard', 'button_multimedia', 'button_field_length', 'default',
]);
const cmdInfo = (x) =>
  x && {
    report_type: x.report_type,
    command: x.command,
    ...(x.packet_length ? { packet_length: x.packet_length } : {}),
    ...(x.readback_length ? { readback_length: x.readback_length } : {}),
    ...(x.response_length ? { response_length: x.response_length } : {}),
  };

const profiles = [];
for (const f of readdirSync(dev).filter((n) => n.endsWith('.py') && n !== '__init__.py').sort()) {
  const p = loadModule(join(dev, f)).profile;
  const settings = {};
  for (const [k, s] of Object.entries(p.settings)) {
    const o = {};
    for (const [kk, vv] of Object.entries(s)) {
      if (kk === 'cli') continue;
      if (!KEEP.has(kk)) throw new Error(`unknown setting field ${kk} in ${f}`);
      // choices with string keys keep their order; JSON objects with numeric keys would reorder, so use pairs
      o[kk] = kk === 'choices' || kk === 'output_choices' ? Object.entries(vv).map(([a, b]) => [isNaN(Number(a)) ? a : Number(a), b]) : vv;
    }
    settings[k] = o;
  }
  let battery;
  if (p.battery_level) {
    const b = p.battery_level;
    const fmt = b.level.lambda.startsWith('aerox') ? 'aerox' : 'rival';
    battery = { ...cmdInfo(b), format: fmt };
  }
  profiles.push({
    id: f.replace(/\.py$/, ''),
    name: p.name,
    models: p.models.map((m) => ({ name: m.name, pid: m.product_id, endpoint: m.endpoint })),
    settings,
    ...(p.save_command ? { save: cmdInfo(p.save_command) } : {}),
    ...(p.firmware_version ? { firmware: cmdInfo(p.firmware_version) } : {}),
    ...(battery ? { battery } : {}),
  });
}

const header = `// GENERATED by scripts/steelseries-table.mjs from rivalcfg (https://github.com/flozz/rivalcfg, WTFPL),
// the community-maintained SteelSeries mouse tool. Do not edit by hand: re-run the script.
import type { SsProfile } from './steelseries';

export const SS_PROFILES: SsProfile[] = `;
const out = join(process.cwd(), 'src', 'drivers', 'steelseries-devices.gen.ts');
writeFileSync(out, header + JSON.stringify(profiles, null, 1) + ';\n');
console.log(`${profiles.length} families, ${profiles.reduce((n, p) => n + p.models.length, 0)} models -> ${out}`);
