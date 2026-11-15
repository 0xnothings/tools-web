#!/usr/bin/env node
// textgrab.js — fetch a page and extract readable text.
// Copyright (c) 2026 0xnothings
// @tool textgrab
// @desc Strip scripts, nav and markup from an HTML page and return the readable article text
// @usage node tools/textgrab.js https://example.com --max 4000
// @tags web,scrape,text
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`textgrab — readable text extraction

  node tools/textgrab.js <url|file|-> [options]

  --max <n>     truncate output to n characters (default: no limit)
  --keep-links  render links as "text <url>"
  --keep-lines  preserve source line breaks where possible
  --stats       print word/char counts instead of the text
  --json        machine-readable output {url,title,text,words,chars}
  -h, --help    this text

  Removes script/style/noscript/svg/iframe/header/footer/nav/aside/form/template,
  then converts block-level tags to line breaks and decodes entities.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const target = o._[0];
if (!target) die('usage: node tools/textgrab.js <url|file|-> [--max 4000] [--json]');

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => (named[n.toLowerCase()] ?? m));
}

function extract(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');

  if (flag(o, 'keep-links')) {
    s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, txt) => `${txt.replace(/<[^>]+>/g, ' ').trim()} <${href}>`);
  } else {
    s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  }

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|table|ul|ol)>/gi, '\n')
    .replace(/<(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  s = s.replace(/\r/g, '');
  const out = s.split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url, status: res.status };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  if (t === '-' || t === undefined) return { body: await readInput(null), final: 'stdin', status: 200 };
  return { body: await readInput(t), final: t, status: 200 };
}

const page = await load(target);
const titleMatch = page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;
let text = extract(page.body);

const maxChars = num(get(o, 'max'), 0);
const truncated = maxChars > 0 && text.length > maxChars;
if (truncated) text = text.slice(0, maxChars).trimEnd() + '…';

const words = text.split(/\s+/).filter(Boolean).length;

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    url: page.final, status: page.status, title,
    chars: text.length, words, truncated,
    readingMinutes: Math.round((words / 220) * 10) / 10,
    text,
  }, null, 2));
  process.exitCode = 0;
} else if (flag(o, 'stats')) {
  console.log(`url:     ${page.final}`);
  console.log(`title:   ${title || '—'}`);
  console.log(`chars:   ${text.length}`);
  console.log(`words:   ${words}`);
  console.log(`reading: ~${Math.round((words / 220) * 10) / 10} min`);
} else {
  if (title) console.log(`# ${title}\n`);
  console.log(text);
}
