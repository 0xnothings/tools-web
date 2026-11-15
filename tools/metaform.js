#!/usr/bin/env node
// metaform.js — list forms on a page: action, method, fields, hidden inputs, CSRF token.
// Copyright (c) 2026 0xnothings
// @tool metaform
// @desc Inventory every <form> on a page with its fields, hidden inputs, CSRF token and submit-target hints
// @usage node tools/metaform.js https://example.com/login --json
// @tags web,scrape,recon
import { args, get, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`metaform — HTML form inventory

  node tools/metaform.js <url|file|-> [options]

  --index <n>    detail dump for a single form (0-based)
  --empty        also list forms with no fields
  --json         machine-readable output
  -h, --help     this text

  Per form: action, method, enctype, field names with types, required/disabled/
  readonly flags, select options, hidden inputs and a likely CSRF token detected
  by name pattern plus a random-looking value.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/metaform.js <url|file|-> [--json]');

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

const CSRF_NAMES = /^(csrf|_csrf|csrf_token|csrftoken|_token|authenticity_token|__requestverificationtoken|antiforgery|xsrf[-_]?token|nonce|__cf[_a-z]*token|form_token|_wpnonce|wp_nonce)$/i;
const looksRandom = (v) => typeof v === 'string' && v.length >= 16 && /^[A-Za-z0-9_\-.:+/=]+$/.test(v) && new Set(v).size > 8;

async function load(t, depth = 0) {
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
const html = page.body;
const base = /^https?:\/\//i.test(page.final) ? page.final : null;

const forms = [];
for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
  const a = attrs(m[1]);
  const body = m[2];
  const fields = [];
  const parseField = (tag, type) => {
    const fa = attrs(tag);
    const f = {
      name: fa.name ?? null,
      type,
      value: fa.value !== undefined ? decode(fa.value) : null,
      placeholder: fa.placeholder ? decode(fa.placeholder) : null,
      required: 'required' in fa,
      disabled: 'disabled' in fa,
      readonly: 'readonly' in fa,
      autocomplete: fa.autocomplete || null,
      pattern: fa.pattern || null,
      multiple: 'multiple' in fa,
      checked: 'checked' in fa,
      maxlength: fa.maxlength ? Number(fa.maxlength) : null,
      tag: tag.replace(/\s[\s\S]*$/, ''),
    };
    if (type === 'select') {
      f.options = [...tag.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((om) => {
        const oa = attrs(om[1]);
        return { value: oa.value !== undefined ? decode(oa.value) : decode(om[2]).trim(), text: decode(om[2]).trim(), selected: 'selected' in oa };
      });
    }
    if (type === 'textarea') f.rows = fa.rows ? Number(fa.rows) : null;
    if (type === 'file') f.accept = fa.accept || null;
    if (fa.id) f.id = fa.id;
    if (fa.name || f.id) fields.push(f);
  };

  for (const fm of body.matchAll(/<input\b[^>]*>/gi)) parseField(fm[0], (attrs(fm[0]).type || 'text').toLowerCase());
  for (const fm of body.matchAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi)) parseField(fm[0].split('>')[0] + '>', 'textarea');
  for (const fm of body.matchAll(/<select\b[\s\S]*?<\/select>/gi)) parseField(fm[0], 'select');
  for (const fm of body.matchAll(/<button\b[^>]*>/gi)) parseField(fm[0], 'submit');

  const passwordFields = fields.filter((f) => f.type === 'password');
  const hiddenFields = fields.filter((f) => f.type === 'hidden');

  const csrfCandidates = fields.filter((f) => {
    const tag = `${f.name || ''} ${f.id || ''}`;
    return (CSRF_NAMES.test(f.name || '') || CSRF_NAMES.test(f.id || '') || /token|nonce|xsrf/i.test(tag)) && looksRandom(f.value) && (f.value || '').length >= 16;
  });

  let action = a.action !== undefined ? decode(a.action).trim() : '';
  let resolvedAction = action;
  if (base) {
    try { resolvedAction = new URL(action || page.final, base).toString(); } catch { resolvedAction = action; }
  }

  const method = (a.method || 'GET').toUpperCase();
  forms.push({
    index: forms.length,
    id: a.id || null,
    name: a.name || null,
    action: action || '(self)',
    resolvedAction,
    method,
    enctype: a.enctype || 'application/x-www-form-urlencoded',
    target: a.target || null,
    autocomplete: a.autocomplete || null,
    hasFileUpload: fields.some((f) => f.type === 'file'),
    fieldCount: fields.length,
    visibleFields: fields.length - hiddenFields.length,
    hiddenCount: hiddenFields.length,
    isLogin: passwordFields.length > 0,
    isSearch: fields.some((f) => f.type === 'search' || /^(q|query|s|search|term)$/i.test(f.name || '')) && fields.length <= 4,
    hasCsrfToken: csrfCandidates.length > 0,
    csrf: csrfCandidates.map((f) => ({ name: f.name || f.id, length: (f.value || '').length, sample: (f.value || '').slice(0, 24) + '…' })),
    fields,
  });
}

const shown = flag(o, 'empty') ? forms : forms.filter((f) => f.fieldCount > 0);
const indexArg = get(o, 'index', null);

if (flag(o, 'json')) {
  const payload = indexArg !== null && indexArg !== true
    ? { source: page.final, form: forms[numOr(indexArg, 0)] || null }
    : { source: page.final, formCount: forms.length, forms: (shown.length ? shown : forms) };
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = 0;
} else {
  function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  const list = shown.length ? shown : forms;
  if (indexArg !== null && indexArg !== true) {
    const f = forms[numOr(indexArg, 0)];
    if (!f) die(`form ${indexArg} not found — page has ${forms.length} form(s)`);
    console.log(`form ${f.index}  ${f.method} ${f.resolvedAction}`);
    console.log(`enctype: ${f.enctype}${f.isLogin ? '   LOGIN FORM' : ''}${f.hasCsrfToken ? '   CSRF token present' : ''}\n`);
    console.log(table(f.fields.map((x) => ({
      name: x.name || x.id || '',
      type: x.type,
      required: x.required ? 'yes' : '',
      value: (x.value === null ? '' : String(x.value)).slice(0, 26),
      extra: [x.placeholder, x.pattern, x.accept, x.maxlength ? `maxlength=${x.maxlength}` : null, x.options ? `${x.options.length} options` : null].filter(Boolean).join(' ').slice(0, 30),
    }))));
  } else {
    console.log(`${page.final} — ${forms.length} form(s)\n`);
    console.log(table(list.map((f) => ({
      '#': f.index,
      method: f.method,
      fields: f.fieldCount,
      hidden: f.hiddenCount,
      kind: f.isLogin ? 'login' : f.isSearch ? 'search' : f.hasFileUpload ? 'upload' : 'form',
      csrf: f.hasCsrfToken ? 'yes' : '',
      action: f.resolvedAction.replace(/^https?:\/\//, '').slice(0, 52),
    }))));
    if (list.length < forms.length) console.log(`\n${forms.length - list.length} empty form(s) hidden — use --empty`);
    console.log('\n--index <n> for the field dump');
  }
  process.exitCode = 0;
}
