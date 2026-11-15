#!/usr/bin/env node
// seohead.js — audit a page's <head>.
// Copyright (c) 2026 0xnothings
// @tool seohead
// @desc Audit title/description/canonical/robots/OG/structured-data in one report with length and duplicate checks
// @usage node tools/seohead.js https://example.com --json
// @tags web,seo,audit
import { args, get, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`seohead — <head> SEO audit

  node tools/seohead.js <url|file|-> [options]

  --max <n>     cap on chars shown per value (default 100)
  --json        machine-readable output
  -h, --help    this text

  Scores title length (50-60), meta description length (120-158), canonical presence
  and self-reference, robots directives, viewport, charset, OpenGraph/Twitter cards,
  JSON-LD presence, h1 count, and image alt coverage.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/seohead.js <url|file|-> [--json]');

const TITLE_MIN = 30, TITLE_MAX = 60;
const DESC_MIN = 70, DESC_MAX = 160;

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url, status: res.status, xRobots: res.headers.get('x-robots-tag') };
    } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t, status: null, xRobots: null };
}

const page = await load(src);
const html = page.body;
const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
const head = headMatch ? headMatch[1] : html;
const metaTags = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
const linkTags = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
const byName = {};
for (const m of metaTags) {
  const k = (m.name || m.property || m.itemprop || m['http-equiv'] || '').toLowerCase();
  if (k && m.content !== undefined) byName[k] = m.content;
}
const findLink = (...rels) => linkTags.find((l) => rels.some((r) => new RegExp(r, 'i').test(l.rel || '')));

const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;
const description = byName.description || null;
const canonicalRaw = findLink('^canonical$')?.href || null;
const canonical = canonicalRaw && /^https?:\/\//i.test(page.final) ? (() => { try { return new URL(canonicalRaw, page.final).toString(); } catch { return canonicalRaw; } })() : canonicalRaw;
const robots = byName.robots || null;
const viewport = byName.viewport || null;
const charset = metaTags.find((m) => m.charset)?.['charset'] || (head.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || null;
const og = Object.fromEntries(Object.entries(byName).filter(([k]) => k.startsWith('og:')).map(([k, v]) => [k.slice(3), v]));
const tw = Object.fromEntries(Object.entries(byName).filter(([k]) => k.startsWith('twitter:')).map(([k, v]) => [k.slice(8), v]));
const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
const ldBlocks = [...html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
const ldTypes = [];
for (const b of ldBlocks) {
  try {
    const parsed = JSON.parse(b[1].trim());
    const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
    for (const n of [].concat(nodes)) if (n && n['@type']) ldTypes.push([].concat(n['@type']).join('/'));
  } catch { ldTypes.push('(unparseable)'); }
}
const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0]));
const altMissing = imgs.filter((i) => i.alt === undefined).length;
const lang = (html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)/i) || [])[1] || null;

const checks = [];
const score = (id, ok, label, detail, severity = 'warn') => checks.push({ id, ok: Boolean(ok), label, detail, severity: ok ? 'ok' : severity });

score('title', title, 'title tag present', title ? `${title.length} chars` : 'missing', 'error');
if (title) {
  score('title-length', title.length >= TITLE_MIN && title.length <= TITLE_MAX, `title length ${TITLE_MIN}-${TITLE_MAX}`,
    title.length < TITLE_MIN ? `${title.length} chars — short, wastes SERP space` : title.length > TITLE_MAX ? `${title.length} chars — will be truncated` : `${title.length} chars — good`);
}
score('description', description, 'meta description present', description ? `${description.length} chars` : 'missing', 'error');
if (description) {
  score('description-length', description.length >= DESC_MIN && description.length <= DESC_MAX, `description length ${DESC_MIN}-${DESC_MAX}`,
    description.length < DESC_MIN ? `${description.length} chars — short` : description.length > DESC_MAX ? `${description.length} chars — truncated in SERPs` : `${description.length} chars — good`);
}
score('canonical', canonical, 'canonical link present', canonical || 'missing', 'error');
if (canonical && /^https?:\/\//i.test(page.final)) {
  const norm = (u) => String(u).replace(/\/$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  score('canonical-self', norm(canonical) === norm(page.final), 'canonical is self-referencing',
    norm(canonical) === norm(page.final) ? canonical : `points at ${canonical} instead of ${page.final}`, 'warn');
}
score('robots', !robots || !/noindex/i.test(robots), 'page is indexable', robots || 'no robots meta (indexable by default)', 'error');
score('viewport', viewport, 'responsive viewport', viewport || 'missing — page will be desktop-width on mobile', 'warn');
score('charset', charset, 'charset declared', charset || 'missing', 'warn');
score('lang', lang, 'html lang attribute', lang || 'missing', 'warn');
score('h1', h1s.length === 1, 'exactly one h1', h1s.length === 0 ? 'no h1 found' : h1s.length > 1 ? `${h1s.length} h1 tags` : h1s[0].slice(0, 60), 'warn');
score('og', og.title && og.description && og.image, 'OpenGraph complete', og.title && og.image ? `og:title + og:image` : 'missing og:title / og:image', 'warn');
score('twitter', tw.card && (tw.title || og.title) && (tw.image || og.image), 'Twitter card complete', tw.card || 'missing twitter:card', 'info');
score('jsonld', ldTypes.length > 0, 'structured data present', ldTypes.length ? ldTypes.join(', ') : 'no JSON-LD', 'info');
score('img-alt', imgs.length === 0 || altMissing === 0, 'images have alt text', imgs.length === 0 ? 'no images' : altMissing === 0 ? `${imgs.length} images, all with alt` : `${altMissing} of ${imgs.length} images missing alt`, 'warn');

const passed = checks.filter((c) => c.ok).length;
const failedErrors = checks.filter((c) => !c.ok && c.severity === 'error').length;
const scorePct = Math.round((passed / checks.length) * 100);
const verdict = failedErrors ? 'blocking issues' : scorePct >= 85 ? 'good' : scorePct >= 60 ? 'needs work' : 'poor';

const report = {
  url: page.final, status: page.status,
  title, titleLength: title?.length ?? 0,
  description, descriptionLength: description?.length ?? 0,
  canonical, robots, viewport, charset, lang,
  xRobotsTag: page.xRobots,
  openGraph: og, twitterCard: tw,
  structuredData: ldTypes,
  h1Count: h1s.length, h1: h1s[0] || null,
  imageCount: imgs.length, imagesMissingAlt: altMissing,
  headBytes: head.length,
  scorePct, verdict,
  passed, total: checks.length,
  checks,
};

if (flag(o, 'json')) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; } else {
console.log(`${page.final}${page.status ? `  [HTTP ${page.status}]` : ''}`);
console.log(`score ${scorePct}% (${passed}/${checks.length}) — ${verdict}\n`);
console.log(table(checks.map((c) => ({
  ok: c.ok ? 'PASS' : c.severity === 'error' ? 'FAIL' : c.severity.toUpperCase(),
  check: c.label,
  detail: String(c.detail).slice(0, 64),
}))));
if (title) console.log(`\ntitle:       ${title}`);
if (description) console.log(`description: ${description}`);
if (canonical) console.log(`canonical:   ${canonical}`);
if (ldTypes.length) console.log(`structured:  ${ldTypes.join(', ')}`);
if (og.title) console.log(`og:          title="${og.title.slice(0, 50)}" type=${og.type || '—'} image=${og.image ? 'yes' : 'no'}`);
}
process.exitCode = 0;
