#!/usr/bin/env node
// sitemapdiff.js — diff two sitemap.xml files.
// Copyright (c) 2026 0xnothings
// @tool sitemapdiff
// @desc Compare two sitemaps and report URLs added, removed, lastmod-changed, priority-changed, plus which new URLs look like they should be polled for indexing first
// @usage node tools/sitemapdiff.js sitemap-old.xml https://example.com/sitemap.xml
// @tags web,seo,diff
import { args, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`sitemapdiff — sitemap comparison

  node tools/sitemapdiff.js <before> <after> [options]

  each argument: URL, file path, or '-'

  --no-sitemap-index  do not follow a <sitemapindex> when given a URL
  --json              machine-readable output
  -h, --help          this text

  Reports added / removed URLs, lastmod changes, priority and changefreq
  changes, and ranks the new URLs as index-poll candidates by priority and
  freshness.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const [a, b] = o._;
if (!a || !b) die('usage: node tools/sitemapdiff.js <before> <after>');

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

function decode(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function parseSitemap(xml) {
  const urls = [];
  const idx = [];
  const re = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const blk = m[1];
    const get = (t) => { const x = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(blk); return x ? decode(x[1]) : null; };
    const loc = get('loc');
    if (!loc) continue;
    const links = [...blk.matchAll(/<xhtml:link\b[^>]*hreflang\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["']/gi)].map((x) => ({ hreflang: x[1], href: decode(x[2]) }));
    urls.push({ loc, lastmod: get('lastmod'), changefreq: get('changefreq'), priority: get('priority'), alternates: links });
  }
  const ire = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  while ((m = ire.exec(xml)) !== null) {
    const loc = (/<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(m[1]) || [])[1];
    if (loc) idx.push(decode(loc));
  }
  return { urls, indexEntries: idx, isIndex: idx.length > 0 && urls.length === 0 };
}

async function loadAll(t) {
  const xml = await load(t);
  const parsed = parseSitemap(xml);
  if (!parsed.isIndex || flag(o, 'no-sitemap-index')) return parsed;
  const urls = [...parsed.urls];
  for (const child of parsed.indexEntries.slice(0, 20)) {
    try {
      const childXml = await load(child);
      urls.push(...parseSitemap(childXml).urls);
    } catch { /* child unreachable — recorded by absence */ }
  }
  return { urls, indexEntries: parsed.indexEntries, isIndex: true };
}

const A = await loadAll(a);
const B = await loadAll(b);
const mapA = new Map(A.urls.map((u) => [u.loc, u]));
const mapB = new Map(B.urls.map((u) => [u.loc, u]));

const added = [...mapB.keys()].filter((k) => !mapA.has(k)).map((k) => mapB.get(k));
const removed = [...mapA.keys()].filter((k) => !mapB.has(k)).map((k) => mapA.get(k));
const changed = [];
let identical = 0;
for (const [k, after] of mapB) {
  const before = mapA.get(k);
  if (!before) continue;
  const diffs = [];
  if ((before.lastmod || '') !== (after.lastmod || '')) diffs.push({ field: 'lastmod', before: before.lastmod, after: after.lastmod });
  if ((before.priority || '') !== (after.priority || '')) diffs.push({ field: 'priority', before: before.priority, after: after.priority });
  if ((before.changefreq || '') !== (after.changefreq || '')) diffs.push({ field: 'changefreq', before: before.changefreq, after: after.changefreq });
  const altsA = JSON.stringify(before.alternates);
  const altsB = JSON.stringify(after.alternates);
  if (altsA !== altsB) diffs.push({ field: 'hreflang', before: `${before.alternates.length}`, after: `${after.alternates.length}` });
  if (diffs.length) changed.push({ loc: k, diffs }); else identical++;
}

const pollCandidates = added.slice().sort((x, y) => {
  const px = Number(x.priority || 0.5), py = Number(y.priority || 0.5);
  if (py !== px) return py - px;
  return String(y.lastmod || '').localeCompare(String(x.lastmod || ''));
}).slice(0, 25);

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    before: { source: a, isIndex: A.isIndex, urls: A.urls.length, childSitemaps: A.indexEntries.length },
    after: { source: b, isIndex: B.isIndex, urls: B.urls.length, childSitemaps: B.indexEntries.length },
    added: added.map((u) => ({ loc: u.loc, lastmod: u.lastmod, priority: u.priority })),
    removed: removed.map((u) => ({ loc: u.loc, lastmod: u.lastmod })),
    changed,
    identical,
    pollCandidates: pollCandidates.map((u) => u.loc),
  }, null, 2));
} else {
  console.log(`before ${a}  (${A.urls.length} URL(s)${A.isIndex ? `, ${A.indexEntries.length} child sitemaps` : ''})`);
  console.log(`after  ${b}  (${B.urls.length} URL(s)${B.isIndex ? `, ${B.indexEntries.length} child sitemaps` : ''})`);
  console.log(`\n+${added.length} added   -${removed.length} removed   ~${changed.length} modified   =${identical} unchanged\n`);
  if (added.length) {
    console.log(`added URLs (${added.length}):`);
    console.log(table(added.slice(0, 25).map((u) => ({ lastmod: u.lastmod || '—', priority: u.priority || '—', url: u.loc.replace(/^https?:\/\//, '').slice(0, 58) }))));
  }
  if (removed.length) {
    console.log(`\nremoved URLs (${removed.length}):`);
    console.log(table(removed.slice(0, 25).map((u) => ({ lastmod: u.lastmod || '—', url: u.loc.replace(/^https?:\/\//, '').slice(0, 60) }))));
  }
  if (changed.length) {
    console.log(`\nmodified entries (${changed.length}):`);
    for (const c of changed.slice(0, 15)) {
      console.log(`  ${c.loc.replace(/^https?:\/\//, '').slice(0, 60)}`);
      for (const d of c.diffs) console.log(`    ${d.field}: ${d.before || '(none)'} -> ${d.after || '(none)'}`);
    }
  }
  if (pollCandidates.length) {
    console.log('\nindex-poll candidates (newest + highest priority first):');
    for (const u of pollCandidates.slice(0, 10)) console.log(`  ${u.loc}${u.lastmod ? `  (lastmod ${u.lastmod})` : ''}`);
  }
  if (!added.length && !removed.length && !changed.length) console.log('the two sitemaps are identical');
}
