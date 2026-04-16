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
  }) {
    let nestInterval = null;
    let sparrowRunAborted = false;
    let activeSparrowRunId = null;

    function extractSparrowErrorMessage(...chunks) {
      const text = chunks.map(chunk => String(chunk || '')).filter(Boolean).join('\n').trim();
      if (!text) return 'Sparrow failed';

      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const explicitError = [...lines].reverse().find(line => /^error:/i.test(line));
      if (explicitError) return explicitError.replace(/^error:\s*/i, '').trim();
      const stripLength = [...lines].reverse().find(line => /requires strip length .* exceeding the configured maximum/i.test(line));
      if (stripLength) return stripLength;
      const lastMeaningful = [...lines].reverse().find(line => !/^\[info\]/i.test(line));
      return lastMeaningful || lines[lines.length - 1] || 'Sparrow failed';
    }

    function showRunError(message, details = '') {
      setStatus('error');
      setNestStatsTone('error');
      const summary = message || 'Sparrow failed';
      dom.nestStats.textContent = `Run failed: ${summary}`;
      dom.nestStats.title = details || summary;
    }

    async function pollSparrowRun(runId) {
      if (!window.electronAPI?.pollSparrow) return;

      const result = await window.electronAPI.pollSparrow(runId);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to poll Sparrow run');
      }

      if (result.summary?.strips?.length) {
        const previousCount = state.nestResult?.strips?.length || 0;
        const previousIndex = state.activeStripIndex || 0;
        state.nestResult = result.summary;
        if (result.inputPath) state.nestInputPath = result.inputPath;

        // While Sparrow is still adding sheets one by one, automatically
        // follow the newest strip so the user sees the sheet currently being
        // populated instead of staying pinned to an older tab.
        if (state.nestResult.strips.length > previousCount) {
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
        const combinedDetails = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n');
        const err = new Error(extractSparrowErrorMessage(result.error, result.stderr, result.stdout));
        err.sparrowDetails = combinedDetails;
        throw err;
      }

      if (result.status === 'stopped') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
      }
    }

    function bind() {
      dom.startBtn.addEventListener('click', async () => {
        if (state.status === 'running') return;
        if (!state.files.length) return;
        if (!state.sheets.length) return;

        let exported;
        try {
          exported = await exportPlacementJSON();
          setNestStatsTone('');
          dom.nestStats.textContent = `Placement JSON saved to ${exported.path}`;
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
        syncExportButton();

        try {
          const primarySheet = state.sheets[0] || {};
          const settings = getCurrentNestingSettings();
          const result = await window.electronAPI.runSparrow(exported.payload, {
            globalTime: Number(settings.timeLimit) || 60,
            rngSeed: 42,
            earlyTermination: !!settings.earlyStopping,
            maxStripLength: primarySheet.widthMode === 'unlimited' ? null : Number(primarySheet.width) || null,
            stripMargin: Number(settings.sheetMargin) || 0,
            minItemSeparation: Number(settings.partSpacing) || 0,
            align: settings.preferredAlignment === 'bottom' ? 'bottom' : 'top',
          });

          if (!result?.success || !result.runId) {
            throw new Error(result?.error || 'Failed to start Sparrow');
          }
          activeSparrowRunId = result.runId;
          setNestStatsTone('');
          dom.nestStats.textContent = `Placement running… input saved to ${result.inputPath}`;

          if (nestInterval) clearInterval(nestInterval);
          await pollSparrowRun(result.runId);
          nestInterval = window.setInterval(async () => {
            if (!activeSparrowRunId || sparrowRunAborted) return;
            try {
              await pollSparrowRun(activeSparrowRunId);
            } catch (pollError) {
              if (sparrowRunAborted) return;
              console.error('[Sparrow] Live preview failed:', pollError?.sparrowDetails || pollError);
              clearInterval(nestInterval);
              nestInterval = null;
              activeSparrowRunId = null;
              showRunError(pollError.message, pollError?.sparrowDetails || pollError.message);
              dom.startBtn.classList.remove('running');
              dom.startBtn.disabled = false;
              dom.stopBtn.disabled = true;
              dom.stopBtn.classList.remove('active');
            }
          }, 500);
        } catch (err) {
          if (sparrowRunAborted) return;
          console.error('[Sparrow] Run failed:', err?.sparrowDetails || err);
          activeSparrowRunId = null;
          if (nestInterval) {
            clearInterval(nestInterval);
            nestInterval = null;
          }
          showRunError(err.message, err?.sparrowDetails || err.message);
          dom.startBtn.classList.remove('running');
          dom.startBtn.disabled = false;
          dom.stopBtn.disabled = true;
          dom.stopBtn.classList.remove('active');
        }
      });

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
