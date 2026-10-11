<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo.white.svg">
    <img src="assets/logo.dark.svg" alt="Kenzap Nesting" width="200">
  </picture>

  <h3>Desktop DXF Nesting for Sheet &amp; Strip Layouts</h3>
  <p>
    Live preview · State-of-the-art 2D nesting algorithm · DXF in / DXF out · Engraving · macOS, Windows &amp; Linux
  </p>

  <p>
    <strong>English</strong> ·
    <a href="docs/i18n/README.zh.md">简体中文</a> ·
    <a href="docs/i18n/README.es.md">Español</a> ·
    <a href="docs/i18n/README.hi.md">हिन्दी</a> ·
    <a href="docs/i18n/README.ar.md">العربية</a> ·
    <a href="docs/i18n/README.pt.md">Português</a> ·
    <a href="docs/i18n/README.ru.md">Русский</a> ·
    <a href="docs/i18n/README.ja.md">日本語</a> ·
    <a href="docs/i18n/README.de.md">Deutsch</a> ·
    <a href="docs/i18n/README.fr.md">Français</a> ·
    <a href="docs/i18n/README.id.md">Bahasa Indonesia</a>
  </p>

  <p>
    <a href="https://github.com/kenzap/nesting-app/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kenzap/nesting-app?style=flat-square&color=2563eb&label=release"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/kenzap/nesting-app?style=flat-square&color=64748b"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square">
    <a href="https://github.com/kenzap/nesting-app/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/kenzap/nesting-app?style=flat-square&color=eab308"></a>
    <a href="https://www.reddit.com/r/kenzap/"><img alt="Community" src="https://img.shields.io/badge/community-r%2Fkenzap-FF4500?style=flat-square"></a>
  </p>

  <p>
    <a href="https://apps.apple.com/lv/app/kenzap-nesting/id6776196927?mt=12">
      <img alt="Download on the Mac App Store" src="https://tools.applemediaservices.com/api/badges/download-on-the-mac-app-store/black/en-us?size=250x83" height="48">
    </a>
    <a href="https://apps.microsoft.com/detail/9nbr7z0phs02?hl=en-US&gl=EN">
      <img alt="Get it from Microsoft" src="https://get.microsoft.com/images/en-us%20dark.svg" height="48">
    </a>
    <a href="https://snapcraft.io/kenzap-nesting">
      <img alt="Get it from the Snap Store" src="https://snapcraft.io/en/dark/install.svg" height="48">
    </a>
  </p>

  <img src="assets/preview.gif" alt="Kenzap Nesting live preview" width="100%">
</div>

---

## Overview

**Kenzap Nesting** is a desktop application that packs DXF parts onto sheets using a state-of-the-art 2D nesting algorithm running locally on your machine. Drop in your drawings, set quantities, configure spacing and engraving, and export the result as production-ready DXF — no cloud round-trip, no per-job billing.

It is designed for the practical reality of CNC, laser, plasma, and waterjet operators: mixed geometry, multi-layer files, real-world spacing and rotation constraints, and engraving that needs to live on its own layer.

Reduce waste and speed up quotation. This app's logic can be seamlessly integrated with production management software. Learn more at https://kenzap.com.

## Downloads

### Stable releases (recommended)

