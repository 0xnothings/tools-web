// readtime.js — reading time, difficulty and content-per-code ratio.
// Copyright (c) 2026 0xnothings
// @tool readtime
// @desc Estimate reading and speaking time, a Flesch-style difficulty score, and how much of the page is prose versus code, tables and lists
// @usage node tools/readtime.js https://example.com/post
// @tags web,text,content
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`readtime — content length and difficulty

  node tools/readtime.js <url|file|-> [options]

  --wpm <n>        reading speed in words per minute (default 230)
  --speak-wpm <n>  speaking speed (default 150)
  --json           machine-readable output
  -h, --help       this text

  Difficulty uses the Flesch reading ease and Flesch-Kincaid grade formulas
  on the visible prose only (code and tables excluded from the prose count).`); 
  process.exit(0);
}

const UA = 'Mozilla/5.0 (compatible; 0xnothings-tools/1.0)';

async function load(t) {
  if (/^https?:\/\//i.test(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(t, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*' } });
      if (!res.ok) die(`fetch failed: HTTP ${res.status} ${t}`);
      return { body: await res.text(), final: res.url };
    } catch (e) {
      die(`fetch failed: ${e.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e.message)}`);
    } finally { clearTimeout(timer); }
  }
  return { body: await readInput(t === '-' ? null : t), final: t };
}

function decode(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d' };
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n.toLowerCase()] ?? m);
}

const { body, final } = await load(o._[0] || die('usage: node tools/readtime.js <url|file|->'));
const html = String(body);

const grab = (tag) => {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
};

const codeBlocks = [...grab('pre'), ...grab('code')];
const codeText = codeBlocks.map((c) => c.replace(/<[^>]+>/g, ' ')).join('\n');
const tableBlocks = grab('table');
const tableText = tableBlocks.map((t) => t.replace(/<[^>]+>/g, ' ')).join(' ');
const listBlocks = grab('li');
const listText = listBlocks.map((t) => t.replace(/<[^>]+>/g, ' ')).join(' ');
const headingBlocks = [1, 2, 3, 4, 5, 6].flatMap((l) => grab(`h${l}`));

let prose = html.replace(/<!--[\s\S]*?-->/g, ' ');
prose = prose.replace(/<(script|style|noscript|svg|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
prose = prose.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, ' ');
prose = prose.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, ' ');
prose = prose.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, ' ');
prose = prose.replace(/<[^>]+>/g, ' ');
const proseText = decode(prose).replace(/\s+/g, ' ').trim();
const codePlain = decode(codeText.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tablePlain = decode(tableText.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const listPlain = decode(listText.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const headingPlain = decode(headingBlocks.join(' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const wc = (t) => (t ? t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);
const words = wc(proseText);
const codeWords = wc(codePlain);
const tableWords = wc(tablePlain);
const listWords = wc(listPlain);
const headingWords = wc(headingPlain);
const allWords = words + codeWords + tableWords + listWords + headingWords;

const syllables = (word) => {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
};
const proseList = proseText.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const sylTotal = proseList.reduce((a, w) => a + syllables(w), 0);
const sentences = (proseText.match(/[.!?]+(?=\s|$)/g) || []).length || (proseText ? 1 : 0);
const complex = proseList.filter((w) => syllables(w) >= 3).length;

const wpm = Math.max(50, num(get(o, 'wpm'), 230));
const speakWpm = Math.max(50, num(get(o, 'speak-wpm'), 150));
const minutes = (count, rate) => count / rate;
const fmtTime = (min) => {
  if (min < 1) return `${Math.max(1, Math.round(min * 60))}s`;
  const m = Math.floor(min), s = Math.round((min - m) * 60);
  return s ? `${m}m ${s}s` : `${m}m`;
};

const fk = sentences && words ? 0.39 * (words / sentences) + 11.8 * (sylTotal / words) - 15.59 : 0;
const fre = sentences && words ? 206.835 - 1.015 * (words / sentences) - 84.6 * (sylTotal / words) : 0;
const gradeLabel = fk < 6 ? 'primary school' : fk < 9 ? 'middle school' : fk < 13 ? 'high school' : fk < 16 ? 'undergraduate' : 'graduate';

const ratios = {
  prose: words, code: codeWords, table: tableWords, list: listWords, headings: headingWords,
};
const share = (n) => (allWords ? Number(((n / allWords) * 100).toFixed(1)) : 0);

const result = {
  source: final,
  words: { prose: words, code: codeWords, table: tableWords, list: listWords, headings: headingWords, total: allWords },
  readingTime: fmtTime(minutes(allWords, wpm)),
  readingMinutes: Number(minutes(allWords, wpm).toFixed(2)),
  speakingTime: fmtTime(minutes(words + listWords, speakWpm)),
  proseOnlyReadingTime: fmtTime(minutes(words, wpm)),
  sentences,
  avgSentenceWords: sentences ? Number((words / sentences).toFixed(1)) : 0,
  avgSyllablesPerWord: words ? Number((sylTotal / words).toFixed(2)) : 0,
  complexWordPercent: words ? Number(((complex / words) * 100).toFixed(1)) : 0,
  fleschReadingEase: Number(fre.toFixed(1)),
  fleschKincaidGrade: Number(fk.toFixed(1)),
  gradeLevel: gradeLabel,
  ratios: Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, { words: v, percent: share(v) }])),
  codeBlocks: codeBlocks.length,
  tables: tableBlocks.length,
  listItems: listBlocks.length,
  headings: headingBlocks.length,
};

if (flag(o, 'json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${final}\n`);
  console.log(table([
    { metric: 'total words', value: allWords.toLocaleString('en-US') },
    { metric: 'readable prose', value: `${words.toLocaleString('en-US')} (${share(words)}%)` },
    { metric: 'code', value: `${codeWords.toLocaleString('en-US')} words (${share(codeWords)}%)` },
    { metric: 'tables', value: `${tableWords.toLocaleString('en-US')} words (${share(tableWords)}%)` },
    { metric: 'lists', value: `${listWords.toLocaleString('en-US')} words (${share(listWords)}%)` },
    { metric: 'headings', value: `${headingWords.toLocaleString('en-US')} words (${share(headingWords)}%)` },
    { metric: 'reading time @ ' + wpm + 'wpm', value: fmtTime(minutes(allWords, wpm)) },
    { metric: 'speaking time @ ' + speakWpm + 'wpm', value: fmtTime(minutes(words + listWords, speakWpm)) },
    { metric: 'sentences', value: String(sentences) },
    { metric: 'avg sentence length', value: `${result.avgSentenceWords} words` },
    { metric: 'complex words', value: `${result.complexWordPercent}% (3+ syllables)` },
    { metric: 'Flesch reading ease', value: String(result.fleschReadingEase) },
    { metric: 'Flesch-Kincaid grade', value: `${result.fleschKincaidGrade} (${gradeLabel})` },
    { metric: 'code blocks', value: String(codeBlocks.length) },
    { metric: 'tables / list items', value: `${tableBlocks.length} / ${listBlocks.length}` },
  ]));
  const verdict = fre >= 70 ? 'easy — comfortable for a general audience'
    : fre >= 50 ? 'medium — readable, some sentences could tighten'
    : fre >= 30 ? 'difficult — college-level prose'
    : 'very difficult — dense academic register';
  console.log(`\nreadability: ${verdict}`);
  if (codeWords > words) console.log('note: this page is mostly code — reading time overstates the prose load');
}
