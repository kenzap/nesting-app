# Windows Store Icons

AppX launcher, tile, Store, and splash images are generated from
`assets/icon-square-windows.svg`, the current blue nesting-blocks artwork.
The EXE uses `assets/icon-square.ico`; changing that ICO alone does not update
Store launcher icons. Electron Builder reads this folder because
`build.directories.buildResources` is `assets`.

After editing the Windows vector icon, run:

```bash
npm run appx:assets
npm run preflight:appx-assets
```

Commit the generated PNGs and `scripts/appx-assets-manifest.json` together with
the source change. The manifest records the source and image checksums so
verification works across macOS, Windows, and Linux without rendering again.
`@resvg/resvg-js` is a development-only renderer, not part of the shipped app.

Generated families:

- `StoreLogo`, `Square44x44Logo`, and `Square150x150Logo`
- `Wide310x150Logo`, `LargeTile`, `SmallTile`, and `SplashScreen`
- Base images and 100%, 125%, 150%, 200%, 250%, 300%, and 400% scale variants
- `Square44x44Logo` target sizes from 16 to 256 pixels, including unplated
  and light-unplated variants for taskbar, Start, and search icons

Every resolution is rendered directly from the vector source, not enlarged from
a small PNG. Square app-list icons use the full icon; tiles and rectangular
images center it with padding. The same branded icon works on both themes.

Local AppX builds, direct electron-builder AppX builds, and GitHub Actions reject
missing, modified, or outdated assets. GitHub Actions also checks the image
checksums inside the finished AppX before creating its upload archive.
`npm run test:appx-assets` covers generation and these failure cases.

For Windows resource naming and size requirements, see
[Microsoft's app icon guidance](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction).
