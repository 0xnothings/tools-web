#!/usr/bin/env node
// domquery.js — CSS-selector query over HTML text with a hand-written matcher.
// Copyright (c) 2026 0xnothings
// @tool domquery
// @desc Query HTML with tag/class/id/attribute selectors plus descendant, child and sibling combinators, printing each match with its text and attributes
// @usage node tools/domquery.js page.html "article.card > h2.title"
// @tags web,dom,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`domquery — CSS-selector-ish DOM query

  node tools/domquery.js <url|file|-> "<selector>" [options]

  Supports:  tag  .class  #id  *  [attr]  [attr=val]  [attr^=v]  [attr$=v]  [attr*=v]
             combinators: " " descendant, ">" child, "+" adjacent, "~" general sibling
             pseudo: :first-child  :last-child  :nth-child(n)  :not(<compound>)
             group: a, b  — comma separates independent selectors

  --limit <n>   cap matches printed (default 50)
  --text        print only the text of each match
  --html        print the outer HTML of each match
  --json        machine-readable output
  -h, --help    this text`); 
  process.exit(0);
}

const src = o._[0];
const selector = o._[1];
if (!src || !selector) die('usage: node tools/domquery.js <url|file|-> "<selector>"');

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9' };
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const k = m[1].toLowerCase();
    if (!k) continue;
    attrs[k] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

function parseDoc(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  const s = String(html);
  const re = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<\/\s*([a-zA-Z][^\s>]*)\s*>|<!--[\s\S]*?-->|<![^>]*>/g;
  let last = 0, m;
  const addText = (t, parent) => {
    const txt = decode(t);
    if (txt.trim()) parent.children.push({ tag: '#text', text: txt, children: [], attrs: {}, parent });
  };
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) addText(s.slice(last, m.index), stack[stack.length - 1]);
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[2] || ''), children: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(node);
      if (RAW.has(tag)) {
        const closeRe = new RegExp(`</\\s*${tag}\\s*>`, 'ig');
        closeRe.lastIndex = last;
        const cm = closeRe.exec(s);
        const end = cm ? cm.index : s.length;
        addText(s.slice(last, end), node);
        last = cm ? cm.index + cm[0].length : s.length;
        re.lastIndex = last;
      } else if (!VOID.has(tag) && m[3] !== '/') {
        stack.push(node);
      }
    } else if (m[4]) {
      const tag = m[4].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
    }
  }
  if (last < s.length) addText(s.slice(last), stack[stack.length - 1]);
  return root;
}

function parseCompound(c) {
  const out = { tag: null, ids: [], classes: [], attrs: [], pseudo: [] };
  const re = /(\*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]|::?([\w-]+)(\([^)]*\))?|([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(c)) !== null) {
    if (m[1]) continue;
    if (m[2]) out.ids.push(m[2]);
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) {
      const am = m[4].match(/^([\w-]+)\s*(?:([~|^$*]?=)\s*["']?([^"'\]]*)["']?)?$/);
      if (am) out.attrs.push({ k: am[1].toLowerCase(), op: am[2] || null, v: am[3] ?? null });
    } else if (m[5]) out.pseudo.push({ name: m[5].toLowerCase(), arg: (m[6] || '').replace(/^\(|\)$/g, '') });
    else if (m[7]) out.tag = m[7].toLowerCase();
  }
  return out;
}

function parseSelector(sel) {
  return sel.split(',').map((part) => {
    const norm = part.trim().replace(/\s*([>+~])\s*/g, ' $1 ');
    const pieces = norm.split(/\s+/).filter(Boolean);
    const steps = [];
    let comb = null;
    for (const p of pieces) {
      if (p === '>' || p === '+' || p === '~') { comb = p; continue; }
      steps.push({ compound: parseCompound(p), comb: steps.length ? (comb || ' ') : null });
      comb = null;
    }
    return steps;
  }).filter((s) => s.length);
}

const elementChildren = (n) => n.children.filter((c) => c.tag !== '#text');
const parentEl = (n) => (n.parent && n.parent.tag !== '#root' ? n.parent : null);

function matchCompound(el, c) {
  if (!el || el.tag === '#text') return false;
  if (c.tag && c.tag !== el.tag) return false;
  for (const id of c.ids) if ((el.attrs.id || '') !== id) return false;
  if (c.classes.length) {
    const cls = (el.attrs.class || '').split(/\s+/);
    for (const k of c.classes) if (!cls.includes(k)) return false;
  }
  for (const a of c.attrs) {
    const has = Object.prototype.hasOwnProperty.call(el.attrs, a.k);
    if (!a.op) { if (!has) return false; continue; }
    if (!has) return false;
    const v = el.attrs[a.k];
    if (a.op === '=' && v !== a.v) return false;
    if (a.op === '^=' && !v.startsWith(a.v)) return false;
    if (a.op === '$=' && !v.endsWith(a.v)) return false;
    if (a.op === '*=' && !v.includes(a.v)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.v)) return false;
    if (a.op === '|=' && !(v === a.v || v.startsWith(a.v + '-'))) return false;
  }
  for (const p of c.pseudo) {
    const sibs = el.parent ? elementChildren(el.parent) : [];
    if (p.name === 'first-child' && sibs[0] !== el) return false;
    if (p.name === 'last-child' && sibs[sibs.length - 1] !== el) return false;
    if (p.name === 'nth-child') {
      const idx = sibs.indexOf(el) + 1;
      const n = Number(p.arg);
      if (!Number.isFinite(n) || idx !== n) return false;
    }
    if (p.name === 'not') {
      if (matchCompound(el, parseCompound(p.arg))) return false;
    }
  }
  return true;
}

function matchSteps(el, steps, idx) {
  if (!matchCompound(el, steps[idx].compound)) return false;
  if (idx === 0) return true;
  const comb = steps[idx].comb;
  if (comb === '>') return matchSteps(parentEl(el) || { tag: '#none' }, steps, idx - 1);
  if (comb === '+') {
    const sibs = el.parent ? elementChildren(el.parent) : [];
    const i = sibs.indexOf(el);
    return i > 0 ? matchSteps(sibs[i - 1], steps, idx - 1) : false;
  }
  if (comb === '~') {
    const sibs = el.parent ? elementChildren(el.parent) : [];
    const i = sibs.indexOf(el);
    for (let k = i - 1; k >= 0; k--) if (matchSteps(sibs[k], steps, idx - 1)) return true;
    return false;
  }
  let cur = parentEl(el);
  while (cur) {
    if (matchSteps(cur, steps, idx - 1)) return true;
    cur = parentEl(cur);
  }
  return false;
}

function outerHtml(el) {
  const attrs = Object.entries(el.attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`)).join('');
  if (el.tag === '#text') return el.text;
  if (VOID.has(el.tag)) return `<${el.tag}${attrs}>`;
  return `<${el.tag}${attrs}>${el.children.map(outerHtml).join('')}</${el.tag}>`;
}
const textOf = (el) => (el.tag === '#text' ? el.text : el.children.map(textOf).join(' ')).replace(/\s+/g, ' ').trim();

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

