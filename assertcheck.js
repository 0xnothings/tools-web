#!/usr/bin/env node
// assertcheck.js — per-tool output assertions, so a logic regression fails CI.
// Copyright (c) 2026 0xnothings
// Usage:
//   node assertcheck.js                  run every case in tests/cases.json
//   node assertcheck.js --update         record/refresh golden output
//   node assertcheck.js --tool cidr.js   run one tool's cases
//   node assertcheck.js --verbose        show full output for failures
//
// Why this exists.
//
// smoke.js catches a tool that will not load. podcheck.js catches a tool that
// crashes at the end of its real code path. Neither catches a tool that runs
// cleanly and returns the WRONG ANSWER — which is exactly how filetype reported
// every short text file as binary, and jsonlint flagged every URL as a comment.
//
// Each case is a real invocation plus assertions:
//
//   { tool, args, fixtures, expect: {
//       exit, stdout_contains[], stdout_not_contains[],
//       stdout_regex[], stdout_lines, no_stack, golden } }
//
// `golden` is the normalized stdout of a known-good run. Normalization strips
// the fields that legitimately change between runs (timestamps, durations,
// temp paths, generated hex) so the comparison stays stable while still
// catching a changed result.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * This file is copied into each repo root, so it must locate itself either way:
 * running from a repo (tests/cases.json next door) or from _build/_shared
 * (sibling repo dirs). Trying both keeps one file serving both layouts.
 */
function repoDirs() {
  const here = ROOT;
  const local = join(here, 'tests/cases.json');
  if (existsSync(local)) return [{ name: here.split(/[\\/]/).filter(Boolean).pop(), dir: here, caseFile: local }];

  const out = [];
  for (const name of ['tools-security', 'tools-devops', 'tools-web', 'tools-data']) {
    const dir = join(here, '..', '..', name);
    const caseFile = join(dir, 'tests/cases.json');
    if (existsSync(caseFile)) out.push({ name, dir, caseFile });
  }
  return out;
}
const CASES = join(ROOT, 'tests/cases.json');
const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const VERBOSE = argv.includes('--verbose');
const ONLY = argv.includes('--tool') ? argv[argv.indexOf('--tool') + 1] : null;

const STACK = /(^\s*at\s+\S+.*:\d+:\d+|ReferenceError|SyntaxError|TypeError|Assertion failed|UV_HANDLE_CLOSING|is not defined)/m;

/**
 * Strip everything that legitimately differs between two runs of the same code.
 * Anything NOT matched here is treated as meaningful output, so a changed
 * result fails the case.
 */
export function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, '<DUR>')
    .replace(/\b\d+(?:\.\d+)?\s?s\b(?=\s|$|\))/g, '<DUR>')
    .replace(/[A-Za-z]:\\[^\s"',;)]+|\/(?:tmp|home|var|usr|etc)\/[^\s"',;)]+/g, '<PATH>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<HEX>')
    .replace(/\b\d{10,}\b/g, '<NUM>')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[/^\d+$/.test(key) ? Number(key) : key];
  }, obj);
}

function runCase(repoDir, c, tmp) {
  // Fixtures are written as UTF-8 text. Binary fixtures cannot be represented
  // that way — "\u008b" encodes to two bytes (0xC2 0x8B), which corrupts any
  // magic-byte format. fixtures_b64 carries raw bytes as base64 instead.
  for (const [name, body] of Object.entries(c.fixtures || {})) {
    writeFileSync(join(tmp, name), body, 'utf8');
  }
  for (const [name, b64] of Object.entries(c.fixtures_b64 || {})) {
    writeFileSync(join(tmp, name), Buffer.from(b64, 'base64'));
  }
  const argList = (c.args || []).map((a) =>
    a.replace(/\{tmp\}\/([^/\s]+)/g, (_, f) => join(tmp, f).replace(/\\/g, '/'))
  );

  let stdout = '', stderr = '', code = 0;
  try {
    stdout = execFileSync(process.execPath, [join(repoDir, 'tools', c.tool), ...argList], {
      stdio: 'pipe', timeout: c.timeout || 45000, encoding: 'utf8', cwd: tmp,
    });
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    code = typeof e.status === 'number' ? e.status : -1;
  }
  return { stdout, stderr, code, combined: stdout + stderr, argList };
}

