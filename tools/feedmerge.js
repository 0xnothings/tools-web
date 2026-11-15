// feedmerge.js — merge multiple RSS/JSON feeds, dedupe, sort by date.
// Copyright (c) 2026 0xnothings
// @tool feedmerge
// @desc Merge many RSS/Atom/JSON feeds into one deduplicated timeline sorted by date
// @usage node tools/feedmerge.js https://news.ycombinator.com/rss https://lobste.rs/rss --limit 20 --json
// @tags web,scrape,rss
import { args, get, num, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`feedmerge — multi-feed merger

  node tools/feedmerge.js <feed...> [options]

  node tools/feedmerge.js --list feeds.txt [options]

  --limit <n>     items to print (default 30)
  --per-feed <n>  cap items taken from each feed before merging
  --dedupe <key>  link | title | both (default both)
  --since <date>  drop items older than this ISO date
  --text          print a plain list instead of a table
  --json          machine-readable output
  -h, --help      this text

  Accepts RSS 2.0, Atom 1.0 and JSON Feed. Each output row keeps its source feed.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
let feedUrls = [...o._];
const listFile = get(o, 'list', null);
if (listFile && listFile !== true) feedUrls = [...feedUrls, ...(await inputLines(String(listFile)))];
if (!feedUrls.length) die('usage: node tools/feedmerge.js <feed...> [--limit 30] [--json]');

const limit = Math.max(1, num(get(o, 'limit'), 30));
const perFeed = Math.max(1, num(get(o, 'per-feed'), 50));
const dedupeMode = String(get(o, 'dedupe', 'both')).toLowerCase();
const since = get(o, 'since', null);

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const stripHtml = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function pickTag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}
function pickAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}
function toISO(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseXml(xml, source) {
  const atom = /<feed[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const title = stripHtml(pickTag(xml.replace(/<\/(item|entry)>[\s\S]*$/i, ''), ['title'])) || source;
  return blocks.map((b) => {
    let link = pickTag(b, ['link']);
    if (!link || link.includes('<')) link = pickAttr(b, 'link', 'href');
    if (!link) link = pickTag(b, ['guid', 'id']);
    return {
      title: stripHtml(pickTag(b, ['title'])) || '(untitled)',
      link: link.trim(),
      date: toISO(pickTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'date'])),
      summary: stripHtml(pickTag(b, ['description', 'summary', 'content:encoded', 'content', 'subtitle'])).slice(0, 220),
      source, feedTitle: title,
    };
  });
}

function parseJsonFeed(txt, source) {
  let doc;
  try { doc = JSON.parse(txt); } catch { return null; }
  const list = Array.isArray(doc) ? doc : doc.items || doc.entries;
  if (!Array.isArray(list)) return null;
  return list.map((it) => ({
    title: String(it.title || it.name || '(untitled)'),
    link: String(it.url || it.link || it.id || ''),
    date: toISO(it.date_published || it.date_modified || it.pubDate || it.date),
    summary: stripHtml(it.summary || it.content_text || it.description || '').slice(0, 220),
    source, feedTitle: doc.title || source,
  }));
}

async function grab(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml,application/atom+xml,application/feed+json,application/json,text/xml,*/*' },
    });
    if (!res.ok) return { source: url, error: `HTTP ${res.status}`, items: [] };
    const body = await res.text();
    const trimmed = body.trimStart();
    const parsed = trimmed.startsWith('{') || trimmed.startsWith('[') ? parseJsonFeed(body, url) : null;
    const items = parsed || parseXml(body, url);
    return { source: url, items: items.slice(0, perFeed), format: parsed ? 'jsonfeed' : (/<feed[\s>]/i.test(body) ? 'atom' : 'rss') };
  } catch (e) {
    return { source: url, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message), items: [] };
  } finally { clearTimeout(t); }
}

const feeds = [];
for (let i = 0; i < feedUrls.length; i += 4) {
  const batch = feedUrls.slice(i, i + 4);
  feeds.push(...(await Promise.all(batch.map(grab))));
}

let items = feeds.flatMap((f) => f.items);

if (since && since !== true) {
  const cut = new Date(String(since)).getTime();
  if (Number.isFinite(cut)) items = items.filter((it) => it.date && new Date(it.date).getTime() >= cut);
}

const seenLink = new Set();
const seenTitle = new Set();
const merged = [];
for (const it of items) {
  const linkKey = (it.link || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const titleKey = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let dup = false;
  if (dedupeMode === 'link' || dedupeMode === 'both') { if (linkKey && seenLink.has(linkKey)) dup = true; }
  if (!dup && (dedupeMode === 'title' || dedupeMode === 'both')) { if (titleKey && seenTitle.has(titleKey)) dup = true; }
  if (dup) continue;
  if (linkKey) seenLink.add(linkKey);
  if (titleKey) seenTitle.add(titleKey);
  merged.push(it);
}

merged.sort((a, b) => {
  const ta = a.date ? new Date(a.date).getTime() : 0;
  const tb = b.date ? new Date(b.date).getTime() : 0;
  return tb - ta;
});

const shown = merged.slice(0, limit);
const env = {
  feeds: feeds.map((f) => ({ source: f.source, items: f.items.length, format: f.format || null, error: f.error || null })),
  raw: items.length, afterDedupe: merged.length, shown: shown.length,
  dedupe: dedupeMode, since: since && since !== true ? String(since) : null,
};

if (flag(o, 'json')) { console.log(JSON.stringify({ ...env, items: shown }, null, 2)); process.exitCode = 0; } else if (flag(o, 'text')) {
  for (const it of shown) console.log(`${(it.date || '').slice(0, 10)}  ${it.title}\n    ${it.link}\n    [${it.source}]`);
  process.exitCode = 0;
} else {
  console.log(`${feeds.length} feed(s) · ${env.raw} items → ${merged.length} after dedupe · showing ${shown.length}\n`);
  console.log(table(shown.map((it, i) => ({
    '#': i + 1,
    date: (it.date || '').slice(0, 10),
    title: it.title.slice(0, 54),
    source: String(it.source).replace(/^https?:\/\/(www\.)?/, '').split('/')[0].slice(0, 22),
  }))));
  const broken = feeds.filter((f) => f.error);
  if (broken.length) { console.log('\nfeed errors:'); for (const b of broken) console.log(`  ${b.source} — ${b.error}`); }
  process.exitCode = 0;
}
