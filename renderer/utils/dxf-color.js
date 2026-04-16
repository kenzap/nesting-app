(function attachNestDxfColor(global) {
  'use strict';

  // Lookup table mapping the most common AutoCAD Color Index (ACI) values to hex colours.
  // Unknown values are rounded to the nearest ten to find the closest listed entry.
  const ACI = {
    1: '#FF4444', 2: '#FFFF44', 3: '#44DD44', 4: '#44DDDD',
    5: '#4488FF', 6: '#DD44DD', 7: '#CCCCCC', 8: '#888888', 9: '#BBBBBB',
    10: '#FF9999', 20: '#FFBB66', 30: '#FFCC55', 40: '#EEFF55',
    50: '#BBFF55', 60: '#55FF88', 70: '#55FFDD', 80: '#55BBFF',
    90: '#5588FF', 100: '#8866FF', 110: '#CC66FF', 120: '#FF66CC',
    130: '#FF6688', 140: '#FF8855', 150: '#FFAA55',
  };

  // Converts an ACI number to a hex colour string by looking it up in the table.
  // Returns null for the special DXF values 0 ("by block") and 256 ("by layer"),
  // which don't represent actual colours.
  function aciToHex(value) {
    if (!value || value === 256 || value === 0) return null;
    return ACI[value] || ACI[Math.round(value / 10) * 10] || null;
  }

  // Accepts any colour string and returns it in consistent #rrggbb format.
  // Returns null if the input doesn't look like a valid hex colour, so callers
  // can safely fall through to another colour source.
  function normalizeHexColor(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
    if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed}`;
    return null;
  }

  // Cleans up an ACI value that dxf-parser may return as a string, float, or
  // negative number. Returns null for non-numeric input so downstream code
  // can distinguish "no colour set" from colour index 0.
  function normalizeAci(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const aci = Math.abs(Math.trunc(num));
    return aci || 0;
  }

  // Converts a 24-bit packed RGB integer (DXF group code 420 true colour) into
  // a #rrggbb hex string so it can be used alongside ACI-derived colours.
  function trueColorToHex(value) {
    if (!Number.isFinite(value)) return null;
    const n = value >>> 0;
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `#${[r, g, b].map(part => part.toString(16).padStart(2, '0')).join('')}`;
  }

  global.NestDxfColor = {
    ACI,
    aciToHex,
    normalizeHexColor,
    normalizeAci,
    trueColorToHex,
  };
})(window);