const html = await load(src);
const doc = parseDoc(html);
const groups = parseSelector(selector);

const matches = [];
(function visit(node, depth) {
  if (node.tag !== '#text' && node.tag !== '#root') {
    for (const steps of groups) {
      if (matchSteps(node, steps, steps.length - 1)) {
        matches.push({ el: node, depth, order: matches.length + 1 });
        break;
      }
    }
  }
  for (const c of node.children) if (c.tag !== '#text') visit(c, depth + 1);
})(doc, 0);

const limit = Math.max(1, num(get(o, 'limit'), 50));
const rows = matches.slice(0, limit).map((m, i) => ({
  '#': i + 1,
  tag: m.el.tag + (m.el.attrs.id ? '#' + m.el.attrs.id : '') + (m.el.attrs.class ? '.' + m.el.attrs.class.split(/\s+/).slice(0, 2).join('.') : ''),
  depth: m.depth,
  text: textOf(m.el).slice(0, get(o, 'text') ? 400 : 70),
}));

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    source: src,
    selector,
    count: matches.length,
    matches: matches.slice(0, limit).map((m) => ({
      tag: m.el.tag,
      id: m.el.attrs.id || null,
      class: m.el.attrs.class || null,
      attrs: m.el.attrs,
      depth: m.depth,
      text: textOf(m.el).slice(0, 500),
      html: outerHtml(m.el).slice(0, 1200),
    })),
  }, null, 2));
} else if (flag(o, 'text')) {
  for (const m of matches.slice(0, limit)) console.log(textOf(m.el));
} else if (flag(o, 'html')) {
  for (const m of matches.slice(0, limit)) console.log(outerHtml(m.el) + '\n');
} else {
  console.log(`${src} — "${selector}" matched ${matches.length} element(s), showing ${Math.min(limit, matches.length)}\n`);
  console.log(table(rows));
  if (matches.length > limit) console.log(`\n${matches.length - limit} more — raise --limit`);
}
