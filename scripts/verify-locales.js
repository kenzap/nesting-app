'use strict';

const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const translations = require('../shared/locales');
const { LANGUAGE_PREFERENCES } = require('../shared/settings');

function flatten(value, prefix = '', result = {}) {
  Object.entries(value).forEach(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, result);
    else result[path] = String(child);
  });
  return result;
}

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map(match => match[1]).sort();
}

const catalogs = Object.fromEntries(
  Object.entries(translations).map(([language, translation]) => [language, flatten(translation)]),
);
const expectedKeys = Object.keys(catalogs.en).sort();
const pluralSuffixPattern = /_(zero|one|two|few|many|other)$/;
const pluralBases = expectedKeys
  .filter(key => key.endsWith('_other') && expectedKeys.includes(`${key.slice(0, -6)}_one`))
  .map(key => key.slice(0, -6));
const errors = [];
const expectedLanguagePreferences = ['auto', ...Object.keys(translations)];
const appxLanguages = packageJson.build?.appx?.languages || [];
const appxLanguageCodes = appxLanguages.map(locale => String(locale).toLowerCase().split('-')[0]);

expectedLanguagePreferences
  .filter(language => !LANGUAGE_PREFERENCES.includes(language))
  .forEach(language => errors.push(`settings: missing language preference ${language}`));
LANGUAGE_PREFERENCES
  .filter(language => !expectedLanguagePreferences.includes(language))
  .forEach(language => errors.push(`settings: unknown language preference ${language}`));
Object.keys(translations)
  .filter(language => !appxLanguageCodes.includes(language))
  .forEach(language => errors.push(`package.json: missing AppX language for ${language}`));
appxLanguageCodes
  .filter(language => !Object.hasOwn(translations, language))
  .forEach(language => errors.push(`package.json: unknown AppX language ${language}`));

function pluralSourceKey(key) {
  const base = key.replace(pluralSuffixPattern, '');
  if (base === key || !pluralBases.includes(base)) return null;
  return `${base}_other`;
}

function translationKeyExists(key) {
  return expectedKeys.includes(key)
    || expectedKeys.includes(`${key}_one`)
    || expectedKeys.includes(`${key}_other`);
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|html)$/.test(entry.name) ? [target] : [];
  });
}

Object.entries(catalogs).forEach(([language, catalog]) => {
  const keys = Object.keys(catalog).sort();
  expectedKeys.filter(key => !keys.includes(key)).forEach(key => errors.push(`${language}: missing ${key}`));
  keys.filter(key => !expectedKeys.includes(key) && !pluralSourceKey(key))
    .forEach(key => errors.push(`${language}: extra ${key}`));
  keys.forEach(key => {
    const sourceKey = expectedKeys.includes(key) ? key : pluralSourceKey(key);
    if (!sourceKey) return;
    const source = placeholders(catalogs.en[sourceKey]);
    const target = placeholders(catalog[key]);
    if (source.join('|') !== target.join('|')) {
      errors.push(`${language}: placeholders differ for ${key} (${source.join(', ')} vs ${target.join(', ')})`);
    }
  });
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  pluralBases.forEach(base => {
    categories.forEach(category => {
      const key = `${base}_${category}`;
      if (!(key in catalog)) errors.push(`${language}: missing plural form ${key}`);
    });
  });
});

const russianTerminologyChecks = [
  {
    keys: [
      'parts.title',
      'parts.removeAll',
      'export.totalParts',
      'export.parts',
      'preview.removePart',
      'history.title',
      'history.none',
      'history.withCount',
      'report.parts',
      'nesting.affectedOne',
      'nesting.affectedMany',
      'nesting.onePartTooLarge',
      'nesting.manyPartsTooLarge',
    ],
    pattern: /детал/iu,
    preferred: 'деталь',
  },
  {
    keys: [
      'preview.shapes',
      'preview.togglePanel',
      'preview.hideOrRestore',
      'preview.restoreShape',
      'nesting.noExportableShapes',
    ],
    pattern: /контур/iu,
    preferred: 'контур',
  },
];

russianTerminologyChecks.forEach(({ keys, pattern, preferred }) => {
  keys.forEach(key => {
    if (!pattern.test(catalogs.ru[key])) {
      errors.push(`ru: ${key} should use consistent term “${preferred}”`);
    }
  });
});

Object.entries(catalogs.ru).forEach(([key, value]) => {
  if (/\b(?:часть|части|частей|запчасть|запчасти|фигура|фигуры|фигур|форма|формы)\b/iu.test(value)) {
    errors.push(`ru: inconsistent CAD/CAM terminology in ${key}`);
  }
});

