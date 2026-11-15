#!/usr/bin/env node
// rssgrab.js — fetch RSS/Atom/JSON feeds and normalize items to JSON.
// Copyright (c) 2026 0xnothings
// @tool rssgrab
// @desc Fetch RSS, Atom or JSON feeds and normalize every entry to title/link/date/summary
// @usage node tools/rssgrab.js https://news.ycombinator.com/rss --limit 10 --json
// @tags web,scrape,rss
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`rssgrab — RSS / Atom / JSON Feed reader

  node tools/rssgrab.js <feed-url|file> [options]

  --limit <n>     max items to print (default 25)
  --summary <n>   summary truncation length in chars (default 180)
  --full          never truncate the summary
  --json          machine-readable output
  -h, --help      this text

  Understands RSS 2.0, Atom 1.0 and JSON Feed 1.x. Feed order is preserved.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/rssgrab.js <feed-url> [--limit 25] [--json]');

const limit = Math.max(1, num(get(o, 'limit'), 25));
const sumLen = flag(o, 'full') ? Infinity : Math.max(0, num(get(o, 'summary'), 180));

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

const stripHtml = (s) => decodeEntities(String(s)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ').trim();

function pickTag(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i');
    const m = block.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}

function pickAttr(block, tagName, attr) {
  const re = new RegExp(`<${tagName}\\b[^>]*?\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

function toDate(raw) {
  const t = String(raw || '').trim();
  if (!t) return { iso: null, raw: null };
  const d = new Date(t);
  return { iso: isNaN(d.getTime()) ? null : d.toISOString(), raw: t };
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
}

function parseXml(xml) {
  const atom = /<feed[\s>]/i.test(xml);
  const itemRe = atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = [...xml.matchAll(itemRe)].map((m) => m[0]);
  const feedTitle = stripHtml(pickTag(xml.replace(/<\/(item|entry)>[\s\S]*$/i, ''), ['title']));
  const items = blocks.map((b) => {
    let link = pickTag(b, ['link']);
    if (!link || /^</.test(link)) link = '';
    if (!link) link = pickAttr(b, 'link', 'href');
    if (!link) link = pickTag(b, ['guid', 'id']);
    let author = stripHtml(pickTag(b, ['dc:creator', 'author']));
    if (!author) author = stripHtml(pickTag(b, ['name']));
    const d = toDate(pickTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'date']));
    const body = pickTag(b, ['content:encoded', 'content', 'description', 'summary', 'subtitle']);
    const cats = [...b.matchAll(/<category\b[^>]*?(?:term\s*=\s*["']([^"']+)["']|>([^<]*)<)/gi)]
      .map((m) => decodeEntities(m[1] || m[2] || '').trim()).filter(Boolean);
    return {
      title: stripHtml(pickTag(b, ['title'])) || '(untitled)',
      link: link.trim(),
      date: d.iso,
      dateRaw: d.raw,
      summary: clip(stripHtml(body), sumLen),
      author: author || null,
      categories: cats,
      guid: pickTag(b, ['guid', 'id']) || null,
    };
  });
  return { feedTitle, format: atom ? 'atom' : 'rss', items };
}

function parseJsonFeed(txt) {
  let doc;
  try { doc = JSON.parse(txt); } catch { return null; }
  const list = Array.isArray(doc) ? doc : doc.items || doc.entries;
  if (!Array.isArray(list)) return null;
  const items = list.map((it) => {
    const d = toDate(it.date_published || it.date_modified || it.pubDate || it.published || it.date);
    return {
      title: String(it.title || it.name || '(untitled)'),
      link: String(it.url || it.link || it.id || ''),
      date: d.iso, dateRaw: d.raw,
      summary: clip(stripHtml(it.summary || it.content_text || it.content_html || it.description || ''), sumLen),
      author: it.author?.name || it.author || null,
      categories: Array.isArray(it.tags) ? it.tags.map(String) : [],
      guid: it.id || null,
    };
  });
  return { feedTitle: doc.title || '(json feed)', format: 'jsonfeed', items };
}

async function grab(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml,application/atom+xml,application/feed+json,application/json,text/xml,*/*' },
    });
    return { ok: res.ok, status: res.status, final: res.url, body: await res.text() };
  } finally { clearTimeout(t); }
}

async function load(target) {
  if (/^https?:\/\//i.test(target)) {
    const r = await grab(target);
    if (!r.ok) die(`feed fetch failed: HTTP ${r.status} ${target}`);
    return { body: r.body, final: r.final, status: r.status };
  }
  const { readFileSync } = await import('node:fs');
  return { body: readFileSync(target, 'utf8'), final: target, status: 200 };
}

const raw = await load(src);
const trimmed = raw.body.trimStart();
let feed = trimmed.startsWith('{') || trimmed.startsWith('[') ? parseJsonFeed(raw.body) : null;
if (!feed) feed = parseXml(raw.body);

const items = feed.items.slice(0, limit);

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: src, final: raw.final, format: feed.format, feed: feed.feedTitle,
    count: items.length, total: feed.items.length, items,
  }, null, 2));
  process.exitCode = 0;
} else {

console.log(`${feed.feedTitle || '(untitled feed)'}  [${feed.format}]  ${feed.items.length} items\n`);
console.log(table(items.map((it, i) => ({
  '#': i + 1,
  date: (it.date || it.dateRaw || '').slice(0, 10),
  title: clip(it.title, 56),
  link: it.link.replace(/^https?:\/\//, '').slice(0, 46),
}))));
}
