const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const vendorConfig = require('./vendor.json');

// ../protocol holds the single protocol source that webpack inlines into this
// bundle. It is not an installed package, so the typings build needs it as a
// declaration file: the ambient module block below is generated from the source,
// written to ./protocol-ambient.d.ts (git-ignored, resolved via tsconfig paths)
// before tsc runs, and spliced back into the emitted typings — otherwise
// @bobjoy/vconsole's types would name a package that is never published.
const PROTOCOL_MODULE = '@bobjoy/vconsole-protocol';
const AMBIENT_FILE = path.resolve(__dirname, 'protocol-ambient.d.ts');

const protocolDeclarations = () => {
  const source = path.resolve(__dirname, '../../protocol/src/protocol.ts');
  const tmpDir = path.resolve(__dirname, '../dist/.protocol');
  execSync(`tsc ${JSON.stringify(source)} --target es2018 --declaration --emitDeclarationOnly --outDir ${JSON.stringify(tmpDir)}`);
  const dts = fs.readFileSync(path.join(tmpDir, 'protocol.d.ts'), 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // `export declare const` is invalid once nested inside a declare module block
  return `declare module "${PROTOCOL_MODULE}" {\n${dts.replace(/^export declare /gm, 'export ').trimEnd()}\n}\n\n`;
};

const main = () => {
  console.group('\nEmitting type declarations...');
  const distFile = './dist/vconsole.min.d.ts';
  if (fs.existsSync(distFile)) {
    fs.unlinkSync(distFile);
  }
  const ambient = protocolDeclarations();
  fs.writeFileSync(AMBIENT_FILE, ambient, 'utf8');
  execSync('tsc --build ./tsconfig.type.json');
  let distContent = fs.readFileSync(distFile, 'utf8');
  for (const name of vendorConfig.name) {
    distContent = distContent.replace(new RegExp(`['"]${name}['"]`, 'g'), `"vendor/${name}"`);
  }
  const vendorContent = '/// <reference path="../build/vendor.d.ts" />\n\n';
  fs.writeFileSync(distFile, vendorContent + ambient + distContent, 'utf8');
  console.groupEnd();
};

main();