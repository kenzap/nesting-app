  'use strict';

  (function defineNestingService(globalScope) {
    function createNestingService({
    state,
    dom,
    getCurrentNestingSettings,
    exportPlacementJSON,
    setStatus,
    setNestStatsTone,
    showNestResult,
    renderTabs,
      syncExportButton,
      partsHistory = null,
    }) {
      const {
        MULTI_SHEET_STRATEGY_OPTIONS = {
          'auto': { multiStripMode: 'barriers', bucketFillWeight: null },
          'by-height': { multiStripMode: 'prebucket', bucketFillWeight: 1.0 },
          'by-length': { multiStripMode: 'prebucket', bucketFillWeight: 0.0 },
          'by-height-or-length': { multiStripMode: 'prebucket', bucketFillWeight: null },
        },
      } = globalScope.NestSettings || {};
      let nestInterval = null;
      let sparrowRunAborted = false;
      let activeSparrowRunId = null;
      let completedFinalizationPolls = 0;
      const MAX_COMPLETED_FINALIZATION_POLLS = 8;

    const SOLVER_ERROR_RULES = [
      {
        pattern: /barrier-mode k-discovery did not converge|tried up to k\s*=\s*\d+ sheets,? items still don'?t fit/i,
        message: 'One or more parts cannot fit on the configured sheet. Increase the sheet dimensions or check the DXF units.',
      },
      {
        pattern: /strip[-\s]?width is running away.*does not seem to fit|item \d+ has minimum bbox dimension .*cannot fit in any sheet/is,
        message: 'A part is larger than the sheet. Check the DXF units or increase the sheet dimensions.',
      },
      {
        pattern: /requires strip length .* exceeding the configured maximum/i,
        message: 'The parts do not fit within the sheet’s maximum length. Reduce the quantities or increase the sheet length.',
      },
      {
        pattern: /sheet margin must be less than half the sheet length/i,
        message: 'The sheet margin is too large for the configured sheet length.',
      },
      {
        pattern: /strip margin .* leaves no usable strip height/i,
        message: 'The sheet margin leaves no usable nesting area. Reduce the margin or increase the sheet height.',
      },
      {
        pattern: /could not construct (?:any strip candidate|a valid strip bucket) under the configured constraints/i,
        message: 'The parts could not be arranged within the current sheet constraints. Increase the sheet dimensions or use a different sheet strategy.',
      },
      {
        pattern: /no (?:items|parts).*placed|zero sheets|no sheets|cannot exact-fit an empty/i,
        message: 'No parts could be placed. Check the part quantities and sheet settings.',
      },
      {
        pattern: /invalid (?:polygon|geometry)|self[-\s]?intersect|non[-\s]?finite coordinate/i,
        message: 'A DXF contains invalid geometry. Repair the affected contour and try again.',
      },
      {
        pattern: /executable not found|enoent/i,
        message: 'The nesting engine could not be started. Reinstall the app or verify its bundled files.',
      },
      {
        pattern: /eacces|permission denied/i,
        message: 'The nesting engine could not be started because access was denied.',
      },
    ];

    function errorChunkText(chunk) {
      if (!chunk) return '';
      if (typeof chunk === 'string') return chunk;
      if (chunk instanceof Error) {
        return [chunk.message, chunk.sparrowDetails, chunk.cause]
          .map(errorChunkText)
          .filter(Boolean)
          .join('\n');
      }
      if (typeof chunk === 'object') {
        return [chunk.message, chunk.error, chunk.stderr, chunk.stdout, chunk.details]
          .map(errorChunkText)
          .filter(Boolean)
          .join('\n');
      }
      return String(chunk);
    }

    function cleanErrorText(raw) {
      return String(raw || '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/\r/g, '')
        .trim();
    }

    // Translates raw solver/Rust errors into plain-language sentences. Unknown
    // messages remain available as technical details and use their cleanest
    // meaningful line as the visible summary.
    function translateSparrowError(raw) {
      const text = cleanErrorText(raw);
      if (!text) return 'Nesting could not be completed.';
      const matchedRule = SOLVER_ERROR_RULES.find(rule => rule.pattern.test(text));
      return matchedRule?.message || text;
    }

    // Parses raw stdout/stderr into a clean one-line message. Known failures
    // win first, followed by Rust panic reasons and the last meaningful line.
    function extractSparrowErrorMessage(...chunks) {
      const text = cleanErrorText(chunks.map(errorChunkText).filter(Boolean).join('\n'));
      if (!text) return 'Nesting could not be completed.';

      const knownFailure = SOLVER_ERROR_RULES.find(rule => rule.pattern.test(text));
      if (knownFailure) return knownFailure.message;

      const lines = [...new Set(text.split(/\n/)
        .map(line => line.trim().replace(/^(?:uncaught\s+)?error:\s*/i, ''))
        .filter(Boolean))];

      // Rust panic: the reason is on the line immediately after
      // "thread '…' panicked at path/to/file.rs:N:N:".
      const panicIdx = lines.findIndex(line => /^thread\s+'[^']*'.*panicked at/i.test(line));
      if (panicIdx >= 0 && panicIdx + 1 < lines.length) {
        return translateSparrowError(lines[panicIdx + 1]);
      }

      const explicitError = [...lines].reverse().find(line => /^(?:fatal|failed|failure):/i.test(line));
      if (explicitError) return translateSparrowError(explicitError.replace(/^[^:]+:\s*/i, '').trim());

      const stripLength = [...lines].reverse().find(line => /requires strip length .* exceeding the configured maximum/i.test(line));
      if (stripLength) return translateSparrowError(stripLength);

      // Skip both info and warn tag lines — neither is an error signal on its own.
      const lastMeaningful = [...lines].reverse().find(line => (
        !/^\[(info|warn|debug|trace)\]/i.test(line)
        && !/^at\s+\S+/i.test(line)
      ));
      const summary = translateSparrowError(
        lastMeaningful || lines[lines.length - 1] || 'Nesting could not be completed.',
      );
      return summary.length > 220 ? `${summary.slice(0, 217)}…` : summary;
    }

    function normalizeRunError(...chunks) {
      const detailLines = [...new Set(
        cleanErrorText(chunks.map(errorChunkText).filter(Boolean).join('\n'))
          .split(/\n/)
          .map(line => line.trim())
          .filter(Boolean),
      )];
      const message = extractSparrowErrorMessage(detailLines.join('\n'));
      if (detailLines.length > 1 && detailLines[0] === message) detailLines.shift();
      return {
        message,
        details: detailLines.join('\n'),
      };
    }

    // Sets the status chip to error, tints the status bar red, and writes the error
    // message with a tooltip containing the full solver details for debugging.
    function showRunError(message, details = '') {
      setStatus('error');
      setNestStatsTone('error');
      const summary = message || 'Nesting could not be completed.';
      dom.nestStats.textContent = summary;
      dom.nestStats.title = details || summary;
    }

    function presentRunError(stage, ...chunks) {
      const failure = normalizeRunError(...chunks);
      console.error(`[Nesting] ${failure.message}`);
      if (failure.details && failure.details !== failure.message) {
        console.groupCollapsed(`[Nesting details] ${stage}`);
        console.debug(failure.details);
        console.groupEnd();
      }
      showRunError(failure.message, failure.details);
    }

    // Shows a gentle preflight hint when Run is pressed before the user has
    // added the required DXF parts and/or sheets.
    function showStartRequirementsWarning(message) {
      setStatus('idle');
      setNestStatsTone('warning');
      dom.nestStats.textContent = message;
      dom.nestStats.title = '';
    }

    function stripSvgBasename(strip) {
      return String(strip?.svg_path || '').split(/[\\/]/).pop() || '';
    }

    function stripJsonBasename(strip) {
      return String(strip?.json_path || '').split(/[\\/]/).pop() || '';
    }

    function isCanonicalFinalSummary(summary) {
      if (!summary?.strips?.length || summary.is_preview) return false;
      return summary.strips.every(strip => {
        if (strip?.is_preview) return false;

        const svgName = stripSvgBasename(strip);
        const jsonName = stripJsonBasename(strip);
        const isMultiSheetFinal = /^strip_\d+\.svg$/i.test(svgName)
          && /^strip_\d+\.json$/i.test(jsonName);
        const isUnlimitedFinal = summary.strips.length === 1
          && /^final_.+\.svg$/i.test(svgName)
          && /^final_.+\.json$/i.test(jsonName);
        return isMultiSheetFinal || isUnlimitedFinal;
      });
    }

    // Called on a 500ms interval while the solver is running to fetch the latest result.
    // Updates state and re-renders the canvas whenever new strips arrive, and cleans up
    // the interval on completion, error, or stop.
    async function pollSparrowRun(runId) {
      if (!window.electronAPI?.pollSparrow) return;

      const result = await window.electronAPI.pollSparrow(runId);
      if (!result?.success) {
        const failure = normalizeRunError(result?.error || 'The nesting run could not be checked.');
        const err = new Error(failure.message);
        err.sparrowDetails = failure.details;
        throw err;
      }

      if (result.status !== 'completed') {
        completedFinalizationPolls = 0;
      }

      // Between "solver reports done" and "canonical strip files exist on
      // disk", one or more polls can return a transitional summary where a
      // strip's SVG has parts already translated into outer-sheet coords
      // while the metadata still reads like a preview — applying our margin
      // shift on top double-translates every part into the top-right corner
      // for that frame. Skip rendering (and mutating state) until the
      // summary settles into its canonical shape; the last good preview
      // frame stays on screen in the meantime.
      const isFinalizationLimbo = result.status === 'completed'
        && !isCanonicalFinalSummary(result.summary);

      if (result.summary?.strips?.length && !isFinalizationLimbo) {
        const previousCount = state.nestResult?.strips?.length || 0;
        const previousIndex = state.activeStripIndex || 0;
        state.nestResult = result.summary;
        if (result.inputPath) state.nestInputPath = result.inputPath;

        if (previousCount === 0) {
          // First time strips become available this run. Default to sheet 1
          // so the user lands on the natural starting point. (Barrier mode
          // loads every sheet on the first poll, so without this guard the
          // newest-strip auto-follow below would jump straight to the last
          // tab.)
          state.activeStripIndex = 0;
        } else if (state.nestResult.strips.length > previousCount) {
          // Pre-bucket mode: Sparrow finishes one sheet at a time. Follow
          // the newest one so the user sees the sheet currently being
          // populated instead of staying pinned to an older tab.
          state.activeStripIndex = state.nestResult.strips.length - 1;
        } else if (!state.nestResult.strips[previousIndex]) {
          state.activeStripIndex = 0;
        }
        syncExportButton();
        renderTabs();
        showNestResult(state.activeStripIndex || 0);
      } else if (result.status === 'running') {
        setNestStatsTone('');
        dom.nestStats.textContent = 'Running placement… waiting for first preview';
      }

      if (result.status === 'completed') {
        const finalSummaryReady = isCanonicalFinalSummary(result.summary);
        if (!finalSummaryReady && completedFinalizationPolls < MAX_COMPLETED_FINALIZATION_POLLS) {
          completedFinalizationPolls += 1;
          setStatus('running');
          setNestStatsTone('');
          dom.nestStats.title = '';
          return;
        }

        completedFinalizationPolls = 0;
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        setStatus('done');
        setNestStatsTone('');
        dom.nestStats.title = '';
        dom.startBtn.classList.remove('running');
        dom.startBtn.disabled = false;
        dom.stopBtn.disabled = true;
        dom.stopBtn.classList.remove('active');
        return;
      }

      if (result.status === 'error') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        const failure = normalizeRunError(result.error, result.stderr, result.stdout);
        const err = new Error(failure.message);
        err.sparrowDetails = failure.details;
        throw err;
      }

      if (result.status === 'stopped') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
      }
    }

    // Wires the Start and Stop buttons.
    // Start: exports the placement JSON, launches Sparrow via IPC, and begins a 500ms
    // polling interval. Stop: sets the abort flag, calls stopSparrow, and resets the UI.
    function bind() {
      // Start button — exports placement JSON, runs Sparrow, and starts polling for results.
      dom.startBtn.addEventListener('click', async () => {
        if (state.status === 'running') return;

        const hasFiles = state.files.length > 0;
        const hasSheets = state.sheets.length > 0;
        if (!hasFiles && !hasSheets) {
          showStartRequirementsWarning('Add DXF parts and at least one sheet, then press Run.');
          return;
        }
        if (!hasFiles) {
          showStartRequirementsWarning('Add one or more DXF parts before running nesting.');
          return;
        }
        if (!hasSheets) {
          showStartRequirementsWarning('Add at least one sheet before running nesting.');
          return;
        }

        // Snapshot the parts list into the run-history stack before starting.
        // No-op if the list hasn't changed since the previous run, so back-to-back
        // runs on the same configuration don't add duplicate entries.
        partsHistory?.recordRunStart();

        let exported;
        try {
          exported = await exportPlacementJSON();
          setNestStatsTone('');
          dom.nestStats.textContent = 'Placement data prepared';
          dom.nestStats.title = exported.path || '';
        } catch (err) {
          console.error('[Placement JSON] Export failed:', err);
          setStatus('error');
          setNestStatsTone('error');
          dom.nestStats.textContent = `Export failed: ${err.message}`;
          return;
        }

        setStatus('running');
        setNestStatsTone('');
        dom.nestStats.title = '';
        sparrowRunAborted = false;
        dom.startBtn.classList.add('running');
        dom.startBtn.disabled = true;
        dom.stopBtn.disabled = false;
        dom.stopBtn.classList.add('active');
        state.nestResult = null;
        state.activeStripIndex = 0;
        completedFinalizationPolls = 0;
        if (dom.svgContainer) {
          delete dom.svgContainer.dataset.activeIndex;
          delete dom.svgContainer.dataset.svgLen;
          delete dom.svgContainer.dataset.svgHash;
          delete dom.svgContainer.dataset.svgSource;
          delete dom.svgContainer.dataset.svgPreview;
        }
        syncExportButton();

        try {
          const primarySheet = state.sheets[0] || {};
          const settings = getCurrentNestingSettings();
          const partSpacing = Number(settings.partSpacing) || 0;
          // Single multi-sheet strategy drives both the placement algorithm
          // (`multiStripMode`) and, for the legacy bucketed paths, the
          // bucket fill weight. `bucketFillWeight: null` means "omit from
          // the CLI" — handled by the spread below.
          const strategyKey = String(settings.multiSheetStrategy || 'auto').toLowerCase();
          const strategy = MULTI_SHEET_STRATEGY_OPTIONS[strategyKey]
            || MULTI_SHEET_STRATEGY_OPTIONS['auto'];
          const { multiStripMode, bucketFillWeight } = strategy;
          const sheetMargin = Math.max(0, Number(settings.sheetMargin) || 0);
          const configuredSheetLength = Number(primarySheet.width);
          const usableSheetLength = configuredSheetLength - (sheetMargin * 2);
          if (primarySheet.widthMode !== 'unlimited' &&
              (!Number.isFinite(usableSheetLength) || usableSheetLength <= 0)) {
            throw new Error('Sheet margin must be less than half the sheet length.');
          }
          const sparrowOptions = {
            globalTime: Number(settings.timeLimit) || 60,
            rngSeed: Number.isFinite(Number(settings.rngSeed)) ? Math.trunc(Number(settings.rngSeed)) : 42,
            workers: Number.isFinite(Number(settings.workers)) ? Math.max(1, Math.trunc(Number(settings.workers))) : 3,
            earlyTermination: !!settings.earlyStopping,
            maxStripLength: primarySheet.widthMode === 'unlimited'
              ? null
              : usableSheetLength,
            stripMargin: sheetMargin,
            minItemSeparation: partSpacing,
            exactCoedge: partSpacing === 0,
            align: String(settings.preferredAlignment || 'top'),
            multiStripMode,
            ...(Number.isFinite(bucketFillWeight) ? { bucketFillWeight } : {}),
          };
          const result = await window.electronAPI.runSparrow(exported.payload, sparrowOptions);

          if (!result?.success || !result.runId) {
            const failure = normalizeRunError(result?.error || 'The nesting engine could not be started.');
            const err = new Error(failure.message);
            err.sparrowDetails = failure.details;
            throw err;
          }
          activeSparrowRunId = result.runId;
          setNestStatsTone('');
          dom.nestStats.textContent = 'Placement running…';
          dom.nestStats.title = result.inputPath || '';

          if (nestInterval) clearInterval(nestInterval);
          await pollSparrowRun(result.runId);
          nestInterval = window.setInterval(async () => {
            if (!activeSparrowRunId || sparrowRunAborted) return;
            try {
              await pollSparrowRun(activeSparrowRunId);
            } catch (pollError) {
              if (sparrowRunAborted) return;
              clearInterval(nestInterval);
              nestInterval = null;
              activeSparrowRunId = null;
              presentRunError('Live preview', pollError);
              dom.startBtn.classList.remove('running');
              dom.startBtn.disabled = false;
              dom.stopBtn.disabled = true;
              dom.stopBtn.classList.remove('active');
            }
          }, 500);
        } catch (err) {
          if (sparrowRunAborted) return;
          activeSparrowRunId = null;
          if (nestInterval) {
            clearInterval(nestInterval);
            nestInterval = null;
          }
          presentRunError('Run', err);
          dom.startBtn.classList.remove('running');
          dom.startBtn.disabled = false;
          dom.stopBtn.disabled = true;
          dom.stopBtn.classList.remove('active');
        }
      });

      // Stop button — sets the abort flag, tells the main process to stop Sparrow,
      // clears the polling interval, and resets the UI to idle.
      dom.stopBtn.addEventListener('click', async () => {
        if (state.status !== 'running') return;
        sparrowRunAborted = true;
        activeSparrowRunId = null;
        if (window.electronAPI?.stopSparrow) {
          try {
            await window.electronAPI.stopSparrow();
          } catch (err) {
            console.error('[Sparrow] Stop failed:', err);
          }
        }
        clearInterval(nestInterval);
        nestInterval = null;
        setStatus('idle');
        setNestStatsTone('');
        dom.nestStats.textContent = 'Placement stopped';
        dom.nestStats.title = '';
        dom.startBtn.classList.remove('running');
        dom.startBtn.disabled = false;
        dom.stopBtn.disabled = true;
        dom.stopBtn.classList.remove('active');
      });
    }

    return { bind };
  }

  globalScope.NestNestingService = { createNestingService };
})(window);
