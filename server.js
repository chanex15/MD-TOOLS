/**
 * MD-TOOL — Express server.
 *
 * Primary flow (two steps, so the UI can show a success card before the file
 * moves):
 *   POST /api/jobs              -> 202, starts one yt-dlp process, returns a job
 *   GET  /api/jobs/:id/events   -> SSE stream of phase updates
 *   GET  /api/jobs/:id/file     -> streams the finished file as an attachment
 *
 * Supporting routes:
 *   GET  /api/health            -> engine readiness (yt-dlp + ffmpeg)
 *   GET  /api/formats           -> selectable output formats
 *   GET  /api/info?url=         -> metadata preview
 *   GET  /api/download?url=&…   -> one-shot process-and-stream escape hatch
 *   DELETE /api/jobs/:id        -> discard a job and free its temp directory
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { FORMAT_LIST, resolveFormat, mimeForExtension } from './lib/formats.js';
import {
  buildAttachmentName,
  contentDisposition,
  checkEngine,
  downloadToTemp,
  fetchInfo,
  friendlyError,
  removeTempDir,
  safeKill,
  sweepStaleTempDirs,
  TEMP_ROOT,
  YtDlpError,
} from './lib/downloader.js';
import {
  activeCount,
  cancelJob,
  createJob,
  deleteJob,
  getJob,
  publicJob,
  registerProcess,
  setPhase,
  startJobSweeper,
  shutdownJobs,
  subscribe,
  updateJob,
  JOB_TTL_MS,
} from './lib/jobs.js';
import { validateUrl } from './lib/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 3);

// Per-client request budget. Separate from MAX_CONCURRENT: this bounds how
// often a client may ask, that bounds how many conversions run at once.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);

// Absolute origin used by canonical/OG tags, sitemap.xml and robots.txt. Set
// SITE_URL in production (e.g. https://mdtool.example.com); it defaults to the
// local server so nothing is ever emitted with a wrong host.
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// The origin the shipped index.html uses in its own meta tags; swapped for
// SITE_URL at serve time so the static file also works when opened directly.
const TEMPLATE_ORIGIN = 'http://localhost:3000';
// Optional Search Console token; injected into <head> only when provided.
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';

const app = express();
app.disable('x-powered-by');

/**
 * How many proxy hops to trust when deriving the client address.
 *
 * Express only reads X-Forwarded-For when `trust proxy` is set, and trusting it
 * unconditionally would let any client spoof its own address (or someone
 * else's, to exhaust their budget). So it is opt-in and explicit:
 *
 *   unset      → the app is exposed directly; req.ip is the socket address.
 *   TRUST_PROXY=1 → one front proxy (Fly.io, Render, Railway, nginx); hop count.
 *   TRUST_PROXY=true, or a comma-separated subnet list → passed through as-is.
 *
 * Render/Railway/Fly all front the app with a local proxy, so without this every
 * visitor shares a single rate-limit bucket.
 */
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY);
app.use(express.json({ limit: '16kb' }));

/** @param {string | undefined} raw @returns {boolean | number | string[]} */
function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') return true;
  // A bare number is a hop count; Express would otherwise read "1" as a subnet.
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendError(res, status, message, code = 'error') {
  if (res.headersSent) {
    // A body already started; the only honest signal left is to break the
    // connection so the client does not keep a truncated file.
    res.destroy();
    return;
  }
  res.status(status).json({ error: { message, code } });
}

/** In-flight counter so one caller cannot monopolise the engine. */
let inFlight = 0;
function acquireSlot() {
  if (inFlight >= MAX_CONCURRENT) return false;
  inFlight += 1;
  return true;
}
function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateBuckets = new Map();

/** Fixed-window limiter. Cheap, and adequate for a single-user utility. */
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || 'unknown';

  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;

  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - bucket.count)));

  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return sendError(res, 429, `Too many requests. Try again in ${retryAfter}s.`, 'rate_limited');
  }

  next();
}

