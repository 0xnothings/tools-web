// htmltable.js — extract HTML tables into CSV/JSON.
// Copyright (c) 2026 0xnothings
// @tool htmltable
// @desc Find every <table> on a page and emit its rows as JSON or CSV with proper rowspan/colspan handling
// @usage node tools/htmltable.js https://en.wikipedia.org/wiki/List_of_countries_by_population --index 0 --csv
// @tags web,scrape,data
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`htmltable — HTML table extractor

  node tools/htmltable.js <url|file|-> [options]

  --index <n>      emit only table n (0-based); default: list all tables
  --all            emit every table, each tagged with its index
  --csv            CSV output instead of JSON
  --header-row     treat the first row as headers and emit objects
  --min-rows <n>   ignore tables with fewer rows than this (default 1)
  --json           machine-readable output (default when a single table is selected)
  -h, --help       this text

  Handles <thead>/<tbody>/<tfoot>, nested markup inside cells, and expands
  rowspan/colspan into a rectangular grid.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/htmltable.js <url|file|-> [--index 0] [--csv]');

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', deg: '°', times: '×' };
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => (named[n.toLowerCase()] ?? m));
}

const TAG = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>|</${name}\\s*>`, 'gi');

/** Remove every tag, skipping over quoted attribute values that contain > */
function stripTags(html) {
  let out = '';
  let i = 0;
  const s = String(html);
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    /* find end of tag, honouring quotes */
    let j = lt + 1;
    let quote = null;
    let closed = false;
    while (j < s.length) {
      const ch = s[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') { closed = true; break; }
      j++;
    }
    if (!closed) { out += s.slice(lt); break; }
    out += ' ';
    i = j + 1;
  }
  return out;
}

const cellText = (html) => decodeEntities(stripTags(String(html).replace(/<br\s*\/?>/gi, ' ')))
  .replace(/\s+/g, ' ').trim();

/** Depth-aware extractor for the OUTERMOST <tag> blocks — handles nested tables/rows correctly. */
function topLevelBlocks(html, tagName) {
  const re = TAG(tagName);
  const out = [];
  let depth = 0, start = -1, openLen = 0, attrsAt = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[0].startsWith('</');
    if (!closing) {
      if (depth === 0) { start = m.index; openLen = m[0].length; attrsAt = m[0].slice(1 + tagName.length, -1) || ''; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const inner = html.slice(start + openLen, m.index);
        out.push({ attrs: attrsAt, inner, html: html.slice(start, m.index + m[0].length) });
        start = -1;
      }
    }
  }
  return out;
}

function splitRows(tableInner) {
  const blocks = topLevelBlocks(tableInner, 'tr');
  if (blocks.length) return blocks.map((b) => b.inner);
  /* Some pages omit <tr> inside <table> — fall back to line splitting. */
  return tableInner.split(/<\/(?:div|p)>/i);
}

function expand(rows) {
  const grid = [];
  const pending = new Map();
  for (const rowHtml of rows) {
    const cellBlocks = [];
    for (const tag of ['th', 'td']) {
      for (const b of topLevelBlocks(rowHtml, tag)) {
        cellBlocks.push({ html: b.inner, attrs: b.attrs, header: tag === 'th', at: rowHtml.indexOf(b.html) });
      }
    }
    cellBlocks.sort((a, b) => a.at - b.at);
    const cells = cellBlocks.map((c) => {
      const attrs = c.attrs || '';
      const span = (n) => {
        const v = (attrs.match(new RegExp(`\\b${n}\\s*=\\s*["']?(\\d+)`, 'i')) || [])[1];
        return v ? Math.max(1, Number(v)) : 1;
      };
      return { html: c.html, colspan: span('colspan'), rowspan: span('rowspan'), header: c.header };
    });
    if (!cells.length) continue;
    const out = [];
    let col = 0;
    const pendingNow = pending;
    const fill = () => {
      while (pendingNow.has(col)) {
        const p = pendingNow.get(col);
        out[col] = p.value;
        p.left--;
        if (p.left <= 0) pendingNow.delete(col); else pendingNow.set(col, p);
        col++;
      }
    };
    for (const c of cells) {
      fill();
      for (let i = 0; i < c.colspan; i++) {
        const text = cellText(c.html);
        out[col] = text;
        if (c.rowspan > 1) pendingNow.set(col, { value: text, left: c.rowspan - 1 });
        col++;
      }
      fill();
    }
    fill();
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
    grid.push(out);
  }
  const width = Math.max(0, ...grid.map((r) => r.length));
  return grid.map((r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url };
    } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t };
}

