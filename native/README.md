# Native Engine Integration

This app now includes macOS-native Rust binaries copied from the `nesting` workspace:

- `native/macos/bin/sparrow`
- `native/macos/bin/dxf_preprocess`

This is the recommended local approach for Electron:

1. Keep the nesting engine as standalone Rust executables.
2. Run them only from Electron's `main` process.
3. Expose a narrow IPC API to the renderer.

Do not run these binaries directly from the renderer process.

## Current layout

```text
native/
  macos/
    bin/
      sparrow
      dxf_preprocess
```

## Why this is recommended

- Reuses the existing Rust CLI without rewriting the algorithm.
- Keeps Electron focused on UI, files, and job orchestration.
- Works well for a future hybrid mode where jobs can run either locally or in the cloud.
- Avoids trying to "compile Rust into Electron", which is not the right model here.

## How to use from Electron

The app exposes:

```js
window.electronAPI.getNativeEngineInfo()
```

That IPC returns the resolved binary paths from the main process.

Example result:

```json
{
  "success": true,
  "baseDir": ".../native/macos/bin",
  "sparrowPath": ".../native/macos/bin/sparrow",
  "dxfPreprocessPath": ".../native/macos/bin/dxf_preprocess",
  "exists": {
    "sparrow": true,
    "dxfPreprocess": true
  }
}
```

## Recommended binding pattern

Run native commands from `main.js` using `child_process.spawn`.

Example:

```js
const { spawn } = require('node:child_process');

function runSparrow(binaryPath, inputPath, outputDir) {
  return spawn(binaryPath, [
    '-i', inputPath,
    '--max-strip-length', '3000',
    '--align-bottom',
  ], {
    cwd: outputDir,
  });
}
```

Recommended IPC flow:

1. Renderer sends a job request to Electron main.
2. Main resolves the binary path.
3. Main spawns the Rust process.
4. Main streams stdout/stderr back to renderer over IPC.
5. Main returns generated SVG/JSON paths when the job finishes.

## How the binaries were produced

From the Rust workspace:

```bash
cd /Users/pavel/Extensions/nesting
cargo build --release
```

Then copied into this app:

```bash
cp /Users/pavel/Extensions/nesting/target/release/sparrow /Users/pavel/Extensions/nesting-app/native/macos/bin/
cp /Users/pavel/Extensions/nesting/target/release/dxf_preprocess /Users/pavel/Extensions/nesting-app/native/macos/bin/
chmod +x /Users/pavel/Extensions/nesting-app/native/macos/bin/sparrow
chmod +x /Users/pavel/Extensions/nesting-app/native/macos/bin/dxf_preprocess
```

## Running locally

Start the Electron app as usual:

```bash
cd /Users/pavel/Extensions/nesting-app
npm start
```

Then inspect the binaries from the renderer with:

```js
window.electronAPI.getNativeEngineInfo()
```

## Packaging note

For production packaging, these binaries should be included in Electron's packaged resources and resolved from `process.resourcesPath` rather than `__dirname`.

For now, this folder structure is a good development starting point and is the recommended approach.
