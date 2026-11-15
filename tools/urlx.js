// urlx.js — URL toolkit: parse, normalize, strip tracking, resolve, compare, build.
// Copyright (c) 2026 0xnothings
// @tool urlx
// @desc Parse, normalize, de-track, resolve and diff URLs with a query-string builder
// @usage node tools/urlx.js "https://Example.COM/a/../b?utm_source=x&id=7#frag" --clean --json
// @tags web,parse,url
import { args, get, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`urlx — URL swiss-army knife

  node tools/urlx.js <url> [url2] [options]

  Operations (pick one, default: parse):
    --parse        full breakdown of every component (default)
    --clean        normalized URL with tracking params stripped
    --resolve      resolve a relative URL against a base: urlx.js <base> --with <rel>
    --compare      structural diff between two URLs
    --set k=v      add/replace a query param (repeatable)
    --del k        remove a query param (repeatable)
    --keep <list>  comma list of query params to keep when cleaning
    --json         machine-readable output
    -h, --help     this text

  Tracking params removed by --clean: utm_*, gclid, fbclid, msclkid, mc_eid, igshid,
  yclid, _hsenc, _hsmi, ref, ref_src, s_cid, spm, scm, xtor, pk_campaign, pk_kwd.`);
  process.exit(0);
}

const TRACKING = new Set([
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'yclid', '_hsenc', '_hsmi',
  'ref', 'ref_src', 'ref_url', 's_cid', 'spm', 'scm', 'xtor', 'pk_campaign', 'pk_kwd',
  'pk_source', 'pk_medium', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
  'wickedid', 'twclid', 'ttclid', 'li_fat_id', 'trk', 'trkCampaign', 'sc_cid',
  'mkt_tok', 'elqTrackId', 'elqTrack', 'assetType', 'assetId', 'campaignId', '_ga', '_gl',
]);
const isTracking = (k) => TRACKING.has(k) || /^utm_/i.test(k) || /^hsa_/i.test(k) || /^pk_/i.test(k) || /^mtm_/i.test(k);

function parseUrl(raw, base) {
  try { return base ? new URL(String(raw), base) : new URL(String(raw)); }
  catch (e) { die(`invalid url: ${raw}${base ? ` (base ${base})` : ''} — ${e.message}`); }
}

function clean(u, keepSet) {
  const c = new URL(u.toString());
  c.hash = '';
  const drop = [];
  for (const k of [...c.searchParams.keys()]) {
    if (keepSet && keepSet.size) { if (!keepSet.has(k)) drop.push(k); continue; }
    if (isTracking(k)) drop.push(k);
  }
  for (const k of drop) c.searchParams.delete(k);
  c.hostname = c.hostname.toLowerCase().replace(/^www\./, '');
  if (c.pathname.length > 1 && c.pathname.endsWith('/')) c.pathname = c.pathname.replace(/\/+$/, '');
  c.protocol = c.protocol === 'http:' && !u.port ? 'https:' : c.protocol;
  c.searchParams.sort();
  return c.toString();
}

function describe(u) {
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = q[k] === undefined ? v : [].concat(q[k], v);
  const parts = u.pathname.split('/').filter(Boolean);
  return {
    href: u.href,
    protocol: u.protocol.replace(':', ''),
    scheme: u.protocol.replace(':', ''),
    username: u.username || null,
    password: u.password ? '***' : null,
    host: u.host,
    hostname: u.hostname,
    port: u.port || null,
    defaultPort: u.port === '' ,
    pathname: u.pathname,
    segments: parts,
    segmentCount: parts.length,
    extension: (u.pathname.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || null,
    search: u.search || null,
    query: q,
    queryCount: Object.keys(q).length,
    hash: u.hash ? u.hash.slice(1) : null,
    origin: u.origin,
    isAbsolute: Boolean(u.protocol && u.host),
    isSecure: u.protocol === 'https:',
    hasCredentials: Boolean(u.username || u.password),
    isIpLiteral: /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':'),
    isLocalhost: /^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname),
    trackingParams: [...u.searchParams.keys()].filter(isTracking),
  };
}

const opCompare = flag(o, 'compare');
const opClean = flag(o, 'clean');
const opResolve = flag(o, 'resolve');

const first = o._[0];
if (!first) die('usage: node tools/urlx.js <url> [url2] [--clean|--compare|--resolve] [--json]');

