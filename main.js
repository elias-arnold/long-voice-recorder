/*
 * Copyright (c) 2025.
 * Author: Elias Arnold licence@eliasarnold.com
 * You should have received a copy of the licence with this file. If not please contact the Author.
 */

/* assets/app.js
   Mobile-first pop-art voice notes – buttons & behaviors.
   jQuery is available globally.
*/
(function (window, $) {
    'use strict';

    // ---- Config you can tweak -----------------------------------------------
    const PROGRESS_TOTAL_MS = 5 * 60 * 1000;    // 5 minutes
    const FRESH_MS = 10_000;                    // highlight new text for 10s
    const SIMULATE_TRANSCRIBE = true;           // set false when wired to backend
    const SIM_TRANSCRIBE_MS = 3_000;            // spinner time during simulation
    const LS_KEY = 'OPENAI_API_KEY';            // localStorage key name

    // ---- State ----------------------------------------------------------------
    const state = {
        isRecording: true,
        isTranscribing: false,
        progressAccumMs: 0,       // accumulated within current 5-min cycle
        progressTick: null,       // setInterval handle
        timerTick: null,          // setInterval handle for mm:ss
        cycleStartTs: null,       // performance.now() when cycle (or resume) started
        timerAccumMs: 0           // total recording time for label
    };

    // ---- DOM ------------------------------------------------------------------
    const el = {};
    function cacheDom() {
        el.mainBtn = $('#mainButton');
        el.iconRecord = $('#icon-record');
        el.iconPause = $('#icon-pause');

        el.progressContainer = $('#progressContainer');
        el.progressFill = $('#progressFill');
        el.spinnerRow = $('#spinnerRow');

        el.settingsBtn = $('#settingsButton');
        el.settingsSheet = $('#settingsSheet');
        el.saveApiKeyBtn = $('#saveApiKeyButton');
        el.closeSettingsBtn = $('#closeSettingsButton');
        el.apiKeyInput = $('#apiKeyInput');

        el.copyBtn = $('#copyButton');
        el.transcript = $('#transcriptArea');
        el.liveRegion = $('#liveRegion');
        el.timerLabel = $('#timerLabel');
    }

    // ---- Utilities ------------------------------------------------------------
    function fmtMMSS(ms) {
        const t = Math.floor(ms / 1000);
        const m = String(Math.floor(t / 60)).padStart(2, '0');
        const s = String(t % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    function announce(msg) {
        el.liveRegion.text(msg);
    }

    function setRecordingUI(recording) {
        state.isRecording = recording;
        el.mainBtn.toggleClass('recording', recording);
        el.mainBtn.attr('data-state', recording ? 'recording' : 'paused');
        el.mainBtn.attr('aria-label', recording ? 'Pause' : 'Record');

        // Show current state icon
        el.iconRecord.toggleClass('hidden', !recording);
        el.iconPause.toggleClass('hidden', recording);
    }

    function showSpinner(show) {
        el.spinnerRow.toggleClass('hidden-important', !show);
        el.progressContainer.toggleClass('hidden-important', show);
        state.isTranscribing = !!show;
    }

    function placeCaretAtEnd(node) {
        try {
            node = node[0] || node; // allow jQuery or DOM node
            node.focus();
            const range = document.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) {
            /* no-op */
        }
    }

    // ---- Progress cycle -------------------------------------------------------
    function startProgressCycle() {
        state.cycleStartTs = performance.now();
        stopProgressTick();
        state.progressTick = setInterval(onProgressTick, 100); // ~10fps
    }

    function stopProgressTick() {
        if (state.progressTick) clearInterval(state.progressTick);
        state.progressTick = null;
    }

    function resetProgressFill() {
        el.progressFill.css('width', '0%');
    }

    function onProgressTick() {
        if (!state.isRecording || state.isTranscribing) return;

        const now = performance.now();
        const elapsedThisRun = now - state.cycleStartTs;
        const totalElapsed = state.progressAccumMs + elapsedThisRun;

        const pct = Math.min(1, totalElapsed / PROGRESS_TOTAL_MS);
        el.progressFill.css('width', (pct * 100).toFixed(3) + '%');

        if (pct >= 1) {
            // One 5-min chunk ended: hide bar, show spinner, reset cycle.
            state.progressAccumMs = 0;
            state.cycleStartTs = performance.now();
            showSpinner(true);
            if (SIMULATE_TRANSCRIBE) {
                setTimeout(() => finishTranscribe(), SIM_TRANSCRIBE_MS);
            }
        }
    }

    function pauseProgress() {
        const now = performance.now();
        if (state.cycleStartTs != null) {
            state.progressAccumMs += Math.max(0, now - state.cycleStartTs);
        }
        stopProgressTick();
    }

    function resumeProgress() {
        state.cycleStartTs = performance.now();
        if (!state.progressTick) {
            state.progressTick = setInterval(onProgressTick, 100);
        }
    }

    // ---- Timer label (mm:ss) --------------------------------------------------
    function startTimer() {
        stopTimer();
        state.timerTick = setInterval(() => {
            if (!state.isRecording) return;
            state.timerAccumMs += 1000;
            el.timerLabel.text(fmtMMSS(state.timerAccumMs));
        }, 1000);
    }
    function stopTimer() {
        if (state.timerTick) clearInterval(state.timerTick);
        state.timerTick = null;
    }

    // ---- Transcript helpers ---------------------------------------------------
    function appendTranscript(text) {
        // Wrap new content to highlight for 10s
        const span = $('<span>')
            .addClass('fresh bg-yellow-100 text-rose-600')
            .text(text);

        // Add a space if needed
        const needsSpace =
            el.transcript.text().length > 0 &&
            !/[\s\n]$/.test(el.transcript.text());
        if (needsSpace) el.transcript.append(document.createTextNode(' '));

        el.transcript.append(span);

        // Keep view scrolled to bottom & caret at end
        el.transcript.scrollTop(el.transcript[0].scrollHeight);
        placeCaretAtEnd(el.transcript);

        // Remove the highlight after 10 seconds
        setTimeout(() => {
            span.removeClass('bg-yellow-100 text-rose-600');
        }, FRESH_MS);
    }

    // ---- Settings sheet -------------------------------------------------------
    function openSettings() {
        const existing = localStorage.getItem(LS_KEY) || '';
        el.apiKeyInput.val(existing);
        el.settingsSheet.removeClass('hidden-important').attr('aria-hidden', 'false');
    }
    function closeSettings() {
        el.settingsSheet.addClass('hidden-important').attr('aria-hidden', 'true');
    }
    function saveApiKey() {
        const val = (el.apiKeyInput.val() || '').trim();
        try {
            localStorage.setItem(LS_KEY, val);
            announce('API key saved to local storage.');
            closeSettings();
        } catch (e) {
            announce('Could not save the API key.');
            console.error(e);
        }
    }

    // ---- Copy transcript ------------------------------------------------------
    async function copyTranscript() {
        const text = el.transcript.text();
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback for non-secure contexts
                const ta = $('<textarea>').val(text).appendTo('body').css({ position: 'fixed', top: '-1000px' });
                ta[0].select();
                document.execCommand('copy');
                ta.remove();
            }
            announce('Transcript copied.');
        } catch (e) {
            announce('Copy failed.');
            console.error(e);
        }
    }

    // ---- Public API -----------------------------------------------------------
    function startTranscribe() {
        showSpinner(true);
    }
    function finishTranscribe() {
        showSpinner(false);
        resetProgressFill();
        // Resume the next 5-min cycle immediately (unless paused)
        if (state.isRecording) {
            startProgressCycle();
        }
    }
    function setRecording(stateBool) {
        if (stateBool === state.isRecording) return;
        if (stateBool) {
            // Resume
            setRecordingUI(true);
            resumeProgress();
        } else {
            // Pause
            setRecordingUI(false);
            pauseProgress();
        }
    }

    // ---- Event wiring ---------------------------------------------------------
    function bindEvents() {
        // Record/Pause toggle
        el.mainBtn.on('click', () => {
            setRecording(!state.isRecording);
        });

        // Copy
        el.copyBtn.on('click', copyTranscript);

        // Settings
        el.settingsBtn.on('click', openSettings);
        el.closeSettingsBtn.on('click', closeSettings);
        el.saveApiKeyBtn.on('click', saveApiKey);

        // Allow ESC to close settings
        $(document).on('keydown', (e) => {
            if (e.key === 'Escape') closeSettings();
        });
    }

    // ---- Init -----------------------------------------------------------------
    function init() {
        cacheDom();
        bindEvents();

        // Start UI in "recording" as per initial HTML
        setRecordingUI(true);
        resetProgressFill();
        startProgressCycle();
        startTimer();

        // Expose small API for your speech pipeline
        window.App = window.App || {};
        Object.assign(window.App, {
            appendTranscript,   // App.appendTranscript("new words...")
            startTranscribe,    // App.startTranscribe()
            finishTranscribe,   // App.finishTranscribe()
            setRecording        // App.setRecording(true/false)
        });

        // Example (remove later): demo new text every 4s while recording
        // to showcase the 10s color flash.
        let demo = setInterval(() => {
            if (!state.isRecording || state.isTranscribing) return;
            appendTranscript('demo input');
        }, 4000);
        // Stop demo once you wire real input:
        window.App.disableDemo = () => { clearInterval(demo); };
    }

    $(init);
})(window, jQuery);

