#!/usr/bin/env node
// hreflanggraph.js — build an hreflang cluster map and report reciprocity gaps.
// Copyright (c) 2026 0xnothings
// @tool hreflanggraph
// @desc Collect alternate hreflang annotations across a page set, group them into language clusters and flag missing return links, bad codes and self-reference errors
// @usage node tools/hreflanggraph.js https://example.com --max 10
// @tags web,seo,i18n
import { args, get, num, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`hreflanggraph — hreflang cluster and reciprocity audit

  node tools/hreflanggraph.js <seed-url|url-list-file> [options]

  --max <n>       crawl at most n pages from the seed (default 10)
  --sitemap       also read xhtml:link alternates from /sitemap.xml of the seed host
  --json          machine-readable output
  -h, --help      this text

  Validates: reciprocity (A->B must have B->A), x-default presence, duplicate
  hreflang for one URL, invalid language tags, self-referencing entries missing.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const src = o._[0];
if (!src) die('usage: node tools/hreflanggraph.js <seed-url|url-list-file>');
const max = Math.max(1, num(get(o, 'max'), 10));

const VALID_LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function norm(raw) {
  try { const u = new globalThis.URL(raw); return u.href.replace(/#.*$/, ''); } catch { return null; }
}

async function grab(url) {
  if (!/^https?:\/\//i.test(url)) {
    try { const { readFileSync } = await import('node:fs'); return { status: 200, body: readFileSync(url, 'utf8'), final: url }; }
    catch (e) { return { status: 0, body: '', final: url, error: e.code }; }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    return { status: res.status, body: await res.text(), final: res.url };
  } catch (e) {
    return { status: 0, body: '', final: url, error: e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}

function alternates(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const relv = (tag.match(/rel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    if (!/\balternate\b/i.test(relv)) continue;
    const hl = (tag.match(/hreflang\s*=\s*["']([^"']+)/i) || [])[1];
    const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (!hl || !href) continue;
    let abs = href;
    try { abs = new globalThis.URL(href, base).href; } catch { /* keep */ }
    out.push({ hreflang: hl.trim().toLowerCase(), href: norm(abs) || abs });
  }
  return out;
}

const linksOf = (html, base) => {
  const out = new Set();
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const n = norm((() => { try { return new globalThis.URL(href, base).href; } catch { return ''; } })());
    if (n) out.add(n);
  }
  return [...out];
};

let pages = [];
if (/^https?:\/\//i.test(src)) {
  const root = norm(src);
  const host = new globalThis.URL(root).host;
  const seen = new Set([root]);
  const queue = [{ url: root, d: 0 }];
  while (queue.length && pages.length < max) {
    const { url, d } = queue.shift();
    const r = await grab(url);
    pages.push({ url, final: r.final, status: r.status || r.error, body: r.body });
    if (d < 2 && pages.length < max) {
      for (const l of linksOf(r.body, r.final)) {
        if (new globalThis.URL(l).host !== host || seen.has(l) || seen.size >= max * 3) continue;
        seen.add(l);
        queue.push({ url: l, d: d + 1 });
      }
    }
  }
  if (flag(o, 'sitemap')) {
    const sm = await grab(`https://${host}/sitemap.xml`);
    const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).filter((u) => !/\.(xml|gz)$/i.test(u));
    for (const u of locs.slice(0, Math.max(0, max - pages.length))) {
      const r = await grab(u);
      pages.push({ url: u, final: r.final, status: r.status || r.error, body: r.body });
    }
  }
} else {
  const list = await inputLines(src);
  for (const u of list.slice(0, max)) {
    const r = await grab(u);
    pages.push({ url: u, final: r.final, status: r.status || r.error, body: r.body });
  }
}

const map = new Map();
for (const p of pages) {
  const alts = alternates(p.body, p.final);
  map.set(p.final, { page: p, alts });
}

