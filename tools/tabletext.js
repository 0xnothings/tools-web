#!/usr/bin/env node
// tabletext.js — render an HTML table as an aligned plain-text grid.
// Copyright (c) 2026 0xnothings
// @tool tabletext
// @desc Turn any HTML table into a monospaced grid with computed column widths, honouring rowspan and colspan and wrapping cells that are too wide
// @usage node tools/tabletext.js https://example.com/pricing --index 0 --max-width 30
// @tags web,scrape,text
import { args, get, num, flag, die, readInput } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`tabletext — HTML table to aligned text

  node tools/tabletext.js <url|file|-> [options]

  --index <n>     render only table n (0-based, default 0)
  --all           render every table
  --max-width <n> wrap any cell wider than n characters (default 24)
  --border <n>    border style: 1 = ascii box, 0 = plain rules (default 1)
  --no-header     do not treat row 0 as a header row
  --json          machine-readable output
  -h, --help      this text`); 
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
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', deg: '\u00b0', times: '\u00d7' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}
const cellText = (h) => decode(String(h).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const html = await load(o._[0] || die('usage: node tools/tabletext.js <url|file|->'));

function topBlocks(src, tag) {
  const re = new RegExp(`<${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>|</${tag}\\s*>`, 'gi');
  const out = [];
  let depth = 0, start = -1, openLen = 0, attrs = '', m;
  while ((m = re.exec(src)) !== null) {
    if (!m[0].startsWith('</')) {
      if (depth === 0) { start = m.index; openLen = m[0].length; attrs = m[0]; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { out.push({ inner: src.slice(start + openLen, m.index), open: attrs }); start = -1; }
    }
  }
  return out;
}

function expand(tableInner) {
  const rows = topBlocks(tableInner, 'tr');
  if (!rows.length) return [];
  const grid = [];
  const carry = new Map();
  for (const row of rows) {
    const cells = [];
    for (const tag of ['th', 'td']) {
      for (const b of topBlocks(row.inner, tag)) {
        const span = (n) => Number((b.open.match(new RegExp(`${n}\\s*=\\s*["']?(\\d+)`, 'i')) || [])[1] || 1);
        cells.push({ text: cellText(b.inner), colspan: Math.max(1, span('colspan')), rowspan: Math.max(1, span('rowspan')), header: tag === 'th', at: row.inner.indexOf(b.inner) });
      }
    }
    cells.sort((a, b) => a.at - b.at);
    if (!cells.length) continue;
    const out = [];
    let col = 0;
    const drain = () => {
      while (carry.has(col)) {
        const c = carry.get(col);
        out[col] = c.text;
        c.left--;
        if (c.left <= 0) carry.delete(col); else carry.set(col, c);
        col++;
      }
    };
    for (const c of cells) {
      drain();
      for (let i = 0; i < c.colspan; i++) {
        out[col] = c.text;
        if (c.rowspan > 1) carry.set(col, { text: c.text, left: c.rowspan - 1 });
        col++;
      }
      drain();
    }
    drain();
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
    grid.push(out);
  }
  const width = Math.max(0, ...grid.map((r) => r.length));
  return grid.map((r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
}

const maxWidth = Math.max(6, num(get(o, 'max-width'), 24));
const useBorder = num(get(o, 'border'), 1) !== 0;

function wrap(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    let token = w;
    while (token.length > width) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(token.slice(0, width));
      token = token.slice(width);
    }
    if ((cur + ' ' + token).trim().length > width) { if (cur) out.push(cur); cur = token; }
    else cur = (cur + ' ' + token).trim();
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function render(grid, headerRow) {
  if (!grid.length) return '(empty table)';
  const cols = grid[0].length;
  // Column width = the WIDEST cell in that column, capped at maxWidth.
  //
  // This read Math.min(maxWidth, ...cells), which takes the NARROWEST cell:
  // a column with cells "a" and "bb" got width 1, then "bb" was hard-wrapped
  // into "b" / "b" and each half printed on its own row. Math.max is the
  // intended reduction.
  const widths = Array.from({ length: cols }, (_, i) => Math.max(1, Math.min(maxWidth, Math.max(...grid.map((r) => String(r[i] ?? '').length)))));
  const body = grid.map((r) => r.map((c, i) => wrap(String(c ?? ''), widths[i])));
  const height = Math.max(...body.map((r) => Math.max(...r.map((c) => c.length))));
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';
  const plainRule = widths.map((w) => '─'.repeat(w)).join('  ');
  const out = [];
  if (useBorder) out.push(top);
  for (let r = 0; r < body.length; r++) {
    for (let line = 0; line < Math.max(...body[r].map((c) => c.length)); line++) {
      const cells = body[r].map((c, i) => (c[line] ?? '').padEnd(widths[i]));
      out.push(useBorder ? '│ ' + cells.join(' │ ') + ' │' : cells.join('  '));
    }
    if (r === 0 && headerRow) out.push(useBorder ? mid : plainRule);
    else if (r < body.length - 1 && useBorder) out.push(mid);
  }
  if (useBorder) out.push(bot);
  return out.join('\n');
}

const tables = topBlocks(html, 'table').map((tb, i) => ({ index: i, grid: expand(tb.inner), caption: cellText((tb.inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || '') }));
if (!tables.length) die('no <table> element found in input');

const all = flag(o, 'all');
const pick = num(get(o, 'index'), 0);
const chosen = all ? tables : [tables[pick]].filter(Boolean);
if (!chosen.length) die(`table ${pick} not found — input has ${tables.length} table(s)`);

const headerRow = !flag(o, 'no-header');

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: o._[0],
    tableCount: tables.length,
    tables: chosen.map((t) => ({ index: t.index, caption: t.caption || null, rows: t.grid.length, cols: t.grid[0]?.length || 0, grid: t.grid })),
  }, null, 2));
} else {
  for (const t of chosen) {
    if (all) console.log(`# table ${t.index}${t.caption ? ' — ' + t.caption : ''}  (${t.grid.length} rows)`);
    console.log(render(t.grid, headerRow));
    console.log('');
  }
  if (!all && tables.length > 1) console.log(`${tables.length} tables on the page — --index <n> or --all`);
}
