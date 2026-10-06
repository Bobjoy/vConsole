/**
 * Probe-side WS frame codec (src/network/wsCodec.ts).
 *
 * The hub-side e2e can only feed already-encoded strings, so this bundles the
 * probe source with esbuild and exercises the encoder itself: text passthrough,
 * ArrayBuffer/typed-array/DataView -> marked base64, the 8KB cap with the
 * original byte count, and Blob (readable only asynchronously).
 *
 * Run: node test/ws-codec.unit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const BIN = '__vcb64__:';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const MAX = 8192;

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

const source = url.fileURLToPath(new URL('../src/network/wsCodec.ts', import.meta.url));
const tmpOut = path.join(os.tmpdir(), `ws-codec-${process.pid}.cjs`);
await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: tmpOut, logLevel: 'error' });
const { encodeWsData } = require(tmpOut);
fs.rmSync(tmpOut, { force: true });

check('text frames pass through', encodeWsData('{"op":"join"}').value === '{"op":"join"}');
check('null-ish payloads stringify', encodeWsData(null).value === 'null' && encodeWsData(undefined).value === 'undefined');

const bytes = new Uint8Array([0x00, 0x11, 0x22, 0x33]);
check('Uint8Array encodes to marked base64', encodeWsData(bytes).value === BIN + b64(bytes));
check('ArrayBuffer encodes to marked base64', encodeWsData(bytes.buffer).value === BIN + b64(bytes));
const view = new DataView(bytes.buffer, 1, 2);
check('DataView honours byteOffset', encodeWsData(view).value === BIN + b64([0x11, 0x22]));

const big = new Uint8Array(MAX + 1).fill(0xab);
const cappedValue = encodeWsData(big).value;
check('oversized payload caps at 8192 bytes and names the original size',
  cappedValue === BIN + b64(big.subarray(0, MAX)) + ':' + (MAX + 1),
  `${cappedValue.length} chars`);

// Blob: the probe cannot read it synchronously, so it hands back a placeholder
// and patches the message once the bytes are in
const blobValue = encodeWsData(new Blob([bytes]));
check('Blob starts as a readable placeholder', blobValue.value === 'Blob(4)' && typeof blobValue.fill === 'function');
const filled = await new Promise((resolve) => {
  blobValue.fill((v) => resolve(v));
});
check('Blob fill produces marked base64', filled === BIN + b64(bytes), filled);

const bigBlob = new Blob([big]);
const bigFilled = await new Promise((resolve) => {
  encodeWsData(bigBlob).fill((v) => resolve(v));
});
check('oversized Blob caps too and names the original size',
  bigFilled === BIN + b64(big.subarray(0, MAX)) + ':' + (MAX + 1), `${bigFilled.length} chars`);

// unknown object payloads (FormData, URLSearchParams, ...) still stay strings
check('unrecognised payloads stringify to a string', typeof encodeWsData(new Map()).value === 'string');

console.log(`\nws codec: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
