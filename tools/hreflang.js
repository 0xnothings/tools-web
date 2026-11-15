// hreflang.js — find hreflang/canonical/alternate tags and report SEO consistency.
// Copyright (c) 2026 0xnothings
// @tool hreflang
// @desc Audit hreflang, canonical and alternate link tags for consistency, reciprocity and validity
// @usage node tools/hreflang.js https://example.com --json
// @tags web,seo,i18n
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`hreflang — hreflang / canonical auditor

  node tools/hreflang.js <url|file|-> [options]

  --verify      fetch each hreflang target and check that it links back (slow, parallel)
  --concurrency <n>  parallel fetches when verifying (default 5)
  --json        machine-readable output
  -h, --help    this text

  Checks: valid language/region codes (ISO 639-1 / ISO 3166-1), x-default presence,
  absolute vs relative hrefs, self-reference, duplicate targets, canonical conflicts,
  and the alternate-format (RSS/JSON/AMP) links.`);
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0; +https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/hreflang.js <url|file|-> [--json]');

const VALID_LANG = new Set('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '));
const VALID_REGION = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url, status: res.status, headers: res.headers };
    } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
    finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t, status: null, headers: new Map() };
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

const page = await load(src);
const html = page.body;
const base = /^https?:\/\//i.test(page.final) ? page.final : null;

function absolutize(href) {
  if (!href) return null;
  if (!base) return href;
  try { return new URL(href, base).toString(); } catch { return href; }
}

const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
const alternates = links.filter((l) => /(^|\s)alternate(\s|$)/i.test(l.rel || ''));
const canonicals = links.filter((l) => /(^|\s)canonical(\s|$)/i.test(l.rel || ''));

const hreflang = alternates.filter((l) => l.hreflang).map((l) => {
  const code = String(l.hreflang).trim().toLowerCase();
  const target = absolutize(l.href);
  const parts = code.split('-');
  const langOk = code === 'x-default' ? true : VALID_LANG.has(parts[0]);
  const regionOk = parts.length < 2 ? true : VALID_REGION.has(parts[1].toUpperCase());
  const issues = [];
  if (!langOk) issues.push(`unknown language subtag "${parts[0]}"`);
  if (!regionOk) issues.push(`unknown region subtag "${parts[1]}"`);
  if (code !== 'x-default' && !/^[a-z]{2,3}(-[a-z]{2,3})?$/.test(code) && !/^[a-z]{2,3}-[A-Z]{2}$/.test(String(l.hreflang).trim())) issues.push('malformed code (expected ll or ll-CC)');
  if (!l.href) issues.push('missing href');
  if (l.href && !/^https?:\/\//i.test(l.href) && base) issues.push('relative href (should be absolute)');
  return { hreflang: String(l.hreflang).trim(), code, target, issues };
});

const targets = hreflang.map((h) => h.target).filter(Boolean);
const dupTargets = Object.entries(targets.reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {})).filter(([, n]) => n > 1).map(([t]) => t);
const selfRef = base ? hreflang.filter((h) => h.target && h.target.replace(/\/$/, '') === base.replace(/\/$/, '')) : [];
const canonical = canonicals[0] ? absolutize(canonicals[0].href) : null;
const canonicalConflicts = canonical ? hreflang.filter((h) => h.target && h.target === canonical).map((h) => h.hreflang) : [];
const xDefault = hreflang.find((h) => h.code === 'x-default');

const alternateFormats = alternates.filter((l) => !l.hreflang).map((l) => ({
  type: l.type || null, href: absolutize(l.href), title: l.title || null,
}));

