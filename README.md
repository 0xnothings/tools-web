# tools-web

Zero-dependency Node.js tools for the web: scraping, feeds, API pagination, metadata extraction, and page analysis. Everything runs on the Node standard library — no `npm install`, no headless browser, no framework.

**[Landing page](https://0xnothings.github.io) · [All four repos](https://github.com/0xnothings)**

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

**61 tools**

| Tool | Description | Tags | Usage |
|---|---|---|---|
| [`apidoc`](tools/apidoc.js) | Fetch a JSON endpoint, infer the response shape, and emit markdown documentation with types, nesting, nullability and example values | api, docs, json | `node tools/apidoc.js https://api.example.com/v1/items --title Items` |
| [`apiprobe`](tools/apiprobe.js) | Fingerprint a JSON API: allowed methods, content types, pagination style, auth scheme, rate headers | web, api, recon | `node tools/apiprobe.js https://api.github.com/users/octocat --json` |
| [`bingindex`](tools/bingindex.js) | Probe whether a URL or site: operator appears indexed on several engines using their public HTML endpoints, and report which returned results with a snippet | web, seo, indexing | `node tools/bingindex.js https://example.com --engines bing,ddg` |
| [`cacheheader`](tools/cacheheader.js) | Check Cache-Control, Expires, ETag, Last-Modified and Vary on each URL and flag conflicts, missing validators and no-store on static assets | web, performance, http | `node tools/cacheheader.js urls.txt --max-age-min 3600` |
| [`canoncheck`](tools/canoncheck.js) | Audit rel=canonical across a page set: missing or non-self canonicals, cross-domain targets, canonical chains and duplicate clusters | web, seo, audit | `node tools/canoncheck.js https://example.com --max 12` |
| [`changelog`](tools/changelog.js) | Summarize releases from the GitHub Releases API, a CHANGELOG.md or a releases HTML page | web, scrape, releases | `node tools/changelog.js https://github.com/nodejs/node --limit 5 --json` |
| [`codeblock`](tools/codeblock.js) | Pull every <pre><code> (and standalone <pre>) block out of a page, detect the language from class names, and print them as markdown fences | web, scrape, markdown | `node tools/codeblock.js https://example.com/post --lang js` |
| [`contractcheck`](tools/contractcheck.js) | Validate a live or on-disk JSON document against a JSON Schema and report every violation with its exact JSON path and the rule that failed | api, json, validation | `node tools/contractcheck.js https://api.example.com/items item.schema.json` |
| [`cookiejar`](tools/cookiejar.js) | Turn Set-Cookie headers (or a live fetch) into a cookie jar with flag explanations and Netscape export | web, http, cookies | `node tools/cookiejar.js https://example.com --json` |
| [`corsmatrix`](tools/corsmatrix.js) | Probe CORS behaviour for a list of origins against a list of endpoints, record the allow-origin/credentials/vary response per cell, and flag the dangerous combinations | web, security, cors | `node tools/corsmatrix.js https://api.example.com --origins origins.txt --paths paths.txt` |
| [`csspeek`](tools/csspeek.js) | Score every CSS rule for specificity and complexity, flag duplicate declaration blocks and selectors no class/id on the page uses, and inventory @media/@supports blocks | web, css, audit | `node tools/csspeek.js https://example.com --html https://example.com` |
| [`dnsforurl`](tools/dnsforurl.js) | Resolve a URL host over DNS (A/AAAA/CNAME/NS/MX/TXT) and infer the CDN or hosting provider | web, dns, recon | `node tools/dnsforurl.js https://example.com --json` |
| [`domquery`](tools/domquery.js) | Query HTML with tag/class/id/attribute selectors plus descendant, child and sibling combinators, printing each match with its text and attributes | web, dom, cli | `node tools/domquery.js page.html "article.card > h2.title"` |
| [`embedparse`](tools/embedparse.js) | Turn a media URL (YouTube/Vimeo/Twitter/Spotify/...) into provider, id and ready-to-paste embed HTML | web, media, embed | `node tools/embedparse.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --json` |
| [`feeddiff`](tools/feeddiff.js) | Compare two RSS/Atom/JSON feed snapshots by item identity and list new, removed and edited entries with the exact fields that changed | web, feeds, diff | `node tools/feeddiff.js feed-yesterday.xml feed-today.xml` |
| [`feedmerge`](tools/feedmerge.js) | Merge many RSS/Atom/JSON feeds into one deduplicated timeline sorted by date | web, scrape, rss | `node tools/feedmerge.js https://news.ycombinator.com/rss https://lobste.rs/rss --limit 20 --json` |
| [`formfiller`](tools/formfiller.js) | Read every <form> on a page, synthesise plausible values per input type, and print the ready-to-send request (curl, body, multipart) | web, forms, testing | `node tools/formfiller.js https://example.com/contact --form 0` |
| [`harfetch`](tools/harfetch.js) | Replay every request in a HAR capture and compare status, size and wall time against the recording | web, http, perf | `node tools/harfetch.js capture.har --filter api --limit 20 --json` |
| [`hreflang`](tools/hreflang.js) | Audit hreflang, canonical and alternate link tags for consistency, reciprocity and validity | web, seo, i18n | `node tools/hreflang.js https://example.com --json` |
| [`hreflanggraph`](tools/hreflanggraph.js) | Collect alternate hreflang annotations across a page set, group them into language clusters and flag missing return links, bad codes and self-reference errors | web, seo, i18n | `node tools/hreflanggraph.js https://example.com --max 10` |
| [`htmltable`](tools/htmltable.js) | Find every <table> on a page and emit its rows as JSON or CSV with proper rowspan/colspan handling | web, scrape, data | `node tools/htmltable.js https://en.wikipedia.org/wiki/List_of_countries_by_population --index 0 --csv` |
| [`htmlvalid`](tools/htmlvalid.js) | Lint HTML for unclosed tags, duplicate ids, missing alt, inline handlers and other inline-fixable defects | web, qa, lint | `node tools/htmlvalid.js https://example.com --json` |
| [`httpmirror`](tools/httpmirror.js) | Crawl a URL list into a single JSON archive holding request and response records (status, headers, base64 body) plus an offline replay command | web, archive, http | `node tools/httpmirror.js urls.txt --out mirror.json --max 10` |
| [`httpstatus`](tools/httpstatus.js) | Look up any HTTP status code (1xx-5xx plus unofficial ones) with meaning, cause and fix hints | web, http, reference | `node tools/httpstatus.js 429 --json` |
| [`jsonfeed`](tools/jsonfeed.js) | Detect the feed format, normalise every entry into one schema, and emit it as JSON with per-format field coverage notes | web, feeds, data | `node tools/jsonfeed.js https://example.com/feed.xml --limit 10` |
| [`jsonld`](tools/jsonld.js) | Pull every JSON-LD block off a page, validate its shape and summarise the schema.org graph | web, seo, structured-data | `node tools/jsonld.js https://example.com --json` |
| [`jsonquery`](tools/jsonquery.js) | Fetch (or read) JSON and run a jq-like path query with slicing, mapping and filtering | web, api, json | `node tools/jsonquery.js https://api.github.com/users/octocat '.name, .id' --json` |
| [`keyworddensity`](tools/keyworddensity.js) | Count 1-, 2- and 3-grams in the readable text with stopwords removed, weight terms found in headings, and score them by TF-IDF against a second reference page | web, seo, text | `node tools/keyworddensity.js https://example.com/post --ref https://example.com/` |
| [`linkcheck`](tools/linkcheck.js) | Extract every link on a page and report HTTP status, redirect target and dead links | web, seo, qa | `node tools/linkcheck.js https://example.com --internal-only --json` |
| [`markdownify`](tools/markdownify.js) | Hand-written HTML to markdown converter covering headings, emphasis, links, images, lists, tables, code fences, blockquotes and horizontal rules | web, markdown, convert | `node tools/markdownify.js https://example.com/post --drop-nav` |
| [`metaform`](tools/metaform.js) | Inventory every <form> on a page with its fields, hidden inputs, CSRF token and submit-target hints | web, scrape, recon | `node tools/metaform.js https://example.com/login --json` |
| [`metalink`](tools/metalink.js) | Pull OpenGraph, Twitter-card, canonical and oEmbed metadata off any page into one object | web, seo, scrape | `node tools/metalink.js https://github.com --oembed --json` |
| [`microdata`](tools/microdata.js) | Parse itemscope/itemprop microdata and RDFa vocab/property/typeof attributes into a nested item tree keyed by schema.org type | web, seo, structured-data | `node tools/microdata.js https://example.com/product` |
| [`mimeprint`](tools/mimeprint.js) | Map file extensions to MIME types (and back) with the correct Content-Type header to send | web, http, reference | `node tools/mimeprint.js .webp svg .webmanifest --json` |
| [`mockjson`](tools/mockjson.js) | Learn the shape of a sample JSON payload and emit a seeded generator script plus ready-generated mock records with realistic value substitution per field name | api, mock, json | `node tools/mockjson.js sample.json --count 5 --seed 42` |
| [`musicsearch`](tools/musicsearch.js) | Query the iTunes Search API and MusicBrainz for tracks, artists and albums; rate-limited and cached | web, api, music | `node tools/musicsearch.js "daft punk" --type artist --limit 10 --json` |
| [`opengraph`](tools/opengraph.js) | Check every og: and twitter: tag against what each platform needs, then render the text preview card that would be shown when the link is shared | web, seo, social | `node tools/opengraph.js https://example.com` |
| [`pagerankish`](tools/pagerankish.js) | Crawl a handful of same-host pages, build the internal link graph, and rank every page by in-degree plus a damped PageRank iteration | web, seo, crawl | `node tools/pagerankish.js https://example.com --max 12` |
| [`pagestruct`](tools/pagestruct.js) | Print the h1-h6 outline with level skips flagged, count multiple h1s, and report missing or repeated nav/main/aside/footer landmarks | web, seo, a11y | `node tools/pagestruct.js https://example.com` |
| [`pageweight`](tools/pageweight.js) | Inventory every subresource a page loads, grouped by type, with sizes when the server reports them | web, perf, audit | `node tools/pageweight.js https://example.com --head --json` |
| [`paginate`](tools/paginate.js) | Walk page/cursor/offset/link-header pagination on a JSON API and collect all records | web, api, json | `node tools/paginate.js https://api.github.com/users/octocat/repos --style auto --max-pages 3 --json` |
| [`ratelim`](tools/ratelim.js) | Read an API's rate-limit headers and compute a safe request pacing / concurrency plan | web, api, recon | `node tools/ratelim.js https://api.github.com/users/octocat --burst 5 --json` |
| [`readtime`](tools/readtime.js) | Estimate reading and speaking time, a Flesch-style difficulty score, and how much of the page is prose versus code, tables and lists | web, text, content | `node tools/readtime.js https://example.com/post` |
| [`redirectchain`](tools/redirectchain.js) | Walk a redirect chain hop by hop and report status, Location, timing and the loop/limit verdict | web, http, debug | `node tools/redirectchain.js http://github.com --max 10 --json` |
| [`robbots`](tools/robbots.js) | Fetch and parse robots.txt, then evaluate paths against any user-agent with full precedence rules | web, seo, recon | `node tools/robbots.js https://example.com --ua Googlebot --path /admin --json` |
| [`robotsdiff`](tools/robotsdiff.js) | Compare two robots.txt files rule by rule per user-agent and state exactly which paths became blocked, unblocked, or changed crawl-delay | web, seo, diff | `node tools/robotsdiff.js https://example.com/robots.txt old-robots.txt` |
| [`rssgrab`](tools/rssgrab.js) | Fetch RSS, Atom or JSON feeds and normalize every entry to title/link/date/summary | web, scrape, rss | `node tools/rssgrab.js https://news.ycombinator.com/rss --limit 10 --json` |
| [`schemagen`](tools/schemagen.js) | Merge one or more JSON samples into a draft-07 schema with required-field detection, enum inference for repeating literals and format hints for dates, emails and URLs | api, json, schema | `node tools/schemagen.js sample.json second-sample.json --title Item` |
| [`searchsuggest`](tools/searchsuggest.js) | Collect autocomplete suggestions from DuckDuckGo, Wikipedia, Google and Brave for keyword research | web, seo, research | `node tools/searchsuggest.js "rust async" --source ddg,wiki --expand --json` |
| [`searchurl`](tools/searchurl.js) | Compose properly percent-encoded search URLs for Google, Bing, DuckDuckGo, Startpage, Brave and Yandex from operator combinations, with a shell-safe copy line | web, seo, cli | `node tools/searchurl.js site:example.com filetype:pdf --engine google,ddg` |
| [`seohead`](tools/seohead.js) | Audit title/description/canonical/robots/OG/structured-data in one report with length and duplicate checks | web, seo, audit | `node tools/seohead.js https://example.com --json` |
| [`sitemapdiff`](tools/sitemapdiff.js) | Compare two sitemaps and report URLs added, removed, lastmod-changed, priority-changed, plus which new URLs look like they should be polled for indexing first | web, seo, diff | `node tools/sitemapdiff.js sitemap-old.xml https://example.com/sitemap.xml` |
| [`sitemapgen`](tools/sitemapgen.js) | Breadth-first crawl of one origin and emit a valid sitemap.xml (or JSON url list) | web, seo, crawler | `node tools/sitemapgen.js https://example.com --depth 2 --max 100 --json` |
| [`sitemapvalidate`](tools/sitemapvalidate.js) | Check URL and sitemap-index files for spec violations: bad lastmod format, out-of-range priority or changefreq values, non-absolute locs, size and count limits, and gzip handling | web, seo, validation | `node tools/sitemapvalidate.js https://example.com/sitemap.xml` |
| [`sitestatus`](tools/sitestatus.js) | Query Statuspage / Instatus / Google Cloud status APIs and summarise which services are degraded | web, status, ops | `node tools/sitestatus.js github cloudflare npm --json` |
| [`tabletext`](tools/tabletext.js) | Turn any HTML table into a monospaced grid with computed column widths, honouring rowspan and colspan and wrapping cells that are too wide | web, scrape, text | `node tools/tabletext.js https://example.com/pricing --index 0 --max-width 30` |
| [`textgrab`](tools/textgrab.js) | Strip scripts, nav and markup from an HTML page and return the readable article text | web, scrape, text | `node tools/textgrab.js https://example.com --max 4000` |
| [`uacheck`](tools/uacheck.js) | Decode one or many User-Agent strings into browser, version, engine, OS, device class and bot flags | web, parse, qa | `node tools/uacheck.js "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" --json` |
| [`urlx`](tools/urlx.js) | Parse, normalize, de-track, resolve and diff URLs with a query-string builder | web, parse, url | `node tools/urlx.js "https://Example.COM/a/../b?utm_source=x&id=7#frag" --clean --json` |
| [`warcbuild`](tools/warcbuild.js) | Crawl URLs and write a hand-assembled WARC 1.1 file with warcinfo, request and response records using correct CRLF line endings and Content-Length blocks | web, archive, warc | `node tools/warcbuild.js urls.txt --out crawl.warc --max 5` |
| [`webfont`](tools/webfont.js) | Inventory every @font-face and font load on a page, classify the loading strategy (local, preload, display swap, self-hosted vs third-party) and estimate FOUT/FOIT risk | web, fonts, performance | `node tools/webfont.js https://example.com --link` |

<!-- CATALOGUE:END -->

## Adding a tool

1. Drop `tools/<name>.js` with the header block.
2. `import { args, get, num, flag, die, inputLines, table } from '../_lib.js';`
3. Help first, then parse, then work, then print.
4. `node smoke.js && node index-tools.js`.

## License

MIT — Copyright (c) 2026 0xnothings
