(function (window, $) {
    'use strict';

    // ---- Configuration --------------------------------------------------------
    // Duration of one "progress cycle" before forcing a recorder rotation.
    // Note: UI animations can be longer/shorter, but this governs when a proper,
    // closed audio container is formed and sent for transcription.
    const PROGRESS_DURATION_MS = 30 * 1000;      // 30 seconds
    const FRESH_MS = 10_000;                     // highlight new text for 10 seconds
    const LS_KEY = 'OPENAI_API_KEY';             // localStorage key for OpenAI API key

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
        pendingTranscribes: 0
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

    // ---- Small utilities ------------------------------------------------------
    function fmtMMSS(ms) {
        // Formats a given time in milliseconds into a MM:SS string representation.
        const t = Math.floor(ms / 1000);
        const m = String(Math.floor(t / 60)).padStart(2, '0');
        const s = String(t % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    function announce(msg) {
        // Updates an aria-live region so screen readers inform the user.
        el.liveRegion.text(msg);
    }

    function placeCaretAtEnd(node) {
        // Ensures caret stays at the end of the contenteditable transcript box.
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
    }

    function showSpinner(show) {
        // Mutually exclusive visibility: while spinner is shown, progress bar is hidden.
        el.spinnerRow.toggleClass('hidden-important', !show);
        el.progressContainer.toggleClass('hidden-important', show);
        state.isTranscribing = !!show;
    }

    function incPendingTranscribes() {
        // Keep spinner visible while any transcription calls are in-flight.
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

    // ---- Progress cycle (rotates the recorder periodically) -------------------
    function startProgressCycle() {
        // Resets the "run" start time and kicks a periodic update.
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

        if (pct >= 1) {
            // One cycle elapsed: close current container and immediately continue recording.
            state.progressAccumMs = 0;
            state.cycleStartTs = performance.now();
            resetProgressFill();
            rotateRecorder('cycle', /* continueAfter */ true);
        }
    }

    function pauseProgress() {
        // Accumulates elapsed time within the current cycle and halts updates.
        const now = performance.now();
        if (state.cycleStartTs != null) {
            state.progressAccumMs += Math.max(0, now - state.cycleStartTs);
        }
        stopProgressTick();
    }

    function resumeProgress() {
        // Resumes the cycle updates without resetting the accumulated progress.
        state.cycleStartTs = performance.now();
        if (!state.progressTick) {
            state.progressTick = setInterval(onProgressTick, 100);
        }
    }

    // ---- Timer label (mm:ss) --------------------------------------------------
    function startTimer() {
        // Starts the user-visible elapsed timer. Resumes from current accum.
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
        // Appends new text, briefly highlighted, keeps scroll and caret at the end.
        const span = $('<span>')
            .addClass('fresh bg-yellow-100 text-rose-600')
            .text(text);

        const needsSpace =
            el.transcript.text().length > 0 &&
            !/[\s\n]$/.test(el.transcript.text());
        if (needsSpace) el.transcript.append(document.createTextNode(' '));

        el.transcript.append(span);

        // Keep view scrolled to bottom & caret at end
        el.transcript.scrollTop(el.transcript[0].scrollHeight);
        placeCaretAtEnd(el.transcript);

        // Remove the highlight after FRESH_MS
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
        // Attempts secure clipboard API first; falls back to execCommand for HTTP.
        const text = el.transcript.text();
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
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

    // ---- Media: microphone + MediaRecorder -----------------------------------
    function getSupportedMimeType() {
        // Returns the first supported audio container/codec combination.
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4' // sometimes Safari supports MPEG-4 AAC (container m4a)
        ];
        for (const type of candidates) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
        }
        return '';
    }

    async function initMic() {
        // Requests mic permission and primes the recording stream.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            announce('Microphone not supported in this browser.');
            console.error('getUserMedia not supported');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.mediaStream = stream;
            startRecorder(stream);
            announce('Microphone ready. Recording started.');
        } catch (e) {
            announce('Microphone permission denied or unavailable.');
            console.error(e);
        }
    }

    function startRecorder(stream) {
        // Starts a MediaRecorder with small time slices so dataavailable fires regularly.
        const mimeType = getSupportedMimeType();
        const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        state.mediaRecorder = mr;
        state.chunkParts = [];
        state.chunkStartTs = performance.now();

        mr.addEventListener('dataavailable', (ev) => {
            if (ev.data && ev.data.size > 0) {
                state.chunkParts.push(ev.data);
            }
        });

        mr.addEventListener('stop', () => {
            // On stop we finalize the container from the collected parts and dispatch it.
            try {
                if (state.chunkParts.length > 0) {
                    const type = mr.mimeType || 'audio/webm';
                    const blob = new Blob(state.chunkParts, { type });
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    const ext =
                        type.includes('webm') ? 'webm' :
                            type.includes('ogg')  ? 'ogg'  :
                                type.includes('mp4')  ? 'm4a'  : 'webm';
                    const fileName = `voice-${ts}.${ext}`;
                    const file = new File([blob], fileName, { type, lastModified: Date.now() });

                    // Reset for next session
                    state.chunkParts = [];

                    // Fire-and-forget transcription
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
        // Gracefully stops and (optionally) restarts the MediaRecorder to ensure
        // we produce a finalized audio container usable by transcription services.
        try {
            if (!state.mediaRecorder) return;

            const stream = state.mediaStream;
            const shouldRestart = !!continueAfter;

            state.mediaRecorder.addEventListener('stop', function restartOnce() {
                state.mediaRecorder.removeEventListener('stop', restartOnce);
                if (shouldRestart && state.isRecording && stream) {
                    // Slight delay avoids InvalidStateError on some browsers
                    setTimeout(() => startRecorder(stream), 1);
                }
            }, { once: true });

            // Request the last buffered data chunk before stopping
            try { state.mediaRecorder.requestData(); } catch (_) {}
            state.mediaRecorder.stop();
        } catch (e) {
            console.warn('rotateRecorder failed:', e);
        }
    }

    async function sendForTranscription(file) {
        // Sends the audio file to the transcription API and appends resulting text.
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
                    // Important: do not set Content-Type when sending FormData.
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
        // Shows the spinner and hides progress while an external transcription runs.
        showSpinner(true);
    }

    function finishTranscribe() {
        // Hides the spinner, restores progress UI, and ensures progress continues if recording.
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

            // Ensure we have mic permission and a stream, then start/continue the recorder
            if (!state.mediaStream) {
                await initMic(); // starts recorder on success
            } else if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
                startRecorder(state.mediaStream);
            } else if (state.mediaRecorder.state === 'paused') {
                try { state.mediaRecorder.resume(); } catch (e) { console.warn('Resume failed:', e); }
            }

            // Start/resume UI cycles
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
            // Fire-and-forget async toggling (no need to await)
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
            setRecording        // App.setRecording(true/false) — returns a Promise
        });
    }

    $(init);
})(window, jQuery);
