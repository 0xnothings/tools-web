// uacheck.js — parse a User-Agent string into browser/os/engine/device.
// Copyright (c) 2026 0xnothings
// @tool uacheck
// @desc Decode one or many User-Agent strings into browser, version, engine, OS, device class and bot flags
// @usage node tools/uacheck.js "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" --json
// @tags web,parse,qa
import { args, get, flag, inputLines, readInput, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`uacheck — User-Agent decoder

  node tools/uacheck.js [ua-string | file | -] [options]

  --json      machine-readable output
  --ua <s>    pass the string as a flag instead of a positional
  -h, --help  this text

  With no argument it reads stdin (one UA per line) or parses a built-in demo list.
  Reports browser, version, engine, OS, device class, and bot/crawler detection.`);
  process.exit(0);
}

const BROWSERS = [
  { name: 'Edge', re: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: 'Opera', re: /(?:OPR|OPiOS|Opera)\/([\d.]+)/ },
  { name: 'Samsung Internet', re: /SamsungBrowser\/([\d.]+)/ },
  { name: 'Vivaldi', re: /Vivaldi\/([\d.]+)/ },
  { name: 'Brave', re: /Brave\/([\d.]+)/ },
  { name: 'Yandex', re: /YaBrowser\/([\d.]+)/ },
  { name: 'UC Browser', re: /UCBrowser\/([\d.]+)/ },
  { name: 'Firefox', re: /(?:Firefox|FxiOS)\/([\d.]+)/ },
  { name: 'Chrome', re: /(?:Chrome|CriOS|Chromium)\/([\d.]+)/ },
  { name: 'Safari', re: /Version\/([\d.]+).*Safari/ },
  { name: 'IE', re: /(?:MSIE |rv:)([\d.]+).*Trident/ },
  { name: 'Curl', re: /^curl\/([\d.]+)/ },
  { name: 'Wget', re: /^Wget\/([\d.]+)/ },
  { name: 'Python Requests', re: /python-requests\/([\d.]+)/i },
  { name: 'Go HTTP', re: /^Go-http-client\/([\d.]+)/ },
  { name: 'Node Fetch', re: /^(?:node|undici)/i },
  { name: 'Postman', re: /PostmanRuntime\/([\d.]+)/ },
  { name: 'Insomnia', re: /insomnia\/([\d.]+)/i },
];

const BOTS = [
  [/Googlebot/i, 'Googlebot'], [/bingbot/i, 'Bingbot'], [/YandexBot/i, 'YandexBot'],
  [/DuckDuckBot/i, 'DuckDuckBot'], [/Baiduspider/i, 'Baiduspider'], [/Slurp/i, 'Yahoo Slurp'],
  [/facebookexternalhit/i, 'Facebook'], [/Twitterbot/i, 'Twitterbot'], [/LinkedInBot/i, 'LinkedInBot'],
  [/AhrefsBot/i, 'AhrefsBot'], [/SemrushBot/i, 'SemrushBot'], [/MJ12bot/i, 'MJ12bot'],
  [/GPTBot|ChatGPT-User|ClaudeBot|CCBot|anthropic-ai/i, 'AI crawler'],
  [/bot\b|crawler|spider|scrape|headless|phantom|puppeteer|playwright/i, 'generic bot'],
];

const ENGINES = [
  [/Gecko\/|Firefox/i, 'Gecko'], [/AppleWebKit/i, 'WebKit'], [/Trident/i, 'Trident'],
  [/EdgeHTML/i, 'EdgeHTML'], [/Presto/i, 'Presto'], [/curl|Wget|python-requests|Go-http/i, 'none (http client)'],
];

const DEVICES = [
  [/iPad|Tablet|PlayBook|Silk/i, 'tablet'],
  [/Mobile|iPhone|iPod|Android.*Mobile|Windows Phone/i, 'mobile'],
  [/SmartTV|SMART-TV|AppleTV|Roku|CrKey|HbbTV/i, 'tv'],
  [/Xbox|PlayStation|Nintendo/i, 'console'],
  [/bot|crawler|spider/i, 'bot'],
];

