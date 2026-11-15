// embedparse.js — parse an embed/oEmbed URL into id + canonical embed HTML.
// Copyright (c) 2026 0xnothings
// @tool embedparse
// @desc Turn a media URL (YouTube/Vimeo/Twitter/Spotify/...) into provider, id and ready-to-paste embed HTML
// @usage node tools/embedparse.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --json
// @tags web,media,embed
import { args, get, num, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`embedparse — media URL to embed HTML

  node tools/embedparse.js <url>... [options]

  --size <w>x<h>    iframe dimensions (default 640x360)
  --oembed          also call the provider's oEmbed endpoint for the authoritative data
  --html            print only the embed HTML (one per line, pipe-friendly)
  --json            machine-readable output
  -h, --help        this text

  Providers: YouTube (incl. shorts/live), Vimeo, Twitter/X, Spotify, SoundCloud,
  Reddit, TikTok, Twitch, Dailymotion, Loom, Streamable, Imgur, Giphy, GitHub Gist,
  CodePen, CodeSandbox, Google Maps, Amp, and generic oEmbed discovery.`);
  process.exit(0);
}

const UA = '0xnothings-tools/1.0 (+https://github.com/0xnothings)';
const sizeArg = String(get(o, 'size', '640x360'));
const sizeMatch = /^(\d{2,4})x(\d{2,4})$/i.exec(sizeArg);
const W = sizeMatch ? Number(sizeMatch[1]) : 640;
const H = sizeMatch ? Number(sizeMatch[2]) : 360;

