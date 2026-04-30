# Kenzap Nesting App

![Kenzap Nesting Preview](assets/preview.gif)

A desktop nesting application for DXF-based sheet and strip layouts, with live preview, built-in state-of-the-art 2D nesting algorithm, DXF sheet export, engraving, and cross-platform support.

## Downloads

- [Windows x64](https://apps.microsoft.com/detail/9nbr7z0phs02?hl=en-US&gl=EN)

Download stable release from the official store.

## Downloads (Latest releases)

- [Windows x64](https://github.com/kenzap/nesting-app/releases/latest)
- [macOS Apple Silicon](https://github.com/kenzap/nesting-app/releases/latest)

Download the matching build from the latest GitHub release page to skip compilation and test the latest version.

## How It Works

Simply drag and drop one or more DXF sketch drawings. Kenzap Nesting automatically detects nestable shapes. Set quantities for each drawing and adjust engraving settings as needed. Click the RUN button to send the job to the native nesting engine and preview the resulting sheets with nested shapes. Export to DXF format with all items packed and ready for placement.

The workflow is:

1. Add DXF parts.
2. Detect separate shapes and internal cut and engraving geometry.
3. Configure sheet size, strip behavior, spacing, rotation, additional engraving, and other algorithm settings.
4. Run the native nesting engine.
5. Review sheets live while the algorithm works.
6. Export final sheets, including DXF output with original layer structure and engraving geometry.

You can also check this video for live [nesting demo](https://youtu.be/b55Bph1dwPY).

## Core Features

- DXF import by click or drag and drop
- Multi-shape detection within a single DXF sketch
- DXF multi-layer and color support
- Preview dialog for per-shape quantity, removal, restore, and layer-aware review
- Support for mixed geometry such as lines, arcs, circles, polylines, ellipses, and splines
- Live nesting preview while the algorithm is still running
- Windows and macOS native integration
- Polygon placement JSON export for cloud or offline algorithm workflows
- DXF export with preserved layer structure and geometry reconstruction
- Plate size optimization
- Configurable spacing, sheet margin, orientation step, alignment, and engraving
- Engraving styles:
  - `Simple` for single-line lettering
  - `Stroked` for outlined lettering

## Research Credit

This project builds on ideas from recent research in computational geometry and nesting.

More info:

- [Computational Geometry research reference](https://arxiv.org/abs/2509.13329)

## Run Natively

### Requirements

- Node.js
- npm
- Native algorithm binaries placed under:
  - `native/macos/bin/`
  - `native/windows/bin/`

To compile the binaries, please refer to the [Sparrow](https://github.com/JeroenGar/sparrow) repository.

### Development Run

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

`npm run dev` opens Electron with DevTools enabled, which is helpful for debugging renderer issues and algorithm integration.

## Build the App

### Windows x64

Windows portable build (running from macOS):

```bash
npx electron-builder --win portable --x64
```

Windows installer build (running from macOS):

```bash
npm run dist:win
```

Windows AppX / MSIX build for Microsoft Store (https://storedeveloper.microsoft.com/) packaging:

```bash
npm run dist:appx
```

When building AppX from macOS, Electron Builder expects a Windows environment.
Its official path for macOS is a running Windows VM, such as Parallels, that it
can detect automatically during the build. This repo preflights that setup and
fails early with a clearer message if `prlctl` is unavailable.

`npm run dist:appx` also creates an `.appxupload` file next to the built package,
which is the recommended artifact for Partner Center submissions.

The AppX manifest is also patched during build to declare the
`Microsoft.VCLibs.140.00.UWPDesktop` framework dependency required by the
bundled native Windows binaries.

For local Windows testing, trust the signing certificate from the latest package
and install it with:

```bash
npm run install:appx-test
```

You can also pass an explicit package path:

```bash
npm run install:appx-test -- "C:\\path\\to\\KENZAP NEST-1.0.0-x64.appx"
```

### macOS

```bash
npx electron-builder
```

Production

```bash
npm run dist:mas-dev
npm run verify:mas-signing
```

check if signed correctly manually
```bash
codesign -dv --verbose=4 "dist/mas-dev/KENZAP NEST.app/Contents/Helpers/sparrow"
codesign -d --entitlements :- "dist/mas-dev/KENZAP NEST.app/Contents/Helpers/sparrow"
```

### Notes

- The build examples above are tested on macOS M-series chips. To cross-compile from Windows to macOS, you may need to adjust some parameters.
- Windows and macOS packages include the Electron app (UI and visualization) and bundled native binaries (nesting algorithm).
- Microsoft Store tile assets can be added under `assets/appx/` using the standard AppX filenames documented in `assets/appx/README.md`.
- For a real Partner Center submission, set the final AppX identity and publisher values to the exact reserved Microsoft Store values before shipping the package.

## Repository Structure

```text
assets/                 app icons, preview media, branding assets
main/                   Electron main-process modules
  app.js                window, menu, About panel, app lifecycle
  ipc/                  file dialogs, Sparrow, DXF export IPC handlers
  utils/                main-process helpers such as temp retention cleanup
native/                 platform-specific native binaries
  macos/bin/            Sparrow and preprocess binaries for macOS
  windows/bin/          Sparrow and preprocess binaries for Windows
renderer/               Electron renderer application
  state/                app state store and mutations
  views/                panes, modals, canvas, DXF preview UI rendering
  services/             nesting, DXF parsing/preview, export workflows
  utils/                DXF geometry, color, SVG, and preview helpers
  helpers.js            shared renderer-only formatting helpers
  index.html            renderer shell
  renderer.js           renderer bootstrap and module wiring
  styles.css            application styling
shared/                 constants and settings used by main + renderer
preload.js              secure Electron bridge exposed to the renderer
main.js                 thin bootstrap that starts the main-process modules
dist/                   packaged builds
```

## Current Focus

Kenzap Nesting is designed for practical DXF nesting workflows:

- Accurate multi-contour import
- Format-agnostic support
- Brand-specific machined tool path integration
- Cloud integration for superior nesting performance

## Feedback

- Bugs & feature requests: [GitHub Issues](https://github.com/kenzap/nesting-app/issues)
- Community discussion: [r/kenzap](https://www.reddit.com/r/kenzap/)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](/Users/pavel/Extensions/nesting-app/LICENSE).