const page = await load(src);

const tables = [];
for (const block of topLevelBlocks(page.body, 'table')) {
  const rawAttrs = block.attrs || '';
  const caption = /<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(block.inner);
  const rows = expand(splitRows(block.inner));
  const dataRows = rows.length ? rows.length - 1 : 0;
  tables.push({
    index: tables.length,
    id: (rawAttrs.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || null,
    className: (rawAttrs.match(/\bclass\s*=\s*["']([^"']+)/i) || [])[1] || null,
    caption: caption ? cellText(caption[1]) : null,
    columns: rows[0]?.length || 0,
    rows: rows.length,
    dataRows,
    grid: rows,
  });
}

const minRows = Math.max(1, num(get(o, 'min-rows'), 1));
const usable = tables.filter((t) => t.rows >= minRows);
const indexArg = get(o, 'index', null);
const wantAll = flag(o, 'all') || indexArg === null;

function toCsv(grid) {
  const cell = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return grid.map((r) => r.map(cell).join(',')).join('\n');
}

function toObjects(grid, useHeader) {
  if (!useHeader || !grid.length) return grid.map((r) => Object.fromEntries(r.map((v, i) => [`col${i + 1}`, v])));
  const head = grid[0].map((h, i) => h || `col${i + 1}`);
  return grid.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

if (wantAll) {
  if (flag(o, 'csv')) {
    console.log(usable.map((t) => `# table ${t.index}${t.caption ? ` — ${t.caption}` : ''}\n${toCsv(t.grid)}`).join('\n\n'));
  } else if (flag(o, 'json')) {
    console.log(JSON.stringify({
      source: page.final, tableCount: tables.length,
      tables: usable.map((t) => ({ index: t.index, caption: t.caption, id: t.id, columns: t.columns, rows: t.rows, data: toObjects(t.grid, flag(o, 'header-row')) })),
    }, null, 2));
  } else {
    console.log(`${page.final} — ${tables.length} table(s)\n`);
    console.log(table(usable.map((t) => ({
      '#': t.index, rows: t.rows, cols: t.columns,
      header: (t.grid[0] || []).slice(0, 3).join(' | ').slice(0, 46),
      caption: (t.caption || t.id || '').slice(0, 34),
    }))));
    const small = tables.length - usable.length;
    if (small) console.log(`\n${small} table(s) below --min-rows ${minRows} hidden`);
    console.log('\n--index <n> --csv  to dump one table');
  }
  process.exitCode = 0;
} else {
  const n = num(indexArg, 0);
  const t = tables[n];
  if (!t) die(`table ${n} not found — page has ${tables.length} table(s) (0..${Math.max(0, tables.length - 1)})`);
  if (flag(o, 'csv')) console.log(toCsv(t.grid));
  else if (flag(o, 'json')) console.log(JSON.stringify({ index: t.index, caption: t.caption, columns: t.columns, rows: t.rows, data: toObjects(t.grid, flag(o, 'header-row')) }, null, 2));
  else {
    console.log(`${page.final} — table ${t.index}${t.caption ? ` — ${t.caption}` : ''}  (${t.rows} rows × ${t.columns} cols)\n`);
    console.log(table(t.grid.slice(0, 40).map((r, i) => Object.fromEntries(r.map((v, j) => [`c${j + 1}`, String(v).slice(0, 24)])))));
    if (t.rows > 40) console.log(`\n${t.rows - 40} more rows — use --csv`);
  }
  process.exitCode = 0;
}
