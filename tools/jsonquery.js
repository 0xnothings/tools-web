#!/usr/bin/env node
// jsonquery.js — fetch JSON and query it with a jq-like path expression.
// Copyright (c) 2026 0xnothings
// @tool jsonquery
// @desc Fetch (or read) JSON and run a jq-like path query with slicing, mapping and filtering
// @usage node tools/jsonquery.js https://api.github.com/users/octocat '.name, .id' --json
// @tags web,api,json
import { args, get, num, flag, die, readInput, readStdin } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`jsonquery — jq-like path resolver for fetched JSON

  node tools/jsonquery.js <url|file|-> [path...] [options]

  Path syntax (a usable subset of jq):
    .user.name                 field access
    .items[0]                  array index (negative allowed)
    .items[-1]
    .items[2:6]                array slice
    .users[].email             map over an array (flattens)
    .users[?age>30]            filter an array by comparison
    .users[?active]            filter by truthiness
    .users | length            pipe to a builtin
    keys, length, type, first, last, flatten, unique, sort, min, max, sum, join(",")

  Options:
    --get <path>      shorthand for the path argument
    --raw             print strings unquoted
    --csv             flatten objects/arrays to CSV
    --count           print only the number of result items
    --header k:v      extra request header (repeatable)
    --timeout <n>     request timeout ms (default 15000)
    --json            machine-readable output (always on for objects)
    -h, --help        this text

  Example:
    node tools/jsonquery.js https://api.github.com/repos/nodejs/node '.topics[]' --raw`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/jsonquery.js <url|file|-> [path] [--json]');

