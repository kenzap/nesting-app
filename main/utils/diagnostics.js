'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { randomBytes } = require('crypto');
const { app, crashReporter, dialog, shell } = require('electron');
const { t } = require('../i18n');

const MAX_LOG_FILES = 20;
const MAX_DETAIL_LENGTH = 12000;
const MAX_CRASH_REPORT_BYTES = 7 * 1024 * 1024;
const CRASH_REPORT_SUBMIT_URL = 'https://kenzap.com/crash-receiver/';
const ROUTINE_EVENTS = new Set([
  'application-started',
  'application-ready',
  'application-before-quit',
  'application-will-quit',
  'diagnostics-folder-opened',
]);

let diagnosticsDir = null;
let sessionLogPath = null;
let initialized = false;
let hasMeaningfulActivity = false;
let appVersion = '';
let pendingCrashReports = [];
let pendingReportsHandled = false;
let automaticCrashReporting = false;

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    stack: error.stack ? String(error.stack) : undefined,
    code: error.code !== undefined ? String(error.code) : undefined,
  };
}

function normalizeDetails(value, seen = new WeakSet()) {
  if (value instanceof Error) return serializeError(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => normalizeDetails(item, seen));
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    normalizeDetails(item, seen),
  ]));
}

function trimDetails(details) {
  const normalized = normalizeDetails(details);
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_DETAIL_LENGTH) return normalized;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_DETAIL_LENGTH),
  };
}

