#!/usr/bin/env node
// cookiejar.js — parse Set-Cookie headers into a jar, export Netscape format, explain flags.
// Copyright (c) 2026 0xnothings
// @tool cookiejar
// @desc Turn Set-Cookie headers (or a live fetch) into a cookie jar with flag explanations and Netscape export
// @usage node tools/cookiejar.js https://example.com --json
// @tags web,http,cookies
import { args, get, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`cookiejar — Set-Cookie parser and jar

  node tools/cookiejar.js <url|file|-> [options]

  Sources:
    <url>          fetch the URL and parse its Set-Cookie headers
    <file|->       parse Set-Cookie header lines from a file or stdin

  --netscape     output the jar in Netscape cookies.txt format
  --header <h>   send a Cookie header with the fetch
  --explain      add a per-flag explanation for every cookie
  --json         machine-readable output
  -h, --help     this text

  Flags decoded: Domain, Path, Expires, Max-Age, Secure, HttpOnly, SameSite,
  Priority, and the __Host-/__Secure- name prefixes.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/cookiejar.js <url|file|-> [--netscape] [--json]');

const LIFETIME = { session: 0, expired: 1 };
const NOW = Date.now();

function splitSetCookie(value) {
  /* Split a comma-joined Set-Cookie blob at positions that start a new date or name=value. */
  const out = [];
  let buf = '';
  const parts = String(value).split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_\`|~-]+\s*=)/);
  for (const p of parts) {
    const hasExpires = /expires\s*=/i.test(p);
    if (hasExpires && buf && /,\s*\d{1,2}[- ]/.test(buf)) { out.push(buf.trim()); buf = p; }
    else if (buf && !/expires\s*=/i.test(buf) && /^\s*[A-Za-z0-9!#$%&'*+.^_\`|~-]+\s*=/.test(p) && /\b(path|domain|httponly|secure|samesite|max-age|expires)\s*=/i.test(p.split(';')[1] || '')) { out.push(buf.trim()); buf = p; }
    else buf = buf ? `${buf},${p}` : p;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseOne(raw, host) {
  const segs = String(raw).split(';');
  const [nv, ...attrs] = segs;
  const eq = nv.indexOf('=');
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  const c = {
    name, value,
    domain: host, hostOnly: true, path: '/',
    expires: null, maxAge: null, secure: false, httpOnly: false,
    sameSite: null, priority: null, raw: String(raw).trim(),
  };
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'domain') { c.domain = v.replace(/^\./, ''); c.hostOnly = false; }
    else if (k === 'path') c.path = v || '/';
    else if (k === 'expires') { const d = new Date(v); c.expires = isNaN(d.getTime()) ? v : d.toISOString(); }
    else if (k === 'max-age') { const n = Number(v); c.maxAge = Number.isFinite(n) ? n : null; if (Number.isFinite(n)) c.expires = new Date(NOW + n * 1000).toISOString(); }
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite') c.sameSite = v || 'Unspecified';
    else if (k === 'priority') c.priority = v;
  }
  c.session = !c.expires;
  c.persistent = !c.session;
  c.lifetimeDays = c.expires ? Math.round(((new Date(c.expires).getTime() - NOW) / 86400000) * 10) / 10 : null;
  c.expired = Boolean(c.expires) && new Date(c.expires).getTime() < NOW;
  const lifetime = c.lifetimeDays;
  c.verdict = c.expired ? 'expired'
    : lifetime !== null && lifetime > 365 ? 'long-lived'
    : lifetime !== null && lifetime > 30 ? 'persistent'
    : 'short-lived';
  c.prefix = name.startsWith('__Host-') ? '__Host-' : name.startsWith('__Secure-') ? '__Secure-' : null;
  c.scope = c.hostOnly ? 'host-only' : 'domain (subdomains included)';
  c.risk = [];
  if (!c.secure) c.risk.push('no Secure — sent over http://');
  if (!c.httpOnly) c.risk.push('no HttpOnly — readable from JS');
  if (!c.sameSite) c.risk.push('no SameSite — defaults to Lax in modern browsers');
  if (c.prefix === '__Host-' && (!c.secure || c.path !== '/' || !c.hostOnly)) c.risk.push('__Host- prefix requires Secure + Path=/ + no Domain');
  if (c.prefix === '__Secure-' && !c.secure) c.risk.push('__Secure- prefix requires Secure');
  return c;
}

const FLAG_DOC = {
  Domain: 'which hosts may receive the cookie; absent = host-only',
  Path: 'URL prefix the cookie is scoped to',
  Expires: 'absolute expiry; absent = session cookie',
  'Max-Age': 'relative lifetime in seconds; wins over Expires',
  Secure: 'only transmit over HTTPS',
  HttpOnly: 'hide from document.cookie (XSS mitigation)',
  SameSite: 'Strict | Lax | None — cross-site send policy',
  Priority: 'browser eviction hint (Low/Medium/High)',
};

async function loadFromUrl(u, cookieHeader) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const h = { 'user-agent': UA, accept: 'text/html,application/json,*/*' };
    if (cookieHeader) h.cookie = cookieHeader;
    const res = await fetch(u, { signal: ctl.signal, redirect: 'manual', headers: h });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const fallback = res.headers.get('set-cookie');
    const list = raw.length ? raw : fallback ? splitSetCookie(fallback) : [];
    if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    return { status: res.status, list, headers: Object.fromEntries(res.headers) };
  } finally { clearTimeout(t); }
}

let parsed = [];
let meta = {};

if (/^https?:\/\//i.test(src)) {
  const host = new URL(src).hostname;
  const cookieHeader = get(o, 'header', null);
  const r = await loadFromUrl(src, cookieHeader && cookieHeader !== true ? String(cookieHeader) : null);
  parsed = r.list.map((x) => parseOne(x, host)).filter(Boolean);
  meta = { source: src, status: r.status, host, setCookieCount: r.list.length, note: parsed.length ? null : 'no Set-Cookie header returned' };
  if (r.headers['set-cookie']) meta.rawSetCookie = r.headers['set-cookie'];
} else {
  const text = src === '-' ? await readInput(null) : await readInput(src);
  const host = String(get(o, 'host', 'example.com'));
  const blobs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*set-cookie\s*:\s*(.+)$/i);
    blobs.push(m ? m[1] : line);
  }
  parsed = blobs.filter((b) => b.trim()).flatMap((b) => splitSetCookie(b)).map((x) => parseOne(x, host)).filter(Boolean);
  meta = { source: src, host, setCookieCount: parsed.length, note: parsed.length ? null : 'no cookies parsed' };
}

const jar = {
  ...meta,
  count: parsed.length,
  cookies: parsed,
};

if (flag(o, 'netscape')) {
  const netscape = [
    '# Netscape HTTP Cookie File',
    '# generated by 0xnothings cookiejar',
    ...parsed.map((c) => [
      c.domain.startsWith('.') ? c.domain : c.hostOnly ? c.domain : '.' + c.domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : 0,
      c.name,
      c.value,
    ].join('\t')),
  ].join('\n');
  console.log(netscape);
  process.exitCode = 0;
} else if (flag(o, 'json')) {
  console.log(JSON.stringify(flag(o, 'explain') ? { ...jar, flagDocs: FLAG_DOC } : jar, null, 2));
  process.exitCode = 0;
} else {
  console.log(`${meta.source}${meta.status ? `  [HTTP ${meta.status}]` : ''}  host: ${meta.host}`);
  console.log(`${parsed.length} cookie${parsed.length === 1 ? '' : 's'}${meta.note ? `  — ${meta.note}` : ''}\n`);
  if (parsed.length) {
    console.log(table(parsed.map((c) => ({
      name: c.name,
      value: c.value.length > 22 ? c.value.slice(0, 22) + '…' : c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure ? 'Y' : '-',
      http: c.httpOnly ? 'Y' : '-',
      sameSite: c.sameSite || '-',
      expires: c.session ? 'session' : (c.expires || '').slice(0, 10),
      verdict: c.verdict,
    }))));
    const risky = parsed.filter((c) => c.risk.length);
    if (risky.length) {
      console.log('\nFLAGS TO REVIEW');
      for (const c of risky) console.log(`  ${c.name}: ${c.risk.join('; ')}`);
    }
    if (flag(o, 'explain')) {
      console.log('\nFLAG REFERENCE');
      console.log(table(Object.entries(FLAG_DOC).map(([k, v]) => ({ flag: k, meaning: v }))));
    }
  }
}
process.exitCode = 0;
