'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const helperDir = path.join(repoRoot, 'native', 'macos', 'bin');
const helperNames = ['sparrow', 'dxf_preprocess'];

function fail(message) {
  console.error(`[mac-helpers] ${message}`);
  process.exit(1);
}

function describeWithFile(filePath) {
  try {
    return execFileSync('file', [filePath], { encoding: 'utf8' }).trim();
  } catch (error) {
    fail(`Unable to inspect ${path.basename(filePath)} with 'file': ${error.message}`);
  }
}

function verifyExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    fail(`${path.basename(filePath)} is not marked executable`);
  }
}

function verifyArm64(filePath) {
  const description = describeWithFile(filePath);
  if (!/\barm64\b/i.test(description)) {
    fail(`${path.basename(filePath)} is not an Apple Silicon arm64 binary: ${description}`);
  }
  return description;
}

if (process.platform !== 'darwin') {
  console.log('[mac-helpers] Skipping helper verification on non-macOS host');
  process.exit(0);
}

const summaries = helperNames.map((name) => {
  const filePath = path.join(helperDir, name);
  if (!fs.existsSync(filePath)) {
    fail(`Missing required helper at ${path.relative(repoRoot, filePath)}`);
  }
  verifyExecutable(filePath);
  const description = verifyArm64(filePath);
  return `${name}: ${description}`;
});

console.log('[mac-helpers] Verified bundled macOS helpers:');
summaries.forEach(line => console.log(`  - ${line}`));
