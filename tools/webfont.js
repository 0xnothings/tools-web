#!/usr/bin/env node
// webfont.js — detect web fonts, loading strategy and FOUT/FOIT risk.
// Copyright (c) 2026 0xnothings
// @tool webfont
// @desc Inventory every @font-face and font load on a page, classify the loading strategy (local, preload, display swap, self-hosted vs third-party) and estimate FOUT/FOIT risk
// @usage node tools/webfont.js https://example.com --link
// @tags web,fonts,performance
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`webfont — font loading audit

  node tools/webfont.js <url|file|-> [options]

  --link           also fetch linked stylesheets and read their @font-face rules
  --json           machine-readable output
  -h, --help       this text

  Reports: font-family, source URL, format, font-display value, preload state,
  whether the host is third-party, and a FOUT/FOIT risk verdict per family.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t };
}

const { body, final } = await load(o._[0] || die('usage: node tools/webfont.js <url|file|->'));
const pageHost = (() => { try { return new globalThis.URL(final).host; } catch { return ''; } })();

const preloads = new Set();
const preloadRe = /<link\b[^>]*rel\s*=\s*["']?preload["']?[^>]*>/gi;
let m;
while ((m = preloadRe.exec(body)) !== null) {
  if (!/as\s*=\s*["']?font/i.test(m[0])) continue;
  const href = (m[0].match(/href\s*=\s*["']([^"']+)/i) || [])[1];
  if (href) preloads.add(href.split('?')[0]);
}
const corsPreload = /crossorigin/.test((body.match(/<link\b[^>]*as\s*=\s*["']?font[^>]*>/gi) || []).join(' '));

const googleLinks = [...body.matchAll(/<link\b[^>]*href\s*=\s*["']([^"']*fonts\.googleapis\.com[^"']+)["'][^>]*>/gi)].map((x) => x[1]);
const googlePreconnect = /fonts\.gstatic\.com/i.test(body) && /preconnect/i.test(body);

let css = '';
const inlineStyles = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((x) => x[1]);
css += inlineStyles.join('\n');

if (flag(o, 'link')) {
  const sheets = [...body.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi)].map((x) => (x[0].match(/href\s*=\s*["']([^"']+)/i) || [])[1]).filter(Boolean).slice(0, 6);
  for (const href of sheets) {
    let abs = href;
    try { abs = new globalThis.URL(href, final).href; } catch { continue; }
    try {
      const res = await fetch(abs, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (res.ok) css += '\n' + (await res.text());
    } catch { /* skip unreachable sheet */ }
  }
}

const faces = [];
const faceRe = /@font-face\s*\{([^}]*)\}/gi;
while ((m = faceRe.exec(css)) !== null) {
  const block = m[1];
  const pick = (prop) => (block.match(new RegExp(`${prop}\\s*:\\s*([^;]+)`, 'i')) || [])[1]?.trim() || null;
  const family = (pick('font-family') || '').replace(/["']/g, '').split(',')[0].trim();
  const srcRaw = pick('src') || '';
  const urls = [...srcRaw.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((x) => x[1]);
  const formats = [...srcRaw.matchAll(/format\(\s*["']?([\w-]+)["']?\s*\)/gi)].map((x) => x[1]);
  const localSrc = /local\(/i.test(srcRaw);
  const display = pick('font-display');
  const weight = pick('font-weight');
  const unicodeRange = /unicode-range/i.test(block);
  for (const u of (urls.length ? urls : [null])) {
    const baseName = u ? u.split('/').pop().split('?')[0] : null;
    const preloaded = u ? preloads.has(u.split('?')[0]) || [...preloads].some((p) => u.includes(p) || p.includes(baseName || '\u0000')) : false;
    let host = '';
    try { host = u ? new globalThis.URL(u, final).host : ''; } catch { host = ''; }
    const thirdParty = host && pageHost && host !== pageHost;
    faces.push({
      family: family || '(unnamed)',
      file: baseName || (localSrc ? '(local only)' : '(no src)'),
      url: u ? (u.length > 60 ? u.slice(0, 60) + '…' : u) : null,
      format: formats[0] || (baseName ? (baseName.split('.').pop() || '?') : '?'),
      weight: weight || '400',
      display: display || '(unset → block)',
      preloaded,
      host: host || '(inline)',
      thirdParty: thirdParty ? 'yes' : '',
      unicodeRange,
      fallback: localSrc ? 'local() first' : 'network',
    });
  }
}

const families = [...new Set(faces.map((f) => f.family))];
const verdicts = families.map((fam) => {
  const set = faces.filter((f) => f.family === fam);
  const display = set[0].display;
  const preloaded = set.some((f) => f.preloaded);
  const thirdParty = set.some((f) => f.thirdParty === 'yes');
  const risk = display.includes('swap') ? (thirdParty ? 'LOW-MED' : 'LOW')
    : display.includes('optional') ? 'LOW'
    : display.includes('fallback') ? 'MEDIUM'
    : display.includes('block') ? (preloaded ? 'MEDIUM' : 'HIGH')
    : (preloaded ? 'MEDIUM' : 'HIGH');
  const symptom = display.includes('swap') ? 'FOUT — fallback shown, then swap'
    : display.includes('optional') ? 'no FOIT, font may be skipped'
    : display.includes('block') ? 'FOIT — invisible text up to 3s'
    : preloaded ? 'FOIT, shortened by preload' : 'FOIT — invisible text until the font loads';
  return { family: fam, faces: set.length, display, preloaded: preloaded ? 'yes' : 'no', thirdParty: thirdParty ? 'yes' : 'no', risk, symptom, formats: [...new Set(set.map((f) => f.format))].join(',') };
});

const systemStack = /font-family\s*:\s*([^;{}]+)/i.exec(css.replace(/@font-face\s*\{[^}]*\}/gi, ''));
const stackFamilies = systemStack ? systemStack[1].split(',').map((s) => s.replace(/["']/g, '').trim()).filter(Boolean) : [];
const stackHasFallback = stackFamilies.length > 1;

const result = {
  source: final,
  pageHost,
  fontFaceCount: faces.length,
  families: families.length,
  preloadedCount: preloads.size,
  crossoriginOnPreload: corsPreload,
  googleFontsLinks: googleLinks,
  googlePreconnect,
  faces,
  verdicts,
  stackFamilies,
  hasFallbackStack: stackHasFallback,
};

if (flag(o, 'json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${final}\n`);
  if (!faces.length) {
    console.log('no @font-face rules found' + (googleLinks.length ? ' in inline CSS' : ''));
  } else {
    console.log(table(faces.map((f) => ({
      family: f.family.slice(0, 18),
      file: String(f.file).slice(0, 26),
      format: f.format,
      weight: f.weight,
      display: f.display,
      preload: f.preloaded ? 'yes' : '—',
      third: f.thirdParty,
    }))));
  }
  if (googleLinks.length) {
    console.log(`\nGoogle Fonts stylesheet(s): ${googleLinks.length}`);
    for (const g of googleLinks.slice(0, 4)) console.log('  ' + g.slice(0, 88));
    console.log(`  preconnect to fonts.gstatic.com: ${googlePreconnect ? 'present' : 'MISSING — add <link rel=preconnect>'}`);
  }
  if (verdicts.length) {
    console.log('\nloading strategy per family:');
    console.log(table(verdicts.map((v) => ({ family: v.family.slice(0, 18), faces: v.faces, display: v.display, preload: v.preloaded, '3p': v.thirdParty, risk: v.risk, symptom: v.symptom.slice(0, 36) }))));
  }
  console.log(`\nfont-display audit: ${verdicts.filter((v) => v.risk === 'HIGH').length} high risk, ${verdicts.filter((v) => v.risk.startsWith('MEDIUM') || v.risk === 'LOW-MED').length} medium`);
  if (!stackHasFallback && stackFamilies.length) console.log('declared font stack has no fallback family — add a system fallback');
  if (preloads.size && !corsPreload) console.log('preloaded fonts lack crossorigin — the preload will be fetched twice');
}
