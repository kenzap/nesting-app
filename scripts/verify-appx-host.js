#!/usr/bin/env node

const os = require('os');
const { spawnSync } = require('child_process');

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function fail(message, details = []) {
  console.error(message);
  for (const line of details) {
    console.error(`- ${line}`);
  }
  process.exit(1);
}

if (process.platform === 'darwin') {
  if (!hasCommand('prlctl', ['list'])) {
    fail(
      'AppX build host preflight failed.',
      [
        'electron-builder needs a Windows environment on macOS for AppX/MSIX builds.',
        'Parallels Desktop is the supported automatic path, but `prlctl` was not found on this machine.',
        'Run `npm run dist:appx` from Windows, or install/configure Parallels with a Windows VM first.'
      ]
    );
  }

  console.log(`AppX build host preflight ok: Parallels detected on ${os.platform()}`);
  process.exit(0);
}

if (process.platform === 'win32') {
  console.log('AppX build host preflight ok: running on Windows');
  process.exit(0);
}

fail(
  'AppX build host preflight failed.',
  [
    `Unsupported host platform for AppX build: ${process.platform}`,
    'Use Windows directly, or macOS with Parallels Desktop and a Windows VM.'
  ]
);
