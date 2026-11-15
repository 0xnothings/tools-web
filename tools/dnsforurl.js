// dnsforurl.js — resolve a URL's host through DNS and report CDN/hosting hints.
// Copyright (c) 2026 0xnothings
// @tool dnsforurl
// @desc Resolve a URL host over DNS (A/AAAA/CNAME/NS/MX/TXT) and infer the CDN or hosting provider
// @usage node tools/dnsforurl.js https://example.com --json
// @tags web,dns,recon
import { args, get, flag, die, table } from '../_lib.js';
import { Resolver } from 'node:dns/promises';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`dnsforurl — DNS + hosting fingerprint

  node tools/dnsforurl.js <url|host>... [options]

  --all        query every record type (A, AAAA, CNAME, NS, MX, TXT, SOA, CAA)
  --server <ip>  use this DNS resolver instead of the system default
  --json       machine-readable output
  -h, --help   this text

  Resolves the host, follows the CNAME chain, then matches the answers against a
  table of CDN/host ASN names to say who is actually serving the traffic.`);
  process.exit(0);
}

const CDN_HINTS = [
  { re: /cloudflare/i, provider: 'Cloudflare', kind: 'CDN + WAF', note: 'origin IP is hidden behind the proxy' },
  { re: /cloudfront|amazonaws/i, provider: 'Amazon CloudFront / AWS', kind: 'CDN', note: 'AWS-hosted' },
  { re: /fastly|fastlylb/i, provider: 'Fastly', kind: 'CDN', note: 'Fastly edge' },
  { re: /akamai|akamaiedge|akamaihd|edgekey|edgesuite/i, provider: 'Akamai', kind: 'CDN', note: 'Akamai edge network' },
  { re: /azure|azureedge|trafficmanager|microsoft/i, provider: 'Microsoft Azure', kind: 'Cloud', note: 'Azure Front Door / CDN' },
  { re: /googleusercontent|googlehosted|ghs\.google|google\.com/i, provider: 'Google', kind: 'Cloud', note: 'Google Cloud / GHC' },
  { re: /vercel|now\.sh/i, provider: 'Vercel', kind: 'PaaS', note: 'Vercel edge network' },
  { re: /netlify/i, provider: 'Netlify', kind: 'PaaS', note: 'Netlify edge' },
  { re: /github\.io|github\.com|githubusercontent/i, provider: 'GitHub Pages', kind: 'PaaS', note: 'GitHub Pages' },
  { re: /cloudflarepages|pages\.dev/i, provider: 'Cloudflare Pages', kind: 'PaaS', note: 'Cloudflare Pages' },
  { re: /herokudns|herokussl|herokuapp/i, provider: 'Heroku', kind: 'PaaS', note: 'Heroku dyno router' },
  { re: /digitalocean/i, provider: 'DigitalOcean', kind: 'Cloud', note: 'DigitalOcean droplet/App Platform' },
  { re: /linode|akamai\.net/i, provider: 'Linode/Akamai', kind: 'Cloud', note: 'Linode' },
  { re: /vultr/i, provider: 'Vultr', kind: 'Cloud', note: 'Vultr' },
  { re: /fly\.io|fly\.dev/i, provider: 'Fly.io', kind: 'PaaS', note: 'Fly edge' },
  { re: /render\.com|onrender/i, provider: 'Render', kind: 'PaaS', note: 'Render' },
  { re: /shopify/i, provider: 'Shopify', kind: 'PaaS', note: 'Shopify storefront' },
  { re: /wpengine|kinsta|sgcpanel|siteground|bluehost|hostgator|godaddy|namecheap/i, provider: 'Shared hosting', kind: 'Hosting', note: 'classic shared host DNS' },
  { re: /squarespace/i, provider: 'Squarespace', kind: 'Website builder', note: 'Squarespace site' },
  { re: /wixsite|wixdns|wix\.com/i, provider: 'Wix', kind: 'Website builder', note: 'Wix site' },
  { re: /sentry|statuspage|zendesk|freshdesk/i, provider: 'SaaS provider', kind: 'SaaS', note: 'third-party SaaS hostname' },
  { re: /oracle|oci/i, provider: 'Oracle Cloud', kind: 'Cloud', note: 'OCI' },
  { re: /ibm|softlayer/i, provider: 'IBM Cloud', kind: 'Cloud', note: 'IBM/SoftLayer' },
  { re: /aiven|mongodb\.net|neon\.tech|supabase/i, provider: 'Managed DB platform', kind: 'DBaaS', note: 'managed database endpoint' },
];