const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS);
rateSweep.unref?.();

/** Kill a spawned process when the requesting client disconnects. */
function makeRequestSignal(req, res) {
  let child = null;
  let aborted = false;

  const onClose = () => {
    // A finished response also emits 'close'; only a premature one is an abort.
    if (res.writableEnded || res.writableFinished) return;
    aborted = true;
    safeKill(child);
  };

  // Deliberately NOT listening on req 'close'. As soon as a request body has
  // been fully consumed — which express.json() does for every POST — Node emits
  // 'close' on the request stream even though the client is still connected and
  // waiting. Treating that as a disconnect killed the child and returned no
  // response, hanging the request forever. The response's own 'close' is the
  // reliable signal, and it is guarded by writableFinished above.
  res.on('close', onClose);

  return {
    get aborted() {
      return aborted;
    },
    register(proc) {
      child = proc;
      if (aborted) safeKill(proc);
    },
  };
}

/**
 * Run the conversion for a job and drive its lifecycle.
 * The concurrency slot is held only for the duration of processing.
 */
async function processJob(job, format) {
  const signal = {
    get aborted() {
      return getJob(job.id)?.status === 'cancelled';
    },
    register(child) {
      registerProcess(job.id, child);
      if (getJob(job.id)?.status === 'cancelled') safeKill(child);
    },
  };

  try {
    const result = await downloadToTemp(job.url, format, {
      signal,
      onPhase: (event) => setPhase(job.id, event.phase, event.pct ?? null),
    });

    const current = getJob(job.id);
    if (!current || current.status === 'cancelled') {
      await removeTempDir(result.dir);
      return;
    }

    // yt-dlp has exited; what remains is staging the file for delivery.
    setPhase(job.id, 'finalizing');

    const info = result.info ?? {};
    const filename = buildAttachmentName({
      title: info.title ?? null,
      id: info.id ?? null,
      extension: result.extension,
      rawBaseName: result.rawBaseName,
    });

    updateJob(job.id, {
      status: 'ready',
      phase: 'ready',
      pct: 100,
      // Internal: used by GET /api/jobs/:id/file and for temp cleanup. Never
      // exposed through publicJob().
      dir: result.dir,
      filePath: result.filePath,
      info: {
        title: info.title ?? result.rawBaseName,
        id: info.id ?? null,
        duration: info.duration ?? null,
        thumbnail: info.thumbnail ?? null,
        uploader: info.uploader ?? null,
        extractor: null,
      },
      file: {
        name: filename,
        size: result.size,
        mime: mimeForExtension(result.extension, format.mime),
        extension: result.extension,
      },
    });
  } catch (err) {
    // A cancelled job has already been reported; do not overwrite it with a
    // misleading "killed" error.
    const current = getJob(job.id);
    if (!current || current.status === 'cancelled') return;

    const message =
      err instanceof YtDlpError
        ? friendlyError(err.stderr, err.message)
        : 'Something went wrong while processing that link.';
    const code = err.code === 'ENOENT' ? 'engine_missing' : 'processing_failed';

    if (!(err instanceof YtDlpError)) console.error('[job] unexpected error:', err);
    updateJob(job.id, { status: 'error', error: { message, code } });
  } finally {
    releaseSlot();
  }
}

/* ------------------------------------------------------------------ */
/* Job API                                                             */
/* ------------------------------------------------------------------ */

