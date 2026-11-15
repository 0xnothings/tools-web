// mockjson.js — infer a deterministic mock-JSON generator from a sample payload.
// Copyright (c) 2026 0xnothings
// @tool mockjson
// @desc Learn the shape of a sample JSON payload and emit a seeded generator script plus ready-generated mock records with realistic value substitution per field name
// @usage node tools/mockjson.js sample.json --count 5 --seed 42
// @tags api,mock,json
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`mockjson — sample payload to mock generator

  node tools/mockjson.js <url|file|-> [options]

  --count <n>    how many records to generate (default 3)
  --seed <n>     deterministic PRNG seed (default 1)
  --script       emit a standalone generator module instead of sample data
  --keep-values  reuse literal values from the sample instead of synthesising
  --json         machine-readable output
  -h, --help     this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json, */*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

const text = await load(o._[0] || die('usage: node tools/mockjson.js <url|file|->'));
let sample;
try { sample = JSON.parse(text); } catch (e) { die(`not JSON: ${e.message.slice(0, 90)}`); }

/* mulberry32 — deterministic, seedable */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = num(get(o, 'seed'), 1) >>> 0;
const count = Math.max(1, num(get(o, 'count'), 3));
const keepValues = flag(o, 'keep-values');
const keepList = [];

const FIRST = ['Ada', 'Kenji', 'Priya', 'Mateo', 'Zola', 'Ingrid', 'Tomas', 'Nadia', 'Rustam', 'Chidi'];
const LAST = ['Lovelace', 'Tanaka', 'Sharma', 'Vega', 'Nkosi', 'Bergman', 'Novak', 'Haddad', 'Aliyev', 'Okonkwo'];
const WORDS = ['relay', 'collector', 'trail', 'pipe', 'frame', 'wire', 'grain', 'scent', 'nest', 'hum', 'cable', 'junction'];
const DOMAINS = ['example.com', 'coldwire.dev', 'nest.local'];
const TAGS = ['alpha', 'beta', 'gamma', 'stable', 'pilot'];

function mockFor(key, kind, sampleValue, rand) {
  if (keepValues && sampleValue !== undefined) return sampleValue;
  const k = String(key).toLowerCase();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  if (k.includes('email')) return `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${int(1, 99)}@${pick(DOMAINS)}`;
  if (k.includes('firstname') || k === 'first_name') return pick(FIRST);
  if (k.includes('lastname') || k === 'last_name') return pick(LAST);
  if (k.includes('name') && (k.includes('user') || k.includes('author') || k.includes('full') || k === 'name')) return `${pick(FIRST)} ${pick(LAST)}`;
  if (k.includes('company') || k.includes('org')) return `${pick(LAST)} ${pick(['Labs', 'Works', 'Group', 'Systems'])}`;
  if (k.includes('url') || k.includes('href') || k.includes('link')) return `https://${pick(DOMAINS)}/${pick(WORDS)}/${int(1, 999)}`;
  if (k.includes('image') || k.includes('avatar') || k.includes('photo')) return `https://cdn.${pick(DOMAINS)}/img/${int(1, 999)}.png`;
  if (k.includes('id') || k.endsWith('_id') || k === 'uuid') {
    if (typeof sampleValue === 'number') return int(1, 100000);
    if (typeof sampleValue === 'string' && /^[0-9a-f-]{36}$/i.test(sampleValue)) return `${int(10000000, 99999999)}-${int(1000, 9999)}-4${int(100, 999)}-a${int(100, 999)}-${int(100000000000, 999999999999)}`;
    return (typeof sampleValue === 'string') ? `id_${int(1000, 999999)}` : int(1, 9999);
  }
  if (k.includes('date') || k.includes('time') || k.includes('_at') || k.includes('created') || k.includes('updated')) return new Date(Date.UTC(2025, 0, 1) + int(0, 365) * 86400000 + int(0, 86399) * 1000).toISOString();
  if (k.includes('country')) return pick(['US', 'DE', 'JP', 'BR', 'ID', 'NG']);
  if (k.includes('city')) return pick(['Berlin', 'Osaka', 'Lisbon', 'Nairobi', 'Medan']);
  if (k.includes('price') || k.includes('amount') || k.includes('total') || k.includes('cost')) return Number((int(100, 99999) / 100).toFixed(2));
  if (k.includes('count') || k.includes('qty') || k.includes('quantity') || k.includes('stock') || k.includes('views') || k.includes('likes')) return int(0, 5000);
  if (k.includes('age') || k.includes('year')) return int(18, 80);
  if (k.includes('rating') || k.includes('score')) return Number((rand() * 5).toFixed(1));
  if (k.includes('lat')) return Number((rand() * 180 - 90).toFixed(6));
  if (k.includes('lng') || k.includes('lon')) return Number((rand() * 360 - 180).toFixed(6));
  if (k.includes('country')) return pick(['US', 'DE', 'JP', 'BR', 'ID', 'NG']);
  if (k.includes('city')) return pick(['Berlin', 'Osaka', 'Lisbon', 'Nairobi', 'Medan']);
  if (k.includes('phone') || k.includes('tel')) return `+1${int(2000000000, 9999999999)}`;
  if (k.includes('slug')) return `${pick(WORDS)}-${pick(WORDS)}-${int(10, 99)}`;
  if (k.includes('title') || k.includes('subject') || k.includes('headline')) return `${pick(WORDS)} ${pick(['notes', 'report', 'guide', 'log'])} ${int(1, 99)}`;
  if (k.includes('description') || k.includes('summary') || k.includes('body') || k.includes('content')) return `Generated ${pick(WORDS)} text for testing, ${int(3, 9)} sentences of sample prose.`;
  if (k.includes('tag') || k.includes('label') || k.includes('category')) return pick(TAGS);
  if (k.includes('status')) return pick(['active', 'pending', 'archived']);
  if (k.includes('color')) return `#${int(0x100000, 0xffffff).toString(16)}`;
  if (k.includes('hash') || k.includes('token') || k.includes('key')) return Array.from({ length: 24 }, () => '0123456789abcdef'[int(0, 15)]).join('');
  if (kind === 'boolean') return rand() > 0.5;
  if (kind === 'integer') return int(1, 1000);
  if (kind === 'number') return Number((rand() * 1000).toFixed(2));
  if (kind === 'string') return `${pick(WORDS)}-${int(1, 999)}`;
  return sampleValue;
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function generate(template, rand, key = '') {
  const kind = kindOf(template);
  if (kind === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = generate(v, rand, k);
    return out;
  }
  if (kind === 'array') {
    const n = flag(o, 'keep-values') ? template.length : Math.max(1, Math.min(3, template.length || 1));
    const proto = template[0] ?? '';
    return Array.from({ length: n }, () => generate(proto, rand, key));
  }
  if (kind === 'null') return null;
  return mockFor(key, kind, template, rand);
}