const PROVIDERS = [
  {
    name: 'YouTube', id: 'youtube', re: /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{6,})/i,
    canonical: (id) => `https://www.youtube.com/watch?v=${id}`,
    embed: (id, w, h) => `<iframe width="${w}" height="${h}" src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`,
    oembed: (id) => `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
    thumb: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  },
  {
    name: 'Vimeo', id: 'vimeo', re: /vimeo\.com\/(?:video\/)?(\d{5,})/i,
    canonical: (id) => `https://vimeo.com/${id}`,
    embed: (id, w, h) => `<iframe src="https://player.vimeo.com/video/${id}" width="${w}" height="${h}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="Vimeo video"></iframe>`,
    oembed: (id) => `https://vimeo.com/api/oembed.json?url=https%3A//vimeo.com/${id}`,
  },
  {
    name: 'Twitter/X', id: 'twitter', re: /(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i, multi: true,
    canonical: (id) => `https://twitter.com/i/status/${id.split('/')[1]}`,
    embed: (id, w, h) => {
      const [user, tweet] = id.split('/');
      return `<blockquote class="twitter-tweet"><a href="https://twitter.com/${user}/status/${tweet}"></a></blockquote>\n<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`;
    },
    oembed: (id) => `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${id.split('/')[1]}`)}`,
  },
  {
    name: 'Spotify', id: 'spotify', re: /open\.spotify\.com\/(?:intl-\w+\/)?(track|album|playlist|episode|show|artist)\/([\w]+)/i, multi: true,
    canonical: (id) => `https://open.spotify.com/${id}`,
    embed: (id, w, h) => `<iframe style="border-radius:12px" src="https://open.spotify.com/embed/${id}" width="100%" height="${id.startsWith('track') ? 152 : 352}" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`,
    oembed: (id) => `https://open.spotify.com/oembed?url=https://open.spotify.com/${id}`,
  },
  {
    name: 'SoundCloud', id: 'soundcloud', re: /soundcloud\.com\/([\w-]+\/[\w-]+)/i,
    canonical: (id) => `https://soundcloud.com/${id}`,
    embed: (id, w, h) => `<iframe width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${id}`)}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true"></iframe>`,
    oembed: (id) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(`https://soundcloud.com/${id}`)}`,
  },
  {
    name: 'Reddit', id: 'reddit', re: /reddit\.com\/r\/([\w-]+)\/comments\/(\w+)/i, multi: true,
    canonical: (id) => `https://www.reddit.com/r/${id.split('/')[0]}/comments/${id.split('/')[1]}/`,
    embed: (id, w, h) => {
      const [sub, post] = id.split('/');
      return `<blockquote class="reddit-embed-bq" style="height:${h}px" data-embed-height="${h}"><a href="https://www.reddit.com/r/${sub}/comments/${post}/">View on Reddit</a></blockquote>\n<script async src="https://embed.reddit.com/widgets.js"></script>`;
    },
    oembed: (id) => `https://www.reddit.com/oembed?url=${encodeURIComponent(`https://www.reddit.com/r/${id.split('/')[0]}/comments/${id.split('/')[1]}/`)}`,
  },
  {
    name: 'TikTok', id: 'tiktok', re: /tiktok\.com\/@([\w.]+)\/video\/(\d+)/i, multi: true,
    canonical: (id) => `https://www.tiktok.com/@${id.split('/')[0]}/video/${id.split('/')[1]}`,
    embed: (id, w, h) => `<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@${id.split('/')[0]}/video/${id.split('/')[1]}" data-video-id="${id.split('/')[1]}" style="max-width:605px;min-width:325px;"><section></section></blockquote>\n<script async src="https://www.tiktok.com/embed.js"></script>`,
    oembed: (id) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/@${id.split('/')[0]}/video/${id.split('/')[1]}`)}`,
  },
  {
    name: 'Twitch', id: 'twitch', re: /twitch\.tv\/(?:videos\/(\d+)|([\w]+))/i,
    canonical: (id) => (id.startsWith('video:') ? `https://www.twitch.tv/videos/${id.slice(6)}` : `https://www.twitch.tv/${id}`),
    embed: (id, w, h) => {
      const isVideo = id.startsWith('video:');
      const parent = 'localhost';
      return isVideo
        ? `<iframe src="https://player.twitch.tv/?video=${id.slice(6)}&parent=${parent}&autoplay=false" height="${h}" width="${w}" allowfullscreen></iframe>`
        : `<iframe src="https://player.twitch.tv/?channel=${id}&parent=${parent}&autoplay=false" height="${h}" width="${w}" allowfullscreen></iframe>`;
    },
  },
  {
    name: 'Dailymotion', id: 'dailymotion', re: /dailymotion\.com\/video\/([\w]+)/i,
    canonical: (id) => `https://www.dailymotion.com/video/${id}`,
    embed: (id, w, h) => `<iframe frameborder="0" width="${w}" height="${h}" src="https://www.dailymotion.com/embed/video/${id}" allowfullscreen allow="autoplay"></iframe>`,
    oembed: (id) => `https://www.dailymotion.com/services/oembed?url=https%3A//www.dailymotion.com/video/${id}&format=json`,
  },
  {
    name: 'Loom', id: 'loom', re: /loom\.com\/share\/([\w]+)/i,
    canonical: (id) => `https://www.loom.com/share/${id}`,
    embed: (id, w, h) => `<iframe src="https://www.loom.com/embed/${id}" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="width:${w}px;height:${h}px;"></iframe>`,
    oembed: (id) => `https://www.loom.com/v1/oembed?url=${encodeURIComponent(`https://www.loom.com/share/${id}`)}`,
  },
  {
    name: 'Streamable', id: 'streamable', re: /streamable\.com\/([\w]+)/i,
    canonical: (id) => `https://streamable.com/${id}`,
    embed: (id, w, h) => `<iframe src="https://streamable.com/e/${id}" width="${w}" height="${h}" frameborder="0" allowfullscreen></iframe>`,
  },
  {
    name: 'Imgur', id: 'imgur', re: /imgur\.com\/(?:a|gallery)?\/?([\w]+)/i,
    canonical: (id) => `https://imgur.com/${id}`,
    embed: (id, w, h) => `<blockquote class="imgur-embed-pub" lang="en" data-id="${id}"><a href="https://imgur.com/${id}">View post on imgur.com</a></blockquote>\n<script async src="//s.imgur.com/min/embed.js" charset="utf-8"></script>`,
  },
  {
    name: 'Giphy', id: 'giphy', re: /giphy\.com\/(?:gifs|media|embed)\/(?:[\w-]+-)?([\w]{5,})/i,
    canonical: (id) => `https://giphy.com/gifs/${id}`,
    embed: (id, w, h) => `<iframe src="https://giphy.com/embed/${id}" width="${w}" height="${h}" frameborder="0" class="giphy-embed" allowfullscreen></iframe>`,
  },
  {
    name: 'GitHub Gist', id: 'gist', re: /gist\.github\.com\/([\w]+\/[\w]+)/i,
    canonical: (id) => `https://gist.github.com/${id}`,
    embed: (id) => `<script src="https://gist.github.com/${id}.js"></script>`,
  },
  {
    name: 'CodePen', id: 'codepen', re: /codepen\.io\/([\w-]+)\/pen\/([\w]+)/i, multi: true,
    canonical: (id) => `https://codepen.io/${id.split('/')[0]}/pen/${id.split('/')[1]}`,
    embed: (id, w, h) => `<iframe height="${h}" style="width: 100%;" scrolling="no" title="CodePen" src="https://codepen.io/${id.split('/')[0]}/embed/${id.split('/')[1]}?default-tab=html%2Cresult" frameborder="no" loading="lazy" allowtransparency="true" allowfullscreen="true"></iframe>`,
  },
  {
    name: 'CodeSandbox', id: 'codesandbox', re: /codesandbox\.io\/(?:s|embed)\/([\w-]+)/i,
    canonical: (id) => `https://codesandbox.io/s/${id}`,
    embed: (id, w, h) => `<iframe src="https://codesandbox.io/embed/${id}?fontsize=14&hidenavigation=1&theme=dark" style="width:100%; height:${h}px; border:0; border-radius:4px; overflow:hidden;" title="${id}" allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"></iframe>`,
  },
  {
    name: 'Google Maps', id: 'gmaps', re: /google\.[a-z.]+\/maps\/.*[?&]q=([^&]+)/i,
    canonical: (id) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(id)}`,
    embed: (id, w, h) => `<iframe src="https://www.google.com/maps?q=${encodeURIComponent(id)}&output=embed" width="${w}" height="${h}" style="border:0;" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`,
  },
];

async function oembedLookup(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { status: res.status, data: await res.json() };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) }; }
  finally { clearTimeout(t); }
}

const inputs = o._;
if (!inputs.length) die('usage: node tools/embedparse.js <url>... [--json]');

const results = [];
for (const raw of inputs) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { results.push({ url: raw, error: 'invalid url' }); continue; }

  const matched = PROVIDERS.find((p) => p.re.test(raw));
  if (!matched) {
    results.push({
      url: raw, provider: null, error: 'no known provider matched',
      hint: 'try --oembed discovery against the page itself, or paste the iframe URL directly',
      hostname: u.hostname,
    });
    continue;
  }
  const m = raw.match(matched.re);
  let id = m[1];
  if (matched.multi) id = m.slice(1).filter(Boolean).join('/')
    .replace(/^video\//, 'video:');
  else if (matched.id === 'twitch' && m[1]) id = `video:${m[1]}`;
  else if (matched.id === 'twitch') id = m[2] || m[1];

  const entry = {
    url: raw, provider: matched.name, providerId: matched.id, id,
    canonical: matched.canonical(id),
    embedHtml: matched.embed(id, W, H),
    thumbnail: matched.thumb ? matched.thumb(id) : null,
    dimensions: matched.id === 'spotify' ? { width: '100%', height: id.startsWith('track') ? 152 : 352 } : { width: W, height: H },
  };

  if (flag(o, 'oembed') && matched.oembed) {
    entry.oembedUrl = matched.oembed(id);
    const r = await oembedLookup(entry.oembedUrl);
    entry.oembed = r.error ? { error: r.error } : r.data;
  }
  results.push(entry);
}

if (flag(o, 'json')) { console.log(JSON.stringify(results.length === 1 ? results[0] : { count: results.length, embeds: results }, null, 2)); process.exitCode = 0; } else if (flag(o, 'html')) {
  for (const r of results) if (r.embedHtml) console.log(r.embedHtml.replace(/\s*\n\s*/g, ' '));
  process.exitCode = 0;
} else {
  for (const r of results) {
    if (r.error) { console.log(`${r.url}\n  error: ${r.error}${r.hint ? `\n  ${r.hint}` : ''}\n`); continue; }
    console.log(`${r.provider} — ${r.url}`);
    console.log(table([
      { field: 'id', value: r.id },
      { field: 'canonical', value: r.canonical },
      { field: 'size', value: `${r.dimensions.width}x${r.dimensions.height}` },
      ...(r.thumbnail ? [{ field: 'thumbnail', value: r.thumbnail }] : []),
      ...(r.oembed ? [{ field: 'oembed', value: r.oembed.title || r.oembed.error || 'ok' }] : []),
    ]));
    console.log(`\n${r.embedHtml}\n`);
  }
}
process.exitCode = 0;
