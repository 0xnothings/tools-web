#!/usr/bin/env node
// htmlvalid.js — heuristic HTML lint.
// Copyright (c) 2026 0xnothings
// @tool htmlvalid
// @desc Lint HTML for unclosed tags, duplicate ids, missing alt, inline handlers and other inline-fixable defects
// @usage node tools/htmlvalid.js https://example.com --json
// @tags web,qa,lint
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`htmlvalid — heuristic HTML linter

  node tools/htmlvalid.js <url|file|-> [options]

  --max <n>       report at most n issues per rule (default 8)
  --rules         list every rule with its severity
  --warn-only     exit 0 even when errors are found
  --json          machine-readable output
  -h, --help      this text

  Rules: unclosed/ mismatched tags, duplicate ids, images without alt, inputs without
  labels, inline event handlers, deprecated attributes, missing lang, missing doctype,
  empty links/buttons, target=_blank without rel=noopener, and tabindex > 0.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/htmlvalid.js <url|file|-> [--json]');

const RULES = [
  { id: 'doctype', severity: 'error', desc: 'missing or non-HTML5 doctype' },
  { id: 'lang', severity: 'error', desc: '<html> has no lang attribute' },
  { id: 'unclosed-tag', severity: 'error', desc: 'a tag is never closed' },
  { id: 'mismatched-tag', severity: 'error', desc: 'a closing tag does not match the open tag' },
  { id: 'duplicate-id', severity: 'error', desc: 'the same id appears more than once' },
  { id: 'img-alt', severity: 'error', desc: '<img> without alt' },
  { id: 'inline-handler', severity: 'warn', desc: 'on* attribute instead of addEventListener' },
  { id: 'input-label', severity: 'warn', desc: 'input without a label or aria-label' },
  { id: 'empty-link', severity: 'warn', desc: 'anchor with no text and no aria-label' },
  { id: 'target-blank', severity: 'warn', desc: 'target="_blank" without rel=noopener' },
  { id: 'deprecated-attr', severity: 'warn', desc: 'deprecated presentational attribute' },
  { id: 'tabindex-positive', severity: 'warn', desc: 'tabindex greater than zero breaks tab order' },
  { id: 'duplicate-attr', severity: 'warn', desc: 'the same attribute appears twice on one element' },
  { id: 'title-length', severity: 'info', desc: '<title> longer than 60 or empty' },
  { id: 'heading-order', severity: 'info', desc: 'heading levels skip (h1 → h3)' },
  { id: 'nested-interactive', severity: 'info', desc: 'a link nested inside a link or button' },
  { id: 'viewport', severity: 'info', desc: 'no responsive viewport meta' },
  { id: 'charset', severity: 'info', desc: 'no charset declared in the first 1024 bytes' },
];

if (flag(o, 'rules')) {
  if (flag(o, 'json')) console.log(JSON.stringify({ rules: RULES }, null, 2));
  else console.log(table(RULES.map((r) => ({ rule: r.id, severity: r.severity, description: r.desc }))));
  process.exitCode = 0;
} else {

const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const OPTIONAL_CLOSE = new Set('li p td th tr option dt dd thead tbody tfoot colgroup'.split(' '));
const DEPRECATED_ATTRS = ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'valign', 'nowrap', 'hspace', 'vspace', 'frameborder', 'marginwidth', 'marginheight'];

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
const html = page.body;
const issues = [];
const push = (rule, severity, message, detail = {}) => issues.push({ rule, severity, message, ...detail });

/* --- tag pairing --- */
const tags = [];
for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
  tags.push({ name: m[1].toLowerCase(), attrsRaw: m[2] || '', tag: m[0], at: m.index, closing: false });
}
for (const m of html.matchAll(/<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g)) {
  tags.push({ name: m[1].toLowerCase(), attrsRaw: '', tag: m[0], at: m.index, closing: true });
}
tags.sort((a, b) => a.at - b.at);

const stack = [];
for (const t of tags) {
  if (VOID.has(t.name) || /\/$/.test(t.tag)) continue;
  if (!t.closing) {
    /* implicit close for optional-close tags */
    const top = stack[stack.length - 1];
    if (top && OPTIONAL_CLOSE.has(top.name) && (t.name === top.name || /^(p|li|td|th|tr)$/.test(t.name))) stack.pop();
    stack.push(t);
  } else {
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === t.name) { idx = i; break; }
    if (idx === -1) {
      if (!VOID.has(t.name)) push('mismatched-tag', 'error', `</${t.name}> has no matching opening tag`, { position: t.at, snippet: t.tag });
    } else {
      for (let i = stack.length - 1; i > idx; i--) push('unclosed-tag', 'error', `<${stack[i].name}> is never closed`, { position: stack[i].at, snippet: stack[i].tag.slice(0, 80) });
      stack.length = idx;
    }
  }
}
for (const t of stack) if (!OPTIONAL_CLOSE.has(t.name)) push('unclosed-tag', 'error', `<${t.name}> is never closed`, { position: t.at, snippet: t.tag.slice(0, 80) });

/* --- structure --- */
if (!/^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+html/i.test(html)) push('doctype', 'error', 'the document does not start with <!DOCTYPE html>');
const htmlTag = html.match(/<html\b([^>]*)>/i);
if (!htmlTag) push('lang', 'error', 'no <html> element found');
else if (!/\blang\s*=/i.test(htmlTag[1])) push('lang', 'error', '<html> has no lang attribute — screen readers cannot pick a voice');
if (!/<meta[^>]+charset/i.test(html.slice(0, 2048))) push('charset', 'info', 'no charset declared in the first 2KB');
if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) push('viewport', 'info', 'no responsive viewport meta tag');

/* --- ids and attributes --- */
const ids = new Map();
for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
  const raw = m[2] || '';
  const name = m[1].toLowerCase();
  const attrPairs = [...raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)];
  const attrMap = {};
  const dupAttrs = [];
  for (const a of attrPairs) {
    const k = a[1].toLowerCase();
    if (attrMap[k] !== undefined) dupAttrs.push(k);
    attrMap[k] = a[2] ?? a[3] ?? a[4] ?? '';
  }
  if (attrMap.id) {
    if (ids.has(attrMap.id)) push('duplicate-id', 'error', `duplicate id "${attrMap.id}"`, { position: m.index, snippet: m[0].slice(0, 70) });
    else ids.set(attrMap.id, m.index);
  }
  if (dupAttrs.length) push('duplicate-attr', 'warn', `duplicate attribute(s) on <${name}>: ${[...new Set(dupAttrs)].join(', ')}`, { position: m.index, snippet: m[0].slice(0, 70) });

  if (name === 'img') {
    const altPresent = 'alt' in attrMap;
    const ariaHide = attrMap['aria-hidden'] === 'true' || attrMap.role === 'presentation' || attrMap.role === 'none';
    if (!altPresent && !ariaHide) push('img-alt', 'error', '<img> has no alt attribute', { position: m.index, snippet: m[0].slice(0, 90) });
  }
  if (name === 'a') {
    if (attrMap.target === '_blank') {
      const rel = (attrMap.rel || '').toLowerCase();
      if (!/noopener|noreferrer/.test(rel)) push('target-blank', 'warn', 'target="_blank" without rel="noopener"', { position: m.index, snippet: m[0].slice(0, 70) });
    }
    if (attrMap.href === '' && !attrMap['aria-label'] && !attrMap.title) push('empty-link', 'warn', 'anchor with an empty href and no accessible name', { position: m.index, snippet: m[0].slice(0, 70) });
  }
  if (name === 'input' || name === 'select' || name === 'textarea') {
    const labelled = attrMap.id && new RegExp(`<label[^>]+for\\s*=\\s*["']${attrMap.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(html);
    const hidden = ['hidden', 'submit', 'button', 'reset', 'image'].includes(attrMap.type || (name === 'input' ? 'text' : ''));
    if (!labelled && !attrMap['aria-label'] && !attrMap['aria-labelledby'] && !attrMap.title && !attrMap.placeholder && !hidden && !attrMap['aria-hidden']) {
      push('input-label', 'warn', `<${name}>${attrMap.name ? ` name="${attrMap.name}"` : ''} has no label`, { position: m.index, snippet: m[0].slice(0, 70) });
    }
  }
  for (const a of Object.keys(attrMap)) {
    if (/^on[a-z]+$/.test(a) && !['on'].includes(a)) push('inline-handler', 'warn', `inline handler ${a} on <${name}>`, { position: m.index, snippet: m[0].slice(0, 70) });
    if (DEPRECATED_ATTRS.includes(a) && name !== 'input' && name !== 'table' && name !== 'iframe') push('deprecated-attr', 'warn', `deprecated attribute ${a} on <${name}>`, { position: m.index, snippet: m[0].slice(0, 70) });
  }
  if (attrMap.tabindex !== undefined && Number(attrMap.tabindex) > 0) push('tabindex-positive', 'warn', `tabindex="${attrMap.tabindex}" on <${name}> — positive values break natural tab order`, { position: m.index, snippet: m[0].slice(0, 70) });
}

