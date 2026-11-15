#!/usr/bin/env node
// pagerankish.js — internal link graph + PageRank approximation from a small crawl.
// Copyright (c) 2026 0xnothings
// @tool pagerankish
// @desc Crawl a handful of same-host pages, build the internal link graph, and rank every page by in-degree plus a damped PageRank iteration
// @usage node tools/pagerankish.js https://example.com --max 12
// @tags web,seo,crawl
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`pagerankish — internal link graph ranking

  node tools/pagerankish.js <seed-url> [options]

  --max <n>        crawl at most n pages (default 10)
  --depth <n>      BFS depth limit (default 2)
  --all            follow off-host links too (default: same host only)
  --iterations <n> PageRank iterations (default 30, damping 0.85)
  --json           machine-readable output
  -h, --help       this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const seed = o._[0];
if (!seed) die('usage: node tools/pagerankish.js <seed-url> [--max 10]');
if (!/^https?:\/\//i.test(seed)) die('seed must be an http(s) URL');

const max = Math.max(1, num(get(o, 'max'), 10));
const maxDepth = Math.max(0, num(get(o, 'depth'), 2));
const iters = Math.max(1, num(get(o, 'iterations'), 30));
const crossHost = flag(o, 'all');
const seedHost = new globalThis.URL(seed).host;

function norm(raw) {
  let u;
  try { u = new globalThis.URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  if (u.pathname === '') u.pathname = '/';
  return u.href;
}

function linksOf(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new globalThis.URL(href, baseUrl).href; } catch { continue; }
    const n = norm(abs);
    if (n) out.add(n);
  }
  return [...out];
}

async function fetchPage(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('text/html') || type === '' ? await res.text() : '';
    return { status: res.status, body, final: res.url, type };
  } catch (e) {
    return { status: 0, body: '', final: url, type: '', error: e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}

const pages = new Map();
const queue = [{ url: norm(seed), depth: 0 }];
const seen = new Set([norm(seed)]);

while (queue.length && pages.size < max) {
  const { url, depth } = queue.shift();
  const res = await fetchPage(url);
  const outLinks = (/html/i.test(res.type) || res.body) ? linksOf(res.body, res.final) : [];
  pages.set(url, { url, status: res.status, title: (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim().slice(0, 60) || '', out: outLinks, depth, error: res.error || null });
  if (depth < maxDepth) {
    for (const l of outLinks) {
      const host = (() => { try { return new globalThis.URL(l).host; } catch { return ''; } })();
      if (!crossHost && host !== seedHost) continue;
      if (seen.has(l) || pages.size + queue.length >= max) continue;
      seen.add(l);
      queue.push({ url: l, depth: depth + 1 });
    }
  }
}

const urls = [...pages.keys()];
const idx = new Map(urls.map((u, i) => [u, i]));
const edges = urls.map(() => []);
const inDegree = new Map(urls.map((u) => [u, 0]));
for (const [u, p] of pages) {
  for (const l of p.out) {
    if (!idx.has(l)) continue;
    edges[idx.get(u)].push(idx.get(l));
    inDegree.set(l, inDegree.get(l) + 1);
  }
}

const n = urls.length || 1;
const d = 0.85;
let rank = new Array(n).fill(1 / n);
for (let it = 0; it < iters; it++) {
  const next = new Array(n).fill((1 - d) / n);
  let dangling = 0;
  for (let i = 0; i < n; i++) {
    const outs = edges[i];
    if (!outs.length) { dangling += rank[i]; continue; }
    const share = (rank[i] * d) / outs.length;
    for (const j of outs) next[j] += share;
  }
  for (let i = 0; i < n; i++) next[i] += (d * dangling) / n;
  rank = next;
}

const rows = urls.map((u, i) => ({
  url: u.replace(/^https?:\/\//, '').slice(0, 58),
  status: pages.get(u).status || 'ERR',
  in: inDegree.get(u),
  out: edges[i].length,
  pr: rank[i],
  score: (rank[i] * 100).toFixed(3),
  title: pages.get(u).title.slice(0, 34),
})).sort((a, b) => b.pr - a.pr);

const orphans = urls.filter((u) => inDegree.get(u) === 0 && u !== norm(seed));
const deadEnds = urls.filter((u, i) => edges[i].length === 0);
const broken = [...pages.values()].filter((p) => p.status === 0 || p.status >= 400).map((p) => ({ url: p.url, status: p.status || p.error }));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    seed,
    crawled: urls.length,
    pages: rows.map((r, i) => ({ url: urls[rows.indexOf(r)] || r.url, rank: r.pr, inDegree: r.in, outDegree: r.out, status: r.status })),
    orphans, deadEnds, broken,
    edges: urls.flatMap((u, i) => edges[i].map((j) => [u, urls[j]])),
  }, null, 2));
} else {
  console.log(`seed ${seed} — crawled ${urls.length} page(s), ${edges.reduce((a, e) => a + e.length, 0)} internal edge(s)\n`);
  console.log(table(rows.map(({ pr, ...rest }) => rest)));
  if (orphans.length) console.log(`\norphans (no inbound internal link): ${orphans.length}\n  ` + orphans.slice(0, 6).map((u) => u.replace(/^https?:\/\//, '')).join('\n  '));
  if (deadEnds.length) console.log(`\ndead ends (no outbound internal link): ${deadEnds.length}`);
  if (broken.length) console.log(`\nnon-2xx: ${broken.map((b) => `${b.status} ${b.url.replace(/^https?:\/\//, '')}`).join(', ')}`);
  if (urls.length >= max) console.log(`\n--max ${max} reached; raise it to widen the graph`);
}
