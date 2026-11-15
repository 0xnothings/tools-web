#!/usr/bin/env node
// jsonld.js — extract and validate schema.org JSON-LD blocks from a page.
// Copyright (c) 2026 0xnothings
// @tool jsonld
// @desc Pull every JSON-LD block off a page, validate its shape and summarise the schema.org graph
// @usage node tools/jsonld.js https://example.com --json
// @tags web,seo,structured-data
import { args, get, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`jsonld — schema.org structured data extractor

  node tools/jsonld.js <url|file|-> [options]

  --type <t>     only show nodes of this @type (e.g. Product, Article, FAQPage)
  --raw          print the parsed JSON instead of a table
  --json         machine-readable output
  -h, --help     this text

  Validates: JSON syntax per block, presence of @context/@type, required fields for
  the common types (Product needs name+offers, Article needs headline+author,
  BreadcrumbList needs itemListElement), and flags unknown/missing types.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/jsonld.js <url|file|-> [--json]');

const REQUIRED = {
  Product: ['name'],
  ProductGroup: ['name'],
  Article: ['headline', 'author'],
  NewsArticle: ['headline', 'author'],
  BlogPosting: ['headline', 'author'],
  TechArticle: ['headline', 'author'],
  Recipe: ['name', 'recipeIngredient', 'recipeInstructions'],
  Event: ['name', 'startDate', 'location'],
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  Person: ['name'],
  WebSite: ['url'],
  WebPage: ['url'],
  BreadcrumbList: ['itemListElement'],
  FAQPage: ['mainEntity'],
  HowTo: ['name', 'step'],
  VideoObject: ['name', 'uploadDate', 'thumbnailUrl'],
  JobPosting: ['title', 'datePosted', 'hiringOrganization'],
  Course: ['name', 'provider'],
  SoftwareApplication: ['name', 'applicationCategory'],
  Review: ['itemReviewed', 'reviewRating'],
  AggregateRating: ['ratingValue', 'reviewCount'],
  ItemList: ['itemListElement'],
  Offer: ['price', 'priceCurrency'],
  Product2: [],
};
const RECOMMENDED = {
  Product: ['image', 'description', 'sku', 'brand', 'aggregateRating'],
  Article: ['datePublished', 'dateModified', 'image', 'publisher'],
  BlogPosting: ['datePublished', 'dateModified', 'image'],
  Organization: ['logo', 'sameAs'],
  FAQPage: [],
  BreadcrumbList: [],
  Recipe: ['image', 'author', 'datePublished'],
  Event: ['endDate', 'offers', 'image', 'description'],
};

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url, status: res.status };
    } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t, status: null };
}

const page = await load(src);
const blocks = [];
for (const m of page.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrsRaw = m[1] || '';
  if (!/application\/ld\+json/i.test(attrsRaw)) continue;
  const id = (attrsRaw.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || null;
  const text = m[2].trim();
  if (!text) { blocks.push({ index: blocks.length, id, ok: false, error: 'empty script body', nodes: [] }); continue; }
  try {
    const parsed = JSON.parse(text.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ''));
    blocks.push({ index: blocks.length, id, ok: true, parsed });
  } catch (e) {
    blocks.push({ index: blocks.length, id, ok: false, error: e.message.slice(0, 120), preview: text.slice(0, 100), nodes: [] });
  }
}

function flatten(value, out = [], ctxType = null) {
  if (Array.isArray(value)) { for (const v of value) flatten(v, out, ctxType); return out; }
  if (value && typeof value === 'object') {
    const graph = value['@graph'];
    if (Array.isArray(graph)) { for (const g of graph) flatten(g, out, value['@context'] || ctxType); }
    if (value['@type'] || value.name || value.headline) out.push({ node: value, context: value['@context'] || ctxType });
    for (const [k, v] of Object.entries(value)) {
      if (k === '@graph') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (v['@type'] && k !== 'author' && k !== 'publisher' && k !== 'brand' && k !== 'provider') flatten(v, out, value['@context'] || ctxType);
      }
    }
  }
  return out;
}

const nodes = [];
for (const b of blocks) {
  if (!b.ok) continue;
  const found = flatten(b.parsed);
  for (const f of found) {
    const types = [].concat(f.node['@type'] || []).filter(Boolean);
    nodes.push({
      block: b.index,
      types,
      primaryType: types[0] || '(no @type)',
      context: typeof f.context === 'string' ? f.context : Array.isArray(f.context) ? f.context.join(',') : f.context && typeof f.context === 'object' ? Object.keys(f.context).join(',') : null,
      name: f.node.name || f.node.headline || f.node.title || null,
      id: f.node['@id'] || null,
      node: f.node,
    });
  }
}

const withValidation = nodes.map((n) => {
  const issues = [];
  const warnings = [];
  if (!n.types.length) issues.push('missing @type');
  if (!n.context) warnings.push('missing @context');
  else if (typeof n.context === 'string' && !/schema\.org/.test(n.context)) warnings.push(`@context is not schema.org (${n.context})`);
  for (const t of n.types) {
    const req = REQUIRED[t];
    if (!req) { warnings.push(`@type "${t}" is not in the validator table`); continue; }
    for (const field of req) if (n.node[field] === undefined || n.node[field] === null || n.node[field] === '') issues.push(`${t} is missing required "${field}"`);
    if (t === 'Product' && !n.node.offers) warnings.push('Product has no offers (Google requires offers or review/aggregateRating)');
    if (t === 'FAQPage' && Array.isArray(n.node.mainEntity)) {
      for (const q of n.node.mainEntity) {
        if (!q.name) issues.push('FAQPage question missing name');
        if (!q.acceptedAnswer?.text) issues.push(`FAQPage question "${String(q.name).slice(0, 30)}" missing acceptedAnswer.text`);
      }
    }
    if (t === 'BreadcrumbList' && Array.isArray(n.node.itemListElement)) {
      n.node.itemListElement.forEach((el, i) => {
        if (!el.position) warnings.push(`breadcrumb item ${i} has no position`);
        if (!el.name && !el.item) issues.push(`breadcrumb item ${i} has neither name nor item`);
      });
    }
  }
  return { ...n, issues, warnings, valid: issues.length === 0 };
});

const typeFilter = get(o, 'type', null);
const shown = typeFilter && typeFilter !== true
  ? withValidation.filter((n) => n.types.some((t) => String(t).toLowerCase() === String(typeFilter).toLowerCase()))
  : withValidation;

const typeCounts = withValidation.reduce((a, n) => { for (const t of n.types) a[t] = (a[t] || 0) + 1; return a; }, {});
const report = {
  url: page.final,
  status: page.status,
  scriptBlocks: blocks.length,
  parsedBlocks: blocks.filter((b) => b.ok).length,
  failedBlocks: blocks.filter((b) => !b.ok).length,
  nodes: withValidation.length,
  shown: shown.length,
  typeCounts,
  invalidNodes: withValidation.filter((n) => !n.valid).length,
  blocks: blocks.map((b) => ({ index: b.index, id: b.id, ok: b.ok, error: b.error || null, preview: b.preview || null })),
  items: shown.map((n) => ({ block: n.block, types: n.types, primaryType: n.primaryType, context: n.context, name: n.name, id: n.id, valid: n.valid, issues: n.issues, warnings: n.warnings, node: flag(o, 'raw') || flag(o, 'json') ? n.node : undefined })),
};

if (flag(o, 'json')) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; } else if (flag(o, 'raw')) {
  console.log(JSON.stringify(shown.map((n) => n.node), null, 2));
  process.exitCode = 0;
} else {
  console.log(`${page.final}${page.status ? `  [HTTP ${page.status}]` : ''}`);
  console.log(`${blocks.length} JSON-LD block(s) · ${report.parsedBlocks} parsed · ${withValidation.length} node(s) · ${report.invalidNodes} with issues\n`);
  if (!shown.length) {
    console.log(typeFilter ? `no node of type "${typeFilter}"` : 'no JSON-LD structured data found on this page');
    if (report.failedBlocks) {
      console.log('\nFAILED BLOCKS');
      for (const b of blocks.filter((x) => !x.ok)) console.log(`  block ${b.index}: ${b.error}\n    ${b.preview}`);
    }
  } else {
    console.log(table(shown.map((n) => ({
      '#': n.block,
      type: n.primaryType.slice(0, 22),
      name: String(n.name || '—').slice(0, 42),
      valid: n.valid ? 'yes' : 'NO',
      issues: n.issues.length ? n.issues[0].slice(0, 40) : '',
    }))));
    const problems = shown.filter((n) => n.issues.length || n.warnings.length);
    if (problems.length) {
      console.log('\nISSUES');
      for (const n of problems) {
        for (const i of n.issues) console.log(`  [${n.primaryType}] ${i}`);
        for (const w of n.warnings.slice(0, 3)) console.log(`  [${n.primaryType}] warn: ${w}`);
      }
    }
    if (report.failedBlocks) {
      console.log('\nFAILED BLOCKS');
      for (const b of blocks.filter((x) => !x.ok)) console.log(`  block ${b.index}: ${b.error}`);
    }
    console.log(`\ntypes found: ${Object.entries(typeCounts).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }
  process.exitCode = 0;
}
