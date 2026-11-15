#!/usr/bin/env node
// pageweight.js — measure a page's transfer breakdown by resource type.
// Copyright (c) 2026 0xnothings
// @tool pageweight
// @desc Inventory every subresource a page loads, grouped by type, with sizes when the server reports them
// @usage node tools/pageweight.js https://example.com --head --json
// @tags web,perf,audit
import { args, get, num, flag, die, table, fmt } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`pageweight — page weight and subresource audit

  node tools/pageweight.js <url> [options]

  --head            HEAD every subresource to get real content-length (slower, accurate)
  --concurrency <n> parallel HEAD requests (default 8)
  --timeout <n>     per-request timeout ms (default 10000)
  --top <n>         show the n heaviest resources (default 15)
  --inline          include the HTML document itself in the totals
  --json            machine-readable output
  -h, --help        this text

  Without --head, sizes come from the HTML where available and from the number of
  resources otherwise, so treat those totals as a count-based estimate.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const url = o._[0];
if (!url) die('usage: node tools/pageweight.js <url> [--head] [--json]');

const timeout = Math.max(1000, num(get(o, 'timeout'), 10000));
const conc = Math.max(1, Math.min(32, num(get(o, 'concurrency'), 8)));
const topN = Math.max(1, num(get(o, 'top'), 15));

const CATEGORY = [
  { name: 'document', re: /\.html?$|^\/$|^[^.]*$/i },
  { name: 'stylesheet', re: /\.css$/i },
  { name: 'script', re: /\.m?js$|\.jsx?$|\.ts$/i },
  { name: 'image', re: /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i },
  { name: 'font', re: /\.(woff2?|ttf|otf|eot)$/i },
  { name: 'media', re: /\.(mp4|webm|ogg|mp3|wav|m4a|m3u8|ts)$/i },
  { name: 'data', re: /\.(json|xml|csv|txt|wasm)$/i },
];
const categorize = (path, hint) => {
  if (hint) return hint;
  for (const c of CATEGORY) if (c.re.test(path)) return c.name;
  return 'other';
};

function decodeEntities(s) {
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
};

const ctl0 = new AbortController();
const t0 = setTimeout(() => ctl0.abort(), timeout);
let page;
try {
  const res = await fetch(url, { signal: ctl0.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
  if (!res.ok) die(`fetch failed: HTTP ${res.status} ${url}`);
  page = { body: await res.text(), final: res.url, status: res.status, encoding: res.headers.get('content-encoding'), htmlBytes: Number(res.headers.get('content-length')) || 0 };
} catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
finally { clearTimeout(t0); }

const base = page.final;
const seen = new Map();
const add = (raw, category, extra = {}) => {
  if (!raw) return;
  let abs;
  try { abs = new URL(raw, base).toString(); } catch { return; }
  if (!/^https?:/i.test(abs)) return;
  if (abs.startsWith('data:')) return;
  if (seen.has(abs)) { const e = seen.get(abs); e.refs++; return; }
  seen.set(abs, { url: abs, category, size: extra.size ?? null, async: extra.async || false, deferred: extra.deferred || false, refs: 1, ...extra });
};

for (const m of page.body.matchAll(/<script\b[^>]*>/gi)) {
  const a = attrs(m[0]);
  if (a.src && !/^data:/i.test(a.src)) add(decodeEntities(a.src), 'script', { async: 'async' in a, deferred: 'defer' in a, type: a.type || null });
}
for (const m of page.body.matchAll(/<link\b[^>]*>/gi)) {
  const a = attrs(m[0]);
  const rel = (a.rel || '').toLowerCase();
  if (!a.href) continue;
  if (/stylesheet/.test(rel)) add(decodeEntities(a.href), 'stylesheet', { media: a.media || null });
  else if (/preload/.test(rel)) add(decodeEntities(a.href), categorize(a.href, a.as), { preload: a.as || true });
  else if (/modulepreload/.test(rel)) add(decodeEntities(a.href), 'script', { preload: 'module' });
  else if (/icon/.test(rel)) add(decodeEntities(a.href), 'image', { rel });
  else if (/manifest/.test(rel)) add(decodeEntities(a.href), 'data', { rel });
}
for (const m of page.body.matchAll(/<img\b[^>]*>/gi)) {
  const a = attrs(m[0]);
  add(decodeEntities(a.src || ''), 'image', { lazy: a.loading === 'lazy', width: a.width || null, height: a.height || null, srcsetCount: a.srcset ? a.srcset.split(',').length : 0 });
  if (a.srcset) {
    for (const part of a.srcset.split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (u) add(decodeEntities(u), 'image', { fromSrcset: true, lazy: a.loading === 'lazy' });
    }
  }
}
for (const m of page.body.matchAll(/<(?:source|video|audio)\b[^>]*>/gi)) {
  const a = attrs(m[0]);
  add(decodeEntities(a.src || ''), 'media', { poster: a.poster || null });
  if (a.srcset) for (const part of a.srcset.split(',')) { const u = part.trim().split(/\s+/)[0]; if (u) add(decodeEntities(u), 'media', { fromSrcset: true }); }
}
for (const m of page.body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(decodeEntities(m[1]), 'font', { fromCss: true });

const preconnect = [...page.body.matchAll(/<link\b[^>]*rel\s*=\s*["'](?:dns-prefetch|preconnect)["'][^>]*>/gi)].map((m) => attrs(m[0]).href).filter(Boolean);
const inlineScripts = [...page.body.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].length);
const inlineStyles = [...page.body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].length);

const resources = [...seen.values()];

async function measure(r) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const start = Date.now();
  try {
    const res = await fetch(r.url, { method: 'HEAD', signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*' } });
    const len = Number(res.headers.get('content-length')) || null;
    const type = (res.headers.get('content-type') || '').split(';')[0] || null;
    const encoded = res.headers.get('content-encoding') || null;
    const status = res.status;
    if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    if (len) return { ...r, status, size: len, ms: Date.now() - start, type, encoded };

    /* compressed responses often drop content-length — ask for one byte and read Content-Range */
    const ctl2 = new AbortController();
    const t2 = setTimeout(() => ctl2.abort(), timeout);
    try {
      const rangeRes = await fetch(r.url, { method: 'GET', signal: ctl2.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*', range: 'bytes=0-0' } });
      const cr = rangeRes.headers.get('content-range');
      const total = cr && /\/(\d+)\s*$/.exec(cr) ? Number(/\/(\d+)\s*$/.exec(cr)[1]) : null;
      if (rangeRes.body) { try { await rangeRes.body.cancel(); } catch { /* ignore */ } }
      return { ...r, status, size: total, ms: Date.now() - start, type, encoded, sizeFrom: total ? 'content-range' : 'unavailable' };
    } finally { clearTimeout(t2); }
  } catch (e) {
    return { ...r, status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message), ms: Date.now() - start };
  } finally { clearTimeout(t); }
}

let measured = resources;
if (flag(o, 'head')) {
  measured = [];
  for (let i = 0; i < resources.length; i += conc) {
    const batch = resources.slice(i, i + conc);
    measured.push(...(await Promise.all(batch.map(measure))));
  }
}

const byCat = {};
for (const r of measured) {
  byCat[r.category] = byCat[r.category] || { category: r.category, count: 0, bytes: 0, unknown: 0 };
  byCat[r.category].count++;
  if (r.size) byCat[r.category].bytes += r.size; else byCat[r.category].unknown++;
}
if (flag(o, 'inline')) {
  byCat['inline-css'] = { category: 'inline-css', count: inlineStyles.length, bytes: inlineStyles.reduce((a, b) => a + b, 0), unknown: 0 };
  byCat['inline-js'] = { category: 'inline-js', count: inlineScripts.length, bytes: inlineScripts.reduce((a, b) => a + b, 0), unknown: 0 };
}

const totalBytes = Object.values(byCat).reduce((a, b) => a + b.bytes, 0) + (flag(o, 'inline') ? page.body.length : 0);
const report = {
  url: base,
  status: page.status,
  htmlBytes: page.htmlBytes || page.body.length,
  htmlCompressed: Boolean(page.encoding),
  resources: measured.length,
  thirdParty: measured.filter((r) => { try { return new URL(r.url).origin !== new URL(base).origin; } catch { return false; } }).length,
  byCategory: Object.values(byCat).sort((a, b) => b.bytes - a.bytes || b.count - a.count),
  totals: {
    measuredBytes: totalBytes,
    knownBytes: measured.reduce((a, b) => a + (b.size || 0), 0),
    unknownSize: measured.filter((r) => !r.size).length,
    blockingScripts: measured.filter((r) => r.category === 'script' && !r.async && !r.deferred).length,
    blockingStyles: byCat.stylesheet?.count || 0,
    lazyImages: measured.filter((r) => r.lazy).length,
    errors: measured.filter((r) => !r.status || r.status >= 400).length,
  },
  preconnect: [...new Set(preconnect)],
  inline: { scripts: inlineScripts.length, scriptBytes: inlineScripts.reduce((a, b) => a + b, 0), styles: inlineStyles.length, styleBytes: inlineStyles.reduce((a, b) => a + b, 0) },
  heaviest: [...measured].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, topN).map((r) => ({ url: r.url, category: r.category, bytes: r.size, status: r.status || null, ms: r.ms })),
  resources_: undefined,
};

if (flag(o, 'json')) {
  report.all = measured.map((r) => ({ url: r.url, category: r.category, bytes: r.size, status: r.status ?? null, async: r.async || false, deferred: r.deferred || false, error: r.error || null }));
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${base}  [HTTP ${page.status}]`);
  console.log(`html document: ${fmt(page.htmlBytes || page.body.length)} bytes${page.htmlCompressed ? ` (${page.encoding})` : ''}   subresources: ${measured.length}   third-party: ${report.thirdParty}\n`);
  console.log(table(report.byCategory.map((c) => ({
    category: c.category,
    count: c.count,
    bytes: c.bytes ? fmt(c.bytes) : '—',
    unknown: c.unknown || '',
    share: totalBytes ? Math.round((c.bytes / totalBytes) * 100) + '%' : '',
  }))));
  console.log('');
  console.log(table([
    { metric: 'measured total', value: fmt(totalBytes) + ' bytes' },
    { metric: 'blocking scripts', value: report.totals.blockingScripts },
    { metric: 'blocking stylesheets', value: report.totals.blockingStyles },
    { metric: 'lazy images', value: report.totals.lazyImages },
    { metric: 'inline scripts', value: `${report.inline.scripts} (${fmt(report.inline.scriptBytes)} B)` },
    { metric: 'inline styles', value: `${report.inline.styles} (${fmt(report.inline.styleBytes)} B)` },
    { metric: 'failed resources', value: report.totals.errors },
    { metric: 'unknown size', value: report.totals.unknownSize },
  ]));
  if (report.heaviest.length) {
    console.log('\nHEAVIEST');
    console.log(table(report.heaviest.map((r) => ({
      bytes: r.bytes ? fmt(r.bytes) : '—',
      status: r.status ?? '',
      category: r.category,
      url: r.url.replace(/^https?:\/\//, '').slice(0, 56),
    }))));
  }
  if (report.preconnect.length) console.log(`\nhints: ${report.preconnect.length} preconnect/dns-prefetch — ${report.preconnect.slice(0, 4).join(', ')}`);
  if (!flag(o, 'head')) console.log('\nsizes shown are what the server reported in the HTML only — re-run with --head for real content-length values');
}
process.exitCode = 0;
