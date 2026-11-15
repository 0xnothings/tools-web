#!/usr/bin/env node
// harfetch.js — replay a .har file's requests and report status/wall-time differences.
// Copyright (c) 2026 0xnothings
// @tool harfetch
// @desc Replay every request in a HAR capture and compare status, size and wall time against the recording
// @usage node tools/harfetch.js capture.har --filter api --limit 20 --json
// @tags web,http,perf
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`harfetch — HAR replayer and diff

  node tools/harfetch.js <file.har|-> [options]

  --filter <text>     only replay entries whose URL contains this substring
  --method <m>        only replay this HTTP method
  --limit <n>         replay at most n entries (default 25)
  --concurrency <n>   parallel requests (default 4)
  --timeout <n>       per-request timeout ms (default 20000)
  --dry-run           print what would be replayed without sending anything
  --list              list entries without replaying
  --json              machine-readable output
  -h, --help          this text

  GET/HEAD are replayed as recorded. Other methods are sent WITHOUT their recorded
  body unless --with-body is passed, so replays do not mutate state by default.
  Reports status drift, size drift and wall-time drift per entry.`);
  process.exit(0);
}

const UA = '0xnothings-harfetch/1.0 (+https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/harfetch.js <file.har|-> [--limit 25] [--json]');

const text = src === '-' ? await readInput(null) : readFileSync(src, 'utf8');
let har;
try { har = JSON.parse(text); } catch (e) { die(`invalid JSON in ${src}: ${e.message}`); }
const entries = har?.log?.entries;
if (!Array.isArray(entries)) die('not a HAR file: log.entries missing');

const filter = get(o, 'filter', null);
const methodFilter = get(o, 'method', null);
const limit = Math.max(1, num(get(o, 'limit'), 25));
const conc = Math.max(1, Math.min(16, num(get(o, 'concurrency'), 4)));
const timeout = Math.max(1000, num(get(o, 'timeout'), 20000));
const dryRun = flag(o, 'dry-run');

let selected = entries;
if (filter && filter !== true) selected = selected.filter((e) => String(e.request?.url || '').includes(String(filter)));
if (methodFilter && methodFilter !== true) selected = selected.filter((e) => String(e.request?.method || '').toUpperCase() === String(methodFilter).toUpperCase());
const total = selected.length;
selected = selected.slice(0, limit);

function rec(entry) {
  const req = entry.request || {};
  const res = entry.response || {};
  const headers = {};
  for (const h of req.headers || []) headers[String(h.name).toLowerCase()] = h.value;
  const size = res.content?.size ?? (res.content?.text ? res.content.text.length : null);
  return {
    method: String(req.method || 'GET').toUpperCase(),
    url: req.url,
    headers,
    status: res.status ?? null,
    recordedTime: entry.time ?? null,
    recordedSize: size,
    recordedType: (res.content?.mimeType || '').split(';')[0] || null,
    body: req.postData?.text || null,
    mime: req.postData?.mimeType || null,
  };
}

const planned = selected.map(rec);

if (flag(o, 'list') || dryRun) {
  const rows = planned.map((p, i) => ({ '#': i + 1, method: p.method, recorded: p.status ?? '', size: p.recordedSize ?? '', url: p.url.slice(0, 68) }));
  if (flag(o, 'json')) console.log(JSON.stringify({ source: src, total, shown: planned.length, entries: planned }, null, 2));
  else { console.log(table(rows)); if (total > planned.length) console.log(`\n${total - planned.length} more not shown (--limit ${limit})`); }
  process.exitCode = 0;
} else {

async function replay(p) {
  const headers = { 'user-agent': UA };
  for (const [k, v] of Object.entries(p.headers)) {
    if (!k || /^(host|content-length|connection|accept-encoding|cookie2?|origin|referer|:)/.test(k)) continue;
    headers[k] = v;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const opts = { method: p.method, headers, signal: ctl.signal, redirect: 'manual' };
    if (p.body && !['GET', 'HEAD'].includes(p.method) && flag(o, 'with-body')) { opts.body = p.body; headers['content-type'] = p.mime || 'application/json'; }
    const res = await fetch(p.url, opts);
    const txt = await res.text();
    const ms = Date.now() - t0;
    return {
      liveStatus: res.status, liveMs: ms, liveSize: txt.length,
      liveType: (res.headers.get('content-type') || '').split(';')[0] || null,
      location: res.headers.get('location') || null,
      error: null,
    };
  } catch (e) {
    return { liveStatus: 0, liveMs: Date.now() - t0, liveSize: null, liveType: null, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

const results = [];
for (let i = 0; i < planned.length; i += conc) {
  const batch = planned.slice(i, i + conc);
  const done = await Promise.all(batch.map(async (p) => ({ ...p, ...(await replay(p)) })));
  results.push(...done);
}

const report = results.map((r) => ({
  method: r.method,
  url: r.url,
  recordedStatus: r.status,
  liveStatus: r.liveStatus,
  statusDrift: r.status !== null && r.liveStatus ? r.liveStatus - r.status : null,
  recordedMs: r.recordedTime,
  liveMs: r.liveMs,
  timeDriftPct: r.recordedTime && r.recordedTime > 0 ? Math.round(((r.liveMs - r.recordedTime) / r.recordedTime) * 100) : null,
  recordedSize: r.recordedSize,
  liveSize: r.liveSize,
  error: r.error,
  verdict: r.error ? 'error'
    : r.status !== null && r.liveStatus !== r.status ? 'status-changed'
    : r.status === null ? 'unknown'
    : 'match',
}));

const changed = report.filter((r) => r.verdict !== 'match');
const slow = report.filter((r) => r.timeDriftPct !== null && r.timeDriftPct > 50);
const failing = report.filter((r) => r.liveStatus >= 400 || r.error);
const avgLive = report.filter((r) => r.liveMs).reduce((a, b) => a + b.liveMs, 0) / (report.filter((r) => r.liveMs).length || 1);

const env = {
  source: src, harVersion: har.log?.version || null, creator: har.log?.creator?.name || null,
  totalEntries: entries.length, replayed: report.length, filteredOut: entries.length - total,
  match: report.length - changed.length, changed: changed.length, failing: failing.length, slow: slow.length,
  avgLiveMs: Math.round(avgLive),
};

if (flag(o, 'json')) { console.log(JSON.stringify({ ...env, results: report }, null, 2)); process.exitCode = 0; } else {
console.log(`${src}  har ${har.log?.version || '?'}  by ${har.log?.creator?.name || 'unknown'}`);
console.log(`${entries.length} entries · replayed ${report.length} · match ${env.match} · changed ${changed.length} · failing ${failing.length} · avg ${env.avgLiveMs}ms\n`);
console.log(table(report.slice(0, 60).map((r) => ({
  method: r.method,
  recorded: r.recordedStatus ?? '',
  live: r.liveStatus || r.error || '',
  Δms: r.timeDriftPct === null ? '' : (r.timeDriftPct > 0 ? '+' : '') + r.timeDriftPct + '%',
  live_ms: r.liveMs,
  verdict: r.verdict,
  url: r.url.slice(0, 48),
}))));
if (report.length > 60) console.log(`\n${report.length - 60} more not shown`);
if (failing.length) console.log(`\n${failing.length} endpoint(s) failing now — likely deleted, auth-gated or moved.`);
}
process.exitCode = failedExit(changed.length);
}

function failedExit(n) { return n ? 1 : 0; }
