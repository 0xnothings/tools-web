// bingindex.js — keyless index-presence probe across search engines.
// Copyright (c) 2026 0xnothings
// @tool bingindex
// @desc Probe whether a URL or site: operator appears indexed on several engines using their public HTML endpoints, and report which returned results with a snippet
// @usage node tools/bingindex.js https://example.com --engines bing,ddg
// @tags web,seo,indexing
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`bingindex — index presence probe

  node tools/bingindex.js <url|domain|query> [options]

  --engines <list>  bing, ddg, mojeek, brave, startpage (default: bing,ddg)
  --exact           wrap the target in quotes
  --site            treat the target as a domain and query site:<domain> instead
  --snippet         print the first returned result title and snippet
  --json            machine-readable output
  -h, --help        this text

  Uses each engine's public HTML results page. No API key. Bing and DuckDuckGo
  html endpoints return a stable result count; mojeek is the most scrape-tolerant.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const target = o._[0];
if (!target) die('usage: node tools/bingindex.js <url|domain|query> [--engines bing,ddg]');

const ENGINES = {
  bing: {
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10&setlang=en`,
    count: (html) => {
      const m = html.match(/<span[^>]*class="[^"]*sb_count[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
    },
    results: (html) => [...html.matchAll(/<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => {
      const title = (m[1].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
      const snip = (m[1].match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
      const href = (m[1].match(/href="(https?:\/\/[^"]+)"/i) || [])[1] || '';
      return { title: title ? title.replace(/<[^>]+>/g, '').trim() : '', snippet: snip ? snip.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '', href };
    }),
    blocked: (html, status) => status === 429 || /captcha|unusual traffic/i.test(html),
  },
  ddg: {
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    count: (html) => {
      const m = html.match(/class="result__count"[^>]*>([\s\S]*?)</i);
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    },
    results: (html) => [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ title: m[2].replace(/<[^>]+>/g, '').trim(), snippet: '', href: decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1]) })),
    blocked: (html, status) => status === 403 || /anomaly|blocked/i.test(html),
  },
  mojeek: {
    url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
    count: (html) => {
      const m = html.match(/<p class="results-count"[^>]*>([\s\S]*?)<\/p>/i) || html.match(/([\d,]+)\s+results?/i);
      return m ? String(m[1]).replace(/<[^>]+>/g, '').trim() : null;
    },
    results: (html) => [...html.matchAll(/<a class="ob"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ title: m[1].replace(/<[^>]+>/g, '').trim(), snippet: '' })),
    blocked: (html, status) => status >= 400 || /<title>\s*Captcha/i.test(html),
  },
  brave: {
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    count: () => null,
    results: (html) => [...html.matchAll(/<a[^>]*class="[^"]*result-header[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ title: m[1].replace(/<[^>]+>/g, '').trim(), snippet: '' })),
    blocked: (html, status) => status === 429 || /captcha/i.test(html),
  },
  startpage: {
    url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`,
    count: () => null,
    results: (html) => [...html.matchAll(/<a[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ title: m[1].replace(/<[^>]+>/g, '').trim(), snippet: '' })),
    blocked: (html, status) => status === 403 || status === 429,
  },
};

const wanted = String(get(o, 'engines', 'bing,ddg')).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const unknown = wanted.filter((e) => !ENGINES[e]);
if (unknown.length) die(`unknown engine(s): ${unknown.join(', ')} — available: ${Object.keys(ENGINES).join(', ')}`);

const asSite = flag(o, 'site');
const scopeHost = (() => {
  if (!asSite) return null;
  try { return new globalThis.URL(target.startsWith('http') ? target : `https://${target}`).host.replace(/^www\./, ''); } catch { return target.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
})();

const query = (() => {
  let t = target;
  try {
    const u = new globalThis.URL(t);
    t = u.href;
  } catch { /* not a URL — use as-is */ }
  if (asSite) {
    let host = t;
    try { host = new globalThis.URL(t.startsWith('http') ? t : `https://${t}`).host; } catch { host = t.replace(/^https?:\/\//, '').split('/')[0]; }
    t = `site:${host}`;
  } else if (flag(o, 'exact')) t = `"${t}"`;
  return t;
})();

const rows = [];
for (const engine of wanted) {
  const e = ENGINES[engine];
  const url = e.url(query);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    });
    const html = await res.text();
    const blocked = e.blocked(html, res.status);
    const results = blocked ? [] : e.results(html);
    const count = blocked ? null : e.count(html);
    const onScope = scopeHost ? results.filter((r) => { try { return new globalThis.URL(r.href).host.replace(/^www\./, '').endsWith(scopeHost); } catch { return false; } }) : results;
    const offScope = scopeHost ? results.length - onScope.length : 0;
    rows.push({
      engine,
      status: res.status,
      elapsedMs: Date.now() - started,
      blocked: blocked ? 'yes' : '',
      count: count || '—',
      resultCount: results.length,
      onScope: onScope.length,
      offScope,
      indexed: blocked ? 'unknown' : (onScope.length > 0 ? 'yes' : (results.length > 0 ? 'no' : 'no')),
      firstTitle: (onScope[0] || results[0])?.title?.slice(0, 60) || '',
      firstSnippet: (onScope[0] || results[0])?.snippet?.slice(0, 100) || '',
      bytes: html.length,
    });
  } catch (err) {
    rows.push({
      engine,
      status: err.name === 'AbortError' ? 'timeout' : 'error',
      elapsedMs: Date.now() - started,
      blocked: '',
      count: '—',
      resultCount: 0,
      indexed: 'unknown',
      firstTitle: '',
      firstSnippet: (err?.cause?.code || err.message).slice(0, 60),
      bytes: 0,
    });
  } finally { clearTimeout(timer); }
}

const indexed = rows.filter((r) => r.indexed === 'yes');
const notIndexed = rows.filter((r) => r.indexed === 'no');
const v = {
  target,
  query,
  engines: rows,
  indexedOn: indexed.map((r) => r.engine),
  notIndexedOn: notIndexed.map((r) => r.engine),
  verdict: indexed.length ? (notIndexed.length ? 'PARTIAL — indexed on some engines only' : 'INDEXED on every engine queried') : (rows.some((r) => r.blocked === 'yes') ? 'UNKNOWN — engines rate-limited the probe' : 'NOT FOUND on any engine queried'),
};

if (flag(o, 'json')) {
  console.log(JSON.stringify(v, null, 2));
} else {
  console.log(`target: ${target}`);
  console.log(`query:  ${query}\n`);
  console.log(table(rows.map((r) => ({
    engine: r.engine,
    http: r.status,
    ms: r.elapsedMs,
    indexed: r.indexed,
    results: r.resultCount,
    onscope: scopeHost ? (r.onScope ?? 0) : '—',
    'index count': String(r.count).slice(0, 22),
    note: r.blocked === 'yes' ? 'rate-limited' : (scopeHost && r.offScope ? `${r.offScope} off-domain` : ''),
  }))));
  console.log(`\nverdict: ${v.verdict}`);
  if (scopeHost) console.log(`scope check: counted only results whose host ends with ${scopeHost}`);
  if (indexed.length) console.log(`available in: ${indexed.map((r) => r.engine).join(', ')}`);
  if (flag(o, 'snippet')) {
    for (const r of rows.filter((x) => x.firstTitle)) {
      console.log(`\n[${r.engine}] ${r.firstTitle}`);
      if (r.firstSnippet) console.log(`  ${r.firstSnippet}`);
    }
  }
  if (rows.some((r) => r.blocked === 'yes')) console.log('\nengine(s) rate-limited the request — retry later or add a delay between runs');
}
