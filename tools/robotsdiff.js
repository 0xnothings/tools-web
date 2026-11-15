#!/usr/bin/env node
// robotsdiff.js — diff two robots.txt versions and explain the crawl impact.
// Copyright (c) 2026 0xnothings
// @tool robotsdiff
// @desc Compare two robots.txt files rule by rule per user-agent and state exactly which paths became blocked, unblocked, or changed crawl-delay
// @usage node tools/robotsdiff.js https://example.com/robots.txt old-robots.txt
// @tags web,seo,diff
import { args, get, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`robotsdiff — robots.txt impact diff

  node tools/robotsdiff.js <before> <after> [options]

  each argument: a URL, a file path, or '-' for stdin (only one may be stdin)

  --json          machine-readable output
  -h, --help      this text

  Exit code 1 when the after version blocks something the before version allowed.`); 
  process.exit(0);
}

const [a, b] = o._;
if (!a || !b) die('usage: node tools/robotsdiff.js <before> <after>');

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null, sitemaps: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) { cur = { agents: ['*'], rules: [], delay: null, sitemaps: [] }; groups.push(cur); }
    if (key === 'allow' || key === 'disallow') cur.rules.push({ type: key, path: val });
    else if (key === 'crawl-delay') cur.delay = val;
    else if (key === 'sitemap') cur.sitemaps.push(val);
  }
  const byAgent = new Map();
  for (const g of groups) {
    for (const ag of g.agents) {
      if (!byAgent.has(ag)) byAgent.set(ag, { rules: [], delay: null });
      const slot = byAgent.get(ag);
      slot.rules.push(...g.rules);
      if (g.delay !== null) slot.delay = g.delay;
    }
  }
  return { groups, byAgent, sitemaps: groups.flatMap((g) => g.sitemaps) };
}

const before = parseRobots(await load(a));
const after = parseRobots(await load(b));

const ruleKey = (r) => `${r.type}:${r.path}`;
const agentNames = [...new Set([...before.byAgent.keys(), ...after.byAgent.keys()])].sort();
const report = [];

for (const agent of agentNames) {
  const A = before.byAgent.get(agent) || { rules: [], delay: null };
  const B = after.byAgent.get(agent) || { rules: [], delay: null };
  const aSet = new Set(A.rules.map(ruleKey));
  const bSet = new Set(B.rules.map(ruleKey));
  const added = B.rules.filter((r) => !aSet.has(ruleKey(r)));
  const removed = A.rules.filter((r) => !bSet.has(ruleKey(r)));
  report.push({
    agent,
    presence: !before.byAgent.has(agent) ? 'added' : (!after.byAgent.has(agent) ? 'removed' : 'changed'),
    newDisallow: added.filter((r) => r.type === 'disallow' && r.path).map((r) => r.path),
    newAllow: added.filter((r) => r.type === 'allow' && r.path).map((r) => r.path),
    droppedDisallow: removed.filter((r) => r.type === 'disallow' && r.path).map((r) => r.path),
    droppedAllow: removed.filter((r) => r.type === 'allow' && r.path).map((r) => r.path),
    delay: { before: A.delay, after: B.delay },
    rulesBefore: A.rules.length,
    rulesAfter: B.rules.length,
  });
}

const blockedNow = report.reduce((n, r) => n + r.newDisallow.length, 0);
const freedNow = report.reduce((n, r) => n + r.droppedDisallow.length, 0);
const delayChanges = report.filter((r) => r.delay.before !== r.delay.after);
const sitemapAdded = after.sitemaps.filter((s) => !before.sitemaps.includes(s));
const sitemapRemoved = before.sitemaps.filter((s) => !after.sitemaps.includes(s));

if (flag(o, 'json')) {
  console.log(JSON.stringify({ before: a, after: b, agents: report, summary: { newlyBlocked: blockedNow, newlyAllowed: freedNow, delayChanges: delayChanges.length, sitemapAdded, sitemapRemoved } }, null, 2));
} else {
  console.log(`before ${a}\nafter  ${b}\n`);
  console.log(`${before.byAgent.size} user-agent group(s) -> ${after.byAgent.size}; ${blockedNow} path(s) newly blocked, ${freedNow} newly allowed\n`);
  console.log(table(report.map((r) => ({
    agent: r.agent.slice(0, 18),
    state: r.presence,
    'now blocked': r.newDisallow.join(', ').slice(0, 30),
    unblocked: r.droppedDisallow.join(', ').slice(0, 30),
    delay: r.delay.before === r.delay.after ? (r.delay.after || '—') : `${r.delay.before || '—'} -> ${r.delay.after || '—'}`,
  }))));
  if (delayChanges.length) console.log(`\ncrawl-delay changed for: ${delayChanges.map((d) => d.agent).join(', ')}`);
  if (sitemapAdded.length) console.log(`\nsitemap added: ${sitemapAdded.join(', ')}`);
  if (sitemapRemoved.length) console.log(`\nsitemap removed: ${sitemapRemoved.join(', ')}`);
  const impact = [];
  for (const r of report) {
    for (const p of r.newDisallow) impact.push(`${r.agent} loses ${p} — now disallowed`);
    for (const p of r.droppedDisallow) impact.push(`${r.agent} gains ${p} — no longer disallowed`);
  }
  if (impact.length) console.log('\nimpact:\n' + impact.slice(0, 20).map((x) => '  ' + x).join('\n'));
  else console.log('\nno per-agent rule changes');
}
process.exitCode = blockedNow > 0 ? 1 : 0;