function pruneOldLogs() {
  if (!diagnosticsDir || !fs.existsSync(diagnosticsDir)) return;
  const logs = fs.readdirSync(diagnosticsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^session-.*\.log$/i.test(entry.name))
    .map(entry => {
      const filePath = path.join(diagnosticsDir, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  logs.slice(MAX_LOG_FILES).forEach(({ filePath }) => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Retention must never interfere with app startup.
    }
  });
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readPersistedSettings() {
  try {
    const filePath = settingsPath();
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCrashReportingPreference(enabled) {
  const filePath = settingsPath();
  const settings = readPersistedSettings();
  settings.automaticCrashReporting = Boolean(enabled);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
  automaticCrashReporting = Boolean(enabled);
}

function findCrashReports(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  const reports = [];
  const directories = [directory];

  while (directories.length) {
    const current = directories.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.forEach(entry => {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directories.push(filePath);
        return;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.dmp') return;
      if (fs.existsSync(`${filePath}.submitted`)) return;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          reports.push({
            filePath,
            fileName: entry.name,
            size: stats.size,
            createdAt: stats.mtime.toISOString(),
            mtimeMs: stats.mtimeMs,
          });
        }
      } catch {
        // A report can disappear while Crashpad finishes maintaining its database.
      }
    });
  }

  return reports.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function removeSubmittedCrashReport(report) {
  const markerPath = `${report.filePath}.submitted`;
  try {
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {
    // Deleting the dump still prevents a duplicate submission in most cases.
  }

  try {
    fs.unlinkSync(report.filePath);
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // A stale marker is harmless and is ignored by the report scanner.
    }
    return true;
  } catch (error) {
    logDiagnostic('crash-report-cleanup-failed', {
      fileName: report.fileName,
      error,
    });
    return false;
  }
}

function multipartField(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
    'utf8',
  );
}

function multipartFile(boundary, name, fileName, content) {
  const safeName = String(fileName || 'crash-report.dmp').replace(/["\r\n]/g, '_');
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  return Buffer.concat([header, content, Buffer.from('\r\n', 'utf8')]);
}

function crashReportSubmitUrl() {
  if (!app.isPackaged && process.env.KENZAP_CRASH_REPORT_SUBMIT_URL) {
    return process.env.KENZAP_CRASH_REPORT_SUBMIT_URL;
  }
  return CRASH_REPORT_SUBMIT_URL;
}

function postCrashReport(report) {
  if (!report?.filePath || !fs.existsSync(report.filePath)) {
    return Promise.reject(new Error('The local crash report is no longer available.'));
  }
  if (report.size > MAX_CRASH_REPORT_BYTES) {
    return Promise.reject(new Error('The crash report is too large to send automatically.'));
  }

  const reportContent = fs.readFileSync(report.filePath);
  const boundary = `----KenzapCrashBoundary${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    multipartField(boundary, 'form-name', 'electron-crashes'),
    multipartField(boundary, '_version', appVersion),
    multipartField(boundary, 'platform', `${process.platform}-${process.arch}`),
    multipartField(boundary, 'process_type', 'electron'),
    multipartFile(boundary, 'upload_file_minidump', report.fileName, reportContent),
    Buffer.from(`--${boundary}--\r\n`, 'utf8'),
  ]);
  const target = new URL(crashReportSubmitUrl());
  const transport = target.protocol === 'https:' ? https : http;

  if (app.isPackaged && target.protocol !== 'https:') {
    return Promise.reject(new Error('Crash reports require a secure HTTPS endpoint.'));
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': `Kenzap-Nesting/${appVersion || 'unknown'}`,
      },
    }, response => {
      response.resume();
      response.once('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ statusCode: response.statusCode });
          return;
        }
        reject(new Error(`Crash report service returned HTTP ${response.statusCode || 'unknown'}.`));
      });
    });
    request.setTimeout(30000, () => {
      request.destroy(new Error('Crash report upload timed out.'));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function sendPendingCrashReports() {
  const results = [];
  for (const report of [...pendingCrashReports]) {
    try {
      const response = await postCrashReport(report);
      const removed = removeSubmittedCrashReport(report);
      pendingCrashReports = pendingCrashReports.filter(item => item.filePath !== report.filePath);
      results.push({ report, success: true, statusCode: response.statusCode });
      logDiagnostic('crash-report-sent', {
        fileName: report.fileName,
        size: report.size,
        statusCode: response.statusCode,
        removed,
      });
    } catch (error) {
      results.push({ report, success: false, error });
      logDiagnostic('crash-report-send-failed', {
        fileName: report.fileName,
        size: report.size,
        error,
      });
    }
  }
  return results;
}

async function handlePendingCrashReports(parentWindow = null) {
  const previewOnly = !app.isPackaged && process.argv.includes('--preview-crash-dialog');
  if (pendingReportsHandled || (pendingCrashReports.length === 0 && !previewOnly)) {
    return { handled: false, automaticCrashReporting };
  }
  pendingReportsHandled = true;

  let shouldSend = automaticCrashReporting;
  let explicitRequest = false;
  if (previewOnly || !automaticCrashReporting) {
    const pendingSummary = pendingCrashReports.length > 1
      ? t('diagnostics.pendingReports', { count: pendingCrashReports.length })
      : '';
    const previewSummary = previewOnly
      ? t('diagnostics.preview')
      : '';
    const messageOptions = {
      type: 'warning',
      title: t('diagnostics.unexpectedTitle'),
      message: t('diagnostics.unexpectedMessage'),
      detail: t('diagnostics.detail', { pending: pendingSummary, preview: previewSummary }),
      buttons: [t('diagnostics.send'), t('diagnostics.notNow'), t('diagnostics.alwaysSend')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showMessageBox(parentWindow, messageOptions)
      : await dialog.showMessageBox(messageOptions);

    if (previewOnly) {
      return { handled: true, preview: true, response: result.response, automaticCrashReporting };
    }

    if (result.response === 1) {
      logDiagnostic('crash-report-deferred', { reportCount: pendingCrashReports.length });
      return { handled: true, sent: false, automaticCrashReporting };
    }

    explicitRequest = true;
    shouldSend = result.response === 0 || result.response === 2;
    if (result.response === 2) {
      try {
        writeCrashReportingPreference(true);
        if (parentWindow && !parentWindow.isDestroyed()) {
          parentWindow.webContents.send('crash-reporting-preference-changed', { enabled: true });
        }
      } catch (error) {
        logDiagnostic('crash-report-preference-save-failed', { error });
      }
    }
  }

  if (!shouldSend) return { handled: true, sent: false, automaticCrashReporting };
  const results = await sendPendingCrashReports();
  const failures = results.filter(result => !result.success);
  if (failures.length > 0 && explicitRequest) {
    const errorOptions = {
      type: 'warning',
      title: t('diagnostics.notSentTitle'),
      message: t('diagnostics.notSentMessage'),
      detail: t('diagnostics.notSentDetail'),
      buttons: [t('diagnostics.ok')],
      defaultId: 0,
      noLink: true,
    };
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, errorOptions);
    } else {
      await dialog.showMessageBox(errorOptions);
    }
  }

  return {
    handled: true,
    sent: results.some(result => result.success),
    failed: failures.length,
    automaticCrashReporting,
  };
}

function logDiagnostic(event, details = {}) {
  if (!sessionLogPath) return;
  try {
    const eventName = String(event || 'unknown');
    if (!ROUTINE_EVENTS.has(eventName)) hasMeaningfulActivity = true;
    const entry = {
      timestamp: new Date().toISOString(),
      event: eventName,
      details: trimDetails(details),
    };
    fs.appendFileSync(sessionLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Diagnostics must not introduce a new application failure.
  }
}

function initializeDiagnostics({ productName, version } = {}) {
  if (initialized) return { diagnosticsDir, sessionLogPath };
  initialized = true;

  app.setName(String(productName || app.name || 'Kenzap Nesting'));
  appVersion = String(version || app.getVersion() || '');
  diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  const crashDumpsDir = path.join(diagnosticsDir, 'crash-dumps');
  fs.mkdirSync(crashDumpsDir, { recursive: true });
  pendingCrashReports = findCrashReports(crashDumpsDir);
  automaticCrashReporting = readPersistedSettings().automaticCrashReporting === true;
  sessionLogPath = path.join(
    diagnosticsDir,
    `session-${timestampForFile()}-${process.pid}.log`,
  );
  pruneOldLogs();

  let crashReporterEnabled = false;
  try {
    app.setPath('crashDumps', crashDumpsDir);
    crashReporter.start({
      productName: String(productName || app.name || 'Kenzap Nesting'),
      submitURL: CRASH_REPORT_SUBMIT_URL,
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      globalExtra: {
        _companyName: 'Kenzap Pte Ltd',
        applicationVersion: String(version || app.getVersion() || ''),
        platform: process.platform,
        architecture: process.arch,
      },
    });
    crashReporterEnabled = crashReporter.getUploadToServer() === false;
  } catch (error) {
    logDiagnostic('crash-reporter-start-failed', { error });
  }

  logDiagnostic('application-started', {
    productName: String(productName || app.name || ''),
    version: String(version || app.getVersion() || ''),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    packaged: app.isPackaged,
    osRelease: require('os').release(),
    crashReporterEnabled,
    pendingCrashReportCount: pendingCrashReports.length,
    automaticCrashReporting,
  });

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logDiagnostic('main-process-uncaught-exception', { origin, error });
  });
  process.on('warning', warning => {
    logDiagnostic('main-process-warning', { warning });
  });

  return { diagnosticsDir, sessionLogPath };
}

function registerAppDiagnostics() {
  app.on('ready', () => {
    logDiagnostic('application-ready', { locale: app.getLocale() });
  });
  app.on('before-quit', () => {
    logDiagnostic('application-before-quit');
  });
  app.on('will-quit', () => {
    logDiagnostic('application-will-quit');
    if (!hasMeaningfulActivity && sessionLogPath) {
      try {
        fs.unlinkSync(sessionLogPath);
        sessionLogPath = null;
      } catch {
        // A leftover routine log is harmless and will be handled by retention.
      }
    }
  });
  app.on('child-process-gone', (_event, details) => {
    logDiagnostic('electron-child-process-gone', details);
  });
  app.on('browser-window-created', (_event, window) => {
    const windowId = window.id;
    window.on('unresponsive', () => {
      logDiagnostic('browser-window-unresponsive', { windowId });
    });
    window.on('responsive', () => {
      logDiagnostic('browser-window-responsive', { windowId });
    });
    window.webContents.on('render-process-gone', (_renderEvent, details) => {
      logDiagnostic('renderer-process-gone', { windowId, ...details });
    });
    window.webContents.on('did-fail-load', (
      _loadEvent,
      errorCode,
      errorDescription,
      _validatedUrl,
      isMainFrame,
    ) => {
      if (!isMainFrame) return;
      logDiagnostic('renderer-main-frame-load-failed', {
        windowId,
        errorCode,
        errorDescription,
      });
    });
    window.webContents.on('preload-error', (_preloadEvent, _preloadPath, error) => {
      logDiagnostic('renderer-preload-error', { windowId, error });
    });
  });
}

async function openDiagnosticsFolder() {
  if (!diagnosticsDir) {
    diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  }
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const error = await shell.openPath(diagnosticsDir);
  if (error) {
    logDiagnostic('open-diagnostics-folder-failed', { error });
    throw new Error(error);
  }
  logDiagnostic('diagnostics-folder-opened');
  return diagnosticsDir;
}

function stderrTail(value, maxLength = 8000) {
  const text = String(value || '').trim();
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

module.exports = {
  initializeDiagnostics,
  handlePendingCrashReports,
  logDiagnostic,
  openDiagnosticsFolder,
  registerAppDiagnostics,
  stderrTail,
};
