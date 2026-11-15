#!/usr/bin/env node
// musicsearch.js — search public music metadata without an account.
// Copyright (c) 2026 0xnothings
// @tool musicsearch
// @desc Query the iTunes Search API and MusicBrainz for tracks, artists and albums; rate-limited and cached
// @usage node tools/musicsearch.js "daft punk" --type artist --limit 10 --json
// @tags web,api,music
import { args, get, num, flag, die, table, sleep } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`musicsearch — public music metadata search

  node tools/musicsearch.js "<query>" [options]

  --type <t>       song | artist | album | all (default: song)
  --limit <n>      results per source (default: 10, max 50)
  --source <s>     itunes | brainz | both (default: both)
  --country <cc>   itunes storefront (default: US)
  --json           machine-readable output
  -h, --help       this text

  Uses the public iTunes Search API and MusicBrainz — no keys, no accounts.
  MusicBrainz requires a descriptive User-Agent and 1 req/sec; this tool
  obeys that rate limit automatically.`);
  process.exit(0);
}

const query = o._[0];
if (!query) die('usage: node tools/musicsearch.js "<query>" [--type song|artist|album]');

const typeMap = { song: 'musicTrack', artist: 'musicArtist', album: 'album', all: 'musicTrack' };
const type = String(get(o, 'type', 'song'));
const limit = Math.min(num(get(o, 'limit'), 10), 50);
const source = String(get(o, 'source', 'both'));
const country = String(get(o, 'country', 'US'));
const UA = '0xnothings-tools/1.0 (https://github.com/0xnothings)';

async function j(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message) }; }
  finally { clearTimeout(t); }
}

async function itunes() {
  const term = typeMap[type] || 'musicTrack';
  const r = await j(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=${term}&limit=${limit}&country=${country}`);
  if (r.error) return { source: 'itunes', error: r.error };
  return {
    source: 'itunes',
    results: (r.results || []).map((x) => ({
      kind: x.wrapperType === 'artist' ? 'artist' : x.collectionType === 'Album' ? 'album' : 'track',
      title: x.trackName || x.collectionName || x.artistName,
      artist: x.artistName, album: x.collectionName || null,
      year: x.releaseDate ? x.releaseDate.slice(0, 4) : null,
      duration: x.trackTimeMillis ? `${Math.floor(x.trackTimeMillis / 60000)}:${String(Math.floor(x.trackTimeMillis % 60000 / 1000)).padStart(2, '0')}` : null,
      genre: x.primaryGenreName || null, preview: x.previewUrl ? 'available' : null,
      url: x.trackViewUrl || x.artistLinkUrl || null,
    })),
  };
}

async function brainz() {
  const kind = type === 'artist' ? 'artist' : type === 'album' ? 'release-group' : 'recording';
  const r = await j(`https://musicbrainz.org/ws/2/${kind}/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`);
  if (r.error) return { source: 'musicbrainz', error: r.error };
  const items = r.recordings || r.artists || r['release-groups'] || [];
  return {
    source: 'musicbrainz',
    results: items.map((x) => ({
      kind, title: x.title || x.name, artist: x['artist-credit']?.map((a) => a.name).join(', ') || x.name,
      album: null, year: (x['first-release-date'] || x.date || '').slice(0, 4) || null,
      duration: x.length ? `${Math.floor(x.length / 60000)}:${String(Math.floor(x.length % 60000 / 1000)).padStart(2, '0')}` : null,
      genre: x.tags?.[0]?.name || null, score: x.score, mbid: x.id, url: `https://musicbrainz.org/${kind}/${x.id}`,
    })),
  };
}

const out = [];
if (source === 'itunes' || source === 'both') out.push(await itunes());
if (source === 'brainz' || source === 'both') { if (source === 'both') await sleep(1100); out.push(await brainz()); }

if (flag(o, 'json')) { console.log(JSON.stringify({ query, type, sources: out }, null, 2)); process.exit(0); }
for (const src of out) {
  console.log(`\n=== ${src.source} ===`);
  if (src.error) { console.log('  ' + src.error); continue; }
  if (!src.results.length) { console.log('  no results'); continue; }
  console.log(table(src.results.map((r) => ({ kind: r.kind, title: (r.title || '').slice(0, 42), artist: (r.artist || '').slice(0, 24), year: r.year || '', len: r.duration || '', score: r.score ?? '' }))));
}
