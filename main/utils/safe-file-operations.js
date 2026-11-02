'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function overwriteTextFile(targetPath, contents) {
  const tempPath = path.join(path.dirname(targetPath), `.nest-export-${randomUUID()}.tmp`);
  const fd = fs.openSync(tempPath, 'wx');
  try {
    try {
      fs.writeFileSync(fd, contents, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const now = new Date();
    fs.utimesSync(tempPath, now, now);
    // Never delete the destination first: a blocked replacement must leave it intact.
    fs.renameSync(tempPath, targetPath);
  } finally {
    try {
      removeFileIfExists(tempPath);
    } catch {
      // Cleanup must not mask the original write/rename error or a successful export.
    }
  }
}

async function removeTempPath(targetPath) {
  try {
    // Async rm uses a different implementation from Windows' native RmSync,
    // whose path-conversion errors can terminate Electron outside JS try/catch.
    await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Temporary artifacts may still be locked. Leave them for a later cleanup.
  }
}

module.exports = { overwriteTextFile, removeFileIfExists, removeTempPath };