const problems = [];
const updates = [];
let ran = 0, passed = 0;

for (const { name: repoName, dir: repoDir, caseFile } of repoDirs()) {
  let doc;
  try { doc = JSON.parse(readFileSync(caseFile, 'utf8')); } catch (e) { console.log(`${repoName}: cases.json is invalid JSON — ${e.message}`); continue; }
  const cases = doc.cases || [];
  console.log(`\n${repoName}: ${cases.length} case(s)`);

  let dirty = false;
  for (const c of cases) {
    if (ONLY && c.tool !== ONLY) continue;
    ran++;
    const tmp = mkdtempSync(join(tmpdir(), 'assert-'));
    let r;
    try { r = runCase(repoDir, c, tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }

    const norm = normalize(r.stdout);
    const ex = c.expect || {};
    const fails = [];

    if (ex.no_stack !== false && STACK.test(r.combined)) {
      const line = r.combined.split('\n').find((l) => STACK.test(l)) || '';
      fails.push(`stack trace: ${line.trim().slice(0, 90)}`);
    }
    if (ex.exit !== undefined && r.code !== ex.exit) fails.push(`exit ${r.code}, expected ${ex.exit}`);

    for (const s of ex.stdout_contains || []) if (!r.stdout.includes(s)) fails.push(`missing in stdout: ${JSON.stringify(s)}`);
    for (const s of ex.stdout_not_contains || []) if (r.stdout.includes(s)) fails.push(`unexpected in stdout: ${JSON.stringify(s)}`);
    for (const p of ex.stdout_regex || []) {
      let re; try { re = new RegExp(p, 'm'); } catch { fails.push(`bad regex in case: ${p}`); continue; }
      if (!re.test(r.stdout)) fails.push(`regex did not match: ${p}`);
    }
    if (ex.stderr_not_contains) for (const s of ex.stderr_not_contains) if (r.stderr.includes(s)) fails.push(`unexpected in stderr: ${JSON.stringify(s)}`);
    if (ex.stdout_lines !== undefined) {
      const n = r.stdout.trim().length ? r.stdout.trim().split('\n').length : 0;
      if (n !== ex.stdout_lines) fails.push(`stdout lines ${n}, expected ${ex.stdout_lines}`);
    }

    if (UPDATE) {
      if (!fails.length) {
        if (c.expect.golden !== norm) { c.expect.golden = norm; dirty = true; }
        updates.push(`${repoName}/${c.tool} ${r.argList.join(' ')}`.trim());
      } else {
        problems.push(`${repoName}/${c.tool} ${r.argList.join(' ')} — cannot record golden: ${fails[0]}`);
      }
      continue;
    }

    if (ex.golden !== undefined) {
      if (norm !== ex.golden) {
        const a = ex.golden.split('\n'), b = norm.split('\n');
        let i = 0; while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
        fails.push(`output changed at line ${i + 1}:\n        recorded: ${JSON.stringify((a[i] ?? '(eof)').slice(0, 100))}\n        actual:   ${JSON.stringify((b[i] ?? '(eof)').slice(0, 100))}`);
      }
    }

    if (fails.length) {
      problems.push(`${repoName}/${c.tool} ${r.argList.join(' ')}\n        ${fails.join('\n        ')}`);
      if (VERBOSE) console.log(`--- actual output ---\n${r.stdout.slice(0, 1200)}`);
    } else passed++;
  }

  if (UPDATE && dirty) {
    writeFileSync(caseFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`  golden updated`);
  }
}

if (UPDATE) {
  console.log(`\nrecorded/verified ${updates.length} golden output(s).`);
  if (problems.length) { console.log('\nproblems during update:'); problems.forEach((p) => console.log('  ' + p)); process.exitCode = 1; }
} else {
  console.log(`\n${ran} case(s), ${passed} passed, ${problems.length} failed`);
  if (problems.length) { console.log('\nfailures:'); problems.forEach((p) => console.log('  ' + p)); process.exitCode = 1; }
}
