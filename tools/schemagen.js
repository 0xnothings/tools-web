// schemagen.js — infer a JSON Schema (draft-07 subset) from sample JSON.
// Copyright (c) 2026 0xnothings
// @tool schemagen
// @desc Merge one or more JSON samples into a draft-07 schema with required-field detection, enum inference for repeating literals and format hints for dates, emails and URLs
// @usage node tools/schemagen.js sample.json second-sample.json --title Item
// @tags api,json,schema
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`schemagen — JSON sample to JSON Schema

  node tools/schemagen.js <sample...> [options]

  each sample: URL, file path, or '-'

  --title <text>     schema title (default: derived from the first input name)
  --id <uri>         value for $id
  --draft <n>        draft version label (default 07)
  --no-required      omit the required array entirely
  --enum-max <n>     infer enum when a string field has <= n distinct values (default 6)
  --json             machine-readable output
  -h, --help         this text

  Multiple samples widen the inferred type set and reveal optional fields.`); 
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

const inputs = o._.length ? o._ : [];
if (!inputs.length) die('usage: node tools/schemagen.js <sample.json> [more.json]');

const samples = [];
for (const inp of inputs) {
  const text = await load(inp);
  try { samples.push(JSON.parse(text)); } catch (e) { die(`not JSON (${inp}): ${e.message.slice(0, 80)}`); }
}

const enumMax = Math.max(1, num(get(o, 'enum-max'), 6));
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URI_RE = /^https?:\/\/[^\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function mergeTypeSet(values) {
  const types = new Set(values.map(typeOf));
  if (types.has('integer') && types.has('number')) types.delete('integer');
  if (types.size === 1) return [...types][0];
  return [...types].sort();
}

function infer(values) {
  const flat = values.filter((v) => v !== undefined);
  if (!flat.length) return {};
  const nonNull = flat.filter((v) => v !== null);
  const t = mergeTypeSet(flat);
  const schema = {};

  if (Array.isArray(t)) {
    /* union of several types */
    schema.type = t.filter((x) => x !== 'null');
    if (t.includes('null')) schema.nullable = true;
  } else if (t === 'null') {
    schema.type = 'null';
    return schema;
  } else {
    schema.type = t;
    if (flat.includes(null)) { schema.type = [t, 'null']; }
  }

  if (nonNull.length && nonNull.every((v) => typeof v === 'object' && !Array.isArray(v))) {
    const keys = [...new Set(nonNull.flatMap((v) => Object.keys(v)))];
    const required = keys.filter((k) => nonNull.every((v) => Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined));
    schema.properties = {};
    for (const k of keys) schema.properties[k] = infer(nonNull.map((v) => v[k]));
    if (!flag(o, 'no-required') && required.length) schema.required = required;
    schema.additionalProperties = false;
    return schema;
  }

  if (nonNull.length && nonNull.every((v) => Array.isArray(v))) {
    const all = nonNull.flat();
    schema.items = all.length ? infer(all) : {};
    const lens = nonNull.map((a) => a.length);
    if (new Set(lens).size === 1) schema.minItems = lens[0];
    return schema;
  }

  const strs = nonNull.filter((v) => typeof v === 'string');
  if (strs.length && strs.length === nonNull.length) {
    const distinct = [...new Set(strs)];
    if (distinct.every((s) => DATE_RE.test(s))) { schema.type = 'string'; schema.format = 'date-time'; return schema; }
    if (distinct.every((s) => EMAIL_RE.test(s))) { schema.format = 'email'; return schema; }
    if (distinct.every((s) => UUID_RE.test(s))) { schema.format = 'uuid'; return schema; }
    if (distinct.every((s) => URI_RE.test(s))) { schema.format = 'uri'; return schema; }
    if (distinct.length <= enumMax && distinct.length > 1 && strs.length > distinct.length) schema.enum = distinct;
    else if (distinct.length <= 3 && distinct.length > 1 && distinct.every((s) => s.length < 16 && !/\d{4}-\d{2}-\d{2}/.test(s) && !s.includes('@'))) schema.enum = distinct;
    else {
      const minLen = Math.min(...distinct.map((s) => s.length));
      const maxLen = Math.max(...distinct.map((s) => s.length));
      if (minLen === maxLen && minLen > 0) schema.minLength = minLen;
      const pattern = distinct.length > 1 ? distinct[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+') : null;
      if (pattern && distinct.every((s) => new RegExp('^' + pattern + '$').test(s))) schema.pattern = pattern;
    }
    return schema;
  }

  const nums = nonNull.filter((v) => typeof v === 'number');
  if (nums.length && nums.length === nonNull.length) {
    if (nums.length > 2) { schema.minimum = Math.min(...nums); schema.maximum = Math.max(...nums); }
    return schema;
  }

  const bools = nonNull.filter((v) => typeof v === 'boolean');
  if (bools.length === nonNull.length && nonNull.length) {
    if (new Set(bools).size === 1) schema.enum = [bools[0]];
    return schema;
  }
  return schema;
}

const rootValues = samples;
const schema = { $schema: `http://json-schema.org/draft-0${num(get(o, 'draft'), 7)}/schema#` };
const title = get(o, 'title', null) || (() => {
  const first = inputs[0];
  try { const u = new globalThis.URL(first); return u.pathname.replace(/\/$/, '').split('/').pop() || 'root'; } catch { return first.split(/[\\/]/).pop().replace(/\.json$/i, '') || 'root'; }
})();
schema.title = String(title);
if (get(o, 'id', null)) schema.$id = String(get(o, 'id'));
Object.assign(schema, infer(rootValues));

const stats = { samples: samples.length, properties: 0, required: 0, enums: 0, formats: 0 };
(function count(node) {
  if (!node || typeof node !== 'object') return;
  if (node.properties) {
    stats.properties += Object.keys(node.properties).length;
    stats.required += (node.required || []).length;
    for (const v of Object.values(node.properties)) count(v);
  }
  if (node.items) count(node.items);
  if (node.enum) stats.enums++;
  if (node.format) stats.formats++;
})(schema);

if (flag(o, 'json')) {
  console.log(JSON.stringify({ inputs, stats, schema }, null, 2));
} else {
  console.log(JSON.stringify(schema, null, 2));
  process.stderr.write(`\n${stats.samples} sample(s) -> ${stats.properties} propert(ies), ${stats.required} required, ${stats.enums} enum(s), ${stats.formats} format hint(s)\n`);
}
