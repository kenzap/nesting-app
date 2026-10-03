# Native Engine Integration

This app now includes macOS-native Rust binaries copied from the `nesting` workspace:

- `native/macos/bin/sparrow`

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
  "exists": {
    "sparrow": true
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

The engine source lives in the sibling `nesting` workspace. Changes there
must be rebuilt and copied into this app; restarting Electron alone does not
update the native helpers.

Bounded-sheet barrier mode now tests a lower sheet count when the initial
greedy placement needs more sheets than the area-based lower bound. It
balances quantities across candidate sheets and optimizes each distinct
batch without separators. The common batch is solved first and reused across
full sheets, while leftover demand is packed independently into one or more
remainder sheets. A complete compact fallback is retained even if a larger
batch cannot fit. Validated remainder layouts shown during the trial are
reused in the complete plan, not randomly rebuilt during finalization.
Over-length trials can retry a smaller reusable batch;
subsequent sheet-count trials add extra items around the validated layout
instead of starting over. No particular part count is hard-coded.
Both each batch and the combined layout must be complete,
collision-free, and inside the usable sheet dimensions.
The attempts share the existing time budget and keep the original placement
as a fallback. On Stop, recent feasible trial checkpoints are checked for
whole parts already inside the sheet; crossing parts are packed separately.
The best complete, validated plan is retained rather than resetting to the
original placement. If no complete improvement can be validated, the safe
fallback remains. Regular barrier optimization also scores every feasible
checkpoint, independently of the live preview refresh rate.
An uncropped trial preview is
labelled "Testing one-sheet fit" or "Testing sheet count: N". Trial previews
never enable export or replace the fallback until all candidate sheets fit.
All candidate tabs stay visible during the attempt. Identical batches share
the updating trial SVG. Remainder sheets get their own initial geometry before
the common batch starts, and cached layouts are restored before any new batch
is optimized. When a trial tests fewer sheets than the saved complete plan,
its extra sheets remain selectable with their own retained geometry and a
"Last complete layout" label. The manifest distinguishes the trial's target
sheet count from the number of visible tabs. These retained sheets stay
preview-only and keep the physical sheet frame and margins. During the trial,
feasible improvements periodically rebuild a complete bounded plan. Its
retained remainder SVGs and dimensions refresh only when that complete plan
beats the saved result. The remainder also receives short, warm-started
optimization passes while the common batch runs, rather than stopping at
its initial greedy layout. These passes use one worker, share the existing
Stop signal and global deadline, and stream their current trial geometry
independently of the best valid checkpoint. The best remainder is reused in
complete-plan validation, Stop recovery, and finalization. Running remainder
previews keep the physical sheet mode and margins and never enable export.
Only sheets without geometry show a waiting state.

From the Rust workspace:

```bash
cd /Users/pavel/Extensions/nesting
cargo build --release --bin sparrow --features live_svg
```

Then copied into this app:

```bash
cp /Users/pavel/Extensions/nesting/target/release/sparrow /Users/pavel/Extensions/nesting-app/native/macos/bin/
chmod +x /Users/pavel/Extensions/nesting-app/native/macos/bin/sparrow
```

Windows helpers can be cross-compiled from macOS with `cargo-xwin`:

```bash
cargo xwin build --release --target x86_64-pc-windows-msvc --bin sparrow --features live_svg
cp target/x86_64-pc-windows-msvc/release/sparrow.exe ../nesting-app/native/windows/bin/
```

Rebuild the Linux helper on Linux with the same `cargo build` command, then
copy `target/release/sparrow` into `native/linux/bin/`. Helpers for other
platforms do not receive an engine fix until they are rebuilt too.

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
