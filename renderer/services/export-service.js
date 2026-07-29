'use strict';

(function defineExportService(globalScope) {
  function createExportService({ state, dom }) {
    const { formatWidthMeters } = globalScope.NestHelpers;
    let exportFolderPath = null;
    let exportFolderBookmark = null;

    const PRINT_ICON = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 6V2.75C4 2.34 4.34 2 4.75 2h6.5c.41 0 .75.34.75.75V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4.75 10H3.5A1.5 1.5 0 012 8.5v-1A1.5 1.5 0 013.5 6h9A1.5 1.5 0 0114 7.5v1a1.5 1.5 0 01-1.5 1.5h-1.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4.75 9.5h6.5V13a1 1 0 01-1 1h-4.5a1 1 0 01-1-1V9.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <circle cx="11.5" cy="7.9" r=".7" fill="currentColor"/>
      </svg>
    `;

    const DOWNLOAD_ICON = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2v7.25M5.25 6.5L8 9.25 10.75 6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 11.5V13a1 1 0 001 1h8a1 1 0 001-1v-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    function setActionButtonLabel(button, label, iconMarkup) {
      if (!button) return;
      button.innerHTML = `${iconMarkup}<span>${label}</span>`;
    }

    // Returns true only when there's a completed (non-preview) solver result.
    // Used to gate the Print and Export actions so partial/preview runs can't be used.
    function canExportFinalSheets() {
      return !!(state.nestResult?.strips?.length && !state.nestResult?.is_preview);
    }

    // Returns the effective export width for a strip, preferring the user-configured
    // fixed width over the solver's strip_width when the sheet is in fixed-width mode.
    function exportSheetWidthForStrip(strip, sheet) {
      if (sheet?.widthMode === 'fixed') {
        const configuredWidth = Number(sheet?.width);
        if (Number.isFinite(configuredWidth) && configuredWidth > 0) return configuredWidth;
      }
      return Number(strip?.strip_width) || 0;
    }

    // Recalculates density against the fixed target area so utilisation bars in the
    // export modal are accurate even when the sheet is in fixed-width mode.
    function exportSheetDensityForStrip(strip, sheet) {
      const rawDensity = Number(strip?.density);
      if (!Number.isFinite(rawDensity)) return 0;

      const rawWidth = Number(strip?.strip_width);
      const rawHeight = Number(strip?.strip_height) || Number(sheet?.height);
      const targetWidth = exportSheetWidthForStrip(strip, sheet);

      if (!Number.isFinite(rawWidth) || rawWidth <= 0 || !Number.isFinite(rawHeight) || rawHeight <= 0) {
        return rawDensity;
      }
      if (sheet?.widthMode !== 'fixed') return rawDensity;

      const usedArea = rawDensity * rawWidth * rawHeight;
      const fixedArea = targetWidth * rawHeight;
      if (!Number.isFinite(fixedArea) || fixedArea <= 0) return rawDensity;
      return usedArea / fixedArea;
    }

    // Rounds a millimetre dimension up to the nearest integer, matching the display
    // convention where e.g. 2660.1 mm is shown as 2661 mm.
    function roundUpDim(mm) {
      return Math.ceil(mm);
    }

    // Maps a utilisation percentage to a CSS modifier class used to colour the
    // progress bar: empty string = good (≥75%), 'warn' = medium, 'low' = poor.
    function utilClass(pct) {
      if (pct >= 75) return '';
      if (pct >= 50) return 'warn';
      return 'low';
    }

    // Trims a long filesystem path down to the last two segments so it fits
    // in the folder label without overflowing the modal layout.
    function shortPath(fullPath) {
      const parts = (fullPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    }

    function refreshActionButtons() {
      const canPrint = canExportFinalSheets();
      const canExport = canPrint && !!exportFolderPath;

      if (dom.printReportBtn) {
        dom.printReportBtn.disabled = !canPrint;
        dom.printReportBtn.classList.remove('btn-success');
        setActionButtonLabel(dom.printReportBtn, 'Print', PRINT_ICON);
      }

      if (dom.exportSheetsBtn) {
        dom.exportSheetsBtn.disabled = !canExport;
        dom.exportSheetsBtn.classList.remove('btn-success');
        setActionButtonLabel(dom.exportSheetsBtn, 'Export', DOWNLOAD_ICON);
      }
    }

    // Stores the chosen folder path, updates the label, resets any success/error colour,
    // and enables the Export button so the user can immediately trigger the export.
    function applyExportFolder(folderPath, bookmark = null) {
      exportFolderPath = folderPath;
      exportFolderBookmark = bookmark || null;
      dom.exportFolderLabel.textContent = shortPath(folderPath);
      dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
      refreshActionButtons();
    }

    function normalizeStoredExportFolder(saved) {
      if (!saved) return null;
      if (typeof saved === 'string') {
        return saved.trim() ? { path: saved, bookmark: null } : null;
      }
      if (typeof saved?.path === 'string' && saved.path.trim()) {
        return {
          path: saved.path,
          bookmark: typeof saved?.bookmark === 'string' && saved.bookmark.trim()
            ? saved.bookmark
            : null,
        };
      }
      return null;
    }

    // On startup, reads __lastExportFolder from the app settings file and restores it
    // so the previous export destination is pre-filled without user action.
    async function loadLastExportFolder() {
      if (!window.electronAPI?.loadAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      const saved = normalizeStoredExportFolder(result?.settings?.__lastExportFolder);
      if (saved) {
        applyExportFolder(saved.path, saved.bookmark);
      } else {
        refreshActionButtons();
      }
    }

    // Persists the chosen folder path into app settings so it survives app restarts.
    async function saveLastExportFolder(folderPath) {
      if (!window.electronAPI?.loadAppSettings || !window.electronAPI?.saveAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      const settings = {
        ...(result?.settings || {}),
        __lastExportFolder: {
          path: folderPath,
          bookmark: exportFolderBookmark || null,
        },
      };
      await window.electronAPI.saveAppSettings(settings);
    }

    // Opens the native folder-picker dialog via Electron, then applies and persists the
    // chosen path if the user didn't cancel.
    async function chooseExportFolder() {
      if (!window.electronAPI?.chooseExportFolder) return null;
      const result = await window.electronAPI.chooseExportFolder();
      if (result?.path) {
        applyExportFolder(result.path, result.bookmark || null);
        await saveLastExportFolder(result.path);
        return result.path;
      }
      return null;
    }

    function buildExportStrips() {
      const sheet = state.sheets[0] || {};
      return (state.nestResult?.strips || []).map(strip => ({
        index: strip.index,
        json_path: strip.json_path,
        strip_width: strip.strip_width,
        strip_height: sheet.height || 0,
        sheet_width: exportSheetWidthForStrip(strip, sheet),
        sheet_width_mode: sheet.widthMode || 'fixed',
        density: strip.density,
        item_count: strip.item_count,
        material: sheet.material || '',
      }));
    }

    // Fills the export modal's summary bar and per-sheet table rows with live data
    // from the current solver result, including corrected widths and densities.
    function populateExportModal() {
      const strips = state.nestResult?.strips || [];
      const sheet = state.sheets[0] || {};
      const isPreview = !!state.nestResult?.is_preview;

      dom.exportSummarySheets.textContent = strips.length;
      const totalParts = strips.reduce((s, t) => s + (t.item_count || 0), 0);
      dom.exportSummaryParts.textContent = totalParts;
      const densities = strips
        .map(strip => exportSheetDensityForStrip(strip, sheet))
        .filter(value => Number.isFinite(value) && value > 0);
      const avgUtil = densities.length
        ? densities.reduce((sum, value) => sum + value, 0) / densities.length
        : null;
      dom.exportSummaryUtil.textContent = Number.isFinite(avgUtil)
        ? `${(avgUtil * 100).toFixed(1)}%`
        : '—';
      const totalMm = strips.reduce((sum, strip) => sum + exportSheetWidthForStrip(strip, sheet), 0);
      dom.exportSummaryLength.textContent = `${(totalMm / 1000).toFixed(2)} m`;
      dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
      if (isPreview) {
        dom.exportFolderLabel.textContent = 'Waiting for final Sparrow result before export';
      }

      dom.exportTableBody.innerHTML = '';
      strips.forEach((strip, i) => {
        const w = roundUpDim(exportSheetWidthForStrip(strip, sheet));
        const h = roundUpDim(sheet.height || 0);
        const density = exportSheetDensityForStrip(strip, sheet);
        const pct = Number.isFinite(density) && density > 0 ? density * 100 : null;
        const cls = Number.isFinite(pct) ? utilClass(pct) : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="export-sheet-num">${i + 1}</span></td>
          <td style="font-variant-numeric:tabular-nums">${h} × ${w}</td>
          <td style="color:var(--text-dim)">${sheet.material || '—'}</td>
          <td style="font-variant-numeric:tabular-nums">${strip.item_count || 0}</td>
          <td>
            <div class="export-util-bar-wrap">
              <div class="export-util-bar">
                <div class="export-util-fill ${cls}" style="width:${Number.isFinite(pct) ? Math.min(100, pct).toFixed(1) : 0}%"></div>
              </div>
              <span class="export-util-pct">${Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—'}</span>
            </div>
          </td>
          <td style="font-variant-numeric:tabular-nums;color:var(--text-dim)">${formatWidthMeters(exportSheetWidthForStrip(strip, sheet))}</td>`;
        dom.exportTableBody.appendChild(tr);
      });
    }

    // Guards against opening the modal when there's no result, then populates it,
    // restores the saved folder if available, and shows the modal.
    function openExportModal() {
      if (!state.nestResult?.strips?.length) return;
      populateExportModal();
      if (exportFolderPath && canExportFinalSheets()) {
        applyExportFolder(exportFolderPath, exportFolderBookmark);
      } else if (!state.nestResult?.is_preview) {
        dom.exportFolderLabel.textContent = 'No export folder selected';
        dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
        refreshActionButtons();
      } else {
        refreshActionButtons();
      }
      dom.exportModal.classList.add('open');
    }

    // Enables or disables the toolbar export icon based on whether the solver has
    // produced any strips — keeps the button in sync after each nesting run.
    function syncExportButton() {
      if (dom.openExportBtn) {
        dom.openExportBtn.disabled = !state.nestResult?.strips?.length;
      }
      refreshActionButtons();
    }

    // Wires all modal interactions: open/close/cancel/overlay-click, folder picker,
    // a print action that opens the native print flow for the sheet report, and the
    // main export action which writes the DXF files.
    function bind() {
      dom.openExportBtn?.addEventListener('click', openExportModal);
      dom.exportClose?.addEventListener('click', () => dom.exportModal.classList.remove('open'));
      dom.exportCancel?.addEventListener('click', () => dom.exportModal.classList.remove('open'));
      dom.exportModal?.addEventListener('click', e => { if (e.target === dom.exportModal) dom.exportModal.classList.remove('open'); });

      dom.exportChooseFolder?.addEventListener('click', async () => {
        await chooseExportFolder();
      });

      dom.printReportBtn?.addEventListener('click', async () => {
        if (!canExportFinalSheets()) return;
        if (!window.electronAPI?.printSheetsReport) return;
        dom.printReportBtn.disabled = true;
        setActionButtonLabel(dom.printReportBtn, 'Opening…', PRINT_ICON);
        dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
        try {
          const sheet = state.sheets[0] || {};
          const result = await window.electronAPI.printSheetsReport({
            jobName: state.nestResult.name || 'nesting-job',
            sheetMaterial: sheet.material || '',
            strips: buildExportStrips(),
          });

          if (result?.canceled) {
            refreshActionButtons();
            return;
          }
          if (!result?.success) throw new Error(result?.error || 'Print failed');

          dom.printReportBtn.classList.add('btn-success');
          setActionButtonLabel(dom.printReportBtn, 'Printed', PRINT_ICON);
          setTimeout(() => {
            refreshActionButtons();
          }, 2000);
        } catch (err) {
          console.error('[Print Report]', err);
          refreshActionButtons();
          dom.exportFolderLabel.textContent = `Error: ${err.message}`;
          dom.exportFolderLabel.classList.add('export-folder-error');
        }
      });

      dom.exportSheetsBtn?.addEventListener('click', async () => {
        if (!canExportFinalSheets()) return;
        if (!exportFolderPath) {
          const chosenFolder = await chooseExportFolder();
          if (!chosenFolder) return;
        }
        dom.exportSheetsBtn.disabled = true;
        setActionButtonLabel(dom.exportSheetsBtn, 'Exporting…', DOWNLOAD_ICON);
        dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
        try {
          const result = await window.electronAPI.exportSheetsDXF({
            outputDir: exportFolderPath,
            outputDirBookmark: exportFolderBookmark || null,
            jobName: state.nestResult.name || 'nesting-job',
            inputPath: state.nestInputPath || null,
            exportItems: state.lastPlacementExportItems || {},
            strips: buildExportStrips(),
          });
          if (!result?.success) throw new Error(result?.error || 'Export failed');

          dom.exportSheetsBtn.classList.add('btn-success');
          setActionButtonLabel(dom.exportSheetsBtn, 'Exported', DOWNLOAD_ICON);
          dom.exportFolderLabel.textContent = `${result.fileCount} file${result.fileCount !== 1 ? 's' : ''} saved to ${shortPath(result.outputDir)}`;
          dom.exportFolderLabel.classList.add('export-folder-success');

          setTimeout(() => {
            refreshActionButtons();
          }, 3000);
        } catch (err) {
          console.error('[Export DXF]', err);
          refreshActionButtons();
          dom.exportFolderLabel.textContent = `Error: ${err.message}`;
          dom.exportFolderLabel.classList.add('export-folder-error');
        }
      });
    }

    return {
      loadLastExportFolder,
      syncExportButton,
      bind,
    };
  }

  globalScope.NestExportService = { createExportService };
})(window);
