// canoncheck.js — canonical URL consistency audit across pages.
// Copyright (c) 2026 0xnothings
// @tool canoncheck
// @desc Audit rel=canonical across a page set: missing or non-self canonicals, cross-domain targets, canonical chains and duplicate clusters
// @usage node tools/canoncheck.js https://example.com --max 12
// @tags web,seo,audit
import { args, get, num, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`canoncheck — canonical consistency audit

  node tools/canoncheck.js <seed-url|url-list-file> [options]

  --max <n>       crawl at most n pages from the seed (default 10)
  --depth <n>     BFS depth (default 2)
  --json          machine-readable output
  -h, --help      this text

  If the argument is an http(s) URL it is crawled; if it is a file each line
  is fetched as its own page.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const src = o._[0];
if (!src) die('usage: node tools/canoncheck.js <seed-url|url-list-file>');

const max = Math.max(1, num(get(o, 'max'), 10));
const depthMax = Math.max(0, num(get(o, 'depth'), 2));

function norm(raw) {
  try {
    const u = new globalThis.URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

async function grab(url) {
  if (!/^https?:\/\//i.test(url)) {
    try {
      const { readFileSync } = await import('node:fs');
      return { status: 200, body: readFileSync(url, 'utf8'), final: url };
    } catch (e) {
      return { status: 0, body: '', final: url, error: e.code || 'unreadable' };
    }
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

const rel = (html, base) => {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const r = (tag.match(/rel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    if (!/\bcanonical\b/i.test(r)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (!href) continue;
    try { out.push(new globalThis.URL(href, base).href); } catch { out.push(href); }
  }
  return out;
};
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

let targets = [];
if (/^https?:\/\//i.test(src)) {
  const root = norm(src);
  const seen = new Set([root]);
  let queue = [{ url: root, d: 0 }];
  while (queue.length && targets.length < max) {
    const { url, d } = queue.shift();
    const r = await grab(url);
    targets.push({ url, final: r.final, status: r.status, body: r.body, error: r.error });
    if (d < depthMax && targets.length < max) {
      for (const l of linksOf(r.body, r.final)) {
        if (new globalThis.URL(l).host !== new globalThis.URL(root).host) continue;
        if (seen.has(l) || seen.size >= max * 2) continue;
        seen.add(l);
        queue.push({ url: l, d: d + 1 });
      }
    }
  }
} else {
  const list = await inputLines(src);
  for (const u of list.slice(0, max)) {
    const r = await grab(u);
    targets.push({ url: u, final: r.final, status: r.status, body: r.body, error: r.error });
  }
}

const pages = targets.map((t) => {
  const canon = rel(t.body, t.final);
  const self = t.final;
  const strip = (u) => u.replace(/\/$/, '');
  const checks = [];
  if (!canon.length) checks.push('missing-canonical');
  if (canon.length > 1) checks.push(`multiple-canonicals(${canon.length})`);
  const primary = canon[0] ? canon[0] : null;
  if (primary) {
    if (strip(primary) !== strip(self)) checks.push('not-self');
    if (/^https?:\/\//i.test(self)) {
      try {
        if (new globalThis.URL(primary).host !== new globalThis.URL(self).host) checks.push('cross-domain');
      } catch { checks.push('invalid-target'); }
    }
  }
  return { url: t.url, final: self, status: t.status || t.error, canonical: primary, all: canon, checks };
});

const targetMap = new Map(pages.filter((p) => p.canonical).map((p) => [p.canonical.replace(/\/$/, ''), p]));
const chains = [];
for (const p of pages) {
  if (!p.canonical) continue;
  const t = targetMap.get(p.canonical.replace(/\/$/, ''));
  if (t && t.url !== p.url && t.canonical && t.canonical.replace(/\/$/, '') !== p.canonical.replace(/\/$/, '')) {
    chains.push({ from: p.url, to: p.canonical, then: t.canonical });
  }
}

const clusters = new Map();
for (const p of pages) {
  if (!p.canonical) continue;
  const k = p.canonical.replace(/\/$/, '');
  if (!clusters.has(k)) clusters.set(k, []);
  clusters.get(k).push(p.url);
}
const dupes = [...clusters.entries()].filter(([, v]) => v.length > 1).map(([target, members]) => ({ target, members }));

const findings = pages.filter((p) => p.checks.length);
const severity = (p) => {
  if (p.checks.includes('cross-domain')) return 'HIGH';
  if (p.checks.includes('missing-canonical')) return 'MEDIUM';
  if (p.checks.includes('multiple-canonicals')) return 'MEDIUM';
  if (p.checks.includes('not-self')) return 'LOW';
  return 'INFO';
};

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: src, pages, chains, duplicateClusters: dupes, findings: findings.map((p) => ({ url: p.url, checks: p.checks, severity: severity(p) })) }, null, 2));
} else {
  console.log(`${src} — ${pages.length} page(s) audited, ${findings.length} with canonical issues\n`);
  console.log(table(pages.map((p) => ({
    page: p.url.replace(/^https?:\/\//, '').slice(0, 44),
    canon: (p.canonical || '—').replace(/^https?:\/\//, '').slice(0, 44),
    issues: p.checks.join(',') || 'ok',
  }))));
  if (chains.length) {
    console.log(`\ncanonical chains (${chains.length}) — target of A itself declares another canonical:`);
    console.log(table(chains.map((c) => ({ from: c.from.replace(/^https?:\/\//, '').slice(0, 36), to: c.to.replace(/^https?:\/\//, '').slice(0, 36), then: c.then.replace(/^https?:\/\//, '').slice(0, 36) }))));
  }
  if (dupes.length) {
    console.log(`\nduplicate clusters (${dupes.length}) — several URLs consolidate onto one canonical:`);
    for (const d of dupes) console.log(`  ${d.target.replace(/^https?:\/\//, '')}\n    <- ${d.members.map((m) => m.replace(/^https?:\/\//, '')).join('\n    <- ')}`);
  }
  const missing = pages.filter((p) => p.checks.includes('missing-canonical')).length;
  if (missing) console.log(`\n${missing} page(s) have no rel=canonical at all`);
}
