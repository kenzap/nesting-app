'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'assets/icon-square-windows.svg';
const MANIFEST = 'scripts/appx-assets-manifest.json';
const SCALES = [100, 125, 150, 200, 250, 300, 400];
const TARGET_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const BASE_ASSETS = [
  ['StoreLogo', 50, 50, 0],
  ['Square44x44Logo', 44, 44, 0],
  ['Square150x150Logo', 150, 150, 0.1],
  ['Wide310x150Logo', 310, 150, 0.1],
  ['LargeTile', 310, 310, 0.1],
  ['SmallTile', 71, 71, 0.1],
  ['SplashScreen', 620, 300, 0.1],
];
const ASSETS = BASE_ASSETS.flatMap(([name, width, height, padding]) => [
  { name: `${name}.png`, width, height, padding },
  ...SCALES.map(scale => ({
    name: `${name}.scale-${scale}.png`,
    width: Math.round(width * scale / 100),
    height: Math.round(height * scale / 100),
    padding,
  })),
]).concat(TARGET_SIZES.flatMap(size => ['', '_altform-unplated', '_altform-lightunplated'].map(form => ({
  name: `Square44x44Logo.targetsize-${size}${form}.png`,
  width: size,
  height: size,
  padding: 0,
}))));

function checksum(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readSource(root) {
  // Git can check text files out with CRLF on Windows; artwork is unchanged.
  return (await fs.readFile(path.join(root, SOURCE), 'utf8')).replace(/\r\n?/g, '\n');
}

async function generateAssets(root = ROOT) {
  const { Resvg } = require('@resvg/resvg-js');
  const source = await readSource(root);
  const svg = source.match(/<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/);
  if (!svg) throw new Error(`Cannot read the SVG viewBox in ${SOURCE}.`);
  const outputDir = path.join(root, 'assets/appx');
  await fs.mkdir(outputDir, { recursive: true });
  const manifest = {
    source: SOURCE,
    sourceSha256: checksum(source),
    rendererVersion: require('@resvg/resvg-js/package.json').version,
    assets: {},
  };
  for (const asset of ASSETS) {
    const size = Math.min(asset.width, asset.height) * (1 - asset.padding * 2);
    const x = (asset.width - size) / 2;
    const y = (asset.height - size) / 2;
    // Render each resolution from the vector, never upscale an existing PNG.
    const imageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}">
      <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${svg[1]}">${svg[2]}</svg>
    </svg>`;
    const png = new Resvg(imageSvg, { font: { loadSystemFonts: false } }).render().asPng();
    await fs.writeFile(path.join(outputDir, asset.name), png);
    manifest.assets[asset.name] = { width: asset.width, height: asset.height, sha256: checksum(png) };
  }
  await fs.mkdir(path.dirname(path.join(root, MANIFEST)), { recursive: true });
  await fs.writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return ASSETS.length;
}

async function verifyAssets(root = ROOT) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  const source = await readSource(root);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.source !== SOURCE || manifest.sourceSha256 !== checksum(source)) {
    throw new Error('AppX icons are out of date with the Windows vector artwork.');
  }
  if (manifest.rendererVersion !== metadata.devDependencies['@resvg/resvg-js']) {
    throw new Error('AppX icons were generated with a different renderer version.');
  }
  const expectedNames = ASSETS.map(asset => asset.name).sort();
  if (JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error('The AppX asset manifest is missing required icon variants.');
  }
  const outputDir = path.join(root, 'assets/appx');
  const families = new Set(BASE_ASSETS.map(([name]) => name));
  const extra = (await fs.readdir(outputDir)).filter(name =>
    name.endsWith('.png') && families.has(name.split('.')[0]) && !Object.hasOwn(manifest.assets, name));
  if (extra.length) throw new Error(`Unverified AppX icon variants: ${extra.join(', ')}.`);
  for (const asset of ASSETS) {
    const png = await fs.readFile(path.join(outputDir, asset.name));
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.toString('ascii', 12, 16) !== 'IHDR' ||
        png.readUInt32BE(16) !== asset.width || png.readUInt32BE(20) !== asset.height) {
      throw new Error(`Invalid image or dimensions for ${asset.name}; expected ${asset.width} x ${asset.height}.`);
    }
    const recorded = manifest.assets[asset.name];
    if (recorded.width !== asset.width || recorded.height !== asset.height || recorded.sha256 !== checksum(png)) {
      throw new Error(`AppX icon ${asset.name} differs from the generated Windows artwork.`);
    }
  }
  return ASSETS.length;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const operation = args.length === 0 ? generateAssets : args.length === 1 && args[0] === '--check' ? verifyAssets : null;
  if (!operation) {
    console.error('Usage: node scripts/generate-appx-assets.js [--check]');
    process.exitCode = 1;
  } else {
    operation().then(count => {
      console.log(`[appx-assets] ${args.length ? 'Verified' : 'Generated'} ${count} Windows Store icon assets.`);
    }).catch(error => {
      console.error(`[appx-assets] ${error.message}\nRegenerate with: npm run appx:assets`);
      process.exitCode = 1;
    });
  }
}

module.exports = { ASSETS, generateAssets, verifyAssets };
