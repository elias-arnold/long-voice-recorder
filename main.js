// main.js
(function (window, $) {
    'use strict';

    // ---- Configuration --------------------------------------------------------
    // Duration of one "progress cycle" before forcing a recorder rotation.
    // UI animations can differ, but this governs when a finalized audio container is produced.
    let PROGRESS_DURATION_MS = 30 * 1000;      // 30 seconds
    const FRESH_MS = 10_000;                   // highlight new text for 10 seconds
    const COUNTDOWN_WINDOW_MS = 5_000;         // show countdown in last 5 seconds
    const LS_KEY = 'OPENAI_API_KEY';           // localStorage key for OpenAI API key
    const LS_RUNTIME_KEY = 'REC_RUNTIME_MS';   // localStorage key for runtime (ms)

    // ---- Runtime state --------------------------------------------------------
    const state = {
        isRecording: false,        // starts paused for better UX/permissions
        isTranscribing: false,

        // Progress cycle bookkeeping
        progressAccumMs: 0,
        progressTick: null,        // setInterval handle for progress bar updates
        cycleStartTs: null,

        // Timer (mm:ss) bookkeeping
        timerTick: null,           // setInterval handle for timer label
        timerAccumMs: 0,

        // Media capture/recording
        mediaStream: null,
        mediaRecorder: null,
        chunkParts: [],
        chunkStartTs: null,

        // Spinner concurrency (can have multiple in-flight transcriptions)
        pendingTranscribes: 0,

        // Countdown bookkeeping
        lastCountdownValue: null,

        // Loop limit bookkeeping
        loopCount: 0,
        maxLoops: null

    };

    // ---- DOM cache ------------------------------------------------------------
    const el = {};

    function cacheDom() {
        el.mainBtn = $('#mainButton');
        el.iconRecord = $('#icon-record');
        el.iconPause = $('#icon-pause');

        el.progressContainer = $('#progressContainer');
        el.progressFill = $('#progressFill');
        el.spinnerRow = $('#spinnerRow');
        el.progressBar = $('#progressBar');

        el.settingsBtn = $('#settingsButton');
        el.settingsSheet = $('#settingsSheet');
        el.saveApiKeyBtn = $('#saveApiKeyButton');
        el.closeSettingsBtn = $('#closeSettingsButton');
        el.apiKeyInput = $('#apiKeyInput');
        el.runtimeSelect = $('#runtimeSelect');

        el.copyBtn = $('#copyButton');
        el.transcript = $('#transcriptArea');
        el.liveRegion = $('#liveRegion');
        el.timerLabel = $('#timerLabel');

        el.rotationCountdown = $('#rotationCountdown');
    }

    // ---- Small utilities ------------------------------------------------------
    function fmtMMSS(ms) {
        const t = Math.floor(ms / 1000);
        const m = String(Math.floor(t / 60)).padStart(2, '0');
        const s = String(t % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    function announce(msg) {
        el.liveRegion.text(msg);
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

    // ---- UI state helpers -----------------------------------------------------
    function setRecordingUI(recording) {
        state.isRecording = recording;

        el.mainBtn.toggleClass('recording', recording);
        el.mainBtn.attr('data-state', recording ? 'recording' : 'paused');
        el.mainBtn.attr('aria-label', recording ? 'Pause' : 'Record');

        // Swap icons
        el.iconRecord.toggleClass('hidden', recording);
        el.iconPause.toggleClass('hidden', !recording);

        // Hide countdown when pausing
        if (!recording) hideCountdown();
    }

    function showSpinner(show) {
        el.spinnerRow.toggleClass('hidden-important', !show);
        el.progressContainer.toggleClass('hidden-important', show);
        state.isTranscribing = !!show;
    }

    function incPendingTranscribes() {
        state.pendingTranscribes += 1;
        el.spinnerRow.removeClass('hidden-important');
        el.progressContainer.addClass('hidden-important');
        state.isTranscribing = true;
    }

    function decPendingTranscribes() {
        state.pendingTranscribes = Math.max(0, state.pendingTranscribes - 1);
        if (state.pendingTranscribes === 0) {
            el.spinnerRow.addClass('hidden-important');
            el.progressContainer.removeClass('hidden-important');
            state.isTranscribing = false;
        }
    }

    // ---- Countdown overlay ----------------------------------------------------
    function updateCountdown(remainingMs) {
        // Only show in the last 5 seconds while actively recording
        if (!state.isRecording || remainingMs <= 0 || remainingMs > COUNTDOWN_WINDOW_MS) {
            hideCountdown();
            return;
        }
        const val = Math.max(1, Math.ceil(remainingMs / 1000)); // 5..1
        if (state.lastCountdownValue !== val) {
            state.lastCountdownValue = val;
            el.rotationCountdown.text(String(val));
            // trigger a quick "pop" animation
            el.rotationCountdown.removeClass('pop');
            // force reflow to restart animation
            void el.rotationCountdown[0].offsetWidth;
            el.rotationCountdown.addClass('pop');
        }
        el.rotationCountdown.removeClass('hidden-important').attr('aria-hidden', 'false');
    }

    function hideCountdown() {
        state.lastCountdownValue = null;
        if (el.rotationCountdown) {
            el.rotationCountdown.addClass('hidden-important').attr('aria-hidden', 'true');
        }
    }

    // ---- Progress cycle (rotates the recorder periodically) -------------------
    function startProgressCycle() {
        state.cycleStartTs = performance.now();
        stopProgressTick();
        state.progressTick = setInterval(onProgressTick, 100); // ~10 FPS
    }

    function stopProgressTick() {
        if (state.progressTick) clearInterval(state.progressTick);
        state.progressTick = null;
    }

    function resetProgressFill() {
        el.progressFill.css('width', '0%');
    }

    function onProgressTick() {
        // Recorder continues capturing; this only updates UI and triggers rotations.
        const now = performance.now();
        const elapsedThisRun = now - state.cycleStartTs;
        const totalElapsed = state.progressAccumMs + elapsedThisRun;

        const pct = Math.min(1, totalElapsed / PROGRESS_DURATION_MS);
        el.progressFill.css('width', (pct * 100).toFixed(3) + '%');

        // Update top-right countdown for last 5 seconds
        const remaining = PROGRESS_DURATION_MS - totalElapsed;
        updateCountdown(remaining);

        if (pct >= 1) {
            // One cycle elapsed: close current container and immediately continue recording.
            state.progressAccumMs = 0;
            state.cycleStartTs = performance.now();
            resetProgressFill();
            hideCountdown();

            // Loop limiting: stop after reaching the configured number of loops
            if (state.maxLoops != null) {
                state.loopCount = (state.loopCount || 0) + 1;
                if (state.loopCount >= state.maxLoops) {
                    // Finalize current audio and stop recording entirely
                    rotateRecorder('cycle-final', /* continueAfter */ false);
                    pauseProgress();
                    void setRecording(false);
                    // Reset loop limiter
                    state.maxLoops = null;
                    state.loopCount = 0;
                    return;
                }
            }

            rotateRecorder('cycle', /* continueAfter */ true);
        }
    }

    // Public helper: stop after N loops (use N=5 for the requested behavior)
    function stopAfterNLoops(n) {
        const num = Math.max(1, Math.floor(n || 1));
        state.loopCount = 0;
        state.maxLoops = num;
        announce(`Will stop after ${num} loop${num === 1 ? '' : 's'}.`);
    }

    // Convenience function specifically for 5 loops
    function stopAfterFiveLoops() {
        stopAfterNLoops(5);
    }


    function pauseProgress() {
        const now = performance.now();
        if (state.cycleStartTs != null) {
            state.progressAccumMs += Math.max(0, now - state.cycleStartTs);
        }
        stopProgressTick();
        hideCountdown();
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
        const span = $('<span>')
            .addClass('fresh bg-yellow-100 text-rose-600')
            .text(text);

        const needsSpace =
            el.transcript.text().length > 0 &&
            !/[\s\n]$/.test(el.transcript.text());
        if (needsSpace) el.transcript.append(document.createTextNode(' '));

        el.transcript.append(span);

        el.transcript.scrollTop(el.transcript[0].scrollHeight);
        placeCaretAtEnd(el.transcript);

        setTimeout(() => {
            span.removeClass('bg-yellow-100 text-rose-600');
        }, FRESH_MS);
    }

    // ---- Settings sheet -------------------------------------------------------
    function openSettings() {
        const existing = localStorage.getItem(LS_KEY) || '';
        el.apiKeyInput.val(existing);
        const rt = localStorage.getItem(LS_RUNTIME_KEY) || String(PROGRESS_DURATION_MS);
        if (el.runtimeSelect && el.runtimeSelect.length) {
            const valid = ['30000', '60000', '180000', '300000'];
            el.runtimeSelect.val(valid.includes(rt) ? rt : String(PROGRESS_DURATION_MS));
        }
        el.settingsSheet.removeClass('hidden-important').attr('aria-hidden', 'false');
    }

    function closeSettings() {
        el.settingsSheet.addClass('hidden-important').attr('aria-hidden', 'true');
    }

    function applyProgressAnimationDuration() {
        try {
            if (el.progressBar && el.progressBar.length) {
                el.progressBar[0].style.setProperty('--progress-duration', PROGRESS_DURATION_MS + 'ms');
            }
        } catch (_) {
        }
    }

    function saveApiKey() {
        const val = (el.apiKeyInput.val() || '').trim();
        try {
            localStorage.setItem(LS_KEY, val);
            if (el.runtimeSelect && el.runtimeSelect.length) {
                const sel = String(el.runtimeSelect.val() || '');
                const valid = ['30000', '60000', '180000', '300000'];
                const toStore = valid.includes(sel) ? sel : '30000';
                localStorage.setItem(LS_RUNTIME_KEY, toStore);
                PROGRESS_DURATION_MS = parseInt(toStore, 10) || 30000;
                applyProgressAnimationDuration();
            }
            announce('Settings saved to local storage.');
            closeSettings();
        } catch (e) {
            announce('Could not save settings.');
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
                const ta = $('<textarea>').val(text).appendTo('body').css({position: 'fixed', top: '-1000px'});
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

    // ---- Media: microphone + MediaRecorder -----------------------------------
    function getSupportedMimeType() {
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4'
        ];
        for (const type of candidates) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
        }
        return '';
    }

    async function initMic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            announce('Microphone not supported in this browser.');
            console.error('getUserMedia not supported');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            state.mediaStream = stream;
            startRecorder(stream);
            announce('Microphone ready. Recording started.');
        } catch (e) {
            announce('Microphone permission denied or unavailable.');
            console.error(e);
        }
    }

    function startRecorder(stream) {
        const mimeType = getSupportedMimeType();
        const mr = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
        state.mediaRecorder = mr;
        state.chunkParts = [];
        state.chunkStartTs = performance.now();

        mr.addEventListener('dataavailable', (ev) => {
            if (ev.data && ev.data.size > 0) {
                state.chunkParts.push(ev.data);
            }
        });

        mr.addEventListener('stop', () => {
            try {
                if (state.chunkParts.length > 0) {
                    const type = mr.mimeType || 'audio/webm';
                    const blob = new Blob(state.chunkParts, {type});
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    const ext =
                        type.includes('webm') ? 'webm' :
                            type.includes('ogg') ? 'ogg' :
                                type.includes('mp4') ? 'm4a' : 'webm';
                    const fileName = `voice-${ts}.${ext}`;
                    const file = new File([blob], fileName, {type, lastModified: Date.now()});

                    state.chunkParts = [];

                    void sendForTranscription(file);
                }
            } catch (e) {
                console.error('Failed to build audio file:', e);
            }
        });

        // Use a small timeslice so dataavailable fires regularly (and to minimize loss on stop).
        mr.start(1000); // 1 second slices
    }

    function rotateRecorder(reason, continueAfter) {
        try {
            if (!state.mediaRecorder) return;

            const stream = state.mediaStream;
            const shouldRestart = !!continueAfter;

            state.mediaRecorder.addEventListener('stop', function restartOnce() {
                state.mediaRecorder.removeEventListener('stop', restartOnce);
                if (shouldRestart && state.isRecording && stream) {
                    setTimeout(() => startRecorder(stream), 1);
                }
            }, {once: true});

            try {
                state.mediaRecorder.requestData();
            } catch (_) {}
            state.mediaRecorder.stop();
        } catch (e) {
            console.warn('rotateRecorder failed:', e);
        }
    }

    async function sendForTranscription(file) {
        try {
            incPendingTranscribes();

            const apiKey = (localStorage.getItem(LS_KEY) || '').trim();
            if (!apiKey) {
                announce('Missing OpenAI API key. Please add it in Settings.');
                console.warn('OpenAI API key missing.');
                return;
            }

            const formData = new FormData();
            formData.append('file', file, file.name);
            formData.append('model', 'gpt-4o-transcribe');

            const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`
                },
                body: formData
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.error('OpenAI transcription error:', res.status, errText);
                announce('Transcription failed.');
                return;
            }

            const data = await res.json();
            const text =
                (typeof data === 'object' && data && typeof data.text === 'string')
                    ? data.text
                    : (typeof data === 'string' ? data : '');

            if (text) {
                appendTranscript(text);
            } else {
                console.warn('No transcript text in response:', data);
            }
        } catch (e) {
            console.error('Transcription failed:', e);
            announce('Transcription failed.');
        } finally {
            decPendingTranscribes();
        }
    }

    // ---- Public API (for external orchestration if needed) --------------------
    function startTranscribe() {
        showSpinner(true);
    }

    function finishTranscribe() {
        showSpinner(false);
        resetProgressFill();
        if (state.isRecording) startProgressCycle();
    }

    // Toggle recording with proper recorder/timer/progress control and permissions.
    async function setRecording(stateBool) {
        if (stateBool === state.isRecording) return;

        if (stateBool) {
            // Transition: paused -> recording
            setRecordingUI(true);

            if (!state.mediaStream) {
                await initMic(); // starts recorder on success
            } else if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
                startRecorder(state.mediaStream);
            } else if (state.mediaRecorder.state === 'paused') {
                try {
                    state.mediaRecorder.resume();
                } catch (e) {
                    console.warn('Resume failed:', e);
                }
            }

            resumeProgress();
            startTimer();
        } else {
            // Transition: recording -> paused
            setRecordingUI(false);

            // Finalize current audio container and do NOT continue recording afterward
            rotateRecorder('pause', /* continueAfter */ false);

            // Pause progress and reset
            pauseProgress();
            state.progressAccumMs = 0;
            resetProgressFill();

            // Stop and reset the user-visible timer
            stopTimer();
            state.timerAccumMs = 0;
            el.timerLabel.text('00:00');
        }
    }

    // ---- Event wiring ---------------------------------------------------------
    function bindEvents() {
        // Main Record/Pause FAB
        el.mainBtn.on('click', () => {
            void setRecording(!state.isRecording);
        });

        // Copy transcript
        el.copyBtn.on('click', copyTranscript);

        // Settings
        el.settingsBtn.on('click', openSettings);
        el.closeSettingsBtn.on('click', closeSettings);
        el.saveApiKeyBtn.on('click', saveApiKey);

        // ESC closes settings sheet
        $(document).on('keydown', (e) => {
            if (e.key === 'Escape') closeSettings();
        });

        // On page unload, try to finalize any active recorder
        window.addEventListener('beforeunload', () => {
            try {
                if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
                    state.mediaRecorder.stop();
                }
            } catch (_) {}
        });
    }

    // ---- Init -----------------------------------------------------------------
    function init() {
        cacheDom();
        bindEvents();

        // Load runtime setting from localStorage
        try {
            const saved = localStorage.getItem(LS_RUNTIME_KEY);
            if (saved) {
                const ms = parseInt(saved, 10);
                if ([30000, 60000, 180000, 300000].includes(ms)) {
                    PROGRESS_DURATION_MS = ms;
                }
            }
        } catch (_) {}

        // Ensure the CSS animation duration matches the runtime setting
        applyProgressAnimationDuration();

        // Start UI in paused mode. We'll request microphone on first Record tap.
        setRecordingUI(false);
        resetProgressFill();
        el.timerLabel.text('00:00');

        // Expose a small API (optional)
        window.App = window.App || {};
        Object.assign(window.App, {
            appendTranscript,   // App.appendTranscript("new words...")
            startTranscribe,    // App.startTranscribe()
            finishTranscribe,   // App.finishTranscribe()
            setRecording,       // App.setRecording(true/false) — returns a Promise
            stopAfterNLoops,    // App.stopAfterNLoops(n)
            stopAfterFiveLoops  // App.stopAfterFiveLoops()
        });

    }

    $(init);
})(window, jQuery);
