#!/usr/bin/env node
// smoke.js — exercise every tool past --help, not just at it.
// Copyright (c) 2026 0xnothings
// Usage: node smoke.js [--deep]
//
// Three layers, because each one misses what the previous catches:
//
//  1. --help            catches a file that will not load at all
//  2. --json (no args)  forces the argv/option path AND the fatal-error path,
//                       which is where an unimported helper first evaluates
//  3. --deep            runs an import-reachability lint plus a syntax check
//                       over every tool, catching references that only break
//                       on the real code path (the tlsinfo.js class of bug)
//
// A tool that correctly demands an argument exits non-zero on layer 2 — that is
// expected and is not a failure. What IS a failure: a Node stack trace, a
// ReferenceError, or a SyntaxError.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(ROOT, 'tools');
const deep = process.argv.includes('--deep');
const files = readdirSync(TOOLS).filter((f) => f.endsWith('.js')).sort();

const CRASH = /(ReferenceError|SyntaxError|TypeError|Assertion failed|Cannot read propert|is not defined|UV_HANDLE_CLOSING|ERR_MODULE_NOT_FOUND)/;

function run(file, argList) {
  try {
    const out = execFileSync(process.execPath, [join(TOOLS, file), ...argList], {
      stdio: 'pipe', timeout: 20000, encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      out: (e.stdout || '') + (e.stderr || ''),
    };
  }
}

let pass = 0;
const failures = [];

for (const f of files) {
  const help = run(f, ['--help']);
  if (help.code !== 0) { failures.push(`${f}: --help exited ${help.code}`); continue; }
  if (CRASH.test(help.out)) {
    const hit = help.out.match(CRASH);
    failures.push(`${f}: crash during --help (${hit[0]})`);
    continue;
  }

  // No-argument run: reaches the option-parsing and fatal-error paths without
  // touching the network. Exit 1 with a usage message is correct behaviour.
  const bare = run(f, []);
  if (CRASH.test(bare.out)) {
    const hit = bare.out.match(CRASH);
    const detail = (bare.out.split('\n').find((l) => CRASH.test(l)) || '').trim().slice(0, 90);
    failures.push(`${f}: crash on bare invocation (${hit[0]}) — ${detail}`);
    continue;
  }

  pass++;
}

console.log(`${files.length} tools | pass=${pass} fail=${failures.length}`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((x) => console.log('  ' + x));
}

if (deep) {
  console.log('\n-- deep checks --');
  let deepFail = 0;

  // syntax / load check
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', join(TOOLS, f)], { stdio: 'pipe', encoding: 'utf8' }); }
    catch (e) { console.log(`  SYNTAX ${f}: ${(e.stderr || '').split('\n')[0]}`); deepFail++; }
  }
  if (!deepFail) console.log('  syntax: all files parse');

  // import reachability: a _lib helper used but never imported breaks only on
  // the real code path, which --help never reaches.
  const libPath = join(ROOT, '_lib.js');
  const LIB = readFileSync(libPath, 'utf8');
  const EXPORTS = new Set();
  for (const m of LIB.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) EXPORTS.add(m[1]);

  const strip = (s) => s
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const localsOf = (s) => {
    const code = strip(s), n = new Set();
    for (const m of code.matchAll(/(?:^|[;{}\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) n.add(m[1]);
    for (const m of code.matchAll(/(?:^|[;{}\n])\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) n.add(m[1]);
    for (const m of code.matchAll(/(?:^|[;{}\n])\s*class\s+([A-Za-z_$][\w$]*)/gm)) n.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) for (const p of m[1].split(',')) { const x = p.trim().split(':').pop().split('=')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(x)) n.add(x); }
    for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/gm)) for (const p of m[1].split(',')) { const x = p.trim(); if (/^[A-Za-z_$][\w$]*$/.test(x)) n.add(x); }
    return n;
  };

  let importFaults = 0;
  for (const f of files) {
    const src = readFileSync(join(TOOLS, f), 'utf8');
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*_lib\.js['"]/g)) {
      for (const p of m[1].split(',')) { const x = p.trim().split(/\s+as\s+/).pop().trim(); if (x) imported.add(x); }
    }
    const local = localsOf(src), code = strip(src);
    const missing = [...EXPORTS].filter((name) => {
      if (imported.has(name) || local.has(name)) return false;
      return new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(code)
        || new RegExp(`(?<![\\w$.])${name}\\s*[,)\\]}]`).test(code)
        || new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${name}\\b`).test(code);
    });
    const shadow = [...imported].filter((n) => local.has(n));
    if (missing.length) { console.log(`  MISSING IMPORT ${f}: ${missing.join(', ')}`); importFaults++; deepFail++; }
    if (shadow.length) { console.log(`  SHADOWED IMPORT ${f}: ${shadow.join(', ')}`); importFaults++; deepFail++; }
  }
  if (!importFaults) console.log('  imports: every _lib helper used is declared');

  console.log(deepFail ? `\ndeep: ${deepFail} problem(s)` : '\ndeep: clean');
  if (deepFail) process.exitCode = 1;
}

if (failures.length) process.exitCode = 1;
