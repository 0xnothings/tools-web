# tools-web

Zero-dependency Node.js tools for the web: scraping, feeds, API pagination, metadata extraction, and page analysis. Everything runs on the Node standard library — no `npm install`, no headless browser, no framework.

```bash
node tools/rssgrab.js https://news.ycombinator.com/rss --limit 5
node tools/metalink.js https://github.com/0xnothings
node tools/seohead.js https://example.com
```

Requirements: Node.js 18+ (uses `fetch`, ESM). No dependencies.

## How it works

```
_ lib.js        shared argv parser, table renderer, stdin/line helpers
tools/*.js      one file per tool, self-contained, --help on every one
index-tools.js  rescans tools/ and regenerates the catalogue below
smoke.js        runs every tool with --help and reports pass/fail
catalogue.json  machine-readable catalogue
```

Each tool declares its own metadata:

```js
// @tool metalink
// @desc Extract OpenGraph, Twitter-card and oEmbed metadata from a URL
// @usage node tools/metalink.js https://example.com --json
// @tags web,metadata,seo
```

`node index-tools.js` rebuilds the README table from those blocks.

Every tool supports `--json`. Exit codes: `0` clean, `1` findings, `2` gate tripped.

## Discipline

- Polite scraping: descriptive User-Agent, conservative concurrency, no aggressive retry storms. Raise limits yourself when you have permission.
- HTML parsing is hand-written and tolerant, not a spec-compliant DOM. It handles real pages, not adversarial ones.
- No headless browser anywhere. If a page needs JS to render, the tool tells you instead of pretending.

## Catalogue

<!-- CATALOGUE:START -->

**31 tools**

