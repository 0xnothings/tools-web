#!/usr/bin/env node
// apidoc.js — generate markdown API docs from a live JSON response sample.
// Copyright (c) 2026 0xnothings
// @tool apidoc
// @desc Fetch a JSON endpoint, infer the response shape, and emit markdown documentation with types, nesting, nullability and example values
// @usage node tools/apidoc.js https://api.example.com/v1/items --title Items
// @tags api,docs,json
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`apidoc — JSON response to markdown docs

  node tools/apidoc.js <url|file|-> [options]

  --title <text>    endpoint title for the heading (default: derived from the path)
  --method <verb>   HTTP method to document (default GET)
  --desc <text>     one-line description to place under the heading
  --status <code>   response status to document (default 200)
  --merge <path>    second sample to merge into the shape (catches optional fields)
  --json            wrap the markdown in JSON ({ markdown, shape })
  -h, --help        this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json, */*' } });
      const text = await res.text();
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { text, final: res.url, status: res.status, type: res.headers.get('content-type') || '' };
    } catch (e) {
      if (e && e.code) throw e;
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  const text = await readInput(t === '-' ? null : t);
  return { text, final: t, status: null, type: '' };
}

const src = o._[0] || die('usage: node tools/apidoc.js <url|file|->');
const { text, final, status, type } = await load(src);
let parsed;
try { parsed = JSON.parse(text); } catch (e) { die(`response is not JSON: ${e.message.slice(0, 90)}`); }

function scalarType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

function shapeOf(value, path = '', depth = 0) {
  if (depth > 8) return { path, type: 'object', depth };
  const t = scalarType(value);
  if (t === 'array') {
    const items = value.slice(0, 50);
    const types = [...new Set(items.map(scalarType))];
    const elemShape = items.length && types[0] === 'object' ? mergeShapes(items.filter((x) => x && typeof x === 'object')) : null;
    return { path, type: 'array', length: value.length, itemTypes: types, element: elemShape ? shapeOf(elemShape, path + '[]', depth + 1) : { path: path + '[]', type: types[0] || 'unknown' } };
  }
  if (t === 'object') {
    const children = Object.entries(value).map(([k, v]) => shapeOf(v, k, depth + 1));
    return { path, type: 'object', children };
  }
  return { path, type: t, example: t === 'string' ? value.slice(0, 60) : value, depth };
}

function mergeShapes(objs) {
  const out = {};
  const keys = new Set(objs.flatMap((x) => Object.keys(x)));
  for (const k of keys) {
    const vals = objs.map((x) => x[k]).filter((v) => v !== undefined);
    const first = vals[0];
    if (first && typeof first === 'object' && !Array.isArray(first) && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) out[k] = mergeShapes(vals);
    else if (Array.isArray(first)) {
      const flat = vals.filter(Array.isArray).flat();
      out[k] = flat.length && typeof flat[0] === 'object' ? [mergeShapes(flat.filter((x) => x && typeof x === 'object'))] : first;
    } else out[k] = first;
  }
  return out;
}

let merged = parsed;
const mergeSrc = get(o, 'merge', null);
if (mergeSrc) {
  const second = await load(String(mergeSrc));
  try {
    const b = JSON.parse(second.text);
    merged = (Array.isArray(parsed) && Array.isArray(b)) ? [mergeShapes([...parsed, ...b].filter((x) => x && typeof x === 'object'))] : mergeShapes([parsed, b].filter((x) => x && typeof x === 'object'));
  } catch (e) { die(`--merge sample is not JSON: ${e.message.slice(0, 70)}`); }
}

const root = shapeOf(merged);
const rows = [];
const nullable = [];
(function walk(node, prefix) {
  if (node.type === 'object') {
    for (const c of node.children || []) {
      rows.push({ path: prefix ? `${prefix}.${c.path}` : c.path, type: c.type === 'array' ? `array[${c.length}]` : c.type, example: c.type === 'object' ? '{...}' : c.type === 'array' ? `[${c.length}]` : String(c.example ?? '') });
      walk(c, prefix ? `${prefix}.${c.path}` : c.path);
    }
  } else if (node.type === 'array' && node.element) {
    if (node.element.type === 'object') {
      for (const c of node.element.children || []) {
        rows.push({ path: `${prefix}[].${c.path}`, type: c.type === 'array' ? `array[${c.length}]` : c.type, example: c.type === 'object' ? '{...}' : c.type === 'array' ? `[${c.length}]` : String(c.example ?? '') });
        walk(c, `${prefix}[].${c.path}`);
      }
    } else {
      rows.push({ path: `${prefix}[]`, type: node.element.type, example: '' });
    }
  }
})(root, '');
const nulls = rows.filter((r) => r.type === 'null');
const title = get(o, 'title', null) || (() => { try { return new globalThis.URL(final).pathname.replace(/\/$/, '').split('/').pop() || 'response'; } catch { return 'response'; } })();
const method = String(get(o, 'method', 'GET')).toUpperCase();
const desc = get(o, 'desc', null);
const statusArg = get(o, 'status', null) || (status ? String(status) : '200');
const size = Buffer.byteLength(text, 'utf8');

const md = [];
md.push(`# ${method} ${title}`);
md.push('');
if (desc) { md.push(String(desc)); md.push(''); }
md.push(`\`${method} ${final}\``);
md.push('');
md.push('## Response');
md.push('');
md.push(`Status \`${statusArg}\` · \`${type || 'application/json'}\` · ${size.toLocaleString('en-US')} bytes · ${rows.length} documented field(s)`);
md.push('');
md.push('| field | type | description | example |');
md.push('| --- | --- | --- | --- |');
for (const r of rows) {
  const descCell = r.type === 'null' ? 'may be null' : (r.type === 'integer' || r.type === 'number' ? 'numeric' : '');
  md.push(`| \`${r.path}\` | \`${r.type}\` | ${descCell} | ${String(r.example).replace(/\|/g, '\\|').slice(0, 50)} |`);
}
if (Array.isArray(parsed)) {
  md.push('');
  md.push(`Top-level array with ${parsed.length} element(s).`);
}
md.push('');
md.push('## Example response');
md.push('');
md.push('```json');
md.push(JSON.stringify(parsed, null, 2).split('\n').slice(0, 40).join('\n') + (JSON.stringify(parsed, null, 2).split('\n').length > 40 ? '\n... (truncated)' : ''));
md.push('```');

const markdown = md.join('\n') + '\n';
if (flag(o, 'json')) console.log(JSON.stringify({ source: final, method, status: statusArg, fieldCount: rows.length, nullableFields: nulls.map((n) => n.path), shape: root, markdown }, null, 2));
else process.stdout.write(markdown);