const spanishTerminologyChecks = [
  {
    keys: [
      'parts.title',
      'parts.removeAll',
      'export.totalParts',
      'export.parts',
      'preview.removePart',
      'history.title',
      'history.none',
      'history.withCount',
      'report.parts',
      'nesting.affectedOne',
      'nesting.affectedMany',
      'nesting.onePartTooLarge',
      'nesting.manyPartsTooLarge',
    ],
    pattern: /piez/iu,
    preferred: 'pieza',
  },
  {
    keys: [
      'parts.shapeCount_one',
      'parts.shapeCount_other',
      'preview.shapes',
      'preview.togglePanel',
      'preview.hideOrRestore',
      'preview.restoreShape',
      'nesting.noExportableShapes',
    ],
    pattern: /contorn/iu,
    preferred: 'contorno',
  },
  {
    keys: [
      'canvas.utilization',
      'export.averageUtilization',
      'export.utilization',
      'report.averageUtilization',
      'report.utilization',
    ],
    pattern: /aprovechamiento/iu,
    preferred: 'aprovechamiento',
  },
  {
    keys: [
      'sheet.add',
      'sheet.fixedSize',
      'canvas.sheets',
      'canvas.sheetNumber',
      'export.sheets',
      'export.sheetSize',
      'report.sheets',
      'report.sheet',
      'nesting.cannotFit',
    ],
    pattern: /hoj/iu,
    preferred: 'hoja',
  },
];

spanishTerminologyChecks.forEach(({ keys, pattern, preferred }) => {
  keys.forEach(key => {
    if (!pattern.test(catalogs.es[key])) {
      errors.push(`es: ${key} should use consistent term “${preferred}”`);
    }
  });
});

const terminologyKeyGroups = {
  part: [
    'parts.title',
    'parts.removeAll',
    'export.totalParts',
    'export.parts',
    'preview.removePart',
    'history.title',
    'history.none',
    'history.withCount',
    'report.parts',
    'nesting.affectedOne',
    'nesting.affectedMany',
    'nesting.onePartTooLarge',
    'nesting.manyPartsTooLarge',
  ],
  contour: [
    'parts.shapeCount_one',
    'parts.shapeCount_other',
    'preview.shapes',
    'preview.togglePanel',
    'preview.hideOrRestore',
    'preview.restoreShape',
    'nesting.noExportableShapes',
  ],
  utilization: [
    'canvas.utilization',
    'export.averageUtilization',
    'export.utilization',
    'report.averageUtilization',
    'report.utilization',
  ],
  sheet: [
    'sheet.add',
    'sheet.fixedSize',
    'canvas.sheets',
    'canvas.sheetNumber',
    'export.sheets',
    'export.sheetSize',
    'report.sheets',
    'report.sheet',
    'nesting.cannotFit',
  ],
  nesting: [
    'app.startNesting',
    'app.stopNesting',
    'canvas.emptyTitle',
    'report.title',
    'report.defaultJob',
    'nesting.failed',
    'errors.nestingFailed',
  ],
};

