'use strict';

const { app } = require('electron');

function isMasBuild() {
  return !!process.mas;
}

function normalizeBookmark(bookmark) {
  return typeof bookmark === 'string' && bookmark.trim() ? bookmark : null;
}

function startBookmarkAccess(bookmark) {
  const normalized = normalizeBookmark(bookmark);
  if (!isMasBuild() || !normalized || typeof app.startAccessingSecurityScopedResource !== 'function') {
    return () => {};
  }

  const stopAccess = app.startAccessingSecurityScopedResource(normalized);
  return typeof stopAccess === 'function' ? stopAccess : () => {};
}

async function withSecurityScopedAccess(bookmark, work) {
  const stopAccess = startBookmarkAccess(bookmark);
  try {
    return await work();
  } finally {
    try {
      stopAccess();
    } catch {
      // Ignore cleanup errors so the original file-operation error can surface.
    }
  }
}

module.exports = {
  isMasBuild,
  normalizeBookmark,
  startBookmarkAccess,
  withSecurityScopedAccess,
};
