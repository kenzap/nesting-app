'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const helperNames = ['sparrow', 'dxf_preprocess'];

function fail(message) {
  console.error(`[verify-mas-signing] ${message}`);
  process.exit(1);
}

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed\n${output}`);
  }
  return output;
}

function plistHasKeyValue(xml, key, expected = true) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = expected
    ? new RegExp(`<key>${escapedKey}</key>\\s*<true\\s*/>`, 'i')
    : new RegExp(`<key>${escapedKey}</key>`, 'i');
  return pattern.test(xml);
}

function candidateAppPaths() {
  const explicitArg = process.argv[2];
  const explicitEnv = process.env.APP_PATH;
  const candidates = [explicitArg, explicitEnv]
    .filter(Boolean)
    .map(entry => path.resolve(entry));

  if (fs.existsSync(distDir)) {
    const preferredDirs = ['mas-dev-arm64', 'mas-arm64', 'mas-dev', 'mas', 'mac-arm64'];
    preferredDirs.forEach((dirName) => {
      const dirPath = path.join(distDir, dirName);
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
      fs.readdirSync(dirPath)
        .filter(name => name.endsWith('.app'))
        .sort()
        .forEach(name => candidates.push(path.join(dirPath, name)));
    });
  }

  return candidates;
}

function resolveAppPath() {
  const appPath = candidateAppPaths().find(candidate => (
    candidate &&
    fs.existsSync(candidate) &&
    fs.statSync(candidate).isDirectory() &&
    candidate.endsWith('.app')
  ));
  if (!appPath) {
    fail('No .app bundle found. Pass a path explicitly: npm run verify:mas-signing -- /path/to/App.app');
  }
  return appPath;
}

function verifyEntitlements(targetPath, expectedKeys) {
  const xml = runTool('codesign', ['-d', '--entitlements', ':-', targetPath]);
  expectedKeys.forEach((key) => {
    if (!plistHasKeyValue(xml, key, true)) {
      fail(`Missing entitlement ${key} on ${targetPath}`);
    }
  });
  return xml;
}

function verifySignedTarget(targetPath, { deep = false } = {}) {
  const args = ['--verify', '--strict', '--verbose=2'];
  if (deep) args.push('--deep');
  args.push(targetPath);
  runTool('codesign', args);
  return runTool('codesign', ['-dv', '--verbose=4', targetPath]);
}

if (process.platform !== 'darwin') {
  fail('MAS signing verification must be run on macOS.');
}

const appPath = resolveAppPath();
const helperDir = path.join(appPath, 'Contents', 'Helpers');
const helperPaths = helperNames.map(name => path.join(helperDir, name));

if (!fs.existsSync(helperDir)) {
  fail(`Missing helper directory: ${helperDir}`);
}
helperPaths.forEach((helperPath) => {
  if (!fs.existsSync(helperPath)) {
    fail(`Missing bundled helper: ${helperPath}`);
  }
});

console.log(`[verify-mas-signing] Verifying app bundle: ${appPath}`);
verifySignedTarget(appPath, { deep: true });
verifyEntitlements(appPath, [
  'com.apple.security.app-sandbox',
  'com.apple.security.files.user-selected.read-only',
  'com.apple.security.files.user-selected.read-write',
]);

helperPaths.forEach((helperPath) => {
  console.log(`[verify-mas-signing] Verifying helper: ${helperPath}`);
  verifySignedTarget(helperPath);
  verifyEntitlements(helperPath, [
    'com.apple.security.app-sandbox',
    'com.apple.security.inherit',
  ]);
});

console.log('[verify-mas-signing] MAS signing looks valid for app and helper binaries.');
