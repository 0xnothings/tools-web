// changelog.js — scrape a releases/changelog page and summarize versions.
// Copyright (c) 2026 0xnothings
// @tool changelog
// @desc Summarize releases from the GitHub Releases API, a CHANGELOG.md or a releases HTML page
// @usage node tools/changelog.js https://github.com/nodejs/node --limit 5 --json
// @tags web,scrape,releases
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`changelog — release history summarizer

  node tools/changelog.js <github-url|repo|raw-changelog-url|file> [options]

  --limit <n>     releases to show (default 10)
  --since <v>     stop at this version/tag (exclusive)
  --major-only    only show x.0.0 releases
  --full          print the full release notes instead of a summary
  --json          machine-readable output
  -h, --help      this text

  Input forms:
    https://github.com/owner/repo     → uses the public Releases API
    owner/repo                        → same
    https://.../CHANGELOG.md          → parses a Keep-a-Changelog markdown file
    <local file>                      → parses it as markdown`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const src = o._[0];
if (!src) die('usage: node tools/changelog.js <github-url|owner/repo|changelog.md> [--limit 10]');

const limit = Math.max(1, num(get(o, 'limit'), 10));
const since = get(o, 'since', null);
const majorOnly = flag(o, 'major-only');

async function grab(url, accept = 'application/json') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } });
    return { ok: res.ok, status: res.status, body: await res.text(), final: res.url };
  } catch (e) { die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)} for ${url}`); }
  finally { clearTimeout(t); }
}

const clean = (s) => String(s || '').replace(/\r/g, '').trim();
const firstParagraph = (md) => {
  const lines = clean(md).split('\n');
  const buf = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (buf.length) break; else continue; }
    if (/^#{1,6}\s/.test(l)) continue;
    if (/^[-*]\s+\[?@?[\w-]+\]?/.test(l) && buf.length === 0 && lines.length > 4) continue;
    buf.push(l.replace(/^[-*]\s+/, '').replace(/^#+\s*/, ''));
    if (buf.length >= 3) break;
  }
  return buf.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').slice(0, 300);
};
const semver = (s) => {
  const m = String(s || '').match(/v?(\d+)\.(\d+)\.(\d+)(?:[-+]([A-Za-z0-9.\-]+))?/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, full: `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}` } : null;
};
const countBullets = (md) => (clean(md).match(/^\s*[-*+]\s+/gm) || []).length;
const breakingCount = (md) => (clean(md).match(/BREAKING|breaking change|⚠/g) || []).length;
const cveCount = (md) => (clean(md).match(/CVE-\d{4}-\d{4,7}/g) || []).length;

let releases = [];
let kind = 'unknown';
let repo = null;

const ghMatch = src.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i) || (!src.includes('/') && src.includes(' ') ? null : null);
const shortMatch = /^([\w.-]+)\/([\w.-]+)$/.exec(src);

if (ghMatch || shortMatch) {
  repo = ghMatch ? `${ghMatch[1]}/${ghMatch[2].replace(/\.git$/, '')}` : `${shortMatch[1]}/${shortMatch[2]}`;
  kind = 'github-releases-api';
  const res = await grab(`https://api.github.com/repos/${repo}/releases?per_page=${Math.min(100, Math.max(limit * 3, 20))}`);
  if (!res.ok && res.status === 404) die(`repository not found: ${repo}`);
  if (!res.ok && res.status === 403) die(`github API rate limited (HTTP 403) — retry later or pass a raw CHANGELOG.md URL`);
  if (!res.ok) die(`github API error: HTTP ${res.status}`);
  let list;
  try { list = JSON.parse(res.body); } catch { die('github API returned non-JSON'); }
  if (!Array.isArray(list)) die('unexpected GitHub API payload');
  releases = list.map((r) => {
    const v = semver(r.tag_name || r.name);
    return {
      version: r.tag_name || r.name,
      name: r.name && r.name !== r.tag_name ? r.name : null,
      semver: v ? v.full : null,
      major: v ? v.major : null,
      isMajor: v ? v.minor === 0 && v.patch === 0 : false,
      prerelease: Boolean(r.prerelease),
      draft: Boolean(r.draft),
      published: r.published_at,
      date: (r.published_at || r.created_at || '').slice(0, 10) || null,
      url: r.html_url,
      author: r.author?.login || null,
      assets: (r.assets || []).length,
      downloads: (r.assets || []).reduce((a, b) => a + (b.download_count || 0), 0),
      bullets: countBullets(r.body),
      breaking: breakingCount(r.body),
      cves: [...new Set(clean(r.body).match(/CVE-\d{4}-\d{4,7}/g) || [])],
      summary: firstParagraph(r.body),
    };
  });
} else {
  kind = 'markdown';
  let body;
  let final = src;
  if (/^https?:\/\//i.test(src)) { const r = await grab(src, 'text/plain, text/markdown, */*'); if (!r.ok) die(`fetch failed: HTTP ${r.status}`); body = r.body; final = r.final; }
  else { const { readFileSync } = await import('node:fs'); body = readFileSync(src, 'utf8'); }
  repo = final;
  const lines = body.replace(/\r/g, '').split('\n');
  const headingRe = /^##+\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.\-]+)?)\]?(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?/;
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { version: m[1], date: m[2] || null, lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  if (!blocks.length) die(`no version headings found in ${final} (expected "## 1.2.3 — YYYY-MM-DD")`);
  releases = blocks.map((b) => {
    const md = b.lines.join('\n');
    const v = semver(b.version);
    return {
      version: b.version,
      name: null,
      semver: v ? v.full : null,
      major: v ? v.major : null,
      isMajor: v ? v.minor === 0 && v.patch === 0 : false,
      prerelease: Boolean(v?.pre),
      draft: false,
      published: b.date,
      date: b.date,
      url: `${final}#${String(b.version).replace(/\./g, '')}`,
      author: null,
      assets: 0, downloads: 0,
      bullets: countBullets(md),
      breaking: breakingCount(md),
      cves: [...new Set(md.match(/CVE-\d{4}-\d{4,7}/g) || [])],
      summary: firstParagraph(md),
      notes: clean(md).slice(0, flag(o, 'full') ? 100000 : 1200),
    };
  });
}

let filtered = releases.filter((r) => !r.draft);
if (majorOnly) filtered = filtered.filter((r) => r.isMajor);
if (since && since !== true) {
  const idx = filtered.findIndex((r) => String(r.version).includes(String(since)));
  if (idx >= 0) filtered = filtered.slice(0, idx);
}
const shown = filtered.slice(0, limit);

const stats = {
  totalReleases: releases.length,
  shown: shown.length,
  breakingTotal: releases.reduce((a, b) => a + b.breaking, 0),
  cveTotal: [...new Set(releases.flatMap((r) => r.cves))].length,
  latest: releases[0]?.version || null,
  latestDate: releases[0]?.date || null,
  versions: releases.map((r) => r.version),
};

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: src, sourceType: kind, repo, stats, releases: shown.map((r) => (flag(o, 'full') ? r : { ...r, notes: undefined })) }, null, 2));
  process.exitCode = 0;
} else if (flag(o, 'full')) {
  for (const r of shown) { console.log(`\n## ${r.version} — ${r.date || 'no date'}`); console.log(clean(r.notes || r.summary)); }
  process.exitCode = 0;
} else {
  console.log(`${repo}  (${kind})`);
  console.log(`${stats.totalReleases} releases · latest ${stats.latest || '—'} ${stats.latestDate ? `(${stats.latestDate})` : ''} · ${stats.breakingTotal} breaking mentions · ${stats.cveTotal} CVEs\n`);
  console.log(table(shown.map((r) => ({
    version: String(r.version).slice(0, 18),
    date: r.date || '',
    kind: r.prerelease ? 'pre' : r.isMajor ? 'MAJOR' : 'patch',
    items: r.bullets,
    break: r.breaking || '',
    cve: r.cves.length || '',
    summary: (r.summary || '').slice(0, 52),
  }))));
  if (filtered.length > shown.length) console.log(`\n${filtered.length - shown.length} more releases not shown (--limit ${limit})`);
}
process.exitCode = 0;
