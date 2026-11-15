#!/usr/bin/env node
// ratelim.js — detect rate limit headers and compute a safe pacing plan.
// Copyright (c) 2026 0xnothings
// @tool ratelim
// @desc Read an API's rate-limit headers and compute a safe request pacing / concurrency plan
// @usage node tools/ratelim.js https://api.github.com/users/octocat --burst 5 --json
// @tags web,api,recon
import { args, get, num, flag, die, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`ratelim — rate limit detector and pacing planner

  node tools/ratelim.js <url> [options]

  --burst <n>        probe this many requests back-to-back to measure throttling (default 3, max 12)
  --window <sec>     assume this window when the API gives no reset header (default 60)
  --target <ratio>   fraction of the quota to consume (default 0.8)
  --header k:v       extra request header (repeatable)
  --json             machine-readable output
  -h, --help         this text

  Recognises GitHub (x-ratelimit-*), IETF draft (ratelimit-*), Retry-After,
  Stripe-style (x-rate-limit-*), Cloudflare and generic quota headers. Probes are
  GETs with no body; they never mutate state.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const url = o._[0];
if (!url) die('usage: node tools/ratelim.js <url> [--burst 3] [--json]');

const burst = Math.max(1, Math.min(12, num(get(o, 'burst'), 3)));
const defaultWindow = Math.max(1, num(get(o, 'window'), 60));
const targetRatio = Math.min(1, Math.max(0.05, num(get(o, 'target'), 0.8)));

const headers = { 'user-agent': UA, accept: 'application/json, */*' };
if (o.f.header) {
  for (const raw of [].concat(o.f.header)) {
    const i = String(raw).indexOf(':');
    if (i > 0) headers[String(raw).slice(0, i).trim().toLowerCase()] = String(raw).slice(i + 1).trim();
  }
}

const PATTERNS = [
  { key: 'limit', re: /^(x-)?ratelimit-limit$|^(x-)?rate-limit-limit$|^x-rate-limit$/ },
  { key: 'remaining', re: /^(x-)?ratelimit-remaining$|^(x-)?rate-limit-remaining$/ },
  { key: 'reset', re: /^(x-)?ratelimit-reset$|^(x-)?rate-limit-reset$|^ratelimit-reset$/ },
  { key: 'window', re: /^(x-)?ratelimit-window$|^(x-)?rate-limit-window$|^x-window$/ },
  { key: 'policy', re: /^(x-)?ratelimit-policy$/ },
  { key: 'retryAfter', re: /^retry-after$/ },
  { key: 'quota', re: /^(x-)?quota-(limit|remaining|reset)$|^x-requests-(limit|remaining|reset)$/ },
];

function collectHeaders(h) {
  const found = {};
  for (const [k, v] of Object.entries(h)) {
    for (const p of PATTERNS) {
      if (!p.re.test(k)) continue;
      found[k] = v;
      const m = String(v).match(/(\d+)\s*;\s*w=(\d+)/);
      if (m) {
        found[`${k}#parsed`] = { count: Number(m[1]), windowSeconds: Number(m[2]) };
      }
      break;
    }
  }
  const hasRL = Object.keys(found).length > 0;
  const retryAfter = h['retry-after'] ? Number(h['retry-after']) || (Date.parse(h['retry-after']) - Date.now()) / 1000 : null;
  return { found, hasRL, retryAfter };
}

