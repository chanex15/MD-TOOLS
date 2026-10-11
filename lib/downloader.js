/**
 * Core engine: thin wrappers around the yt-dlp and ffmpeg binaries.
 *
 * Design note — why downloads land in a temp directory instead of being piped
 * straight out of yt-dlp's stdout:
 *
 *   `-o -` (stdout) is incompatible with yt-dlp's post-processing steps. Any
 *   format that needs a merged video+audio stream, an audio extraction, or a
 *   container remux requires ffmpeg to read and write seekable files first.
 *   So the engine runs yt-dlp into a private temp directory, asks yt-dlp for
 *   the exact final path via `--print-to-file after_move:filepath`, and the
 *   caller then streams that finished file back to the client as an
 *   attachment. The client still receives a single streamed HTTP body; only
 *   the staging step is on disk.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

import { interpretYtDlpLine } from './phases.js';

export const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
export const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

export const TEMP_ROOT = path.join(os.tmpdir(), 'md-tool');
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 15 * 60 * 1000);
const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_MS || 60 * 1000);
const MAX_FILENAME_BYTES = Number(process.env.MAX_FILENAME_BYTES || 120);

/** Temp directories currently owned by this process, cleaned up on exit. */
const liveTempDirs = new Set();

export class YtDlpError extends Error {
  constructor(message, { stderr = '', code = null, timedOut = false } = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.stderr = stderr;
    this.code = code;
    this.timedOut = timedOut;
  }
}

/**
 * Run a child process to completion, collecting stdout/stderr.
 * Returns the handle immediately so callers can abort a long download when the
 * client disconnects.
 */
function run(bin, args, { timeoutMs, onSpawn, onStdoutLine } = {}) {
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never inherit a shell; args are passed as an array so a URL can't be
    // reinterpreted as a shell metacharacter.
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';
  let timedOut = false;
  let settled = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;

    // Split incrementally so callers see progress as it happens rather than
    // only once the process exits.
    if (onStdoutLine) {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        onStdoutLine(line);
        newline = stdoutBuffer.indexOf('\n');
      }
      // Guard against a pathological line with no terminator.
      if (stdoutBuffer.length > 8192) stdoutBuffer = '';
    }
  });
  child.stderr.on('data', (chunk) => {
    // Bound memory: keep the head and tail of a chatty process.
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });

  const done = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    child.on('error', (err) => {
      finish(reject, new YtDlpError(failedToStartMessage(err), { code: err.code }));
    });

    child.on('close', (code) => {
      finish(resolve, { code, stdout, stderr, timedOut });
    });
  });

  if (typeof onSpawn === 'function') onSpawn(child);

  return { child, done };
}

function failedToStartMessage(err) {
  if (err.code === 'ENOENT') {
    return `Could not find the "${err.path || YTDLP_BIN}" executable. Install it and make sure it is on your PATH (or set YTDLP_PATH/FFMPEG_PATH).`;
  }
  return `Failed to start the downloader: ${err.message}`;
}

/**
 * yt-dlp's `--ffmpeg-location` wants either a real path or a containing
 * directory — it does not resolve bare command names against PATH the way a
 * shell does. Passing "ffmpeg" there makes yt-dlp look for a *directory* named
 * `ffmpeg` and fail. So only forward the flag when we were given a path; a bare
 * name is left alone and yt-dlp resolves it from PATH itself.
 */
function ffmpegLocationArgs() {
  const bin = FFMPEG_BIN;
  if (!bin) return [];
  const isPath = path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\');
  return isPath ? ['--ffmpeg-location', bin] : [];
}

/* ------------------------------------------------------------------ */
/* Hosts that block cloud IPs                                          */
/* ------------------------------------------------------------------ */

