#!/usr/bin/env node
// podcheck.js — proof-of-done check: run tools on REAL input and fail on any
// stack trace, because smoke.js only sees the --help and no-argument paths.
// Copyright (c) 2026 0xnothings
// Usage: node podcheck.js <repo-dir> [...]
//
// A tool can pass --help, pass a bare invocation, and still crash at the end of
// its real code path (massparse did: correct output, then an unhandled sentinel
// printed a stack trace). The only way to catch that class is to actually run
// the thing against an input that makes it do work.
//
// Each case is: tool, args, and an optional fixture the runner writes first.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const STACK = /(^\s*at\s+\S+.*:\d+:\d+|ReferenceError|SyntaxError|TypeError|Assertion failed|UV_HANDLE_CLOSING|unhandledRejection|is not defined)/m;

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node podcheck.js <repo-dir> [...]'); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'podcheck-'));

// Fixtures used by the cases below.
const FX = {
  'nmap.xml': `<?xml version="1.0"?><nmaprun><host><status state="up"/><address addr="93.184.216.34" addrtype="ipv4"/><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx" version="1.24.0"/></port></ports></host></nmaprun>`,
  'hosts.txt': '93.184.216.34\t80\topen\thttp\n93.184.216.34\t443\topen\thttps\n',
  'greppable.txt': 'Host: 93.184.216.34 ()\n\tPorts: 80/open/tcp//http///\n',
  'domains.txt': 'example.com\nexample.org\n',
  't.csv': 'id,name,score\n1,alice,9\n2,bob,7\n',
  'o.json': '{"a":1,"b":{"c":[1,2,3]}}',
  'n.json': '{"a":2,"b":{"c":[1,2,4]},"d":true}',
  't.log': '93.184.216.34 - - [15/Nov/2026:12:00:00 +0000] "GET / HTTP/1.1" 200 1234 "-" "curl/8.0"\n',
  'compose.yml': 'services:\n  api:\n    image: nginx:latest\n    privileged: true\n    ports:\n      - "8080:8080"\n',
  'sshd_config': 'PermitRootLogin yes\nPasswordAuthentication yes\nPort 22\n',
  'cron.txt': '*/5 * * * * root /usr/local/bin/backup.sh\n',
  'path.txt': '/usr/local/bin:/usr/bin:/bin\n',
  'ini.cfg': '[s]\nurl = "https://example.com/a//b"\nkey = value\n',
  't.toml': '[table]\nurl = "https://example.com/x"\nn = 42\n',
  'y.yaml': 'name: test\nitems:\n  - a\n  - b\n',
  'q.sql': 'SELECT a, b FROM t WHERE id = 1 AND name = \'x\' ORDER BY a;\n',
  'dup.json': '{"a":1,"a":2}\n',
  'big.json': '{"n": 9007199254740993}\n',
};
for (const [name, body] of Object.entries(FX)) writeFileSync(join(tmp, name), body, 'utf8');
const P = (name) => join(tmp, name).replace(/\\/g, '/');

