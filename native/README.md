# Native Engine Integration

This app now includes macOS-native Rust binaries copied from the `nesting` workspace:

- `native/macos/bin/packing`

This is the recommended local approach for Electron:

1. Keep the nesting engine as standalone Rust executables.
2. Run them only from Electron's `main` process.
3. Expose a narrow IPC API to the renderer.

Do not run these binaries directly from the renderer process.

## Executable Name

The fork's Cargo package and executable target are named `packing`; builds emit
`target/release/packing` on macOS/Linux and `packing.exe` on Windows. This is a
packaging rename, not a change to the nesting algorithm or output format.
Upstream Sparrow attribution and the internal Rust library name are retained.
Existing `run-sparrow`/`poll-sparrow`/`stop-sparrow` IPC channels and the live
preview manifest key remain compatible. Engine info exposes `packingPath` and
`exists.packing`, with the old field names retained as aliases.

The checked-in Linux helper was renamed without rebuilding it; its capabilities
are unchanged. Rebuild it on Linux to pick up recent engine changes.
`npm run test:native-engine-name` checks launch paths for all platforms in
development and packaged layouts, compatibility fields and packaging names.

## Geometry Engine Backports

The macOS arm64 and Windows x64 helpers include selected upstream jagua-rs
improvements while retaining our existing input format and custom optimizer:

- Native per-hazard early rejection, a faster collision collector, and cached
  surrogate screening reduce repeated collision work.
- Polygon simplification cannot enlarge the original bounding box. Requested
  spacing offsets are still applied separately.
- `geo 0.33` buffering replaces `geo-buffer` for clearance offsets, with
  validation at solver precision.
- Placed items, collision hazards and snapshots share immutable polygon
  geometry instead of repeatedly copying it.

These are backports to the vendored 0.7-compatible fork, not a complete 1.1
migration. Sources, upstream references, regression tests and fixed-work
benchmarks are documented in the sibling engine's `vendor/jagua-rs/BACKPORTS.md`.
Local macOS benchmarks showed 20-28% less collision-evaluation time across
three inputs; this is not a prediction of total nesting time or layout quality.

Verification included 66 native tests, the app's shared-edge suite (17 native
scenarios), cutout nesting in all three sheet modes, previews, layout editing,
and DXF export. The Windows helper was cross-compiled, not runtime-tested on
Windows. Linux still needs rebuilding. The older Rust integration suite has
pre-existing API drift, documented in `BACKPORTS.md`; it is not counted as a pass.

## Allow Exact Fits

Settings > Algorithm > **Allow exact fits** is on by default. Saved explicit
choices to disable it are preserved. It requires zero
part spacing, Auto multi-sheet strategy, and Fixed or Optimize up to max length
sheet mode. Sheet margins and allowed rotations remain in effect.

The native `--exact-fit-assist` pass tries exact contact positions separately
from the strict-touch optimizer. It can use 0.1 mm of temporary search slack,
but accepts only complete layouts recovered onto the original usable sheets.
It never scales parts. Both collision contours and export-precision source
contours are checked for bounds and intersection, including after finishing
and the unified-to-local sheet coordinate round trip. Normal completion and
Stop select between validated plans; failed recovery keeps the normal result.

Assisted layouts use the DXF writer's 0.0001 mm precision for placement
translations in both validation and final JSON. Original contour coordinates
are not rounded or scaled. This avoids false overlap failures caused by f32
centering/serialization of offset decimal-coordinate DXFs. Candidate generation
also checks nearby representable translations, without relaxing final bounds.

The search uses at most 15% of the run budget, capped at 2 seconds, with limits
of 512 copies, 1,024 vertices per contour and 32,768 vertices across copies.
Complex jobs fall back to normal nesting. This is a bounded heuristic, not a
guarantee of a globally optimal layout. Exact-contact plans are not fed back
into the strict-touch optimizer, which would separate them again.

Repeated copies reuse failed contact searches on unchanged sheets. The cache
is per item type, resets when a part is added (new edges create new candidate
positions), and never records interrupted searches. This prevents full sheets
from consuming the budget repeatedly on multi-sheet jobs. Trial diagnostics
report search counts, skipped repeats and deadline expiry. The macOS arm64 and
Windows x64 helpers include this fix; Linux still needs rebuilding.

Rebuild the helper on each platform when shipping this feature. The app checks
for the CLI capability before launching; older helpers use normal nesting,
with the control disabled and an explanatory hint in Settings, rather than
receiving an unknown flag or preventing a run. The Linux helper still
needs rebuilding. Sources are in the sibling `nesting` repository.

Checks: `npm run test:exact-fit-assist` and
`npm run test:exact-fit-assist:native`. The native test also accepts a helper
path and verifies final DXF dimensions, margins, counts, contacts, multiple
sheets, and early stopping.

The geometry integration cases use a 15-second global budget to give exact-fit
construction its full 2-second allowance on slower CI runners. They are not
3-second performance benchmarks; the expected sheet counts and geometry checks
are unchanged. Failed Windows Store runs retain inputs, native logs and outputs
in an `exact-fit-diagnostics` workflow artifact.
Multi-sheet cases also assert bounded search counts, independently of CPU speed.

## Stopping During Startup

Stop is latched while placement preparation or native launch is still pending.
Helpers advertising `--stop-file` receive a persistent per-run marker on every
platform, including macOS, so requests cannot be lost before signal handling
is installed. Older helpers retain the signal-based fallback.

