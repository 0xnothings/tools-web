#!/usr/bin/env node
// paginate.js — follow API pagination and collect every item into one array.
// Copyright (c) 2026 0xnothings
// @tool paginate
// @desc Walk page/cursor/offset/link-header pagination on a JSON API and collect all records
// @usage node tools/paginate.js https://api.github.com/users/octocat/repos --style auto --max-pages 3 --json
// @tags web,api,json
import { args, get, num, flag, die, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`paginate — API pagination walker

  node tools/paginate.js <url> [options]

  --style <s>       auto | page | cursor | offset | link | tombstones (default auto)
  --param <name>    override the page parameter name (default depends on style)
  --start <n>       first page number / offset (default 1, offset style: 0)
  --size <n>        page size to request where the API accepts it (default none)
  --field <path>    dotted path to the record array (default auto-detect)
  --cursor-field <path>  dotted path to the next cursor in the response
  --max-pages <n>   stop after n pages (default 20)
  --delay <ms>      wait between requests (default 250)
  --dedupe <key>    drop duplicate records by this field
  --header k:v      extra request header (repeatable)
  --raw             print the merged array as JSON (default: table preview)
  --json            machine-readable envelope with metadata
  -h, --help        this text

  Auto style detection order: Link header → body cursor fields → body page fields →
  revenuecat "next_page". Records are appended in request order.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const startUrl = o._[0];
if (!startUrl) die('usage: node tools/paginate.js <url> [--style auto] [--max-pages 20] [--json]');

const styleReq = String(get(o, 'style', 'auto')).toLowerCase();
const maxPages = Math.max(1, num(get(o, 'max-pages'), 20));
const delayMs = Math.max(0, num(get(o, 'delay'), 250));
const pageSize = num(get(o, 'size'), 0);
const dedupeKey = get(o, 'dedupe', null);

const headers = { 'user-agent': UA, accept: 'application/json' };
if (o.f.header) {
  for (const raw of [].concat(o.f.header)) {
    const i = String(raw).indexOf(':');
    if (i > 0) headers[String(raw).slice(0, i).trim().toLowerCase()] = String(raw).slice(i + 1).trim();
  }
}

const CANDIDATE_ARRAYS = ['data', 'items', 'results', 'records', 'rows', 'list', 'entries', 'content', 'objects', 'values', 'docs', 'hits'];

function dig(obj, path) {
  if (!path) return undefined;
  return String(path).replace(/^\./, '').split('.').reduce((a, k) => {
    if (a == null) return undefined;
    const idx = k.match(/^(\w+)\[(\d+)\]$/);
    if (idx) { const v = a[idx[1]]; return Array.isArray(v) ? v[Number(idx[2])] : undefined; }
    return a[k];
  }, obj);
}

function findArray(doc, hint) {
  if (Array.isArray(doc)) return { path: '', list: doc };
  if (hint) { const v = dig(doc, hint); if (Array.isArray(v)) return { path: hint, list: v }; }
  for (const k of CANDIDATE_ARRAYS) if (Array.isArray(doc?.[k])) return { path: k, list: doc[k] };
  for (const [k, v] of Object.entries(doc || {})) if (Array.isArray(v)) return { path: k, list: v };
  return null;
}

function parseLink(header) {
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";,]+)"?/);
    if (m) out[m[2].trim()] = m[1];
  }
  return out;
}

const CURSOR_KEYS = ['next_cursor', 'nextCursor', 'next_token', 'cursor', 'nextPageToken', 'continuation', 'after', 'next_key', 'scroll_id'];
const PAGE_KEYS = ['page', 'pageNumber', 'current_page', 'page_number', 'p'];
const TOTAL_KEYS = ['total', 'total_count', 'totalCount', 'count', 'totalPages', 'total_pages', 'last_page'];

function detectStyle(doc, linkHeader) {
  const lh = parseLink(linkHeader);
  if (lh.next) return 'link';
  const flat = doc && typeof doc === 'object' ? { ...doc, ...(doc.meta || {}), ...(doc.pagination || {}) } : {};
  for (const k of CURSOR_KEYS) if (flat[k] !== undefined && flat[k] !== null && flat[k] !== '' && flat[k] !== false) return 'cursor';
  for (const k of PAGE_KEYS) if (flat[k] !== undefined) return 'page';
  for (const k of ['offset', 'skip', 'start']) if (flat[k] !== undefined) return 'offset';
  return 'none';
}

function buildUrl(base, style, state, paramName) {
  const u = new URL(base);
  if (style === 'page') {
    u.searchParams.set(paramName || 'page', String(state.page));
    if (pageSize) u.searchParams.set('per_page', String(pageSize));
  } else if (style === 'offset') {
    u.searchParams.set(paramName || 'offset', String(state.offset));
    if (pageSize) u.searchParams.set(paramName ? 'limit' : 'limit', String(pageSize));
  } else if (style === 'cursor') {
    if (state.cursor) u.searchParams.set(paramName || 'cursor', String(state.cursor));
  } else if (style === 'tombstones') {
    if (state.cursor) u.searchParams.set(paramName || 'starting_after', String(state.cursor));
  }
  return u.toString();
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers });
    let body = null;
    const txt = await res.text();
    try { body = JSON.parse(txt); } catch { body = { _raw: txt.slice(0, 500) }; }
    return { status: res.status, body, headers: res.headers, final: res.url };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

const state = { page: Math.max(1, num(get(o, 'start'), 1)), offset: num(get(o, 'start'), 0), cursor: null };
const collected = [];
const pages = [];
let style = styleReq;
let fieldHint = get(o, 'field', null);
let nextUrl = null;
let total = null;
let stopped = 'max-pages';
let lastStateKey = null;

for (let p = 0; p < maxPages; p++) {
  let url;
  if (nextUrl) url = nextUrl;
  else if (p === 0) url = startUrl;
  else if (style === 'link') { stopped = 'no-next-link'; break; }
  else url = buildUrl(startUrl, style, state, get(o, 'param', null));

  const r = await getJson(url);
  if (r.status === 0) { pages.push({ page: p + 1, url, error: r.error }); stopped = 'error'; break; }
  if (r.status >= 400) {
    pages.push({ page: p + 1, url, status: r.status });
    stopped = `http-${r.status}`;
    break;
  }

  if (p === 0 && styleReq === 'auto') {
    style = detectStyle(r.body, r.headers.get('link'));
  }

  const found = findArray(r.body, fieldHint && fieldHint !== true ? String(fieldHint) : null);
  if (!found) { stopped = 'no-array-found'; pages.push({ page: p + 1, url, status: r.status, records: 0 }); break; }
  fieldHint = found.path;
  collected.push(...found.list);

  const link = parseLink(r.headers.get('link'));
  const flat = { ...r.body, ...(r.body?.meta || {}), ...(r.body?.pagination || {}) };
  for (const k of TOTAL_KEYS) if (flat[k] !== undefined && typeof flat[k] === 'number') { total = flat[k]; break; }

  pages.push({ page: p + 1, url, status: r.status, records: found.list.length, style, total });

  /* --- decide next --- */
  nextUrl = null;
  if (link.next) { nextUrl = link.next; continue; }
  if (!found.list.length) { stopped = 'empty-page'; break; }

  const cursorHint = get(o, 'cursor-field', null);
  const cursorVal = cursorHint && cursorHint !== true ? dig(r.body, cursorHint) : CURSOR_KEYS.map((k) => flat[k]).find((v) => v !== undefined && v !== null && v !== '' && v !== false);

  if (style === 'cursor' || style === 'tombstones' || (style === 'auto' && cursorVal !== undefined && cursorVal !== null && cursorVal !== '')) {
    if (cursorVal === undefined || cursorVal === null || cursorVal === '' || cursorVal === false) { stopped = 'no-cursor'; break; }
    if (String(cursorVal) === lastStateKey) { stopped = 'cursor-loop'; break; }
    lastStateKey = String(cursorVal);
    state.cursor = cursorVal;
    style = style === 'auto' ? 'cursor' : style;
    continue;
  }

  if (style === 'page' || style === 'none') {
    const cur = Number(flat.page ?? state.page);
    const last = Number(flat.totalPages ?? flat.total_pages ?? flat.last_page ?? 0);
    if (last && cur >= last) { stopped = 'last-page'; break; }
    if (total !== null && collected.length >= total) { stopped = 'total-reached'; break; }
    if (!found.list.length) { stopped = 'empty-page'; break; }
    state.page = cur + 1;
    continue;
  }

  if (style === 'offset') {
    const nextOff = Number(flat.next_offset ?? flat.nextOffset ?? (state.offset + (found.list.length || 1)));
    if (total !== null && collected.length >= total) { stopped = 'total-reached'; break; }
    state.offset = Number.isFinite(nextOff) ? nextOff : state.offset + found.list.length;
    continue;
  }

  if (style === 'link') { stopped = 'last-page'; break; }

  stopped = 'no-pagination';
  break;
}

let records = collected;
if (dedupeKey && dedupeKey !== true) {
  const seen = new Set();
  records = collected.filter((r) => {
    const k = dig(r, String(dedupeKey)) ?? JSON.stringify(r);
    if (seen.has(String(k))) return false;
    seen.add(String(k));
    return true;
  });
}

const meta = {
  start: startUrl, style, field: fieldHint, pages: pages.length,
  requests: pages.length, collected: collected.length, afterDedupe: records.length,
  total, stopped,
};

if (flag(o, 'json')) {
  console.log(JSON.stringify({ ...meta, pageLog: pages, records }, null, 2));
  process.exitCode = 0;
} else if (flag(o, 'raw')) {
  console.log(JSON.stringify(records, null, 2));
  process.exitCode = 0;
} else {
  console.log(`${startUrl}`);
  console.log(`style: ${style}   field: ${fieldHint || '(root array)'}   records: ${records.length}${total !== null ? ` / ${total}` : ''}   stopped: ${stopped}\n`);
  console.log(table(pages.map((p) => ({ page: p.page, status: p.status ?? p.error ?? '', records: p.records ?? '', url: String(p.url).slice(0, 60) }))));
  if (records.length) {
    const keys = [...new Set(records.slice(0, 40).flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))].slice(0, 5);
    console.log('\nfirst 5 records:');
    console.log(table(records.slice(0, 5).map((r) => Object.fromEntries(keys.map((k) => [k, String(r?.[k] ?? '').slice(0, 28)])))));
  }
}
process.exitCode = 0;
