#!/usr/bin/env node
// pagestruct.js — heading outline and landmark structure audit.
// Copyright (c) 2026 0xnothings
// @tool pagestruct
// @desc Print the h1-h6 outline with level skips flagged, count multiple h1s, and report missing or repeated nav/main/aside/footer landmarks
// @usage node tools/pagestruct.js https://example.com
// @tags web,seo,a11y
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`pagestruct — document outline and landmarks

  node tools/pagestruct.js <url|file|-> [options]

  --depth <n>     indent outline entries to this nesting level (default 4)
  --sections      also list sectioning elements (section/article/nav/aside/main)
  --json          machine-readable output
  -h, --help      this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

const { body, final } = await load(o._[0] || die('usage: node tools/pagestruct.js <url|file|->'));
const src = String(body);

const headings = [];
const headRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
let m;
while ((m = headRe.exec(src)) !== null) {
  const level = Number(m[1]);
  const attrs = (m[0].match(/^<h[1-6]\b([^>]*)>/i) || [])[1] || '';
  const id = (attrs.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || null;
  const cls = (attrs.match(/\bclass\s*=\s*["']([^"']+)/i) || [])[1] || null;
  const text = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  headings.push({ level, text: text.slice(0, 90), id, class: cls, at: m.index });
}

const icons = { 1: '#', 2: '##', 3: '###', 4: '####', 5: '#####', 6: '######' };
const skips = [];
for (let i = 1; i < headings.length; i++) {
  if (headings[i].level - headings[i - 1].level > 1) {
    skips.push({ from: `h${headings[i - 1].level}`, to: `h${headings[i].level}`, at: headings[i].text.slice(0, 44) });
  }
}

const tagCount = (tag) => (src.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
const landmarks = ['main', 'nav', 'header', 'footer', 'aside', 'section', 'article', 'form'].map((t) => ({ el: t, count: tagCount(t) }));
const ariaLandmarks = [...src.matchAll(/role\s*=\s*["'](main|navigation|banner|contentinfo|complementary|search)["']/gi)].map((x) => x[1].toLowerCase());
const skipLink = /<a\b[^>]*href\s*=\s*["']#(main|content|skip[^"']*)["'][^>]*>\s*(skip|jump)/i.test(src);
const langAttr = (src.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)/i) || [])[1] || null;
const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || null;
const h1s = headings.filter((h) => h.level === 1);

const issues = [];
if (!headings.length) issues.push({ level: 'HIGH', issue: 'no headings found', where: 'document' });
if (h1s.length === 0 && headings.length) issues.push({ level: 'HIGH', issue: 'no h1', where: 'document' });
if (h1s.length > 1) issues.push({ level: 'MEDIUM', issue: `${h1s.length} h1 elements`, where: h1s.map((h) => h.text.slice(0, 30)).join(' | ') });
for (const s of skips) issues.push({ level: 'LOW', issue: `heading level skip ${s.from} -> ${s.to}`, where: s.at });
if (landmarks[0].count === 0) issues.push({ level: 'MEDIUM', issue: 'no <main> landmark', where: 'document' });
if (landmarks[1].count === 0) issues.push({ level: 'MEDIUM', issue: 'no <nav> landmark', where: 'document' });
if (landmarks[0].count > 1) issues.push({ level: 'MEDIUM', issue: `${landmarks[0].count} <main> elements`, where: 'document (only one allowed)' });
if (!skipLink) issues.push({ level: 'LOW', issue: 'no skip-to-content link', where: 'document' });
if (!langAttr) issues.push({ level: 'MEDIUM', issue: 'html element has no lang attribute', where: '<html>' });
if (!title) issues.push({ level: 'MEDIUM', issue: 'no <title>', where: '<head>' });
const emptyHeadings = headings.filter((h) => !h.text);
if (emptyHeadings.length) issues.push({ level: 'LOW', issue: `${emptyHeadings.length} empty heading(s)`, where: 'document' });

const levelCounts = [1, 2, 3, 4, 5, 6].map((l) => ({ level: `h${l}`, count: headings.filter((h) => h.level === l).length }));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: final,
    title, lang: langAttr,
    headingCount: headings.length,
    headings, levelSkips: skips, levelCounts, landmarks,
    ariaLandmarks, skipLink,
    issues,
  }, null, 2));
} else {
  console.log(`${final}\ntitle: ${title || '(none)'}   lang: ${langAttr || '(none)'}\n`);
  if (headings.length) {
    console.log('outline:');
    const depth = Math.max(1, num(get(o, 'depth'), 4));
    for (const h of headings.slice(0, 80)) {
      const pad = '  '.repeat(Math.min(depth, h.level - 1));
      console.log(`${pad}${icons[h.level]} ${h.text || '(empty)'}`);
    }
    if (headings.length > 80) console.log(`... ${headings.length - 80} more`);
  } else console.log('outline: (no headings)');
  console.log('\nheading level counts:');
  console.log(table(levelCounts));
  console.log('\nlandmarks:');
  console.log(table(landmarks.map((l) => ({ element: `<${l.el}>`, count: l.count, note: l.el === 'main' && l.count !== 1 ? 'expected exactly 1' : '' }))));
  if (ariaLandmarks.length) console.log(`\nARIA roles: ${ariaLandmarks.join(', ')}`);
  console.log(`\nskip link: ${skipLink ? 'present' : 'missing'}`);
  if (flag(o, 'sections')) {
    const sections = [...src.matchAll(/<(section|article|aside|nav|main|header|footer)\b([^>]*)>/gi)].map((x) => ({
      el: x[1].toLowerCase(),
      id: (x[2].match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || '',
      labelled: /aria-(label|labelledby)|<h[1-6]/i.test(x[2]) ? 'yes' : '',
    }));
    console.log(`\nsectioning elements (${sections.length}):`);
    console.log(table(sections.slice(0, 40)));
  }
  if (issues.length) {
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    console.log('\nissues:');
    console.log(table(issues.sort((a, b) => rank[a.level] - rank[b.level]).map((i) => ({ severity: i.level, issue: i.issue, where: i.where.slice(0, 46) }))));
  } else console.log('\nno structural issues detected');
}