const clusters = new Map();
for (const [pageUrl, entry] of map) {
  if (!entry.alts.length) continue;
  const keys = entry.alts.map((a) => a.href).sort();
  const key = keys.join('|');
  const root = (() => { try { return new globalThis.URL(pageUrl).pathname; } catch { return pageUrl; } })();
  const existing = clusters.get(key);
  if (existing) existing.pages.push(pageUrl);
  else clusters.set(key, { key, pages: [pageUrl], alts: entry.alts, path: root });
}

const findings = [];
for (const [pageUrl, entry] of map) {
  if (!entry.alts.length) { findings.push({ page: pageUrl, issue: 'no-alternates', detail: 'page declares no hreflang alternates', severity: 'INFO' }); continue; }
  const tags = entry.alts.map((a) => a.hreflang);
  const dupTags = tags.filter((t, i) => tags.indexOf(t) !== i);
  if (dupTags.length) findings.push({ page: pageUrl, issue: 'duplicate-hreflang', detail: [...new Set(dupTags)].join(','), severity: 'MEDIUM' });
  for (const a of entry.alts) {
    if (a.hreflang !== 'x-default' && !VALID_LANG.test(a.hreflang)) {
      findings.push({ page: pageUrl, issue: 'invalid-lang-code', detail: a.hreflang, severity: 'MEDIUM' });
    }
  }
  if (!tags.includes('x-default')) findings.push({ page: pageUrl, issue: 'missing-x-default', detail: 'no x-default alternate', severity: 'LOW' });
  const selfEntry = entry.alts.find((a) => a.href === pageUrl || a.href.replace(/\/$/, '') === pageUrl.replace(/\/$/, ''));
  if (!selfEntry) findings.push({ page: pageUrl, issue: 'missing-self-reference', detail: 'no alternate pointing at this URL', severity: 'MEDIUM' });
  for (const a of entry.alts) {
    const other = map.get(a.href);
    if (other) {
      const back = other.alts.some((x) => x.href === pageUrl || x.href.replace(/\/$/, '') === pageUrl.replace(/\/$/, ''));
      if (!back) findings.push({ page: pageUrl, issue: 'no-return-link', detail: `${a.hreflang} -> ${a.href} does not link back`, severity: 'HIGH' });
    } else if (/^https?:/i.test(a.href)) {
      const r = await grab(a.href);
      if (r.status && r.status >= 400) findings.push({ page: pageUrl, issue: 'target-unreachable', detail: `${a.hreflang} -> ${a.href} (HTTP ${r.status})`, severity: 'HIGH' });
    }
  }
}

const langTally = new Map();
for (const [, entry] of map) for (const a of entry.alts) langTally.set(a.hreflang, (langTally.get(a.hreflang) || 0) + 1);

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: src,
    pagesAudited: pages.length,
    clusters: [...clusters.values()].map((c) => ({ hreflangs: c.alts.map((a) => a.hreflang), pages: c.pages, targets: c.alts.map((a) => a.href) })),
    languages: Object.fromEntries(langTally),
    findings,
  }, null, 2));
} else {
  console.log(`${src} — ${pages.length} page(s) audited, ${clusters.size} cluster(s), ${findings.length} finding(s)\n`);
  if (clusters.size) {
    for (const c of [...clusters.values()].slice(0, 6)) {
      console.log(`cluster  ${c.alts.map((a) => a.hreflang).join(', ')}`);
      console.log(table(c.alts.map((a) => ({ hreflang: a.hreflang, target: a.href.replace(/^https?:\/\//, '').slice(0, 56) }))));
      console.log('');
    }
  } else console.log('no hreflang annotations found on any audited page\n');
  if (langTally.size) console.log('languages seen: ' + [...langTally.entries()].map(([k, v]) => `${k}(${v})`).join(' '));
  if (findings.length) {
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
    console.log('\nfindings:');
    console.log(table(findings.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 24).map((f) => ({
      severity: f.severity,
      issue: f.issue,
      page: f.page.replace(/^https?:\/\//, '').slice(0, 34),
      detail: f.detail.slice(0, 50),
    }))));
  }
}
