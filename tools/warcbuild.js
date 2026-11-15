#!/usr/bin/env node
// warcbuild.js — write a minimal valid WARC 1.1 file from a crawl.
// Copyright (c) 2026 0xnothings
// @tool warcbuild
// @desc Crawl URLs and write a hand-assembled WARC 1.1 file with warcinfo, request and response records using correct CRLF line endings and Content-Length blocks
// @usage node tools/warcbuild.js urls.txt --out crawl.warc --max 5
// @tags web,archive,warc
import { args, get, num, flag, die, inputLines, table, nowISO, sleep } from '../_lib.js';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`warcbuild — write a WARC 1.1 file

  node tools/warcbuild.js <url-list|url> [options]

  --out <file>     WARC path (default crawl.warc)
  --max <n>        cap URLs captured (default 10)
  --delay <ms>     pause between requests (default 250)
  --operator <s>   value for the operator field (default 0xnothings)
  --json           print a record summary as JSON
  -h, --help       this text

  Emits one warcinfo record, then a request/response pair per URL.
  Line endings are CRLF as the WARC spec requires.`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const out = String(get(o, 'out', 'crawl.warc'));
const max = Math.max(1, num(get(o, 'max'), 10));
const delay = Math.max(0, num(get(o, 'delay'), 250));
const operatorName = String(get(o, 'operator', '0xnothings'));

const src = o._[0];
if (!src) die('usage: node tools/warcbuild.js <url-list|url> [--out crawl.warc]');
const urls = /^https?:\/\//i.test(src) ? [src] : await inputLines(src);
if (!urls.length) die('no URLs to capture');

const CRLF = '\r\n';
const chunks = [];
const summary = [];

function record({ type, uri, headers, content }) {
  const body = content || '';
  const msgtype = type === 'request' ? 'request' : type === 'response' ? 'response' : null;
  const head = [
    `WARC/1.1`,
    `WARC-Type: ${type}`,
    `WARC-Date: ${nowISO().replace(/\.\d+Z$/, 'Z')}`,
    `WARC-Record-ID: <urn:uuid:${randomUUID()}>`,
    `WARC-Content-Length: ${Buffer.byteLength(body, 'binary')}`,
    ...headers.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`),
    msgtype ? `Content-Type: application/http; msgtype=${msgtype}` : `Content-Type: text/plain`,
  ];
  return head.join(CRLF) + CRLF + CRLF + body + CRLF + CRLF;
}

const infoBody = `software: 0xnothings warcbuild/1.0\r\nformat: WARC File Format 1.1\r\noperator: ${operatorName}\r\nsource: ${src}\r\n`;
chunks.push(record({ type: 'warcinfo', uri: 'urn:warcbuild:warcinfo', headers: [['WARC-Filename', out.split(/[\\/]/).pop()]], content: infoBody }));

for (const url of urls.slice(0, max)) {
  if (!/^https?:\/\//i.test(url)) continue;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const started = new Date();
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    const buf = Buffer.from(await res.arrayBuffer());
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;
    const statusLine = `HTTP/1.1 ${res.status} ${res.statusText || ''}`.trim();
    const resHead = [statusLine, ...[...res.headers].map(([k, v]) => `${k}: ${v}`)].join(CRLF) + CRLF + CRLF;
    const dateStr = started.toISOString().replace(/\.\d+Z$/, 'Z');

    chunks.push(record({
      type: 'request',
      uri: url,
      headers: [['WARC-Target-URI', url]],
      content: [`GET ${new globalThis.URL(url).pathname}${new globalThis.URL(url).search} HTTP/1.1`, `Host: ${new globalThis.URL(url).host}`, `User-Agent: ${UA}`, '', ''].join(CRLF),
    }));
    chunks.push(record({
      type: 'response',
      uri: url,
      headers: [['WARC-Target-URI', url], ['WARC-Payload-Digest', `sha256:${Buffer.from(await cryptoDigest(buf)).toString('hex')}`]],
      content: resHead + buf.toString('binary'),
    }));
    summary.push({ type: 'response', status: res.status, bytes: buf.length, url: url.replace(/^https?:\/\//, '').slice(0, 50) });
  } catch (e) {
    summary.push({ type: 'error', status: e.name === 'AbortError' ? 'timeout' : 'error', bytes: 0, url: url.replace(/^https?:\/\//, '').slice(0, 50) });
  } finally { clearTimeout(timer); }
  if (delay) await sleep(delay);
}

async function cryptoDigest(buf) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buf).digest();
}

const fileBody = chunks.join(CRLF);
writeFileSync(out, fileBody, 'binary');

const bytes = Buffer.byteLength(fileBody, 'binary');
if (flag(o, 'json')) {
  console.log(JSON.stringify({ out, bytes, records: summary.length * 2 + 1, urls: summary }, null, 2));
} else {
  console.log(`wrote ${out} — ${(bytes / 1024).toFixed(1)} KiB, ${chunks.length} WARC record(s) (1 warcinfo + ${summary.length * 2} request/response)\n`);
  console.log(table(summary.map((s) => ({ status: s.status, bytes: s.bytes, url: s.url }))));
  console.log('\nverify with any WARC reader, or: head -c 200 ' + out);
}
