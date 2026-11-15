#!/usr/bin/env node
// robbots.js — parse robots.txt and test whether paths are allowed for a user-agent.
// Copyright (c) 2026 0xnothings
// @tool robbots
// @desc Fetch and parse robots.txt, then evaluate paths against any user-agent with full precedence rules
// @usage node tools/robbots.js https://example.com --ua Googlebot --path /admin --json
// @tags web,seo,recon
import { args, get, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`robbots — robots.txt parser and evaluator

  node tools/robbots.js <url|host> [options]

  --ua <agent>       user-agent to evaluate (default *)
  --path <p>         test a path (repeatable, comma-separated also works)
  --list             list every rule in rule order
  --sitemaps         print only the sitemap lines
  --raw              print the raw robots.txt
  --json             machine-readable output
  -h, --help         this text

  Follows the Google REP rule set: longest-match wins, Allow beats Disallow at
  equal length, group selection is most-specific-UA first.`);
  process.exit(0);
}

const UA_REQ = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const target = o._[0];
if (!target) die('usage: node tools/robbots.js <url> [--ua Googlebot] [--path /admin]');

let base;
try {
  const u = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
  base = `${u.protocol}//${u.host}`;
} catch { die(`not a valid url: ${target}`); }

const robotsUrl = /robots\.txt$/i.test(target) ? target : `${base}/robots.txt`;

async function grab(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA_REQ, accept: 'text/plain,*/*' } });
    return { status: res.status, body: await res.text(), final: res.url, type: res.headers.get('content-type') || '' };
  } catch (e) { return { status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message), body: '' }; }
  finally { clearTimeout(t); }
}

const res = await grab(robotsUrl);

if (res.status === 0) die(`robots fetch failed: ${res.error} ${robotsUrl}`);

const raw = res.body || '';
const lines = raw.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

const groups = [];
let current = null;
let lastWasAgent = false;

for (const line of lines) {
  const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
  if (!m) continue;
  const key = m[1].toLowerCase();
  const value = m[2].trim();
  if (key === 'user-agent') {
    if (!current || !lastWasAgent) {
      current = { agents: [], rules: [], crawlDelay: null };
      groups.push(current);
    }
    current.agents.push(value.toLowerCase());
    lastWasAgent = true;
  } else {
    if (!current) { current = { agents: ['*'], rules: [], crawlDelay: null }; groups.push(current); }
    lastWasAgent = false;
    if (key === 'disallow' || key === 'allow') {
      current.rules.push({ type: key, path: value });
    } else if (key === 'crawl-delay') {
      current.crawlDelay = Number(value) || null;
    }
  }
}

const sitemaps = lines.filter((l) => /^sitemap\s*:/i.test(l)).map((l) => l.split(/:(.+)/).slice(1).join(':').trim());

function pickGroup(agent) {
  const a = String(agent).toLowerCase();
  let best = null, bestScore = -1;
  for (const g of groups) {
    let score = -1;
    for (const name of g.agents) {
      if (name === '*') score = Math.max(score, 0);
      else if (a === name || a.startsWith(name)) score = Math.max(score, name.length);
    }
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}

/** Longest-match rule evaluation per Google's REP. */
function evaluate(agent, path, method = 'GET') {
  const g = pickGroup(agent);
  if (!g) return { allowed: true, rule: null, group: null, reason: 'no matching group — nothing disallowed' };
  let p = path.startsWith('/') ? path : `/${path}`;
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);

  let winner = null;
  for (const r of g.rules) {
    if (!r.path) continue;
    const pattern = r.path;
    let matches = false;
    if (pattern === '/') matches = p === '/';
    else if (pattern.includes('*') || pattern.endsWith('$')) {
      const body = pattern.endsWith('$') ? pattern.slice(0, -1) : pattern;
      const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + (pattern.endsWith('$') ? '$' : ''));
      matches = re.test(p);
    } else {
      matches = p.startsWith(pattern);
    }
    if (!matches) continue;
    const len = pattern.length;
    if (!winner || len > winner.len || (len === winner.len && r.type === 'allow')) {
      winner = { len, type: r.type, path: pattern };
    }
  }
  if (!winner) return { allowed: true, rule: null, group: g.agents, reason: 'no rule matches — allowed by default' };
  return {
    allowed: winner.type === 'allow',
    rule: winner.path, type: winner.type, group: g.agents,
    reason: `${winner.type} ${winner.path} (match length ${winner.len})`,
  };
}

const agent = String(get(o, 'ua', '*'));
const pathArg = o.f.path;
const paths = [];
if (pathArg && pathArg !== true) {
  const extra = o._.slice(1);
  for (const chunk of [String(pathArg), ...extra]) {
    for (const p of chunk.split(',')) if (p.trim()) paths.push(p.trim());
  }
}

if (flag(o, 'raw')) { console.log(raw.trim()); process.exit(0); }
if (flag(o, 'sitemaps')) { console.log(sitemaps.length ? sitemaps.join('\n') : '(no sitemap directives)'); process.exit(0); }

const tests = paths.map((p) => ({ path: p, ...evaluate(agent, p) }));
const group = pickGroup(agent);

if (flag(o, 'list')) {
  if (flag(o, 'json')) {
    console.log(JSON.stringify({ robots: robotsUrl, status: res.status, groups: groups.map((g) => ({ agents: g.agents, crawlDelay: g.crawlDelay, rules: g.rules })), sitemaps }, null, 2));
    process.exitCode = 0;
  } else {
  console.log(`${robotsUrl}  [HTTP ${res.status}]  ${groups.length} groups · ${groups.reduce((n, g) => n + g.rules.length, 0)} rules\n`);
  for (const g of groups) {
    console.log(`User-agent: ${g.agents.join(', ')}${g.crawlDelay ? `   (crawl-delay ${g.crawlDelay})` : ''}`);
    for (const r of g.rules) console.log(`  ${r.type === 'allow' ? 'Allow   ' : 'Disallow'} ${r.path || '(everything)'}`);
  }
  if (sitemaps.length) { console.log('\nSitemaps:'); sitemaps.forEach((s) => console.log('  ' + s)); }
  }
  process.exitCode = 0;
} else {

const out = {
  robots: robotsUrl, robotsStatus: res.status, bytes: raw.length,
  groups: groups.length,
  matchedGroup: group ? group.agents : null,
  crawlDelay: group ? group.crawlDelay : null,
  sitemaps,
  agent,
  tests,
  wildcardRules: group ? group.rules.length : 0,
};

if (flag(o, 'json')) { console.log(JSON.stringify(out, null, 2)); process.exitCode = 0; } else {

console.log(`${robotsUrl}  [HTTP ${res.status}]  ${raw.length} bytes`);
console.log(`groups: ${groups.length}   matched for "${agent}": ${group ? group.agents.join(', ') : '(none)'}${group?.crawlDelay ? `   crawl-delay ${group.crawlDelay}s` : ''}`);
if (sitemaps.length) console.log(`sitemaps: ${sitemaps.length}`);
if (!tests.length) {
  console.log(`\nno --path given. rules for the matched group:`);
  for (const r of (group?.rules || [])) console.log(`  ${r.type === 'allow' ? 'Allow   ' : 'Disallow'} ${r.path || '(everything)'}`);
} else {
console.log('');
console.log(table(tests.map((t) => ({ path: t.path, verdict: t.allowed ? 'ALLOWED' : 'BLOCKED', reason: t.reason }))));
}
process.exitCode = tests.some((t) => !t.allowed) ? 2 : 0;
}
}