/* --- title / headings / nesting --- */
const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
if (titleMatch) {
  const t = titleMatch[1].trim();
  if (!t) push('title-length', 'info', '<title> is empty');
  else if (t.length > 60) push('title-length', 'info', `<title> is ${t.length} characters (over 60 — search results will truncate it)`);
}
const headingLevels = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]));
for (let i = 1; i < headingLevels.length; i++) {
  if (headingLevels[i] - headingLevels[i - 1] > 1) {
    push('heading-order', 'info', `heading level jumps h${headingLevels[i - 1]} → h${headingLevels[i]}`);
    break;
  }
}
if (/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/i.test(html)) push('nested-interactive', 'info', 'an <a> is nested inside another <a>');

/* --- group and cap --- */
const maxPerRule = Math.max(1, num(get(o, 'max'), 8));
const grouped = {};
for (const i of issues) {
  grouped[i.rule] = grouped[i.rule] || { rule: i.rule, severity: i.severity, count: 0, samples: [] };
  grouped[i.rule].count++;
  if (grouped[i.rule].samples.length < maxPerRule) grouped[i.rule].samples.push(i);
}
const byRule = Object.values(grouped).sort((a, b) => {
  const order = { error: 0, warn: 1, info: 2 };
  return order[a.severity] - order[b.severity] || b.count - a.count;
});
const errors = issues.filter((i) => i.severity === 'error').length;
const warns = issues.filter((i) => i.severity === 'warn').length;
const infos = issues.filter((i) => i.severity === 'info').length;

