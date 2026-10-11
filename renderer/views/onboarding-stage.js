'use strict';

/**
 * Live sheet preview for onboarding step 3.
 *
 * Draws into the static <svg> from index.html (#onboardingStage) using the
 * values the user is editing: sheet aspect ratio, part spacing (drawn as
 * the gap between parts), mode, and the length-optimization switch.
 *
 *   predefined         sheet at its real aspect ratio, parts pack in from
 *                      the left, unused length is hatched as waste
 *   predefined + opt   the sheet edge slides in to hug the parts, the
 *                      original length stays as a dashed ghost
 *   unlimited          a strip that keeps growing: a glowing head advances,
 *                      parts pop in behind it and the camera follows
 *
 * The scene is rebuilt as one SVG string per frame. With a few dozen nodes
 * that is cheaper and much simpler than diffing, and the rAF loop goes idle
 * as soon as every tween has settled (Unlimited keeps running while visible).
 */
(function defineOnboardingStage(globalScope) {
  const VB_W = 600;
  const X0 = 64;
  const Y0 = 16;
  const AW = 600 - X0 - 28;
  const AH = 236 - Y0 - 50;
  const STRIP_H = 118;
  const UNL_SPEED = 0.55;          // strip heights per second
  const UNL_PREROLL = 1.1;         // strip heights already packed on entry
  const UNL_HEAD_AT = 0.6;         // camera keeps the head at this share of AW
  const FILL = 0.7;                // share of the predefined sheet the demo job uses
  const POP_MS = 420;
  const SHAPES = ['rect', 'plate', 'obround', 'L', 'trap', 'notch', 'rect', 'plate', 'L'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Deterministic per index, so typing a new length never reshuffles parts.
  const columnCache = [];
  function column(i) {
    if (columnCache[i]) return columnCache[i];
    const r = mulberry32(1013 + i * 7919);
    const cw = 0.11 + r() * 0.17;
    const roll = r();
    const k = roll < 0.12 ? 1 : roll < 0.45 ? 2 : roll < 0.85 ? 3 : 4;
    const weights = Array.from({ length: k }, () => 0.55 + r());
    const sum = weights.reduce((a, b) => a + b, 0);
    const items = weights.map(w => ({
      frac: w / sum,
      wf: 0.72 + r() * 0.28,
      shape: SHAPES[Math.floor(r() * SHAPES.length)],
      tone: Math.floor(r() * 3),
    }));
    columnCache[i] = { cw, items };
    return columnCache[i];
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  function easeOutBack(t) {
    const c1 = 1.55;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n1 = (v) => Math.round(v * 10) / 10;

  function shapePath(shape, x, y, w, h) {
    const m = Math.min(w, h);
    const r = Math.max(1, m * 0.09);
    const rr = (rx, ry, rw, rh, rad) =>
      `M${n1(rx + rad)} ${n1(ry)}H${n1(rx + rw - rad)}Q${n1(rx + rw)} ${n1(ry)} ${n1(rx + rw)} ${n1(ry + rad)}`
      + `V${n1(ry + rh - rad)}Q${n1(rx + rw)} ${n1(ry + rh)} ${n1(rx + rw - rad)} ${n1(ry + rh)}`
      + `H${n1(rx + rad)}Q${n1(rx)} ${n1(ry + rh)} ${n1(rx)} ${n1(ry + rh - rad)}`
      + `V${n1(ry + rad)}Q${n1(rx)} ${n1(ry)} ${n1(rx + rad)} ${n1(ry)}Z`;
    const circle = (cx, cy, cr) =>
      `M${n1(cx - cr)} ${n1(cy)}a${n1(cr)} ${n1(cr)} 0 1 0 ${n1(cr * 2)} 0a${n1(cr)} ${n1(cr)} 0 1 0 ${n1(-cr * 2)} 0Z`;
    switch (shape) {
      case 'plate':
        return rr(x, y, w, h, r) + circle(x + w / 2, y + h / 2, m * 0.2);
      case 'obround':
        return rr(x, y, w, h, m / 2);
      case 'L': {
        const lw = w * 0.48;
        const lh = h * 0.46;
        return `M${n1(x)} ${n1(y)}H${n1(x + lw)}V${n1(y + h - lh)}H${n1(x + w)}V${n1(y + h)}H${n1(x)}Z`;
      }
      case 'trap':
        return `M${n1(x)} ${n1(y)}H${n1(x + w * 0.62)}L${n1(x + w)} ${n1(y + h)}H${n1(x)}Z`;
      case 'notch': {
        const nr = Math.min(w * 0.22, h * 0.3);
        const cx = x + w / 2;
        return `M${n1(x)} ${n1(y)}H${n1(cx - nr)}A${n1(nr)} ${n1(nr)} 0 0 0 ${n1(cx + nr)} ${n1(y)}`
          + `H${n1(x + w)}V${n1(y + h)}H${n1(x)}Z`;
      }
      default:
        return rr(x, y, w, h, r);
    }
  }

  // Approximate label width in viewBox units (11px semibold, tabular).
  const labelGap = (label) => String(label).length * 6.4 + 12;

  // CAD-style dimension: the line breaks around the label instead of
  // running through it. If the span is too short for the label, the line
  // is drawn whole and the label sits outside it.
  function dimH(x1, x2, y, label) {
    if (x2 - x1 < 6) return '';
    const mid = (x1 + x2) / 2;
    const half = labelGap(label) / 2;
    const fits = x2 - x1 > half * 2 + 24;
    const line = fits
      ? `M${n1(x1)} ${n1(y)}H${n1(mid - half)}M${n1(mid + half)} ${n1(y)}H${n1(x2)}`
      : `M${n1(x1)} ${n1(y)}H${n1(x2)}`;
    return `<g class="ob-dim">`
      + `<path d="M${n1(x1)} ${n1(y - 5)}V${n1(y + 5)}M${n1(x2)} ${n1(y - 5)}V${n1(y + 5)}${line}"/>`
      + `<path class="ob-dim-arrow" d="M${n1(x1 + 6)} ${n1(y - 3)}L${n1(x1)} ${n1(y)}L${n1(x1 + 6)} ${n1(y + 3)}M${n1(x2 - 6)} ${n1(y - 3)}L${n1(x2)} ${n1(y)}L${n1(x2 - 6)} ${n1(y + 3)}"/>`
      + `<text x="${n1(mid)}" y="${n1(fits ? y + 4 : y + 17)}" text-anchor="middle">${esc(label)}</text></g>`;
  }

  function dimV(x, y1, y2, label) {
    if (y2 - y1 < 6) return '';
    const mid = (y1 + y2) / 2;
    const half = labelGap(label) / 2;
    const fits = y2 - y1 > half * 2 + 24;
    const line = fits
      ? `M${n1(x)} ${n1(y1)}V${n1(mid - half)}M${n1(x)} ${n1(mid + half)}V${n1(y2)}`
      : `M${n1(x)} ${n1(y1)}V${n1(y2)}`;
    const tx = fits ? x : x - 12;
    return `<g class="ob-dim">`
      + `<path d="M${n1(x - 5)} ${n1(y1)}H${n1(x + 5)}M${n1(x - 5)} ${n1(y2)}H${n1(x + 5)}${line}"/>`
      + `<path class="ob-dim-arrow" d="M${n1(x - 3)} ${n1(y1 + 6)}L${n1(x)} ${n1(y1)}L${n1(x + 3)} ${n1(y1 + 6)}M${n1(x - 3)} ${n1(y2 - 6)}L${n1(x)} ${n1(y2)}L${n1(x + 3)} ${n1(y2 - 6)}"/>`
      + `<text transform="rotate(-90 ${n1(tx)} ${n1(mid)})" x="${n1(tx)}" y="${n1(mid + 4)}" text-anchor="middle">${esc(label)}</text></g>`;
  }

  // Lays columns out from `startX` (px) with unit `H` (px) and gap `g`
  // (fraction of H). Calls `emit` per part; stops when `accept` says no.
  function packColumns(startX, y, H, g, accept, emit) {
    let x = startX + g * H;
    let last = startX;
    for (let i = 0; i < 400; i++) {
      const col = column(i);
      const cwPx = col.cw * H;
      if (!accept(i, x, x + cwPx)) break;
      const avail = H * (1 - g * (col.items.length + 1));
      let cy = y + g * H;
      col.items.forEach((item, j) => {
        const h = item.frac * avail;
        emit(i, j, item, x, cy, cwPx * item.wf, h);
        cy += h + g * H;
      });
      last = x + cwPx;
      x = last + g * H;
    }
    return last;
  }

  function create({ scene, badge, badgeText, t }) {
    const reduceMotion = globalScope.matchMedia
      ? globalScope.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };

    const target = { mode: 'predefined', opt: false, length: 2500, width: 1250, spacing: 3 };
    const cur = { logL: Math.log(2500), logW: Math.log(1250), gap: 0.03, trim: 0, blend: 0 };
    const appear = new Map();
    let fmt = (mm) => `${Math.round(mm)} mm`;
    let active = false;
    let raf = 0;
    let lastT = 0;
    let unlStart = 0;
    let lastSavedPct = 0;

    const gapFor = (spacing) => 0.012 + Math.min(0.05, Math.max(0, spacing) * 0.006);

    function popScale(key, now, delay = 0) {
      if (reduceMotion.matches) return 1;
      if (!appear.has(key)) appear.set(key, now + delay);
      const p = clamp((now - appear.get(key)) / POP_MS, 0, 1);
      return p;
    }

    function partSvg(item, x, y, w, h, p, extraCls = '') {
      if (p <= 0) return '';
      const s = 0.55 + 0.45 * easeOutBack(p);
      const cx = x + w / 2;
      const cy = y + h / 2;
      const flash = p < 1 ? ' ob-part-new' : '';
      return `<path class="ob-part ob-tone-${item.tone}${flash}${extraCls}" fill-rule="evenodd" opacity="${n1(Math.min(1, p * 1.6))}"`
        + ` transform="translate(${n1(cx)} ${n1(cy)}) scale(${s.toFixed(3)}) translate(${n1(-cx)} ${n1(-cy)})"`
        + ` d="${shapePath(item.shape, x, y, w, h)}"/>`;
    }

    function renderPredefined(now, alpha, dy) {
      const L = Math.exp(cur.logL);
      const W = Math.exp(cur.logW);
      const ratio = clamp(L / W, 0.35, 12);
      let lenPx;
      let hPx;
      if (ratio > AW / AH) {
        lenPx = AW;
        hPx = AW / ratio;
      } else {
        hPx = AH;
        lenPx = AH * ratio;
      }
      hPx = Math.max(hPx, 34);
      // Centred on the full length, so trimming visibly pulls the right
      // edge in while the left edge stays put.
      const x = X0 + (AW - lenPx) / 2;
      const y = Y0 + (AH - hPx) / 2 + dy;
      const g = cur.gap;

      let parts = '';
      let pending = false;
      const fillEnd = x + lenPx * FILL;
      const lastRight = packColumns(x, y, hPx, g,
        (i, cx0, cx1) => cx1 <= fillEnd || (i === 0 && cx1 <= x + lenPx - g * hPx),
        (i, j, item, px, py, pw, ph) => {
          const p = popScale(`p:${i}:${j}`, now, i * 55 + j * 35);
          if (p < 1) pending = true;
          parts += partSvg(item, px, py, pw, ph, p);
        });
      const partsEnd = lastRight > x ? lastRight + g * hPx : x + lenPx * 0.25;
      const trimmedLen = clamp(partsEnd - x, 24, lenPx);
      const shownLen = lerp(lenPx, trimmedLen, cur.trim);
      const savedPct = Math.max(0, Math.round((1 - trimmedLen / lenPx) * 100));
      lastSavedPct = savedPct;

      const wasteW = x + lenPx - partsEnd;
      const wasteAlpha = (1 - cur.trim);
      let out = `<g opacity="${alpha.toFixed(3)}">`;
      out += `<rect class="ob-ghost" x="${n1(x)}" y="${n1(y)}" width="${n1(lenPx)}" height="${n1(hPx)}" rx="3" opacity="${(cur.trim * 0.9).toFixed(3)}"/>`;
      out += `<rect class="ob-sheet" x="${n1(x)}" y="${n1(y)}" width="${n1(shownLen)}" height="${n1(hPx)}" rx="3"/>`;
      if (wasteW > 4 && wasteAlpha > 0.02) {
        out += `<g opacity="${wasteAlpha.toFixed(3)}">`
          + `<rect class="ob-waste" x="${n1(partsEnd)}" y="${n1(y + 1)}" width="${n1(Math.max(0, wasteW - 1))}" height="${n1(hPx - 2)}"/>`;
        if (wasteW > 64 && hPx > 30) {
          out += `<text class="ob-waste-label" x="${n1(partsEnd + wasteW / 2)}" y="${n1(y + hPx / 2 + 4)}" text-anchor="middle">${esc(t('onboarding.unused', 'unused'))}</text>`;
        }
        out += `</g>`;
      }
      out += parts;
      // The sheet's right edge gets an accent "blade" while it is moving.
      const moving = Math.abs(cur.trim - (target.opt ? 1 : 0)) > 0.01;
      if (moving && cur.trim > 0.01) {
        out += `<line class="ob-trim-edge" x1="${n1(x + shownLen)}" y1="${n1(y - 6)}" x2="${n1(x + shownLen)}" y2="${n1(y + hPx + 6)}"/>`;
      }
      out += dimV(x - 24, y, y + hPx, fmt(W));
      const lenLabel = cur.trim > 0.02 ? fmt(L * shownLen / lenPx, { approx: true }) : fmt(L);
      out += dimH(x, x + shownLen, y + hPx + 24, lenLabel);
      out += `</g>`;
      return { svg: out, pending };
    }

    function renderUnlimited(now, alpha, dy) {
      const W = Math.exp(cur.logW);
      const H = STRIP_H;
      const y = Y0 + (AH - H) / 2 + dy;
      const g = cur.gap;
      const elapsed = reduceMotion.matches ? 4.5 : Math.max(0, (now - unlStart) / 1000);
      const headU = UNL_PREROLL + elapsed * UNL_SPEED;
      const camU = Math.max(0, headU - (AW * UNL_HEAD_AT) / H);
      const startX = X0 - camU * H;
      const headX = startX + headU * H;

      let parts = '';
      packColumns(startX, y, H, g,
        (i, cx0) => cx0 <= headX && cx0 < VB_W + 40,
        (i, j, item, px, py, pw, ph) => {
          if (px + pw < -20) return;
          // Age measured from when the head passed this column.
          const crossedU = (px - startX) / H;
          const ageMs = reduceMotion.matches ? POP_MS : ((headU - crossedU) / UNL_SPEED) * 1000 - j * 70;
          const p = clamp(ageMs / POP_MS, 0, 1);
          parts += partSvg(item, px, py, pw, ph, p);
        });

      let out = `<g opacity="${alpha.toFixed(3)}">`;
      out += `<g mask="url(#obStripMask)">`;
      const fillFrom = Math.max(startX, -10);
      out += `<rect class="ob-strip" x="${n1(fillFrom)}" y="${n1(y)}" width="${n1(Math.max(0, headX - fillFrom + 4))}" height="${H}"/>`;
      out += `<path class="ob-strip-edge" d="M${n1(fillFrom)} ${n1(y)}H${n1(headX)}M${n1(fillFrom)} ${n1(y + H)}H${n1(headX)}"/>`;
      out += `<path class="ob-strip-future" d="M${n1(headX)} ${n1(y)}H${VB_W}M${n1(headX)} ${n1(y + H)}H${VB_W}"/>`;
      if (startX > -4) {
        out += `<line class="ob-strip-edge" x1="${n1(startX)}" y1="${n1(y)}" x2="${n1(startX)}" y2="${n1(y + H)}"/>`;
      }
      out += parts;
      out += `<ellipse class="ob-head-glow" cx="${n1(headX)}" cy="${n1(y + H / 2)}" rx="34" ry="${n1(H * 0.62)}" fill="url(#obHeadGlow)"/>`;
      out += `<line class="ob-head" x1="${n1(headX)}" y1="${n1(y - 7)}" x2="${n1(headX)}" y2="${n1(y + H + 7)}"/>`;
      const dimY = y + H + 24;
      const mid = X0 + AW * 0.5;
      const lineFrom = Math.max(startX, X0 - 30);
      out += `<g class="ob-dim"><path d="M${n1(lineFrom)} ${n1(dimY)}H${n1(mid - 15)}M${n1(mid + 15)} ${n1(dimY)}H${VB_W}`;
      if (startX > X0 - 30) out += `M${n1(startX)} ${n1(dimY - 5)}V${n1(dimY + 5)}`;
      out += `"/></g>`;
      out += `</g>`;
      out += `<g class="ob-dim"><text class="ob-dim-inf" x="${n1(mid)}" y="${n1(dimY + 5)}" text-anchor="middle">∞</text></g>`;
      out += dimV(X0 - 24, y, y + H, fmt(W));
      out += `</g>`;
      return out;
    }

    function step(dt) {
      const k = (rate) => (reduceMotion.matches ? 1 : 1 - Math.exp(-dt * rate));
      cur.logL += (Math.log(Math.max(1, target.length)) - cur.logL) * k(10);
      cur.logW += (Math.log(Math.max(1, target.width)) - cur.logW) * k(10);
      cur.gap += (gapFor(target.spacing) - cur.gap) * k(12);
      cur.trim += ((target.opt && target.mode === 'predefined' ? 1 : 0) - cur.trim) * k(7);
      cur.blend += ((target.mode === 'unlimited' ? 1 : 0) - cur.blend) * k(9);
    }

    function snapTo() {
      cur.logL = Math.log(Math.max(1, target.length));
      cur.logW = Math.log(Math.max(1, target.width));
      cur.gap = gapFor(target.spacing);
      cur.trim = target.opt && target.mode === 'predefined' ? 1 : 0;
      cur.blend = target.mode === 'unlimited' ? 1 : 0;
    }

    function settled() {
      return Math.abs(Math.log(Math.max(1, target.length)) - cur.logL) < 1e-3
        && Math.abs(Math.log(Math.max(1, target.width)) - cur.logW) < 1e-3
        && Math.abs(gapFor(target.spacing) - cur.gap) < 1e-4
        && Math.abs((target.opt && target.mode === 'predefined' ? 1 : 0) - cur.trim) < 1e-3
        && Math.abs((target.mode === 'unlimited' ? 1 : 0) - cur.blend) < 1e-3;
    }

    function frame(now) {
      raf = 0;
      const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
      lastT = now;
      step(dt);
      // Land exactly on the targets so labels read 2500, not 2499.1.
      if (settled()) snapTo();
      const b = cur.blend;
      let svg = '';
      let pending = false;
      if (b < 0.999) {
        const r = renderPredefined(now, 1 - b, b * 8);
        svg += r.svg;
        pending = r.pending;
      }
      if (b > 0.001) svg += renderUnlimited(now, b, (1 - b) * 8);
      scene.innerHTML = svg;
      updateBadge();

      const keepGoing = !settled() || pending || (target.mode === 'unlimited' && !reduceMotion.matches);
      if (active && keepGoing) raf = globalScope.requestAnimationFrame(frame);
      else lastT = 0;
    }

    function kick() {
      if (!active || raf) return;
      raf = globalScope.requestAnimationFrame(frame);
    }

    function updateBadge() {
      if (!badge) return;
      const show = target.mode === 'predefined' && target.opt && lastSavedPct > 0;
      badge.classList.toggle('show', show);
      if (show && badgeText) {
        const fallback = `${lastSavedPct}% shorter`;
        const txt = t('onboarding.lengthSaved', fallback, { pct: lastSavedPct });
        if (badgeText.textContent !== txt) badgeText.textContent = txt;
      }
    }

    return {
      update(next) {
        const modeChanged = next.mode && next.mode !== target.mode;
        Object.assign(target, next);
        if (modeChanged && target.mode === 'unlimited') unlStart = globalScope.performance.now();
        if (modeChanged && target.mode === 'predefined') appear.clear();
        kick();
      },
      setFormatter(fn) {
        fmt = fn;
        kick();
      },
      refreshTranslations() {
        updateBadge();
        kick();
      },
      // Re-run the pop-in sequence, e.g. every time step 3 is entered.
      replay() {
        appear.clear();
        unlStart = globalScope.performance.now();
        kick();
      },
      // Snap tweens to their targets so the first frame isn't a zoom-in.
      snap() {
        snapTo();
        kick();
      },
      start() {
        active = true;
        kick();
      },
      stop() {
        active = false;
        if (raf) globalScope.cancelAnimationFrame(raf);
        raf = 0;
        lastT = 0;
      },
    };
  }

  globalScope.NestOnboardingStage = { create };
})(typeof window !== 'undefined' ? window : globalThis);
