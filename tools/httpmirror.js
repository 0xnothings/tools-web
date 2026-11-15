// httpmirror.js — local request/response archive, replayable offline.
// Copyright (c) 2026 0xnothings
// @tool httpmirror
// @desc Crawl a URL list into a single JSON archive holding request and response records (status, headers, base64 body) plus an offline replay command
// @usage node tools/httpmirror.js urls.txt --out mirror.json --max 10
// @tags web,archive,http
import { args, get, num, flag, die, inputLines, table, nowISO, sleep } from '../_lib.js';
import { writeFileSync, readFileSync } from 'node:fs';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`httpmirror — request/response archive

  node tools/httpmirror.js <url-list|url> [options]

  --out <file>       archive path (default mirror.json)
  --max <n>          cap the number of URLs captured (default 20)
  --delay <ms>       pause between requests (default 250)
  --binary           also archive non-text response bodies (base64)
  --replay <file>    replay an archive offline instead of crawling
  --json             print the archive summary as JSON
  -h, --help         this text

  The archive is one plain JSON file: { meta, records: [{ request, response }] }
  Bodies are stored as utf8 text, or base64 when --binary and non-text.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const out = String(get(o, 'out', 'mirror.json'));
const max = Math.max(1, num(get(o, 'max'), 20));
const delay = Math.max(0, num(get(o, 'delay'), 250));
const wantBinary = flag(o, 'binary');
const replayFile = get(o, 'replay', null);

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/i;

if (replayFile) {
  let archive;
  try { archive = JSON.parse(readFileSync(String(replayFile), 'utf8')); } catch (e) { die(`archive unreadable: ${e.message.slice(0, 100)}`); }
  const records = archive.records || [];
  if (flag(o, 'json')) {
    console.log(JSON.stringify({ replayOf: replayFile, meta: archive.meta, records: records.length, entries: records.map((r) => ({ url: r.request.url, method: r.request.method, status: r.response.status, bytes: r.response.bodyLength, at: r.capturedAt })) }, null, 2));
  } else {
    console.log(`replaying ${replayFile} offline — ${records.length} record(s) captured ${archive.meta?.created || 'unknown'}\n`);
    console.log(table(records.map((r) => ({
      method: r.request.method,
      status: r.response.status,
      bytes: r.response.bodyLength ?? 0,
      url: String(r.request.url).replace(/^https?:\/\//, '').slice(0, 52),
    }))));
    console.log('\neach record holds the full response headers and body — this replay needs no network');
  }
  process.exit(0);
}

const src = o._[0];
if (!src) die('usage: node tools/httpmirror.js <url-list|url> [--out mirror.json]');
const urls = /^https?:\/\//i.test(src) ? [src] : await inputLines(src);
if (!urls.length) die('no URLs to capture');

const records = [];
for (const url of urls.slice(0, max)) {
  if (!/^https?:\/\//i.test(url)) continue;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const isText = TEXTUAL.test(type) || (!type && buf.length < 200000);
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    records.push({
      capturedAt: nowISO(),
      request: { method: 'GET', url, headers: { 'user-agent': UA } },
      response: {
        status: res.status,
        statusText: res.statusText,
        finalUrl: res.url,
        headers,
        contentType: type,
        bodyLength: buf.length,
        bodyEncoding: isText ? 'utf8' : (wantBinary ? 'base64' : 'omitted'),
        body: isText ? buf.toString('utf8').slice(0, 500000) : (wantBinary ? buf.toString('base64') : null),
        elapsedMs: Date.now() - started,
      },
    });
  } catch (e) {
    records.push({
      capturedAt: nowISO(),
      request: { method: 'GET', url, headers: { 'user-agent': UA } },
      response: { status: 0, statusText: e.name === 'AbortError' ? 'timeout' : 'error', headers: {}, contentType: '', bodyLength: 0, bodyEncoding: 'utf8', body: null, error: e?.cause?.code || e.message, elapsedMs: Date.now() - started },
    });
  } finally { clearTimeout(timer); }
  if (delay) await sleep(delay);
}

const archive = {
  meta: {
    tool: 'httpmirror',
    version: 1,
    created: nowISO(),
    source: src,
    userAgent: UA,
    recordCount: records.length,
    totalBytes: records.reduce((a, r) => a + (r.response.bodyLength || 0), 0),
    note: 'Bodies are utf8 text or base64; replay with: node tools/httpmirror.js --replay <file>',
  },
  records,
};

writeFileSync(out, JSON.stringify(archive, null, 2), 'utf8');

if (flag(o, 'json')) {
  console.log(JSON.stringify({ out, meta: archive.meta, records: records.map((r) => ({ url: r.request.url, status: r.response.status, bytes: r.response.bodyLength, encoding: r.response.bodyEncoding })) }, null, 2));
} else {
  console.log(`captured ${records.length} response(s) into ${out} (${(archive.meta.totalBytes / 1024).toFixed(1)} KiB of bodies)\n`);
  console.log(table(records.map((r) => ({
    status: r.response.status,
    bytes: r.response.bodyLength,
    encoding: r.response.bodyEncoding,
    type: (r.response.contentType || '—').slice(0, 26),
    url: String(r.request.url).replace(/^https?:\/\//, '').slice(0, 44),
  }))));
  console.log(`\nreplay offline: node tools/httpmirror.js --replay ${out}`);
}
