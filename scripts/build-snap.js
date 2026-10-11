'use strict';

function useGeneratedDesktopFiles(snap) {
  for (const app of Object.values(snap.apps || {})) {
    if (typeof app.desktop === 'string' && /^meta\/gui\/[^/]+\.desktop$/.test(app.desktop)) {
      // electron-builder writes snap/gui; Snapcraft copies it to meta/gui itself.
      // The desktop key instead expects a file already present in prime.
      delete app.desktop;
    }
  }
  return snap;
}

function configureSnapDesktopFiles() {
  // Scoped to core24 builds; leave dependencies on disk and other targets untouched.
  const { SnapCore24 } = require('app-builder-lib/out/targets/snap/core24');
  const createDescriptor = SnapCore24.prototype.createDescriptor;
  SnapCore24.prototype.createDescriptor = async function (arch) {
    return useGeneratedDesktopFiles(await createDescriptor.call(this, arch));
  };
}

if (require.main === module) {
  configureSnapDesktopFiles();
  require('electron-builder/cli');
}

module.exports = { configureSnapDesktopFiles, useGeneratedDesktopFiles };