| Platform | Store | Architecture |
|---|---|---|
| **macOS** | [Mac App Store](https://apps.apple.com/lv/app/kenzap-nesting/id6776196927?mt=12) | Apple Silicon |
| **Windows** | [Microsoft Store](https://apps.microsoft.com/detail/9nbr7z0phs02?hl=en-US&gl=EN) | x86_64 |
| **Ubuntu / Linux** | [Snap Store](https://snapcraft.io/kenzap-nesting) | x86_64 |

### Latest builds (GitHub Releases)

Skip the store cadence and grab the freshest build directly:

- **[Latest GitHub Release](https://github.com/kenzap/nesting-app/releases/latest)** &mdash; macOS arm64, Windows x86_64, and Ubuntu x86_64 artifacts

## How It Works

Drop one or more DXF sketches into the app. Kenzap Nesting automatically detects nestable shapes, then lets you set quantities, engraving, and sheet behavior before sending the job to a native nesting engine and previewing the resulting sheets live.

**Workflow at a glance:**

1. **Add DXF parts** &mdash; drag & drop or browse.
2. **Detect shapes** &mdash; the app finds individual parts and any internal cut / engraving geometry within a single sketch.
3. **Configure** &mdash; sheet size, strip behavior, spacing, rotation step, alignment, and engraving style.
4. **Run** &mdash; native nesting engine starts; results stream in as they're computed.
5. **Review live** &mdash; the canvas updates while the algorithm is still optimizing.
6. **Export** &mdash; DXF output preserves your original layer structure and engraving geometry.

Watch a live nesting session: **[Demo on YouTube](https://youtu.be/b55Bph1dwPY)**.

## Features

<table>
  <tr>
    <td valign="top" width="50%">

**Input & detection**

- DXF import by click or drag and drop
- Multi-shape detection within a single sketch
- Multi-layer and color support
- Mixed geometry: lines, arcs, circles, polylines, ellipses, splines
- Per-shape quantity, removal, restore, and layer-aware preview

</td>
    <td valign="top" width="50%">

**Nesting & layout**

- State-of-the-art 2D nesting via bundled native engine
- Live preview while the algorithm is still running
- Configurable spacing, sheet margin, rotation step, alignment
- Plate size optimization
- Polygon-placement JSON export for cloud/offline workflows

</td>
  </tr>
  <tr>
    <td valign="top">

**Export**

- DXF export with preserved layer structure
- Native LWPOLYLINE / arc / spline reconstruction
- Original color and entity metadata kept intact
- Sheet-by-sheet output
- Shared kerf edges between adjacent parts (Common Line Cutting, Co-Edge)

</td>
    <td valign="top">

**Engraving**

- Dedicated engraving layer
- **Simple** &mdash; single-line lettering
- **Stroked** &mdash; outlined lettering
- Bounded automatically to the part envelope

</td>
  </tr>
</table>

## Development

### Requirements

- Node.js (latest LTS recommended) &amp; npm
- Native nesting binaries placed under:
  - `native/linux/bin/`
  - `native/macos/bin/`
  - `native/windows/bin/`

The native binary is **[Sparrow](https://github.com/JeroenGar/sparrow)**. Refer to its repository for compilation instructions if you need to build it for an unsupported architecture.

### Run locally

```bash
npm install
npm run dev
```

`npm run dev` opens Electron with DevTools enabled &mdash; useful for debugging renderer logic and algorithm integration.

### Build

| Target | Command |
|---|---|
| macOS (DMG + ZIP, Developer ID signed) | `npm run dist:mac` |
| Mac App Store (production) | `npm run dist:mas` |
| Mac App Store (development build) | `npm run dist:mas-dev` |
| Windows installer (NSIS) | `npm run dist:win` |
| Windows portable | `npm run dist:win-portable` |
| Windows AppX / MSIX (Microsoft Store) | `npm run dist:appx` |
| Ubuntu Snap | `npm run dist:snap` |

### Windows Store build from GitHub

The **Windows Store Build** workflow builds an x64 Microsoft Store package on a
standard GitHub-hosted Windows runner. It is **manual-only**: creating a release,
pushing a commit, or opening a pull request does not start it automatically.

Once `.github/workflows/windows-store.yml` is pushed to the repository's default
branch (`main`):

1. Open the repository's **Actions** tab and select **Windows Store Build**.
2. Click **Run workflow**, choose the branch to build, and confirm.
3. After the run succeeds, download the artifact from the run's **Artifacts** section.
4. Extract the downloaded ZIP and upload the `.appxupload` file to Microsoft Partner Center.

The download includes the `.appx`, `.appxupload`, and `SHA256SUMS.txt` files and is
retained for **7 days**. The run summary includes the app version, source commit,
and bundled Windows helper checksum. No GitHub release or Store submission is
created, and no Store credentials or signing certificates are required for this
Store-only build. Standard runner execution is free for public repositories;
artifact storage remains subject to GitHub's account limits.

The workflow checks translations and regressions and verifies that the bundled
Windows helper starts. It packages the checked-in `native/windows/bin/sparrow.exe`
without recompiling it, so update that binary separately when the native engine
changes. The app version comes from `package.json`; increase it before submitting
a Store update. These checks do not replace testing the packaged app on Windows
or Microsoft Store certification. The unsigned `.appx` is not ready for direct
sideloading without separate test signing.

### Ubuntu Snap build from GitHub

The **Ubuntu Snap Build** workflow packages the app as an x64 Snap on a
GitHub-hosted Ubuntu 24.04 runner. Like the Windows workflow, it is
**manual-only** and does not publish to the Snap Store or GitHub Releases.

Once `.github/workflows/ubuntu-snap.yml` is pushed to the default branch (`main`):

1. Open **Actions** and select **Ubuntu Snap Build**.
2. Click **Run workflow**, choose the branch to build, and confirm.
3. Download the successful run's artifact and extract its ZIP.
4. Test the `.snap` on Ubuntu, then upload it to the Snap Store using your usual publishing process.

The artifact includes the `.snap`, `BUILD-INFO.txt`, and `SHA256SUMS.txt` and is
retained for **7 days**. Run `sha256sum --check SHA256SUMS.txt` from the extracted
folder to verify the download. Build information records the app version, source
commit, tool versions, and Linux helper checksums. Failed runs also upload any
available Snapcraft logs and generated build configuration for troubleshooting.

The workflow reuses the existing `core24`, GNOME, and strict-confinement
configuration in `package.json`, setting up Snapcraft and LXD on the runner.
It checks translations and regressions, verifies the Linux helper starts, and
checks that the finished Snap contains its desktop launcher, icon, and an
executable Sparrow helper that starts. `npm run dist:snap` uses a Snap-only
wrapper to work around electron-builder's core24 desktop-file path mismatch:
Snapcraft uses the generated `snap/gui` files instead of looking for an entry
that is not yet present in `prime/meta/gui`. This does not modify installed
dependencies or change other platform builds. `npm run test:snap-packaging`
checks the generated manifest and launcher staging without running Snapcraft.
It packages the **checked-in** `native/linux/bin/sparrow` without compiling Rust
or downloading the engine source. Commit and push any updated Linux helper
before building; local-only changes are not included. No Snap Store credentials
are required to build. These checks do not replace testing the installed app on
Ubuntu or Snap Store review. Increase the version in `package.json` before a
Store update.

### Notes

- Build examples above are tested on macOS Apple Silicon. To cross-compile from Windows to macOS, parameter adjustments may be necessary.
- Distributable packages bundle both the Electron app (UI + visualization) and the native nesting binaries.
- Microsoft Store tile assets live under `assets/appx/` &mdash; see [`assets/appx/README.md`](assets/appx/README.md) for naming conventions.
- For real Partner Center submissions, set the final AppX identity and publisher values to the exact reserved Microsoft Store values before shipping.

## Repository Structure

```text
assets/                 app icons, preview media, branding assets
main/                   Electron main-process modules
  app.js                window, menu, About panel, app lifecycle
  ipc/                  file dialogs, Sparrow, DXF export IPC handlers
  utils/                main-process helpers (temp retention cleanup, etc.)
native/                 platform-specific native binaries
  linux/bin/            Sparrow and preprocess binaries for Ubuntu
  macos/bin/            Sparrow and preprocess binaries for macOS
  windows/bin/          Sparrow and preprocess binaries for Windows
renderer/               Electron renderer application
  state/                app state store and mutations
  views/                panes, modals, canvas, DXF preview UI
  services/             nesting, DXF parsing/preview, export workflows
  utils/                DXF geometry, color, SVG, and preview helpers
  helpers.js            renderer-only formatting helpers
  index.html            renderer shell
  renderer.js           renderer bootstrap and module wiring
  styles.css            application styling
shared/                 constants and settings used by both main + renderer
preload.js              secure Electron bridge exposed to the renderer
main.js                 thin bootstrap that starts the main-process modules
dist/                   packaged builds
docs/i18n/              translated README variants
```

## Research

Kenzap Nesting builds on recent computational geometry and nesting research. See:

- **[Computational Geometry research reference](https://arxiv.org/abs/2509.13329)**

## Roadmap &amp; Current Focus

- **Format-agnostic input** &mdash; broader sketch sources beyond DXF
- **Brand-specific tool path integration** &mdash; tighter machine-side workflows
- **Optional cloud nesting** &mdash; offload large jobs to higher-performance backends

## Feedback &amp; Community

- **Bugs &amp; feature requests** &mdash; [GitHub Issues](https://github.com/kenzap/nesting-app/issues)
- **Community discussion** &mdash; [r/kenzap](https://www.reddit.com/r/kenzap/)
- **Updates** &mdash; [LinkedIn](https://www.linkedin.com/company/kenzap)

## License

Licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) for the full text.