function parseOS(ua) {
  let m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    const names = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7', '6.0': 'Windows Vista', '5.1': 'Windows XP' };
    return { name: names[m[1]] || `Windows NT ${m[1]}`, version: m[1], family: 'Windows' };
  }
  if ((m = ua.match(/iPhone OS ([\d_]+)/))) return { name: 'iOS', version: m[1].replace(/_/g, '.'), family: 'iOS' };
  if ((m = ua.match(/iPad.*?OS ([\d_]+)/))) return { name: 'iPadOS', version: m[1].replace(/_/g, '.'), family: 'iOS' };
  if ((m = ua.match(/Mac OS X ([\d_.]+)/))) return { name: 'macOS', version: m[1].replace(/_/g, '.'), family: 'macOS' };
  if ((m = ua.match(/Android ([\d.]+)/))) return { name: 'Android', version: m[1], family: 'Android' };
  if ((m = ua.match(/CrOS \w+ ([\d.]+)/))) return { name: 'ChromeOS', version: m[1], family: 'ChromeOS' };
  if ((m = ua.match(/Ubuntu/i))) return { name: 'Ubuntu', version: null, family: 'Linux' };
  if ((m = ua.match(/Fedora/i))) return { name: 'Fedora', version: null, family: 'Linux' };
  if ((m = ua.match(/Linux/i))) return { name: 'Linux', version: null, family: 'Linux' };
  if ((m = ua.match(/FreeBSD[ /]([\d.]+)?/))) return { name: 'FreeBSD', version: m[1] || null, family: 'BSD' };
  return { name: 'unknown', version: null, family: 'unknown' };
}

function parseUA(ua) {
  const s = String(ua).trim();
  let browser = { name: 'unknown', version: null };
  for (const b of BROWSERS) {
    const m = s.match(b.re);
    if (m) { browser = { name: b.name, version: m[1] || null }; break; }
  }
  const os = parseOS(s);
  const engine = (ENGINES.find(([re]) => re.test(s)) || [null, 'unknown'])[1];
  const device = (DEVICES.find(([re]) => re.test(s)) || [null, 'desktop'])[1];
  const botHit = BOTS.find(([re]) => re.test(s));
  const botMatch = s.match(/([A-Za-z0-9_.-]*(?:bot|crawler|spider|scraper)[A-Za-z0-9_.-]*)\/?([\d.]+)?/i);

  const compat = /compatible;\s*([^;)]+)/i.exec(s);
  const arch = (s.match(/x86_64|Win64|WOW64|arm64|aarch64/i) || [null])[0];

  return {
    ua: s,
    browser: browser.name,
    browserVersion: browser.version,
    engine,
    os: os.name,
    osVersion: os.version,
    osFamily: os.family,
    device,
    isBot: Boolean(botHit),
    botName: botHit ? botHit[1] : null,
    botToken: botMatch ? `${botMatch[1]}${botMatch[2] ? '/' + botMatch[2] : ''}` : null,
    isMobile: device === 'mobile' || device === 'tablet',
    isTablet: device === 'tablet',
    isDesktop: device === 'desktop',
    arch: arch || null,
    compat: compat ? compat[1].trim() : null,
    length: s.length,
    tokens: s.split(/[\s()]+/).filter(Boolean).length,
  };
}

const DEMO = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'curl/8.4.0',
];

const flagUa = get(o, 'ua', null);
let inputs;
if (flagUa && flagUa !== true) inputs = [String(flagUa)];
else if (o._.length) {
  const maybeFile = o._[0];
  if (maybeFile === '-' || maybeFile.includes('\n')) inputs = (await readInput(maybeFile)).split(/\r?\n/).filter(Boolean);
  else {
    const { existsSync } = await import('node:fs');
    inputs = existsSync(maybeFile) ? await inputLines(maybeFile) : o._;
  }
} else {
  const stdin = await readInput(null);
  inputs = stdin.trim() ? stdin.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : DEMO;
}

const results = inputs.map(parseUA);

if (flag(o, 'json')) {
  console.log(JSON.stringify(results.length === 1 ? results[0] : { count: results.length, agents: results }, null, 2));
} else if (results.length === 1) {
  const r = results[0];
  console.log(table([
    { field: 'browser', value: `${r.browser}${r.browserVersion ? ' ' + r.browserVersion : ''}` },
    { field: 'engine', value: r.engine },
    { field: 'os', value: `${r.os}${r.osVersion ? ' ' + r.osVersion : ''}` },
    { field: 'device', value: r.device },
    { field: 'bot', value: r.isBot ? `yes (${r.botName})` : 'no' },
    { field: 'arch', value: r.arch || '—' },
    { field: 'length', value: `${r.length} chars / ${r.tokens} tokens` },
  ]));
} else {
  console.log(table(results.map((r, i) => ({
    '#': i + 1,
    browser: `${r.browser}${r.browserVersion ? ' ' + r.browserVersion.split('.')[0] : ''}`,
    os: r.os,
    device: r.device,
    bot: r.isBot ? r.botName || 'yes' : '',
    ua: r.ua.slice(0, 52),
  }))));
}
process.exitCode = 0;
