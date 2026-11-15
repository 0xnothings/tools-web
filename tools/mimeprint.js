// mimeprint.js — file extension to MIME type and back.
// Copyright (c) 2026 0xnothings
// @tool mimeprint
// @desc Map file extensions to MIME types (and back) with the correct Content-Type header to send
// @usage node tools/mimeprint.js .webp svg .webmanifest --json
// @tags web,http,reference
import { args, get, flag, die, inputLines, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`mimeprint — MIME type lookup

  node tools/mimeprint.js <.ext | mime/type | filename>... [options]

  --reverse     treat arguments as MIME types and list matching extensions
  --header      print the full header line to send (Content-Type: ...; charset=...)
  --nginx       print an nginx "types { }" block for the matches
  --charset <c> charset to append for text types (default utf-8)
  --list        dump the whole table
  --json        machine-readable output
  -h, --help    this text

  Accepts extensions with or without the dot, full filenames, and MIME types.`);
  process.exit(0);
}

const TABLE = [
  ['html', 'text/html', 'text', true], ['htm', 'text/html', 'text', true],
  ['css', 'text/css', 'text', true], ['js', 'text/javascript', 'text', true], ['mjs', 'text/javascript', 'text', true],
  ['cjs', 'text/javascript', 'text', true], ['json', 'application/json', 'text', true],
  ['jsonld', 'application/ld+json', 'text', true], ['map', 'application/json', 'text', true],
  ['xml', 'application/xml', 'text', true], ['xsl', 'application/xml', 'text', true],
  ['rss', 'application/rss+xml', 'text', true], ['atom', 'application/atom+xml', 'text', true],
  ['txt', 'text/plain', 'text', true], ['md', 'text/markdown', 'text', true], ['csv', 'text/csv', 'text', true],
  ['tsv', 'text/tab-separated-values', 'text', true], ['ics', 'text/calendar', 'text', true],
  ['vtt', 'text/vtt', 'text', true], ['rtf', 'application/rtf', 'binary', false],
  ['png', 'image/png', 'image', false], ['jpg', 'image/jpeg', 'image', false], ['jpeg', 'image/jpeg', 'image', false],
  ['jpe', 'image/jpeg', 'image', false], ['gif', 'image/gif', 'image', false], ['webp', 'image/webp', 'image', false],
  ['avif', 'image/avif', 'image', false], ['svg', 'image/svg+xml', 'image', true], ['ico', 'image/x-icon', 'image', false],
  ['bmp', 'image/bmp', 'image', false], ['tif', 'image/tiff', 'image', false], ['tiff', 'image/tiff', 'image', false],
  ['heic', 'image/heic', 'image', false], ['heif', 'image/heif', 'image', false], ['apng', 'image/apng', 'image', false],
  ['jxl', 'image/jxl', 'image', false], ['psd', 'image/vnd.adobe.photoshop', 'image', false],
  ['woff', 'font/woff', 'font', false], ['woff2', 'font/woff2', 'font', false], ['ttf', 'font/ttf', 'font', false],
  ['otf', 'font/otf', 'font', false], ['eot', 'application/vnd.ms-fontobject', 'font', false],
  ['mp3', 'audio/mpeg', 'audio', false], ['wav', 'audio/wav', 'audio', false], ['ogg', 'audio/ogg', 'audio', false],
  ['oga', 'audio/ogg', 'audio', false], ['opus', 'audio/opus', 'audio', false], ['flac', 'audio/flac', 'audio', false],
  ['aac', 'audio/aac', 'audio', false], ['m4a', 'audio/mp4', 'audio', false], ['weba', 'audio/webm', 'audio', false],
  ['mid', 'audio/midi', 'audio', false], ['midi', 'audio/midi', 'audio', false],
  ['mp4', 'video/mp4', 'video', false], ['m4v', 'video/mp4', 'video', false], ['webm', 'video/webm', 'video', false],
  ['ogv', 'video/ogg', 'video', false], ['mov', 'video/quicktime', 'video', false], ['avi', 'video/x-msvideo', 'video', false],
  ['mkv', 'video/x-matroska', 'video', false], ['m3u8', 'application/vnd.apple.mpegurl', 'video', true],
  ['ts', 'video/mp2t', 'video', false], ['flv', 'video/x-flv', 'video', false], ['wmv', 'video/x-ms-wmv', 'video', false],
  ['pdf', 'application/pdf', 'document', false], ['doc', 'application/msword', 'document', false],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', false],
  ['xls', 'application/vnd.ms-excel', 'document', false],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document', false],
  ['ppt', 'application/vnd.ms-powerpoint', 'document', false],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document', false],
  ['odt', 'application/vnd.oasis.opendocument.text', 'document', false],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet', 'document', false],
  ['odp', 'application/vnd.oasis.opendocument.presentation', 'document', false],
  ['epub', 'application/epub+zip', 'document', false], ['mobi', 'application/x-mobipocket-ebook', 'document', false],
  ['zip', 'application/zip', 'archive', false], ['gz', 'application/gzip', 'archive', false],
  ['tgz', 'application/gzip', 'archive', false], ['tar', 'application/x-tar', 'archive', false],
  ['bz2', 'application/x-bzip2', 'archive', false], ['xz', 'application/x-xz', 'archive', false],
  ['7z', 'application/x-7z-compressed', 'archive', false], ['rar', 'application/vnd.rar', 'archive', false],
  ['zst', 'application/zstd', 'archive', false], ['br', 'application/brotli', 'archive', false],
  ['exe', 'application/vnd.microsoft.portable-executable', 'binary', false],
  ['msi', 'application/x-msdownload', 'binary', false], ['dmg', 'application/x-apple-diskimage', 'binary', false],
  ['apk', 'application/vnd.android.package-archive', 'binary', false],
  ['deb', 'application/vnd.debian.binary-package', 'binary', false],
  ['rpm', 'application/x-rpm', 'binary', false], ['iso', 'application/x-iso9660-image', 'binary', false],
  ['wasm', 'application/wasm', 'binary', false], ['bin', 'application/octet-stream', 'binary', false],
  ['sh', 'application/x-sh', 'text', true], ['py', 'text/x-python', 'text', true],
  ['rb', 'text/x-ruby', 'text', true], ['php', 'application/x-httpd-php', 'text', true],
  ['c', 'text/x-c', 'text', true], ['h', 'text/x-c', 'text', true], ['cpp', 'text/x-c++', 'text', true],
  ['yml', 'application/yaml', 'text', true], ['yaml', 'application/yaml', 'text', true],
  ['toml', 'application/toml', 'text', true], ['webmanifest', 'application/manifest+json', 'text', true],
  ['appcache', 'text/cache-manifest', 'text', true], ['webapp', 'application/x-web-app-manifest+json', 'text', true],
  ['form', 'application/x-www-form-urlencoded', 'text', true], ['multipart', 'multipart/form-data', 'text', true],
];

