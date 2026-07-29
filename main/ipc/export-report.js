'use strict';

const { BrowserWindow, ipcMain } = require('electron');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function roundUpDim(mm) {
  const numeric = Number(mm);
  return Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : 0;
}

function formatUtilization(density) {
  const numeric = Number(density);
  return Number.isFinite(numeric) && numeric > 0
    ? `${(numeric * 100).toFixed(1)}%`
    : '—';
}

function formatMeters(mm) {
  const numeric = Number(mm);
  return Number.isFinite(numeric) && numeric > 0
    ? `${(numeric / 1000).toFixed(2)} m`
    : '—';
}

function formatDateTime(date = new Date()) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return String(date);
  }
}

function buildReportHtml({ jobName, strips, summary }) {
  const rows = strips.map((strip, index) => `
    <tr>
      <td class="num">${index + 1}</td>
      <td class="num">${strip.sheetWidth || '—'}</td>
      <td class="num">${strip.sheetLength || '—'}</td>
      <td class="num">${strip.parts}</td>
      <td>${escapeHtml(strip.material)}</td>
      <td class="num">${escapeHtml(formatUtilization(strip.density))}</td>
    </tr>
  `).join('');

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml('Nesting Sheet Report')}</title>
        <style>
          :root {
            color-scheme: light;
            --text: #1f2937;
            --muted: #64748b;
            --border: #dfe6ee;
            --accent: #2563eb;
            --surface: #f8fafc;
          }

          @page {
            size: A4 portrait;
            margin: 12mm;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--text);
            background: #ffffff;
          }

          .page {
            padding: 4mm 2mm 0;
          }

          .eyebrow {
            margin: 0 0 6px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--accent);
          }

          h1 {
            margin: 0 0 8px;
            font-size: 26px;
            line-height: 1.15;
          }

          .meta {
            display: flex;
            flex-wrap: wrap;
            gap: 8px 18px;
            margin-bottom: 18px;
            color: var(--muted);
            font-size: 12px;
          }

          .summary {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 20px;
          }

          .summary-card {
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 12px 14px;
            background: #ffffff;
          }

          .summary-card strong {
            display: block;
            margin-bottom: 4px;
            font-size: 20px;
            line-height: 1.2;
          }

          .summary-card span {
            font-size: 12px;
            color: var(--muted);
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
          }

          th,
          td {
            border: 1px solid var(--border);
            padding: 10px 12px;
            text-align: left;
            vertical-align: top;
          }

          th {
            background: var(--surface);
            font-weight: 600;
          }

          tbody tr:nth-child(even) {
            background: #fbfdff;
          }

          .num {
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
          }
        </style>
      </head>
      <body>
        <main class="page">
          <p class="eyebrow">Kenzap Nesting</p>
          <h1>${escapeHtml('Nesting Sheet Report')}</h1>
          <div class="meta">
            <div><strong>Job:</strong> ${escapeHtml(jobName || '—')}</div>
            <div><strong>Generated:</strong> ${escapeHtml(formatDateTime())}</div>
          </div>
          <div class="summary">
            <div class="summary-card">
              <strong>${summary.sheetCount}</strong>
              <span>Sheets</span>
            </div>
            <div class="summary-card">
              <strong>${summary.totalParts}</strong>
              <span>Parts</span>
            </div>
            <div class="summary-card">
              <strong>${escapeHtml(formatUtilization(summary.avgUtilization))}</strong>
              <span>Average utilization</span>
            </div>
            <div class="summary-card">
              <strong>${escapeHtml(formatMeters(summary.totalLengthMm))}</strong>
              <span>Total length</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Sheet width (mm)</th>
                <th>Sheet length (mm)</th>
                <th>Parts</th>
                <th>Material</th>
                <th>Utilization</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </main>
      </body>
    </html>
  `;
}

async function withPreparedPrintWindow(html, work) {
  const printWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1660,
    backgroundColor: '#ffffff',
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await printWindow.webContents.executeJavaScript(`
      new Promise(resolve => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(done).catch(done);
        } else {
          done();
        }
      });
    `);
    return await work(printWindow);
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

async function printReportHtml(html) {
  return withPreparedPrintWindow(html, printWindow => new Promise((resolve, reject) => {
    printWindow.webContents.print(
      {
        silent: false,
        printBackground: true,
      },
      (success, errorType) => {
        if (success) {
          resolve({ success: true });
          return;
        }
        if (errorType === 'cancelled') {
          resolve({ success: true, canceled: true });
          return;
        }
        reject(new Error(errorType || 'Print failed'));
      }
    );
  }));
}

function registerExportReportIpc() {
  ipcMain.handle('print-sheets-report', async (event, {
    jobName,
    sheetMaterial,
    strips = [],
  }) => {
    try {
      const normalizedStrips = (Array.isArray(strips) ? strips : []).map(strip => ({
        sheetWidth: roundUpDim(strip.strip_height),
        sheetLength: roundUpDim(strip.sheet_width ?? strip.strip_width),
        parts: Math.max(0, Number(strip.item_count) || 0),
        material: String(strip.material || sheetMaterial || '').trim() || '—',
        density: Number(strip.density),
      }));

      if (!normalizedStrips.length) {
        return { success: false, error: 'No sheets available to print' };
      }

      const densities = normalizedStrips
        .map(strip => strip.density)
        .filter(value => Number.isFinite(value) && value > 0);

      const summary = {
        sheetCount: normalizedStrips.length,
        totalParts: normalizedStrips.reduce((sum, strip) => sum + strip.parts, 0),
        avgUtilization: densities.length
          ? densities.reduce((sum, value) => sum + value, 0) / densities.length
          : null,
        totalLengthMm: normalizedStrips.reduce((sum, strip) => sum + (strip.sheetLength || 0), 0),
      };

      const html = buildReportHtml({
        jobName: String(jobName || '').trim() || 'Nesting job',
        strips: normalizedStrips,
        summary,
      });

      return await printReportHtml(html);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerExportReportIpc,
};
