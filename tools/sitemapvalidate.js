#!/usr/bin/env node
// sitemapvalidate.js — validate sitemap.xml and sitemap index files against the spec.
// Copyright (c) 2026 0xnothings
// @tool sitemapvalidate
// @desc Check URL and sitemap-index files for spec violations: bad lastmod format, out-of-range priority or changefreq values, non-absolute locs, size and count limits, and gzip handling
// @usage node tools/sitemapvalidate.js https://example.com/sitemap.xml
// @tags web,seo,validation
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`sitemapvalidate — sitemap spec check

  node tools/sitemapvalidate.js <sitemap-url-or-file> [options]

  --children       also validate every child sitemap of a sitemap index
  --max-urls <n>   flag files exceeding this URL count (default 50000)
  --max-bytes <n>  flag files exceeding this size in bytes (default 52428800)
  --json           machine-readable output
  -h, --help       this text

  Checks: XML well-formedness (basic), required loc, absolute http(s) URL,
  lastmod W3C datetime, priority in [0.0,1.0], changefreq vocabulary,
  duplicate locs, entity escaping, and the 50k URL / 50 MB limits.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const src = o._[0];
if (!src) die('usage: node tools/sitemapvalidate.js <sitemap-url-or-file>');

const maxUrls = Math.max(1, num(get(o, 'max-urls'), 50000));
const maxBytes = Math.max(1024, num(get(o, 'max-bytes'), 52428800));
const CHANGEFREQ = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);
const LASTMOD_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;

async function loadRaw(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const gz = /gzip/i.test(res.headers.get('content-type') || '') || t.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b);
      return { buf, text: gz ? gunzipSync(buf).toString('utf8') : buf.toString('utf8'), gzipped: gz, final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  const buf = readFileSync(t === '-' ? 0 : t);
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  return { buf, text: gz ? gunzipSync(buf).toString('utf8') : buf.toString('utf8'), gzipped: gz, final: t };
}

function validateOne(doc, label) {
  const issues = [];
  const err = (severity, rule, detail) => issues.push({ severity, rule, detail });
  const isIndex = /<sitemapindex\b/i.test(doc.text);
  const isUrlset = /<urlset\b/i.test(doc.text);
  if (!isIndex && !isUrlset) {
    err('HIGH', 'root-element', 'neither <urlset> nor <sitemapindex> found');
    return { label, kind: 'unknown', urlCount: 0, issues, gzipped: doc.gzipped, bytes: doc.buf.length };
  }
  if (!/^\s*<\?xml/i.test(doc.text)) err('LOW', 'xml-declaration', 'missing <?xml ... ?> declaration');
  const nsOk = /xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/(0\.9|sitemap)["']/i.test(doc.text) || /xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i.test(doc.text);
  if (!nsOk) err('MEDIUM', 'namespace', 'urlset/sitemapindex missing the sitemaps.org namespace');
  const opens = (doc.text.match(/<url\b/gi) || []).length + (doc.text.match(/<sitemap\b/gi) || []).length;
  const closes = (doc.text.match(/<\/url>/gi) || []).length + (doc.text.match(/<\/sitemap>/gi) || []).length;
  if (opens !== closes) err('HIGH', 'well-formedness', `${opens} opening vs ${closes} closing block tags`);

  const blockTag = isIndex ? 'sitemap' : 'url';
  const blocks = [...doc.text.matchAll(new RegExp(`<${blockTag}\\b[^>]*>([\\s\\S]*?)</${blockTag}>`, 'gi'))].map((m) => m[1]);
  if (!blocks.length) err('HIGH', 'empty', `no <${blockTag}> entries found`);

  const seen = new Set();
  let badLoc = 0, badLastmod = 0, badPriority = 0, badFreq = 0, dupes = 0;
  for (const blk of blocks) {
    const loc = (/<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(blk) || [])[1];
    if (!loc) { badLoc++; err('HIGH', 'missing-loc', 'entry without <loc>'); continue; }
    const clean = loc.trim();
    if (!/^https?:\/\/\S+$/i.test(clean)) { badLoc++; err('HIGH', 'loc-scheme', `not an absolute http(s) URL: ${clean.slice(0, 60)}`); }
    if (/[&](?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(clean)) err('MEDIUM', 'unescaped-entity', `raw & in loc: ${clean.slice(0, 60)}`);
    if (seen.has(clean)) { dupes++; err('MEDIUM', 'duplicate-loc', clean.slice(0, 70)); }
    seen.add(clean);
    const lm = (/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i.exec(blk) || [])[1];
    if (lm !== undefined) {
      const v = lm.trim();
      if (!LASTMOD_RE.test(v)) { badLastmod++; err('MEDIUM', 'lastmod-format', `not W3C datetime: ${v.slice(0, 40)}`); }
      else if (Number.isNaN(Date.parse(v))) { badLastmod++; err('MEDIUM', 'lastmod-invalid', `unparseable date: ${v.slice(0, 40)}`); }
      else if (Date.parse(v) > Date.now() + 86400000) err('LOW', 'lastmod-future', `date in the future: ${v.slice(0, 40)}`);
    }
    const pr = (/<priority\b[^>]*>([\s\S]*?)<\/priority>/i.exec(blk) || [])[1];
    if (pr !== undefined) {
      const n = Number(pr.trim());
      if (!Number.isFinite(n) || n < 0 || n > 1) { badPriority++; err('MEDIUM', 'priority-range', `${pr.trim()} outside [0.0,1.0]`); }
    }
    const cf = (/<changefreq\b[^>]*>([\s\S]*?)<\/changefreq>/i.exec(blk) || [])[1];
    if (cf !== undefined && !CHANGEFREQ.has(cf.trim().toLowerCase())) { badFreq++; err('MEDIUM', 'changefreq-value', cf.trim().slice(0, 30)); }
    if (isIndex && /\.xml\.gz$/i.test(clean) === false && !/\.xml$/i.test(clean)) err('LOW', 'child-extension', `child sitemap not .xml: ${clean.slice(0, 60)}`);
  }
  if (blocks.length > maxUrls) err('HIGH', 'url-count', `${blocks.length} entries exceeds limit ${maxUrls}`);
  if (doc.buf.length > maxBytes) err('HIGH', 'file-size', `${doc.buf.length} bytes exceeds limit ${maxBytes}`);
  if (doc.gzipped && doc.buf.length > 52428800) err('HIGH', 'gzip-size', 'gzipped file over 50 MB');
  return {
    label,
    kind: isIndex ? 'sitemapindex' : 'urlset',
    urlCount: blocks.length,
    gzipped: doc.gzipped,
    bytes: doc.buf.length,
    issues,
    entries: blocks.length,
  };
}

const root = await loadRaw(src);
const results = [validateOne(root, src)];
if (flag(o, 'children') && results[0].kind === 'sitemapindex') {
  const children = [...root.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim());
  for (const child of children.slice(0, 15)) {
    try {
      const doc = await loadRaw(child);
      results.push(validateOne(doc, child));
    } catch (e) {
      results.push({ label: child, kind: 'unreachable', urlCount: 0, gzipped: false, bytes: 0, issues: [{ severity: 'HIGH', rule: 'child-unreachable', detail: e.message.slice(0, 80) }], entries: 0 });
    }
  }
}

const allIssues = results.flatMap((r) => r.issues.map((i) => ({ ...i, where: r.label })));
const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const sorted = allIssues.sort((a, b) => rank[a.severity] - rank[b.severity]);

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: src, files: results.map((r) => ({ label: r.label, kind: r.kind, entries: r.entries, bytes: r.bytes, gzipped: r.gzipped, issueCount: r.issues.length })), issueCount: allIssues.length, issues: sorted }, null, 2));
} else {
  console.log(`${src}\n`);
  console.log(table(results.map((r) => ({ file: r.label.replace(/^https?:\/\//, '').slice(0, 46), kind: r.kind, entries: r.entries, bytes: r.bytes, gzip: r.gzipped ? 'yes' : 'no', issues: r.issues.length }))));
  if (sorted.length) {
    console.log(`\n${sorted.length} issue(s):`);
    console.log(table(sorted.slice(0, 30).map((i) => ({ severity: i.severity, rule: i.rule, detail: i.detail.slice(0, 50), where: i.where.replace(/^https?:\/\//, '').slice(0, 30) }))));
  } else {
    console.log('\nno spec violations found');
  }
  const total = results.reduce((a, r) => a + r.entries, 0);
  console.log(`\n${total} total entr(ies) across ${results.length} file(s)`);
}
process.exitCode = sorted.some((i) => i.severity === 'HIGH') ? 1 : 0;