const verdict = errors ? 'fails' : warns ? 'warns' : 'passes';

if (flag(o, 'json')) {
  console.log(JSON.stringify({
    url: page.final, bytes: html.length, elements: tags.length,
    errors, warnings: warns, info: infos, verdict,
    rules: byRule, issues: issues.slice(0, 300),
  }, null, 2));
} else {
  console.log(`${page.final} — ${html.length} bytes, ${tags.length} tags`);
  console.log(`${errors} error(s) · ${warns} warning(s) · ${infos} info — verdict: ${verdict}\n`);
  if (!issues.length) console.log('nothing flagged. Heuristic lint only — validate against the W3C checker for full conformance.');
  else {
    console.log(table(byRule.map((g) => ({
      severity: g.severity,
      rule: g.rule,
      count: g.count,
      sample: (g.samples[0]?.message || '').slice(0, 56),
    }))));
    console.log('');
    for (const g of byRule.filter((x) => x.severity !== 'info')) {
      console.log(`${g.rule} (${g.count})`);
      for (const s of g.samples) console.log(`  ${s.message}${s.snippet ? `\n    ${s.snippet.replace(/\s+/g, ' ')}` : ''}`);
    }
  }
}
process.exitCode = flag(o, 'warn-only') ? 0 : (errors ? 1 : 0);
}
