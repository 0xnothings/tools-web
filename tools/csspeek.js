// csspeek.js — CSS analyzer: specificity, duplicates, media inventory.
// Copyright (c) 2026 0xnothings
// @tool csspeek
// @desc Score every CSS rule for specificity and complexity, flag duplicate declaration blocks and selectors no class/id on the page uses, and inventory @media/@supports blocks
// @usage node tools/csspeek.js https://example.com --html https://example.com
// @tags web,css,audit
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`csspeek — CSS specificity and hygiene report

  node tools/csspeek.js <url|file|-> [options]

  --html <url|file>  cross-check selectors against the class/id usage of this page
  --link             also follow <link rel=stylesheet> found in HTML input (max 6)
  --top <n>          rows per section (default 10)
  --json             machine-readable output
  -h, --help         this text

  Accepts a .css file, a raw HTML page, or stdin.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const src = o._[0];
if (!src) die('usage: node tools/csspeek.js <url|file|-> [--html page]');

async function load(t, accept = 'text/css,text/html,*/*') {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t };
}

const stripComments = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(body) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((d) => d.trim()).filter((d) => d.includes(':')).map((d) => {
    const i = d.indexOf(':');
    return { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() };
  });
}

function walk(css, ctx, out) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 0, j = open, close = -1;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) break;
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      const at = prelude.split(/[\s(]/)[0].toLowerCase();
      if (/^@(media|supports|layer|container|scope|document)$/.test(at)) walk(body, [...ctx, prelude], out);
      else out.push({ kind: 'at', selector: prelude, at, ctx: [...ctx], body, decls: [] });
    } else {
      const decls = declarations(body);
      for (const sel of prelude.split(',').map((s) => s.trim()).filter(Boolean)) {
        out.push({ kind: 'rule', selector: sel, ctx: [...ctx], body, decls });
      }
    }
    i = close + 1;
  }
}

function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let s = sel.replace(/::[\w-]+/g, ' PSEUDOEL ');
  s = s.replace(/:not\(([^)]*)\)/gi, (_, inner) => ' ' + inner + ' ');
  s = s.replace(/:where\(([^)]*)\)/gi, ' ');
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?/g) || []).length;
  c += (s.match(/(?:^|[\s>+~(,])([a-zA-Z][\w-]*)/g) || []).length;
  c += (s.match(/PSEUDOEL/g) || []).length;
  return { a, b, c, score: a * 100 + b * 10 + c, text: `${a}-${b}-${c}` };
}

function findStylesheets(html) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ label: '<style>', css: m[1] });
  const lre = /<link\b[^>]*>/gi;
  while ((m = lre.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (href) out.push({ label: href, css: null });
  }
  return out;
}

async function collect() {
  const page = await load(src);
  const body = page.body;
  const looksHtml = /<html|<body|<style|<link\b/i.test(body);
  if (!looksHtml) return { css: body, sources: [{ label: page.final, bytes: body.length }], page: null };
  const sheets = findStylesheets(body);
  const parts = [];
  const sources = [];
  let fetched = 0;
  for (const sh of sheets) {
    if (sh.css !== null) { parts.push(sh.css); sources.push({ label: sh.label, bytes: sh.css.length }); continue; }
    if (!flag(o, 'link') || fetched >= 6) { sources.push({ label: sh.label, bytes: 0, skipped: true }); continue; }
    let abs = sh.label;
    const isRemote = /^https?:\/\//i.test(sh.label);
    try { abs = new globalThis.URL(sh.label, page.final).href; } catch { /* keep raw */ }
    if (!isRemote && !/^https?:/i.test(page.final)) {
      /* local page with a relative stylesheet: read it off disk */
      const baseDir = isAbsolute(page.final) ? dirname(page.final) : process.cwd();
      const diskPath = isAbsolute(sh.label) ? sh.label : join(baseDir, sh.label);
      try {
        const t = readFileSync(diskPath, 'utf8');
        parts.push(t); sources.push({ label: diskPath, bytes: t.length }); fetched++;
      } catch (e) { sources.push({ label: diskPath, bytes: 0, skipped: e.code || 'unreadable' }); }
      continue;
    }
    try {
      const res = await fetch(abs, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (res.ok) { const t = await res.text(); parts.push(t); sources.push({ label: abs, bytes: t.length }); fetched++; }
      else sources.push({ label: abs, bytes: 0, skipped: `HTTP ${res.status}` });
    } catch (e) { sources.push({ label: abs, bytes: 0, skipped: e.message.slice(0, 40) }); }
  }
  return { css: parts.join('\n'), sources, page: body };
}

const { css, sources, page } = await collect();
if (!css.trim()) die('no CSS found — pass a .css file/URL, an HTML page with <style>, or add --link');

const rules = [];
walk(stripComments(css), [], rules);
const styleRules = rules.filter((r) => r.kind === 'rule');

const bySelector = new Map();
const byDecls = new Map();
for (const r of styleRules) {
  const sig = r.decls.map((d) => `${d.prop}:${d.value}`).sort().join(';');
  r.sig = sig;
  r.spec = specificity(r.selector);
  r.complexity = (r.selector.match(/[\s>+~]+/g) || []).length;
  r.length = r.decls.length;
  if (!bySelector.has(r.selector)) bySelector.set(r.selector, []);
  bySelector.get(r.selector).push(r);
  if (sig) {
    if (!byDecls.has(sig)) byDecls.set(sig, []);
    byDecls.get(sig).push(r);
  }
}

const repeatedSelectors = [...bySelector.entries()].filter(([, v]) => v.length > 1).map(([sel, v]) => ({ selector: sel, times: v.length, specificity: v[0].spec.text }));
const duplicateBlocks = [...byDecls.entries()].filter(([, v]) => v.length > 1).map(([sig, v]) => ({
  selectors: v.map((r) => r.selector).join(' | '),
  count: v.length,
  decls: sig.replace(/;/g, '; ').slice(0, 70),
}));

const media = new Map();
for (const r of rules) {
  for (const c of r.ctx) {
    if (!media.has(c)) media.set(c, 0);
    media.set(c, media.get(c) + 1);
  }
}
const mediaInventory = [...media.entries()].map(([q, n]) => ({ query: q, rules: n }));

const atBlocks = rules.filter((r) => r.kind === 'at').map((r) => ({ at: r.at, prelude: r.selector.slice(0, 60) }));

let unused = [];
if (get(o, 'html', null)) {
  const h = await load(String(get(o, 'html')), 'text/html,*/*');
  const usedClasses = new Set((h.body.match(/class\s*=\s*["']([^"']*)["']/gi) || []).flatMap((m) => m.replace(/^class\s*=\s*["']|["']$/gi, '').split(/\s+/)).filter(Boolean));
  const usedIds = new Set((h.body.match(/id\s*=\s*["']([^"']+)["']/gi) || []).map((m) => m.replace(/^id\s*=\s*["']|["']$/gi, '')));
  unused = styleRules.filter((r) => {
    if (/[:@]/.test(r.selector)) return false;
    const classes = (r.selector.match(/\.([\w-]+)/g) || []).map((x) => x.slice(1));
    const ids = (r.selector.match(/#([\w-]+)/g) || []).map((x) => x.slice(1));
    if (!classes.length && !ids.length) return false;
    const classHit = classes.some((c) => usedClasses.has(c));
    const idHit = ids.some((i) => usedIds.has(i));
    return !classHit && !idHit;
  }).map((r) => ({ selector: r.selector, specificity: r.spec.text }));
}

const top = Math.max(1, num(get(o, 'top'), 10));
const totalBytes = sources.reduce((a, s) => a + (s.bytes || 0), 0);
const hoisted = styleRules.filter((r) => r.spec.score >= 300).length;
const maxDepth = Math.max(0, ...styleRules.map((r) => r.complexity));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: src,
    bytes: totalBytes,
    sources,
    rules: styleRules.length,
    selectors: bySelector.size,
    media: mediaInventory,
    atRules: atBlocks,
    maxSpecificity: styleRules.map((r) => r.spec.score).sort((a, b) => b - a)[0] ?? 0,
    maxCombinatorDepth: maxDepth,
    highSpecificityRules: hoisted,
    repeatedSelectors,
    duplicateBlocks,
    unusedSelectors: unused,
  }, null, 2));
} else {
  console.log(`${src} — ${totalBytes.toLocaleString('en-US')} bytes CSS from ${sources.length} source(s)`);
  console.log(`${styleRules.length} rules over ${bySelector.size} unique selectors · ${media.size} distinct at-rule contexts · max specificity ${styleRules.map((r) => r.spec.score).sort((a, b) => b - a)[0] ?? 0}`);
  if (sources.length > 1 || sources[0].bytes !== totalBytes) {
    console.log('\nsources:');
    console.log(table(sources.map((s) => ({ source: s.label.slice(0, 60), bytes: s.bytes || 0, note: s.skipped || '' }))));
  }
  if (mediaInventory.length) {
    console.log('\n@media inventory:');
    console.log(table(mediaInventory.slice(0, top).map((m) => ({ query: m.query.slice(0, 62), rules: m.rules }))));
  }
  const spec = styleRules.slice().sort((a, b) => b.spec.score - a.spec.score).slice(0, top);
  console.log('\nmost specific selectors:');
  console.log(table(spec.map((r) => ({ specificity: r.spec.text, score: r.spec.score, decls: r.length, selector: r.selector.slice(0, 54) }))));
  if (duplicateBlocks.length) {
    console.log(`\nduplicate declaration blocks (${duplicateBlocks.length}):`);
    console.log(table(duplicateBlocks.slice(0, top).map((d) => ({ count: d.count, selectors: d.selectors.slice(0, 44), decls: d.decls }))));
  }
  if (repeatedSelectors.length) {
    console.log(`\nselectors declared more than once (${repeatedSelectors.length}):`);
    console.log(table(repeatedSelectors.slice(0, top).map((r) => ({ times: r.times, specificity: r.specificity, selector: r.selector.slice(0, 56) }))));
  }
  if (get(o, 'html', null)) {
    console.log(`\nselectors with no matching class/id on the page (${unused.length}):`);
    if (unused.length) console.log(table(unused.slice(0, top * 2).map((u) => ({ specificity: u.specificity, selector: u.selector.slice(0, 60) }))));
    else console.log('  none — every simple class/id selector is referenced');
  }
  if (hoisted) console.log(`\n${hoisted} rule(s) at specificity >= 3-0-0 — override candidates for lowering`);
}
