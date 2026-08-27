#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const helpers = [
  {
    label: 'sparrow',
    file: path.join(repoRoot, 'native', 'linux', 'bin', 'sparrow'),
  },
];

function fail(message) {
  console.error(`[linux-helpers] ${message}`);
  process.exit(1);
}

if (process.platform !== 'linux') {
  console.log('[linux-helpers] Skipping helper verification on non-Linux host');
  process.exit(0);
}

const summaries = helpers.map((helper) => {
  if (!fs.existsSync(helper.file)) {
    fail(`Missing required helper at ${path.relative(repoRoot, helper.file)}`);
  }

  let restoredExecutable = false;
  try {
    fs.accessSync(helper.file, fs.constants.X_OK);
  } catch {
    try {
      const mode = fs.statSync(helper.file).mode;
      fs.chmodSync(helper.file, mode | 0o755);
      fs.accessSync(helper.file, fs.constants.X_OK);
      restoredExecutable = true;
    } catch (error) {
      fail(`${path.basename(helper.file)} is not executable and its permissions could not be repaired: ${error.message}`);
    }
  }

  const probe = spawnSync(helper.file, ['--help'], {
    stdio: 'ignore',
    timeout: 10000,
  });
  if (probe.error) {
    const noExecHint = probe.error.code === 'EACCES'
      ? ' The project filesystem may be mounted with noexec; move the checkout to your Ubuntu home directory and reinstall dependencies there.'
      : '';
    fail(`${path.basename(helper.file)} has executable permissions but could not be started: ${probe.error.message}.${noExecHint}`);
  }
  if (probe.status !== 0) {
    fail(`${path.basename(helper.file)} executable check exited with code ${probe.status ?? 'unknown'}`);
  }

  const repairedNote = restoredExecutable ? ' (restored executable permission)' : '';
  return `${helper.label}: ${path.relative(repoRoot, helper.file)}${repairedNote}`;
});

console.log('[linux-helpers] Verified bundled Linux helpers:');
summaries.forEach(line => console.log(`  - ${line}`));