const targets = o._;
if (!targets.length) die('usage: node tools/dnsforurl.js <url|host>... [--all] [--json]');

const server = get(o, 'server', null);
const resolver = new Resolver({ timeout: 8000, tries: 2 });
if (server && server !== true) { try { resolver.setServers(String(server).split(',').map((s) => s.trim())); } catch { die(`bad --server value: ${server}`); } }

const wantAll = flag(o, 'all');

async function tryResolve(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, code: e.code || e.message }; }
}

const out = [];

for (const raw of targets) {
  let host;
  try {
    host = /^https?:\/\//i.test(raw) ? new URL(raw).hostname : String(raw).split('/')[0].split(':')[0];
  } catch { out.push({ input: raw, error: 'invalid url or host' }); continue; }

  const entry = { input: raw, host, records: {}, errors: {} };

  const [a, aaaa, cname] = await Promise.all([
    tryResolve(() => resolver.resolve4(host)),
    tryResolve(() => resolver.resolve6(host)),
    tryResolve(() => resolver.resolveCname(host)),
  ]);
  if (a.ok) entry.records.A = a.value; else entry.errors.A = a.code;
  if (aaaa.ok) entry.records.AAAA = aaaa.value; else entry.errors.AAAA = aaaa.code;
  if (cname.ok) entry.records.CNAME = cname.value; else entry.errors.CNAME = cname.code;

  /* follow the CNAME chain by hand, up to 8 hops */
  const chain = [];
  let cur = host;
  for (let i = 0; i < 8; i++) {
    const c = await tryResolve(() => resolver.resolveCname(cur));
    if (!c.ok) break;
    const next = c.value[0];
    if (!next || chain.includes(next)) { if (next) chain.push(`${next} (loop)`); break; }
    chain.push(next);
    cur = next;
  }
  entry.cnameChain = chain;
  entry.finalTarget = chain.length ? chain[chain.length - 1] : host;

  if (wantAll) {
    const [ns, mx, txt, soa, caa] = await Promise.all([
      tryResolve(() => resolver.resolveNs(host)),
      tryResolve(() => resolver.resolveMx(host)),
      tryResolve(() => resolver.resolveTxt(host)),
      tryResolve(() => resolver.resolveSoa(host)),
      tryResolve(() => resolver.resolveCaa(host)),
    ]);
    const [parent] = host.split('.').slice(1).join('.') ? [null] : [null];
    if (ns.ok) entry.records.NS = ns.value; else entry.errors.NS = ns.code;
    if (mx.ok) entry.records.MX = mx.value.map((m) => `${m.priority} ${m.exchange}`); else entry.errors.MX = mx.code;
    if (txt.ok) entry.records.TXT = txt.value.map((t) => t.join('')); else entry.errors.TXT = txt.code;
    if (soa.ok) entry.records.SOA = [`${soa.value.nsname} ${soa.value.hostmaster} serial=${soa.value.serial}`]; else entry.errors.SOA = soa.code;
    if (caa.ok) entry.records.CAA = caa.value.map((c) => `${c.critical ? 'critical ' : ''}${c.issue || c.issuewild || ''}`.trim()); else entry.errors.CAA = caa.code;

    /* NS of the registrable domain */
    const labels = host.split('.');
    const apex = labels.length > 2 ? labels.slice(-2).join('.') : host;
    if (apex !== host) {
      const ans = await tryResolve(() => resolver.resolveNs(apex));
      if (ans.ok) entry.apexNs = { domain: apex, servers: ans.value };
    }
  }

  /* provider inference — the bare apex host must not self-match (github.com is not "GitHub Pages") */
  const hostLabels = host.split('.').length;
  const hostForMatching = hostLabels > 2 ? host : '';
  const blob = [
    hostForMatching,
    ...(entry.records.CNAME || []), ...chain, ...(entry.records.A || []),
    ...(entry.records.NS || []), ...(entry.records.TXT || []), ...(entry.apexNs?.servers || []),
  ].join(' ').toLowerCase();
  const hints = CDN_HINTS.filter((h) => h.re.test(blob)).map((h) => ({ provider: h.provider, kind: h.kind, note: h.note }));
  entry.hints = hints;
  entry.provider = hints[0]?.provider || null;
  entry.behindCdn = hints.some((h) => /CDN/.test(h.kind));
  entry.ips = [...(entry.records.A || []), ...(entry.records.AAAA || [])];
  entry.resolves = entry.ips.length > 0;

  if (wantAll) {
    const [ptrs] = await Promise.all([Promise.all(entry.ips.slice(0, 6).map(async (ip) => {
      const r = await tryResolve(() => resolver.reverse(ip));
      return { ip, ptr: r.ok ? r.value[0] : null };
    }))]);
    entry.reverse = ptrs;
  }

  out.push(entry);
}

