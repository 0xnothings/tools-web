#!/usr/bin/env node
// httpstatus.js — explain any HTTP status code.
// Copyright (c) 2026 0xnothings
// @tool httpstatus
// @desc Look up any HTTP status code (1xx-5xx plus unofficial ones) with meaning, cause and fix hints
// @usage node tools/httpstatus.js 429 --json
// @tags web,http,reference
import { args, get, flag, die, table } from '../_lib.js';

const o = args(process.argv.slice(2));
if (o.f.help) {
  console.log(`httpstatus — HTTP status code reference

  node tools/httpstatus.js [code|class|text] [options]

  node tools/httpstatus.js            list every code
  node tools/httpstatus.js 404        explain one code
  node tools/httpstatus.js 4xx        list one class
  node tools/httpstatus.js not found  search by phrase

  --json       machine-readable output
  --fix        only show the remediation section
  -h, --help   this text

  Covers RFC 9110/9111/7231-7235, RFC 6585, RFC 8297, plus the widely deployed
  unofficial codes (Cloudflare 520-527, nginx 444/494-499, IIS 440/449).`);
  process.exit(0);
}

const DB = [
  { code: 100, name: 'Continue', cls: 'informational', rfc: 'RFC 9110', md: 'The server received the request headers and the client should proceed to send the body.',
    cause: 'A client sent Expect: 100-continue before uploading a large body.', fix: 'Nothing to fix — it is an interim response. If it never arrives, the client should send the body anyway after a short timeout.' },
  { code: 101, name: 'Switching Protocols', cls: 'informational', rfc: 'RFC 9110', md: 'The server is switching to the protocol named in the Upgrade header.',
    cause: 'WebSocket or HTTP/2 upgrade handshake.', fix: 'Expected for WebSockets. If unexpected, check the Upgrade/Connection headers on both sides.' },
  { code: 102, name: 'Processing', cls: 'informational', rfc: 'RFC 2518', md: 'The server has received and is processing the request, but no response is available yet (WebDAV).',
    cause: 'Long-running WebDAV operation.', fix: 'Wait. If it never completes, look at the server-side task queue.' },
  { code: 103, name: 'Early Hints', cls: 'informational', rfc: 'RFC 8297', md: 'The server sends preliminary headers (usually Link: rel=preload) before the final response.',
    cause: 'A CDN or origin optimising LCP with preload hints.', fix: 'Nothing to fix — it is an optimisation. Verify the preloaded URLs are correct.' },

  { code: 200, name: 'OK', cls: 'success', rfc: 'RFC 9110', md: 'The request succeeded and the response payload carries the result.',
    cause: 'Normal successful request.', fix: 'Nothing to do.' },
  { code: 201, name: 'Created', cls: 'success', rfc: 'RFC 9110', md: 'The request succeeded and a new resource was created; Location identifies it.',
    cause: 'POST that creates a resource.', fix: 'Read the Location header to learn the new resource URL.' },
  { code: 202, name: 'Accepted', cls: 'success', rfc: 'RFC 9110', md: 'The request was accepted for processing but is not complete.',
    cause: 'Asynchronous job queued (batch import, video encode).', fix: 'Poll the status URL the API returns; do not assume completion.' },
  { code: 203, name: 'Non-Authoritative Information', cls: 'success', rfc: 'RFC 9110', md: 'The returned metadata came from a transforming proxy, not the origin.',
    cause: 'A proxy rewrote the response (rare; some caching gateways).', fix: 'Usually harmless. If exactness matters, bypass the proxy.' },
  { code: 204, name: 'No Content', cls: 'success', rfc: 'RFC 9110', md: 'The request succeeded and there is no body to return.',
    cause: 'DELETE, PUT, or a preflight OPTIONS response.', fix: 'Do not try to parse a body — there is none. A body here breaks HTTP/1.1 framing.' },
  { code: 205, name: 'Reset Content', cls: 'success', rfc: 'RFC 9110', md: 'The client should reset the document view that submitted the request.',
    cause: 'Form submission where the form should be cleared.', fix: 'Nothing on the client; rarely used in APIs.' },
  { code: 206, name: 'Partial Content', cls: 'success', rfc: 'RFC 9110', md: 'The server is delivering part of the resource in response to a Range request.',
    cause: 'Range: bytes=0-1023, used by video players and download resumers.', fix: 'Verify the Content-Range header; retry the remaining range if the connection drops.' },
  { code: 207, name: 'Multi-Status', cls: 'success', rfc: 'RFC 4918', md: 'The body is a multi-status XML document with per-resource results (WebDAV).',
    cause: 'PROPFIND or batch operations.', fix: 'Parse the individual status elements inside the XML body.' },
  { code: 208, name: 'Already Reported', cls: 'success', rfc: 'RFC 5842', md: 'The members of a DAV binding were already enumerated in a previous reply.',
    cause: 'WebDAV with repetitive bindings.', fix: 'Ignore — it is a de-duplication signal.' },
  { code: 226, name: 'IM Used', cls: 'success', rfc: 'RFC 3229', md: 'The server fulfilled a GET with instance manipulations applied.',
    cause: 'Delta encoding (rare).', fix: 'Apply the delta the server describes.' },

  { code: 300, name: 'Multiple Choices', cls: 'redirect', rfc: 'RFC 9110', md: 'Several representations exist; the client may pick one.',
    cause: 'Content negotiation without a clear winner.', fix: 'Send an explicit Accept header so the server can choose.' },
  { code: 301, name: 'Moved Permanently', cls: 'redirect', rfc: 'RFC 9110', md: 'The resource has moved permanently; caches and clients should update their links.',
    cause: 'Site restructure, http→https, apex→www.', fix: 'Update your links to the Location target. POST bodies may be converted to GET by some clients — prefer 308 to avoid that.' },
  { code: 302, name: 'Found', cls: 'redirect', rfc: 'RFC 9110', md: 'The resource is temporarily at another URL.',
    cause: 'Login flows, A/B tests, geo-routing.', fix: 'Follow it for the moment; do not hard-code the target.' },
  { code: 303, name: 'See Other', cls: 'redirect', rfc: 'RFC 9110', md: 'Fetch the target with GET instead — the correct way to finish a POST.',
    cause: 'Post/Redirect/Get pattern after form submission.', fix: 'Your client should switch to GET for the next request.' },
  { code: 304, name: 'Not Modified', cls: 'redirect', rfc: 'RFC 9110', md: 'Your cached copy is still valid; there is no body.',
    cause: 'If-None-Match / If-Modified-Since conditional request.', fix: 'Serve from cache. If your client expects a body, it must handle 304 explicitly.' },
  { code: 305, name: 'Use Proxy', cls: 'redirect', rfc: 'RFC 9110 (deprecated)', md: 'Deprecated: the client should use the specified proxy.',
    cause: 'Legacy proxy configuration.', fix: 'Deprecated for security reasons — configure the proxy out of band.' },
  { code: 307, name: 'Temporary Redirect', cls: 'redirect', rfc: 'RFC 9110', md: 'Temporary redirect that preserves the request method and body.',
    cause: 'Maintenance mode, load balancing.', fix: 'Retry the same request against the Location target.' },
  { code: 308, name: 'Permanent Redirect', cls: 'redirect', rfc: 'RFC 9110', md: 'Permanent redirect that preserves the request method and body.',
    cause: 'https migration, API version move.', fix: 'Update your client to the new endpoint — this is permanent.' },

  { code: 400, name: 'Bad Request', cls: 'client-error', rfc: 'RFC 9110', md: 'The server cannot parse or accept the request.',
    cause: 'Malformed JSON, missing required field, bad content-type, invalid header value.', fix: 'Log the raw request body and headers. Validate the payload against the schema before sending.' },
  { code: 401, name: 'Unauthorized', cls: 'client-error', rfc: 'RFC 9110', md: 'Authentication is required and was missing or invalid. (It really means unauthenticated.)',
    cause: 'No token, expired token, wrong auth scheme.', fix: 'Send credentials. Check the WWW-Authenticate header for the expected scheme, then re-authenticate.' },
  { code: 402, name: 'Payment Required', cls: 'client-error', rfc: 'RFC 9110', md: 'Reserved for payment systems; used by Stripe and some APIs for billing/quota failures.',
    cause: 'Unpaid invoice, exceeded plan, card declined.', fix: 'Check the api key scope and the account billing state.' },
  { code: 403, name: 'Forbidden', cls: 'client-error', rfc: 'RFC 9110', md: 'The server understood the request but refuses to authorise it. Re-authenticating will not help.',
    cause: 'Insufficient scope/role, IP allowlist, WAF rule, missing CSRF token.', fix: 'Check permissions and scope — not credentials. A 403 with a valid token means an authorisation gap, not an auth gap.' },
  { code: 404, name: 'Not Found', cls: 'client-error', rfc: 'RFC 9110', md: 'The target resource does not exist, or the server denies its existence.',
    cause: 'Typo in the path, deleted resource, or a deliberate masking of a 403.', fix: 'Verify the URL and method. Some APIs return 404 instead of 403 to avoid leaking resource existence.' },
  { code: 405, name: 'Method Not Allowed', cls: 'client-error', rfc: 'RFC 9110', md: 'The resource exists but does not support this HTTP method.',
    cause: 'POST to a read-only endpoint.', fix: 'Read the Allow header — it lists the supported methods.' },
  { code: 406, name: 'Not Acceptable', cls: 'client-error', rfc: 'RFC 9110', md: 'No representation matches the Accept headers you sent.',
    cause: 'Accept: application/xml on a JSON-only API.', fix: 'Send a supported Accept value. Some APIs return 406 instead of 415 for content-type mismatches.' },
  { code: 407, name: 'Proxy Authentication Required', cls: 'client-error', rfc: 'RFC 9110', md: 'The client must authenticate with the proxy first.',
    cause: 'Corporate proxy without credentials.', fix: 'Set Proxy-Authorization (or the proxy credentials in your HTTP client).' },
  { code: 408, name: 'Request Timeout', cls: 'client-error', rfc: 'RFC 9110', md: 'The server timed out waiting for the request.',
    cause: 'Slow client upload, stalled connection.', fix: 'Retry; if it persists, check upload size and connection stability.' },
  { code: 409, name: 'Conflict', cls: 'client-error', rfc: 'RFC 9110', md: 'The request conflicts with the current state of the target resource.',
    cause: 'Duplicate unique key, edit conflict, concurrent write.', fix: 'Re-read the resource, merge, retry. For upserts use the API\'s idempotency key.' },
  { code: 410, name: 'Gone', cls: 'client-error', rfc: 'RFC 9110', md: 'The resource existed and has been permanently removed.',
    cause: 'Deleted record, retired API version.', fix: 'Stop retrying and remove the reference. Unlike 404, this will not come back.' },
  { code: 411, name: 'Length Required', cls: 'client-error', rfc: 'RFC 9110', md: 'The request needs a Content-Length header.',
    cause: 'Chunked request to a server that requires a length.', fix: 'Set Content-Length, or use a streaming API that supports chunked transfer.' },
  { code: 412, name: 'Precondition Failed', cls: 'client-error', rfc: 'RFC 9110', md: 'An If-Match / If-Unmodified-Since precondition evaluated to false.',
    cause: 'Optimistic locking — someone else modified the resource first.', fix: 'Re-fetch the resource, apply your change to the fresh version, resend with the new ETag.' },
  { code: 413, name: 'Content Too Large', cls: 'client-error', rfc: 'RFC 9110', md: 'The request body exceeds the server limit.',
    cause: 'Upload above the configured max (nginx client_max_body_size, API payload cap).', fix: 'Chunk the upload (multipart or presigned S3 parts) or raise the server limit.' },
  { code: 414, name: 'URI Too Long', cls: 'client-error', rfc: 'RFC 9110', md: 'The request target is longer than the server will interpret.',
    cause: 'Huge query string, GET used where POST belongs, redirect loop appending parameters.', fix: 'Move data into the request body, or shorten the parameter set.' },
  { code: 415, name: 'Unsupported Media Type', cls: 'client-error', rfc: 'RFC 9110', md: 'The payload format is not supported for this method on this resource.',
    cause: 'Missing or wrong Content-Type header.', fix: 'Set Content-Type: application/json (or whatever the API documents). Sending JSON without the header is the usual culprit.' },
  { code: 416, name: 'Range Not Satisfiable', cls: 'client-error', rfc: 'RFC 9110', md: 'The Range header cannot be fulfilled for this resource.',
    cause: 'Requesting bytes beyond the file size.', fix: 'Read the actual size first, then request a valid range.' },
  { code: 417, name: 'Expectation Failed', cls: 'client-error', rfc: 'RFC 9110', md: 'The Expect header cannot be met by this server.',
    cause: 'Expect: 100-continue against a server that does not support it.', fix: 'Remove the Expect header and send the body directly.' },
  { code: 418, name: "I'm a teapot", cls: 'client-error', rfc: 'RFC 2324 (April Fools)', md: 'Short and stout. Used as an easter egg and by some APIs to signal "do not automate this".',
    cause: 'Deliberate joke response; some anti-bot systems return it.', fix: 'Treat it as a soft block. If an API returns it consistently, check its automation policy.' },
  { code: 421, name: 'Misdirected Request', cls: 'client-error', rfc: 'RFC 9110', md: 'The request reached a server that cannot produce a response for this authority.',
    cause: 'HTTP/2 connection coalescing across SNI names.', fix: 'Open a fresh connection for that hostname instead of reusing the pooled one.' },
  { code: 422, name: 'Unprocessable Content', cls: 'client-error', rfc: 'RFC 9110', md: 'Syntax is fine but the payload is semantically invalid.',
    cause: 'Validation failure — unknown enum, negative quantity, bad date format.', fix: 'Read the error detail in the body; it usually names the offending field.' },
  { code: 423, name: 'Locked', cls: 'client-error', rfc: 'RFC 4918', md: 'The resource is locked (WebDAV) or the account is locked.',
    cause: 'WebDAV write lock, or an admin-disabled account.', fix: 'Release the lock or resolve the account state.' },
  { code: 424, name: 'Failed Dependency', cls: 'client-error', rfc: 'RFC 4918', md: 'The request failed because a dependency of it failed.',
    cause: 'Batch operation where another item errored.', fix: 'Inspect the multi-status body for the failing member.' },
  { code: 425, name: 'Too Early', cls: 'client-error', rfc: 'RFC 8470', md: 'The server is unwilling to risk processing a request that might be replayed.',
    cause: 'TLS early-data (0-RTT) replay protection.', fix: 'Retry without early data — a normal handshake request will succeed.' },
  { code: 426, name: 'Upgrade Required', cls: 'client-error', rfc: 'RFC 9110', md: 'The server refuses the request without a protocol upgrade.',
    cause: 'Server requires TLS or a newer HTTP version.', fix: 'Read the Upgrade header, then retry over the required protocol.' },
  { code: 428, name: 'Precondition Required', cls: 'client-error', rfc: 'RFC 6585', md: 'The origin requires the request to be conditional.',
    cause: 'API requires If-Match to avoid the lost-update problem.', fix: 'Fetch the ETag first, then send If-Match with your write.' },
  { code: 429, name: 'Too Many Requests', cls: 'client-error', rfc: 'RFC 6585', md: 'The client has sent too many requests in a given time window.',
    cause: 'Rate limit exceeded, burst detection, per-key quota.', fix: 'Read Retry-After and the RateLimit-* headers, then back off exponentially with jitter. Do not retry immediately — that digs the hole deeper.' },
  { code: 431, name: 'Request Header Fields Too Large', cls: 'client-error', rfc: 'RFC 6585', md: 'One header or the whole header block is too large.',
    cause: 'Oversized cookie (a classic), or a huge Authorization token.', fix: 'Trim cookies, split the token, or raise the server limit. Check for a cookie-leak that keeps re-adding values.' },
  { code: 451, name: 'Unavailable For Legal Reasons', cls: 'client-error', rfc: 'RFC 7725', md: 'The resource is blocked for legal reasons (censorship, DMCA, sanctions).',
    cause: 'Geo-block, court order, takedown.', fix: 'Nothing technical to fix — it is a policy block. Check for a Link header pointing at the legal notice.' },

  { code: 500, name: 'Internal Server Error', cls: 'server-error', rfc: 'RFC 9110', md: 'The server hit an unexpected condition and could not fulfil the request.',
    cause: 'Unhandled exception, null dereference, bad deploy, DB connection failure.', fix: 'Retry once with backoff. If reproducible, this is a server bug — send the request id/trace id from the response headers to the API owner.' },
  { code: 501, name: 'Not Implemented', cls: 'server-error', rfc: 'RFC 9110', md: 'The server does not support the functionality required to fulfil the request.',
    cause: 'Unknown method, or WebDAV verb on a non-DAV server.', fix: 'Check the method against the API docs. Not retryable as-is.' },
  { code: 502, name: 'Bad Gateway', cls: 'server-error', rfc: 'RFC 9110', md: 'A gateway or proxy received an invalid response from the upstream server.',
    cause: 'Origin down, crashed worker, TLS mismatch between proxy and origin, timeout upstream.', fix: 'Retry with backoff. If persistent, it is an infrastructure problem between the edge and the origin, not your request.' },
  { code: 503, name: 'Service Unavailable', cls: 'server-error', rfc: 'RFC 9110', md: 'The server is currently unable to handle the request — usually temporary.',
    cause: 'Overload, maintenance, cold start, connection pool exhaustion.', fix: 'Honour Retry-After, then retry with exponential backoff and jitter.' },
  { code: 504, name: 'Gateway Timeout', cls: 'server-error', rfc: 'RFC 9110', md: 'A gateway did not receive a timely response from the upstream server.',
    cause: 'Slow origin query, upstream timeout below yours.', fix: 'Retry. For long jobs, switch to an async API — the synchronous path will keep timing out.' },
  { code: 505, name: 'HTTP Version Not Supported', cls: 'server-error', rfc: 'RFC 9110', md: 'The HTTP protocol version used is not supported.',
    cause: 'HTTP/2 or /3 attempt against an HTTP/1.1-only server, or a malformed version token.', fix: 'Downgrade the protocol version in your client.' },
  { code: 506, name: 'Variant Also Negotiates', cls: 'server-error', rfc: 'RFC 2295', md: 'Transparent content negotiation has a circular reference.',
    cause: 'Misconfigured negotiation on the server.', fix: 'Server-side fix: correct the negotiation configuration. Send an explicit Accept to work around it.' },
  { code: 507, name: 'Insufficient Storage', cls: 'server-error', rfc: 'RFC 4918', md: 'The server cannot store the representation needed to complete the request.',
    cause: 'Disk full, quota exhausted (WebDAV/cloud storage).', fix: 'Free space or raise the quota, then retry.' },
  { code: 508, name: 'Loop Detected', cls: 'server-error', rfc: 'RFC 5842', md: 'The server detected an infinite loop while processing the request.',
    cause: 'Circular WebDAV bindings or a redirect/rewrite loop.', fix: 'Break the loop server-side (rewrite rules, symlink cycles).' },
  { code: 510, name: 'Not Extended', cls: 'server-error', rfc: 'RFC 2774', md: 'Further extensions to the request are required for the server to fulfil it.',
    cause: 'HTTP extension framework (rare).', fix: 'Read the extension headers the server demands.' },
  { code: 511, name: 'Network Authentication Required', cls: 'server-error', rfc: 'RFC 6585', md: 'The client needs to authenticate to gain network access.',
    cause: 'Captive portal (hotel/airport WiFi).', fix: 'Open the portal in a browser and sign in, then retry.' },

  { code: 440, name: 'Login Time-out', cls: 'vendor', rfc: 'IIS', md: 'The client session expired and must log in again.',
    cause: 'IIS session timeout.', fix: 'Re-authenticate and resend.' },
  { code: 444, name: 'No Response', cls: 'vendor', rfc: 'nginx', md: 'nginx closed the connection without sending any response.',
    cause: 'Deliberate connection drop by an nginx rule — often anti-bot or deny rules.', fix: 'The connection was killed on purpose. Check whether your client is being blocked.' },
  { code: 449, name: 'Retry With', cls: 'vendor', rfc: 'IIS', md: 'The request should be retried after an appropriate action.',
    cause: 'IIS needs more information (usually credentials).', fix: 'Read the Ms-* headers and retry with the required data.' },
  { code: 494, name: 'Request Header Too Large', cls: 'vendor', rfc: 'nginx', md: 'nginx-specific: headers exceed the buffer size.',
    cause: 'Oversized request headers.', fix: 'Reduce header size (commonly cookies) or raise large_client_header_buffers.' },
  { code: 495, name: 'SSL Certificate Error', cls: 'vendor', rfc: 'nginx', md: 'The client certificate failed verification.',
    cause: 'mTLS client cert invalid or untrusted.', fix: 'Fix the client certificate chain.' },
  { code: 496, name: 'SSL Certificate Required', cls: 'vendor', rfc: 'nginx', md: 'A client certificate is required but none was provided.',
    cause: 'mTLS endpoint.', fix: 'Present a client certificate.' },
  { code: 497, name: 'HTTP Request Sent to HTTPS Port', cls: 'vendor', rfc: 'nginx', md: 'Plain HTTP was sent to a TLS port.',
    cause: 'Using http:// against port 443.', fix: 'Use https:// for that port — or the redirect listener if the server has one.' },
  { code: 498, name: 'Invalid Token', cls: 'vendor', rfc: 'nginx / common', md: 'Invalid or expired token (used by many gateways).',
    cause: 'Expired JWT, revoked API key.', fix: 'Refresh the token.' },
  { code: 499, name: 'Client Closed Request', cls: 'vendor', rfc: 'nginx', md: 'The client closed the connection before the server responded.',
    cause: 'Client timeout shorter than the server response time.', fix: 'Raise the client timeout, or make the endpoint faster/async. A 499 means you gave up, not that the server failed.' },
  { code: 520, name: 'Web Server Returned an Unknown Error', cls: 'vendor', rfc: 'Cloudflare', md: 'Cloudflare received an empty or unknown response from the origin.',
    cause: 'Origin crashed, or returned a malformed/empty reply.', fix: 'Check the origin is healthy and its error logs. Usually an origin bug.' },
  { code: 521, name: 'Web Server Is Down', cls: 'vendor', rfc: 'Cloudflare', md: 'The origin refused the connection from Cloudflare.',
    cause: 'Origin process not listening, firewall blocking Cloudflare IPs.', fix: 'Start the origin service and allow Cloudflare ranges.' },
  { code: 522, name: 'Connection Timed Out', cls: 'vendor', rfc: 'Cloudflare', md: 'Cloudflare could not complete the TCP handshake with the origin in time.',
    cause: 'Origin overloaded or dropping packets.', fix: 'Scale the origin or fix the network path between Cloudflare and origin.' },
  { code: 523, name: 'Origin Is Unreachable', cls: 'vendor', rfc: 'Cloudflare', md: 'The origin address could not be reached at all.',
    cause: 'Wrong origin IP in DNS config, BGP issue.', fix: 'Verify the origin address Cloudflare is using.' },
  { code: 524, name: 'A Timeout Occurred', cls: 'vendor', rfc: 'Cloudflare', md: 'Cloudflare connected to the origin but the origin did not respond within 100 seconds.',
    cause: 'Long-running request exceeding the Cloudflare proxy timeout.', fix: 'Move the work to a background job; for the request itself, use Cloudflare\'s async patterns.' },
  { code: 525, name: 'SSL Handshake Failed', cls: 'vendor', rfc: 'Cloudflare', md: 'The TLS handshake between Cloudflare and the origin failed.',
    cause: 'Origin TLS misconfiguration, expired cert, wrong port.', fix: 'Run openssl s_client against the origin and compare the cert chain.' },
  { code: 526, name: 'Invalid SSL Certificate', cls: 'vendor', rfc: 'Cloudflare', md: 'Cloudflare could not validate the origin certificate.',
    cause: 'Self-signed or expired origin certificate with Full (strict) mode.', fix: 'Install a valid origin cert or switch to Full (not strict) knowingly.' },
  { code: 527, name: 'Railgun Listener to Origin Error', cls: 'vendor', rfc: 'Cloudflare', md: 'Connection between Cloudflare and the Railgun listener failed.',
    cause: 'Legacy Railgun tunnel problem.', fix: 'Railgun is deprecated — remove it from the origin setup.' },
  { code: 529, name: 'Site Is Overloaded', cls: 'vendor', rfc: 'Qualys / ISC', md: 'The site is overloaded (Circuit Breaker).',
    cause: 'Capacity exceeded.', fix: 'Retry later with backoff.' },
  { code: 530, name: 'Site Is Frozen', cls: 'vendor', rfc: 'Cloudflare / Pantheon', md: 'The site is frozen (Cloudflare 1xxx family or Pantheon).',
    cause: 'Account/site suspended or frozen by the host.', fix: 'Check the hosting panel for a suspension notice.' },
  { code: 598, name: 'Network Read Timeout Error', cls: 'vendor', rfc: 'non-standard', md: 'A network read timeout behind a proxy.',
    cause: 'Proxy read timeout.', fix: 'Increase the proxy read timeout or optimise the backend.' },
  { code: 599, name: 'Network Connect Timeout Error', cls: 'vendor', rfc: 'non-standard', md: 'A network connect timeout behind a proxy.',
    cause: 'Proxy could not connect upstream.', fix: 'Check upstream reachability and the proxy configuration.' },
];

