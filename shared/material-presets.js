'use strict';

/**
 * Material → default settings table used by the onboarding dialog.
 *
 * Each preset carries the three values the onboarding step 2 lets the user
 * confirm or edit, plus an SVG icon used in the material cards.
 *
 *   - `sheetWidth`  (mm) — rectangle long side, in instance units
 *   - `sheetHeight` (mm) — rectangle short side
 *   - `partSpacing` (mm) — min-item-separation. **Not** a true kerf setting:
 *                          with the current algorithm, items don't share
 *                          edges, so each boundary becomes a two-pass cut.
 *                          When kerf support lands, these values will need
 *                          to be re-tuned.
 *   - `icon`        (SVG) — inline SVG drawn only in `currentColor`, so the
 *                          card tints it to the theme and selection state.
 *
 * The two UI-facing lists (primary cards vs the "Other" expansion row) live
 * in `shared/settings.js` as `MATERIALS_PRIMARY` / `MATERIALS_OTHER`; this
 * file just owns the numbers + glyphs.
 */
(function defineMaterialPresets(globalScope) {
  // Icons: one family. Each material is a piece of sheet stock in the same
  // 3/4 view, two-tone (faces filled with currentColor at low opacity) plus
  // the one detail that identifies it. 32×32 viewBox, 1.5 stroke.
  const f = (n) => String(Math.round(n * 100) / 100);
  const pt = ([x, y]) => `${f(x)} ${f(y)}`;
  const A = [16, -7];   // long axis
  const B = [10, 4.5];  // short axis (towards the viewer)
  const iso = (o, u, v, down = 0) => [o[0] + A[0] * u + B[0] * v, o[1] + A[1] * u + B[1] * v + down];
  const poly = (pts) => `M${pts.map(pt).join('L')}Z`;
  const line = (a, b) => `M${pt(a)}L${pt(b)}`;
  const FACE = { top: 0.12, end: 0.34, front: 0.22 };
  const face = (d, op, extra = '') => `<path d="${d}" fill="currentColor" fill-opacity="${op}"${extra}/>`;
  const stroke = (d, extra = '') => `<path d="${d}"${extra}/>`;

  function slab(o, t, { top = FACE.top, end = FACE.end, front = FACE.front, attrs = '' } = {}) {
    return face(poly([iso(o, 0, 0), iso(o, 1, 0), iso(o, 1, 1), iso(o, 0, 1)]), top, attrs)
      + face(poly([iso(o, 0, 0), iso(o, 0, 1), iso(o, 0, 1, t), iso(o, 0, 0, t)]), end, attrs)
      + face(poly([iso(o, 0, 1), iso(o, 1, 1), iso(o, 1, 1, t), iso(o, 0, 1, t)]), front, attrs);
  }

  const SVG = (body) =>
    `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" `
    + `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${body}</svg>`;
  const thin = ' stroke-width="1.1"';

  const ICONS = {
    // Thin plate with a brushed-metal sheen.
    metal: (() => {
      const o = [3, 16.5];
      return SVG(slab(o, 2.6)
        + stroke(line(iso(o, 0.36, 0.16), iso(o, 0.22, 0.84)), thin)
        + stroke(line(iso(o, 0.5, 0.16), iso(o, 0.43, 0.5)), thin));
    })(),
    // Plank: long grain on top, growth rings on the sawn end.
    wood: (() => {
      const o = [3, 14];
      const t = 6;
      const wave = (v, amp) =>
        `M${pt(iso(o, 0.06, v))}C${pt(iso(o, 0.35, v - amp))} ${pt(iso(o, 0.6, v + amp))} ${pt(iso(o, 0.94, v))}`;
      const grain = wave(0.3, 0.1) + wave(0.55, 0.08) + wave(0.8, 0.1);
      const pith = iso(o, 0, 0.5, t);
      const rings = [2, 3.6].map(r =>
        `M${f(pith[0] - r)} ${f(pith[1] - r * 0.45)}A${r} ${r} 0 0 1 ${f(pith[0] + r)} ${f(pith[1] + r * 0.45)}`).join('');
      return SVG(slab(o, t)
        + stroke(grain, thin)
        + stroke(rings, ' stroke-width="1" opacity=".8"'));
    })(),
    // Clear acrylic: barely tinted faces, hidden back edges visible
    // through the sheet, and a glint.
    plastics: (() => {
      const o = [3, 17];
      const t = 3;
      const hidden = `M${pt(iso(o, 0, 0, t))}L${pt(iso(o, 1, 0, t))}L${pt(iso(o, 1, 1, t))}`;
      return SVG(slab(o, t, { top: 0.06, end: 0.14, front: 0.1 })
        + stroke(hidden, ' stroke-width="1" stroke-dasharray="1.4 1.8" opacity=".55"')
        + stroke(line(iso(o, 0.62, 0.12), iso(o, 0.82, 0.12)), thin)
        + '<path d="M25.5 2.5Q26 5 28.5 5.5Q26 6 25.5 8.5Q25 6 22.5 5.5Q25 5 25.5 2.5Z" fill="currentColor" stroke="none"/>');
    })(),
    // Hide silhouette with a stitched inset.
    leather: SVG(
      '<path d="M2.8 16C3.9 14.5 5.3 13.7 7.1 13.5C6.8 11.4 5.8 9.7 4.1 8.2C6.9 7.9 9.4 8.8 11.1 10.3C14.3 9.3 17.7 9.3 20.9 10.3C22.6 8.8 25.1 7.9 27.9 8.2C26.2 9.7 25.2 11.4 24.9 13.5C26.7 13.7 28.1 14.5 29.2 16C28.1 17.5 26.7 18.3 24.9 18.5C25.2 20.6 26.2 22.3 27.9 23.8C25.1 24.1 22.6 23.2 20.9 21.7C17.7 22.7 14.3 22.7 11.1 21.7C9.4 23.2 6.9 24.1 4.1 23.8C5.8 22.3 6.8 20.6 7.1 18.5C5.3 18.3 3.9 17.5 2.8 16Z" fill="currentColor" fill-opacity=".14"/>'
      + '<rect x="9.6" y="12.6" width="12.8" height="6.8" rx="3" stroke-width="1.1" stroke-dasharray="1.6 1.9"/>'
    ),
    // Thick block with open pores on its faces.
    foam: (() => {
      const o = [3, 12.5];
      const t = 8;
      const pores = [[0.14, 0.3], [0.36, 0.62], [0.58, 0.28], [0.8, 0.6], [0.26, 0.82], [0.7, 0.86]]
        .map(([s, h]) => {
          const c = iso(o, s, 1, h * t);
          return `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="0.95" stroke-width="1"/>`;
        }).join('');
      const top = [[0.3, 0.45], [0.62, 0.55]].map(([u, v]) => {
        const c = iso(o, u, v);
        return `<ellipse cx="${f(c[0])}" cy="${f(c[1])}" rx="1.1" ry="0.6" stroke-width="1"/>`;
      }).join('');
      return SVG(slab(o, t) + pores + top);
    })(),
    // Board whose cut edge shows the corrugated flute between two liners.
    cardboard: (() => {
      const o = [3, 15];
      const t = 5.5;
      const n = 6;
      let d = `M${pt(iso(o, 0, 1, 1.3))}`;
      for (let i = 0; i < n; i++) {
        const ctrl = iso(o, (i + 0.5) / n, 1, i % 2 ? 0.2 : t - 0.2);
        const end = iso(o, (i + 1) / n, 1, i % 2 === 0 ? 1.3 : t - 1.3);
        d += `Q${pt(ctrl)} ${pt(end)}`;
      }
      return SVG(slab(o, t) + stroke(d, thin));
    })(),
    // Laminate: visible plies on the edges, woven grid on top.
    composites: (() => {
      const o = [3, 15];
      const t = 5.4;
      let grid = '';
      [0.25, 0.5, 0.75].forEach(u => { grid += line(iso(o, u, 0), iso(o, u, 1)); });
      [0.34, 0.67].forEach(v => { grid += line(iso(o, 0, v), iso(o, 1, v)); });
      let plies = '';
      [t / 3, (2 * t) / 3].forEach(h => {
        plies += `M${pt(iso(o, 0, 0, h))}L${pt(iso(o, 0, 1, h))}L${pt(iso(o, 1, 1, h))}`;
      });
      return SVG(slab(o, t)
        + stroke(grid, ' stroke-width="1" opacity=".6"')
        + stroke(plies, ' stroke-width="1"'));
    })(),
    // Flange gasket lying flat: ring, thickness, bolt holes.
    rubber: (() => {
      const cx = 16;
      const cy = 14;
      const R = 13;
      const r = 6;
      const t = 3.2;
      const ring = `M${cx - R} ${cy}A${R} ${R / 2} 0 1 0 ${cx + R} ${cy}A${R} ${R / 2} 0 1 0 ${cx - R} ${cy}Z`
        + `M${cx - r} ${cy}A${r} ${r / 2} 0 1 1 ${cx + r} ${cy}A${r} ${r / 2} 0 1 1 ${cx - r} ${cy}Z`;
      const side = `M${cx - R} ${cy}L${cx - R} ${cy + t}A${R} ${R / 2} 0 0 0 ${cx + R} ${cy + t}L${cx + R} ${cy}A${R} ${R / 2} 0 0 1 ${cx - R} ${cy}Z`;
      const wallX = r * Math.sqrt(0.75);
      const wall = `M${f(cx - wallX)} ${f(cy + r / 4 + 0.3)}A${r} ${r / 2} 0 0 1 ${f(cx + wallX)} ${f(cy + r / 4 + 0.3)}`;
      const holes = [45, 135, 225, 315].map(a => {
        const rad = (a * Math.PI) / 180;
        const hx = cx + 9.5 * Math.cos(rad);
        const hy = cy + 4.75 * Math.sin(rad);
        return `<ellipse cx="${f(hx)}" cy="${f(hy)}" rx="1.25" ry="0.65" stroke-width="1"/>`;
      }).join('');
      return SVG(`<path d="${side}" fill="currentColor" fill-opacity="${FACE.front}"/>`
        + `<path d="${ring}" fill="currentColor" fill-opacity="${FACE.top}" fill-rule="evenodd"/>`
        + stroke(wall, thin) + holes);
    })(),
    // Fabric roll with a length of cloth unrolled towards the viewer.
    textile: (() => {
      const dx = 14;
      const dy = -6;
      const len = Math.hypot(dx, dy);
      const n = [-dy / len, dx / len];
      const r = 3.6;
      const R0 = [7.5, 11.5];
      const R1 = [R0[0] + dx, R0[1] + dy];
      const top0 = [R0[0] - n[0] * r, R0[1] - n[1] * r];
      const top1 = [R1[0] - n[0] * r, R1[1] - n[1] * r];
      const bot0 = [R0[0] + n[0] * r, R0[1] + n[1] * r];
      const bot1 = [R1[0] + n[0] * r, R1[1] + n[1] * r];
      const S = [8, 9];
      const front0 = [bot0[0] + S[0], bot0[1] + S[1]];
      const front1 = [bot1[0] + S[0], bot1[1] + S[1]];
      const cloth = poly([bot0, bot1, front1, front0]);
      const body = `M${pt(top0)}L${pt(top1)}A${r} ${r} 0 0 1 ${pt(bot1)}L${pt(bot0)}`;
      let weave = '';
      [0.36, 0.7].forEach(k => {
        const a = [bot0[0] + S[0] * k, bot0[1] + S[1] * k];
        const b = [bot1[0] + S[0] * k, bot1[1] + S[1] * k];
        weave += line(a, b);
      });
      return SVG(face(cloth, FACE.top)
        + stroke(weave, ' stroke-width="1" stroke-dasharray="1.6 1.6" opacity=".7"')
        + face(body, FACE.front)
        + `<circle cx="${f(R0[0])}" cy="${f(R0[1])}" r="${r}" fill="currentColor" fill-opacity="${FACE.end}"/>`
        + `<circle cx="${f(R0[0])}" cy="${f(R0[1])}" r="1.3" stroke-width="1.1"/>`);
    })(),
    // Ream of sheets with a dog-eared top sheet and ruled lines.
    paper: (() => {
      const o = [3, 13.5];
      let under = '';
      [2.2, 4.4].forEach(h => {
        under += `M${pt(iso(o, 0, 0, h))}L${pt(iso(o, 0, 1, h))}L${pt(iso(o, 1, 1, h))}L${pt(iso(o, 1, 0.98, h))}`;
      });
      const top = poly([iso(o, 0, 0), iso(o, 1, 0), iso(o, 1, 0.66), iso(o, 0.8, 1), iso(o, 0, 1)]);
      const ear = poly([iso(o, 1, 0.66), iso(o, 0.8, 1), iso(o, 0.78, 0.62)]);
      const ruled = line(iso(o, 0.16, 0.36), iso(o, 0.66, 0.36)) + line(iso(o, 0.16, 0.6), iso(o, 0.5, 0.6));
      return SVG(stroke(under, ' fill="currentColor" fill-opacity=".16"')
        + face(top, FACE.top) + face(ear, FACE.end) + stroke(ruled, thin));
    })(),
    // "Any other sheet": dashed outline with a plus on top.
    other: (() => {
      const o = [3, 16.5];
      const t = 3;
      const outline = poly([iso(o, 0, 0), iso(o, 1, 0), iso(o, 1, 1), iso(o, 0, 1)])
        + `M${pt(iso(o, 0, 0))}L${pt(iso(o, 0, 0, t))}L${pt(iso(o, 0, 1, t))}L${pt(iso(o, 1, 1, t))}L${pt(iso(o, 1, 1))}M${pt(iso(o, 0, 1))}L${pt(iso(o, 0, 1, t))}`;
      const c = iso(o, 0.5, 0.5);
      return SVG(stroke(outline, ' stroke-dasharray="2 2" opacity=".7"')
        + stroke(`M${f(c[0] - 2.6)} ${f(c[1])}H${f(c[0] + 2.6)}M${f(c[0])} ${f(c[1] - 2.6)}V${f(c[1] + 2.6)}`));
    })(),
  };

  const MATERIAL_PRESETS = {
    metal:      { icon: ICONS.metal,      sheetWidth: 2500, sheetHeight: 1250, partSpacing: 3 },
    wood:       { icon: ICONS.wood,       sheetWidth: 2440, sheetHeight: 1220, partSpacing: 5 },
    plastics:   { icon: ICONS.plastics,   sheetWidth: 3050, sheetHeight: 2050, partSpacing: 8 },
    leather:    { icon: ICONS.leather,    sheetWidth: 1500, sheetHeight: 1200, partSpacing: 4 },
    foam:       { icon: ICONS.foam,       sheetWidth: 2000, sheetHeight: 1000, partSpacing: 5 },
    cardboard:  { icon: ICONS.cardboard,  sheetWidth: 2000, sheetHeight: 1000, partSpacing: 2 },
    composites: { icon: ICONS.composites, sheetWidth: 1500, sheetHeight: 1000, partSpacing: 4 },
    rubber:     { icon: ICONS.rubber,     sheetWidth: 1500, sheetHeight: 1000, partSpacing: 3 },
    textile:    { icon: ICONS.textile,    sheetWidth: 1500, sheetHeight: 1200, partSpacing: 2 },
    paper:      { icon: ICONS.paper,      sheetWidth: 1000, sheetHeight: 700,  partSpacing: 1 },
  };

  // Exposed so the modal's "Other" card can grab the plus glyph without
  // reaching into private module state.
  const EXTRA_ICONS = {
    other: ICONS.other,
  };

  /**
   * Returns the preset for a given material key. Falls back to a safe
   * universal default when the key is unknown or empty — avoids the caller
   * having to guard every single preset access.
   */
  function getMaterialPreset(material) {
    const key = String(material || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MATERIAL_PRESETS, key)) {
      return MATERIAL_PRESETS[key];
    }
    return {
      icon: ICONS.other,
      sheetWidth: 2000,
      sheetHeight: 1000,
      partSpacing: 3,
    };
  }

  const api = {
    MATERIAL_PRESETS,
    EXTRA_ICONS,
    getMaterialPreset,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalScope.NestMaterialPresets = api;
})(typeof window !== 'undefined' ? window : globalThis);