const additionalTerminologyChecks = {
  ar: {
    part: { pattern: /قطع|قطعة/iu, preferred: 'قطعة' },
    contour: { pattern: /كفاف/iu, preferred: 'كفاف' },
    utilization: { pattern: /استغلال/iu, preferred: 'نسبة الاستغلال' },
    sheet: { pattern: /صف(?:ي|ائ)ح/iu, preferred: 'صفيحة' },
    nesting: { pattern: /تعشيق/iu, preferred: 'تعشيق' },
  },
  de: {
    part: { pattern: /teil/iu, preferred: 'Teil' },
    contour: { pattern: /kontur/iu, preferred: 'Kontur' },
    utilization: { pattern: /auslastung/iu, preferred: 'Auslastung' },
    sheet: { pattern: /tafel/iu, preferred: 'Tafel' },
    nesting: { pattern: /verschachtel/iu, preferred: 'Verschachtelung' },
  },
  fr: {
    part: { pattern: /pi[eè]c/iu, preferred: 'pièce' },
    contour: { pattern: /contour/iu, preferred: 'contour' },
    utilization: { pattern: /utilisation/iu, preferred: 'utilisation' },
    sheet: { pattern: /t[oô]le/iu, preferred: 'tôle' },
    nesting: { pattern: /imbrication/iu, preferred: 'imbrication' },
  },
  id: {
    part: { pattern: /komponen/iu, preferred: 'komponen' },
    contour: { pattern: /kontur/iu, preferred: 'kontur' },
    utilization: { pattern: /pemanfaatan/iu, preferred: 'pemanfaatan' },
    sheet: { pattern: /lembar/iu, preferred: 'lembar' },
    nesting: { pattern: /nesting/iu, preferred: 'nesting' },
  },
  it: {
    part: { pattern: /part/iu, preferred: 'parte' },
    contour: { pattern: /contorn/iu, preferred: 'contorno' },
    utilization: { pattern: /utilizz/iu, preferred: 'utilizzo' },
    sheet: { pattern: /fogli/iu, preferred: 'foglio' },
    nesting: { pattern: /nesting/iu, preferred: 'nesting' },
  },
  hi: {
    part: { pattern: /पार्ट/iu, preferred: 'पार्ट' },
    contour: { pattern: /कंटूर/iu, preferred: 'कंटूर' },
    utilization: { pattern: /उपयोग दर/iu, preferred: 'उपयोग दर' },
    sheet: { pattern: /शीट/iu, preferred: 'शीट' },
    nesting: { pattern: /नेस्टिंग/iu, preferred: 'नेस्टिंग' },
  },
  ja: {
    part: { pattern: /パーツ/iu, preferred: 'パーツ' },
    contour: { pattern: /輪郭/iu, preferred: '輪郭' },
    utilization: { pattern: /使用率/iu, preferred: '使用率' },
    sheet: { pattern: /シート/iu, preferred: 'シート' },
    nesting: { pattern: /ネスティング/iu, preferred: 'ネスティング' },
  },
  pt: {
    part: { pattern: /peç/iu, preferred: 'peça' },
    contour: { pattern: /contorn/iu, preferred: 'contorno' },
    utilization: { pattern: /aproveitamento/iu, preferred: 'aproveitamento' },
    sheet: { pattern: /folh/iu, preferred: 'folha' },
    nesting: { pattern: /nesting/iu, preferred: 'nesting' },
  },
  pl: {
    part: { pattern: /częś/iu, preferred: 'część' },
    contour: { pattern: /kontur/iu, preferred: 'kontur' },
    utilization: { pattern: /wykorzyst/iu, preferred: 'wykorzystanie' },
    sheet: { pattern: /arkusz/iu, preferred: 'arkusz' },
    nesting: { pattern: /rozkład/iu, preferred: 'rozkład' },
  },
  tr: {
    part: { pattern: /parça/iu, preferred: 'parça' },
    contour: { pattern: /kontur/iu, preferred: 'kontur' },
    utilization: { pattern: /kullanım/iu, preferred: 'kullanım' },
    sheet: { pattern: /levha/iu, preferred: 'levha' },
    nesting: { pattern: /yerleşim/iu, preferred: 'yerleşim' },
  },
  zh: {
    part: { pattern: /零件/iu, preferred: '零件' },
    contour: { pattern: /轮廓/iu, preferred: '轮廓' },
    utilization: { pattern: /利用率/iu, preferred: '利用率' },
    sheet: { pattern: /板材/iu, preferred: '板材' },
    nesting: { pattern: /排料/iu, preferred: '排料' },
  },
};

Object.entries(additionalTerminologyChecks).forEach(([language, checks]) => {
  Object.entries(checks).forEach(([concept, { pattern, preferred }]) => {
    terminologyKeyGroups[concept].forEach(key => {
      if (!pattern.test(catalogs[language][key])) {
        errors.push(`${language}: ${key} should use consistent term “${preferred}”`);
      }
    });
  });
});

const projectRoot = path.join(__dirname, '..');
const filesToCheck = [
  ...sourceFiles(path.join(projectRoot, 'main')),
  ...sourceFiles(path.join(projectRoot, 'renderer')),
  path.join(projectRoot, 'preload.js'),
];
const keyPatterns = [
  /\bt\(\s*['"]([a-z][\w.-]*)['"]/g,
  /NestI18n\.t\(\s*['"]([a-z][\w.-]*)['"]/g,
  /data-i18n(?:-title|-placeholder|-aria-label)?=['"]([a-z][\w.-]*)['"]/g,
];

filesToCheck.forEach(filePath => {
  const source = fs.readFileSync(filePath, 'utf8');
  keyPatterns.forEach(pattern => {
    for (const match of source.matchAll(pattern)) {
      if (!translationKeyExists(match[1])) {
        errors.push(`${path.relative(projectRoot, filePath)}: unknown translation key ${match[1]}`);
      }
    }
  });
});

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Locale catalogs verified: ${expectedKeys.length} keys across ${Object.keys(catalogs).length} languages.`);
}
