const fs = require('fs');
const path = require('path');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function cleanupTempArtifacts(rootDir, maxAgeMs = ONE_DAY_MS) {
  if (!rootDir) return;
  if (!fs.existsSync(rootDir)) return;

  const cutoff = Date.now() - maxAgeMs;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  entries.forEach(entry => {
    const entryPath = path.join(rootDir, entry.name);
    try {
      const stats = fs.statSync(entryPath);
      const modifiedAt = stats.mtimeMs || stats.ctimeMs || 0;
      if (modifiedAt >= cutoff) return;
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only. Ignore files currently locked or already removed.
    }
  });
}

module.exports = {
  ONE_DAY_MS,
  cleanupTempArtifacts,
};
