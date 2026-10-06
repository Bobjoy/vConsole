/**
 * Probe-side replay behaviour (src/mcp/commands.ts).
 *
 * The hub-side suites can only see the command result, not what the page was
 * about to put on the wire — and that is exactly where replay lives: re-encoding
 * the formatted copy, dropping headers a browser would ignore anyway, and the
 * one-tick stamp handshake with the fetch proxy. So this bundles the probe source
 * with esbuild and stubs `fetch`, like screenshot-loader.unit.mjs does for
 * html2canvas.
 *
 * Run: node test/replay.unit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

const probeSrc = (rel) => url.fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const tmpOut = path.join(os.tmpdir(), `replay-unit-${process.pid}.cjs`);

// a virtual entry: the store the replay reads, the mark the proxy reads, the command itself
await build({
  stdin: {
    contents: [
      `export { replay } from ${JSON.stringify(probeSrc('mcp/commands.ts'))};`,
      `export { requestList } from ${JSON.stringify(probeSrc('network/network.model.ts'))};`,
      `export { takeReplayMark } from ${JSON.stringify(probeSrc('mcp/replayStamp.ts'))};`,
    ].join('\n'),
    resolveDir: os.tmpdir(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: tmpOut,
  tsconfig: url.fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
  logLevel: 'error',
});

const { replay, requestList, takeReplayMark } = require(tmpOut);

/** @returns calls the stubbed fetch saw */
function installFetch(response = () => new Response('{"ok":true}', {
  status: 201,
  statusText: 'Created',
  headers: { 'content-type': 'application/json', 'x-total': '3' },
}), opts = { stamp: true }) {
  const calls = [];
  globalThis.fetch = (u, init) => {
    calls.push({ url: u, init });
    if (opts.stamp) {
      const mark = takeReplayMark();
      if (mark) { mark.newItemId = `new-${calls.length}`; }
    }
    return Promise.resolve(typeof response === 'function' ? response() : response);
  };
  return calls;
}

function putItem(item) {
  requestList.set({ [item.id]: item });
}

