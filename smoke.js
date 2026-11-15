#!/usr/bin/env node
// smoke.js — run every tool with --help and report pass/fail.
// Copyright (c) 2026 0xnothings
// Usage: node smoke.js
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(ROOT, 'tools');
const files = readdirSync(TOOLS).filter(f => f.endsWith('.js')).sort();

let pass = 0, fail = 0;
const failures = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, [join(TOOLS, f), '--help'], { stdio: 'pipe', timeout: 15000, encoding: 'utf8' });
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${f}: ${(e.stderr || e.message || '').toString().split('\n')[0]}`);
  }
}
console.log(`${files.length} tools | pass=${pass} fail=${fail}`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach(x => console.log('  ' + x)); }
process.exit(fail ? 1 : 0);
