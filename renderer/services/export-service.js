'use strict';

(function defineExportService(globalScope) {
  function createExportService({ state, dom }) {
    const { formatWidthMeters } = globalScope.NestHelpers;
    let exportFolderPath = null;

    function exportSheetWidthForStrip(strip, sheet) {
      if (sheet?.widthMode === 'fixed') {
        const configuredWidth = Number(sheet?.width);
        if (Number.isFinite(configuredWidth) && configuredWidth > 0) return configuredWidth;
      }
      return Number(strip?.strip_width) || 0;
    }

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

    function roundUpDim(mm) {
      return Math.ceil(mm);
    }

    function utilClass(pct) {
      if (pct >= 75) return '';
      if (pct >= 50) return 'warn';
      return 'low';
    }

    function shortPath(fullPath) {
      const parts = (fullPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    }

    function applyExportFolder(folderPath) {
      exportFolderPath = folderPath;
      dom.exportFolderLabel.textContent = shortPath(folderPath);
      dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
      dom.exportDXFBtn.disabled = false;
      dom.exportDXFBtn.textContent = 'Export DXF';
    }

    async function loadLastExportFolder() {
      if (!window.electronAPI?.loadAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      const saved = result?.settings?.__lastExportFolder;
      if (saved) applyExportFolder(saved);
    }

    async function saveLastExportFolder(folderPath) {
      if (!window.electronAPI?.loadAppSettings || !window.electronAPI?.saveAppSettings) return;
      const result = await window.electronAPI.loadAppSettings();
      const settings = { ...(result?.settings || {}), __lastExportFolder: folderPath };
      await window.electronAPI.saveAppSettings(settings);
    }

    function populateExportModal() {
      const strips = state.nestResult?.strips || [];
      const sheet = state.sheets[0] || {};

      dom.exportSummarySheets.textContent = strips.length;
      const totalParts = strips.reduce((s, t) => s + (t.item_count || 0), 0);
      dom.exportSummaryParts.textContent = totalParts;
      const avgUtil = strips.length
        ? strips.reduce((sum, strip) => sum + exportSheetDensityForStrip(strip, sheet), 0) / strips.length
        : 0;
      dom.exportSummaryUtil.textContent = `${(avgUtil * 100).toFixed(1)}%`;
      const totalMm = strips.reduce((sum, strip) => sum + exportSheetWidthForStrip(strip, sheet), 0);
      dom.exportSummaryLength.textContent = `${(totalMm / 1000).toFixed(2)} m`;

      dom.exportTableBody.innerHTML = '';
      strips.forEach((strip, i) => {
        const w = roundUpDim(exportSheetWidthForStrip(strip, sheet));
        const h = roundUpDim(sheet.height || 0);
        const pct = exportSheetDensityForStrip(strip, sheet) * 100;
        const cls = utilClass(pct);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="export-sheet-num">${i + 1}</span></td>
          <td style="font-variant-numeric:tabular-nums">${h} × ${w}</td>
          <td style="color:var(--text-dim)">${sheet.material || '—'}</td>
          <td style="font-variant-numeric:tabular-nums">${strip.item_count || 0}</td>
          <td>
            <div class="export-util-bar-wrap">
              <div class="export-util-bar">
                <div class="export-util-fill ${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
              </div>
              <span class="export-util-pct">${pct.toFixed(1)}%</span>
            </div>
          </td>
          <td style="font-variant-numeric:tabular-nums;color:var(--text-dim)">${formatWidthMeters(exportSheetWidthForStrip(strip, sheet))}</td>`;
        dom.exportTableBody.appendChild(tr);
      });
    }

    function openExportModal() {
      if (!state.nestResult?.strips?.length) return;
      populateExportModal();
      if (exportFolderPath) {
        applyExportFolder(exportFolderPath);
      } else {
        dom.exportFolderLabel.textContent = 'No folder selected';
        dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
        dom.exportDXFBtn.disabled = true;
        dom.exportDXFBtn.textContent = 'Export DXF';
      }
      dom.exportModal.classList.add('open');
    }

    function syncExportButton() {
      if (dom.openExportBtn) {
        dom.openExportBtn.disabled = !state.nestResult?.strips?.length;
      }
    }

    function bind() {
      dom.openExportBtn?.addEventListener('click', openExportModal);
      dom.exportClose?.addEventListener('click', () => dom.exportModal.classList.remove('open'));
      dom.exportCancel?.addEventListener('click', () => dom.exportModal.classList.remove('open'));
      dom.exportModal?.addEventListener('click', e => { if (e.target === dom.exportModal) dom.exportModal.classList.remove('open'); });

      dom.exportChooseFolder?.addEventListener('click', async () => {
        if (!window.electronAPI?.chooseExportFolder) return;
        const result = await window.electronAPI.chooseExportFolder();
        if (result?.path) {
          applyExportFolder(result.path);
          saveLastExportFolder(result.path);
        }
      });

      dom.exportDXFBtn?.addEventListener('click', async () => {
        if (!exportFolderPath || !state.nestResult?.strips?.length) return;
        dom.exportDXFBtn.disabled = true;
        dom.exportDXFBtn.textContent = 'Exporting…';
        dom.exportFolderLabel.classList.remove('export-folder-success', 'export-folder-error');
        try {
          const sheet = state.sheets[0] || {};
          const strips = state.nestResult.strips.map(strip => ({
            index: strip.index,
            json_path: strip.json_path,
            strip_width: strip.strip_width,
            strip_height: sheet.height || 0,
            sheet_width: exportSheetWidthForStrip(strip, sheet),
            sheet_width_mode: sheet.widthMode || 'fixed',
            density: strip.density,
            item_count: strip.item_count,
          }));
          const result = await window.electronAPI.exportSheetsDXF({
            outputDir: exportFolderPath,
            jobName: state.nestResult.name || 'nesting-job',
            inputPath: state.nestInputPath || null,
            exportItems: state.lastPlacementExportItems || {},
            strips,
          });
          if (!result?.success) throw new Error(result?.error || 'Export failed');

          dom.exportDXFBtn.textContent = '✓ Exported';
          dom.exportDXFBtn.classList.add('btn-success');
          dom.exportFolderLabel.textContent = `${result.fileCount} file${result.fileCount !== 1 ? 's' : ''} saved to ${shortPath(result.outputDir)}`;
          dom.exportFolderLabel.classList.add('export-folder-success');

          setTimeout(() => {
            dom.exportDXFBtn.textContent = 'Export DXF';
            dom.exportDXFBtn.classList.remove('btn-success');
            dom.exportDXFBtn.disabled = false;
          }, 3000);
        } catch (err) {
          console.error('[Export DXF]', err);
          dom.exportDXFBtn.textContent = 'Export DXF';
          dom.exportDXFBtn.disabled = false;
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
