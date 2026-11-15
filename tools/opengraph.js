#!/usr/bin/env node
// opengraph.js — OpenGraph and Twitter Card completeness validator.
// Copyright (c) 2026 0xnothings
// @tool opengraph
// @desc Check every og: and twitter: tag against what each platform needs, then render the text preview card that would be shown when the link is shared
// @usage node tools/opengraph.js https://example.com
// @tags web,seo,social
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`opengraph — social card validator and preview

  node tools/opengraph.js <url|file|-> [options]

  --width <n>     preview column width (default 72)
  --fetch-images  HEAD each og:image to report status and content-type
  --json          machine-readable output
  -h, --help      this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const LIMITS = {
  'og:title': 60, 'og:description': 110, 'twitter:title': 70, 'twitter:description': 200,
  'og:image:width': 1200, 'og:image:height': 630,
};

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { html: await res.text(), final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { html: await readInput(t === '-' ? null : t), final: t };
}

const { html, final } = await load(o._[0] || die('usage: node tools/opengraph.js <url|file|->'));

const meta = new Map();
const metaRe = /<meta\b[^>]*>/gi;
let m;
while ((m = metaRe.exec(html)) !== null) {
  const tag = m[0];
  const key = ((tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)/i) || [])[1] || '').toLowerCase();
  if (!key) continue;
  const val = decode((tag.match(/\bcontent\s*=\s*["']([^"']*)/i) || [])[1] || '');
  if (key.startsWith('og:') || key.startsWith('twitter:')) if (!meta.has(key)) meta.set(key, val);
}
const canonical = (html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*href\s*=\s*["']([^"']+)/i) || [])[1] || null;
const titleTag = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const descTag = decode((html.match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)/i) || [])[1] || '').trim();
const icon = (html.match(/<link\b[^>]*rel\s*=\s*["'][^"']*(?:icon|shortcut)[^"']*["'][^>]*href\s*=\s*["']([^"']+)/i) || [])[1] || null;

const PLATFORMS = {
  facebook: ['og:title', 'og:type', 'og:image', 'og:url'],
  twitter: ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'],
  linkedin: ['og:title', 'og:description', 'og:image'],
  discord: ['og:title', 'og:description', 'og:image'],
  slack: ['og:title', 'og:description', 'og:image'],
  whatsapp: ['og:title', 'og:description', 'og:image'],
  telegram: ['og:title', 'og:description', 'og:image'],
};
const OPTIONAL = { facebook: ['og:description', 'og:site_name', 'og:locale'], twitter: ['twitter:site', 'twitter:creator'], linkedin: ['og:site_name'], discord: ['og:site_name'], slack: ['og:site_name'], whatsapp: [], telegram: [] };

const effective = (key) => {
  if (meta.has(key)) return meta.get(key);
  const alt = { 'twitter:title': 'og:title', 'twitter:description': 'og:description', 'twitter:image': 'og:image' }[key];
  if (alt && meta.has(alt)) return `(falls back to ${alt}) ${meta.get(alt)}`;
  if (key === 'twitter:title') return titleTag || null;
  if (key === 'twitter:description') return descTag || null;
  return null;
};

const required = [...new Set(Object.values(PLATFORMS).flat())];
const rows = required.map((k) => {
  const v = effective(k);
  const limit = LIMITS[k] || null;
  let note = '';
  if (v && limit && v.length > limit) note = `${v.length} chars > ${limit} recommended`;
  if (v && v.startsWith('(falls back')) note = note || 'implicit fallback';
  return { tag: k, present: v ? 'yes' : 'no', length: v ? v.replace(/^\(falls back to [^)]*\) /, '').length : 0, note, value: (v || '').slice(0, 54) };
});

const missing = [...meta.keys()].length ? rows.filter((r) => r.present === 'no') : [];
const platformReport = Object.entries(PLATFORMS).map(([plat, req]) => {
  const miss = req.filter((k) => !effective(k));
  const optMiss = (OPTIONAL[plat] || []).filter((k) => !meta.has(k));
  return { platform: plat, required: req.length, missing: miss.join(', ') || '—', score: `${req.length - miss.length}/${req.length}`, optional_missing: optMiss.join(', ') || '—' };
});

let imageReport = [];
if (flag(o, 'fetch-images')) {
  const imgs = [...new Set([meta.get('og:image'), meta.get('twitter:image')].filter(Boolean))];
  for (const raw of imgs) {
    let abs = raw;
    try { abs = new globalThis.URL(raw, final).href; } catch { /* keep */ }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(abs, { method: 'HEAD', signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
      imageReport.push({ url: abs.slice(0, 60), status: res.status, type: res.headers.get('content-type') || '', bytes: res.headers.get('content-length') || '?' });
    } catch (e) {
      imageReport.push({ url: abs.slice(0, 60), status: e.name === 'AbortError' ? 'timeout' : 'error', type: '', bytes: '?' });
    } finally { clearTimeout(timer); }
  }
}

const title = (meta.get('og:title') || titleTag || '').replace(/^\(falls back[^)]*\)\s*/, '');
const desc = (meta.get('og:description') || descTag || '').replace(/^\(falls back[^)]*\)\s*/, '');
const site = meta.get('og:site_name') || (() => { try { return new globalThis.URL(final).host; } catch { return ''; } })();
const card = meta.get('twitter:card') || 'summary_large_image';
const type = meta.get('og:type') || '(missing og:type)';

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { if (cur) out.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const width = Math.max(40, Math.min(120, num(get(o, 'width'), 72)));

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: final, canonical, tags: Object.fromEntries(meta), tagsChecked: rows, platforms: platformReport, images: imageReport, preview: { card, site, title, description: desc, type } }, null, 2));
} else {
  console.log(`${final}\n`);
  console.log(table(rows.map((r) => ({ tag: r.tag.slice(0, 22), ok: r.present, len: r.length, note: r.note.slice(0, 30), value: r.value }))));
  console.log('\nplatform requirements:');
  console.log(table(platformReport));
  if (imageReport.length) {
    console.log('\nimages:');
    console.log(table(imageReport));
  }
  const inner = width - 4;
  console.log('\ncard preview (' + card + '):');
  console.log('+' + '-'.repeat(width - 2) + '+');
  const put = (t) => console.log('| ' + String(t).slice(0, inner).padEnd(inner) + ' |');
  put('');
  put('  ' + (meta.get('og:image') ? '[ image: ' + meta.get('og:image').replace(/^https?:\/\//, '').slice(0, inner - 14) + ' ]' : '[ no og:image — plain text card ]'));
  put('');
  put('  ' + card.toUpperCase());
  put('');
  for (const l of wrap(title || '(no title)', inner - 2)) put('  ' + l);
  put('  ' + site.toLowerCase().slice(0, inner - 2));
  put('');
  for (const l of wrap(desc || '(no description)', inner - 2).slice(0, 3)) put('  ' + l);
  put('');
  console.log('+' + '-'.repeat(width - 2) + '+');
  console.log(`\ncanonical: ${canonical || '(none — og:url is used for the share target)'}`);
  console.log(`favicon: ${icon || '(none)'}`);
  if (missing.length) console.log(`\n${missing.length} of ${rows.length} commonly required tags missing: ${missing.map((r) => r.tag).join(', ')}`);
}
