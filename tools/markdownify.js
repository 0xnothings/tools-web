// markdownify.js — convert HTML to clean markdown.
// Copyright (c) 2026 0xnothings
// @tool markdownify
// @desc Hand-written HTML to markdown converter covering headings, emphasis, links, images, lists, tables, code fences, blockquotes and horizontal rules
// @usage node tools/markdownify.js https://example.com/post --drop-nav
// @tags web,markdown,convert
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`markdownify — HTML to markdown

  node tools/markdownify.js <url|file|-> [options]

  --drop-nav         remove nav/footer/header/aside/script/style before converting
  --keep-empty-links keep anchors with no text
  --base <url>       resolve relative links against this base
  --json             wrapped JSON output ({ markdown, stats })
  -h, --help         this text

  Escape hatches: inline code uses backticks, tables become GFM pipe tables,
  nested lists are preserved with two-space indentation per level.`); 
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

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', '&': '&' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

const { body, final } = await load(o._[0] || die('usage: node tools/markdownify.js <url|file|->'));
let html = String(body);

const base = get(o, 'base', null) || final;
const absUrl = (u) => {
  if (!u || /^(#|mailto:|tel:|data:|https?:)/i.test(u)) return u;
  try { return new globalThis.URL(u, base).href; } catch { return u; }
};

if (flag(o, 'drop-nav')) {
  html = html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  html = html.replace(/<(nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}
html = html.replace(/<!--[\s\S]*?-->/g, '');

const inline = (s) => {
  let x = String(s);
  x = x.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => {
    const t = decode(c.replace(/<[^>]+>/g, ''));
    const ticks = t.includes('`') ? '``' : '`';
    return `${ticks}${t}${ticks}`;
  });
  x = x.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  x = x.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  x = x.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  x = x.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  x = x.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '~~$1~~');
  x = x.replace(/<s\b[^>]*>([\s\S]*?)<\/s>/gi, '~~$1~~');
  x = x.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==');
  x = x.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, '~$1~');
  x = x.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '^$1^');
  x = x.replace(/<kbd\b[^>]*>([\s\S]*?)<\/kbd>/gi, '`$1`');
  x = x.replace(/<br\s*\/?>/gi, '  \n');
  x = x.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1] || '';
    const alt = (tag.match(/\balt\s*=\s*["']([^"']*)/i) || [])[1] || '';
    const title = (tag.match(/\btitle\s*=\s*["']([^"']*)/i) || [])[1];
    if (!src) return '';
    return `![${alt}](${absUrl(src)}${title ? ` "${title}"` : ''})`;
  });
  x = x.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = String(text).replace(/<[^>]+>/g, '').trim();
    if (!t && !flag(o, 'keep-empty-links')) return '';
    return `[${t || href}](${absUrl(href)})`;
  });
  x = x.replace(/<[^>]+>/g, '');
  return decode(x);
};

function convertTable(tableHtml) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) cells.push(inline(cm[2]).replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
  const head = pad(rows[0]);
  const out = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  for (const r of rows.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |');
  return out.join('\n');
}

const lines = [];
let listStack = [];
let inParagraph = false;

function flushList() {
  if (listStack.length) listStack = [];
  return '';
}

function convert(htmlText, depth = 0) {
  let s = String(htmlText);

  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const cm = /<code\b([^>]*)>([\s\S]*?)<\/code>/i.exec(inner);
    const attr = cm ? cm[1] : '';
    let codeRaw = cm ? cm[2] : inner;
    codeRaw = codeRaw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    let code = decode(codeRaw).replace(/\u00a0/g, ' ').replace(/^\n+|\s+$/g, '');
    const lang = (attr.match(/(?:language|lang)-([\w+#-]+)/i) || [])[1] || '';
    return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  });

  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => `\n\n${convertTable(inner)}\n\n`);

  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const t = inline(convert(inner)).trim().split('\n').map((l) => '> ' + l).join('\n');
    return `\n\n${t}\n\n`;
  });

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inline(inner).replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');

  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const text = inline(convert(inner)).replace(/\s+/g, ' ').trim();
    return `\n${'  '.repeat(depth)}- ${text}`;
  });
  s = s.replace(/<\/?(ul|ol|dl)\b[^>]*>/gi, '\n');

  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${inline(convert(inner)).trim()}\n\n`);
  s = s.replace(/<\/(?:div|section|article|main|figure|figcaption)>/gi, '\n\n');
  s = s.replace(/<div\b[^>]*>/gi, '\n');

  s = inline(s);
  return s;
}

let md = convert(html);
md = md.replace(/\r\n/g, '\n');
md = md.replace(/[ \t]+\n/g, '\n');
md = md.replace(/\n{3,}/g, '\n\n');
md = md.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim() + '\n';

const stats = {
  source: final,
  bytes: md.length,
  lines: md.split('\n').length,
  words: md.split(/\s+/).filter(Boolean).length,
  headings: (md.match(/^#{1,6}\s/gm) || []).length,
  links: (md.match(/\[[^\]]*\]\([^)]*\)/g) || []).length,
  images: (md.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length,
  codeFences: Math.floor((md.match(/^```/gm) || []).length / 2),
  tables: (md.match(/^\|.*\|$/gm) || []).length ? (md.match(/^\| *---/gm) || []).length : 0,
};

if (flag(o, 'json')) console.log(JSON.stringify({ ...stats, markdown: md }, null, 2));
else process.stdout.write(md);
