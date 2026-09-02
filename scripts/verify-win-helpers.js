#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const helpers = [
  {
    label: 'sparrow',
    file: path.join(repoRoot, 'native', 'windows', 'bin', 'sparrow.exe')
  }
];

const missing = [];
const failures = [];

for (const helper of helpers) {
  try {
    const stat = fs.statSync(helper.file);
    if (!stat.isFile()) {
      missing.push(`${helper.label}: not a file (${helper.file})`);
    }
  } catch (error) {
    missing.push(`${helper.label}: ${helper.file}`);
  }
}

if (missing.length) {
  console.error('Windows helper preflight failed.');
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

for (const helper of helpers) {
  const binary = fs.readFileSync(helper.file);
  if (!binary.includes(Buffer.from('stop-file'))) {
    failures.push(`${helper.label}: bundled executable does not advertise --stop-file support`);
    continue;
  }

  if (process.platform !== 'win32') continue;
  const probe = spawnSync(helper.file, ['--help'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (probe.error) {
    failures.push(`${helper.label}: could not be started (${probe.error.message})`);
  } else if (probe.status !== 0) {
    failures.push(`${helper.label}: --help exited with code ${probe.status ?? 'unknown'}`);
  } else if (!`${probe.stdout || ''}\n${probe.stderr || ''}`.includes('--stop-file')) {
    failures.push(`${helper.label}: --help output does not include --stop-file`);
  }
}

if (failures.length) {
  console.error('Windows helper preflight failed.');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}

console.log('Windows helper preflight ok:');
for (const helper of helpers) {
  console.log(`- ${helper.label}: ${path.relative(repoRoot, helper.file)}`);
}