/**
 * YouTube and TikTok decide whether to serve a video from the *IP reputation*
 * of the requester before they look at anything else. A residential address
 * (your laptop) is served; a cloud address (Fly, Render, a VPS) gets "Sign in to
 * confirm you're not a bot" or a captcha. There is no flag that makes a blocked
 * IP unblocked, so the only real fixes are a session cookie or a different
 * egress IP — both of which are configuration, not code.
 *
 * These switches are the supported way to supply that configuration, and every
 * one of them is inert unless its environment variable is set, so local runs
 * and the test suite are unaffected.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

let cookieFilePromise = null;

/**
 * A Netscape-format cookie jar for yt-dlp.
 *
 * `YTDLP_COOKIES` is a path that already exists (e.g. a mounted secret file).
 * `YTDLP_COOKIES_B64` is the file's *contents*, base64-encoded — the only shape
 * that works on hosts where the sole writable channel is an environment secret
 * (`fly secrets set`, Render/Railway env vars). It is decoded to a 0600 file
 * once per process.
 *
 * @returns {Promise<string | null>} path to a readable cookie file, or null
 */
async function resolveCookieFile() {
  if (process.env.YTDLP_COOKIES) return process.env.YTDLP_COOKIES;

  const encoded = process.env.YTDLP_COOKIES_B64;
  if (!encoded) return null;

  if (!cookieFilePromise) {
    cookieFilePromise = (async () => {
      const file = path.join(TEMP_ROOT, 'cookies.txt');
      await fsp.mkdir(TEMP_ROOT, { recursive: true });
      await fsp.writeFile(file, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      return file;
    })().catch((err) => {
      // Do not cache the failure: a bad value should not poison later runs.
      cookieFilePromise = null;
      console.warn('[engine] could not decode YTDLP_COOKIES_B64:', err.message);
      return null;
    });
  }

  return cookieFilePromise;
}

/**
 * Extra yt-dlp arguments derived from the environment. Order is irrelevant to
 * yt-dlp; each flag is simply omitted when unset.
 * @returns {Promise<string[]>}
 */
export async function networkArgs() {
  const args = [];

  const cookies = await resolveCookieFile();
  if (cookies) args.push('--cookies', cookies);
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  // TikTok in particular serves a stub to unknown clients; a browser UA helps.
  if (process.env.YTDLP_USER_AGENT) args.push('--user-agent', process.env.YTDLP_USER_AGENT);
  // Some container networks have broken IPv6 egress, which looks like a
  // timeout rather than an error.
  if (TRUTHY.has(String(process.env.YTDLP_FORCE_IPV4 || '').toLowerCase())) args.push('--force-ipv4');
  // Escape hatch for extractor-specific workarounds.
  if (process.env.YTDLP_EXTRACTOR_ARGS) args.push('--extractor-args', process.env.YTDLP_EXTRACTOR_ARGS);

  return args;
}

/** yt-dlp writes its diagnostics to stderr; surface the useful line. */
export function summariseStderr(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLine = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  const chosen = errorLine ?? lines[lines.length - 1] ?? '';
  return chosen.replace(/^ERROR:\s*/i, '').slice(0, 400);
}

/**
 * Common yt-dlp failures, rewritten as messages a user can act on.
 * Ordered: the first match wins.
 */
const ERROR_PATTERNS = [
  [/private video|video is private|sign in if you've been granted access/i, 'That video is private, so it cannot be downloaded.'],
  [/members[- ]only|join this channel|channel members/i, 'That video is members-only, so it cannot be downloaded.'],
  [/age[- ]restricted|confirm your age|inappropriate for some users|agegate/i, 'That video is age-restricted and cannot be downloaded without signing in.'],
  [/not available in your country|geo[- ]?restrict|blocked in your country|available in your country|did not get any data/i, 'That video is geo-restricted and is not available from this server.'],
  [
    /sign in to confirm|not a bot|confirm you're not a bot/i,
    'The source is asking for a bot check. This usually means the server\u2019s IP is blocked — set YTDLP_COOKIES or YTDLP_PROXY (see the README).',
  ],
  [
    /captcha|verify you are human|unusual traffic|are you a robot/i,
    'The source served a captcha instead of the video. This usually means the server\u2019s IP is flagged — set YTDLP_COOKIES or YTDLP_PROXY (see the README).',
  ],
  [
    /only available for registered users|login required|log in to continue|please sign in|authentication required|not logged in/i,
    'That video needs a signed-in session. Supply account cookies via YTDLP_COOKIES (see the README).',
  ],
  [/video unavailable|this video is not available|has been removed|no longer available|account.*terminated/i, 'That video is unavailable — it may have been removed.'],
  [/live event will begin|premieres in|has not started|upcoming/i, "That stream hasn't started yet."],
  [/live event has ended|live stream.*(ended|over)/i, 'That live stream has ended.'],
  [/unsupported url/i, "That link isn't a supported video URL."],
  [/requested format is not available/i, 'The requested format is not available for that video.'],
  [/HTTP Error 404|404 Not Found/i, 'That page could not be found (404).'],
  [/HTTP Error 403|403 Forbidden/i, 'Access to that video was denied (403).'],
  [/HTTP Error 429|too many requests/i, 'The source site is rate-limiting us. Try again in a few minutes.'],
  [/timed out|timeout/i, 'The source took too long to respond. Try again.'],
  [/unable to download webpage|temporary failure|connection refused|name or service not known|network is unreachable/i, 'Could not reach the source site. Check the link and your connection.'],
];

/**
 * Turn raw yt-dlp stderr into a clean, human-readable message.
 * Falls back to the raw ERROR line so nothing is swallowed.
 * @returns {string}
 */
export function friendlyError(stderr, fallback = 'The download failed.') {
  const text = String(stderr ?? '');

  for (const [pattern, message] of ERROR_PATTERNS) {
    if (pattern.test(text)) return message;
  }

  return summariseStderr(text) || fallback;
}

/** Sending a signal to an already-dead process is expected, not an error. */
function safeKill(child) {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ */
/* Temp workspace                                                      */
/* ------------------------------------------------------------------ */

/** Remove leftover staging directories from previous runs. */
export async function sweepStaleTempDirs(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    const entries = await fsp.readdir(TEMP_ROOT, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !liveTempDirs.has(path.join(TEMP_ROOT, entry.name)))
        .map(async (entry) => {
          const full = path.join(TEMP_ROOT, entry.name);
          try {
            const stat = await fsp.stat(full);
            if (now - stat.mtimeMs > maxAgeMs) await fsp.rm(full, { recursive: true, force: true });
          } catch {
            /* raced with another cleanup */
          }
        })
    );
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[temp] sweep failed:', err.message);
  }
}

export async function createTempDir() {
  await fsp.mkdir(TEMP_ROOT, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'job-'));
  liveTempDirs.add(dir);
  return dir;
}

