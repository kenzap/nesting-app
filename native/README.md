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
Copying tight batches into distant sheet slots can lose tiny gaps to f32
rounding. Assembly first preserves coordinates, then, only if needed, retries
bounded placement separations (at most 0.008 mm per axis, without scaling
parts). Both the combined layout and its sheet-local round trip must pass the
unchanged collision and size checks. Final batch candidates are ranked against
the retained best complete plan instead of unconditionally replacing it.
The optional shared-edge finishing pass checks original contour coordinates
with the serialized export transforms on every proposed move, including group
alignment. Unsafe or incompletely validated moves are skipped individually;
the best validated checkpoint survives Stop or a timeout. Contact scoring and
measurement use the same export-precision geometry, not rounded preview points.
When Favor shared edges is off, preferred alignment still runs a per-part pass
after nominal reconstruction, with a separate 250 ms budget shared across the
job. It preserves spacing and the occupied envelope without locking parts into
existing contact groups. Stop or deadline exhaustion preserves validated moves.
With Favor shared edges on, ordinary per-part alignments toward all four corners
are retained as baseline candidates, alongside the incoming placement. The
shortest ordinary candidate defines a fixed material limit. Candidates within
0.01% of that length (at least 0.001 mm, at most 0.5 mm) rank actual shared-edge
length first, occupied length second, and occupied height last. This material
allowance does not change the 0.001 mm contact tolerance or collision checks,
and never accumulates against successive candidates. Each corner's ordinary
layout seeds its optional contact search; weaker or incompletely scored trials
cannot replace the retained baseline. Search is independent of preferred
alignment. The selected placement is then translated as one rigid arrangement
to the preferred edge/corner. This final translation checks exported geometry
and preserves shared cuts; it does not move individual parts. Fixed sheets use
their full usable frame, while optimized/unlimited sheets keep their used width.
None skips the final translation. The app removes the redundant Auto alignment
option and migrates saved Auto preferences to Bottom Left; the native
`--align-auto` flag remains supported for older clients. Incomplete validation
retains the last safe layout.
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

The optional **Settings > Algorithm > Favor shared edges** toggle defaults to
off. With zero part spacing it passes `--favor-shared-edges` and adds a finishing
budget equal to 5% of the configured search time (at most two seconds for the
entire job), shared across all sheets. The main search keeps its full budget;
finishing no longer deducts exploration/compression time. A quarter of the
finishing budget evaluates ordinary baseline alignments and the rest searches
for additional contacts. It tries contact translations on
nearby parts, maximizing shared straight-edge length within the existing
occupied envelope. Rotations, item quantities, sheet assignments, and margins
are preserved. The same budget also covers contact-preserving alignment:
touching parts move as connected groups, while independent parts move alone.
It alternates contact search and alignment for up to three rounds within the
same time budget, so alignment can expose new contact opportunities. Both
axis orders toward each of the four trial corners are tried, independently of
Preferred alignment. Candidates maximize shared-edge length within the fixed
ordinary-baseline material limit; length and alignment break ties. Each
fully validated improvement is checkpointed; an interrupted or weaker trial
cannot replace the best layout. Alignment moves preserve existing contacts,
and contact-search moves must increase total shared length within the original
occupied envelope. Both original and collision contours are checked. This is a
bounded heuristic, not a guarantee of optimal compaction.
Candidate generation visits long-edge pairs across all nearby parts before
spending its 256-candidate limit on small edges of one neighbor. Contact
translations are calculated in double precision before storage; nearby
representable positions within half the 0.001 mm contact tolerance are also
tried when needed. These retries do not relax collision or sheet-bound checks.
Stop skips or interrupts this optional pass. It does not rotate parts,
increase occupied dimensions, or merge DXF toolpaths.
Positive spacing disables the option without forgetting the
saved preference. Input `shared_edge_segments` identifies actual straight
DXF segments so sampled curve chords do not earn contact credit; only segments
that also belong to the outer nesting contour are eligible. The log reports
accepted moves and gained shared-edge length. This metric is not a machine
cut-time estimate. macOS and Windows helpers include the new flag; Linux
must be rebuilt before using it. The app checks support before requesting it.

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

Completed results include `shared_edge_length_mm` per sheet and
`total_shared_edge_length_mm` in multi-sheet summaries. These measure shared
straight outer edges once per contact (0.001 mm contact tolerance), whether
Favor shared edges is enabled or disabled. They are geometric contact lengths,
not a guarantee that a CAM tool will merge cuts or save an equivalent amount
of cutting time. Curves and internal contours are excluded.

The app supplies `shared_edge_segments` on every input item so comparisons use
actual straight DXF segments rather than tessellated curves. Missing metadata
or an exhausted measurement budget yields `null` (shown as unavailable), never
a misleading zero or partial sum. Measurement is bounded to two seconds across
the job and also runs on finalized early-stop results. Older native helpers
must be rebuilt to provide these statistics.

Before building a job, the renderer recovers straight polygon contours from
their original DXF segments when every edge has an unambiguous match. This
removes small extraction-rounding offsets that otherwise prevent real cuts
from touching. The 0.05 mm correspondence limit is not a contact tolerance:
shared cuts still require 0.001 mm contact. Curved, incomplete, ambiguous, or
unsupported contours remain unchanged. Engine input and export metadata use
the same recovered contour; original exported entities are never modified.
This correction also applies to cached parts on the next nesting run.

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
