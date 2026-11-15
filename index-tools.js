#!/usr/bin/env node
// index-tools.js — scan tools/ and regenerate the README catalogue table.
// Copyright (c) 2026 0xnothings
// Usage: node index-tools.js
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(ROOT, 'tools');
const START = '<!-- CATALOGUE:START -->';
const END = '<!-- CATALOGUE:END -->';

function readMeta(file) {
  const src = readFileSync(join(TOOLS, file), 'utf8');
  const grab = (k) => {
    const m = src.match(new RegExp('^//\\s*@' + k + '\\s+(.+)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const rawUsage = grab('usage') || `node tools/${file}`;
  return {
    link: `tools/${file}`,
    name: grab('tool') || file.replace(/\.js$/, ''),
    desc: grab('desc') || '(no description)',
    usage: rawUsage.replace(/^node\s+\S*?tools[\\/]/, 'node tools/'),
    tags: (grab('tags') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const rows = readdirSync(TOOLS)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readMeta(f))
  .sort((a, b) => a.name.localeCompare(b.name));

const table = [
  '| Tool | Description | Tags | Usage |',
  '|---|---|---|---|',
  ...rows.map((r) => `| [\`${r.name}\`](${r.link}) | ${r.desc} | ${r.tags.join(', ')} | \`${r.usage}\` |`),
].join('\n');

const block = `${START}\n\n**${rows.length} tools**\n\n${table}\n\n${END}`;

const readmePath = join(ROOT, 'README.md');
let readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';

const s = readme.indexOf(START);
const e = readme.indexOf(END);

if (s !== -1 && e !== -1 && e > s) {
  readme = readme.slice(0, s) + block + readme.slice(e + END.length);
} else {
  readme = `# ${basename(ROOT)}\n\n${block}\n`;
}

writeFileSync(readmePath, readme, 'utf8');
writeFileSync(join(ROOT, 'catalogue.json'), JSON.stringify(rows, null, 2), 'utf8');
console.log(`indexed ${rows.length} tools -> README.md + catalogue.json`);