export async function removeTempDir(dir) {
  if (!dir) return;
  liveTempDirs.delete(dir);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

process.on('exit', () => {
  for (const dir of liveTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/* ------------------------------------------------------------------ */
/* Binary discovery                                                    */
/* ------------------------------------------------------------------ */

async function probeVersion(bin, args) {
  try {
    const { done } = run(bin, args, { timeoutMs: 10_000 });
    const { code, stdout, stderr } = await done;
    if (code !== 0) return { available: false, version: null };
    const text = (stdout || stderr).split(/\r?\n/).find((line) => line.trim());
    return { available: true, version: text ? text.trim().slice(0, 120) : null };
  } catch {
    return { available: false, version: null };
  }
}

export function checkEngine() {
  return Promise.all([
    probeVersion(YTDLP_BIN, ['--version']),
    probeVersion(FFMPEG_BIN, ['-version']),
  ]).then(([ytdlp, ffmpeg]) => ({
    ytdlp,
    ffmpeg,
    ready: ytdlp.available && ffmpeg.available,
    version: pkg.version,
  }));
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

const INFO_ARGS = [
  '--dump-single-json',
  '--no-playlist',
  '--no-warnings',
  '--skip-download',
  '--no-progress',
  '--ignore-config',
];

/**
 * Resolve a URL to a small, serialisable metadata object.
 * @param {string} url
 * @param {{ onSpawn?: (child: import('node:child_process').ChildProcess) => void }} [options]
 */
export async function fetchInfo(url, { onSpawn } = {}) {
  const args = [...INFO_ARGS, ...(await networkArgs()), '--', url];
  const { done } = run(YTDLP_BIN, args, { timeoutMs: INFO_TIMEOUT_MS, onSpawn });
  const { code, stdout, stderr, timedOut } = await done;

  if (timedOut) {
    throw new YtDlpError('Reading that URL timed out. Try again.', { stderr, timedOut: true });
  }
  if (code !== 0) {
    throw new YtDlpError(summariseStderr(stderr) || 'yt-dlp could not read that URL.', { stderr, code });
  }

  // Warnings can precede the JSON document, so parse the last JSON-ish line.
  const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  let data;
  try {
    data = JSON.parse(jsonLine);
  } catch {
    throw new YtDlpError('yt-dlp returned an unreadable response for that URL.', { stderr, code });
  }

  if (data._type === 'playlist') {
    const first = Array.isArray(data.entries) ? data.entries.find(Boolean) : null;
    if (!first) throw new YtDlpError('That link is a playlist with no playable entries.');
    data = first;
  }

  // Distinct video heights on offer, descending. Kept to plain numbers so the
  // response stays lightweight; a full format dump belongs behind a separate
  // endpoint if it is ever needed.
  const resolutions = [
    ...new Set(
      (Array.isArray(data.formats) ? data.formats : [])
        .map((format) => format?.height)
        .filter((height) => Number.isFinite(height) && height > 0)
    ),
  ].sort((a, b) => b - a);

  return {
    id: data.id ?? null,
    title: data.title ?? 'Untitled',
    uploader: data.uploader ?? data.channel ?? data.creator ?? null,
    duration: Number.isFinite(data.duration) ? data.duration : null,
    thumbnail: data.thumbnail ?? null,
    extractor: data.extractor_key ?? data.extractor ?? null,
    webpageUrl: data.webpage_url ?? url,
    isLive: Boolean(data.is_live),
    approxBytes: Number.isFinite(data.filesize_approx) ? data.filesize_approx : null,
    resolutions,
    maxResolution: resolutions[0] ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

/**
 * Trim a title to something safe for a filename and for HTTP headers.
 * Keeps it well under filesystem limits while remaining recognisable.
 */
export function sanitiseFilenameBase(input) {
  const cleaned = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars (incl. CR/LF: header injection)
    .replace(/[\\/:*?"<>|]/g, '-') // characters illegal on Windows
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .trim();

  const base = cleaned || 'download';
  return truncateBytes(base, MAX_FILENAME_BYTES);
}

function truncateBytes(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

/* Metadata fields are joined with a unit separator: it cannot appear in any of
 * the values, so parsing never has to guess where one field ends. */
const META_SEP = '\u001f';
const META_TEMPLATE = [
  '%(title)s',
  '%(id)s',
  '%(duration|0)s',
  '%(thumbnail|)s',
  '%(uploader|)s',
].join(META_SEP);

/** Parse the before_dl metadata file written by yt-dlp. Never throws. */
function parseMetaFile(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  if (!line) return null;

  const [title, id, duration, thumbnail, uploader] = line.split(META_SEP);
  const seconds = Number(duration);

  return {
    title: title || null,
    id: id || null,
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    thumbnail: thumbnail || null,
    uploader: uploader || null,
  };
}

/**
 * Download `url` in the requested format into a fresh temp directory.
 *
 * A single yt-dlp process does everything: it reports metadata at the
 * `before_dl` stage and the finished file path at `after_move`, while stdout is
 * streamed through `onPhase` so the UI can show real progress.
 *
 * @param {string} url
 * @param {object} format entry from lib/formats.js
 * @param {{ signal?: object, onChild?: Function, onPhase?: Function }} [options]
 * @returns {Promise<{ filePath: string, extension: string, size: number,
 *   dir: string, rawBaseName: string, info: object | null }>}
 */
export async function downloadToTemp(url, format, { signal, onChild, onPhase } = {}) {
  const dir = await createTempDir();
  const listFile = path.join(dir, '__output.txt');
  const metaFile = path.join(dir, '__meta.txt');

  // The template carries the title and id so the finished file's basename can
  // be reused verbatim as the download's filename. `%(title).120B` truncates by
  // bytes, and yt-dlp already strips filesystem-illegal characters for us.
  const outputTemplate = path.join(dir, '%(title).120B [%(id)s].%(ext)s');
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--no-part',
    '--retries',
    '3',
    // Success-card metadata, captured at the earliest usable stage so the whole
    // conversion still costs exactly one yt-dlp process. `|` supplies a default
    // for fields that are legitimately absent (duration, thumbnail, uploader).
    '--print-to-file',
    `before_dl:${META_TEMPLATE}`,
    metaFile,
    // The absolute path of the finished file. This is the only reliable way to
    // learn the real extension after post-processing has run.
    '--print-to-file',
    'after_move:filepath',
    listFile,
    ...ffmpegLocationArgs(),
    ...(await networkArgs()),
    ...format.ytdlpArgs,
    '-o',
    outputTemplate,
    '--',
    url,
  ];

  onPhase?.({ phase: 'metadata' });

  const { done } = run(YTDLP_BIN, args, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onStdoutLine: (line) => {
      const event = interpretYtDlpLine(line);
      if (event) onPhase?.(event);
    },
    onSpawn: (child) => {
      // Hand the process to the caller so it can be killed if the client goes
      // away (or when the job expires).
      signal?.register?.(child);
      onChild?.(child);
    },
  });

  let result;
  try {
    result = await done;
  } catch (err) {
    await removeTempDir(dir);
    throw err;
  }

  const stderr = result.stderr || '';

  if (result.timedOut) {
    await removeTempDir(dir);
    throw new YtDlpError(
      `The download exceeded the ${Math.round(DOWNLOAD_TIMEOUT_MS / 60000)} minute limit and was stopped.`,
      { stderr, timedOut: true }
    );
  }

  if (result.code !== 0) {
    await removeTempDir(dir);
    throw new YtDlpError(summariseStderr(stderr) || 'The download failed.', {
      stderr,
      code: result.code,
    });
  }

  // Metadata is a bonus: a parse failure must not sink an otherwise good file.
  let info = null;
  try {
    info = parseMetaFile(await fsp.readFile(metaFile, 'utf8'));
  } catch {
    info = null;
  }

  // Prefer the path yt-dlp reported; otherwise fall back to whatever landed.
  let filePath = null;
  try {
    const reported = (await fsp.readFile(listFile, 'utf8')).split(/\r?\n/).filter(Boolean).pop();
    if (reported && path.resolve(reported).startsWith(path.resolve(dir))) filePath = reported.trim();
  } catch {
    /* fall through to directory scan */
  }

  if (!filePath) {
      const produced = (await fsp.readdir(dir)).filter(
      (name) => !name.startsWith('__') && !name.endsWith('.part')
    );
    if (produced.length === 0) {
      await removeTempDir(dir);
      throw new YtDlpError('yt-dlp finished without producing a file.', { stderr });
    }
    filePath = path.join(dir, produced[0]);
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    await removeTempDir(dir);
    throw new YtDlpError('The download completed but the resulting file was empty.', { stderr });
  }

  return {
    dir,
    filePath,
    size: stat.size,
    extension: path.extname(filePath).replace(/^\./, '').toLowerCase(),
    rawBaseName: path.basename(filePath, path.extname(filePath)),
    info,
  };
}

/**
 * Build the attachment filename shown to the user.
 * Tries for "<Title> [<id>].<ext>" and degrades to the on-disk name.
 */
export function buildAttachmentName({ title, id, extension, rawBaseName }, fallbackExt) {
  const ext = extension || fallbackExt || 'bin';
  const qualifier = id ? ` [${id}]` : '';
  if (title) return `${sanitiseFilenameBase(title)}${qualifier}.${ext}`;
  return `${sanitiseFilenameBase(rawBaseName || 'download')}.${ext}`;
}

/** RFC 6266 / RFC 5987 compliant Content-Disposition value. */
export function contentDisposition(filename) {
  const safe = filename.replace(/[\r\n]/g, '');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 200);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export { safeKill };