// Cases: [toolFile, args...]. Only listed tools are exercised; the rest are
// covered by smoke.js --deep.
const CASES = {
  'tools-security': [
    ['massparse.js', P('nmap.xml')],
    ['massparse.js', P('hosts.txt')],
    ['massparse.js', P('greppable.txt')],
    ['dnsrecon.js', 'example.com'],
    ['whoisparse.js', 'example.com'],
    ['crtlookup.js', 'example.com', '--limit', '3'],
    ['internetdb.js', '1.1.1.1'],
    ['ipintel.js', '1.1.1.1'],
    ['asnmap.js', '--ip', '1.1.1.1'],
    ['hackertarget.js', 'dnslookup', 'example.com'],
    ['dorkgen.js', 'example.com'],
    ['sessioncheck.js', 'https://example.com'],
    ['cspreporter.js', 'https://example.com'],
    ['svcaudit.js', 'example.com'],
    
    ['tlsinfo.js', 'example.com'],
    ['svcfinger.js', 'scanme.nmap.org', '--ports', '22,80'],
    ['sshkeyaudit.js', P('sshd_config')],
    ['postexploit.js', '--path', P('path.txt')],
    ['jwtforge.js', '--alg', 'none'],
    ['cracker.js', '--help'],
    ['encryptfile.js', '--help'],
    ['nosqli.js', '--help'],
    ['crlfsplit.js', '--help'],
    ['smuggle.js', '--help'],
    ['templateinject.js', '--help'],
    ['wsprobe.js', '--help'],
    ['xxecheck.js', '--help'],
    ['gittools.js', '--help'],
    ['covertunnel.js', '--help'],
    ['ratelimitmap.js', '--help'],
  ],
  'tools-devops': [
    ['composecheck.js', P('compose.yml')],
    ['sshconfig.js', P('sshd_config')],
    ['cronaudit.js', P('cron.txt')],
    ['pathaudit.js', '--path', P('path.txt')],
    ['makefile.js', '--help'],
    ['k8scheck.js', '--help'],
    ['terraformaudit.js', '--help'],
    ['playbookaudit.js', '--help'],
    ['kvmreport.js', '--help'],
    ['systemdunit.js', '--help'],
    ['envdiff.js', '--help'],
    ['portforward.js', '--help'],
    ['basicauth.js', '--help'],
    ['htpasswdgen.js', '--help'],
    ['nfsmount.js', '--help'],
    ['smarthealth.js', '--help'],
    ['diskusage.js', '--help'],
    ['bandwidth.js', '--help'],
    ['dnspropagate.js', 'example.com'],
    ['tlsgrade.js', 'example.com'],
    ['uptimecalc.js', '--help'],
    ['incidentlog.js', '--help'],
    ['runbookgen.js', '--help'],
    ['dockerfilecheck.js', '--help'],
    ['imagetag.js', '--help'],
    ['envrc.js', '--help'],
    ['cronconvert.js', '--help'],
    ['lbcheck.js', '--help'],
    ['certchain.js', 'example.com'],
    ['mailauth.js', 'example.com'],
  ],
  'tools-web': [
    ['httpstatus.js', '404'],
    ['uacheck.js', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'],
    ['urlx.js', 'https://x.com/a?utm_source=fb&id=3'],
    ['markdownify.js', P('t.csv')],
    ['tabletext.js', P('t.csv')],
    ['htmlvalid.js', P('t.csv')],
    ['jsonld.js', P('t.csv')],
    ['microdata.js', P('t.csv')],
    ['opengraph.js', P('t.csv')],
    ['schemagen.js', P('o.json')],
    ['contractcheck.js', '--help'],
    ['mockjson.js', P('o.json')],
    ['apidoc.js', P('o.json')],
    ['corsmatrix.js', '--help'],
    ['cacheheader.js', 'https://example.com'],
    ['sitemapvalidate.js', '--help'],
    ['sitemapdiff.js', '--help'],
    ['searchurl.js', '--help'],
    ['webfont.js', 'https://example.com'],
    ['csspeek.js', 'https://example.com'],
    ['pagestruct.js', 'https://example.com'],
    ['readtime.js', 'https://example.com'],
    ['keyworddensity.js', 'https://example.com'],
  ],
  'tools-data': [
    ['targz.js', '--help'],
    ['cpio.js', '--help'],
    ['filetype.js', P('t.csv')],
    ['strings.js', P('t.csv'), '--limit', '3'],
    ['hexdumpx.js', P('t.csv')],
    ['entropyscan.js', P('t.csv')],
    ['jsonlint.js', P('dup.json')],
    ['jsonlint.js', P('big.json')],
    ['iniscan.js', P('ini.cfg')],
    ['tomlpeek.js', P('t.toml')],
    ['yamlpeek.js', P('y.yaml')],
    ['sqlformat.js', P('q.sql')],
    ['schemadump.js', P('q.sql')],
    ['jsonmerge.js', P('o.json')],
    ['jsonflatten.js', P('o.json')],
    ['jsonmask.js', P('o.json')],
    ['jsonlint.js', P('o.json')],
    ['jsonsplit.js', P('o.json'), '--shards', '2'],
    ['tsv2md.js', P('t.csv')],
    ['graphtext.js', P('t.csv')],
    ['unitconvert.js', '--help'],
    ['numberfmt.js', '--help'],
    ['csvpeek.js', P('t.csv')],
    ['csvsql.js', P('t.csv'), 'SELECT name FROM t WHERE score > 7'],
    ['jsondiff.js', P('o.json'), P('n.json')],
    ['snifftable.js', P('t.log')],
    ['netflowstat.js', '--help'],
    ['hashdir.js', tmp.replace(/\\/g, '/')],
    ['logtail.js', P('t.log')],
  ],
};

let ran = 0, failed = 0;
for (const dir of dirs) {
  const repo = dir.split(/[\\/]/).filter(Boolean).pop();
  const cases = CASES[repo];
  if (!cases) continue;
  console.log(`\n${repo}:`);

  for (const [file, ...argList] of cases) {
    const p = join(dir, 'tools', file);
    if (!existsSync(p)) { console.log(`  MISSING ${file}`); failed++; continue; }
    ran++;
    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, [p, ...argList], { stdio: 'pipe', timeout: 45000, encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      code = typeof e.status === 'number' ? e.status : -1;
    }
    if (STACK.test(out)) {
      failed++;
      const line = out.split('\n').find((l) => STACK.test(l)) || '';
      console.log(`  CRASH ${file} ${argList.join(' ').slice(0, 34)}  exit=${code}`);
      console.log(`        ${line.trim().slice(0, 100)}`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran} real invocations, ${failed} with a stack trace.`);
process.exit(failed ? 1 : 0);
