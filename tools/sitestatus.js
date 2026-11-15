#!/usr/bin/env node
// sitestatus.js — check status-page APIs (statuspage.io) for a list of companies.
// Copyright (c) 2026 0xnothings
// @tool sitestatus
// @desc Query Statuspage / Instatus / Google Cloud status APIs and summarise which services are degraded
// @usage node tools/sitestatus.js github cloudflare npm --json
// @tags web,status,ops
import { args, get, num, flag, die, inputLines, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`sitestatus — third-party status checker

  node tools/sitestatus.js <name|url>... [options]

  node tools/sitestatus.js --list        show the built-in directory
  node tools/sitestatus.js --list-file hosts.txt

  --incidents     include open incidents with their latest update
  --all           also show operational components
  --timeout <n>   per-request timeout ms (default 12000)
  --json          machine-readable output
  -h, --help      this text

  Accepts a short name from the built-in directory, any <slug>.statuspage.io host,
  or a full status URL. Statuspage, Instatus and the Google Cloud incidents feed
  are all understood.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const DIRECTORY = {
  github: 'https://www.githubstatus.com',
  cloudflare: 'https://www.cloudflarestatus.com',
  npm: 'https://status.npmjs.org',
  stripe: 'https://status.stripe.com',
  twilio: 'https://status.twilio.com',
  datadog: 'https://status.datadoghq.com',
  aws: 'https://status.aws.amazon.com',
  gcp: 'https://status.cloud.google.com',
  azure: 'https://azure.status.microsoft',
  slack: 'https://status.slack.com',
  discord: 'https://discordstatus.com',
  reddit: 'https://www.redditstatus.com',
  shopify: 'https://www.shopifystatus.com',
  vercel: 'https://www.vercel-status.com',
  netlify: 'https://www.netlifystatus.com',
  heroku: 'https://status.heroku.com',
  digitalocean: 'https://status.digitalocean.com',
  linode: 'https://status.linode.com',
  cloudflareworkers: 'https://www.cloudflarestatus.com',
  openai: 'https://status.openai.com',
  anthropic: 'https://status.anthropic.com',
  mongodb: 'https://status.mongodb.com',
  elastic: 'https://status.elastic.co',
  atlassian: 'https://status.atlassian.com',
  zoom: 'https://status.zoom.us',
  dropbox: 'https://status.dropbox.com',
  sendgrid: 'https://status.sendgrid.com',
  postmark: 'https://status.postmarkapp.com',
  algolia: 'https://status.algolia.com',
  contentful: 'https://status.contentful.com',
  sanity: 'https://status.sanity.io',
  supabase: 'https://status.supabase.com',
  render: 'https://status.render.com',
  railway: 'https://railway.instatus.com',
  bunny: 'https://status.bunny.net',
};

const timeout = Math.max(1000, num(get(o, 'timeout'), 12000));

if (flag(o, 'list')) {
  const rows = Object.entries(DIRECTORY).map(([name, url]) => ({ name, url }));
  if (flag(o, 'json')) console.log(JSON.stringify({ count: rows.length, directory: rows }, null, 2));
  else console.log(table(rows));
  process.exitCode = 0;
  process.exitCode = 0;
} else {
  const inc = (() => {
    const list = [...o._];
    const lf = get(o, 'list-file', null);
    return { list, lf };
  })();
  let targets = [...inc.list];
  if (inc.lf && inc.lf !== true) targets = [...targets, ...(await inputLines(String(inc.lf)))];
  const defaultSet = ['github', 'cloudflare', 'npm', 'stripe'];
  if (!targets.length) targets = defaultSet;

  async function fetchJson(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
      const text = await res.text();
      try { return { data: JSON.parse(text), status: res.status }; } catch { return { error: 'non-JSON response', status: res.status }; }
    } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) }; }
    finally { clearTimeout(t); }
  }

  function baseFor(target) {
    const t = String(target).trim();
    if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, '');
    if (t.includes('.')) return `https://${t.replace(/\/+$/, '')}`;
    return DIRECTORY[t.toLowerCase()] || null;
  }

  const INDICATOR_SEVERITY = { none: 0, minor: 1, major: 2, critical: 3, maintenance: 1 };
  const results = [];

  for (const target of targets) {
    const base = baseFor(target);
    if (!base) { results.push({ target, error: 'unknown name — use --list for the built-in directory, or pass a full URL' }); continue; }

    /* --- Statuspage style --- */
    const sum = await fetchJson(`${base}/api/v2/summary.json`);
    if (sum.data) {
      const d = sum.data;
      const indicator = d.status?.indicator || 'none';
      const components = (d.components || []).filter((c) => !c.group);
      const degraded = components.filter((c) => c.status && c.status !== 'operational');
      const open = (d.incidents || []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');
      const maint = (d.scheduled_maintenances || []).filter((m) => m.status === 'in_progress' || m.status === 'scheduled');
      results.push({
        target, name: d.page?.name || String(target), provider: 'statuspage',
        url: d.page?.url || base,
        indicator, description: d.status?.description || null,
        severity: INDICATOR_SEVERITY[indicator] ?? 1,
        updated: d.page?.updated_at || null,
        components: components.length,
        degradedComponents: degraded.map((c) => ({ name: c.name, status: c.status })),
        incidents: open.map((i) => ({
          name: i.name, impact: i.impact, status: i.status,
          created: i.created_at, shortlink: i.shortlink,
          latest: i.incident_updates?.[0]?.body?.replace(/\s+/g, ' ').slice(0, 200) || null,
        })),
        maintenance: maint.map((m) => ({ name: m.name, status: m.status, scheduledFor: m.scheduled_for, scheduledUntil: m.scheduled_until })),
      });
      continue;
    }

    /* --- Instatus style --- */
    const instatus = await fetchJson(`${base}/summary.json`);
    if (instatus.data?.page) {
      const d = instatus.data;
      results.push({
        target, name: d.page.name, provider: 'instatus', url: d.page.url,
        indicator: d.page.status === 'UP' ? 'none' : d.page.status === 'HASISSUES' ? 'major' : d.page.status.toLowerCase(),
        description: d.page.status,
        severity: d.page.status === 'UP' ? 0 : 2,
        updated: d.page.updatedAt || null,
        components: (d.components || []).length,
        degradedComponents: (d.components || []).filter((c) => c.status !== 'OPERATIONAL').map((c) => ({ name: c.name, status: c.status })),
        incidents: (d.incidents || []).map((i) => ({ name: i.name, impact: i.impact, status: i.status, created: i.createdAt, latest: i.status })),
        maintenance: [],
      });
      continue;
    }

    /* --- Google Cloud incidents feed --- */
    if (/status\.cloud\.google\.com/.test(base)) {
      const g = await fetchJson('https://status.cloud.google.com/incidents.json');
      if (g.data && Array.isArray(g.data)) {
        const open = g.data.filter((i) => !i.end);
        results.push({
          target, name: 'Google Cloud', provider: 'gcp-incidents', url: base,
          indicator: open.length ? (open.some((i) => /high|critical/i.test(i.severity)) ? 'major' : 'minor') : 'none',
          description: open.length ? `${open.length} open incident(s)` : 'All services operational',
          severity: open.length ? 2 : 0,
          components: null, degradedComponents: [],
          incidents: open.slice(0, 10).map((i) => ({
            name: i.service_name, impact: i.severity, status: 'active', created: i.begin,
            latest: (i.most_recent_update?.text || '').slice(0, 200),
          })),
          maintenance: [],
          note: 'aggregated feed — not filtered to a single product',
        });
        continue;
      }
    }

    /* --- AWS has no JSON API; fall back to a plain note --- */
    if (/status\.aws\.amazon\.com/.test(base)) {
      results.push({
        target, name: 'AWS', provider: 'aws', url: base,
        indicator: 'unknown', description: 'AWS publishes an RSS feed and an HTML dashboard only',
        severity: -1, rss: 'https://status.aws.amazon.com/rss/all.rss',
        note: 'use: node tools/rssgrab.js https://status.aws.amazon.com/rss/all.rss',
      });
      continue;
    }

    results.push({ target, name: String(target), provider: 'unknown', url: base, indicator: 'unknown', severity: -1, error: sum.error || instatus.error || 'no supported status API at this host' });
  }

  const worst = results.reduce((a, b) => Math.max(a, b.severity ?? -1), -1);
  const overall = ['operational', 'degraded', 'partial outage', 'major outage'][Math.max(0, worst)] || 'unknown';
  const down = results.filter((r) => (r.severity ?? -1) > 0);
  const failing = results.filter((r) => r.error || (r.severity ?? -1) < 0);

  const payload = {
    checked: results.length, overall,
    affected: down.map((r) => r.name || r.target),
    errored: failing.map((r) => r.target),
    services: results,
  };

  if (flag(o, 'json')) { console.log(JSON.stringify(payload, null, 2)); process.exitCode = 0; } else {
    console.log(`${results.length} service(s) checked · overall: ${overall}\n`);
    console.log(table(results.map((r) => ({
      service: String(r.name || r.target).slice(0, 26),
      state: r.indicator || (r.error ? 'error' : '?'),
      degraded: r.degradedComponents?.length ?? '',
      incidents: r.incidents?.length ?? '',
      notes: r.error ? String(r.error).slice(0, 34) : (r.incidents?.[0]?.name || r.description || '').slice(0, 40),
    }))));

    if (flag(o, 'incidents')) {
      const withInc = results.filter((r) => r.incidents?.length);
      if (withInc.length) {
        console.log('\nOPEN INCIDENTS');
        for (const r of withInc) {
          for (const i of r.incidents) {
            console.log(`  ${r.name}: ${i.name} [${i.impact || i.status}]`);
            if (i.latest) console.log(`    ${i.latest}`);
          }
        }
      } else console.log('\nno open incidents');
    }
    if (flag(o, 'all')) {
      const withDeg = results.filter((r) => r.degradedComponents?.length);
      if (withDeg.length) {
        console.log('\nDEGRADED COMPONENTS');
        for (const r of withDeg) for (const c of r.degradedComponents) console.log(`  ${r.name} / ${c.name} — ${c.status}`);
      }
    }
    if (failing.length) console.log(`\nnot checked (no supported API): ${failing.map((r) => r.target).join(', ')}`);
    if (worst > 0) process.exitCode = 2; else process.exitCode = 0;
  }
}
process.exitCode = process.exitCode || 0;