if (opResolve) {
  const withRel = get(o, 'with', o._[1]);
  if (!withRel || withRel === true) die('--resolve needs --with <relative-url>');
  const u = parseUrl(String(withRel), first);
  if (flag(o, 'json')) console.log(JSON.stringify({ base: first, relative: String(withRel), resolved: u.toString(), ...describe(u) }, null, 2));
  else { console.log(u.toString()); }
  process.exitCode = 0;
} else if (opCompare) {
  const second = o._[1];
  if (!second) die('--compare needs a second URL');
  const a = parseUrl(first), b = parseUrl(second);
  const da = describe(a), db = describe(b);
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])];
  const diff = keys
    .filter((k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]))
    .map((k) => ({ field: k, a: JSON.stringify(da[k]), b: JSON.stringify(db[k]) }));
  const qKeys = [...new Set([...Object.keys(da.query), ...Object.keys(db.query)])]
    .filter((k) => JSON.stringify(da.query[k]) !== JSON.stringify(db.query[k]))
    .map((k) => ({ param: k, a: JSON.stringify(da.query[k] ?? null), b: JSON.stringify(db.query[k] ?? null) }));
  const sameClean = clean(a) === clean(b);
  if (flag(o, 'json')) {
    console.log(JSON.stringify({ a: a.toString(), b: b.toString(), equal: sameClean, structurallyEqual: diff.length === 0, differences: diff, queryDifferences: qKeys }, null, 2));
  } else {
    console.log(`A: ${a.toString()}\nB: ${b.toString()}\n`);
    console.log(`equal after cleaning: ${sameClean ? 'yes' : 'no'}`);
    if (!diff.length) console.log('structurally identical');
    else { console.log(''); console.log(table(diff.map((d) => ({ field: d.field, a: d.a.slice(0, 40), b: d.b.slice(0, 40) })))); }
    if (qKeys.length) { console.log('\nquery diff:'); console.log(table(qKeys)); }
  }
  process.exitCode = 0;
} else {
  const u = parseUrl(first);
  const setPairs = [].concat(o.f.set || []).filter((s) => s !== true).map((s) => {
    const i = String(s).indexOf('=');
    return i > 0 ? [String(s).slice(0, i), String(s).slice(i + 1)] : [String(s), ''];
  });
  const delKeys = [].concat(o.f.del || []).filter((s) => s !== true).map(String);
  const keepRaw = get(o, 'keep', null);
  const keepSet = keepRaw && keepRaw !== true ? new Set(String(keepRaw).split(',').map((s) => s.trim()).filter(Boolean)) : null;

  let modified = u;
  if (setPairs.length || delKeys.length || keepSet) {
    const m = new URL(u.toString());
    for (const [k, v] of setPairs) m.searchParams.set(k, v);
    for (const k of delKeys) m.searchParams.delete(k);
    if (keepSet) for (const k of [...m.searchParams.keys()]) if (!keepSet.has(k)) m.searchParams.delete(k);
    modified = m;
  }
  const d = describe(modified);
  const cleanedUrl = clean(modified, keepSet);

  if (flag(o, 'json')) {
    console.log(JSON.stringify({ ...d, cleaned: cleanedUrl, normalized: modified.toString() }, null, 2));
  } else if (opClean) {
    console.log(cleanedUrl);
  } else {
    console.log(table([
      { field: 'href', value: d.href.slice(0, 80) },
      { field: 'origin', value: d.origin },
      { field: 'scheme', value: d.scheme },
      { field: 'host', value: d.host },
      { field: 'hostname', value: d.hostname },
      { field: 'port', value: d.port || '(default)' },
      { field: 'path', value: d.pathname },
      { field: 'segments', value: d.segmentCount },
      { field: 'extension', value: d.extension || '—' },
      { field: 'query params', value: d.queryCount },
      { field: 'hash', value: d.hash || '—' },
      { field: 'secure', value: d.isSecure ? 'yes' : 'no' },
      { field: 'localhost', value: d.isLocalhost ? 'yes' : 'no' },
      { field: 'ip literal', value: d.isIpLiteral ? 'yes' : 'no' },
      { field: 'tracking', value: d.trackingParams.length ? d.trackingParams.join(', ') : 'none' },
    ]));
    if (d.queryCount) { console.log('\nquery:'); console.log(table(Object.entries(d.query).map(([k, v]) => ({ key: k, value: JSON.stringify(v), tracking: isTracking(k) ? 'yes' : '' })))); }
    console.log(`\ncleaned: ${cleanedUrl}`);
  }
  process.exitCode = 0;
}
