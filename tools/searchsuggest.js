#!/usr/bin/env node
// searchsuggest.js — query public search-suggest endpoints for keyword research.
// Copyright (c) 2026 0xnothings
// @tool searchsuggest
// @desc Collect autocomplete suggestions from DuckDuckGo, Wikipedia, Google and Brave for keyword research
// @usage node tools/searchsuggest.js "rust async" --source ddg,wiki --expand --json
// @tags web,seo,research
import { args, get, num, flag, die, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`searchsuggest — autocomplete harvester

  node tools/searchsuggest.js "<seed>" [options]

  --source <list>   ddg, wiki, google, brave, youtube (comma list; default ddg,wiki)
  --lang <code>     language hint (default en)
  --expand          also suggest for "<seed> a".."<seed> z" (alphabet soup)
  --questions       also run the question prefixes: how, what, why, when, where, who, is, can
  --limit <n>       suggestions per query (default 10)
  --delay <ms>      delay between requests (default 200)
  --json            machine-readable output
  -h, --help        this text

  Only public, unauthenticated JSON endpoints are used. Suggestions are deduped
  across sources and ranked by how many sources returned them.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const seed = o._[0];
if (!seed) die('usage: node tools/searchsuggest.js "<seed>" [--source ddg,wiki] [--json]');

const sources = String(get(o, 'source', 'ddg,wiki')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const lang = String(get(o, 'lang', 'en'));
const limit = Math.max(1, Math.min(25, num(get(o, 'limit'), 10)));
const delayMs = Math.max(0, num(get(o, 'delay'), 200));

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json,*/*' } });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, error: 'non-JSON', text: text.slice(0, 120) }; }
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) }; }
  finally { clearTimeout(t); }
}

const ENDPOINTS = {
  ddg: async (q) => {
    const r = await getJson(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list&kl=${lang}-${lang}`);
    if (!r.ok || !Array.isArray(r.data)) return { error: r.error || 'unexpected payload' };
    /* two shapes: ["q", ["s1","s2"]] or [{phrase:"s1"},{phrase:"s2"}] */
    const raw = Array.isArray(r.data[1]) ? r.data[1] : r.data;
    const items = raw.map((x) => (typeof x === 'string' ? x : (x && (x.phrase || x.suggestion)) || null)).filter(Boolean);
    return { items: items.slice(0, limit) };
  },
  wiki: async (q) => {
    const r = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${limit}&namespace=0&format=json&origin=*`);
    if (!r.ok || !Array.isArray(r.data)) return { error: r.error || 'unexpected payload' };
    return { items: (r.data[1] || []).slice(0, limit), descriptions: (r.data[2] || []).slice(0, limit) };
  },
  google: async (q) => {
    const r = await getJson(`https://suggestqueries.google.com/complete/search?client=firefox&hl=${lang}&q=${encodeURIComponent(q)}`);
    if (!r.ok || !Array.isArray(r.data)) return { error: r.error || 'unexpected payload' };
    return { items: (r.data[1] || []).slice(0, limit) };
  },
  brave: async (q) => {
    const r = await getJson(`https://search.brave.com/api/suggest?q=${encodeURIComponent(q)}&country=us&lang=${lang}`);
    if (!r.ok || !r.data) return { error: r.error || 'unexpected payload' };
    const items = (r.data.results || []).map((x) => (typeof x === 'string' ? x : x.q || x.title)).filter(Boolean);
    return { items: items.slice(0, limit) };
  },
  youtube: async (q) => {
    const r = await getJson(`https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=${lang}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return { error: r.error || 'unexpected payload' };
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '')); } catch { return { error: 'unparseable youtube payload' }; } }
    if (!Array.isArray(data) || !Array.isArray(data[1])) return { error: 'unexpected payload' };
    return { items: (data[1] || []).map((x) => (Array.isArray(x) ? x[0] : x)).filter(Boolean).slice(0, limit) };
  },
};

const queries = [{ q: seed, kind: 'seed' }];
if (flag(o, 'expand')) for (const c of 'abcdefghijklmnopqrstuvwxyz') queries.push({ q: `${seed} ${c}`, kind: 'alpha' });
if (flag(o, 'questions')) {
  for (const p of ['how', 'what', 'why', 'when', 'where', 'who', 'is', 'can', 'should', 'does'])
    queries.push({ q: `${p} ${seed}`, kind: 'question' });
}

const hits = new Map();
const sourceStats = Object.fromEntries(sources.map((s) => [s, { queries: 0, items: 0, errors: [] }]));
const perQuery = [];

for (const { q, kind } of queries) {
  const row = { query: q, kind, sources: {} };
  for (const s of sources) {
    const fn = ENDPOINTS[s];
    if (!fn) { row.sources[s] = { error: 'unknown source' }; continue; }
    const r = await fn(q);
    sourceStats[s].queries++;
    if (r.error) { sourceStats[s].errors.push(`${q}: ${r.error}`); row.sources[s] = { error: r.error }; continue; }
    sourceStats[s].items += r.items.length;
    row.sources[s] = { count: r.items.length };
    for (const item of r.items) {
      const key = String(item).trim().toLowerCase();
      if (!key) continue;
      const prev = hits.get(key) || { text: String(item).trim(), sources: [], kinds: new Set(), bestRank: Infinity };
      if (!prev.sources.includes(s)) prev.sources.push(s);
      prev.kinds.add(kind);
      const rank = r.items.indexOf(item);
      prev.bestRank = Math.min(prev.bestRank, rank);
      hits.set(key, prev);
    }
    if (delayMs) await sleep(delayMs);
  }
  perQuery.push(row);
}

const merged = [...hits.values()]
  .map((h) => ({ text: h.text, sources: h.sources, sourceCount: h.sources.length, kinds: [...h.kinds], bestRank: h.bestRank }))
  .sort((a, b) => b.sourceCount - a.sourceCount || a.bestRank - b.bestRank || a.text.localeCompare(b.text));

const report = {
  seed, lang, sources, queries: queries.length, suggestions: merged.length,
  sourceStats,
  results: merged,
  queryLog: perQuery,
};

if (flag(o, 'json')) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; } else {
  console.log(`"${seed}" — ${queries.length} queries across ${sources.length} source(s)`);
  console.log(`${merged.length} unique suggestions\n`);
  const usable = merged.filter((m) => !m.text.toLowerCase().trim().startsWith(seed.toLowerCase().trim()) || m.text.trim().toLowerCase() !== seed.trim().toLowerCase());
  console.log(table(usable.slice(0, 60).map((m) => ({
    src: m.sourceCount,
    from: m.sources.join(','),
    via: m.kinds.join(','),
    suggestion: m.text.slice(0, 62),
  }))));
  if (usable.length > 60) console.log(`\n${usable.length - 60} more — use --json for the full list`);
  console.log('\nSOURCES');
  console.log(table(Object.entries(sourceStats).map(([s, v]) => ({ source: s, queries: v.queries, items: v.items, errors: v.errors.length }))));
  const hadErrors = Object.entries(sourceStats).filter(([, v]) => v.errors.length);
  if (hadErrors.length) {
    console.log('\nsource errors:');
    for (const [s, v] of hadErrors) console.log(`  ${s}: ${v.errors[0]}`);
  }
}
process.exitCode = 0;
