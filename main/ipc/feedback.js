'use strict';

/**
 * IPC handler for the onboarding opt-in submission.
 *
 * Routes a form payload from the renderer to a Netlify Forms endpoint. The
 * renderer calls this via `window.electronAPI.submitOnboarding(payload)`
 * — defined in `preload.js`.
 *
 * Only fires when the user has ticked at least one opt-in checkbox in the
 * onboarding dialog AND provided an email; see `onboarding-modal.js`'s
 * `finish()` for the gate. This file does not re-check — if we're called,
 * the user explicitly agreed.
 *
 * How Netlify Forms submission works for an Electron (not Netlify-hosted)
 * app:
 *   1. You deploy a Netlify site that has a static page containing a
 *      hidden `<form netlify>` with every field name this handler sends
 *      (otherwise Netlify's bot filter rejects unknown fields).
 *   2. From Electron, POST `application/x-www-form-urlencoded` to the
 *      Netlify site root (any URL on that site actually works, root is
 *      conventional). Netlify's forms endpoint intercepts the POST when
 *      `form-name` matches a registered form.
 *   3. Submissions show up in the Netlify dashboard under Forms, with
 *      email notifications you can wire up there.
 *
 * The form lives in kenzap-landing at src/pages/app-onboarding.astro. We
 * POST to that page (same pattern as the crash receiver) rather than "/",
 * so the site's catch-all SPA rewrite never gets involved.
 */

const { ipcMain, app } = require('electron');

const NETLIFY_URL = 'https://kenzap.com/app-onboarding/';

// `fetch` is global in modern Node (18+); Electron ships with it. We
// double-check at submit time to give a clear error on older runtimes.
function hasFetch() {
  return typeof fetch === 'function';
}

function registerFeedbackIpc() {
  ipcMain.handle('submit-onboarding', async (_event, payload = {}) => {
    try {
      if (!hasFetch()) {
        return { success: false, error: 'fetch unavailable in this runtime' };
      }

      // Flatten the payload into a URL-encoded body, adding the fields
      // Netlify needs (`form-name`) and the auto-populated ones that the
      // renderer doesn't know about (`platform`, `appVersion`,
      // `submittedAt`). `bot-field` stays empty — it's the honeypot
      // that Netlify's spam filter checks.
      const body = new URLSearchParams({
        'form-name': 'onboarding',
        'bot-field': '',
        materialType: String(payload.materialType || ''),
        mode: String(payload.mode || ''),
        lengthOptimization: String(payload.lengthOptimization || ''),
        sheetWidthMm: String(payload.sheetWidthMm ?? ''),
        sheetLengthMm: String(payload.sheetLengthMm ?? ''),
        partSpacingMm: String(payload.partSpacingMm ?? ''),
        units: String(payload.units || 'auto'),
        language: String(payload.language || ''),
        optInFeedback: String(payload.optInFeedback || 'no'),
        optInUpdates: String(payload.optInUpdates || 'no'),
        email: String(payload.email || '').trim(),
        platform: String(process.platform || ''),
        appVersion: String(app?.getVersion?.() || ''),
        submittedAt: new Date().toISOString(),
      }).toString();

      // Short timeout — the onboarding modal doesn't wait for this to
      // close, but we still don't want hanging TCP sockets if the user
      // closes the app. AbortController is standard in Node 18+.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(NETLIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          return { success: false, error: `HTTP ${res.status}` };
        }
        return { success: true };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}

module.exports = {
  registerFeedbackIpc,
};