app.post('/api/jobs', rateLimit, (req, res) => {
  const body = req.body ?? {};
  const check = validateUrl(body.url ?? req.query.url);
  if (!check.ok) return sendError(res, 400, check.error, 'invalid_url');

  const format = resolveFormat(body.format ?? req.query.format);

  if (!acquireSlot()) {
    return sendError(res, 429, 'The server is busy with other conversions. Try again in a moment.', 'busy');
  }

  let job;
  try {
    job = createJob({ url: check.url, format: format.id });
  } catch (err) {
    releaseSlot();
    throw err;
  }

  // Respond first, then start the work.
  res.status(202).json({ job: publicJob(job) });
  processJob(job, format);
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: activeCount() });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return sendError(res, 404, 'That job no longer exists.', 'job_not_found');
  res.json({ job: publicJob(job) });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return sendError(res, 404, 'That job no longer exists.', 'job_not_found');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Defensive: stop nginx-style proxies from buffering the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  subscribe(req.params.id, res);

  // Close the stream once the job settles; the client does not need to poll for
  // that, and holding the connection open would leak sockets.
  const finish = setInterval(() => {
    const current = getJob(req.params.id);
    if (!current || current.status !== 'processing') {
      clearInterval(finish);
      res.end();
    }
  }, 250);
  res.on('close', () => clearInterval(finish));
});

