#!/usr/bin/env node
// redirectchain.js — follow and print every hop of a redirect chain with timing.
// Copyright (c) 2026 0xnothings
// @tool redirectchain
// @desc Walk a redirect chain hop by hop and report status, Location, timing and the loop/limit verdict
// @usage node tools/redirectchain.js http://github.com --max 10 --json
// @tags web,http,debug
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`redirectchain — redirect chain tracer

  node tools/redirectchain.js <url> [options]

  --max <n>      maximum hops before giving up (default 15)
  --method <m>   HTTP method to use (default GET; HEAD is faster but some CDNs differ)
  --timeout <n>  per-request timeout ms (default 15000)
  --header k:v   extra request header (repeatable)
  --show-body    print a snippet of the final response body
  --json         machine-readable output
  -h, --help     this text

  Uses manual redirect handling, so every hop is recorded — including chains that
  fetch() would collapse. Detects loops, https-downgrades, cross-origin jumps and
  meta-refresh / JS redirects in the final body.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const start = o._[0];
if (!start) die('usage: node tools/redirectchain.js <url> [--max 15] [--json]');
const url0 = /^https?:\/\//i.test(start) ? start : `https://${start}`;

const maxHops = Math.max(1, Math.min(50, num(get(o, 'max'), 15)));
const method = String(get(o, 'method', 'GET')).toUpperCase();
const timeout = Math.max(1000, num(get(o, 'timeout'), 15000));

const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' };
if (o.f.header) {
  for (const raw of [].concat(o.f.header)) {
    const i = String(raw).indexOf(':');
    if (i > 0) headers[String(raw).slice(0, i).trim().toLowerCase()] = String(raw).slice(i + 1).trim();
  }
}

const metaRefresh = (body) => {
  const m = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"';]+)/i.exec(body || '');
  return m ? m[1].trim() : null;
};
const jsRedirect = (body) => {
  const m = /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(body || '');
  return m ? m[1] : null;
};

const hops = [];
let current = url0;
let verdict = 'ok';
const seen = new Set([url0.replace(/#.*$/, '')]);
let finalBody = '';
let totalMs = 0;

for (let i = 0; i < maxHops; i++) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(current, { method, signal: ctl.signal, redirect: 'manual', headers });
  } catch (e) {
    clearTimeout(timer);
    hops.push({ hop: i, url: current, status: 0, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) });
    verdict = 'unreachable';
    break;
  }
  const ms = Date.now() - t0;
  totalMs += ms;
  clearTimeout(timer);

  const h = {};
  for (const [k, v] of res.headers) h[k] = v;

  if (method !== 'HEAD') { try { finalBody = await res.text(); } catch { finalBody = ''; } }
  else if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }

  const location = res.headers.get('location');
  const hop = {
    hop: i,
    url: current,
    status: res.status,
    ms,
    location: location || null,
    server: h.server || null,
    cache: h['cf-cache-status'] || h['x-cache'] || h['x-vercel-cache'] || null,
    type: (h['content-type'] || '').split(';')[0] || null,
    bytes: h['content-length'] ? Number(h['content-length']) : (finalBody ? finalBody.length : null),
    security: [
      h['strict-transport-security'] ? 'HSTS' : null,
      h['content-security-policy'] ? 'CSP' : null,
      h['x-frame-options'] ? 'XFO' : null,
    ].filter(Boolean).join(' '),
  };
  hops.push(hop);

  if (res.status >= 300 && res.status < 400 && location) {
    let next;
    try { next = new URL(location, current).toString(); } catch {
      hop.error = `invalid Location header: ${location}`;
      verdict = 'malformed-location';
      break;
    }
    hop.next = next;
    const key = next.replace(/#.*$/, '');
    if (seen.has(key)) { hop.loop = true; verdict = 'loop-detected'; break; }
    seen.add(key);
    if (current.startsWith('https://') && next.startsWith('http://')) verdict = 'https-downgrade';
    try {
      if (new URL(current).origin !== new URL(next).origin && verdict === 'ok') verdict = 'cross-origin';
    } catch { /* ignore */ }
    current = next;
    continue;
  }

  if (res.status >= 400) { verdict = verdict === 'ok' ? `final-${res.status}` : verdict; }
  else if (i === 0) verdict = 'no-redirect';
  const meta = metaRefresh(finalBody);
  if (meta) { hop.metaRefresh = meta; verdict = 'meta-refresh'; }
  const js = jsRedirect(finalBody);
  if (js) { hop.jsRedirect = js; verdict = verdict === 'ok' || verdict === 'no-redirect' ? 'js-redirect' : verdict; }
  if (i >= maxHops - 1) verdict = 'max-hops-reached';
  break;
}

const finalHop = hops[hops.length - 1];
const report = {
  start: url0,
  finalUrl: finalHop?.url || url0,
  hops: hops.length,
  redirects: hops.filter((h) => h.status >= 300 && h.status < 400).length,
  totalMs,
  status: finalHop?.status ?? 0,
  verdict,
  crossOriginJumps: hops.filter((h, i) => i > 0 && (() => { try { return new URL(h.url).origin !== new URL(hops[i - 1].url).origin; } catch { return false; } })()).length,
  httpsDowngrades: hops.filter((h, i) => i > 0 && hops[i - 1].url.startsWith('https://') && h.url.startsWith('http://')).length,
  chain: hops.map((h) => ({ hop: h.hop, url: h.url, status: h.status, ms: h.ms, location: h.location, error: h.error || null, loop: h.loop || false })),
  finalHeaders: finalHop ? undefined : null,
};

if (flag(o, 'show-body') && finalBody) report.bodySnippet = finalBody.replace(/\s+/g, ' ').slice(0, 500);

if (flag(o, 'json')) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; } else {
console.log(`${url0}\n`);
console.log(table(hops.map((h) => ({
  hop: h.hop,
  status: h.status || 'ERR',
  ms: h.ms,
  cache: h.cache || '',
  sec: h.security || '',
  url: h.url.replace(/^https?:\/\//, '').slice(0, 56),
}))));

for (let i = 1; i < hops.length; i++) {
  const from = hops[i - 1], to = hops[i];
  try {
    if (new URL(from.url).origin !== new URL(to.url).origin) console.log(`\n! hop ${i} crosses origin: ${new URL(from.url).origin} → ${new URL(to.url).origin}`);
  } catch { /* ignore */ }
  if (from.status >= 300 && from.status < 400 && to.url.startsWith('http://') && from.url.startsWith('https://')) {
    console.log(`\n! hop ${i} downgrades HTTPS → HTTP`);
  }
}

console.log(`\nfinal:  ${report.finalUrl}`);
console.log(`hops:   ${report.hops} (${report.redirects} redirects) in ${totalMs}ms`);
console.log(`status: ${report.status}`);
console.log(`verdict: ${verdict}`);
if (finalHop?.metaRefresh) console.log(`meta refresh → ${finalHop.metaRefresh}`);
if (finalHop?.jsRedirect) console.log(`js redirect → ${finalHop.jsRedirect}`);
if (flag(o, 'show-body') && report.bodySnippet) console.log(`\nbody: ${report.bodySnippet}`);
}
process.exitCode = 0;