async function probe() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal, redirect: 'manual', headers });
    const h = {};
    for (const [k, v] of res.headers) h[k] = v;
    if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
    return { status: res.status, headers: h, ms: Date.now() - t0, ok: true };
  } catch (e) {
    return { status: 0, headers: {}, ms: Date.now() - t0, ok: false, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

const probes = [];
for (let i = 0; i < burst; i++) {
  probes.push(await probe());
  if (i < burst - 1) await sleep(60);
}

const first = probes[0];
if (!first.ok) die(`probe failed: ${first.error || first.status}`);

const info = collectHeaders(first.headers);
const remainingValues = probes
  .map((p) => {
    const c = collectHeaders(p.headers);
    const rem = Object.entries(c.found).find(([k]) => /remaining$/.test(k));
    return rem ? Number(rem[1]) : null;
  })
  .filter((v) => v !== null && Number.isFinite(v));

const limit = (() => {
  for (const [k, v] of Object.entries(info.found)) {
    if (/limit$/.test(k) && !k.includes('#') && Number.isFinite(Number(v))) return Number(v);
    if (k.endsWith('#parsed')) return v.count;
  }
  return null;
})();

const windowSeconds = (() => {
  for (const [k, v] of Object.entries(info.found)) {
    if (k.endsWith('#parsed')) return v.windowSeconds;
    if (/window$/i.test(k) && Number.isFinite(Number(v))) return Number(v);
  }
  if (info.found['x-ratelimit-reset'] && limit) return Math.max(1, Math.round(Number(info.found['x-ratelimit-reset']) - Date.now() / 1000));
  return defaultWindow;
})();

const remaining = remainingValues.length ? Math.min(...remainingValues) : (limit !== null ? limit : null);
const throttled = probes.some((p) => p.status === 429 || p.status === 503);
const throttledAt = probes.findIndex((p) => p.status === 429 || p.status === 503);

const resetEpoch = Number(
  info.found['x-ratelimit-reset'] ?? info.found['ratelimit-reset'] ?? info.found['x-rate-limit-reset'] ?? 0,
);
const resetIn = resetEpoch > 1e9 ? Math.max(0, Math.round(resetEpoch - Date.now() / 1000)) : null;
const effectiveWindow = resetIn !== null ? Math.max(1, resetIn) : windowSeconds;

const budget = limit !== null ? Math.floor((remaining !== null ? remaining : limit) * targetRatio) : null;
const safeRps = budget !== null ? Math.max(0.01, budget / effectiveWindow) : null;
const intervalMs = safeRps !== null ? Math.ceil(1000 / safeRps) : null;
const concurrency = safeRps !== null ? Math.max(1, Math.min(8, Math.floor(safeRps * 2))) : 1;

const policy = {
  detected: info.hasRL || throttled,
  headers: info.found,
  limit, remaining,
  windowSeconds: effectiveWindow,
  resetAt: resetEpoch > 1e9 ? new Date(resetEpoch * 1000).toISOString() : null,
  resetInSeconds: resetIn,
  retryAfter: info.retryAfter,
  throttled,
  throttledAtProbe: throttledAt >= 0 ? throttledAt + 1 : null,
  observedRemaining: remainingValues,
  probeStatuses: probes.map((p) => p.status),
  probeLatencyMs: probes.map((p) => p.ms),
  plan: {
    targetRatio,
    budget,
    requestsPerSecond: safeRps !== null ? Math.round(safeRps * 100) / 100 : null,
    minIntervalMs: intervalMs,
    suggestedConcurrency: concurrency,
    requestsPerMinute: safeRps !== null ? Math.round(safeRps * 60) : null,
    requestsPerHour: safeRps !== null ? Math.round(safeRps * 3600) : null,
  },
  advice: [],
};

if (!policy.detected) {
  policy.advice.push('no rate-limit headers seen — assume a conservative 1 request/second and back off on the first 429');
  policy.advice.push('watch for 429/503 during the first 20 requests to calibrate');
} else {
  if (throttled) policy.advice.push(`throttled at probe ${policy.throttledAtProbe} of ${burst} — honour Retry-After and add jitter`);
  if (remaining !== null && limit !== null && remaining / limit < 0.2) policy.advice.push(`quota nearly exhausted (${remaining}/${limit}) — wait for reset`);
  if (resetIn !== null) policy.advice.push(`quota resets in ${resetIn}s — schedule bulk work after the reset`);
  if (intervalMs) policy.advice.push(`pace at 1 request every ${intervalMs}ms to stay inside ${Math.round(targetRatio * 100)}% of the budget`);
  if (!throttled && limit !== null && limit > 100) policy.advice.push('no throttling observed in the burst — the limit is high enough for parallel work');
}

if (flag(o, 'json')) { console.log(JSON.stringify(policy, null, 2)); process.exitCode = 0; } else {
console.log(`${url}`);
console.log(`statuses: ${policy.probeStatuses.join(' → ')}   latency: ${policy.probeLatencyMs.join('/')}ms`);
console.log(`rate limiting: ${policy.detected ? (policy.throttled ? 'ACTIVE (throttled)' : 'declared') : 'not detected'}\n`);

if (Object.keys(policy.headers).length) {
  console.log('HEADERS');
  console.log(table(Object.entries(policy.headers).map(([k, v]) => ({ header: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }))));
  console.log('');
}

console.log('PLAN');
console.log(table([
  { metric: 'limit', value: limit ?? '—' },
  { metric: 'remaining', value: remaining ?? '—' },
  { metric: 'window', value: `${effectiveWindow}s` },
  { metric: 'reset in', value: resetIn !== null ? `${resetIn}s` : policy.resetAt || '—' },
  { metric: 'usable budget', value: budget ?? '—' },
  { metric: 'safe rps', value: policy.plan.requestsPerSecond ?? '—' },
  { metric: 'min interval', value: intervalMs ? `${intervalMs}ms` : '—' },
  { metric: 'concurrency', value: concurrency },
  { metric: 'per minute', value: policy.plan.requestsPerMinute ?? '—' },
  { metric: 'per hour', value: policy.plan.requestsPerHour ?? '—' },
]));

console.log('\nADVICE');
for (const a of policy.advice) console.log('  - ' + a);
}
process.exitCode = 0;
