'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { Arch } = require('builder-util');
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper');
const { configureSnapDesktopFiles, useGeneratedDesktopFiles } = require('./build-snap');
const metadata = require('../package.json');

async function main() {
  const descriptor = {
    apps: {
      generated: { desktop: 'meta/gui/generated.desktop', command: 'app/generated' },
      installed: { desktop: 'usr/share/applications/installed.desktop', command: 'app/installed' },
      existing: { command: 'app/existing' },
    },
  };
  assert.equal(useGeneratedDesktopFiles(descriptor), descriptor);
  assert.equal(Object.hasOwn(descriptor.apps.generated, 'desktop'), false);
  assert.equal(descriptor.apps.generated.command, 'app/generated');
  assert.equal(descriptor.apps.installed.desktop, 'usr/share/applications/installed.desktop');
  assert.deepEqual(descriptor.apps.existing, { command: 'app/existing' });
  assert.deepEqual(useGeneratedDesktopFiles({}), {});
  const normalized = structuredClone(descriptor);
  assert.deepEqual(useGeneratedDesktopFiles(descriptor), normalized);

  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenzap-snap-packaging-'));
  try {
    const stageDir = path.join(temporaryDir, 'stage');
    const appOutDir = path.join(temporaryDir, 'unpacked');
    const name = metadata.build.linux.executableName;
    await fs.mkdir(appOutDir, { recursive: true });
    await fs.mkdir(path.join(appOutDir, 'resources/native/linux/bin'), { recursive: true });
    await fs.writeFile(path.join(appOutDir, name), 'test app');
    await fs.writeFile(path.join(appOutDir, 'resources/native/linux/bin/sparrow'), 'test helper');

    const packager = {
      config: metadata.build,
      platformSpecificBuildOptions: metadata.build.linux,
      executableName: name,
      fileAssociations: [],
      appInfo: {
        version: metadata.version,
        productName: metadata.build.productName,
        description: metadata.description,
      },
      info: { metadata },
      packagerOptions: {
        effectiveOptionComputed: async ({ snap }) => {
          const written = yaml.load(await fs.readFile(path.join(stageDir, 'snap/snapcraft.yaml'), 'utf8'));
          assert.deepEqual(written, snap);
          assert.equal(Object.hasOwn(written.apps[name], 'desktop'), false);
          assert.deepEqual(written.apps[name].extensions, ['gnome']);
          assert.equal(written.base, 'core24');
          assert.equal(written.confinement, 'strict');
          assert.equal(written.version, metadata.version);
          assert.equal(written.parts[name].organize[name], `app/${name}`);
          assert.equal(written.parts[name].organize.resources, 'app/resources');
          assert.match(written.apps[name].command, new RegExp(`^app/${name}(?: |$)`));
          const desktop = await fs.readFile(path.join(stageDir, 'snap/gui', `${name}.desktop`), 'utf8');
          assert.match(desktop, new RegExp(`^Exec=${name} %U$`, 'm'));
          assert.ok(desktop.includes(`Icon=\${SNAP}/meta/gui/${name}.png`));
          const icon = await fs.readFile(path.join(stageDir, written.icon));
          assert.deepEqual(icon, await fs.readFile(path.join(__dirname, '../assets/icon-square.png')));
          assert.equal(await fs.readFile(path.join(stageDir, 'app/resources/native/linux/bin/sparrow'), 'utf8'), 'test helper');
          return true; // Inspect real staging output without invoking Snapcraft.
        },
      },
    };
    const helper = new LinuxTargetHelper(packager);
    helper.iconPromise = { value: Promise.resolve([]) };
    helper.maxIconPath = path.join(__dirname, '../assets/icon-square.png');
    const originalCore = helper.getSnapCore();
    const original = await originalCore.createDescriptor(Arch.x64);
    configureSnapDesktopFiles();
    const core = helper.getSnapCore();
    const snap = await core.createDescriptor(Arch.x64);
    assert.deepEqual(snap, useGeneratedDesktopFiles(original));
    await core.buildSnap({
      snap,
      appOutDir,
      stageDir,
      snapArch: Arch.x64,
      artifactPath: path.join(temporaryDir, 'test.snap'),
    });
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
  console.log('Snap packaging checks passed: generated manifest, desktop launcher, icon, and helper staging.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
