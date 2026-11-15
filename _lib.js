// _lib.js — shared zero-dependency helpers for every 0xnothings tool.
// Copyright (c) 2026 0xnothings
import { readFileSync } from 'node:fs';

/** Tolerant argv parser: --key value | --key=value | -k value | bare '-' = stdin marker. */
export function args(argv) {
  const pos = [], f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && isNaN(+a.slice(1)))) {
      const key = a.replace(/^-+/, '');
      if (key.includes('=')) { const [k, ...v] = key.split('='); f[k] = v.join('='); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !(next.startsWith('-') && isNaN(+next.slice(1)))) {
        f[key] = next; i++;
      } else f[key] = true;
    } else pos.push(a);
  }
  return { _: pos, f };
}

export const get = (o, k, def) => (o.f[k] === undefined ? def : o.f[k]);
export const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
export const flag = (o, k) => o.f[k] === true || o.f[k] === 'true' || o.f[k] === '1';

export function die(msg, code = 1) {
  process.stderr.write(String(msg) + '\n');
  process.exit(code);
}

export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (b += c));
    process.stdin.on('end', () => resolve(b));
    process.stdin.on('error', () => resolve(b));
  });
}

/** Resolve input: file path, '-' for stdin, null for stdin. */
export async function readInput(p) {
  if (p && p !== '-') return readFileSync(p, 'utf8');
  return readStdin();
}

export async function inputLines(p) {
  const t = await readInput(p);
  return t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export const lines = (t) => t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
export const emit = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
export const fmt = (n) => Number(n).toLocaleString('en-US');

export function table(rows, headers) {
  if (!rows.length) return '(empty)';
  const cols = headers || Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ');
  return [line(cols), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

export function parseDuration(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
}

export const nowISO = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
