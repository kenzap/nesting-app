const fs = require('fs');
const path = require('path');
const { removeTempPath } = require('./safe-file-operations');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function cleanupTempArtifacts(rootDir, maxAgeMs = ONE_DAY_MS) {
  if (!rootDir) return;

  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    try {
      const stats = await fs.promises.lstat(entryPath);
      const modifiedAt = stats.mtimeMs || stats.ctimeMs || 0;
      if (modifiedAt >= cutoff) continue;
      await removeTempPath(entryPath);
    } catch {
      // Best-effort cleanup only. Ignore files currently locked or already removed.
    }
  }
}

module.exports = {
  ONE_DAY_MS,
  cleanupTempArtifacts,
};
