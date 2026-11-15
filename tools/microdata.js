#!/usr/bin/env node
// microdata.js — extract microdata and RDFa items into normalised JSON.
// Copyright (c) 2026 0xnothings
// @tool microdata
// @desc Parse itemscope/itemprop microdata and RDFa vocab/property/typeof attributes into a nested item tree keyed by schema.org type
// @usage node tools/microdata.js https://example.com/product
// @tags web,seo,structured-data
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`microdata — microdata and RDFa extractor

  node tools/microdata.js <url|file|-> [options]

  --type <name>   only emit items whose @type matches (case-insensitive substring)
  --flat          one row per property instead of nested JSON
  --json          machine-readable output (default for nested output)
  -h, --help      this text

  Handles: itemscope / itemtype / itemprop / itemid / content|datetime|href|src
  value resolution, nested items, itemref, and RDFa typeof / property / vocab.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TEXT_PROP = new Set(['name', 'description', 'headline', 'text', 'articleBody', 'title']);

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[1]) continue;
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

function parseDoc(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, text: '', index: -1 };
  const stack = [root];
  const s = String(html);
  const re = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<\/\s*([a-zA-Z][^\s>]*)\s*>|<!--[\s\S]*?-->/g;
  let last = 0, m, n = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) stack[stack.length - 1].text += s.slice(last, m.index);
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[2] || ''), children: [], parent: stack[stack.length - 1], text: '', index: n++ };
      stack[stack.length - 1].children.push(node);
      if (tag === 'script' || tag === 'style' || tag === 'textarea') {
        const cre = new RegExp(`</\\s*${tag}\\s*>`, 'ig');
        cre.lastIndex = last;
        const cm = cre.exec(s);
        const end = cm ? cm.index : s.length;
        node.text = s.slice(last, end);
        last = cm ? cm.index + cm[0].length : s.length;
        re.lastIndex = last;
      } else if (!VOID.has(tag) && m[3] !== '/') stack.push(node);
    } else if (m[4]) {
      const tag = m[4].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
    }
  }
  if (last < s.length) stack[stack.length - 1].text += s.slice(last);
  const index = new Map();
  (function walk(el) { el.children.forEach((c) => { index.set(c.index, c); walk(c); }); })(root);
  return { root, index };
}

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

const html = await load(o._[0] || die('usage: node tools/microdata.js <url|file|->'));
const { root, index } = parseDoc(html);

const textOf = (el) => decode(el.text + el.children.map((c) => (c.tag === 'script' || c.tag === 'style' ? '' : c.text + textOf(c))).join(' ')).replace(/\s+/g, ' ').trim();
const all = (el, out = []) => { for (const c of el.children) { out.push(c); all(c, out); } return out; };
const elements = all(root);

const valueOf = (el) => {
  const a = el.attrs;
  if (a.content !== undefined) return a.content;
  if (a.datetime !== undefined) return a.datetime;
  if (a.href !== undefined) return a.href;
  if (a.src !== undefined) return a.src;
  if (a.value !== undefined) return a.value;
  if (a['data-value'] !== undefined) return a['data-value'];
  return textOf(el).slice(0, 400);
};

const microItems = [];
const itemFor = new Map();
for (const el of elements) {
  if (!(el.attrs.itemscope !== undefined)) continue;
  const item = {
    type: (el.attrs.itemtype || '').split('/').pop() || '(untyped)',
    itemtype: el.attrs.itemtype || null,
    id: el.attrs.itemid || null,
    props: {},
    source: 'microdata',
  };
  itemFor.set(el, item);
  microItems.push({ el, item });
}
for (const { el, item } of microItems) {
  const scoped = all(el);
  const consumed = new Set();
  for (const node of scoped) {
    if (consumed.has(node)) continue;
    const prop = node.attrs.itemprop;
    if (!prop) continue;
    const owner = (() => {
      let p = node.parent;
      while (p) { if (itemFor.get(p) === item) return true; p = p.parent; }
      return false;
    })();
    if (!owner) continue;
    const names = prop.trim().split(/\s+/);
    const nested = itemFor.get(node);
    const val = nested ? nested.props : valueOf(node);
    /* a nested itemscope owns its own subtree — never harvest those props for the parent */
    if (nested) for (const child of all(node)) if (child !== node) consumed.add(child);
    for (const nm of names) {
      if (item.props[nm] === undefined) item.props[nm] = val;
      else if (Array.isArray(item.props[nm])) item.props[nm].push(val);
      else item.props[nm] = [item.props[nm], val];
    }
  }
  for (const ref of (el.attrs.itemref || '').split(/\s+/).filter(Boolean)) {
    const target = elements.find((x) => x.attrs.id === ref);
    for (const node of target ? all(target) : []) {
      const prop = node.attrs.itemprop;
      if (!prop) continue;
      item.props[prop.split(/\s+/)[0]] = item.props[prop.split(/\s+/)[0]] ?? valueOf(node);
    }
  }
}

const rdfaItems = [];
for (const el of elements) {
  const typeofAttr = el.attrs.typeof;
  if (!typeofAttr) continue;
  const props = {};
  for (const node of [el, ...all(el)]) {
    const p = node.attrs.property;
    if (!p) continue;
    const nm = p.split(/\s+/)[0];
    if (props[nm] === undefined) props[nm] = valueOf(node);
  }
  rdfaItems.push({
    type: typeofAttr.split(/\s+/)[0].replace(/^schema:/, ''),
    vocab: el.attrs.vocab || null,
    id: el.attrs.about || el.attrs.resource || null,
    props,
    source: 'rdfa',
  });
}

const typeFilter = get(o, 'type', null);
let items = [...microItems.map((x) => x.item), ...rdfaItems];
if (typeFilter) items = items.filter((i) => i.type.toLowerCase().includes(String(typeFilter).toLowerCase()));

const flatRows = [];
for (const it of items) {
  for (const [k, v] of Object.entries(it.props)) {
    flatRows.push({ type: it.type, property: k, value: (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 60), source: it.source });
  }
}

const typeList = [...new Set(items.map((i) => i.type))].map((t) => ({ type: t, count: items.filter((i) => i.type === t).length }));

if (flag(o, 'json') || !flag(o, 'flat')) {
  console.log(JSON.stringify({ source: o._[0], itemCount: items.length, microdata: microItems.length, rdfa: rdfaItems.length, types: typeList, items }, null, 2));
} else {
  console.log(`${o._[0]} — ${microItems.length} microdata item(s), ${rdfaItems.length} RDFa item(s)\n`);
  console.log(table(typeList.map((t) => ({ type: t.type, count: t.count }))));
  console.log('');
  console.log(table(flatRows.slice(0, Math.max(1, num(get(o, 'limit'), 60)))));
}
