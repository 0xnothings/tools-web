#!/usr/bin/env node
// searchurl.js — build correctly-formed search engine query URLs.
// Copyright (c) 2026 0xnothings
// @tool searchurl
// @desc Compose properly percent-encoded search URLs for Google, Bing, DuckDuckGo, Startpage, Brave and Yandex from operator combinations, with a shell-safe copy line
// @usage node tools/searchurl.js site:example.com filetype:pdf --engine google,ddg
// @tags web,seo,cli
import { args, get, num, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`searchurl — search engine URL builder

  node tools/searchurl.js "<query>" [options]

  --engine <list>  engines: google, bing, ddg, startpage, brave, yandex, mojeek
                   (default: google,bing,ddg)
  --site <domain>  prepend site:<domain> to the query
  --filetype <ext> prepend filetype:<ext>
  --intitle <text> prepend intitle:"<text>"
  --inurl <text>   prepend inurl:<text>
  --exclude <list> comma-separated terms to exclude with -
  --limit <n>      add &num=<n> where the engine supports it
  --group          print grouped operator suggestions instead of URLs
  --json           machine-readable output
  -h, --help       this text`); 
  process.exit(0);
}

const ENGINES = {
  google: { base: 'https://www.google.com/search', q: 'q', extra: (lim) => (lim ? { num: String(lim) } : {}), ops: ['site:', 'filetype:', 'intitle:', 'inurl:', 'intext:', '-', 'OR', 'after:', 'before:'] },
  bing: { base: 'https://www.bing.com/search', q: 'q', extra: (lim) => (lim ? { count: String(lim) } : {}), ops: ['site:', 'filetype:', 'intitle:', 'inurl:', 'inbody:', '-', 'OR'] },
  ddg: { base: 'https://duckduckgo.com/', q: 'q', extra: () => ({}), ops: ['site:', 'filetype:', 'intitle:', 'inurl:', '-', 'OR'] },
  startpage: { base: 'https://www.startpage.com/sp/search', q: 'query', extra: () => ({}), ops: ['site:', 'filetype:', 'intitle:', '-'] },
  brave: { base: 'https://search.brave.com/search', q: 'q', extra: () => ({}), ops: ['site:', 'filetype:', 'intitle:', 'inurl:', '-'] },
  yandex: { base: 'https://yandex.com/search/', q: 'text', extra: () => ({}), ops: ['site:', 'mime:', 'title:', 'url:', '-'] },
  mojeek: { base: 'https://www.mojeek.com/search', q: 'q', extra: () => ({}), ops: ['site:', 'inurl:', 'intitle:', '-'] },
};

const GROUP_PRESETS = [
  { name: 'credential exposure', query: 'site:{site} (filetype:env OR filetype:sql OR filetype:log OR filetype:bak)' },
  { name: 'admin panels', query: 'site:{site} (inurl:admin OR inurl:login OR inurl:dashboard)' },
  { name: 'directory listings', query: 'site:{site} intitle:"index of"' },
  { name: 'config leaks', query: 'site:{site} (filetype:config OR filetype:ini OR filetype:yaml)' },
  { name: 'api docs', query: 'site:{site} (inurl:swagger OR inurl:openapi OR inurl:api-docs)' },
  { name: 'error pages', query: 'site:{site} ("stack trace" OR "sql syntax" OR "fatal error")' },
  { name: 'cloud buckets', query: 'site:{site} (s3.amazonaws.com OR blob.core.windows.net OR storage.googleapis.com)' },
  { name: 'backup archives', query: 'site:{site} (filetype:zip OR filetype:tar.gz OR filetype:sql.gz)' },
];

const rawParts = o._.slice();
const site = get(o, 'site', null);
const filetype = get(o, 'filetype', null);
const intitle = get(o, 'intitle', null);
const inurl = get(o, 'inurl', null);
const exclude = get(o, 'exclude', null) ? String(get(o, 'exclude')).split(',').map((s) => s.trim()).filter(Boolean) : [];
const limit = get(o, 'limit', null) ? num(get(o, 'limit'), 0) : 0;

const enginesArg = String(get(o, 'engine', 'google,bing,ddg')).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const unknown = enginesArg.filter((e) => !ENGINES[e]);
if (unknown.length) die(`unknown engine(s): ${unknown.join(', ')} — available: ${Object.keys(ENGINES).join(', ')}`);

function buildQuery() {
  const parts = [];
  if (site) parts.push(`site:${site}`);
  if (filetype) parts.push(`filetype:${filetype}`);
  if (intitle) parts.push(`intitle:"${intitle}"`);
  if (inurl) parts.push(`inurl:${inurl}`);
  if (rawParts.length) parts.push(rawParts.join(' '));
  for (const ex of exclude) parts.push(`-${ex.startsWith('-') ? ex.slice(1) : ex}`);
  if (!parts.length) die('empty query — pass a query string or at least one operator flag');
  return parts.join(' ');
}

function buildUrl(engine, query) {
  const e = ENGINES[engine];
  const params = new globalThis.URLSearchParams();
  params.set(e.q, query);
  for (const [k, v] of Object.entries(e.extra(limit))) params.set(k, v);
  return `${e.base}?${params.toString()}`;
}

const rows = [];
if (flag(o, 'group')) {
  const siteName = site || (rawParts[0] && /^[\w.-]+\.[a-z]{2,}$/i.test(rawParts[0]) ? rawParts[0] : 'example.com');
  for (const preset of GROUP_PRESETS) {
    const q = preset.query.replace(/\{site\}/g, siteName);
    rows.push({ preset: preset.name, query: q, url: buildUrl(enginesArg[0], q) });
  }
  if (flag(o, 'json')) console.log(JSON.stringify({ site: siteName, engine: enginesArg[0], presets: rows.map((r) => ({ name: r.preset, query: r.query, url: r.url })) }, null, 2));
  else {
    console.log(`operator presets for ${siteName} on ${enginesArg[0]}\n`);
    for (const r of rows) {
      console.log(`${r.preset}`);
      console.log(`  ${r.query}`);
      console.log(`  ${r.url}\n`);
    }
  }
  process.exit(0);
}

const query = buildQuery();
const built = enginesArg.map((engine) => {
  const url = buildUrl(engine, query);
  const ops = ENGINES[engine].ops;
  const usedOps = [...query.matchAll(/\b(site|filetype|intitle|inurl|intext|inbody|mime|title|url):/gi)].map((m) => m[1].toLowerCase() + ':');
  const unsupported = usedOps.filter((op) => !ops.some((o2) => o2 === op));
  return { engine, url, length: url.length, unsupported: unsupported.length ? unsupported.join(',') : '' };
});

if (flag(o, 'json')) {
  console.log(JSON.stringify({ query, engines: built }, null, 2));
} else {
  console.log(`query: ${query}\n`);
  console.log(table(built.map((b) => ({ engine: b.engine, 'url length': b.length, 'unsupported ops': b.unsupported || '—' }))));
  console.log('');
  for (const b of built) {
    console.log(`${b.engine}:`);
    console.log(b.url);
    if (b.unsupported) console.log(`  note: ${b.engine} does not honour ${b.unsupported}`);
    console.log('');
  }
  console.log('tip: --group prints ready-made operator presets for a domain');
}