const CHARSET = String(get(o, 'charset', 'utf-8'));
const BY_EXT = new Map(TABLE.map(([ext, mime, cat, textual]) => [ext, { ext, mime, category: cat, textual }]));
const BY_MIME = new Map();
for (const [ext, mime, cat, textual] of TABLE) {
  if (!BY_MIME.has(mime)) BY_MIME.set(mime, []);
  BY_MIME.get(mime).push({ ext, mime, category: cat, textual });
}

const contentType = (e) => (e.textual ? `${e.mime}; charset=${CHARSET}` : e.mime);

function normalize(token) {
  let t = String(token).trim();
  if (!t) return null;
  if (t.includes('/')) return { kind: 'mime', value: t.toLowerCase().split(';')[0].trim() };
  t = t.split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop();
  const m = /\.([A-Za-z0-9]+)$/.exec(t);
  const ext = m ? m[1].toLowerCase() : t.replace(/^\./, '').toLowerCase();
  return { kind: 'ext', value: ext, filename: t };
}

let inputs;
if (o._.length) inputs = o._;
else {
  const { readInput } = await import('../_lib.js');
  const stdin = await readInput(null);
  inputs = stdin.trim() ? stdin.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : null;
}

if (flag(o, 'list')) {
  if (flag(o, 'json')) console.log(JSON.stringify({ count: TABLE.length, entries: TABLE.map(([ext, mime, category, textual]) => ({ ext, mime, category, contentType: textual ? `${mime}; charset=${CHARSET}` : mime })) }, null, 2));
  else console.log(table(TABLE.map(([ext, mime, category]) => ({ ext: '.' + ext, mime, category }))));
  process.exitCode = 0;
} else if (!inputs) {
  console.log(`mimeprint — ${TABLE.length} types known`);
  console.log('usage: node tools/mimeprint.js .webp svg application/json --json');
  console.log('       node tools/mimeprint.js --list | --reverse image/jpeg');
  process.exitCode = 0;
} else {
  const queries = inputs.map(normalize).filter(Boolean);
  const results = queries.map((q) => {
    if (q.kind === 'ext') {
      const hit = BY_EXT.get(q.value);
      return hit
        ? { query: q.filename || '.' + q.value, ...hit, contentType: contentType(hit), found: true }
        : { query: q.filename || '.' + q.value, ext: q.value, found: false, mime: 'application/octet-stream', category: 'unknown', contentType: 'application/octet-stream', note: 'unknown extension — a server will usually send application/octet-stream' };
    }
    const hits = BY_MIME.get(q.value);
    if (hits) return { query: q.value, found: true, mime: q.value, extensions: hits.map((h) => '.' + h.ext), category: hits[0].category, contentType: hits[0].textual ? `${q.value}; charset=${CHARSET}` : q.value };
    const prefix = TABLE.find(([, mime]) => mime.startsWith(q.value.split('/')[0] + '/'));
    return { query: q.value, found: false, mime: q.value, extensions: [], note: `no exact match${prefix ? ` — the table does know ${prefix[1]}` : ''}` };
  });

  if (flag(o, 'json')) {
    console.log(JSON.stringify({ count: results.length, charset: CHARSET, results }, null, 2));
  } else if (flag(o, 'header')) {
    for (const r of results) console.log(`Content-Type: ${r.contentType}`);
  } else if (flag(o, 'nginx') || flag(o, 'reverse')) {
    const exts = results.flatMap((r) => (r.extensions ? r.extensions.map((e) => ({ ext: e.replace(/^\./, ''), mime: r.mime })) : r.found ? [{ ext: r.ext, mime: r.mime }] : []));
    if (flag(o, 'nginx')) {
      console.log('types {');
      const seen = new Set();
      for (const e of exts) { const k = `${e.ext}|${e.mime}`; if (seen.has(k)) continue; seen.add(k); console.log(`    ${e.mime.padEnd(64)} ${e.ext};`); }
      console.log('}');
    } else {
      console.log(table(results.map((r) => ({ query: r.query, found: r.found ? 'yes' : 'no', mime: r.mime, extensions: (r.extensions || (r.found ? ['.' + r.ext] : [])).join(' ') }))));
    }
  } else {
    console.log(table(results.map((r) => ({
      query: r.query.slice(0, 30),
      mime: r.found ? r.mime.slice(0, 56) : '(unknown)',
      category: r.category || '',
      header: r.contentType.slice(0, 46),
    }))));
    const unknown = results.filter((r) => !r.found);
    if (unknown.length) console.log(`\n${unknown.length} unknown — servers default these to application/octet-stream`);
  }
  process.exitCode = 0;
}