app.get('/api/jobs/:id/file', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return sendError(res, 404, 'That job no longer exists.', 'job_not_found');
  if (job.status !== 'ready') {
    return sendError(res, 409, `That job is not ready yet (status: ${job.status}).`, 'job_not_ready');
  }

  const filePath = job.filePath;
  if (!filePath) return sendError(res, 410, 'That file is no longer available.', 'file_gone');

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return sendError(res, 410, 'That file is no longer available.', 'file_gone');

  res.status(200);
  res.setHeader('Content-Type', job.file?.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', contentDisposition(job.file?.name || 'download'));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  res.setHeader('X-Download-Filename', encodeURIComponent(job.file?.name || 'download'));

  const stream = fs.createReadStream(filePath);
  // If the client aborts mid-transfer, stop reading; the job and its file are
  // left in place so the user can try again from the success card.
  res.on('close', () => {
    if (!res.writableFinished) stream.destroy();
  });

  try {
    await pipeline(stream, res);
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, 'Could not stream that file.', 'internal');
    else if (!res.writableEnded) res.destroy();
  } finally {
    // Reclaim the staged file the moment the stream ends, whatever the outcome,
    // so server disk never accumulates. This makes the save button one-shot:
    // a repeat requires a fresh conversion. Jobs that are never downloaded are
    // still collected by the TTL sweeper.
    await deleteJob(job.id).catch(() => {});
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return sendError(res, 404, 'That job no longer exists.', 'job_not_found');

  if (job.status === 'processing') cancelJob(job.id, 'Cancelled by the user.');
  await deleteJob(job.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Supporting API                                                      */
/* ------------------------------------------------------------------ */

app.get('/api/health', async (_req, res) => {
  const engine = await checkEngine();
  res.json({
    ok: engine.ready,
    engine: { ytdlp: engine.ytdlp, ffmpeg: engine.ffmpeg },
    concurrency: { max: MAX_CONCURRENT, active: inFlight },
    jobs: activeCount(),
    jobTtlMs: JOB_TTL_MS,
    version: engine.version,
  });
});

app.get('/api/formats', (_req, res) => {
  res.json({ formats: FORMAT_LIST });
});

app.get('/api/info', rateLimit, async (req, res) => {
  const check = validateUrl(req.query.url);
  if (!check.ok) return sendError(res, 400, check.error, 'invalid_url');

  if (!acquireSlot()) {
    return sendError(res, 429, 'The server is busy with other downloads. Try again in a moment.', 'busy');
  }

  const signal = makeRequestSignal(req, res);
  try {
    const info = await fetchInfo(check.url, { onSpawn: signal.register });
    if (signal.aborted) return;
    res.json({ info });
  } catch (err) {
    if (signal.aborted) return;
    const message =
      err instanceof YtDlpError
        ? friendlyError(err.stderr, err.message)
        : 'Could not read that URL. Check the link and try again.';
    sendError(res, 502, message, err.code === 'ENOENT' ? 'engine_missing' : 'extract_failed');
  } finally {
    releaseSlot();
  }
});

/**
 * One-shot download: process and stream in a single request, so the browser
 * shows a standard file download. This is the endpoint described by the API
 * spec. The job flow exists alongside it because the UI has to display a
 * success card *before* the file moves.
 */
async function handleOneShotDownload(req, res, rawUrl, rawFormat) {
  const check = validateUrl(rawUrl);
  if (!check.ok) return sendError(res, 400, check.error, 'invalid_url');

  const format = resolveFormat(rawFormat);

  if (!acquireSlot()) {
    return sendError(res, 429, 'The server is busy with other downloads. Try again in a moment.', 'busy');
  }

  const signal = makeRequestSignal(req, res);
  let staged = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };

  res.on('close', () => {
    release();
    if (!res.writableFinished) {
      staged?.stream?.destroy();
      if (staged?.dir) removeTempDir(staged.dir);
    }
  });

  try {
    const download = await downloadToTemp(check.url, format, {
      signal,
      onChild: signal.register,
    });

    if (signal.aborted) {
      await removeTempDir(download.dir);
      return;
    }

    const filename = buildAttachmentName({
      title: download.info?.title ?? null,
      id: download.info?.id ?? null,
      extension: download.extension,
      rawBaseName: download.rawBaseName,
    });

    const mime = mimeForExtension(download.extension, format.mime);

    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(download.size));
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    res.setHeader('X-Download-Filename', encodeURIComponent(filename));

    const stream = fs.createReadStream(download.filePath);
    staged = { dir: download.dir, stream };

    await pipeline(stream, res);
  } catch (err) {
    if (signal.aborted) {
      // Client vanished; nothing to report.
    } else if (err instanceof YtDlpError) {
      sendError(res, err.code === 'ENOENT' ? 503 : 502, friendlyError(err.stderr, err.message), 'download_failed');
    } else if (!res.headersSent) {
      console.error('[download] unexpected error:', err);
      sendError(res, 500, 'Something went wrong while preparing the download.', 'internal');
    }
  } finally {
    // Temp files are removed as soon as the stream completes — see the module
    // docstring on lib/downloader.js.
    if (staged?.dir) await removeTempDir(staged.dir);
    release();
  }
}

/** POST variant, taking `{ url, format }` — the shape in the API spec. */
app.post('/api/download', rateLimit, (req, res) => {
  const body = req.body ?? {};
  return handleOneShotDownload(req, res, body.url ?? req.query.url, body.format ?? req.query.format);
});

/** GET variant, so the endpoint doubles as a plain downloadable link. */
app.get('/api/download', rateLimit, (req, res) =>
  handleOneShotDownload(req, res, req.query.url, req.query.format)
);

app.all('/api/*splat', (_req, res) => {
  sendError(res, 404, 'No such API route.', 'not_found');
});

/* ------------------------------------------------------------------ */
/* Static UI                                                           */
/* ------------------------------------------------------------------ */

const publicDir = path.join(__dirname, 'public');
const INDEX_TEMPLATE = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
// Rendered once at boot: the only per-request substitution is SITE_URL, so a
// pre-rendered copy keeps responses cheap.
const BUILT_AT = new Date().toISOString().slice(0, 10);

/**
 * HTTPS enforcement. Only active when the site is configured for https, so it
 * stays completely inert on localhost. Behind a TLS-terminating proxy the
 * forwarded proto header is authoritative; without one (e.g. direct TLS) the
 * connection is already https and HSTS is simply advertised.
 */
app.use((req, res, next) => {
  if (!SITE_URL.startsWith('https://')) return next();

  const proto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim();
  const host = req.get('host');
  if (proto && proto !== 'https' && host) {
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  }

  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/** index.html with the configured origin (and optional verification token). */
function renderIndex() {
  let html = INDEX_TEMPLATE.split(TEMPLATE_ORIGIN).join(SITE_URL);
  if (GOOGLE_SITE_VERIFICATION) {
    html = html.replace(
      '</head>',
      `  <meta name="google-site-verification" content="${GOOGLE_SITE_VERIFICATION}" />\n  </head>`
    );
  }
  return html;
}

const sendIndex = (_req, res) => res.type('html').send(renderIndex());

/* ── Crawler-facing routes ──────────────────────────────────────── */

app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(
      [
        '# MD-TOOL',
        'User-agent: *',
        'Allow: /',
        '# No crawl value in the JSON APIs.',
        'Disallow: /api/',
        '',
        `Sitemap: ${SITE_URL}/sitemap.xml`,
        '',
      ].join('\n')
    );
});

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url>',
      `    <loc>${SITE_URL}/</loc>`,
      `    <lastmod>${BUILT_AT}</lastmod>`,
      '    <changefreq>weekly</changefreq>',
      '    <priority>1.0</priority>',
      '  </url>',
      '</urlset>',
      '',
    ].join('\n')
  );
});

