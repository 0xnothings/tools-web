#!/usr/bin/env node
// codeblock.js — extract code blocks with language detection.
// Copyright (c) 2026 0xnothings
// @tool codeblock
// @desc Pull every <pre><code> (and standalone <pre>) block out of a page, detect the language from class names, and print them as markdown fences
// @usage node tools/codeblock.js https://example.com/post --lang js
// @tags web,scrape,markdown
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`codeblock — extract code from a page as markdown

  node tools/codeblock.js <url|file|-> [options]

  --lang <name>   only emit blocks detected as this language
  --list          one-line-per-block summary instead of full fences
  --json          machine-readable output
  -h, --help      this text

  Language detection order: class="language-x" / class="lang-x" / data-language,
  then content heuristics (shebang, keywords, punctuation density).`); 
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
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z#0-9]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

const PATTERNS = [
  ['bash', /^#!.*\b(bash|sh)\b|^\s*(sudo|apt|npm|yarn|pnpm|pip|git|cd|ls|curl|docker|node|go|cargo|make)\s/m],
  ['python', /^\s*(def|class)\s+\w+|^\s*(import|from)\s+\w+|^\s*@\w+\(|\bself\./m],
  ['javascript', /\b(const|let|var)\s+\w+\s*=|=>|console\.log|require\(|module\.exports|\bawait\s|\bfunction\s*\w*\s*\(/],
  ['typescript', /:\s*(string|number|boolean|void|any)\b|\binterface\s+\w+|\btype\s+\w+\s*=/],
  ['json', /^\s*[{[]\s*$|"\s*:\s*("|\d|true|false|null|[{[])/],
  ['html', /<\/?[a-z][\w-]*(\s+[^>]*)?>/i],
  ['css', /[.#]?[\w-]+\s*\{[^}]*:[^}]*;|\@media\b|\bcolor\s*:/],
  ['sql', /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER|JOIN)\b/i],
  ['go', /\bfunc\s+\w+\(|\bpackage\s+\w+|\bimport\s+\(|\bfmt\./],
  ['rust', /\bfn\s+\w+\(|\blet\s+mut\b|println!|\bimpl\s+\w+|\buse\s+std::/],
  ['java', /\bpublic\s+(static\s+)?(class|void|int|String)\b|\bSystem\.out\./],
  ['c', /\b#include\s*<|\bint\s+main\s*\(|\bprintf\s*\(/],
  ['php', /<\?php|\$\w+\s*=|->\w+\(/],
  ['yaml', /^\s*[\w-]+\s*:\s*.*$/m],
  ['markdown', /^#{1,6}\s+\w|^\s*[-*]\s+\w/m],
];

function detectLang(code, classes) {
  const attr = classes || '';
  const m = attr.match(/(?:language|lang|highlight|brush)[-:]([\w+#-]+)/i);
  if (m) return m[1].toLowerCase();
  const dl = attr.match(/data-(?:language|lang)\s*=\s*["']?([\w+#-]+)/i);
  if (dl) return dl[1].toLowerCase();
  for (const [lang, re] of PATTERNS) if (re.test(code)) return lang;
  return 'text';
}

const html = await load(o._[0] || die('usage: node tools/codeblock.js <url|file|->'));

const blocks = [];
const seen = new Set();
const preRe = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi;
let m;
while ((m = preRe.exec(html)) !== null) {
  const preAttrs = m[1] || '';
  let inner = m[2];
  let lang = null;
  const codeMatch = /<code\b([^>]*)>([\s\S]*?)<\/code>/i.exec(inner);
  let attrText = preAttrs;
  if (codeMatch) { attrText += ' ' + (codeMatch[1] || ''); inner = codeMatch[2]; }
  inner = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:div|p|li)>/gi, '\n').replace(/<[^>]+>/g, '');
  let code = decode(inner).replace(/\u00a0/g, ' ');
  code = code.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!code.trim()) continue;
  lang = detectLang(code, attrText);
  blocks.push({ index: blocks.length, lang, lines: code.split('\n').length, chars: code.length, code });
  seen.add(m.index);
}

const inline = [];
if (!blocks.length) {
  const codeRe = /<code\b([^>]*)>([\s\S]*?)<\/code>/gi;
  let c;
  while ((c = codeRe.exec(html)) !== null) {
    const code = decode(c[2].replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ');
    if (!code.includes('\n') && code.length < 60) continue;
    inline.push({ index: inline.length, lang: detectLang(code, c[1] || ''), lines: code.split('\n').length, chars: code.length, code });
  }
}

const found = blocks.length ? blocks : inline;
const want = get(o, 'lang', null);
const filtered = want ? found.filter((b) => b.lang === String(want).toLowerCase() || b.lang.includes(String(want).toLowerCase())) : found;
const langTally = [...found.reduce((map, b) => map.set(b.lang, (map.get(b.lang) || 0) + 1), new Map()).entries()].map(([lang, count]) => ({ lang, count, lines: found.filter((b) => b.lang === lang).reduce((a, b) => a + b.lines, 0) }));

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: o._[0], blockCount: found.length, source: 'pre' + (blocks.length ? '' : ' (inline code fallback)'), languages: langTally, blocks: filtered }, null, 2));
} else if (flag(o, 'list')) {
  console.log(`${o._[0]} — ${found.length} code block(s)\n`);
  console.log(table(langTally));
  console.log('');
  console.log(table(filtered.map((b) => ({ '#': b.index, lang: b.lang, lines: b.lines, chars: b.chars, first: b.code.split('\n')[0].slice(0, 50) }))));
} else {
  console.log(`${o._[0]} — ${found.length} code block(s)${want ? ` (${filtered.length} matching "${want}")` : ''}\n`);
  if (langTally.length) console.log(table(langTally) + '\n');
  for (const b of filtered) {
    console.log('```' + b.lang);
    console.log(b.code);
    console.log('```\n');
  }
  if (!found.length) console.log('no <pre> or <code> blocks found on the page');
}
