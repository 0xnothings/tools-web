// cacheheader.js — audit caching headers across a URL list.
// Copyright (c) 2026 0xnothings
// @tool cacheheader
// @desc Check Cache-Control, Expires, ETag, Last-Modified and Vary on each URL and flag conflicts, missing validators and no-store on static assets
// @usage node tools/cacheheader.js urls.txt --max-age-min 3600
// @tags web,performance,http
import { args, get, num, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`cacheheader — caching header audit

  node tools/cacheheader.js <url-list|url> [options]

  --max <n>          cap the number of URLs checked (default 25)
  --max-age-min <s>  flag static assets cached for less than this (default 3600)
  --json             machine-readable output
  -h, --help         this text

  Static is decided by extension: css, js, png, jpg, gif, svg, woff2, ico, mp4.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const STATIC_EXT = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)$/i;

const src = o._[0];
if (!src) die('usage: node tools/cacheheader.js <url-list|url> [--max 25]');

const urls = /^https?:\/\//i.test(src) ? [src] : await inputLines(src);
if (!urls.length) die('no URLs to check');
const max = Math.max(1, num(get(o, 'max'), 25));
const maxAgeMin = Math.max(0, num(get(o, 'max-age-min'), 3600));

const rows = [];
for (const url of urls.slice(0, max)) {
  if (!/^https?:\/\//i.test(url)) { rows.push({ url: url.slice(0, 46), status: 'SKIP', cacheControl: 'not a URL', ttl: '', etag: '', lastMod: '', expires: '', vary: '', findings: 'skipped' }); continue; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    const h = res.headers;
    const cc = h.get('cache-control') || '';
    const expires = h.get('expires') || '';
    const etag = h.get('etag') || '';
    const lastMod = h.get('last-modified') || '';
    const vary = h.get('vary') || '';
    const isStatic = STATIC_EXT.test(new globalThis.URL(res.url).pathname);
    const findings = [];

    const maxAge = (cc.match(/max-age\s*=\s*(\d+)/i) || [])[1];
    let ttl = maxAge ? Number(maxAge) : null;
    if (ttl === null && expires) {
      const d = Date.parse(expires);
      if (!Number.isNaN(d)) ttl = Math.max(0, Math.round((d - Date.now()) / 1000));
    }
    if (maxAge && expires) {
      const d = Date.parse(expires);
      if (!Number.isNaN(d)) {
        const expTtl = Math.max(0, Math.round((d - Date.now()) / 1000));
        if (Math.abs(expTtl - Number(maxAge)) > 60) findings.push(`Cache-Control max-age=${maxAge} disagrees with Expires (${expTtl}s)`);
      }
    }
    if (!cc && !expires) findings.push('no Cache-Control and no Expires');
    if (/\bno-store\b/i.test(cc) && isStatic) findings.push('no-store on a static asset');
    if (/\bno-cache\b/i.test(cc) && !/\bmax-age\b/i.test(cc)) findings.push('no-cache without max-age — revalidation every time');
    if (/\bprivate\b/i.test(cc) && isStatic) findings.push('private on a static asset — blocks shared caches');
    if (!etag && !lastMod) findings.push('no ETag and no Last-Modified validator');
    if (isStatic && ttl !== null && ttl < maxAgeMin) findings.push(`static TTL ${ttl}s below ${maxAgeMin}s`);
    if (/\bimmutable\b/i.test(cc) && !maxAge) findings.push('immutable without max-age');
    if (/\bpublic\b/i.test(cc) && /set-cookie/i.test([...h.keys()].join(','))) findings.push('public caching on a response that sets cookies');
    if (vary && /(^|,)\s*\*\s*($|,)/.test(vary)) findings.push('Vary: * disables caching');
    const hasVaryEncoding = /accept-encoding/i.test(vary);
    if (isStatic && !hasVaryEncoding && /\b(gzip|br|deflate)\b/i.test(h.get('content-encoding') || '')) findings.push('compressed asset without Vary: Accept-Encoding');
    if (res.redirected) findings.push(`followed redirect to ${res.url.slice(0, 40)}`);

    rows.push({
      url: url.replace(/^https?:\/\//, '').slice(0, 44),
      status: res.status,
      cacheControl: cc.slice(0, 34) || '—',
      ttl: ttl === null ? '—' : (ttl >= 86400 ? `${Math.round(ttl / 86400)}d` : ttl >= 3600 ? `${Math.round(ttl / 3600)}h` : `${ttl}s`),
      etag: etag ? 'yes' : '—',
      lastMod: lastMod ? 'yes' : '—',
      expires: expires ? 'yes' : '—',
      vary: vary.slice(0, 20) || '—',
      findings: findings.join('; ').slice(0, 60),
      isStatic,
      severity: findings.length ? (findings.some((f) => /no-store|no Cache-Control|below|disagrees/.test(f)) ? 'MEDIUM' : 'LOW') : 'OK',
    });
  } catch (e) {
    rows.push({ url: url.replace(/^https?:\/\//, '').slice(0, 44), status: e.name === 'AbortError' ? 'TIMEOUT' : 'ERR', cacheControl: '', ttl: '', etag: '', lastMod: '', expires: '', vary: '', findings: (e?.cause?.code || e.message).slice(0, 40), severity: 'HIGH' });
  } finally { clearTimeout(timer); }
}

const withIssues = rows.filter((r) => r.severity && r.severity !== 'OK');
const statics = rows.filter((r) => r.isStatic);

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: src, checked: rows.length, issues: withIssues.length, staticAssets: statics.length, results: rows }, null, 2));
} else {
  console.log(`${src} — ${rows.length} URL(s) checked, ${withIssues.length} with caching issues, ${statics.length} static asset(s)\n`);
  console.log(table(rows.map((r) => ({
    url: r.url,
    st: r.status,
    'cache-control': r.cacheControl,
    ttl: r.ttl,
    etag: r.etag,
    'last-mod': r.lastMod,
    expires: r.expires,
    vary: r.vary,
    sev: r.severity || '',
  }))));
  if (withIssues.length) {
    console.log('\nfindings:');
    for (const r of withIssues) console.log(`  ${r.url}\n    ${r.findings}`);
  } else {
    console.log('\nno header conflicts detected');
  }
  const noValidator = rows.filter((r) => r.etag === '—' && r.lastMod === '—' && r.status === 200).length;
  if (noValidator) console.log(`\n${noValidator} URL(s) have no ETag and no Last-Modified`);
}
