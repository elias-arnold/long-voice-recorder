(function (window, $) {
    'use strict';

    // ---- Config you can tweak -----------------------------------------------
    const PROGRESS_TOTAL_MS = 0.5 * 60 * 1000;    // 5 minutes
    const FRESH_MS = 10_000;                    // highlight new text for 10s
    const SIMULATE_TRANSCRIBE = false;          // set false when wired to backend
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
        timerAccumMs: 0,          // total recording time for label

        // Microphone/recording
        mediaStream: null,
        mediaRecorder: null,
        chunkParts: [],
        chunkStartTs: null,
        pendingTranscribes: 0
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

    // Keep spinner in sync with multiple concurrent transcriptions
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
        if (!state.isRecording || state.isTranscribing /* UI-only; recorder continues */) {
            // Note: we keep MediaRecorder running even if spinner shows
        }

        const now = performance.now();
        const elapsedThisRun = now - state.cycleStartTs;
        const totalElapsed = state.progressAccumMs + elapsedThisRun;

        const pct = Math.min(1, totalElapsed / PROGRESS_TOTAL_MS);
        el.progressFill.css('width', (pct * 100).toFixed(3) + '%');

        if (pct >= 1) {
            // One 5-min chunk ended: finalize current file and immediately continue
            state.progressAccumMs = 0;
            state.cycleStartTs = performance.now();
            resetProgressFill();
            rotateRecorder('timer', /* continueAfter */ true);
        }
    }

    function rotateRecorder(reason, continueAfter) {
        try {
            if (!state.mediaRecorder) return;

            // Stopping the recorder ensures a finalized container (fixes "file unsupported" issues)
            const stream = state.mediaStream;
            const shouldRestart = !!continueAfter;

            // On stop handler will package and send the file; restart after a short tick to allow stop to flush
            state.mediaRecorder.addEventListener('stop', function restartOnce() {
                state.mediaRecorder.removeEventListener('stop', restartOnce);
                if (shouldRestart && state.isRecording && stream) {
                    // Small delay to avoid "Invalid state" on immediate restart in some browsers
                    setTimeout(() => startRecorder(stream), 10);
                }
            }, { once: true });

            // Request the last buffered data slice before stopping
            try { state.mediaRecorder.requestData(); } catch (_) {}
            state.mediaRecorder.stop();
        } catch (e) {
            console.warn('rotateRecorder failed:', e);
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

    // ---- Microphone + MediaRecorder ------------------------------------------
    function getSupportedMimeType() {
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4' // fallback for Safari (if supported)
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
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.mediaStream = stream;
            startRecorder(stream);
            // Stop the demo generator once the real mic is on
            if (window.App && typeof window.App.disableDemo === 'function') {
                window.App.disableDemo();
            }
            announce('Microphone ready. Recording started.');
        } catch (e) {
            announce('Microphone permission denied or unavailable.');
            console.error(e);
        }
    }


    function startRecorder(stream) {
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
            // Build a finalized container from all parts collected since last start
            try {
                if (state.chunkParts.length > 0) {
                    const type = mr.mimeType || 'audio/webm';
                    const blob = new Blob(state.chunkParts, { type });
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    const ext =
                        type.includes('webm') ? 'webm' :
                            type.includes('ogg') ? 'ogg' :
                                type.includes('mp4') ? 'm4a' : 'webm';
                    const fileName = `voice-${ts}.` + ext;
                    const file = new File([blob], fileName, { type, lastModified: Date.now() });
                    // Reset parts for next session
                    state.chunkParts = [];
                    // Send out for transcription
                    void sendForTranscription(file);
                }
            } catch (e) {
                console.error('Failed to build audio file:', e);
            }
        });

        // Use a small timeslice so dataavailable fires regularly
        mr.start(1000); // 1s slices
    }


    function finalizeChunk(reason) {
        try {
            if (!state.chunkParts.length) {
                state.chunkStartTs = performance.now();
                return;
            }
            const type = state.mediaRecorder && state.mediaRecorder.mimeType ? state.mediaRecorder.mimeType : 'audio/webm';
            const blob = new Blob(state.chunkParts, { type });
            const startedAt = state.chunkStartTs || performance.now();
            const endedAt = performance.now();
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const ext =
                type.includes('webm') ? 'webm' :
                    type.includes('ogg') ? 'ogg' :
                        type.includes('mp4') ? 'm4a' : 'dat';
            const fileName = `voice-${ts}-${reason}.${ext}`;
            const file = new File([blob], fileName, { type, lastModified: Date.now() });

            // Reset for next rolling chunk
            state.chunkParts = [];
            state.chunkStartTs = endedAt;

            // Send for transcription (non-blocking)
            void sendForTranscription(file);
        } catch (e) {
            console.error('Failed to finalize chunk:', e);
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
                    // Do NOT set Content-Type; the browser will set the multipart boundary.
                },
                body: formData
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.error('OpenAI transcription error:', res.status, errText);
                announce('Transcription failed.');
                return;
            }

            // API returns JSON with `text` field for plain text responses.
            // If your account returns verbose JSON, adapt parsing accordingly.
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
            try {
                if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
                    state.mediaRecorder.resume();
                } else if ((!state.mediaRecorder || state.mediaRecorder.state === 'inactive') && state.mediaStream) {
                    // If there is no active recorder, start a fresh one
                    startRecorder(state.mediaStream);
                }
            } catch (e) {
                console.warn('Resume recorder failed:', e);
            }
        } else {
            // Pause -> finalize current chunk for transcription and reset timer
            setRecordingUI(false);

            // Finalize a proper, closed audio container and do NOT continue recording after
            rotateRecorder('pause', /* continueAfter */ false);

            // Pause and reset the 5-min progress
            pauseProgress();
            state.progressAccumMs = 0;
            resetProgressFill();

            // Reset the mm:ss timer label
            state.timerAccumMs = 0;
            el.timerLabel.text('00:00');
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

        // Finalize any remaining audio before the page unloads
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

        // Start UI in "recording" as per initial HTML
        setRecordingUI(true);
        resetProgressFill();
        startProgressCycle();
        startTimer();

        // Initialize microphone + recorder
        initMic();

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
        // let demo = setInterval(() => {
        //     if (!state.isRecording || state.isTranscribing) return;
        //     appendTranscript('demo input');
        // }, 4000);
        // // Stop demo once you wire real input:
        // window.App.disableDemo = () => { clearInterval(demo); };
    }

    $(init);
})(window, jQuery);
