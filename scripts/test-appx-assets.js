'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ASSETS, generateAssets, verifyAssets } = require('./generate-appx-assets');
const AppXTarget = require('app-builder-lib/out/targets/AppxTarget').default;
const patchAppxManifest = require('./patch-appx-manifest');

async function main() {
  assert.equal(await verifyAssets(), 98);
  assert.equal(new Set(ASSETS.map(asset => asset.name)).size, ASSETS.length);
  const mappings = await AppXTarget.computeUserAssets({ toVmFile: file => file, pathSep: path.sep },
    'unused-fallback-assets', path.join(__dirname, '../assets/appx'));
  for (const asset of ASSETS) {
    assert.ok(mappings.userAssets.includes(asset.name));
    assert.ok(mappings.mappings.some(mapping => mapping.endsWith(`"assets\\${asset.name}"`)));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kenzap-appx-assets-'));
  try {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.copyFile(path.join(__dirname, '../assets/icon-square-windows.svg'), path.join(root, 'assets/icon-square-windows.svg'));
    await fs.copyFile(path.join(__dirname, '../package.json'), path.join(root, 'package.json'));
    assert.equal(await generateAssets(root), ASSETS.length);
    assert.equal(await verifyAssets(root), ASSETS.length);
    // PNG output is recorded when generated; checks need no OS-specific renderer.
    const file = path.join(root, 'assets/appx/Square44x44Logo.png');
    const original = await fs.readFile(file);
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(file, corrupt);
    await assert.rejects(verifyAssets(root), /Square44x44Logo.png differs/);
    const wrongSize = Buffer.from(original);
    wrongSize.writeUInt32BE(45, 16);
    await fs.writeFile(file, wrongSize);
    await assert.rejects(verifyAssets(root), /Invalid image or dimensions/);
    await fs.writeFile(file, original);
    const missing = path.join(root, 'assets/appx/Square44x44Logo.targetsize-256_altform-lightunplated.png');
    const backup = await fs.readFile(missing);
    await fs.unlink(missing);
    await assert.rejects(verifyAssets(root), /ENOENT/);
    await fs.writeFile(missing, backup);
    const obsolete = path.join(root, 'assets/appx/Square44x44Logo.targetsize-128.png');
    await fs.writeFile(obsolete, original);
    await assert.rejects(verifyAssets(root), /Unverified AppX icon variants/);
    await fs.unlink(obsolete);
    const sourceFile = path.join(root, 'assets/icon-square-windows.svg');
    const source = await fs.readFile(sourceFile, 'utf8');
    await fs.writeFile(sourceFile, source.replace('#4f8ef7', '#ff0000'));
    await assert.rejects(verifyAssets(root), /out of date/);
    await fs.writeFile(sourceFile, source);
    assert.equal(await verifyAssets(root), ASSETS.length);
    await fs.writeFile(sourceFile, source.replace(/\n/g, '\r\n'));
    assert.equal(await verifyAssets(root), ASSETS.length);
    const manifestFile = path.join(root, 'AppxManifest.xml');
    await fs.writeFile(manifestFile, '<Package><Dependencies></Dependencies></Package>');
    await patchAppxManifest(manifestFile);
    const patched = await fs.readFile(manifestFile, 'utf8');
    assert.ok(patched.includes('Microsoft.VCLibs.140.00.UWPDesktop'));
    await patchAppxManifest(manifestFile);
    assert.equal(await fs.readFile(manifestFile, 'utf8'), patched);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('AppX icon checks passed: vector source, resolutions, packaging mappings, manifest hook, and stale/missing assets.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
