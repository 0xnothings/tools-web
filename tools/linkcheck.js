#!/usr/bin/env node
// linkcheck.js — check every link found on a page for dead targets.
// Copyright (c) 2026 0xnothings
// @tool linkcheck
// @desc Extract every link on a page and report HTTP status, redirect target and dead links
// @usage node tools/linkcheck.js https://example.com --internal-only --json
// @tags web,seo,qa
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`linkcheck — dead link finder

  node tools/linkcheck.js <url|file|-> [options]

  --internal-only   only check links on the same origin as the page
  --external-only   only check off-origin links
  --concurrency <n> parallel HEAD requests (default 8)
  --timeout <n>     per-request timeout in ms (default 10000)
  --max <n>         check at most n links (default 200)
  --strict          treat 3xx as a problem too
  --json            machine-readable output
  -h, --help        this text

  Uses HEAD, falls back to GET when a server rejects HEAD. Reports 4xx/5xx,
  unreachable hosts and slow responses separately.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const target = o._[0];
if (!target) die('usage: node tools/linkcheck.js <url|file|-> [--internal-only] [--json]');

const conc = Math.max(1, Math.min(32, num(get(o, 'concurrency'), 8)));
const timeout = Math.max(1000, num(get(o, 'timeout'), 10000));
const maxLinks = Math.max(1, num(get(o, 'max'), 200));
const SLOW = 2000;

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      return { body: await res.text(), final: res.url };
    } catch (e) { die(`page fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(timer); }
  }
  if (t === '-') {
    const { readStdin } = await import('../_lib.js');
    return { body: await readStdin(), final: 'stdin' };
  }
  const { readFileSync } = await import('node:fs');
  return { body: readFileSync(t, 'utf8'), final: t };
}

const page = await load(target);
const base = /^https?:\/\//i.test(page.final) ? page.final : null;

const found = new Map();
for (const m of page.body.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>/gi)) {
  const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
  if (!href || /^(#|mailto:|tel:|javascript:|data:|blob:)/i.test(href)) continue;
  let abs;
  try { abs = base ? new URL(href, base).toString() : new URL(href, 'https://example.invalid/').toString(); } catch { continue; }
  if (abs.startsWith('https://example.invalid/')) continue;
  const rel = /rel\s*=\s*["']([^"']*nofollow[^"']*)["']/i.test(m[4] || '');
  const text = decodeEntities(m[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 70);
  if (!found.has(abs)) found.set(abs, { url: abs, text, nofollow: rel, count: 0 });
  found.get(abs).count++;
}

const origin = base ? new URL(base).origin : null;
let links = [...found.values()];
if (flag(o, 'internal-only') || flag(o, 'external-only')) {
  const wantInternal = flag(o, 'internal-only');
  links = links.filter((l) => {
    let same;
    try { same = origin !== null && new URL(l.url).origin === origin; } catch { same = false; }
    return wantInternal ? same : !same;
  });
}
const scanned = links.slice(0, maxLinks);

async function probe(link, useGet) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(link.url, {
      method: useGet ? 'GET' : 'HEAD', signal: ctl.signal, redirect: 'manual',
      headers: { 'user-agent': UA, accept: '*/*' },
    });
    if (useGet && res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    return {
      status: res.status, location: res.headers.get('location'),
      ms: Date.now() - t0, final: res.headers.get('location') || link.url,
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}

const results = [];
for (let i = 0; i < scanned.length; i += conc) {
  const batch = scanned.slice(i, i + conc);
  const done = await Promise.all(batch.map(async (l) => {
    let r = await probe(l, false);
    if (r.status === 405 || r.status === 501 || r.status === 403) r = await probe(l, true);
    return { ...l, ...r };
  }));
  results.push(...done);
}

const strict = flag(o, 'strict');
const isBad = (r) => r.status === 0 || r.status >= 400 || (strict && r.status >= 300);
const broken = results.filter(isBad);
const redirected = results.filter((r) => r.status >= 300 && r.status < 400 && r.location && !isBad(r));
const slow = results.filter((r) => r.ms >= SLOW && !isBad(r));
const ok = results.filter((r) => r.status >= 200 && r.status < 300);

const summary = {
  page: page.final, found: links.length, checked: results.length,
  ok: ok.length, redirected: redirected.length, broken: broken.length, slow: slow.length,
  truncated: links.length > scanned.length,
};

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    ...summary,
    links: results.map((r) => ({
      url: r.url, text: r.text, status: r.status, location: r.location || null,
      ms: r.ms, error: r.error || null, nofollow: r.nofollow, occurrences: r.count,
      verdict: r.status === 0 ? 'unreachable' : r.status >= 400 ? 'broken' : r.status >= 300 ? 'redirect' : 'ok',
    })),
  }, null, 2));
  process.exit(broken.length || slow.length ? 1 : 0);
}

console.log(`${page.final}`);
console.log(`found ${summary.found} links · checked ${summary.checked} · ok ${summary.ok} · redirect ${summary.redirected} · broken ${summary.broken} · slow ${summary.slow}${summary.truncated ? ' (capped)' : ''}\n`);

if (broken.length) {
  console.log('BROKEN');
  console.log(table(broken.sort((a, b) => (a.status || 999) - (b.status || 999))
    .map((r) => ({ status: r.status || 'ERR', ms: r.ms, url: r.url.slice(0, 78), detail: r.error || '' }))));
  console.log('');
}
if (redirected.length) {
  console.log('REDIRECTS');
  console.log(table(redirected.map((r) => ({ status: r.status, url: r.url.slice(0, 60), to: String(r.location).slice(0, 60) }))));
  console.log('');
}
if (slow.length) {
  console.log('SLOW');
  console.log(table(slow.map((r) => ({ ms: r.ms, status: r.status, url: r.url.slice(0, 78) }))));
}

if (broken.length || slow.length) process.exitCode = 1;
else process.exitCode = 0;