Initial placement construction, barrier sheet discovery and legacy bucket
planning now check cancellation, including inside sampling and refinement.
Stopping before a complete baseline cancels without exporting partial parts.
Once a complete baseline exists, normal best-result finalization still applies.
Legacy bucket mode prepares all baselines before optimization so a later Stop
does not have to start constructing more sheets. Failed stop requests remain
retryable in the UI, with polling restored.

Checks: `npm run test:nesting-stop`, `npm run test:native-engine-name` and
`npm run test:nesting-stop:native`. The macOS arm64 and Windows x64 helpers
include the native changes; Linux needs a rebuild to interrupt initial planning.

## Experimental Cutout Nesting

Settings > Algorithm > **Nest inside cutouts** is off by default. It uses a
separate `packing --cutout -i request.json` subset optimizer, not the strip's
all-parts-must-fit workflow.
The native source is `src/optimizer/cutout.rs` in the sibling `nesting` repository.
Both repositories must be included when shipping or reviewing this feature.

- The fixed irregular container reuses jagua collision detection and Sparrow's
  sampling, coordinate descent and guided collision repair. The polygon exterior
  is a fixed hazard, so no artificial filler parts or rectangular approximation
  are needed. It does not resize the hole or recursively nest children.
- Two greedy starting layouts establish a valid fallback. Contact-position
  sampling fills narrow gaps; add-and-rearrange attempts move the existing
  children too. Bounded one-for-many substitutions can replace a blocking part.
  Only feasible improvements in packed area (then count) are retained. The
  search remains a heuristic, not a guarantee of the best possible subset.
- Background preparation is debounced and serialized, with bounded geometry,
  candidates, copies, samples and elapsed time. Geometry validation runs in a
  worker, outside Electron's UI/main threads. Run uses only completed results;
  an early Run or a skipped/failed preparation uses ordinary nesting instead.
- Cached patterns are keyed by exact contours, rotations, spacing and bounded
  remaining demand. Openings are prepared in order using the quantities left
  after earlier packages, including repeated parent copies; Run resolves the
  same keys. Assembly accounts for current inventory and assigns contiguous solver
  IDs. Parent and children remain a rigid package through all sheet modes,
  early stopping and automatic alignment.
- Children retain their own DXF entities and layers. Export composes the child
  and parent transforms, then applies the sheet margin once. The input JSON's
  `cutout_exports` manifest preserves this information for recovery.
- Preparation uses polygonal cutout contours with a 0.02 mm safety allowance in
  addition to part spacing. Complex inputs are skipped, not simplified further.
  Empty search results mean unknown, not proof of infeasibility.
- The first version does not optimize across packages or count their internal
  shared edges. Shared-edge totals are shown as unavailable for packaged runs.

After nesting, Edit Layout expands each package into independently selectable
physical parts. Children can move/rotate within or between approved cutouts or
onto free sheet space. Moving/deleting a parent does not move/delete its children;
multi-select them explicitly to move the group. Collision and clearance checks
use material boundaries with approved empty cutouts, not arbitrary drawing loops.
Straight cutout boundaries are also snapping targets when source geometry confirms
they are lines. Undo/redo/reset retain stable per-copy identities.

Version 2 manual edits address this expanded placement list. The shared model is
rebuilt identically for the preview and DXF export; original solver JSON and
package metadata are not rewritten. Unversioned legacy edits still address whole
packages. Export validates edits before emitting each physical part once, with
its own source entities and layers. `npm run test:cutout-editing` covers this path.

Rebuild the platform's existing packing helper with `--features live_svg` after
updating the native source. The app probes `--help` and disables the setting on
older helpers, including Linux builds that have not yet been rebuilt.

Verification: `npm run test:cutout-nesting` exercises the worker, native search,
all sheet modes, inventory, transforms and DXF export. It also accepts an
executable path: `node scripts/test-cutout-nesting.js /path/to/packing`.
`npm run test:placement-editor-ui` covers independent child selection, moving
between cutouts, group movement, rotation, deletion and undo using real SVG hit testing.

## Current layout

```text
native/
  macos/
    bin/
      packing
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
  "packingPath": ".../native/macos/bin/packing",
  "exists": {
    "packing": true
  }
}
```

## Recommended binding pattern

Run native commands from `main.js` using `child_process.spawn`.

Example:

```js
const { spawn } = require('node:child_process');

function runPacking(binaryPath, inputPath, outputDir) {
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
saved preference; the settings dialog explains this under the toggle, offers a
one-click "Set spacing to 0", and the shared-edge total is left off the stats
line for runs with spacing (it could only ever read 0). Input
`shared_edge_segments` identifies actual straight
DXF segments so sampled curve chords do not earn contact credit; only segments
that also belong to the outer nesting contour are eligible. The log reports
accepted moves and gained shared-edge length. This metric is not a machine
cut-time estimate. macOS and Windows helpers include the new flag; Linux
must be rebuilt before using it. The app checks support before requesting it.

From the Rust workspace:

```bash
cd /Users/pavel/Extensions/nesting
cargo build --release --bin packing --features live_svg
```

Then copied into this app:

```bash
cp /Users/pavel/Extensions/nesting/target/release/packing /Users/pavel/Extensions/nesting-app/native/macos/bin/
chmod +x /Users/pavel/Extensions/nesting-app/native/macos/bin/packing
```

Windows helpers can be cross-compiled from macOS with `cargo-xwin`:

```bash
cargo xwin build --release --target x86_64-pc-windows-msvc --bin packing --features live_svg
cp target/x86_64-pc-windows-msvc/release/packing.exe ../nesting-app/native/windows/bin/
```

Rebuild the Linux helper on Linux with the same `cargo build` command, then
copy `target/release/packing` into `native/linux/bin/`. Helpers for other
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
