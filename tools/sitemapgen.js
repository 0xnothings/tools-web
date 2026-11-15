#!/usr/bin/env node
// sitemapgen.js — crawl a site shallowly and emit sitemap.xml.
// Copyright (c) 2026 0xnothings
// @tool sitemapgen
// @desc Breadth-first crawl of one origin and emit a valid sitemap.xml (or JSON url list)
// @usage node tools/sitemapgen.js https://example.com --depth 2 --max 100 --json
// @tags web,seo,crawler
import { args, get, num, flag, die } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`sitemapgen — shallow crawler that produces sitemap.xml

  node tools/sitemapgen.js <start-url> [options]

  --depth <n>        crawl depth from the start URL (default 2)
  --max <n>          hard page cap (default 200)
  --out <file>       write the sitemap to a file instead of stdout
  --keep-query       keep query strings (default: stripped)
  --lastmod          add <lastmod> from the Last-Modified response header
  --json             emit the URL list as JSON (skips XML)
  -h, --help         this text

  Same-origin only. Assets (.jpg/.pdf/.zip/...) are collected as counts, never listed.
  Honours a politeness delay of --delay ms between requests (default 0).`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const start = o._[0];
if (!start) die('usage: node tools/sitemapgen.js <start-url> [--depth 2] [--max 200]');

let origin;
try { origin = new URL(/^https?:\/\//i.test(start) ? start : `https://${start}`); }
catch { die(`not a valid url: ${start}`); }

const depthMax = Math.max(0, num(get(o, 'depth'), 2));
const pageMax = Math.max(1, num(get(o, 'max'), 200));
const delayMs = Math.max(0, num(get(o, 'delay'), 0));
const keepQuery = flag(o, 'keep-query');

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|zip|gz|tar|rar|7z|exe|dmg|apk|xlsx?|docx?|pptx?|csv)$/i;

const seen = new Set();
const pages = [];
const assets = new Set();
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== origin.origin) return null;
  u.hash = '';
  if (!keepQuery) u.search = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

async function page(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('html') ? await res.text() : '';
    return { status: res.status, type, body, lastmod: res.headers.get('last-modified') };
  } catch (e) {
    return { status: 0, type: '', body: '', error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data|blob):/i.test(href)) continue;
    const abs = normalize(href, base);
    if (abs) out.push(abs);
  }
  return out;
}

let frontier = [normalize(start, origin.toString()) || origin.toString()];
seen.add(frontier[0]);
let depth = 0;

while (frontier.length && depth <= depthMax && pages.length < pageMax) {
  const next = [];
  const queue = frontier.slice(0, Math.max(0, pageMax - pages.length));
  const CONC = 5;
  for (let i = 0; i < queue.length; i += CONC) {
    const batch = queue.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (url) => ({ url, r: await page(url) })));
    for (const { url, r } of results) {
      if (!r.status) { errors.push({ url, error: r.error }); continue; }
      if (ASSET.test(new URL(url).pathname)) { assets.add(url); continue; }
      if (!(r.type || '').includes('html')) { assets.add(url); continue; }
      if (r.status >= 400) { errors.push({ url, error: `HTTP ${r.status}` }); continue; }
      pages.push({ loc: url, lastmod: r.lastmod, status: r.status });
      if (depth < depthMax) {
        for (const l of links(r.body, url)) {
          if (seen.has(l)) continue;
          seen.add(l);
          if (ASSET.test(new URL(l).pathname)) { assets.add(l); continue; }
          next.push(l);
        }
      }
    }
    if (delayMs) await sleep(delayMs);
  }
  frontier = next.slice(0, Math.max(0, pageMax - pages.length));
  depth++;
}

const sorted = pages.sort((a, b) => a.loc.localeCompare(b.loc));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    start: origin.toString(), origin: origin.origin, depth: depthMax,
    pages: sorted.map((p) => ({ loc: p.loc, status: p.status, lastmod: p.lastmod || null })),
    pageCount: sorted.length, assetCount: assets.size, errors,
  }, null, 2));
  process.exitCode = 0;
} else {
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sorted.map((p) => {
    const parts = [`    <loc>${esc(p.loc)}</loc>`];
    if (flag(o, 'lastmod') && p.lastmod) {
      const d = new Date(p.lastmod);
      if (!isNaN(d.getTime())) parts.push(`    <lastmod>${d.toISOString().slice(0, 10)}</lastmod>`);
    }
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  }),
  '</urlset>',
].join('\n');

const outFile = get(o, 'out', null);
if (outFile) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outFile, xml + '\n', 'utf8');
  process.stderr.write(`wrote ${outFile} — ${sorted.length} urls\n`);
} else {
  console.log(xml);
}
if (errors.length) process.stderr.write(`${errors.length} fetch errors (first: ${errors[0].url} ${errors[0].error})\n`);
}
