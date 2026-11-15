// jsonfeed.js — unified RSS / Atom / JSON Feed reader.
// Copyright (c) 2026 0xnothings
// @tool jsonfeed
// @desc Detect the feed format, normalise every entry into one schema, and emit it as JSON with per-format field coverage notes
// @usage node tools/jsonfeed.js https://example.com/feed.xml --limit 10
// @tags web,feeds,data
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`jsonfeed — RSS, Atom and JSON Feed reader

  node tools/jsonfeed.js <url|file|-> [options]

  --limit <n>     keep at most n entries (default 20)
  --dates         include parsed pubDate timestamps
  --json          machine-readable output (default when not a plain listing)
  -h, --help      this text

  Normalised schema: id, title, link, summary, content, author, published,
  updated, categories, image, format.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml, */*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url, type: res.headers.get('content-type') || '' };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t, type: '' };
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d' };
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}
const strip = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const firstTag = (xml, tag) => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decode(m[1]).trim() : null;
};
const tagAttr = (xml, tag, attr) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i').exec(xml);
  return m ? decode(m[1]) : null;
};
/** All attribute sets of every <tag ...> occurrence, so rel/href can be paired safely. */
const tagAttrsAll = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => {
  const attrs = {};
  for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs[a[1].toLowerCase()] = decode(a[2]);
  return attrs;
});
const allBlocks = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push({ inner: m[1], full: m[0] });
  return out;
};

const { body, final, type } = await load(o._[0] || die('usage: node tools/jsonfeed.js <url|file|->'));
const limit = Math.max(1, num(get(o, 'limit'), 20));
const trimmed = body.trim();
let format = 'unknown';
let feed = {};
let items = [];
let notes = [];

if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
  try {
    const j = JSON.parse(trimmed);
    format = j.version && String(j.version).startsWith('https://jsonfeed.org') ? 'jsonfeed' : 'json';
    feed = { title: j.title || null, link: j.home_page_url || null, description: j.description || null, updated: j.feed_url ? null : (j.items?.[0]?.date_modified || null), lang: j.language || null, generator: j.version || null };
    items = (j.items || []).map((it) => ({
      id: it.id ?? null,
      title: it.title ?? null,
      link: it.url ?? null,
      summary: it.summary ?? null,
      content: it.content_html ?? it.content_text ?? null,
      author: it.authors?.[0]?.name ?? it.author?.name ?? null,
      published: it.date_published ?? null,
      updated: it.date_modified ?? null,
      categories: it.tags ?? [],
      image: it.image ?? (it.attachments?.[0]?.url ?? null),
      format,
    }));
    if (!j.items) notes.push('valid JSON but no items[] array — not a JSON Feed');
  } catch (e) {
    die(`not a feed: input starts with "{" but is not valid JSON (${e.message.slice(0, 60)})`);
  }
} else if (/<rss|<rdf:RDF/i.test(trimmed)) {
  format = /<rdf:RDF/i.test(trimmed) ? 'rss1' : 'rss2';
  const channel = (/<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(trimmed) || [])[1] || trimmed;
  feed = { title: firstTag(channel, 'title'), link: firstTag(channel, 'link') || tagAttr(channel, 'link', 'href'), description: firstTag(channel, 'description'), lang: firstTag(channel, 'language'), generator: firstTag(channel, 'generator'), updated: firstTag(channel, 'lastBuildDate') || firstTag(channel, 'pubDate') };
  items = allBlocks(trimmed, 'item').map((b) => {
    const x = b.inner;
    const cats = [...x.matchAll(/<category\b[^>]*>([^<]*)<\/category>/gi)].map((c) => decode(c[1]).trim()).filter(Boolean);
    return {
      id: firstTag(x, 'guid') || firstTag(x, 'link'),
      title: firstTag(x, 'title'),
      link: firstTag(x, 'link') || tagAttr(x, 'link', 'href'),
      summary: firstTag(x, 'description') ? strip(firstTag(x, 'description')).slice(0, 500) : null,
      content: firstTag(x, 'content:encoded') || firstTag(x, 'description'),
      author: firstTag(x, 'dc:creator') || firstTag(x, 'author'),
      published: firstTag(x, 'pubDate') ? new Date(firstTag(x, 'pubDate')).toISOString() : null,
      updated: firstTag(x, 'atom:updated') ? new Date(firstTag(x, 'atom:updated')).toISOString() : null,
      categories: cats,
      image: tagAttr(x, 'enclosure', 'url') || tagAttr(x, 'media:content', 'url'),
      format,
    };
  });
  if (!items.length) notes.push('RSS feed contains zero <item> elements');
} else if (/<feed\b/i.test(trimmed)) {
  format = 'atom';
  feed = { title: strip(firstTag(trimmed, 'title') || ''), link: tagAttrsAll(trimmed, 'link').map((a) => a.href).find(Boolean) || null, description: firstTag(trimmed, 'subtitle'), lang: tagAttr(trimmed, 'feed', 'xml:lang') || tagAttr(trimmed, 'feed', 'lang'), generator: firstTag(trimmed, 'generator'), updated: firstTag(trimmed, 'updated') };
  items = allBlocks(trimmed, 'entry').map((b) => {
    const x = b.inner;
    const links = tagAttrsAll(x, 'link').filter((a) => a.href);
    const alt = links.find((a) => (a.rel || 'alternate') === 'alternate') || links[0] || {};
    return {
      id: firstTag(x, 'id'),
      title: strip(firstTag(x, 'title') || '') || null,
      link: alt.href || null,
      summary: firstTag(x, 'summary') ? strip(firstTag(x, 'summary')).slice(0, 500) : null,
      content: firstTag(x, 'content') || firstTag(x, 'summary'),
      author: firstTag(x, 'name') || firstTag(x, 'author'),
      published: firstTag(x, 'published') ? new Date(firstTag(x, 'published')).toISOString() : null,
      updated: firstTag(x, 'updated') ? new Date(firstTag(x, 'updated')).toISOString() : null,
      categories: allBlocks(x, 'category').map((c) => tagAttr(c.full, 'category', 'term')).filter(Boolean),
      image: null,
      format,
    };
  });
  if (!items.length) notes.push('Atom feed contains zero <entry> elements');
} else {
  die(`unrecognised feed format — no <rss>, <feed> or JSON object at the top of ${final}`);
}

const kinds = format === 'jsonfeed' ? [body] : [];
void kinds;

const coverage = ['id', 'title', 'link', 'summary', 'content', 'author', 'published', 'updated', 'categories', 'image'].map((f) => ({
  field: f,
  filled: items.filter((i) => {
    const v = i[f];
    return Array.isArray(v) ? v.length > 0 : (v !== null && v !== undefined && v !== '');
  }).length,
  percent: items.length ? Math.round((items.filter((i) => { const v = i[f]; return Array.isArray(v) ? v.length : (v !== null && v !== undefined && v !== ''); }).length / items.length) * 100) : 0,
}));

const keep = items.slice(0, limit);

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: final, contentType: type || null, format, feed, count: items.length, entries: keep, coverage, notes }, null, 2));
} else {
  console.log(`${final} — format: ${format}${type ? ` (${type})` : ''}\n`);
  console.log(`feed: ${feed.title || '(untitled)'}`);
  if (feed.link) console.log(`site: ${feed.link}`);
  console.log(`entries: ${items.length}${items.length > limit ? ` (showing ${limit})` : ''}`);
  if (feed.updated) console.log(`updated: ${feed.updated}`);
  console.log('');
  console.log(table(keep.map((i, n) => ({
    '#': n + 1,
    date: (flag(o, 'dates') ? i.published : (i.published || '').slice(0, 10)) || '—',
    title: String(i.title || '(untitled)').slice(0, 52),
    author: String(i.author || '').slice(0, 16),
  }))));
  console.log('\nfield coverage:');
  console.log(table(coverage.map((c) => ({ field: c.field, filled: `${c.filled}/${items.length}`, percent: c.percent + '%' }))));
  if (notes.length) console.log('\nnotes:\n  ' + notes.join('\n  '));
}
