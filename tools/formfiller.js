// formfiller.js — generate a filled submission from a page's form definition.
// Copyright (c) 2026 0xnothings
// @tool formfiller
// @desc Read every <form> on a page, synthesise plausible values per input type, and print the ready-to-send request (curl, body, multipart)
// @usage node tools/formfiller.js https://example.com/contact --form 0
// @tags web,forms,testing
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`formfiller — build a filled form submission

  node tools/formfiller.js <url|file|-> [options]

  --form <n>      fill only form n (0-based); default: every form
  --only <names>  comma-separated field names to keep in the submission
  --skip <names>  comma-separated field names to drop (csrf, honeypot, ...)
  --json          machine-readable output
  -h, --help      this text

  Values are deterministic mocks chosen from the input type and field name.
  Nothing is sent — the tool prints the request you would send.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t };
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
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
  const root = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
  const stack = [root];
  const s = String(html);
  const re = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<\/\s*([a-zA-Z][^\s>]*)\s*>|<!--[\s\S]*?-->|<![^>]*>/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) stack[stack.length - 1].text += s.slice(last, m.index);
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[2] || ''), children: [], parent: stack[stack.length - 1], text: '' };
      stack[stack.length - 1].children.push(node);
      if (tag === 'script' || tag === 'style' || tag === 'textarea') {
        const closeRe = new RegExp(`</\\s*${tag}\\s*>`, 'ig');
        closeRe.lastIndex = last;
        const cm = closeRe.exec(s);
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
  return root;
}

function findAll(node, tag, out = []) {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

const MOCKS = {
  email: () => 'ava.lindqvist@example.com',
  password: () => 'Str0ng!Passw0rd#2026',
  tel: () => '+14155550142',
  number: () => '42',
  range: () => '50',
  date: () => '2026-11-15',
  'datetime-local': () => '2026-11-15T09:30',
  time: () => '09:30',
  month: () => '2026-11',
  week: () => '2026-W46',
  url: () => 'https://example.com/',
  search: () => 'wire protocol',
  color: () => '#1f6feb',
  file: () => '(binary — omit for urlencoded)',
  checkbox: () => 'on',
  radio: () => 'on',
  hidden: () => '1',
  submit: () => '',
  button: () => '',
  reset: () => '',
  text: () => 'Ada Lovelace',
  textarea: () => 'Written by the form filler. Collector plus relay, no drift.',
};

function mockFor(el) {
  const type = (el.attrs.type || (el.tag === 'textarea' ? 'textarea' : el.tag === 'select' ? 'select' : 'text')).toLowerCase();
  const nm = (el.attrs.name || el.attrs.id || '').toLowerCase();
  if (el.tag === 'select') {
    const opts = findAll(el, 'option').filter((x) => !x.attrs.disabled);
    const chosen = opts.find((x) => x.attrs.selected !== undefined) || opts[0];
    return chosen ? (chosen.attrs.value ?? (chosen.text || '').trim()) : '';
  }
  if (nm.includes('email') && type === 'text') return MOCKS.email();
  if (nm.includes('phone') || nm.includes('tel')) return MOCKS.tel();
  if (nm.includes('name') && type === 'text') return 'Ada Lovelace';
  if (nm.includes('company') || nm.includes('org')) return 'Cold Wire Labs';
  if (nm.includes('subject')) return 'Hello from the wire';
  if (nm.includes('message') || nm.includes('comment') || nm.includes('body')) return 'Written by the form filler. Collector plus relay, no drift.';
  if (nm.includes('zip') || nm.includes('postal')) return '94107';
  if (nm.includes('city')) return 'San Francisco';
  if (nm.includes('country')) return 'US';
  if (nm.includes('csrf') || nm.includes('token') || nm.includes('nonce')) return 'TOKEN_FROM_PAGE';
  const fn = MOCKS[type] || MOCKS.text;
  return fn();
}

const { body, final } = await load(o._[0] || die('usage: node tools/formfiller.js <url|file|->'));
const doc = parseDoc(body);

const base = (() => { try { return new globalThis.URL(final).href; } catch { return null; } })();
const forms = findAll(doc, 'form').map((f, i) => {
  const action = f.attrs.action || '';
  let abs = action || (base || final);
  if (base && action) { try { abs = new globalThis.URL(action, base).href; } catch { /* keep */ } }
  const method = (f.attrs.method || 'get').toUpperCase();
  const enctype = (f.attrs.enctype || 'application/x-www-form-urlencoded').toLowerCase();
  const fields = [];
  for (const el of findAll(f, 'input').concat(findAll(f, 'textarea'), findAll(f, 'select'))) {
    const type = (el.attrs.type || el.tag).toLowerCase();
    if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
    const key = el.attrs.name || el.attrs.id;
    if (!key) continue;
    fields.push({
      name: key,
      type,
      required: el.attrs.required !== undefined,
      value: el.attrs.value !== undefined && el.attrs.value !== '' ? el.attrs.value : mockFor(el),
    });
  }
  return { index: i, method, action: abs, enctype, id: f.attrs.id || null, className: f.attrs.class || null, fields };
});

if (!forms.length) die('no <form> found in input');

const keep = get(o, 'only', null) ? String(get(o, 'only')).split(',').map((s) => s.trim()) : null;
const drop = get(o, 'skip', null) ? String(get(o, 'skip')).split(',').map((s) => s.trim()) : [];
const pickArg = get(o, 'form', null);
const selected = pickArg === null ? forms : [forms[num(pickArg, 0)]].filter(Boolean);
if (!selected.length) die(`form ${pickArg} not found — page has ${forms.length}`);

const results = selected.map((f) => {
  const fields = f.fields.filter((x) => (keep ? keep.includes(x.name) : true) && !drop.includes(x.name));
  const enc = fields.map((x) => `${encodeURIComponent(x.name)}=${encodeURIComponent(x.value)}`).join('&');
  const url = f.method === 'GET' ? `${f.action}${f.action.includes('?') ? '&' : '?'}${enc}` : f.action;
  const contentType = f.enctype === 'multipart/form-data' ? 'multipart/form-data; boundary=----0xnothings' : (f.enctype === 'text/plain' ? 'text/plain' : 'application/x-www-form-urlencoded');
  const multipart = fields.map((x) => `------0xnothings\r\nContent-Disposition: form-data; name="${x.name}"\r\n\r\n${x.value}\r\n`).join('') + '------0xnothings--';
  const curl = `curl -X ${f.method} '${url}' \\\n  -H 'content-type: ${contentType}'` + (f.method === 'GET' ? '' : ` \\\n  --data-raw '${f.enctype === 'multipart/form-data' ? multipart : enc}'`);
  return { ...f, fields, encoded: enc, url, contentType, multipart, curl };
});

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: final, forms: results.map((r) => ({ index: r.index, method: r.method, action: r.action, enctype: r.enctype, fields: r.fields, url: r.url, body: r.encoded, curl: r.curl })) }, null, 2));
} else {
  console.log(`${final} — ${results.length} form(s) filled\n`);
  for (const r of results) {
    console.log(`form ${r.index}  ${r.method}  ${r.action}  (${r.enctype})`);
    console.log(table(r.fields.map((x) => ({ field: x.name.slice(0, 24), type: x.type, req: x.required ? 'yes' : '', value: String(x.value).slice(0, 40) }))));
    console.log('\n' + r.curl + '\n');
  }
  console.log('nothing was sent — this is the request body that would be sent');
}
