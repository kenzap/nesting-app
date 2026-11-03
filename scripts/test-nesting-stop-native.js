'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const platform = { darwin: 'macos', win32: 'windows' }[process.platform] || process.platform;
const binary = process.argv[2] || path.join(__dirname, '../native', platform, 'bin', process.platform === 'win32' ? 'packing.exe' : 'packing');
const root = process.env.NESTING_STOP_TEST_ARTIFACTS || os.tmpdir();
fs.mkdirSync(root, { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'nesting-stop-native-'));

async function check(mode, strategy = 'barriers', beforeLaunch = false) {
  const name = `${mode}-${strategy}-${beforeLaunch ? 'before-launch' : 'during-preparation'}`;
  const cwd = path.join(temp, name); fs.mkdirSync(cwd);
  const input = path.join(cwd, 'job.json');
  const marker = path.join(cwd, '.stop-requested');
  fs.writeFileSync(input, JSON.stringify({ name: 'startup-stop', strip_height: 400,
    items: [{ id: 0, demand: 1000, allowed_orientations: [0, 90],
      shape: { type: 'simple_polygon', data: [[0, 0], [40, 0], [40, 80], [0, 80]] } }],
    sheets: [{ width: mode === 'unlimited' ? null : 400, height: 400, width_mode: mode }],
  }));
  if (beforeLaunch) fs.writeFileSync(marker, 'stop\n');
  const args = ['--input', input, '--global-time', '60', '--workers', '1', '--rng-seed', '42', '--stop-file', marker];
  if (mode !== 'unlimited') args.push('--max-strip-length', '400', '--multi-strip-mode', strategy);
  const trigger = mode === 'unlimited' ? '[MAIN] preparing initial placement'
    : strategy === 'prebucket' ? '[MAIN] preparing initial sheet plan' : '[BARRIERS] attempt';
  const child = spawn(binary, args, { cwd });
  let log = ''; let requested = beforeLaunch; let timedOut = false;
  const capture = chunk => {
    log += chunk;
    if (!requested && log.includes(trigger)) {
      requested = true;
      fs.writeFileSync(marker, 'stop\n');
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 12000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  } finally {
    clearTimeout(timeout);
    fs.writeFileSync(path.join(cwd, 'run.log'), JSON.stringify({ args, requested, timedOut, code }, null, 2) + '\n' + log);
  }
  assert.ok(!timedOut, `${name}: Stop did not interrupt startup\n${log}`);
  assert.equal(code, 0, log);
  assert.ok(requested, `${name}: did not reach the requested preparation stage`);
  assert.match(log, /\[STOP\] cancelled before a complete placement was available/);
  const finals = fs.readdirSync(path.join(cwd, 'output'), { recursive: true })
    .filter(file => /(?:final_startup-stop\.json|strip_\d+\.json|summary\.json)$/.test(file));
  assert.equal(finals.length, 0, 'cancelled startup must not export partial placements');
  console.log(`${name}: cancelled cleanly, no partial final exports.`);
}

(async () => {
  for (const mode of ['fixed', 'max', 'unlimited']) {
    await check(mode, 'barriers', true);
    await check(mode);
  }
  await check('fixed', 'prebucket');
  await check('max', 'prebucket');
  fs.rmSync(temp, { recursive: true, force: true });
})().catch(error => { console.error(`Artifacts retained at ${temp}`, error); process.exitCode = 1; });