const CLASSES = {
  '1xx': { label: 'informational', note: 'Interim responses. The request continues.' },
  '2xx': { label: 'success', note: 'The request was received, understood and accepted.' },
  '3xx': { label: 'redirect', note: 'Further action is needed to complete the request.' },
  '4xx': { label: 'client-error', note: 'The request contains a problem the client can usually fix.' },
  '5xx': { label: 'server-error', note: 'The server failed. Retrying may or may not help.' },
};

const query = o._[0];
const total = DB.length;

function printOne(e) {
  if (flag(o, 'json')) {
    console.log(JSON.stringify(e, null, 2));
    return;
  }
  if (flag(o, 'fix')) { console.log(`${e.code} ${e.name}\n  ${e.fix}`); return; }
  console.log(`${e.code} ${e.name}`);
  console.log(`  class:   ${e.cls}   source: ${e.rfc}`);
  console.log(`  meaning: ${e.md}`);
  console.log(`  cause:   ${e.cause}`);
  console.log(`  fix:     ${e.fix}`);
}

if (!query) {
  if (flag(o, 'json')) console.log(JSON.stringify({ count: total, classes: CLASSES, codes: DB }, null, 2));
  else {
    console.log(`${total} codes\n`);
    if (flag(o, 'fix')) { for (const e of DB) console.log(`${e.code} ${e.name}\n  ${e.fix}`); }
    else console.log(table(DB.map((e) => ({ code: e.code, name: e.name.slice(0, 34), class: e.cls, source: e.rfc }))));
  }
  process.exitCode = 0;
} else if (/^[1-5]xx$/i.test(query)) {
  const cls = CLASSES[query.toLowerCase()];
  const rows = DB.filter((e) => e.cls === cls.label);
  if (flag(o, 'json')) console.log(JSON.stringify({ class: query.toLowerCase(), ...cls, codes: rows }, null, 2));
  else {
    console.log(`${query} ${cls.label} — ${cls.note}\n`);
    if (flag(o, 'fix')) { for (const e of rows) console.log(`${e.code} ${e.name}\n  ${e.fix}`); }
    else console.log(table(rows.map((e) => ({ code: e.code, name: e.name.slice(0, 34), source: e.rfc, meaning: e.md.slice(0, 44) }))));
  }
  process.exitCode = 0;
} else if (/^\d{3}$/.test(query)) {
  const code = Number(query);
  const e = DB.find((x) => x.code === code);
  if (!e) {
    const clsNum = Math.floor(code / 100);
    const cls = CLASSES[`${clsNum}xx`];
    if (flag(o, 'json')) { console.log(JSON.stringify({ code, known: false, class: cls ? cls.label : 'invalid', note: cls ? cls.note : 'Not a valid HTTP status class (must be 100-599).' }, null, 2)); process.exitCode = 0; }
    else {
      console.log(`${code} — not in the reference table`);
      console.log(cls ? `  class:   ${cls.label}\n  note:    ${cls.note}` : '  invalid: status codes must be 100-599');
      console.log('  The server is using a non-standard code. Check its documentation.');
      process.exitCode = 3;
    }
  } else { printOne(e); process.exitCode = 0; }
} else {
  const needle = String(query).toLowerCase();
  const hits = DB.filter((e) => e.name.toLowerCase().includes(needle) || e.md.toLowerCase().includes(needle) || e.cause.toLowerCase().includes(needle));
  if (!hits.length) die(`no status code matches "${query}" — try: node tools/httpstatus.js 404, 4xx, 5xx, or with no argument for the full list`);
  if (flag(o, 'json')) console.log(JSON.stringify({ query, matches: hits.length, codes: hits }, null, 2));
  else {
    console.log(`${hits.length} match(es) for "${query}"\n`);
    console.log(table(hits.map((e) => ({ code: e.code, name: e.name.slice(0, 36), class: e.cls }))));
  }
  process.exitCode = 0;
}
