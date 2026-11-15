#!/usr/bin/env node
// apiprobe.js — probe a JSON API endpoint: method matrix, pagination, auth hints.
// Copyright (c) 2026 0xnothings
// @tool apiprobe
// @desc Fingerprint a JSON API: allowed methods, content types, pagination style, auth scheme, rate headers
// @usage node tools/apiprobe.js https://api.github.com/users/octocat --json
// @tags web,api,recon
import { args, get, num, flag, die, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`apiprobe — JSON/HTTP API fingerprinter

  node tools/apiprobe.js <url> [options]

  --methods <list>   comma list to test (default GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD)
  --header k:v       extra request header (repeatable)
  --bearer <token>   send an Authorization: Bearer header
  --no-paginate      skip pagination discovery
  --timeout <n>      per-request timeout ms (default 10000)
  --json             machine-readable output
  -h, --help         this text

  Read-only probing: it never sends a mutating body, so PUT/POST/DELETE calls
  carry no payload and will only reveal whether the route exists.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const url = o._[0];
if (!url) die('usage: node tools/apiprobe.js <url> [--json]');

const timeout = Math.max(1000, num(get(o, 'timeout'), 10000));
const methods = String(get(o, 'methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const headers = { 'user-agent': UA, accept: 'application/json, */*' };
if (o.f.header) {
  for (const raw of Array.isArray(o.f.header) ? o.f.header : [o.f.header]) {
    const i = String(raw).indexOf(':');
    if (i > 0) headers[String(raw).slice(0, i).trim().toLowerCase()] = String(raw).slice(i + 1).trim();
  }
}
const bearer = get(o, 'bearer', null);
if (bearer && bearer !== true) headers.authorization = `Bearer ${bearer}`;

async function req(method, u, extra = {}, readBody = true) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(u, { method, signal: ctl.signal, redirect: 'manual', headers: { ...headers, ...extra } });
    let body = '';
    if (readBody && method !== 'HEAD') body = await res.text();
    else if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    const h = {};
    for (const [k, v] of res.headers) h[k] = v;
    return { status: res.status, headers: h, body, ms: Date.now() - t0, location: res.headers.get('location') };
  } catch (e) {
    return { status: 0, headers: {}, body: '', ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

const matrix = [];
for (const m of methods) {
  const r = await req(m, url, {}, m !== 'HEAD');
  matrix.push({
    method: m, status: r.status, ms: r.ms,
    allow: r.headers.allow || null,
    type: (r.headers['content-type'] || '').split(';')[0] || null,
    length: r.headers['content-length'] || (r.body ? String(r.body.length) : null),
    error: r.error || null,
    bodyHead: m === 'HEAD' || !r.body ? null : r.body.slice(0, 160),
  });
  if (m !== methods[methods.length - 1]) await sleep(120);
}

const getRes = matrix.find((m) => m.method === 'GET');
let json = null;
const firstGet = await req('GET', url);
if ((firstGet.headers['content-type'] || '').includes('json') && firstGet.body) {
  try { json = JSON.parse(firstGet.body); } catch { json = null; }
}
const preflight = await req('OPTIONS', url, { origin: 'https://example.com', 'access-control-request-method': 'GET' });

const cors = {
  allowOrigin: preflight.headers['access-control-allow-origin'] || null,
  allowMethods: preflight.headers['access-control-allow-methods'] || null,
  allowHeaders: preflight.headers['access-control-allow-headers'] || null,
  allowCredentials: preflight.headers['access-control-allow-credentials'] || null,
};

const auth = (() => {
  const st = firstGet.status;
  const wa = firstGet.headers['www-authenticate'] || null;
  const hints = [];
  if (wa) hints.push(wa);
  if (st === 401) hints.push('endpoint requires authentication (401)');
  if (st === 403) hints.push('endpoint exists but is forbidden (403)');
  if (st === 404) hints.push('route not found (404)');
  if (st === 429) hints.push('rate limited (429)');
  if (firstGet.headers['x-ratelimit-limit']) hints.push(`rate-limit header present: ${firstGet.headers['x-ratelimit-limit']}`);
  const lower = String(firstGet.body || '').slice(0, 2000).toLowerCase();
  for (const kw of ['api key', 'apikey', 'unauthorized', 'forbidden', 'token', 'oauth', 'authentication required']) {
    if (lower.includes(kw)) hints.push(`body mentions "${kw}"`);
  }
  return { status: st, wwwAuthenticate: wa, hints: [...new Set(hints)] };
})();

const pagination = { style: 'none', evidence: [] };
if (!flag(o, 'no-paginate') && firstGet.status === 200) {
  const lh = firstGet.headers.link;
  if (lh && /rel="?next"?/i.test(lh)) {
    pagination.style = 'link-header';
    pagination.evidence.push(lh.slice(0, 200));
  }
  if (json) {
    const probe = (obj, keys, label) => {
      for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) pagination.evidence.push(`${label}: ${JSON.stringify(obj[k]).slice(0, 80)}`);
    };
    const root = json && typeof json === 'object' ? (Array.isArray(json) ? { data: json } : json) : {};
    probe(root, ['next', 'next_page', 'nextPage', 'next_cursor', 'nextCursor', 'next_token'], 'next pointer');
    probe(root, ['total', 'total_count', 'totalCount', 'count'], 'total count');
    probe(root, ['page', 'pageNumber', 'current_page', 'offset', 'limit', 'per_page', 'perPage'], 'paging fields');
    const meta = root.meta && typeof root.meta === 'object' ? root.meta : root.pagination && typeof root.pagination === 'object' ? root.pagination : null;
    if (meta) probe(meta, ['next', 'page', 'total', 'has_more', 'hasMore', 'cursor', 'last_page'], 'meta');
    const arr = Array.isArray(json) ? json : Array.isArray(root.data) ? root.data : Array.isArray(root.items) ? root.items : null;
    if (arr) pagination.evidence.push(`records per page: ${arr.length}`);
    if (root.next || root.next_page || (meta && (meta.next || meta.has_more)) || (lh && /rel="?next"?/i.test(lh))) pagination.style = pagination.style === 'link-header' ? 'link-header' : 'cursor';
    else if (arr && arr.length) pagination.style = 'unknown-but-list';
  }
  if (pagination.style === 'unknown-but-list' && (firstGet.headers['x-total-count'] || firstGet.headers['x-pagination'])) {
    pagination.style = 'header-driven';
    pagination.evidence.push('x-total-count / x-pagination header present');
  }
}

const rateHeaders = {};
for (const [k, v] of Object.entries(firstGet.headers)) {
  if (/ratelimit|retry-after|x-rate|request-cost|quota/i.test(k)) rateHeaders[k] = v;
}

const server = firstGet.headers.server || null;
const tech = [];
const h = firstGet.headers;
if (h['x-powered-by']) tech.push(h['x-powered-by']);
if (h['x-generator']) tech.push(h['x-generator']);
if (server) tech.push(server);
const bodyStart = String(firstGet.body || '').slice(0, 3000);
const fingerprints = [
  [/Cannot GET \//, 'Express'], [/"message"\s*:\s*"Not Found"/, 'Express-ish 404'],
  [/Whitelabel Error Page/, 'Spring Boot'], [/<html><head><title>Error<\/title>/i, 'Tomcat/Java'],
  [/{"detail":"/i, 'FastAPI / DRF'], [/Laravel/i, 'Laravel'], [/Django/i, 'Django'],
  [/<\/html>\s*$/, 'HTML response'], [/^\{[\s\S]*\}$/, 'pure JSON response'],
];
for (const [re, label] of fingerprints) if (re.test(bodyStart)) tech.push(label);

const result = {
  url, finalUrl: firstGet.headers['x-final'] || url,
  status: firstGet.status,
  contentType: (firstGet.headers['content-type'] || '').split(';')[0] || null,
  server, tech: [...new Set(tech)],
  shape: json === null ? 'not-json' : Array.isArray(json) ? 'array' : `object(${Object.keys(json).slice(0, 12).join(',')})`,
  records: json === null ? null : Array.isArray(json) ? json.length : null,
  auth, cors, pagination, rateHeaders,
  headers: Object.fromEntries(Object.entries(firstGet.headers).filter(([k]) => /^(cache-control|etag|vary|content-encoding|x-cache|age|set-cookie)$/.test(k))),
  methods: matrix,
};

if (flag(o, 'json')) { console.log(JSON.stringify(result, null, 2)); process.exitCode = 0; } else {

console.log(`${url}`);
console.log(`HTTP ${result.status}  ${result.contentType || '(no content-type)'}  ${server ? `server: ${server}` : ''}${tech.length ? `  tech: ${[...new Set(tech)].join(', ')}` : ''}`);
console.log(`body shape: ${result.shape}${result.records !== null ? ` (${result.records} records)` : ''}\n`);

console.log('METHOD MATRIX');
console.log(table(matrix.map((m) => ({ method: m.method, status: m.status || 'ERR', allow: (m.allow || '').slice(0, 40), type: (m.type || '').slice(0, 28), ms: m.ms }))));

console.log('\nAUTH');
console.log(auth.hints.length ? auth.hints.map((h) => '  - ' + h).join('\n') : '  no auth challenge detected (may be public)');

console.log('\nCORS (preflight-response)');
console.log(table(Object.entries(cors).map(([k, v]) => ({ header: k, value: v || '—' }))));

console.log('\nPAGINATION');
console.log(`  style: ${pagination.style}`);
for (const e of pagination.evidence) console.log('  - ' + e);

if (Object.keys(rateHeaders).length) {
  console.log('\nRATE LIMIT HEADERS');
  console.log(table(Object.entries(rateHeaders).map(([k, v]) => ({ header: k, value: v }))));
}
}
