'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
let capability = null;

async function supportsCutouts(executable) {
  try {
    const key = `${executable}:${fs.statSync(executable).mtimeMs}`;
    if (capability?.key === key) return capability.promise;
    const promise = (async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-cutout-capability-'));
      try {
        return await new Promise(resolve => execFile(executable, ['--help'], {
          cwd: directory, timeout: 3000, windowsHide: true, maxBuffer: 128 * 1024,
        }, (error, stdout) => resolve(!error && /--cutout\b/.test(stdout))));
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    })();
    capability = { key, promise };
    return promise;
  } catch { return false; }
}

function registerCutoutIpc(ipcMain, resolveExecutable, app) {
  let active = null;
  let generation = 0;
  const cancel = () => {
    generation++;
    active?.worker.postMessage({ cancel: true });
  };
  ipcMain.on('cancel-cutout-preparation', cancel);
  app?.once?.('before-quit', cancel);
  ipcMain.handle('prepare-cutout', async (event, request) => {
    const requestGeneration = generation;
    const executable = resolveExecutable('sparrow');
    if (!await supportsCutouts(executable)) return { success: false, unsupported: true, error: 'Cutout nesting requires an updated native engine' };
    if (generation !== requestGeneration) return { success: false, error: 'Cutout preparation canceled' };
    if (active) return { success: false, error: 'Cutout preparation is busy' };
    return new Promise(resolve => {
      let timer;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-cutout-'));
      const worker = new Worker(path.join(__dirname, '../workers/cutout-worker.js'), {
        workerData: { request, executable, directory },
      });
      const finish = result => {
        if (active?.worker !== worker) return;
        clearTimeout(timer);
        active = null;
        resolve(result);
      };
      active = { worker };
      worker.once('message', finish);
      worker.once('error', error => finish({ success: false, error: error.message }));
      worker.once('exit', () => {
        finish({ success: false, error: 'Cutout preparation stopped' });
        // Also clean up if the watchdog had to terminate geometry validation.
        fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      });
      timer = setTimeout(() => {
        finish({ success: false, error: 'Cutout preparation timed out' });
        worker.terminate();
      }, 5000);
    });
  });
}

module.exports = { registerCutoutIpc, supportsCutouts };