const exprs = [];
function splitTop(text) {
  const out = [];
  let depth = 0, quote = null, buf = '';
  for (const c of String(text)) {
    if (quote) { buf += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
for (const raw of o._.slice(1)) exprs.push(...splitTop(raw));
const ep = get(o, 'get', null);
if (ep && ep !== true) exprs.unshift(...splitTop(String(ep)));
if (!exprs.length) exprs.push('.');
if (exprs.length === 1 && exprs[0].includes('|') && !/[\[]/.test(exprs[0])) { /* pipes are supported in one expression */ }

const headers = { 'user-agent': UA, accept: 'application/json, */*' };
if (o.f.header) {
  for (const raw of [].concat(o.f.header)) {
    const i = String(raw).indexOf(':');
    if (i > 0) headers[String(raw).slice(0, i).trim().toLowerCase()] = String(raw).slice(i + 1).trim();
  }
}

async function load(s) {
  if (/^https?:\/\//i.test(s)) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(1000, num(get(o, 'timeout'), 15000)));
    try {
      const res = await fetch(s, { signal: ctl.signal, redirect: 'follow', headers });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${s}`);
      return { text: await res.text(), origin: res.url };
    } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(t); }
  }
  if (s === '-') return { text: await readStdin(), origin: 'stdin' };
  return { text: await readInput(s), origin: s };
}

const loaded = await load(src);
let doc;
try { doc = JSON.parse(loaded.text); } catch (e) { die(`invalid JSON from ${loaded.origin}: ${e.message}`); }

/* ---------- path engine ---------- */

function tokenizePath(src) {
  const parts = [];
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '.') {
      if (buf.trim()) { parts.push({ kind: 'expr', text: buf.trim() }); buf = ''; }
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(src.slice(i));
      if (m) { parts.push({ kind: 'field', name: m[1] }); i += m[0].length; continue; }
      i++; continue;
    }
    if (c === '[') {
      if (buf.trim()) { parts.push({ kind: 'expr', text: buf.trim() }); buf = ''; }
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') { depth--; if (!depth) break; }
      }
      parts.push({ kind: 'bracket', text: src.slice(i + 1, j) });
      i = j + 1; continue;
    }
    if (c === '|') {
      if (buf.trim()) { parts.push({ kind: 'expr', text: buf.trim() }); buf = ''; }
      parts.push({ kind: 'pipe' });
      i++; continue;
    }
    buf += c; i++;
  }
  if (buf.trim()) parts.push({ kind: 'expr', text: buf.trim() });
  return parts;
}

const BUILTINS = {
  keys: (v) => (v && typeof v === 'object' ? Object.keys(v) : []),
  values: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v) : v),
  length: (v) => (v == null ? 0 : typeof v === 'string' || Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : 1),
  type: (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  flatten: (v) => (Array.isArray(v) ? v.flat(Infinity) : v),
  unique: (v) => (Array.isArray(v) ? [...new Set(v.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x)) : v),
  sort: (v) => (Array.isArray(v) ? [...v].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : v),
  min: (v) => (Array.isArray(v) ? Math.min(...v.filter((x) => typeof x === 'number')) : v),
  max: (v) => (Array.isArray(v) ? Math.max(...v.filter((x) => typeof x === 'number')) : v),
  sum: (v) => (Array.isArray(v) ? v.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) : v),
  tostring: (v) => (typeof v === 'string' ? v : JSON.stringify(v)),
  tonumber: (v) => Number(v),
  not: (v) => !v,
};

function parseCall(text) {
  const m = /^([a-zA-Z_][\w]*)\s*\((.*)\)$/s.exec(text.trim());
  if (!m) return null;
  const argText = m[2].trim();
  let arg = null;
  if (argText) {
    try { arg = JSON.parse(argText); }
    catch { arg = argText.replace(/^["']|["']$/g, ''); }
  }
  return { name: m[1], arg };
}

function applyGate(value, gate) {
  const g = gate.trim();
  if (!g) return value;
  if (g === '*') return value;
  const cmp = g.match(/^([A-Za-z_$][\w$]*|\.?[\w$.]+)\s*(==|!=|>=|<=|>|<|=~)\s*(.+)$/);
  if (cmp) {
    const field = cmp[1].replace(/^\./, '');
    const op = cmp[2] === '=' ? '==' : cmp[2];
    let rhs;
    try { rhs = JSON.parse(cmp[3]); } catch { rhs = cmp[3].replace(/^["']|["']$/g, ''); }
    const list = Array.isArray(value) ? value : [value];
    return list.filter((it) => {
      const lhs = field === '' ? it : field.split('.').reduce((a, k) => (a == null ? undefined : a[k]), it);
      switch (op) {
        case '==': return lhs === rhs || String(lhs) === String(rhs);
        case '!=': return !(lhs === rhs || String(lhs) === String(rhs));
        case '>': return lhs > rhs;
        case '<': return lhs < rhs;
        case '>=': return lhs >= rhs;
        case '<=': return lhs <= rhs;
        case '=~': try { return new RegExp(String(rhs)).test(String(lhs)); } catch { return false; }
        default: return false;
      }
    });
  }
  if (g.endsWith(',')) {
    const wanted = g.slice(0, -1).split(',').map((s) => s.trim());
    const list = Array.isArray(value) ? value : [value];
    return list.filter((it) => wanted.some((w) => it != null && w in it));
  }
  const list = Array.isArray(value) ? value : [value];
  const field = g.replace(/^\./, '');
  const picked = list.map((it) => (it && typeof it === 'object' ? field.split('.').reduce((a, k) => (a == null ? undefined : a[k]), it) : undefined));
  return picked.every((x) => x === undefined) ? value : picked.filter((x) => x !== undefined);
}

function runStep(value, step) {
  if (step.kind === 'field') {
    if (Array.isArray(value)) return value.map((v) => (v == null ? null : v[step.name]));
    return value == null ? null : value[step.name];
  }
  if (step.kind === 'bracket') {
    const body = step.text.trim();
    if (body === '' || body === '*') return value;
    if (body.startsWith('?')) return applyGate(value, body.slice(1));
    const slice = body.match(/^(-?\d+)?\s*:\s*(-?\d+)?$/);
    if (slice) {
      if (!Array.isArray(value)) return value;
      return value.slice(slice[1] === undefined ? undefined : Number(slice[1]), slice[2] === undefined ? undefined : Number(slice[2]));
    }
    if (/^-?\d+$/.test(body)) {
      const n = Number(body);
      if (!Array.isArray(value)) return value;
      return value[n < 0 ? value.length + n : n];
    }
    if (/^["']/.test(body)) {
      const key = body.replace(/^["']|["']$/g, '');
      if (Array.isArray(value)) return value.map((v) => (v == null ? null : v[key]));
      return value == null ? null : value[key];
    }
    const call = parseCall(body);
    if (call) return runCall(value, call);
    return applyGate(value, body);
  }
  if (step.kind === 'expr') {
    const e = step.text.trim();
    if (BUILTINS[e]) return BUILTINS[e](value);
    const call = parseCall(e);
    if (call) return runCall(value, call);
    if (e === '.[]' || e === '[]') return Array.isArray(value) ? value : Object.values(value ?? {});
    return value;
  }
  return value;
}

function runCall(value, call) {
  const { name, arg } = call;
  if (name === 'join') return Array.isArray(value) ? value.join(arg ?? ',') : String(value);
  if (name === 'map') {
    if (!Array.isArray(value)) return value;
    const parts = tokenizePath(String(arg ?? '.'));
    return value.map((v) => parts.reduce((acc, p) => runStep(acc, p), v));
  }
  if (name === 'select') return applyGate(value, String(arg ?? ''));
  if (name === 'contains') return Array.isArray(value) ? value : value;
  if (name === 'startswith') return typeof value === 'string' ? value.startsWith(String(arg)) : false;
  if (name === 'split') return typeof value === 'string' ? value.split(String(arg)) : value;
  if (BUILTINS[name]) return BUILTINS[name](value, arg);
  return value;
}

function runPath(doc, expr) {
  const steps = tokenizePath(expr);
  if (!steps.length) return doc;
  let acc = doc;
  let grouped = [];
  let first = true;
  for (const step of steps) {
    if (step.kind === 'pipe') { grouped.push(acc); first = true; continue; }
    acc = runStep(acc, step);
  }
  return acc;
}

const results = exprs.map((e) => {
  try { return { expr: e, ok: true, value: runPath(doc, e) }; }
  catch (err) { return { expr: e, ok: false, error: err.message }; }
});

const forFail = results.find((r) => !r.ok);
if (forFail) die(`query error on ${forFail.expr}: ${forFail.error}`);

const values = results.map((r) => r.value);
const single = values.length === 1;

if (flag(o, 'count')) {
  const v = single ? values[0] : values;
  const n = Array.isArray(v) ? v.length : v == null ? 0 : 1;
  if (flag(o, 'json')) console.log(JSON.stringify({ count: n }, null, 2)); else console.log(n);
  process.exitCode = 0;
} else {

function toCsv(v) {
  const rows = Array.isArray(v) ? v : [v];
  const objs = rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  const cols = [...new Set(objs.flatMap((x) => Object.keys(x)))];
  const cell = (x) => {
    if (x === null || x === undefined) return '';
    const s = typeof x === 'object' ? JSON.stringify(x) : String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...objs.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

if (flag(o, 'csv')) {
  console.log(toCsv(single ? values[0] : values));
} else if (flag(o, 'raw')) {
  const print = (v) => {
    if (typeof v === 'string') console.log(v);
    else if (Array.isArray(v)) v.forEach(print);
    else console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
  };
  if (single) print(values[0]); else values.forEach(print);
} else if (single) {
  console.log(JSON.stringify(values[0], null, 2));
} else {
  console.log(JSON.stringify(Object.fromEntries(results.map((r, i) => [`q${i + 1}: ${r.expr}`, r.value])), null, 2));
}
}
process.exitCode = 0;

