#!/usr/bin/env node
// corsmatrix.js — origin x endpoint CORS result matrix.
// Copyright (c) 2026 0xnothings
// @tool corsmatrix
// @desc Probe CORS behaviour for a list of origins against a list of endpoints, record the allow-origin/credentials/vary response per cell, and flag the dangerous combinations
// @usage node tools/corsmatrix.js https://api.example.com --origins origins.txt --paths paths.txt
// @tags web,security,cors
import { args, get, num, flag, die, inputLines, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`corsmatrix — CORS behaviour matrix

  node tools/corsmatrix.js <base-url> [options]

  --origins <src>  origin list (file or comma-separated); default: a built-in
                   set of probe origins including a hostile one
  --paths <src>    endpoint paths (file or comma-separated); default: ['/']
  --methods <m>    methods to test, default "GET"
  --preflight      send an OPTIONS preflight per cell instead of a simple GET
  --delay <ms>     pause between requests (default 150)
  --json           machine-readable output
  -h, --help       this text

  Dangerous flag rules: reflected origin + credentials true = session hijack
  candidate; wildcard + credentials = spec-invalid; reflected origin without
  credentials = unauthenticated read exposure only.`); 
  process.exit(0);
}

const base = o._[0];
if (!base) die('usage: node tools/corsmatrix.js <base-url> [--origins list] [--paths list]');
if (!/^https?:\/\//i.test(base)) die('base-url must start with http:// or https://');

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const DEFAULT_ORIGINS = ['https://evil.example', 'null', 'https://attacker.test', 'https://sub.example.com'];
const DEFAULT_PATHS = ['/'];

async function listArg(key, fallback) {
  const v = get(o, key, null);
  if (!v) return fallback;
  const s = String(v);
  if (/[,\n]/.test(s)) return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  try { return await inputLines(s); } catch { return [s]; }
}

const origins = await listArg('origins', DEFAULT_ORIGINS);
const paths = await listArg('paths', DEFAULT_PATHS);
const methods = String(get(o, 'methods', 'GET')).toUpperCase().split(',').map((m) => m.trim());
const delay = Math.max(0, num(get(o, 'delay'), 150));
const preflight = flag(o, 'preflight');
const baseUrl = base.replace(/\/$/, '');

const cells = [];
for (const origin of origins) {
  for (const path of paths) {
    const url = path.startsWith('http') ? path : baseUrl + (path.startsWith('/') ? path : '/' + path);
    for (const method of methods) {
      const headers = { 'user-agent': UA, origin };
      if (preflight) {
        headers['access-control-request-method'] = method;
        headers['access-control-request-headers'] = 'content-type, authorization';
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      let res, err = null;
      try {
        res = await fetch(url, { method: preflight ? 'OPTIONS' : method, headers, signal: ctl.signal, redirect: 'manual' });
      } catch (e) {
        err = e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message);
      } finally { clearTimeout(timer); }
      const h = res ? res.headers : new Headers();
      const allowOrigin = h.get('access-control-allow-origin');
      const allowCreds = h.get('access-control-allow-credentials');
      const allowMethods = h.get('access-control-allow-methods');
      const allowHeaders = h.get('access-control-allow-headers');
      const expose = h.get('access-control-expose-headers');
      const vary = h.get('vary');

      let verdict = 'no CORS';
      let severity = 'NONE';
      const reflected = allowOrigin === origin;
      if (allowOrigin === '*') {
        verdict = allowCreds === 'true' ? 'wildcard + credentials (invalid per spec)' : 'wildcard, no credentials';
        severity = allowCreds === 'true' ? 'MEDIUM' : 'LOW';
      } else if (reflected) {
        if (allowCreds === 'true') { verdict = 'REFLECTED with credentials'; severity = 'HIGH'; }
        else { verdict = 'reflected, no credentials'; severity = 'LOW'; }
      } else if (allowOrigin) {
        verdict = `fixed origin (${allowOrigin.slice(0, 26)})`;
        severity = 'NONE';
      }
      if (res && res.status >= 400 && !allowOrigin) verdict = err ? `error ${err}` : `HTTP ${res.status}, no CORS`;
      if (preflight && allowOrigin && (!allowMethods || !allowMethods.split(',').map((m) => m.trim().toUpperCase()).includes(method))) {
        verdict += ' (method not allowed in preflight)';
        severity = severity === 'HIGH' ? 'MEDIUM' : severity;
      }

      cells.push({
        origin: origin.slice(0, 30),
        path: path.slice(0, 30),
        method,
        status: res ? res.status : (err || 'ERR'),
        allowOrigin: allowOrigin || '—',
        creds: allowCreds || '—',
        methods: (allowMethods || '').replace(/\s+/g, '').slice(0, 24) || '—',
        expose: expose ? 'yes' : '—',
        vary: vary && /origin/i.test(vary) ? 'origin' : (vary || '—'),
        verdict,
        severity,
      });
      if (delay) await sleep(delay);
    }
  }
}

const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
const findings = cells.filter((c) => c.severity !== 'NONE').sort((a, b) => rank[a.severity] - rank[b.severity]);
const allowed = cells.filter((c) => c.allowOrigin !== '—');

if (flag(o, 'json')) {
  console.log(JSON.stringify({ base, preflight, results: cells, findings: findings.map((f) => ({ origin: f.origin, path: f.path, method: f.method, verdict: f.verdict, severity: f.severity })) }, null, 2));
} else {
  console.log(`${base} — ${origins.length} origin(s) x ${paths.length} path(s) x ${methods.length} method(s)${preflight ? ' (preflight)' : ''}\n`);
  console.log(table(cells.map((c) => ({
    origin: c.origin,
    path: c.path,
    st: c.status,
    'allow-origin': c.allowOrigin === '—' ? '—' : (c.allowOrigin === '*' ? '*' : (c.allowOrigin === c.origin ? 'reflected' : 'fixed')),
    creds: c.creds,
    vary: c.vary,
    verdict: c.verdict.slice(0, 34),
    sev: c.severity,
  }))));
  console.log(`\n${allowed.length}/${cells.length} cells returned an Access-Control-Allow-Origin header`);
  if (findings.length) {
    console.log('\nfindings:');
    console.log(table(findings.slice(0, 20).map((f) => ({ severity: f.severity, origin: f.origin.slice(0, 26), path: f.path.slice(0, 24), verdict: f.verdict.slice(0, 44) }))));
  } else {
    console.log('no origin reflection and no credentialed wildcard — CORS surface looks closed');
  }
  const hostile = cells.filter((c) => (c.allowOrigin === c.origin || c.allowOrigin === '*') && c.creds === 'true');
  if (hostile.length) console.log(`\n${hostile.length} cell(s) allow arbitrary origins WITH credentials — browser-readable authenticated response`);
}
