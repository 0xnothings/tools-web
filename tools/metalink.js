// metalink.js — extract OpenGraph / Twitter-card / oEmbed metadata from a URL.
// Copyright (c) 2026 0xnothings
// @tool metalink
// @desc Pull OpenGraph, Twitter-card, canonical and oEmbed metadata off any page into one object
// @usage node tools/metalink.js https://github.com --oembed --json
// @tags web,seo,scrape
import { args, get, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`metalink — link preview metadata extractor

  node tools/metalink.js <url> [options]

  --oembed      also fetch the discovered oEmbed endpoint
  --raw         include every <meta> tag found (not just the known keys)
  --timeout <n> request timeout in ms (default 15000)
  --json        machine-readable output
  -h, --help    this text

  Reports og:*, twitter:*, description, canonical, theme-color, JSON-LD summary
  and the oEmbed discovery link.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const target = o._[0];
if (!target) die('usage: node tools/metalink.js <url> [--oembed] [--json]');
const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
const timeout = Math.max(1000, Number(get(o, 'timeout', 15000)) || 15000);

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function tagAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

async function grab(u, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(u, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,*/*' },
    });
    return { ok: res.ok, status: res.status, final: res.url, type: res.headers.get('content-type') || '', body: await res.text() };
  } finally { clearTimeout(t); }
}

let page;
try { page = await grab(url, timeout); }
catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
if (!page.ok) die(`fetch failed: HTTP ${page.status} ${url}`);

const html = page.body;
const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => tagAttrs(m[0]));
const byKey = {};
for (const a of metas) {
  const k = (a.property || a.name || a.itemprop || '').toLowerCase();
  if (k) byKey[k] = a.content ?? a.value ?? byKey[k] ?? '';
}

const pick = (...keys) => {
  for (const k of keys) if (byKey[k]) return byKey[k];
  return null;
};
const firstTag = (re) => {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
};

const title = pick('og:title', 'twitter:title') || firstTag(/<title[^>]*>([\s\S]*?)<\/title>/i);
const desc = pick('og:description', 'twitter:description', 'description');
const canonical = (html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i) || [])[0];
const canonicalHref = canonical ? tagAttrs(canonical).href || null : null;
const canonicalTag = (html.match(/<link\b[^>]*rel\s*=\s*["'](?:canonical)["'][^>]*href\s*=\s*["']([^"']+)/i) || [])[1] || null;

const oembedTag = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => tagAttrs(m[0]))
  .find((a) => (a.type || '').includes('oembed') && a.href);
const iconTag = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => tagAttrs(m[0]))
  .find((a) => /icon/i.test(a.rel || '') && a.href);

const ld = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => {
    try { return JSON.parse(m[1].trim()); } catch { return { parseError: true }; }
  });

const meta = {
  url, finalUrl: page.final, status: page.status, contentType: page.type,
  title,
  description: desc,
  canonical: canonicalTag || canonicalHref || null,
  siteName: pick('og:site_name', 'application-name'),
  type: pick('og:type'),
  image: pick('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
  imageAlt: pick('og:image:alt', 'twitter:image:alt'),
  imageWidth: pick('og:image:width'),
  imageHeight: pick('og:image:height'),
  video: pick('og:video', 'og:video:url', 'twitter:player'),
  audio: pick('og:audio'),
  locale: pick('og:locale'),
  themeColor: pick('theme-color', 'msapplication-tilecolor'),
  card: pick('twitter:card'),
  twitterSite: pick('twitter:site', 'twitter:creator'),
  favicon: iconTag ? new URL(iconTag.href, page.final).toString() : null,
  oembed: oembedTag ? { href: new URL(oembedTag.href, page.final).toString(), type: oembedTag.type } : null,
  jsonld: ld.map((d) => (d['@type'] ? { type: d['@type'], name: d.name || d.headline || null } : { keys: Object.keys(d).slice(0, 6) })),
  missing: [],
};
if (!meta.title) meta.missing.push('title');
if (!meta.description) meta.missing.push('description');
if (!meta.image) meta.missing.push('og:image');
if (!meta.canonical) meta.missing.push('canonical');

if (flag(o, 'oembed') && meta.oembed) {
  try {
    const r = await grab(meta.oembed.href, timeout);
    meta.oembed.data = r.type.includes('json') ? JSON.parse(r.body) : { raw: r.body.slice(0, 400) };
    meta.oembed.status = r.status;
  } catch (e) { meta.oembed.error = String(e.message); }
}

if (flag(o, 'raw')) meta.metaTags = byKey;

if (flag(o, 'json')) { console.log(JSON.stringify(meta, null, 2)); process.exitCode = 0; } else {
const rows = Object.entries({ title: meta.title, description: meta.description, canonical: meta.canonical, site: meta.siteName, type: meta.type, image: meta.image, card: meta.card, locale: meta.locale, theme: meta.themeColor, oembed: meta.oembed?.href })
  .map(([k, v]) => ({ field: k, value: v ? String(v).replace(/\s+/g, ' ').slice(0, 88) : '—' }));
console.log(`${meta.finalUrl}  [HTTP ${meta.status}]  ${meta.contentType.split(';')[0]}\n`);
console.log(table(rows));
if (meta.missing.length) console.log(`\nmissing: ${meta.missing.join(', ')}`);
if (meta.jsonld.length) console.log(`json-ld blocks: ${meta.jsonld.length} (${meta.jsonld.map((d) => d.type || 'object').join(', ')})`);
}