// llms.txt — a short, plain-language summary for AI crawlers.
app.get('/llms.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(
      [
        '# MD-TOOL',
        '',
        '> MD-TOOL is a small web app that downloads any public video or music',
        '> link as MP4 or MP3. Paste a URL, pick a format, save the file.',
        '',
        'It is not YouTube-specific: any public http(s) video or audio page is',
        'passed to yt-dlp, so YouTube, Vimeo, TikTok, Instagram, SoundCloud and',
        'Bandcamp links (among many others) all work.',
        '',
        '## Pages',
        `- [MD-TOOL](${SITE_URL}/): the single-page downloader UI.`,
        '',
        '## API',
        `- [Formats](${SITE_URL}/api/formats): the output formats on offer (mp4, mp3).`,
        `- [Health](${SITE_URL}/api/health): engine readiness for yt-dlp and ffmpeg.`,
        `- [Metadata](${SITE_URL}/api/info): title, thumbnail and resolutions for a URL.`,
        '',
      ].join('\n')
    );
});

// Keep one canonical URL for the page: both /index.html and /index land on /.
app.get(['/index.html', '/index'], (_req, res) => res.redirect(301, '/'));

app.get('/', sendIndex);

// No `extensions: ['html']` here: it resolved /index to the copy of
// public/index.html on disk, which skipped renderIndex() and so served the
// placeholder origin (http://localhost:3000) instead of SITE_URL. The SPA
// fallback below already covers any other path.
app.use(express.static(publicDir, { index: false }));

// SPA fallback for any non-API GET.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.type('html').send(renderIndex());
});

// Final error handler (Express 5 forwards async rejections here).
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  sendError(res, 500, 'Internal server error.', 'internal');
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  await sweepStaleTempDirs();
  startJobSweeper();

  const engine = await checkEngine();
  if (!engine.ytdlp.available || !engine.ffmpeg.available) {
    console.warn('\n  ⚠ Engine check failed:');
    if (!engine.ytdlp.available) {
      console.warn(`     - yt-dlp not found (looked for "${process.env.YTDLP_PATH || 'yt-dlp'}")`);
    }
    if (!engine.ffmpeg.available) {
      console.warn(`     - ffmpeg not found (looked for "${process.env.FFMPEG_PATH || 'ffmpeg'}")`);
    }
    console.warn('     Downloads will fail until both are installed and on PATH.\n');
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n  MD-TOOL  →  http://localhost:${PORT}`);
    if (engine.ytdlp.available) console.log(`  yt-dlp : ${engine.ytdlp.version}`);
    if (engine.ffmpeg.available) console.log(`  ffmpeg : ${engine.ffmpeg.version}`);
    console.log(`  max concurrent conversions: ${MAX_CONCURRENT}`);
    console.log(`  staged files expire after:  ${Math.round(JOB_TTL_MS / 60000)} min\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received, shutting down…`);
    server.close();
    await shutdownJobs();
    await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/* ------------------------------------------------------------------ */
/* Safety nets                                                         */
/* ------------------------------------------------------------------ */

// Last-resort guards so an unexpected throw in one request cannot take the
// whole process down. Startup failures are still fatal (see below).
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception (continuing):', err);
});

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
