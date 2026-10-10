/* MD-TOOL — front end.
 *
 * Three states, driven by one job:
 *
 *   form        pick a URL + format, press "Fetch & Convert"
 *   loading     live phase text pushed over SSE from the server
 *   success     video title / thumbnail / duration + "Download File to Device"
 *
 * The file stays staged on the server until the user clicks the save button, so
 * that click is a plain link navigation: the browser streams it straight to
 * disk using the Content-Disposition filename, with nothing buffered in JS.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    form: $('form'),
    url: $('url'),
    urlError: $('url-error'),
    clearBtn: $('clear-btn'),
    pasteBtn: $('paste-btn'),

    formats: $('formats'),

    convertBtn: $('convert-btn'),
    convertSpinner: $('convert-spinner'),
    convertLabel: $('convert-label'),

    loadingPanel: $('loading-panel'),
    phaseText: $('phase-text'),
    phaseSub: $('phase-sub'),
    phasePct: $('phase-pct'),
    phaseBar: $('phase-bar'),
    cancelBtn: $('cancel-btn'),

    successCard: $('success-card'),
    resultThumb: $('result-thumb'),
    resultTitle: $('result-title'),
    resultDuration: $('result-duration'),
    resultDurationWrap: $('result-duration-wrap'),
    resultUploader: $('result-uploader'),
    resultUploaderWrap: $('result-uploader-wrap'),
    resultSize: $('result-size'),
    resultFilename: $('result-filename'),
    saveBtn: $('save-btn'),
    saveHint: $('save-hint'),
    againBtn: $('again-btn'),

    error: $('error'),
    errorText: $('error-text'),
    errorClose: $('error-close'),

    engineStatus: $('engine-status'),
    engineDot: $('engine-dot'),
    engineLabel: $('engine-label'),
    expiryNote: $('expiry-note'),
  };

  const state = {
    format: 'mp4',
    formats: [],
    jobId: null,
    events: null,
    settled: false,
    processing: false,
  };

  /* ── utilities ─────────────────────────────────────────────── */

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** Mirrors lib/validate.js closely enough to give instant, offline feedback. */
  function validateClient(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return { ok: false, error: 'Paste a video URL to begin.' };
    if (value.length > 2048) return { ok: false, error: 'That URL is too long to be useful.' };

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return { ok: false, error: "That doesn't look like a valid URL." };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Only http:// and https:// URLs are supported.' };
    }
    return { ok: true, url: parsed.toString() };
  }

  function showUrlError(message) {
    el.urlError.textContent = message;
    el.urlError.hidden = false;
  }

  function clearUrlError() {
    el.urlError.hidden = true;
    el.urlError.textContent = '';
  }

  function showError(message) {
    el.errorText.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.hidden = true;
    el.errorText.textContent = '';
  }

  /* ── format tabs ───────────────────────────────────────────── */

  const FALLBACK_FORMATS = [
    { id: 'mp4', label: 'MP4', tabLabel: 'MP4 Video', kind: 'video', featured: true },
    { id: 'mp3', label: 'MP3', tabLabel: 'MP3 Audio', kind: 'audio', featured: true },
  ];

  /** The spec calls for exactly two tabs, so only featured formats are shown. */
  function tabs() {
    return state.formats.filter((format) => format.featured !== false);
  }

  function renderTabs() {
    el.formats.replaceChildren(
      ...tabs().map((format) => {
        const active = format.id === state.format;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.format = format.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(active));
        button.title = format.hint || '';
        button.className = active ? 'tab is-active' : 'tab';
        button.textContent = format.tabLabel || format.label;
        return button;
      })
    );
  }

  function setFormat(id) {
    if (!tabs().some((f) => f.id === id)) return;
    state.format = id;
    renderTabs();
    try {
      localStorage.setItem('wmt:format', id);
    } catch {
      /* storage may be unavailable */
    }
  }

  el.formats.addEventListener('click', (event) => {
    const button = event.target.closest('[data-format]');
    if (button) setFormat(button.dataset.format);
  });

  /* ── view switching ────────────────────────────────────────── */

  function showView(view) {
    el.form.hidden = view !== 'form';
    el.loadingPanel.hidden = view !== 'loading';
    el.successCard.hidden = view !== 'success';
  }

  function setProcessing(active) {
    state.processing = active;
    el.convertBtn.disabled = active;
    el.convertSpinner.hidden = !active;
    el.convertLabel.textContent = active ? 'working…' : 'Fetch & Convert';
  }

  const PHASE_FALLBACK = {
    queued: 'Queued...',
    metadata: 'Extracting metadata...',
    downloading: 'Downloading media...',
    converting: 'Converting stream...',
    finalizing: 'Finalizing file...',
    ready: 'Ready',
  };

  function renderPhase(job) {
    // Prefer the server's label; fall back to a local copy if the server is an
    // older build.
    const text = job.phaseText || PHASE_FALLBACK[job.phase] || 'Working...';
    el.phaseText.textContent = text;

    const hasPct = typeof job.pct === 'number' && Number.isFinite(job.pct);
    if (hasPct) {
      const pct = Math.max(0, Math.min(100, Math.round(job.pct)));
      el.phasePct.textContent = `${pct}%`;
      el.phaseBar.className = 'fill';
      el.phaseBar.style.width = `${pct}%`;
    } else {
      el.phasePct.textContent = '';
      el.phaseBar.className = 'fill bar-indeterminate';
      el.phaseBar.style.width = '';
    }

    el.phaseSub.textContent =
      job.phase === 'converting'
        ? 'running ffmpeg'
        : job.phase === 'downloading'
          ? 'transferring from source'
          : job.phase === 'finalizing'
            ? 'preparing the file'
            : 'this can take a moment';
  }

  /* ── success card ──────────────────────────────────────────── */

  function renderSuccess(job) {
    const info = job.info ?? {};
    const file = job.file ?? {};

    el.resultTitle.textContent = info.title || file.name || 'Your file';

    const duration = formatDuration(info.duration);
    el.resultDuration.textContent = duration;
    el.resultDurationWrap.hidden = !duration;

    el.resultUploader.textContent = info.uploader || '';
    el.resultUploaderWrap.hidden = !info.uploader;

    el.resultSize.textContent = formatBytes(file.size);

    if (info.thumbnail) {
      el.resultThumb.src = info.thumbnail;
      // Descriptive alt text for the preview (empty when there is no image).
      el.resultThumb.alt = info.title ? `Thumbnail for ${info.title}` : 'Video thumbnail';
      el.resultThumb.hidden = false;
    } else {
      el.resultThumb.removeAttribute('src');
      el.resultThumb.alt = '';
      el.resultThumb.hidden = true;
    }

    el.resultFilename.textContent = file.name || '';
    el.resultFilename.hidden = !file.name;

    // A plain link: the browser streams the staged file to disk itself.
    el.saveBtn.href = `/api/jobs/${encodeURIComponent(job.id)}/file`;
    el.saveBtn.setAttribute('download', file.name || '');
    el.saveBtn.classList.remove('is-done');
    el.saveBtn.removeAttribute('aria-disabled');
    el.saveHint.textContent = 'saving to your device…';
    el.saveHint.hidden = true;

    if (job.expiresAt) {
      const minutes = Math.round((job.expiresAt - Date.now()) / 60000);
      if (minutes > 0) {
        el.expiryNote.textContent = `staged file expires in ${minutes} min`;
        el.expiryNote.hidden = false;
      }
    }
  }

  el.saveBtn.addEventListener('click', () => {
    // Navigation is the browser's job; this handler is feedback only.
    el.saveHint.textContent = 'saving to your device…';
    el.saveHint.hidden = false;

    // The server releases the staged file as soon as the stream finishes, so
    // this is deliberately a one-shot action.
    setTimeout(() => {
      el.saveHint.textContent = 'saved — the server released the staged file.';
      el.saveBtn.classList.add('is-done');
      el.saveBtn.setAttribute('aria-disabled', 'true');
    }, 1500);
  });

  el.againBtn.addEventListener('click', () => {
    closeEvents();
    state.jobId = null;
    state.settled = false;
    el.expiryNote.hidden = true;
    clearError();
    clearUrlError();
    showView('form');
    setProcessing(false);
    el.url.focus();
    el.url.select();
  });

  el.cancelBtn.addEventListener('click', async () => {
    const id = state.jobId;
    closeEvents();
    setProcessing(false);
    showView('form');
    if (!id) return;
    try {
      await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* the job will expire on its own */
    }
  });

  /* ── job lifecycle ─────────────────────────────────────────── */

  function closeEvents() {
    if (state.events) {
      state.events.close();
      state.events = null;
    }
  }

  function applyJob(job) {
    if (job.status === 'processing') {
      renderPhase(job);
      return;
    }

    state.settled = true;
    closeEvents();
    setProcessing(false);

    if (job.status === 'ready') {
      renderSuccess(job);
      showView('success');
      return;
    }

    if (job.status === 'cancelled') {
      showView('form');
      return;
    }

    // error
    showView('form');
    showError(job.error?.message || 'That conversion failed.');
  }

  /** One-shot read, used when the SSE stream cannot be established. */
  async function pollJob(id) {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
      const payload = await res.json().catch(() => null);
      if (payload?.job) applyJob(payload.job);
      else if (res.status === 404) {
        showView('form');
        setProcessing(false);
        showError('That job no longer exists on the server.');
      }
    } catch {
      /* keep the last known state; SSE may still recover */
    }
  }

  function watchJob(id) {
    closeEvents();
    state.settled = false;

    const events = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    state.events = events;

    events.onmessage = (event) => {
      let job;
      try {
        job = JSON.parse(event.data);
      } catch {
        return;
      }
      applyJob(job);
    };

    events.onerror = () => {
      // EventSource retries automatically, which would hammer a settled job.
      if (state.settled) {
        closeEvents();
        return;
      }
      // Fall back to a single poll in case the stream is simply unavailable.
      pollJob(id);
    };
  }

  async function startJob(url) {
    clearError();
    setProcessing(true);
    showView('loading');
    el.phaseText.textContent = 'Extracting metadata...';
    el.phaseSub.textContent = 'this can take a moment';
    el.phasePct.textContent = '';
    el.phaseBar.className = 'fill bar-indeterminate';
    el.phaseBar.style.width = '';
    el.expiryNote.hidden = true;

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format: state.format }),
      });

      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        showView('form');
        setProcessing(false);
        showError(payload?.error?.message || `The server refused that request (HTTP ${res.status}).`);
        return;
      }

      const job = payload?.job;
      if (!job?.id) {
        showView('form');
        setProcessing(false);
        showError('The server returned an unexpected response.');
        return;
      }

      state.jobId = job.id;
      renderPhase(job);

      // Already finished before the stream opened (small files).
      if (job.status !== 'processing') {
        applyJob(job);
        return;
      }
      watchJob(job.id);
    } catch (err) {
      showView('form');
      setProcessing(false);
      showError(
        err instanceof TypeError
          ? 'Could not reach the server. Is it still running?'
          : err.message || 'The request failed.'
      );
    }
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();

    const check = validateClient(el.url.value);
    if (!check.ok) {
      showUrlError(check.error);
      el.url.focus();
      return;
    }

    clearUrlError();
    startJob(check.url);
  });

  /* ── input handling ────────────────────────────────────────── */

  el.url.addEventListener('input', () => {
    el.clearBtn.hidden = el.url.value === '';
    const check = validateClient(el.url.value);
    if (el.url.value.trim() !== '' && check.ok) clearUrlError();
  });

  el.clearBtn.addEventListener('click', () => {
    el.url.value = '';
    el.clearBtn.hidden = true;
    clearUrlError();
    el.url.focus();
  });

  el.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      el.url.value = text.trim();
      el.clearBtn.hidden = false;
      clearUrlError();
      el.url.focus();
    } catch {
      showError('Clipboard access was blocked. Paste into the field with Ctrl/Cmd+V instead.');
    }
  });

  el.errorClose.addEventListener('click', clearError);

  /* ── engine health ─────────────────────────────────────────── */

  async function checkEngine() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();

      if (data.ok) {
        el.engineDot.className = 'dot dot-ready';
        el.engineLabel.textContent = 'engine ready';
        el.engineStatus.title =
          `yt-dlp ${data.engine.ytdlp.version || '?'} · ffmpeg ${data.engine.ffmpeg.version || '?'}`;
      } else {
        const missing = [
          !data.engine.ytdlp.available && 'yt-dlp',
          !data.engine.ffmpeg.available && 'ffmpeg',
        ]
          .filter(Boolean)
          .join(' + ');
        el.engineDot.className = 'dot dot-error';
        el.engineLabel.textContent = `missing ${missing}`;
        el.engineLabel.className = 'is-error';
        showError(`The server could not find ${missing}. Install it and restart to enable downloads.`);
      }
    } catch {
      el.engineDot.className = 'dot dot-error';
      el.engineLabel.textContent = 'offline';
      el.engineLabel.className = 'is-error';
      showError('Could not reach the server. Start it with "npm start" and reload.');
    }
  }

  /* ── boot ──────────────────────────────────────────────────── */

  async function init() {
    try {
      const res = await fetch('/api/formats');
      const data = await res.json();
      state.formats =
        Array.isArray(data.formats) && data.formats.length ? data.formats : FALLBACK_FORMATS;
    } catch {
      state.formats = FALLBACK_FORMATS;
    }

    try {
      const stored = localStorage.getItem('wmt:format');
      if (stored && tabs().some((f) => f.id === stored)) state.format = stored;
    } catch {
      /* storage may be unavailable */
    }

    renderTabs();
    showView('form');
    setProcessing(false);
    checkEngine();
  }

  init();
})();