if (flag(o, 'json')) {
  console.log(JSON.stringify(out.length === 1 ? out[0] : { count: out.length, hosts: out }, null, 2));
} else {
  for (const e of out) {
    if (e.error) { console.log(`${e.input}: ${e.error}\n`); continue; }
    console.log(`${e.host}`);
    const rows = [
      { record: 'A', value: (e.records.A || []).join(' ') || e.errors.A || '—' },
      { record: 'AAAA', value: (e.records.AAAA || []).join(' ') || e.errors.AAAA || '—' },
      { record: 'CNAME', value: (e.records.CNAME || []).join(' ') || e.errors.CNAME || '—' },
    ];
    if (e.cnameChain.length) rows.push({ record: 'chain', value: e.cnameChain.join(' → ') });
    if (wantAll) {
      if (e.records.NS) rows.push({ record: 'NS', value: e.records.NS.join(' ').slice(0, 90) });
      if (e.apexNs) rows.push({ record: 'apex NS', value: `${e.apexNs.domain}: ${e.apexNs.servers.join(' ')}`.slice(0, 90) });
      if (e.records.MX) rows.push({ record: 'MX', value: e.records.MX.join(', ').slice(0, 90) });
      if (e.records.TXT) rows.push({ record: 'TXT', value: e.records.TXT.join(' | ').slice(0, 90) });
      if (e.records.CAA) rows.push({ record: 'CAA', value: e.records.CAA.join(', ') });
      if (e.records.SOA) rows.push({ record: 'SOA', value: e.records.SOA[0].slice(0, 90) });
      if (e.reverse) for (const r of e.reverse) if (r.ptr) rows.push({ record: `PTR ${r.ip}`, value: r.ptr });
    }
    console.log(table(rows));
    if (e.hints.length) {
      console.log(`provider: ${e.hints.map((h) => `${h.provider} (${h.kind})`).join(', ')}`);
      for (const h of e.hints) console.log(`  - ${h.note}`);
    } else {
      console.log(e.resolves ? 'provider: unrecognised (custom or self-hosted infrastructure)' : 'provider: unknown — the host does not resolve');
    }
    if (e.behindCdn) console.log('the origin IP is probably not exposed by DNS — check certificates or historical records for it');
    console.log('');
  }
}
process.exitCode = 0;
