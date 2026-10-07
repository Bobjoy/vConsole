/**
 * Probe-side html2canvas load order (src/mcp/commands.ts).
 *
 * The hub-side suites can only observe the command result, not which URL the
 * page was asked to fetch, so this bundles the probe source with esbuild and
 * stubs just enough DOM to watch the <script> chain: the vendored copy on the
 * hub origin must come first, the public CDNs only cover a local miss.
 *
 * Run: node test/screenshot-loader.unit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const LOCAL = 'http://127.0.0.1:9528/html2canvas.min.js';

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

const source = url.fileURLToPath(new URL('../src/mcp/commands.ts', import.meta.url));
const tmpOut = path.join(os.tmpdir(), `shot-loader-${process.pid}.cjs`);
await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: tmpOut, logLevel: 'error' });

/**
 * Same branch order as the real html2canvas 1.4.1 UMD header: CJS, then AMD,
 * then global. The AMD branch hands the factory to `define` and never creates a
 * global, which is the failure this suite exercises.
 */
const UMD_TEXT = '!function(A,e){"object"==typeof exports&&"undefined"!=typeof module'
  + '?module.exports=e():"function"==typeof define&&define.amd?define(e)'
  + ':(A="undefined"!=typeof globalThis?globalThis:A||self).html2canvas=e()}'
  + '(this,function(){return function(){return Promise.resolve(__CANVAS__)}})';

/**
 * @param fail srcs that fire onerror instead of onload
 * @param opts.amdPage srcs whose file loads but stays captured by the page loader
 * @param opts.fetchFails srcs the fallback fetch cannot read
 * @returns { requested: string[], fetched: string[] } plus the stubbed window for assertions
 */
function installDom(fail = () => false, { amdPage = () => false, fetchFails = () => false } = {}) {
  const requested = [];
  const fetched = [];
  const canvas = { width: 800, height: 600, toDataURL: () => 'data:image/png;base64,iVBORw0KGg' };
  globalThis.__CANVAS__ = canvas;
  globalThis.window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    html2canvas: undefined,
  };
  globalThis.fetch = (src) => {
    fetched.push(src);
    if (fetchFails(src)) { return Promise.reject(new Error(`http 404 for ${src}`)); }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(UMD_TEXT) });
  };
  globalThis.document = {
    documentElement: { scrollWidth: 800, scrollHeight: 600 },
    body: {},
    createElement: () => ({ remove() { /* the loader detaches the script tag */ } }),
    head: {
      appendChild(script) {
        const src = script.src;
        requested.push(src);
        setTimeout(() => {
          if (fail(src)) {
            script.onerror();
          } else {
            if (!amdPage(src)) { globalThis.window.html2canvas = () => Promise.resolve(canvas); }
            script.onload();
          }
        }, 0);
      },
    },
  };
  return { requested, fetched };
}

const { screenshot } = require(tmpOut);

try {
  // local source first
  {
    const { requested } = installDom();
    const shot = await screenshot({ assetUrl: LOCAL });
    check('vendored url is fetched before any CDN', requested[0] === LOCAL, JSON.stringify(requested));
    check('only the local source is used when it works', requested.length === 1, JSON.stringify(requested));
    check('screenshot still returns the image', shot.format === 'png' && shot.dataBase64.startsWith('iVBOR'), JSON.stringify(shot).slice(0, 80));
  }

  // local miss -> CDN chain takes over, biggest CDN first
  {
    const { requested } = installDom((src) => src === LOCAL);
    await screenshot({ assetUrl: LOCAL });
    check('a local miss falls through to the CDNs',
      requested.length === 2 && requested[1].startsWith('https://') && requested[1].includes('html2canvas@1.4.1'),
      JSON.stringify(requested));
  }

  // no local source configured (older server / manual init)
  {
    const { requested } = installDom();
    await screenshot({});
    check('without an asset url the chain is CDN only',
      requested.length === 1 && requested[0].startsWith('https://'), JSON.stringify(requested));
  }

  // the page has its own AMD loader: the file downloads, onload fires, and the
  // UMD registers with that loader instead of creating a global
  {
    const { requested, fetched } = installDom(() => false, { amdPage: (src) => src === LOCAL });
    const shot = await screenshot({ assetUrl: LOCAL });
    check('a page with an AMD loader still gets a usable screenshot',
      shot.format === 'png' && shot.dataBase64.startsWith('iVBOR'), JSON.stringify(shot).slice(0, 80));
    check('the fallback re-reads the url whose script tag produced no global',
      fetched.length === 1 && fetched[0] === LOCAL, JSON.stringify(fetched));
    check('the fallback does not append a second script tag', requested.length === 1, JSON.stringify(requested));
    check('the fallback installs nothing on the page',
      globalThis.window.html2canvas === undefined && globalThis.html2canvas === undefined,
      String(globalThis.window.html2canvas));
  }

  // same page, but the fallback cannot read the file -> the chain keeps going
  {
    const { requested, fetched } = installDom(() => false, {
      amdPage: (src) => src === LOCAL,
      fetchFails: (src) => src === LOCAL,
    });
    const shot = await screenshot({ assetUrl: LOCAL });
    check('a failed fallback read falls through to the CDNs',
      requested.length === 2 && requested[1].startsWith('https://') && fetched.length === 1,
      JSON.stringify({ requested, fetched }));
    check('the CDN still yields the image', shot.width === 800, JSON.stringify(shot).slice(0, 60));
  }

  // the fallback is paid once per page, not once per screenshot
  {
    const { requested, fetched } = installDom(() => false, { amdPage: () => true });
    const first = await screenshot({ assetUrl: LOCAL });
    const second = await screenshot({ assetUrl: LOCAL });
    check('both screenshots succeed on a loader page',
      first.format === 'png' && second.format === 'png' && second.width === 800,
      JSON.stringify({ first: first.width, second: second.width }));
    check('the second screenshot reuses the captured build',
      requested.length === 1 && fetched.length === 1, JSON.stringify({ requested, fetched }));
  }

  // everything down
  {
    const { requested } = installDom(() => true);
    let err = null;
    try {
      await screenshot({ assetUrl: LOCAL });
    } catch (e) {
      err = e;
    }
    check('all four sources are attempted before giving up', requested.length === 4, JSON.stringify(requested));
    check('the failure names how many sources it tried',
      !!err && /all 4 sources/.test(err.message), String(err && err.message));
  }
} finally {
  fs.rmSync(tmpOut, { force: true });
}

// Everything above bundles commands.ts on its own, so it stays green even if the
// bridge stops supplying an assetUrl — which is exactly how the local-first chain
// broke once. Watch the wiring at its source instead.
const bridgeSrc = fs.readFileSync(url.fileURLToPath(new URL('../src/mcp/bridge.ts', import.meta.url)), 'utf8');
check('the bridge derives an asset url from the hub endpoint', /this\.assetUrl = localAssetUrl\(opts\.serverUrl\)/.test(bridgeSrc));
check('the bridge hands that url to screenshot()', /assetUrl:\s*this\.assetUrl/.test(bridgeSrc));

console.log(`\nscreenshot loader: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
