#!/usr/bin/env node
// feeddiff.js — diff two feed snapshots and report what changed.
// Copyright (c) 2026 0xnothings
// @tool feeddiff
// @desc Compare two RSS/Atom/JSON feed snapshots by item identity and list new, removed and edited entries with the exact fields that changed
// @usage node tools/feeddiff.js feed-yesterday.xml feed-today.xml
// @tags web,feeds,diff
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`feeddiff — feed snapshot differ

  node tools/feeddiff.js <before> <after> [options]

  each argument: URL, file path, or '-' for stdin (one may be stdin)

  --fields <a,b>  entry fields to compare (default: title,summary,content,author,updated)
  --only-changed  suppress the unchanged section
  --json          machine-readable output
  -h, --help      this text

  Items are matched by id, then by link, then by title.`); 
  process.exit(0);
}

const [a, b] = o._;
if (!a || !b) die('usage: node tools/feeddiff.js <before> <after>');

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const FIELDS = (get(o, 'fields', null) ? String(get(o, 'fields')) : 'title,summary,content,author,updated').split(',').map((s) => s.trim()).filter(Boolean);

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml, */*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' };
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}
const strip = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const tag = (xml, t) => { const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(xml); return m ? decode(m[1]).trim() : null; };
/** Pair rel with href across every <link ...> attribute set instead of assuming order. */
const linkAttrs = (xml) => {
  const out = [];
  for (const m of String(xml).matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs[a[1].toLowerCase()] = a[2];
    out.push(attrs);
  }
  const alt = out.find((a) => a.href && (a.rel || 'alternate') === 'alternate');
  return (alt || out.find((a) => a.href) || {}).href || null;
};
const blocks = (xml, t) => { const out = []; const re = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'gi'); let m; while ((m = re.exec(xml)) !== null) out.push(m[1]); return out; };

function parseFeed(text) {
  const s = String(text).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    const j = JSON.parse(s);
    return { format: 'jsonfeed', title: j.title || null, items: (j.items || []).map((it) => ({ id: it.id ?? null, link: it.url ?? null, title: it.title ?? null, summary: it.summary ?? null, content: it.content_html ?? it.content_text ?? null, author: it.authors?.[0]?.name ?? it.author?.name ?? null, updated: it.date_modified ?? it.date_published ?? null })) };
  }
  if (/<feed\b/i.test(s)) {
    return { format: 'atom', title: strip(tag(s, 'title') || ''), items: blocks(s, 'entry').map((x) => ({ id: tag(x, 'id'), link: linkAttrs(x), title: strip(tag(x, 'title') || ''), summary: strip(tag(x, 'summary') || '') || null, content: tag(x, 'content') || tag(x, 'summary'), author: tag(x, 'name'), updated: tag(x, 'updated') || tag(x, 'published') })) };
  }
  return { format: 'rss', title: strip(tag(s, 'title') || ''), items: blocks(s, 'item').map((x) => ({ id: tag(x, 'guid') || tag(x, 'link'), link: tag(x, 'link'), title: strip(tag(x, 'title') || ''), summary: strip(tag(x, 'description') || '') || null, content: tag(x, 'content:encoded') || tag(x, 'description'), author: tag(x, 'dc:creator') || tag(x, 'author'), updated: tag(x, 'pubDate') })) };
}

const A = parseFeed(await load(a));
const B = parseFeed(await load(b));

const keyOf = (it) => String(it.id || it.link || it.title || '').trim().toLowerCase();
const keyMap = (feed) => {
  const m = new Map();
  for (const it of feed.items) {
    const k = keyOf(it);
    if (k) m.set(k, it);
  }
  return m;
};
const ma = keyMap(A), mb = keyMap(B);

const added = [...mb.keys()].filter((k) => !ma.has(k)).map((k) => mb.get(k));
const removed = [...ma.keys()].filter((k) => !mb.has(k)).map((k) => ma.get(k));
const edited = [];
let unchanged = 0;
for (const [k, after] of mb) {
  const before = ma.get(k);
  if (!before) continue;
  const changes = [];
  for (const f of FIELDS) {
    const x = before[f] === null || before[f] === undefined ? '' : String(before[f]);
    const y = after[f] === null || after[f] === undefined ? '' : String(after[f]);
    if (x !== y && !(f === 'summary' && strip(x) === strip(y))) {
      changes.push({ field: f, before: x.replace(/\s+/g, ' ').slice(0, 44), after: y.replace(/\s+/g, ' ').slice(0, 44) });
    }
  }
  if (changes.length) edited.push({ key: k, title: after.title, changes });
  else unchanged++;
}

const newestFirst = (list) => list.slice().sort((x, y) => String(y.updated || '').localeCompare(String(x.updated || '')));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    before: { source: a, format: A.format, title: A.title, items: A.items.length },
    after: { source: b, format: B.format, title: B.title, items: B.items.length },
    fieldsCompared: FIELDS,
    added: newestFirst(added).map((i) => ({ title: i.title, link: i.link, updated: i.updated })),
    removed: newestFirst(removed).map((i) => ({ title: i.title, link: i.link, updated: i.updated })),
    edited: edited.map((e) => ({ title: e.title, changes: e.changes })),
    unchanged,
  }, null, 2));
} else {
  console.log(`before ${a}  (${A.format}, ${A.items.length} items${A.title ? `, "${A.title}"` : ''})`);
  console.log(`after  ${b}  (${B.format}, ${B.items.length} items${B.title ? `, "${B.title}"` : ''})`);
  if (A.format !== B.format) console.log(`note: format changed ${A.format} -> ${B.format}`);
  console.log(`\n+${added.length} new   -${removed.length} removed   ~${edited.length} edited   =${unchanged} unchanged\n`);
  if (added.length) {
    console.log(`new entries (${added.length}):`);
    console.log(table(newestFirst(added).slice(0, 30).map((i) => ({ date: (i.updated || '').slice(0, 16), title: String(i.title || '').slice(0, 54) }))));
  }
  if (removed.length) {
    console.log(`\nremoved entries (${removed.length}):`);
    console.log(table(newestFirst(removed).slice(0, 30).map((i) => ({ date: (i.updated || '').slice(0, 16), title: String(i.title || '').slice(0, 54) }))));
  }
  if (edited.length) {
    console.log(`\nedited entries (${edited.length}):`);
    for (const e of edited.slice(0, 12)) {
      console.log(`  ${String(e.title || e.key).slice(0, 60)}`);
      for (const c of e.changes) console.log(`    ${c.field}: "${c.before}" -> "${c.after}"`);
    }
    if (edited.length > 12) console.log(`  ... ${edited.length - 12} more`);
  }
  if (!flag(o, 'only-changed') && !added.length && !removed.length) console.log('\nno membership changes between the two snapshots');
  if (!added.length && !removed.length && !edited.length) console.log('the two snapshots are identical across the compared fields');
}