const issues = [];
if (!hreflang.length) issues.push('no hreflang annotations found — fine for a single-language site, a problem for multi-region');
else {
  if (!xDefault) issues.push('no x-default hreflang — add one pointing at the language-selector or default page');
  if (!selfRef.length && base) issues.push('no self-referencing hreflang for the current URL — every cluster member must list itself');
  if (dupTargets.length) issues.push(`${dupTargets.length} target(s) used by more than one hreflang code`);
  if (canonicals.length > 1) issues.push(`${canonicals.length} canonical tags found — only one is allowed`);
  const withIssues = hreflang.filter((h) => h.issues.length);
  if (withIssues.length) issues.push(`${withIssues.length} hreflang entr(ies) have invalid codes or hrefs`);
}
if (!canonical) issues.push('no canonical link tag — search engines will pick one for you');
if (canonical && base && canonical.replace(/\/$/, '') !== base.replace(/\/$/, '')) issues.push('canonical points at a different URL than the page itself (check intentionality)');
if (canonicalConflicts.length) issues.push(`canonical URL is also declared as an hreflang target for: ${canonicalConflicts.join(', ')}`);

let verification = null;
if (flag(o, 'verify') && targets.length) {
  const conc = Math.max(1, Math.min(16, num(get(o, 'concurrency'), 5)));
  const unique = [...new Set(targets)];
  verification = [];
  for (let i = 0; i < unique.length; i += conc) {
    const batch = unique.slice(i, i + conc);
    const done = await Promise.all(batch.map(async (t) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' } });
        const body = await res.text();
        const back = [...body.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]))
          .filter((l) => /alternate/i.test(l.rel || '') && l.hreflang)
          .some((l) => absolutize(l.href)?.replace(/\/$/, '') === base?.replace(/\/$/, ''));
        return { url: t, status: res.status, finalUrl: res.url, linksBack: back };
      } catch (e) {
        return { url: t, status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
      } finally { clearTimeout(timer); }
    }));
    verification.push(...done);
  }
  const broken = verification.filter((v) => v.status === 0 || v.status >= 400);
  const oneWay = verification.filter((v) => v.status && v.status < 400 && !v.linksBack);
  if (broken.length) issues.push(`${broken.length} hreflang target(s) unreachable`);
  if (oneWay.length) issues.push(`${oneWay.length} hreflang target(s) do not link back to this page (cluster is one-way)`);
}

const report = {
  url: page.final,
  status: page.status,
  hreflangCount: hreflang.length,
  clusters: [...new Set(hreflang.map((h) => h.code))].length,
  canonical,
  canonicalCount: canonicals.length,
  xDefault: xDefault ? xDefault.target : null,
  selfReferencing: selfRef.length > 0,
  duplicateTargets: dupTargets,
  alternateFormats,
  entries: hreflang,
  verification,
  issues,
  verdict: issues.length === 0 ? 'clean' : issues.length <= 2 ? 'minor issues' : 'needs work',
};

if (flag(o, 'json')) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; } else {
console.log(`${page.final}${page.status ? `  [HTTP ${page.status}]` : ''}`);
console.log(`hreflang ${hreflang.length} · canonical ${canonical ? 'yes' : 'no'} · x-default ${xDefault ? 'yes' : 'no'} · self-ref ${selfRef.length ? 'yes' : 'no'} · verdict: ${report.verdict}\n`);

if (hreflang.length) {
  console.log(table(hreflang.map((h) => ({
    hreflang: h.hreflang,
    target: (h.target || '').replace(/^https?:\/\//, '').slice(0, 58),
    issues: h.issues.join('; ').slice(0, 40),
  }))));
}
if (canonicals.length) console.log(`\ncanonical: ${canonical}`);
if (alternateFormats.length) {
  console.log('\nother alternates:');
  console.log(table(alternateFormats.map((a) => ({ type: a.type || '—', href: (a.href || '').replace(/^https?:\/\//, '').slice(0, 60) }))));
}
if (verification) {
  console.log('\nVERIFICATION');
  console.log(table(verification.map((v) => ({ status: v.status || 'ERR', linksBack: v.linksBack ? 'yes' : 'no', url: (v.url || '').replace(/^https?:\/\//, '').slice(0, 58) }))));
}
console.log('\nISSUES');
console.log(issues.length ? issues.map((x) => '  - ' + x).join('\n') : '  none');
}
process.exitCode = 0;
