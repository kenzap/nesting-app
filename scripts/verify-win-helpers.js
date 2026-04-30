#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const helpers = [
  {
    label: 'sparrow',
    file: path.join(repoRoot, 'native', 'windows', 'bin', 'sparrow.exe')
  }
  // ,{
  //   label: 'dxf_preprocess',
  //   file: path.join(repoRoot, 'native', 'windows', 'bin', 'dxf_preprocess.exe')
  // }
];

const missing = [];

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

console.log('Windows helper preflight ok:');
for (const helper of helpers) {
  console.log(`- ${helper.label}: ${path.relative(repoRoot, helper.file)}`);
}
