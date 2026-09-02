'use strict';

(function defineNestUnits(globalScope) {
  const MM_PER_INCH = 25.4;
  const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);
  let configuredSystemLocales = null;

  function normalizeMeasurementSystem(value) {
    const normalized = String(value || '').toLowerCase();
    return ['auto', 'metric', 'imperial'].includes(normalized) ? normalized : 'auto';
  }

  function localeRegion(locale) {
    const value = String(locale || '').trim();
    if (!value) return '';
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
        return String(new Intl.Locale(value).maximize().region || '').toUpperCase();
      }
    } catch {
      // Fall through to the simple language-tag parser.
    }
    const region = value.replace(/_/g, '-').split('-')
      .find((part, index) => index > 0 && (/^[a-z]{2}$/i.test(part) || /^\d{3}$/.test(part)));
    return String(region || '').toUpperCase();
  }

  function systemLocales() {
    if (configuredSystemLocales?.length) return [...configuredSystemLocales];
    if (typeof navigator === 'undefined') return [];
    const locales = Array.isArray(navigator.languages) ? navigator.languages : [];
    let intlLocale = '';
    try {
      intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      intlLocale = '';
    }
    return [...locales, navigator.language, intlLocale].filter(Boolean);
  }

  function setSystemLocales(locales) {
    const normalized = (Array.isArray(locales) ? locales : [locales])
      .map(value => String(value || '').trim())
      .filter(Boolean);
    configuredSystemLocales = normalized.length ? normalized : null;
  }

  function detectMeasurementSystem(locales = systemLocales()) {
    const candidates = Array.isArray(locales) ? locales : [locales];
    const region = candidates.map(localeRegion).find(Boolean);
    return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
  }

  function resolveMeasurementSystem(preference = 'auto', locales = systemLocales()) {
    const normalized = normalizeMeasurementSystem(preference);
    return normalized === 'auto' ? detectMeasurementSystem(locales) : normalized;
  }

  function unitLabel(system = 'metric') {
    return resolveMeasurementSystem(system) === 'imperial' ? 'in' : 'mm';
  }

  function toDisplayLength(mm, system = 'metric') {
    const numeric = Number(mm);
    if (!Number.isFinite(numeric)) return NaN;
    return resolveMeasurementSystem(system) === 'imperial' ? numeric / MM_PER_INCH : numeric;
  }

  function fromDisplayLength(value, system = 'metric') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return NaN;
    return resolveMeasurementSystem(system) === 'imperial' ? numeric * MM_PER_INCH : numeric;
  }

  function formatNumber(value, precision) {
    if (!Number.isFinite(value)) return '—';
    return value.toFixed(precision).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  }

  function formatLength(mm, {
    system = 'metric',
    metricPrecision = 1,
    imperialPrecision = 3,
    includeUnit = true,
  } = {}) {
    const resolved = resolveMeasurementSystem(system);
    const converted = toDisplayLength(mm, resolved);
    const precision = resolved === 'imperial' ? imperialPrecision : metricPrecision;
    const value = formatNumber(converted, precision);
    return includeUnit && value !== '—' ? `${value} ${unitLabel(resolved)}` : value;
  }

  function formatDimensions(widthMm, heightMm, options = {}) {
    const system = resolveMeasurementSystem(options.system);
    const width = formatLength(widthMm, { ...options, system, includeUnit: false });
    const height = formatLength(heightMm, { ...options, system, includeUnit: false });
    const suffix = options.includeUnit === false ? '' : ` ${unitLabel(system)}`;
    return `${width} × ${height}${suffix}`;
  }

  function formatInputLength(mm, system = 'metric', { imperialPrecision = 3, metricPrecision = 3 } = {}) {
    const resolved = resolveMeasurementSystem(system);
    const precision = resolved === 'imperial' ? imperialPrecision : metricPrecision;
    return formatNumber(toDisplayLength(mm, resolved), precision);
  }

  function formatLongLength(mm, system = 'metric') {
    const numeric = Number(mm);
    if (!Number.isFinite(numeric) || numeric <= 0) return 'n/a';
    const resolved = resolveMeasurementSystem(system);
    return resolved === 'imperial'
      ? `${(numeric / 304.8).toFixed(2)} ft`
      : `${(numeric / 1000).toFixed(2)} m`;
  }

  const unitsApi = {
    MM_PER_INCH,
    IMPERIAL_REGIONS,
    normalizeMeasurementSystem,
    setSystemLocales,
    localeRegion,
    detectMeasurementSystem,
    resolveMeasurementSystem,
    unitLabel,
    toDisplayLength,
    fromDisplayLength,
    formatLength,
    formatDimensions,
    formatInputLength,
    formatLongLength,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = unitsApi;
  globalScope.NestUnits = unitsApi;
})(typeof window !== 'undefined' ? window : globalThis);
