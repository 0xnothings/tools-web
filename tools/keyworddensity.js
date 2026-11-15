#!/usr/bin/env node
// keyworddensity.js — n-gram and TF-IDF analysis of a page's visible text.
// Copyright (c) 2026 0xnothings
// @tool keyworddensity
// @desc Count 1-, 2- and 3-grams in the readable text with stopwords removed, weight terms found in headings, and score them by TF-IDF against a second reference page
// @usage node tools/keyworddensity.js https://example.com/post --ref https://example.com/
// @tags web,seo,text
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`keyworddensity — term frequency and TF-IDF

  node tools/keyworddensity.js <url|file|-> [options]

  --ref <url|file>  reference corpus page for TF-IDF (default: compares against
                    the page's own heading text so every term gets a non-zero idf)
  --top <n>         rows per n-gram table (default 15)
  --min <n>         minimum occurrence count to report (default 2)
  --max-words <n>   cap words analysed (default 20000)
  --json            machine-readable output
  -h, --help        this text`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';
const STOP = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also may might must shall etc via using use used one two three get got make makes made new like well back even still much many however therefore thus within without upon across per among whether whose whatever whenever wherever'.split(/\s+/)));

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return await res.text();
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return readInput(t === '-' ? null : t);
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

function visibleText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  s = s.replace(/<(?:div|span|p|section|article)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*\b(?:site-)?(?:nav|menu|breadcrumb|sidebar|footer|header)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|span|p|section|article)>/gi, ' ');
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decode(s).replace(/\s+/g, ' ').trim();
}

function headingText(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  return out.join(' ');
}

const tokenize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

function ngrams(words, n) {
  const m = new Map();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

const maxWords = Math.max(100, num(get(o, 'max-words'), 20000));
const src = o._[0] || die('usage: node tools/keyworddensity.js <url|file|->');
const html = await load(src);
const text = visibleText(html).split(/\s+/).slice(0, maxWords).join(' ');
const headings = headingText(html);
const words = tokenize(text);
const headingWords = new Set(tokenize(headings));

const refArg = get(o, 'ref', null);
const refHtml = refArg ? await load(String(refArg)) : '';
const refWords = refArg ? tokenize(visibleText(refHtml)) : tokenize(headings);
const refDocLen = refWords.length || 1;

const total = words.length;
const uni = ngrams(words, 1), bi = ngrams(words, 2), tri = ngrams(words, 3);

const idf = (term) => {
  const tf = refWords.filter((w) => w === term).length || (refArg ? 0 : 1);
  return Math.log((refDocLen + 1) / (tf + 1)) + 1;
};

const minCount = Math.max(1, num(get(o, 'min'), 2));
const build = (map, n) => [...map.entries()]
  .filter(([, c]) => c >= minCount)
  .map(([term, count]) => {
    const density = (count / Math.max(1, total - n + 1)) * 100;
    const tfidf = (count / total) * idf(term.split(' ')[0]);
    return {
      term,
      count,
      density: Number(density.toFixed(2)),
      tfidf: Number(tfidf.toFixed(4)),
      heading: term.split(' ').some((w) => headingWords.has(w)) ? 'yes' : '',
      weight: Number((density * (term.split(' ').some((w) => headingWords.has(w)) ? 2 : 1)).toFixed(2)),
    };
  })
  .sort((a, b) => b.count - a.count);

const unigrams = build(uni, 1);
const bigrams = build(bi, 2);
const trigrams = build(tri, 3);
const top = Math.max(1, num(get(o, 'top'), 15));

const overlap = refArg ? [...uni.keys()].filter((t) => refWords.includes(t)).length : 0;
const summary = {
  words: total,
  uniqueTerms: uni.size,
  sentences: (text.match(/[.!?]+\s/g) || []).length + 1,
  avgWordLength: total ? Number((words.reduce((a, w) => a + w.length, 0) / total).toFixed(2)) : 0,
  headingTerms: headingWords.size,
  coverage: total ? Number(((uni.size / total) * 100).toFixed(1)) : 0,
  refTerms: refArg ? refWords.length : 0,
  refOverlap: overlap,
};

if (flag(o, 'json')) {
  console.log(JSON.stringify({ source: src, reference: refArg || null, summary, unigrams: unigrams.slice(0, top * 2), bigrams: bigrams.slice(0, top), trigrams: trigrams.slice(0, top) }, null, 2));
} else {
  console.log(`${src}${refArg ? `  vs ${refArg}` : '  (self-reference: headings)'}\n`);
  console.log(`${total.toLocaleString('en-US')} words · ${uni.size.toLocaleString('en-US')} unique terms · ${summary.sentences.toLocaleString('en-US')} sentences · avg word length ${summary.avgWordLength} · lexical variety ${summary.coverage}%`);
  if (refArg) console.log(`reference corpus: ${refWords.length} terms, ${overlap} shared with this page`);
  console.log('\ntop unigrams (1-gram):');
  console.log(table(unigrams.slice(0, top)));
  console.log('\ntop bigrams (2-gram):');
  console.log(table(bigrams.slice(0, top)));
  if (trigrams.length) {
    console.log('\ntop trigrams (3-gram):');
    console.log(table(trigrams.slice(0, top)));
  }
  const headingHits = unigrams.filter((u) => u.heading === 'yes').slice(0, 8);
  if (headingHits.length) console.log('\nterms that also appear in headings (weighted 2x): ' + headingHits.map((u) => u.term).join(', '));
  if (refArg) {
    const refSet = new Set(refWords);
    const uniqueTerms = unigrams.filter((u) => !refSet.has(u.term)).slice(0, 10);
    if (uniqueTerms.length) console.log('\nterms unique to this page vs the reference: ' + uniqueTerms.map((u) => u.term).join(', '));
  }
}
