#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const explicitTarget = process.argv[2] ? path.resolve(process.argv[2]) : null;

const PACKAGE_EXTENSIONS = ['.appx', '.msix', '.appxbundle', '.msixbundle'];
const SYMBOL_EXTENSIONS = ['.appxsym', '.msixsym'];

function fail(message) {
  console.error(`[make-appxupload] ${message}`);
  process.exit(1);
}

function findLatestPackage() {
  if (!fs.existsSync(distDir)) return null;
  const candidates = fs.readdirSync(distDir)
    .map(name => path.join(distDir, name))
    .filter(file => {
      try {
        return fs.statSync(file).isFile() && PACKAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function resolveSymbolFiles(packagePath) {
  const dir = path.dirname(packagePath);
  const stem = path.basename(packagePath, path.extname(packagePath));
  return SYMBOL_EXTENSIONS
    .map(ext => path.join(dir, `${stem}${ext}`))
    .filter(file => fs.existsSync(file));
}

function createArchive(outputPath, files) {
  if (!files.length) fail('No files provided for upload archive.');

  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop"',
      `$files = @(${files.map(file => `'${file.replace(/'/g, "''")}'`).join(', ')})`,
      `Compress-Archive -LiteralPath $files -DestinationPath '${outputPath.replace(/'/g, "''")}' -Force`
    ].join('; ');
    const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
    if (result.status !== 0) fail(`PowerShell Compress-Archive failed with exit code ${result.status ?? 'unknown'}.`);
    return;
  }

  const result = spawnSync('zip', ['-j', '-q', outputPath, ...files], { stdio: 'inherit' });
  if (result.error) fail(`zip command failed: ${result.error.message}`);
  if (result.status !== 0) fail(`zip command exited with code ${result.status}.`);
}

const packagePath = explicitTarget || findLatestPackage();
if (!packagePath) fail('No .appx/.msix package found in dist. Pass a package path explicitly if needed.');
if (!fs.existsSync(packagePath)) fail(`Package not found: ${packagePath}`);

const packageExt = path.extname(packagePath).toLowerCase();
const uploadExt = packageExt.startsWith('.msix') ? '.msixupload' : '.appxupload';
const outputPath = path.join(path.dirname(packagePath), `${path.basename(packagePath, packageExt)}${uploadExt}`);
const symbolFiles = resolveSymbolFiles(packagePath);
const files = [packagePath, ...symbolFiles];

if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
createArchive(outputPath, files);

console.log(`[make-appxupload] Created ${path.relative(repoRoot, outputPath)}`);
for (const file of files) {
  console.log(`[make-appxupload] Included ${path.relative(repoRoot, file)}`);
}