try {
  // --- the recorded request is gone from the page ---------------------------
  putItem({ id: 'kept', requestType: 'fetch', method: 'GET', url: 'https://example.com/kept' });
  installFetch();
  let err = null;
  try {
    await replay({ requestId: 'evicted' });
  } catch (e) {
    err = e;
  }
  check('replay refuses an id the page no longer holds',
    !!err && /request not found in page buffer: evicted/.test(err.message), String(err && err.message));

  // --- json body: re-encoded, forbidden header dropped, fresh status --------
  putItem({
    id: 'req-json',
    requestType: 'xhr',
    method: 'post',
    url: 'https://example.com/api/order',
    status: 500,
    requestHeader: { 'Content-Type': 'application/json', Cookie: 'sid=secret', 'X-Trace': 't1' },
    postData: { good: '1' },
  });
  let calls = installFetch();
  let out = await replay({ requestId: 'req-json' });
  const sent = calls[0];
  check('json body is re-encoded from the formatted copy',
    sent.init.body === '{"good":"1"}' && sent.init.headers['Content-Type'] === 'application/json', JSON.stringify(sent.init));
  check('forbidden headers are skipped, page-set ones are kept',
    !('Cookie' in sent.init.headers) && !('cookie' in sent.init.headers) && sent.init.headers['X-Trace'] === 't1',
    JSON.stringify(sent.init.headers));
  check('method is taken from the record and upper-cased', sent.init.method === 'POST');
  check('the result reports this run, not the recorded 500',
    out.status === 201 && out.statusText === 'Created' && out.body === '{"ok":true}' && out.truncated === false,
    JSON.stringify(out));
  check('response headers come back serialized',
    /content-type: application\/json/.test(out.responseHeader) && /x-total: 3/.test(out.responseHeader), out.responseHeader);
  check('the stamp handshake returns the id of the new item',
    out.replayedId === 'new-1' && takeReplayMark() === null, JSON.stringify(out.replayedId));

  // --- multipart: rebuilt as FormData, stale boundary must not be sent -----
  putItem({
    id: 'req-form',
    requestType: 'fetch',
    method: 'POST',
    url: 'https://example.com/api/note',
    requestHeader: { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundaryOLD' },
    postData: { note: 'hi', lang: 'zh' },
  });
  calls = installFetch();
  out = await replay({ requestId: 'req-form' });
  const form = calls[0].init.body;
  check('a multipart record is rebuilt as FormData with its fields',
    form instanceof FormData && form.get('note') === 'hi' && form.get('lang') === 'zh', String(form));
  check('the recorded boundary is dropped so the browser can set a fresh one',
    !Object.keys(calls[0].init.headers).some((k) => k.toLowerCase() === 'content-type'),
    JSON.stringify(calls[0].init.headers));

  // --- lossy bodies: refuse instead of sending a fabricated one ---------------
  // the hub copy is display text and can come back truncated, so this gate only
  // works where the real captured shape still lives
  putItem({
    id: 'req-file',
    requestType: 'fetch',
    method: 'POST',
    url: 'https://example.com/api/upload',
    requestHeader: { 'content-type': 'multipart/form-data; boundary=----X' },
    postData: { note: 'hi', file: '[object Object]' }, // what genFormattedBody leaves a File as
  });
  calls = installFetch();
  let fileErr = null;
  try {
    await replay({ requestId: 'req-file' });
  } catch (e) {
    fileErr = e;
  }
  check('a FormData body holding a File is refused before anything is sent',
    !!fileErr && /\[object Object\]/.test(fileErr.message) && /cannot be replayed/.test(fileErr.message)
      && calls.length === 0, String(fileErr));

  putItem({
    id: 'req-blob',
    requestType: 'xhr',
    method: 'POST',
    url: 'https://example.com/api/blob',
    requestHeader: { 'content-type': 'application/octet-stream' },
    postData: '[object Blob]',
  });
  calls = installFetch();
  let blobErr = null;
  try {
    await replay({ requestId: 'req-blob' });
  } catch (e) {
    blobErr = e;
  }
  check('a raw Blob body is refused the same way',
    !!blobErr && /\[object Blob\]/.test(blobErr.message) && calls.length === 0, String(blobErr));

  // --- urlencoded: values were decoded at capture, so they go back encoded --
  putItem({
    id: 'req-urlencoded',
    requestType: 'fetch',
    method: 'POST',
    url: 'https://example.com/api/search',
    requestHeader: { 'Content-Type': 'application/x-www-form-urlencoded' },
    postData: { q: '+1' },
  });
  calls = installFetch();
  await replay({ requestId: 'req-urlencoded' });
  check('urlencoded pairs are re-encoded', calls[0].init.body.toString() === 'q=%2B1', String(calls[0].init.body));

  // --- a query string captured without a Content-Type: byte-identical rejoin -
  putItem({
    id: 'req-query',
    requestType: 'fetch',
    method: 'POST',
    url: 'https://example.com/api/beat',
    requestHeader: {},
    postData: { a: '1', b: '%3F' },
  });
  calls = installFetch();
  await replay({ requestId: 'req-query' });
  check('a captured query string is rejoined as written', calls[0].init.body === 'a=1&b=%3F', calls[0].init.body);

  // --- string body verbatim, GET stays bodyless ----------------------------
  putItem({ id: 'req-text', requestType: 'fetch', method: 'PUT', url: 'https://example.com/api/put', postData: 'plain-text-payload' });
  calls = installFetch();
  await replay({ requestId: 'req-text' });
  check('a string body is resent verbatim', calls[0].init.body === 'plain-text-payload', calls[0].init.body);

  putItem({ id: 'req-get', requestType: 'xhr', method: 'GET', url: 'https://example.com/api/list?x=1', requestHeader: [['Accept', 'application/json']] });
  calls = installFetch();
  await replay({ requestId: 'req-get' });
  check('a bodyless request is sent without a body',
    calls[0].init.body === null && calls[0].init.headers.Accept === 'application/json', JSON.stringify(calls[0].init));

  // --- oversized body is capped, size reported ------------------------------
  const big = 'y'.repeat(9000);
  putItem({ id: 'req-big', requestType: 'fetch', method: 'GET', url: 'https://example.com/api/big' });
  calls = installFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
  out = await replay({ requestId: 'req-big' });
  check('the returned body is capped at 8KB and says how big it really was',
    out.body.length === 8192 && out.truncated === true && out.responseSize === 9000,
    JSON.stringify({ len: out.body.length, truncated: out.truncated, size: out.responseSize }));

  // --- CORS / unreachable --------------------------------------------------
  putItem({ id: 'req-cors', requestType: 'fetch', method: 'GET', url: 'https://other.example.com/api' });
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  err = null;
  try {
    await replay({ requestId: 'req-cors' });
  } catch (e) {
    err = e;
  }
  check('a request the browser could not read is reported as network-error',
    !!err && /^network-error: /.test(err.message) && /CORS-blocked/.test(err.message), String(err && err.message));

  // --- a mark nobody read must not leak onto the next request --------------
  putItem({ id: 'req-nostamp', requestType: 'fetch', method: 'GET', url: 'https://example.com/api/plain' });
  calls = installFetch(() => new Response('{}', { status: 200 }), { stamp: false });
  out = await replay({ requestId: 'req-nostamp' });
  check('an unread mark is cleared instead of stamping some later request',
    out.replayedId === '' && takeReplayMark() === null, JSON.stringify(out));
} finally {
  delete globalThis.fetch;
  fs.rmSync(tmpOut, { force: true });
}

// The stamp only works if the proxy reads it and the bridge routes the command,
// so watch that wiring at its source too.
const fetchProxySrc = fs.readFileSync(probeSrc('network/fetch.proxy.ts'), 'utf8');
const bridgeSrc = fs.readFileSync(probeSrc('mcp/bridge.ts'), 'utf8');
const commandsSrc = fs.readFileSync(probeSrc('mcp/commands.ts'), 'utf8');
check('the fetch proxy stamps the item it just made',
  /const replayMark = takeReplayMark\(\);[\s\S]{0,160}item\.replayedFrom = replayMark\.sourceId[\s\S]{0,80}replayMark\.newItemId = item\.id/.test(fetchProxySrc));
check('the bridge routes the replay command to the page-side implementation',
  /case 'replay':/.test(bridgeSrc) && /data = await replay\(/.test(bridgeSrc));
check('the mark is set immediately before the replayed fetch call',
  /markReplay\(requestId\)[\s\S]{0,220}?\n\s*const pending = fetch\(source\.url/.test(commandsSrc));

console.log(`\nreplay unit: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