function schemaOf(template, key = '', depth = 0) {
  const kind = kindOf(template);
  if (kind === 'object') {
    const fields = Object.entries(template).map(([k, v]) => ({ field: k, type: kindOf(v), ...schemaOf(v, k, depth + 1) }));
    return { fields };
  }
  if (kind === 'array') return { items: template.length ? schemaOf(template[0], key, depth + 1) : { type: 'unknown' }, type: 'array' };
  return { type: kind, mockStrategy: keepValues ? 'sample value' : 'by field name' };
}

const rand = rng(seed);
const records = Array.from({ length: count }, () => generate(sample, rand));

if (flag(o, 'script')) {
  const body = `// mockdata.js — generated by tools/mockjson.js from a ${Array.isArray(sample) ? `array of ${sample.length}` : 'object'} sample.
// Deterministic: same seed always yields the same records.

const FIRST = ${JSON.stringify(FIRST)};
const LAST = ${JSON.stringify(LAST)};
const WORDS = ${JSON.stringify(WORDS)};
const TEMPLATE = ${JSON.stringify(Array.isArray(sample) ? (sample[0] ?? {}) : sample, null, 2)};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function generate(count = ${count}, seed = ${seed}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const walk = (tpl, key = '') => {
    if (Array.isArray(tpl)) { const n = Math.max(1, Math.min(3, tpl.length || 1)); return Array.from({ length: n }, () => walk(tpl[0] ?? '', key)); }
    if (tpl && typeof tpl === 'object') { const o = {}; for (const [k, v] of Object.entries(tpl)) o[k] = walk(v, k); return o; }
    if (tpl === null) return null;
    const k = String(key).toLowerCase();
    if (k.includes('name')) return \`\${pick(FIRST)} \${pick(LAST)}\`;
    if (k.includes('email')) return \`\${pick(FIRST).toLowerCase()}.\${pick(LAST).toLowerCase()}\${int(1, 99)}@example.com\`;
    if (k.includes('id')) return typeof tpl === 'number' ? int(1, 99999) : \`id_\${int(1000, 999999)}\`;
    if (k.includes('date') || k.includes('time') || k.includes('_at')) return new Date(Date.UTC(2025, 0, 1) + int(0, 365) * 86400000).toISOString();
    if (k.includes('price') || k.includes('amount')) return Number((int(100, 99999) / 100).toFixed(2));
    if (typeof tpl === 'boolean') return rand() > 0.5;
    if (typeof tpl === 'number') return Number.isInteger(tpl) ? int(1, 1000) : Number((rand() * 100).toFixed(2));
    if (typeof tpl === 'string') return \`\${pick(WORDS)}-\${int(1, 999)}\`;
    return tpl;
  };
  const base = walk(TEMPLATE);
  void base;
  return Array.from({ length: count }, () => walk(TEMPLATE));
}

if (process.argv[1] && process.argv[1].endsWith('mockdata.js')) console.log(JSON.stringify(generate(${count}, ${seed}), null, 2));
`;
  if (flag(o, 'json')) console.log(JSON.stringify({ source: o._[0], seed, count, template: Array.isArray(sample) ? sample[0] : sample, script: body }, null, 2));
  else process.stdout.write(body);
} else if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: o._[0], seed, count, rootType: Array.isArray(sample) ? `array[${sample.length}]` : 'object', shape: schemaOf(sample), generated: records }, null, 2));
} else {
  console.log(`${o._[0]} — seed ${seed}, ${count} record(s), template ${Array.isArray(sample) ? `array[${sample.length}]` : 'object'}\n`);
  console.log(JSON.stringify(records, null, 2));
  console.log('\n--script emits a standalone generator module; --seed changes the values');
}
