// contractcheck.js — validate a JSON response against a JSON Schema file.
// Copyright (c) 2026 0xnothings
// @tool contractcheck
// @desc Validate a live or on-disk JSON document against a JSON Schema and report every violation with its exact JSON path and the rule that failed
// @usage node tools/contractcheck.js https://api.example.com/items item.schema.json
// @tags api,json,validation
import { args, get, num, flag, die, readInput } from '../_lib.js';
import { readFileSync } from 'node:fs';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`contractcheck — JSON Schema validation

  node tools/contractcheck.js <document> <schema.json> [options]

  document: URL, file path, or '-' for stdin
  schema:   file path (or URL)

  --max-errors <n>  stop after n violations (default 25)
  --strict          also fail on additionalProperties not listed in the schema
  --json            machine-readable output
  -h, --help        this text

  Supported keywords: type, properties, required, items, enum, const, minimum,
  maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern,
  format (date-time/email/uri/uuid), minItems, maxItems, uniqueItems,
  additionalProperties, anyOf, oneOf, allOf, not, nullable.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const [docArg, schemaArg] = o._;
if (!docArg || !schemaArg) die('usage: node tools/contractcheck.js <document> <schema.json>');

async function loadJson(t, accept = 'application/json, */*') {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { json: JSON.parse(await res.text()), final: res.url };
    } catch (e) {
      if (e instanceof SyntaxError) die(`response is not JSON: ${e.message.slice(0, 80)}`);
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  const text = await readInput(t === '-' ? null : t);
  try { return { json: JSON.parse(text), final: t }; } catch (e) { die(`document is not JSON: ${e.message.slice(0, 80)}`); }
}

const doc = await loadJson(docArg);
let schema;
try { schema = JSON.parse(readFileSync(schemaArg, 'utf8')); } catch (e) { die(`schema unreadable: ${e.message.slice(0, 100)}`); }

const maxErrors = Math.max(1, num(get(o, 'max-errors'), 25));
const strict = flag(o, 'strict');
const errors = [];

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const typeOk = (v, t) => {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  if (t === 'null') return actual === 'null';
  return actual === t;
};

function fail(path, keyword, message, extra = {}) {
  if (errors.length < maxErrors) errors.push({ path: path || '$', keyword, message, ...extra });
}

function validate(value, sch, path) {
  if (errors.length >= maxErrors) return;
  if (!sch || typeof sch !== 'object') return;

  if (sch.nullable === true && value === null) return;
  if (sch.const !== undefined && JSON.stringify(value) !== JSON.stringify(sch.const)) {
    fail(path, 'const', `expected const ${JSON.stringify(sch.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(sch.enum) && !sch.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    fail(path, 'enum', `value ${JSON.stringify(value).slice(0, 40)} not in ${JSON.stringify(sch.enum).slice(0, 60)}`);
  }
  if (sch.type) {
    const types = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!types.some((t) => typeOk(value, t))) {
      fail(path, 'type', `expected ${types.join('|')}, got ${typeOf(value)}`, { expected: types, actual: typeOf(value) });
      return;
    }
  }

  if (typeof value === 'string') {
    if (sch.minLength !== undefined && value.length < sch.minLength) fail(path, 'minLength', `length ${value.length} < ${sch.minLength}`);
    if (sch.maxLength !== undefined && value.length > sch.maxLength) fail(path, 'maxLength', `length ${value.length} > ${sch.maxLength}`);
    if (sch.pattern) {
      let re;
      try { re = new RegExp(sch.pattern); } catch { re = null; }
      if (re && !re.test(value)) fail(path, 'pattern', `"${value.slice(0, 30)}" fails /${sch.pattern}/`);
    }
    if (sch.format) {
      const checks = {
        'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s)),
        date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
        email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s),
        uri: (s) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(s),
        uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
        ipv4: (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255),
      };
      const fn = checks[sch.format];
      if (fn && !fn(value)) fail(path, 'format', `"${value.slice(0, 40)}" is not a valid ${sch.format}`);
    }
  }

  if (typeof value === 'number') {
    if (sch.minimum !== undefined && value < sch.minimum) fail(path, 'minimum', `${value} < ${sch.minimum}`);
    if (sch.maximum !== undefined && value > sch.maximum) fail(path, 'maximum', `${value} > ${sch.maximum}`);
    if (sch.exclusiveMinimum !== undefined && value <= sch.exclusiveMinimum) fail(path, 'exclusiveMinimum', `${value} <= ${sch.exclusiveMinimum}`);
    if (sch.exclusiveMaximum !== undefined && value >= sch.exclusiveMaximum) fail(path, 'exclusiveMaximum', `${value} >= ${sch.exclusiveMaximum}`);
    if (sch.multipleOf !== undefined && value % sch.multipleOf !== 0) fail(path, 'multipleOf', `${value} is not a multiple of ${sch.multipleOf}`);
  }

  if (Array.isArray(value)) {
    if (sch.minItems !== undefined && value.length < sch.minItems) fail(path, 'minItems', `${value.length} items < ${sch.minItems}`);
    if (sch.maxItems !== undefined && value.length > sch.maxItems) fail(path, 'maxItems', `${value.length} items > ${sch.maxItems}`);
    if (sch.uniqueItems) {
      const seen = new Set();
      for (const v of value) {
        const k = JSON.stringify(v);
        if (seen.has(k)) fail(path, 'uniqueItems', `duplicate element ${k.slice(0, 30)}`);
        seen.add(k);
      }
    }
    if (sch.items && typeof sch.items === 'object') {
      value.forEach((v, i) => validate(v, sch.items, `${path}[${i}]`));
    } else if (Array.isArray(sch.items)) {
      sch.items.forEach((s, i) => { if (i < value.length) validate(value[i], s, `${path}[${i}]`); });
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(sch.required)) {
      for (const k of sch.required) if (!Object.prototype.hasOwnProperty.call(value, k)) fail(path, 'required', `missing required property "${k}"`, { property: k });
    }
    const props = sch.properties || {};
    for (const [k, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${k}` : k;
      if (props[k]) validate(v, props[k], childPath);
      else if (sch.additionalProperties === false || (strict && sch.additionalProperties === undefined && Object.keys(props).length)) {
        fail(path, 'additionalProperties', `unexpected property "${k}"`, { property: k });
      } else if (typeof sch.additionalProperties === 'object') validate(v, sch.additionalProperties, childPath);
      if (sch.patternProperties) {
        for (const [pat, sub] of Object.entries(sch.patternProperties)) {
          try { if (new RegExp(pat).test(k)) validate(v, sub, childPath); } catch { /* ignore bad pattern */ }
        }
      }
    }
    if (sch.minProperties !== undefined && Object.keys(value).length < sch.minProperties) fail(path, 'minProperties', `only ${Object.keys(value).length} properties`);
    if (sch.maxProperties !== undefined && Object.keys(value).length > sch.maxProperties) fail(path, 'maxProperties', `${Object.keys(value).length} properties > ${sch.maxProperties}`);
    if (sch.dependencies) {
      for (const [k, dep] of Object.entries(sch.dependencies)) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        if (Array.isArray(dep)) for (const d of dep) if (!Object.prototype.hasOwnProperty.call(value, d)) fail(path, 'dependencies', `"${k}" requires "${d}"`);
        else validate(value, dep, path);
      }
    }
  }

  if (Array.isArray(sch.allOf)) for (const s of sch.allOf) validate(value, s, path);
  if (Array.isArray(sch.anyOf)) {
    const before = errors.length;
    let ok = false;
    for (const s of sch.anyOf) { const snapshot = errors.length; validate(value, s, path); if (errors.length === snapshot) { ok = true; break; } errors.length = snapshot; }
    if (!ok) fail(path, 'anyOf', 'value matches none of the anyOf branches');
    else errors.length = before;
  }
  if (Array.isArray(sch.oneOf)) {
    let matches = 0;
    for (const s of sch.oneOf) { const snapshot = errors.length; validate(value, s, path); if (errors.length === snapshot) matches++; errors.length = snapshot; }
    if (matches !== 1) fail(path, 'oneOf', `value matches ${matches} of the oneOf branches (expected exactly 1)`);
  }
  if (sch.not) {
    const snapshot = errors.length;
    validate(value, sch.not, path);
    if (errors.length === snapshot) fail(path, 'not', 'value matches a schema it must not match');
    errors.length = snapshot;
  }
}

validate(doc.json, schema, '');
const valid = errors.length === 0;
const truncated = errors.length >= maxErrors;

if (flag(o, 'json')) {
  console.log(JSON.stringify({ document: doc.final, schema: schemaArg, title: schema.title || null, valid, errorCount: errors.length, truncated, errors }, null, 2));
} else {
  console.log(`document: ${doc.final}`);
  console.log(`schema:   ${schemaArg}${schema.title ? ` (${schema.title})` : ''}\n`);
  if (valid) {
    console.log('VALID — the document satisfies every constraint in the schema');
  } else {
    console.log(`INVALID — ${errors.length} violation(s)${truncated ? ` (stopped at --max-errors ${maxErrors})` : ''}\n`);
    for (const e of errors) {
      console.log(`  ${e.path}`);
      console.log(`    [${e.keyword}] ${e.message}`);
    }
    const byKeyword = errors.reduce((m, e) => m.set(e.keyword, (m.get(e.keyword) || 0) + 1), new Map());
    console.log('\nby keyword: ' + [...byKeyword.entries()].map(([k, v]) => `${k}(${v})`).join(' '));
  }
}
process.exitCode = valid ? 0 : 1;
