const fs = require('fs');

const VCLIBS_DEPENDENCY = [
  '<PackageDependency',
  'Name="Microsoft.VCLibs.140.00.UWPDesktop"',
  'MinVersion="14.0.27323.0"',
  'Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"',
  '/>'
].join(' ');

module.exports = async function patchAppxManifest(manifestPath) {
  if (!manifestPath) {
    throw new Error('AppX manifest path was not provided to patch-appx-manifest.');
  }

  const xml = fs.readFileSync(manifestPath, 'utf8');
  if (xml.includes('Microsoft.VCLibs.140.00.UWPDesktop')) {
    return;
  }

  const dependenciesPattern = /<Dependencies>([\s\S]*?)<\/Dependencies>/;
  const match = xml.match(dependenciesPattern);
  if (!match) {
    throw new Error(`Could not find <Dependencies> block in AppX manifest: ${manifestPath}`);
  }

  const updatedBlock = `${match[0].replace(
    '</Dependencies>',
    `  ${VCLIBS_DEPENDENCY}\n</Dependencies>`
  )}`;

  fs.writeFileSync(manifestPath, xml.replace(dependenciesPattern, updatedBlock));
  console.log(`[patch-appx-manifest] Added Microsoft.VCLibs dependency to ${manifestPath}`);
};