| Tool | Description | Tags | Usage |
|---|---|---|---|
| [`apiprobe`](tools/apiprobe.js) | Fingerprint a JSON API: allowed methods, content types, pagination style, auth scheme, rate headers | web, api, recon | `node tools/apiprobe.js https://api.github.com/users/octocat --json` |
| [`changelog`](tools/changelog.js) | Summarize releases from the GitHub Releases API, a CHANGELOG.md or a releases HTML page | web, scrape, releases | `node tools/changelog.js https://github.com/nodejs/node --limit 5 --json` |
| [`cookiejar`](tools/cookiejar.js) | Turn Set-Cookie headers (or a live fetch) into a cookie jar with flag explanations and Netscape export | web, http, cookies | `node tools/cookiejar.js https://example.com --json` |
| [`dnsforurl`](tools/dnsforurl.js) | Resolve a URL host over DNS (A/AAAA/CNAME/NS/MX/TXT) and infer the CDN or hosting provider | web, dns, recon | `node tools/dnsforurl.js https://example.com --json` |
| [`embedparse`](tools/embedparse.js) | Turn a media URL (YouTube/Vimeo/Twitter/Spotify/...) into provider, id and ready-to-paste embed HTML | web, media, embed | `node tools/embedparse.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --json` |
| [`feedmerge`](tools/feedmerge.js) | Merge many RSS/Atom/JSON feeds into one deduplicated timeline sorted by date | web, scrape, rss | `node tools/feedmerge.js https://news.ycombinator.com/rss https://lobste.rs/rss --limit 20 --json` |
| [`harfetch`](tools/harfetch.js) | Replay every request in a HAR capture and compare status, size and wall time against the recording | web, http, perf | `node tools/harfetch.js capture.har --filter api --limit 20 --json` |
| [`hreflang`](tools/hreflang.js) | Audit hreflang, canonical and alternate link tags for consistency, reciprocity and validity | web, seo, i18n | `node tools/hreflang.js https://example.com --json` |
| [`htmltable`](tools/htmltable.js) | Find every <table> on a page and emit its rows as JSON or CSV with proper rowspan/colspan handling | web, scrape, data | `node tools/htmltable.js https://en.wikipedia.org/wiki/List_of_countries_by_population --index 0 --csv` |
| [`htmlvalid`](tools/htmlvalid.js) | Lint HTML for unclosed tags, duplicate ids, missing alt, inline handlers and other inline-fixable defects | web, qa, lint | `node tools/htmlvalid.js https://example.com --json` |
| [`httpstatus`](tools/httpstatus.js) | Look up any HTTP status code (1xx-5xx plus unofficial ones) with meaning, cause and fix hints | web, http, reference | `node tools/httpstatus.js 429 --json` |
| [`jsonld`](tools/jsonld.js) | Pull every JSON-LD block off a page, validate its shape and summarise the schema.org graph | web, seo, structured-data | `node tools/jsonld.js https://example.com --json` |
| [`jsonquery`](tools/jsonquery.js) | Fetch (or read) JSON and run a jq-like path query with slicing, mapping and filtering | web, api, json | `node tools/jsonquery.js https://api.github.com/users/octocat '.name, .id' --json` |
| [`linkcheck`](tools/linkcheck.js) | Extract every link on a page and report HTTP status, redirect target and dead links | web, seo, qa | `node tools/linkcheck.js https://example.com --internal-only --json` |
| [`metaform`](tools/metaform.js) | Inventory every <form> on a page with its fields, hidden inputs, CSRF token and submit-target hints | web, scrape, recon | `node tools/metaform.js https://example.com/login --json` |
| [`metalink`](tools/metalink.js) | Pull OpenGraph, Twitter-card, canonical and oEmbed metadata off any page into one object | web, seo, scrape | `node tools/metalink.js https://github.com --oembed --json` |
| [`mimeprint`](tools/mimeprint.js) | Map file extensions to MIME types (and back) with the correct Content-Type header to send | web, http, reference | `node tools/mimeprint.js .webp svg .webmanifest --json` |
| [`musicsearch`](tools/musicsearch.js) | Query the iTunes Search API and MusicBrainz for tracks, artists and albums; rate-limited and cached | web, api, music | `node tools/musicsearch.js "daft punk" --type artist --limit 10 --json` |
| [`pageweight`](tools/pageweight.js) | Inventory every subresource a page loads, grouped by type, with sizes when the server reports them | web, perf, audit | `node tools/pageweight.js https://example.com --head --json` |
| [`paginate`](tools/paginate.js) | Walk page/cursor/offset/link-header pagination on a JSON API and collect all records | web, api, json | `node tools/paginate.js https://api.github.com/users/octocat/repos --style auto --max-pages 3 --json` |
| [`ratelim`](tools/ratelim.js) | Read an API's rate-limit headers and compute a safe request pacing / concurrency plan | web, api, recon | `node tools/ratelim.js https://api.github.com/users/octocat --burst 5 --json` |
| [`redirectchain`](tools/redirectchain.js) | Walk a redirect chain hop by hop and report status, Location, timing and the loop/limit verdict | web, http, debug | `node tools/redirectchain.js http://github.com --max 10 --json` |
| [`robbots`](tools/robbots.js) | Fetch and parse robots.txt, then evaluate paths against any user-agent with full precedence rules | web, seo, recon | `node tools/robbots.js https://example.com --ua Googlebot --path /admin --json` |
| [`rssgrab`](tools/rssgrab.js) | Fetch RSS, Atom or JSON feeds and normalize every entry to title/link/date/summary | web, scrape, rss | `node tools/rssgrab.js https://news.ycombinator.com/rss --limit 10 --json` |
| [`searchsuggest`](tools/searchsuggest.js) | Collect autocomplete suggestions from DuckDuckGo, Wikipedia, Google and Brave for keyword research | web, seo, research | `node tools/searchsuggest.js "rust async" --source ddg,wiki --expand --json` |
| [`seohead`](tools/seohead.js) | Audit title/description/canonical/robots/OG/structured-data in one report with length and duplicate checks | web, seo, audit | `node tools/seohead.js https://example.com --json` |
| [`sitemapgen`](tools/sitemapgen.js) | Breadth-first crawl of one origin and emit a valid sitemap.xml (or JSON url list) | web, seo, crawler | `node tools/sitemapgen.js https://example.com --depth 2 --max 100 --json` |
| [`sitestatus`](tools/sitestatus.js) | Query Statuspage / Instatus / Google Cloud status APIs and summarise which services are degraded | web, status, ops | `node tools/sitestatus.js github cloudflare npm --json` |
| [`textgrab`](tools/textgrab.js) | Strip scripts, nav and markup from an HTML page and return the readable article text | web, scrape, text | `node tools/textgrab.js https://example.com --max 4000` |
| [`uacheck`](tools/uacheck.js) | Decode one or many User-Agent strings into browser, version, engine, OS, device class and bot flags | web, parse, qa | `node tools/uacheck.js "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" --json` |
| [`urlx`](tools/urlx.js) | Parse, normalize, de-track, resolve and diff URLs with a query-string builder | web, parse, url | `node tools/urlx.js "https://Example.COM/a/../b?utm_source=x&id=7#frag" --clean --json` |

<!-- CATALOGUE:END -->

## Adding a tool

1. Drop `tools/<name>.js` with the header block.
2. `import { args, get, num, flag, die, inputLines, table } from '../_lib.js';`
3. Help first, then parse, then work, then print.
4. `node smoke.js && node index-tools.js`.

## License

MIT — Copyright (c) 2026 0xnothings
