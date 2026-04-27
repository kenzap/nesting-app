Place optional AppX / MSIX tile and Store assets in this folder.

Electron Builder looks for these filenames here because `build.directories.buildResources`
points at `/Users/pavel/Extensions/nesting-app/assets`.

Recommended asset filenames:

- `StoreLogo.png`
- `Square150x150Logo.png`
- `Square44x44Logo.png`
- `Wide310x150Logo.png`

Optional assets:

- `BadgeLogo.png`
- `LargeTile.png`
- `SmallTile.png`
- `SplashScreen.png`

If these files are absent, Electron Builder can fall back to generated defaults,
but adding branded PNG assets here produces a cleaner Microsoft Store package.

Source assets in this folder:

- `logo-k.svg` is a square-friendly `K` cropped from `/Users/pavel/Extensions/nesting-app/assets/logo.dark.svg`
- `logo.dark.svg` remains the source for the wide and splash wordmark-style assets
