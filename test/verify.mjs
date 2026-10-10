/**
 * Verification suite.
 *
 * 1. Pure helpers — validation, formats, filenames, headers, phase parsing.
 * 2. HTTP contract — health, formats, error paths, and the full job flow
 *    (create → SSE phases → download the staged file).
 * 3. UI — the real public/index.html and public/app.js executed under jsdom,
 *    with fetch and EventSource stubbed so the whole three-state flow can be
 *    driven: form → loading (with live phase text) → success card.
 *
 * Requires a server running on :3000. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { JSDOM, VirtualConsole } from 'jsdom';

import { validateUrl } from '../lib/validate.js';
import { FORMATS, FORMAT_LIST, FORMAT_TABS, resolveFormat, mimeForExtension } from '../lib/formats.js';
import { interpretYtDlpLine, phaseText, PHASE_TEXT } from '../lib/phases.js';
import {
  buildAttachmentName,
  contentDisposition,
  friendlyError,
  sanitiseFilenameBase,
  summariseStderr,
} from '../lib/downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const TEST_PORT = process.env.TEST_PORT || '3210';
let BASE = process.env.BASE_URL || `http://localhost:${TEST_PORT}`;
let testServer = null;

/**
 * The suite makes far more requests than a person would, which would trip the
 * production rate limiter. So it runs its own instance with a raised budget and
 * cleans it up afterwards. Set BASE_URL to point at an already-running server
 * instead (in which case its own limits apply).
 */
async function startTestServer() {
  if (process.env.BASE_URL) return;

  testServer = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: TEST_PORT, RATE_LIMIT_MAX: '2000' },
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error(`test server never became ready on ${BASE}`);
}

/**
 * A cancelled job releases its concurrency slot a moment after DELETE returns,
 * because the killed child has to actually exit first. Tests that need a slot
 * wait for that to settle rather than racing it.
 */
async function waitForFreeSlots(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await (await fetch(`${BASE}/api/health`)).json();
    if (health.concurrency.active === 0 && health.jobs.processing === 0) return;
    await sleep(200);
  }
  throw new Error('concurrency slots never drained');
}

/**
 * The file route releases its job in a `finally` that runs after the response
 * has finished, so a client can observe delivery a beat before the job leaves
 * the map. Wait for the books to clear rather than racing that final tick.
 */
async function waitForNoJobs(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await (await fetch(`${BASE}/api/health`)).json();
    if (last.jobs.total === 0 && last.concurrency.active === 0) return last;
    await sleep(150);
  }
  return last;
}

function stopTestServer() {
  if (testServer) {
    testServer.kill('SIGKILL');
    testServer = null;
  }
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileP = promisify(execFile);

/**
 * Run a throwaway server with custom env, so tests that must exhaust a shared
 * counter do not interfere with the rest of the suite.
 */
async function withTempServer(env, fn) {
  const port = env.PORT;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    await sleep(200);
    try {
      ready = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* not up yet */
    }
  }

  try {
    if (!ready) throw new Error(`temp server on ${port} never became ready`);
    return await fn(base);
  } finally {
    child.kill('SIGKILL');
  }
}

/* ── 1. validateUrl ─────────────────────────────────────────────── */

console.log('\nvalidation');

await test('accepts a normal https URL', () => {
  const result = validateUrl('https://www.youtube.com/watch?v=abc123');
  assert.equal(result.ok, true);
  assert.equal(result.host, 'www.youtube.com');
});

await test('rejects empty and blank input', () => {
  assert.equal(validateUrl('').ok, false);
  assert.equal(validateUrl('   ').ok, false);
  assert.equal(validateUrl(undefined).ok, false);
});

await test('rejects malformed URLs', () => {
  assert.equal(validateUrl('not a url').ok, false);
  assert.equal(validateUrl('youtube.com/watch?v=x').ok, false);
});

await test('rejects non-http schemes', () => {
  for (const url of ['file:///etc/passwd', 'ftp://x.com/a', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.equal(validateUrl(url).ok, false, `expected rejection: ${url}`);
  }
});

await test('rejects embedded credentials', () => {
  assert.equal(validateUrl('https://user:pass@youtube.com/watch?v=x').ok, false);
});

await test('rejects loopback and private hosts, including IPv6 forms', () => {
  for (const url of [
    'http://localhost/x',
    'http://127.0.0.1:8080/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.4.4/x',
    'http://169.254.169.254/latest/meta-data',
    'http://foo.local/x',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[fd00::1]/x',
    'http://service.internal/x',
  ]) {
    assert.equal(validateUrl(url).ok, false, `expected rejection: ${url}`);
  }
});

await test('allows public IPs and normal hosts', () => {
  assert.equal(validateUrl('https://93.184.216.34/v.mp4').ok, true);
  assert.equal(validateUrl('https://vimeo.com/12345').ok, true);
});

await test('accepts non-YouTube video and music links, not just YouTube', () => {
  // The tool is not YouTube-specific: any public http(s) video or audio page is
  // handed to yt-dlp, which resolves hundreds of sites.
  for (const url of [
    'https://vimeo.com/12345',
    'https://soundcloud.com/artist/track',
    'https://www.tiktok.com/@user/video/123',
    'https://artist.bandcamp.com/track/song',
    'https://www.instagram.com/reel/abc/',
    'https://www.dailymotion.com/video/x123',
  ]) {
    assert.equal(validateUrl(url).ok, true, `expected acceptance: ${url}`);
  }
});

await test('trims surrounding whitespace', () => {
  const result = validateUrl('  https://vimeo.com/12345  ');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://vimeo.com/12345');
});

/* ── 2. formats ─────────────────────────────────────────────────── */

console.log('\nformats');

await test('every format has the fields the UI needs', () => {
  for (const format of FORMAT_LIST) {
    assert.ok(format.id && format.label && format.hint, `incomplete format: ${format.id}`);
    assert.ok(['video', 'audio'].includes(format.kind));
    assert.ok(Array.isArray(FORMATS[format.id].ytdlpArgs));
  }
});

await test('the UI exposes exactly the two spec tabs, with spec labels', () => {
  assert.equal(FORMAT_TABS.length, 2, 'the spec calls for two format tabs');
  assert.deepEqual(
    FORMAT_TABS.map((f) => f.tabLabel),
    ['MP4 Video', 'MP3 Audio']
  );
});

await test('m4a stays usable through the API but is not a tab', () => {
  const m4a = FORMAT_LIST.find((f) => f.id === 'm4a');
  assert.equal(m4a.featured, false);
  assert.equal(resolveFormat('m4a').id, 'm4a');
  assert.ok(FORMATS.m4a.ytdlpArgs.length > 0);
});

await test('resolveFormat falls back to mp4 for unknown input', () => {
  assert.equal(resolveFormat('bogus').id, 'mp4');
  assert.equal(resolveFormat(undefined).id, 'mp4');
  assert.equal(resolveFormat('').id, 'mp4');
});

await test('resolveFormat is case-insensitive', () => {
  assert.equal(resolveFormat('MP3').id, 'mp3');
  assert.equal(resolveFormat('M4A').id, 'm4a');
});

await test('mimeForExtension maps real containers and has a fallback', () => {
  assert.equal(mimeForExtension('mp4'), 'video/mp4');
  assert.equal(mimeForExtension('MP3'), 'audio/mpeg');
  assert.equal(mimeForExtension('webm'), 'video/webm');
  assert.equal(mimeForExtension('xyz', 'video/mp4'), 'video/mp4');
});

/* ── 3. phase interpretation ────────────────────────────────────── */

console.log('\nphases');

await test('the three spec status strings are present verbatim', () => {
  assert.equal(PHASE_TEXT.metadata, 'Extracting metadata...');
  assert.equal(PHASE_TEXT.converting, 'Converting stream...');
  assert.equal(PHASE_TEXT.finalizing, 'Finalizing file...');
});

await test('extractor chatter reads as metadata extraction', () => {
  assert.deepEqual(interpretYtDlpLine('[youtube] Extracting URL: https://youtu.be/x'), { phase: 'metadata' });
  assert.deepEqual(interpretYtDlpLine('[info] x: Downloading 1 format(s): 251'), { phase: 'metadata' });
});

await test('download lines read as media transfer, with a percentage', () => {
  assert.deepEqual(interpretYtDlpLine('[download] Destination: a.webm'), { phase: 'downloading', pct: 0 });
  assert.deepEqual(interpretYtDlpLine('[download]  45.2% of 9.73MiB at 5.00MiB/s ETA 00:01'), {
    phase: 'downloading',
    pct: 45.2,
  });
  assert.deepEqual(interpretYtDlpLine('[download] 100% of 9.73MiB in 00:00:01'), {
    phase: 'downloading',
    pct: 100,
  });
});

await test('ffmpeg post-processing stages read as converting', () => {
  for (const line of [
    '[ExtractAudio] Destination: a.mp3',
    '[Merger] Merging formats into "v.mp4"',
    '[VideoRemuxer] Not remuxing media file "v.mp4"; already is in target format mp4',
    '[Muxer] Writing a.m4a',
  ]) {
    assert.deepEqual(interpretYtDlpLine(line), { phase: 'converting' }, `failed on: ${line}`);
  }
});

await test('unrelated and malformed lines yield no phase', () => {
  for (const line of ['[debug] command line: …', '', 'plain text', null, undefined]) {
    assert.equal(interpretYtDlpLine(line), null);
  }
});

await test('phaseText falls back for an unknown phase', () => {
  assert.equal(phaseText('converting'), 'Converting stream...');
  assert.equal(phaseText('nonsense'), PHASE_TEXT.queued);
});

/* ── 4. filenames and headers ───────────────────────────────────── */

console.log('\nfilenames');

await test('sanitiseFilenameBase strips path separators and control chars', () => {
  assert.equal(sanitiseFilenameBase('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(sanitiseFilenameBase('bad\r\ninjection'), 'badinjection');
  assert.equal(sanitiseFilenameBase('   spaced   out   '), 'spaced out');
});

await test('sanitiseFilenameBase never returns an empty name', () => {
  assert.equal(sanitiseFilenameBase(''), 'download');
  assert.equal(sanitiseFilenameBase('...'), 'download');
  assert.equal(sanitiseFilenameBase(null), 'download');
});

await test('sanitiseFilenameBase enforces the byte budget', () => {
  const long = sanitiseFilenameBase('x'.repeat(500));
  assert.ok(Buffer.byteLength(long, 'utf8') <= 120 + 4, 'should be truncated near 120 bytes');
});

await test('buildAttachmentName pairs title with id and extension', () => {
  const name = buildAttachmentName({ title: 'My Video', id: 'abc', extension: 'mp3', rawBaseName: 'x' });
  assert.equal(name, 'My Video [abc].mp3');
});

await test('buildAttachmentName falls back to the on-disk basename', () => {
  const name = buildAttachmentName({ title: null, id: null, extension: 'mp4', rawBaseName: 'clip [id1]' });
  assert.equal(name, 'clip [id1].mp4');
});

await test('contentDisposition emits both ascii and UTF-8 forms', () => {
  const header = contentDisposition('Café — clip.mp3');
  assert.match(header, /^attachment; filename="[^"]*"/);
  assert.match(header, /filename\*=UTF-8''/);
  assert.ok(header.includes(encodeURIComponent('Café — clip.mp3')));
  assert.ok(!header.includes('\n'), 'must not contain CR/LF');
});

await test('summariseStderr surfaces the yt-dlp ERROR line', () => {
  const stderr = '[youtube] Extracting URL\nWARNING: something\nERROR: Video unavailable\n[download] 0%';
  assert.equal(summariseStderr(stderr), 'Video unavailable');
});

await test('summariseStderr degrades gracefully with no ERROR line', () => {
  assert.equal(summariseStderr(''), '');
  assert.equal(summariseStderr('just a note'), 'just a note');
});

/* ── 5. backend HTTP contract ───────────────────────────────────── */

console.log('\napi');

await startTestServer();

await test('/api/health reports the engine as ready', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true, 'yt-dlp and ffmpeg must both be available for this test');
  assert.equal(data.engine.ytdlp.available, true);
  assert.equal(data.engine.ffmpeg.available, true);
  assert.ok(data.jobTtlMs > 0, 'jobs should advertise a TTL');
});

await test('/api/formats matches the server-side catalogue', async () => {
  const res = await fetch(`${BASE}/api/formats`);
  const data = await res.json();
  assert.deepEqual(
    data.formats.map((f) => f.id).sort(),
    FORMAT_LIST.map((f) => f.id).sort()
  );
  assert.equal(data.formats.filter((f) => f.featured).length, 2);
});

await test('static assets are served', async () => {
  const html = await fetch(`${BASE}/`);
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /Paste video link \(YouTube, etc\.\)\.\.\./, 'spec placeholder');
  assert.match(body, /Fetch &amp; Convert/, 'spec action button');

  const js = await fetch(`${BASE}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

await test('crawler routes (robots, sitemap, llms, og) are served correctly', async () => {
  const robots = await fetch(`${BASE}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /User-agent: \*/);
  assert.match(robotsBody, /Disallow: \/api\//);
  assert.ok(robotsBody.includes(`Sitemap: ${BASE}/sitemap.xml`), 'robots must point at the sitemap');

  const sitemap = await fetch(`${BASE}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  const xml = await sitemap.text();
  assert.match(xml, /<urlset/);
  assert.ok(xml.includes(`<loc>${BASE}/</loc>`), 'sitemap must use the configured origin');
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);

  const llms = await fetch(`${BASE}/llms.txt`);
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get('content-type'), /text\/plain/);
  assert.match(await llms.text(), /# MD-TOOL/);

  const og = await fetch(`${BASE}/og.svg`);
  assert.equal(og.status, 200);
  assert.match(og.headers.get('content-type'), /image\/svg\+xml/);
});

await test('the page is indexable, has one H1, canonical, OG and schema', async () => {
  const redirect = await fetch(`${BASE}/index.html`, { redirect: 'manual' });
  assert.equal(redirect.status, 301, '/index.html should point at the canonical /');
  assert.equal(redirect.headers.get('location'), '/');

  const html = await (await fetch(`${BASE}/`)).text();
  assert.equal((html.match(/<h1/g) || []).length, 1, 'exactly one H1');
  assert.ok(!/noindex/i.test(html), 'no noindex directive should remain');
  assert.ok(
    html.includes(`<link rel="canonical" href="${BASE}/" />`),
    'canonical must use the configured origin'
  );
  assert.match(html, /property="og:image" content="[^"]*\/og\.svg"/);
  assert.match(html, /property="og:url" content="[^"]*"/);
  assert.match(html, /"@type": "WebApplication"/, 'schema markup should be present');
});

await test('bad input is rejected before any job is created', async () => {
  const res = await fetch(`${BASE}/api/download?url=nope&format=mp3`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_url');

  const blocked = await fetch(`${BASE}/api/info?url=` + encodeURIComponent('http://127.0.0.1/x'));
  assert.equal(blocked.status, 400);

  const post = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'not-a-url', format: 'mp3' }),
  });
  assert.equal(post.status, 400);
});

await test('unknown job ids return 404, on every job route', async () => {
  const ghost = '00000000-0000-4000-8000-000000000000';
  for (const route of [`/api/jobs/${ghost}`, `/api/jobs/${ghost}/events`, `/api/jobs/${ghost}/file`]) {
    const res = await fetch(`${BASE}${route}`);
    assert.equal(res.status, 404, `expected 404 from ${route}`);
  }
  const del = await fetch(`${BASE}/api/jobs/${ghost}`, { method: 'DELETE' });
  assert.equal(del.status, 404);
});

/* ── 6. the full job flow ───────────────────────────────────────── */

console.log('\njob flow');

const TEST_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
let jobId = null;

/** Create a job and return its id. */
async function createJob(url = TEST_URL, format = 'mp3') {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, format }),
  });
  const { job } = await res.json();
  return job.id;
}

/** Read a job's SSE stream to completion, collecting the phase sequence. */
async function collectJobEvents(id) {
  const res = await fetch(`${BASE}/api/jobs/${id}/events`);
  const contentType = res.headers.get('content-type') || '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const phases = [];
  let buffer = '';
  let final = null;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue; // heartbeat comment
      const job = JSON.parse(line.slice(6));
      if (phases.at(-1) !== job.phase) phases.push(job.phase);
      if (job.status !== 'processing') final = job;
    }
    if (final) break;
  }

  return { status: res.status, contentType, phases, final };
}

await test('POST /api/jobs accepts the request and starts processing', async () => {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TEST_URL, format: 'mp3' }),
  });

  assert.equal(res.status, 202, 'job creation must not block on the conversion');
  const { job } = await res.json();

  assert.ok(job.id, 'a job id is required');
  assert.equal(job.status, 'processing');
  assert.ok(job.phaseText, 'the client needs a human phase label');
  jobId = job.id;
});

await test('GET /api/jobs/:id/file is refused while the job is not ready', async () => {
  // A second, deliberately slow-to-fail job, so we can hit the not-ready path
  // deterministically right after creation.
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/notavideo', format: 'mp3' }),
  });
  const { job } = await res.json();

  const early = await fetch(`${BASE}/api/jobs/${job.id}/file`);
  assert.equal(early.status, 409, 'a processing job has no file yet');
  const body = await early.json();
  assert.equal(body.error.code, 'job_not_ready');

  // Clean up: this also exercises cancellation of an in-flight job.
  const del = await fetch(`${BASE}/api/jobs/${job.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
});

await test('the SSE stream reports real phases and ends at ready', async () => {
  let { status, contentType, phases, final } = await collectJobEvents(jobId);
  assert.equal(status, 200);
  assert.match(contentType, /text\/event-stream/);

  // The source is a live third party and can rate-limit a burst of downloads.
  // One retry is allowed here; every assertion below is unchanged either way.
  if (final?.status !== 'ready') {
    console.log(`      (job settled as ${final?.status ?? 'timeout'}; retrying once against the live source)`);
    await sleep(5000);
    jobId = await createJob();
    ({ phases, final } = await collectJobEvents(jobId));
  }

  assert.ok(final, 'the stream must terminate with a settled job');
  assert.equal(final.status, 'ready', `expected ready, got ${final.status}`);
  assert.ok(phases.includes('metadata'), `expected a metadata phase, saw: ${phases.join(' -> ')}`);
  assert.ok(
    phases.includes('downloading') || phases.includes('converting'),
    `expected real work phases, saw: ${phases.join(' -> ')}`
  );

  // The success card's contents must be populated from the single yt-dlp run.
  assert.ok(final.info?.title, 'the job must carry a title for the success card');
  assert.ok(final.file?.name, 'the job must carry a filename');
  assert.ok(final.file?.size > 0, 'the job must carry a real byte size');
  assert.ok(final.expiresAt > Date.now(), 'staged files should expire in the future');
  assert.ok(!('dir' in final) && !('filePath' in final), 'server paths must not leak to clients');
});

await test('GET /api/jobs/:id/file streams the finished file as an attachment', async () => {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');

  const disposition = res.headers.get('content-disposition') || '';
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/);

  const bytes = Buffer.from(await res.arrayBuffer());
  const declared = Number(res.headers.get('content-length'));
  assert.equal(bytes.length, declared, 'body length must match Content-Length');
  assert.ok(bytes.length > 100_000, `expected a real audio file, got ${bytes.length} bytes`);

  // Parse the actual container: MPEG audio frames (or an ID3 tag) for an mp3.
  const looksLikeMp3 =
    bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  assert.ok(looksLikeMp3, 'the delivered bytes should be a real MP3');
});

await test('a failed job reports a clean message and is scheduled for cleanup', async () => {
  const id = await createJob('https://example.com/notavideo', 'mp3');
  const { final } = await collectJobEvents(id);

  assert.ok(final, 'a failing job must still settle');
  assert.equal(final.status, 'error');
  assert.ok(final.error?.message, 'the client needs a message to display');
  assert.ok(!final.error.message.startsWith('ERROR:'), 'raw yt-dlp prefixes should be stripped');
  assert.equal(final.file, null, 'a failed job has no file');

  // Without a deadline, failed jobs would accumulate in the map forever.
  assert.ok(final.expiresAt > Date.now(), 'failed jobs must expire too');

  await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' });
});

await test('the staged file is deleted immediately after the stream completes', async () => {
  // Server disk must not accumulate downloaded files, so the file (and the job
  // that owned it) are released the moment delivery finishes.
  const again = await fetch(`${BASE}/api/jobs/${jobId}/file`);
  assert.equal(again.status, 404, 'the staged file should already be gone');

  const job = await fetch(`${BASE}/api/jobs/${jobId}`);
  assert.equal(job.status, 404, 'the job itself should be gone');

  const health = await waitForNoJobs();
  assert.equal(health.jobs.total, 0, 'no job should linger after delivery');
  assert.equal(health.concurrency.active, 0, 'the slot should have been released');
});

await test('concurrency is capped, and slots are released afterwards', async () => {
  const health = await fetch(`${BASE}/api/health`);
  const before = await health.json();
  assert.equal(before.concurrency.active, 0, 'slots must be released once jobs settle');

  // Fire more jobs than the cap allows; at least one must be refused with 429.
  const results = await Promise.all(
    Array.from({ length: before.concurrency.max + 2 }, () =>
      fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/notavideo', format: 'mp3' }),
      })
    )
  );

  const statuses = results.map((r) => r.status);
  assert.ok(statuses.includes(429), `expected backpressure, saw: ${statuses.join(', ')}`);
  assert.ok(statuses.includes(202), `expected some jobs accepted, saw: ${statuses.join(', ')}`);

  // Discard everything we just created, then let the slots drain so later
  // tests are not refused with a spurious 429.
  await Promise.all(
    results.map(async (r) => {
      if (r.status !== 202) return;
      const { job } = await r.json();
      await fetch(`${BASE}/api/jobs/${job.id}`, { method: 'DELETE' });
    })
  );
  await waitForFreeSlots();
});

/* ── 7. Section 3: metadata + one-shot downloader ───────────────── */

console.log('\nsection 3 endpoints');

await test('GET /api/info returns title, thumbnail and available resolutions', async () => {
  const res = await fetch(`${BASE}/api/info?url=${encodeURIComponent(TEST_URL)}`);
  assert.equal(res.status, 200);

  const { info } = await res.json();
  assert.ok(info.title, 'a title is required');
  assert.ok(info.thumbnail, 'a thumbnail is required');
  assert.ok(Number.isFinite(info.duration), 'a duration is required');

  assert.ok(Array.isArray(info.resolutions), 'resolutions must be an array');
  assert.ok(info.resolutions.length > 0, 'this video should expose resolutions');
  assert.ok(
    info.resolutions.every((h) => Number.isFinite(h) && h > 0),
    'resolutions must be plain positive numbers'
  );
  assert.deepEqual(
    info.resolutions,
    [...info.resolutions].sort((a, b) => b - a),
    'resolutions should be descending'
  );
  assert.equal(info.maxResolution, info.resolutions[0]);

  // Lightweight: the raw yt-dlp format dump must not be forwarded.
  assert.equal(info.formats, undefined, 'the full format list should not be returned');
});

await test('the default MP4 selector is bestvideo+bestaudio as specified', () => {
  const args = FORMATS.mp4.ytdlpArgs.join(' ');
  assert.match(args, /bestvideo\[ext=mp4\]\+bestaudio\[ext=m4a\]\/bestvideo\+bestaudio/, 'selector');
  assert.match(args, /--merge-output-format mp4/, 'must merge into mp4');
  assert.match(args, /--remux-video mp4/, 'must guarantee the mp4 container');
});

await test('the default MP4 selector resolves to a real format pair for a real video', async () => {
  // A cheap way to prove the selector is valid without transferring a 4K file:
  // ask yt-dlp to resolve it and report the chosen formats.
  const { stdout } = await execFileP(
    process.env.YTDLP_PATH || 'yt-dlp',
    [
      '--ignore-config',
      '--no-warnings',
      '--no-playlist',
      '--simulate',
      ...FORMATS.mp4.ytdlpArgs,
      '--print',
      '%(format_id)s|%(height)s',
      '--',
      TEST_URL,
    ],
    { timeout: 90_000 }
  );

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `selector resolved to nothing:\n${stdout}`);
  assert.ok(lines.every((line) => line.includes('|')), `unexpected print output: ${lines.join(', ')}`);
});

await test('POST /api/download takes { url, format } and streams a file download', async () => {
  const post = () =>
    fetch(`${BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_URL, format: 'mp3' }),
    });

  let res = await post();
  if (res.status === 502) {
    // Live third-party source under burst load; one retry, same assertions.
    console.log('      (upstream returned 502; retrying once)');
    await sleep(5000);
    res = await post();
  }

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.match(res.headers.get('content-disposition') || '', /^attachment;/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, Number(res.headers.get('content-length')));
  assert.ok(bytes.length > 100_000, 'a real audio file should come back');
  assert.ok(
    bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
    'the bytes should be a real MP3'
  );
});

await test('POST /api/download validates input before doing any work', async () => {
  for (const body of [{ format: 'mp3' }, { url: '' }, { url: 'nope' }, { url: 'file:///etc/passwd' }]) {
    const res = await fetch(`${BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    const payload = await res.json();
    assert.equal(payload.error.code, 'invalid_url');
  }
});

/* ── 8. Section 4: error handling ───────────────────────────────── */

console.log('\nsection 4 error handling');

await test('common yt-dlp failures become clean, actionable messages', () => {
  assert.equal(friendlyError('ERROR: This video is private'), 'That video is private, so it cannot be downloaded.');
  assert.equal(
    friendlyError('ERROR: The uploader has not made this video available in your country'),
    'That video is geo-restricted and is not available from this server.'
  );
  assert.equal(
    friendlyError('ERROR: Sign in to confirm you\u2019re not a bot'),
    'The source is asking for a bot check. Try again later, or from a different network.'
  );
  assert.equal(
    friendlyError('ERROR: Unable to download webpage: HTTP Error 404: Not Found'),
    'That page could not be found (404).'
  );
  assert.equal(friendlyError('ERROR: Unsupported URL: https://x.test/'), "That link isn't a supported video URL.");
});

await test('unrecognised errors are surfaced, never swallowed', () => {
  assert.equal(friendlyError('ERROR: a brand new failure mode'), 'a brand new failure mode');
  assert.equal(friendlyError('', 'fallback text'), 'fallback text');
});

await test('a broken link returns clean JSON and leaves the server running', async () => {
  const res = await fetch(`${BASE}/api/info?url=${encodeURIComponent('https://example.com/notavideo')}`);
  assert.equal(res.status, 502);

  const payload = await res.json();
  assert.ok(typeof payload.error?.message === 'string' && payload.error.message.length > 0);
  assert.ok(!payload.error.message.startsWith('ERROR:'), 'raw yt-dlp prefixes should be stripped');
  assert.equal(payload.error.code, 'extract_failed');

  // The important part: the process survived and still serves requests.
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

await test('every JSON error carries a machine-readable code', async () => {
  const cases = [
    [`${BASE}/api/download?url=nope`, 400],
    [`${BASE}/api/info?url=nope`, 400],
    [`${BASE}/api/nope`, 404],
  ];
  for (const [url, status] of cases) {
    const res = await fetch(url);
    assert.equal(res.status, status, url);
    const payload = await res.json();
    assert.ok(payload.error?.code, `missing code from ${url}`);
    assert.ok(payload.error?.message, `missing message from ${url}`);
  }
});

await test('rate limiting returns a clean 429 with Retry-After', async () => {
  // A dedicated server keeps this from poisoning the shared bucket used by the
  // rest of the suite.
  await withTempServer({ RATE_LIMIT_MAX: '4', PORT: '3199' }, async (base) => {
    const seen = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${base}/api/info?url=nope`);
      seen.push(res.status);
      if (res.status === 429) {
        assert.ok(res.headers.get('retry-after'), 'Retry-After should be present');
        const payload = await res.json();
        assert.equal(payload.error.code, 'rate_limited');
        assert.match(payload.error.message, /too many requests/i);
        return;
      }
    }
    assert.fail(`expected a 429 within 7 requests, saw: ${seen.join(', ')}`);
  });
});

await test('the rate limit does not apply to health checks', async () => {
  await withTempServer({ RATE_LIMIT_MAX: '3', PORT: '3198' }, async (base) => {
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200, 'health must stay reachable for monitoring');
    }
  });
});

/* ── 9. frontend (jsdom) ────────────────────────────────────────── */

console.log('\nfrontend (jsdom)');

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

/**
 * Boot the real page with stubbed `fetch` and `EventSource` (jsdom provides
 * neither), then run the real app.js inside it.
 */
async function bootDom({ fetchImpl, job }) {
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => consoleErrors.push(err));
  virtualConsole.on('error', (...args) => consoleErrors.push(new Error(args.join(' '))));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${BASE}/`,
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;

  const eventSources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      eventSources.push(this);
    }
    close() {
      this.closed = true;
    }
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }
  window.EventSource = FakeEventSource;
  window.fetch = fetchImpl;

  const saves = [];
  window.HTMLAnchorElement.prototype.click = function recordClick() {
    saves.push({ href: this.href, download: this.download });
  };
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', { value: { readText: async () => 'https://x.com/v' } });
  }

  const script = window.document.createElement('script');
  script.textContent = appJs;
  window.document.body.appendChild(script);

  await sleep(50);

  return { window, dom, eventSources, saves, consoleErrors, job };
}

/** fetch stub covering the two calls init() makes. */
const baseStub = (extra) => async (url, init) => {
  const target = String(url);
  if (target.startsWith('/api/health')) {
    return json({ ok: true, engine: { ytdlp: {}, ffmpeg: {} }, concurrency: { max: 3, active: 0 } });
  }
  if (target.startsWith('/api/formats')) return json({ formats: FORMAT_LIST });
  return extra(target, init);
};

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

await test('the form renders the spec placeholder, two tabs and the action button', async () => {
  const { window, dom, consoleErrors } = await bootDom({ fetchImpl: baseStub(() => json({}, 404)) });

  const { document } = window;
  assert.equal(
    document.getElementById('url').getAttribute('placeholder'),
    'Paste video link (YouTube, etc.)...'
  );
  assert.equal(document.getElementById('convert-label').textContent, 'Fetch & Convert');

  const tabs = [...document.querySelectorAll('#formats [data-format]')];
  assert.equal(tabs.length, 2, 'the spec calls for two tabs');
  assert.deepEqual(
    tabs.map((t) => t.textContent.trim()),
    ['MP4 Video', 'MP3 Audio']
  );
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'MP4 starts selected');
  assert.equal(document.getElementById('loading-panel').hidden, true);
  assert.equal(document.getElementById('success-card').hidden, true);

  assert.equal(consoleErrors.length, 0, `unexpected console errors: ${consoleErrors[0]?.message}`);
  dom.window.close();
});

await test('clicking a tab switches the selection', async () => {
  const { window, dom } = await bootDom({ fetchImpl: baseStub(() => json({}, 404)) });

  window.document.querySelector('[data-format="mp3"]').click();
  assert.equal(window.document.querySelector('[data-format="mp3"]').getAttribute('aria-selected'), 'true');
  assert.equal(window.document.querySelector('[data-format="mp4"]').getAttribute('aria-selected'), 'false');
  dom.window.close();
});

await test('a bad URL is rejected without creating a job', async () => {
  let posts = 0;
  const { window, dom } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (init?.method === 'POST') posts += 1;
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'not-a-url';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);

  assert.equal(posts, 0, 'no request should be made for invalid input');
  assert.equal(document.getElementById('url-error').hidden, false);
  assert.equal(document.getElementById('loading-panel').hidden, true);
  dom.window.close();
});

await test('submitting creates a job and shows live phase text', async () => {
  const created = {
    id: 'job-1',
    status: 'processing',
    phase: 'queued',
    phaseText: 'Queued...',
    pct: null,
    info: null,
    file: null,
  };

  let postedBody = null;
  const { window, dom, eventSources } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') {
        postedBody = JSON.parse(init.body);
        return json({ job: created }, 202);
      }
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.querySelector('[data-format="mp3"]').click();
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await sleep(60);

  assert.ok(postedBody, 'a job should have been created');
  assert.equal(postedBody.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(postedBody.format, 'mp3', 'the selected tab must reach the server');

  assert.equal(document.getElementById('loading-panel').hidden, false, 'loading panel should show');
  assert.equal(document.getElementById('form').hidden, true, 'the form should give way to progress');
  assert.equal(document.getElementById('convert-btn').disabled, true);

  assert.equal(eventSources.length, 1, 'the phase stream should be opened');
  assert.equal(eventSources[0].url, '/api/jobs/job-1/events');

  // Walk through every phase the spec names, driven by the SSE stub.
  const phase = (payload) =>
    eventSources[0].emit({ ...created, ...payload });

  phase({ phase: 'metadata', phaseText: 'Extracting metadata...', pct: null });
  assert.equal(document.getElementById('phase-text').textContent, 'Extracting metadata...');

  phase({ phase: 'downloading', phaseText: 'Downloading media...', pct: 42.6 });
  assert.equal(document.getElementById('phase-text').textContent, 'Downloading media...');
  assert.equal(document.getElementById('phase-pct').textContent, '43%', 'progress should be shown');
  assert.match(document.getElementById('phase-bar').style.width, /^43%$/);

  phase({ phase: 'converting', phaseText: 'Converting stream...', pct: null });
  assert.equal(document.getElementById('phase-text').textContent, 'Converting stream...');

  phase({ phase: 'finalizing', phaseText: 'Finalizing file...', pct: null });
  assert.equal(document.getElementById('phase-text').textContent, 'Finalizing file...');

  dom.window.close();
});

await test('reaching ready renders the success card with title, duration and a save link', async () => {
  const created = { id: 'job-2', status: 'processing', phase: 'queued', phaseText: 'Queued...' };
  const ready = {
    id: 'job-2',
    status: 'ready',
    phase: 'ready',
    phaseText: 'Ready',
    pct: 100,
    info: {
      title: 'Big Buck Bunny 60fps 4K',
      duration: 635,
      thumbnail: 'https://i.ytimg.com/vi_webp/abc/maxresdefault.webp',
      uploader: 'Blender',
    },
    file: { name: 'Big Buck Bunny 60fps 4K [abc].mp3', size: 19_037_396, mime: 'audio/mpeg', extension: 'mp3' },
    expiresAt: Date.now() + 30 * 60 * 1000,
  };

  const { window, dom, eventSources } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') return json({ job: created }, 202);
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);

  eventSources[0].emit(ready);
  await sleep(20);

  assert.equal(document.getElementById('success-card').hidden, false, 'success card should appear');
  assert.equal(document.getElementById('loading-panel').hidden, true, 'loading state should end');
  assert.equal(document.getElementById('form').hidden, true);

  // The success card contents required by the spec.
  assert.equal(document.getElementById('result-title').textContent, 'Big Buck Bunny 60fps 4K');
  assert.equal(document.getElementById('result-duration').textContent, '10:35');
  assert.equal(document.getElementById('result-thumb').hidden, false);
  assert.equal(
    document.getElementById('result-thumb').getAttribute('src'),
    'https://i.ytimg.com/vi_webp/abc/maxresdefault.webp'
  );
  // 19_037_396 bytes -> 18.155 MiB -> rounded to whole MiB above 10.
  assert.equal(document.getElementById('result-size').textContent, '18 MB');
  assert.equal(document.getElementById('save-btn').textContent.trim().includes('Download File to Device'), true);

  // The save button must point at the staged file and name it for the browser.
  assert.equal(document.getElementById('save-btn').getAttribute('href'), '/api/jobs/job-2/file');
  assert.equal(document.getElementById('save-btn').getAttribute('download'), 'Big Buck Bunny 60fps 4K [abc].mp3');

  // The stream should be closed once settled, not left to auto-reconnect.
  assert.equal(eventSources[0].closed, true);

  assert.equal(document.getElementById('convert-btn').disabled, false, 'the button should be usable again');

  // "Convert another" returns to a clean form.
  document.getElementById('again-btn').click();
  assert.equal(document.getElementById('form').hidden, false);
  assert.equal(document.getElementById('success-card').hidden, true);
  dom.window.close();
});

await test('the save button goes one-shot, matching the server-side cleanup', async () => {
  // The server releases the staged file as soon as the stream completes, so the
  // UI must stop offering it rather than silently 404 later.
  const created = { id: 'job-5', status: 'processing', phase: 'queued', phaseText: 'Queued...' };
  const ready = {
    id: 'job-5',
    status: 'ready',
    phase: 'ready',
    phaseText: 'Ready',
    pct: 100,
    info: { title: 'Clip', duration: 60, thumbnail: null, uploader: null },
    file: { name: 'Clip [abc].mp3', size: 1000, mime: 'audio/mpeg', extension: 'mp3' },
    expiresAt: Date.now() + 60_000,
  };

  const { window, dom, eventSources } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') return json({ job: created }, 202);
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);
  eventSources[0].emit(ready);
  await sleep(20);

  const save = document.getElementById('save-btn');
  assert.equal(save.getAttribute('aria-disabled'), null, 'the file is offered on arrival');
  assert.equal(save.getAttribute('href'), '/api/jobs/job-5/file');

  save.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(40);
  assert.equal(document.getElementById('save-hint').hidden, false, 'feedback while saving');

  await sleep(1700);
  assert.equal(save.getAttribute('aria-disabled'), 'true', 'one-shot after delivery');
  assert.match(document.getElementById('save-hint').textContent, /released the staged file/);
  dom.window.close();
});

await test('a failed job surfaces the server message on the form', async () => {
  const created = { id: 'job-3', status: 'processing', phase: 'queued', phaseText: 'Queued...' };

  const { window, dom, eventSources } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') return json({ job: created }, 202);
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);

  eventSources[0].emit({
    id: 'job-3',
    status: 'error',
    phase: 'metadata',
    phaseText: 'Extracting metadata...',
    error: { message: 'Video unavailable', code: 'processing_failed' },
  });
  await sleep(20);

  assert.equal(document.getElementById('error').hidden, false);
  assert.equal(document.getElementById('error-text').textContent, 'Video unavailable');
  assert.equal(document.getElementById('success-card').hidden, true);
  assert.equal(document.getElementById('form').hidden, false, 'the user should be able to retry');
  dom.window.close();
});

await test('a job rejected with 429 reports busy rather than hanging', async () => {
  const { window, dom } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') {
        return json({ error: { message: 'The server is busy with other conversions.', code: 'busy' } }, 429);
      }
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);

  assert.equal(document.getElementById('error-text').textContent, 'The server is busy with other conversions.');
  assert.equal(document.getElementById('loading-panel').hidden, true);
  assert.equal(document.getElementById('convert-btn').disabled, false);
  dom.window.close();
});

await test('cancel discards the job and returns to the form', async () => {
  const created = { id: 'job-4', status: 'processing', phase: 'metadata', phaseText: 'Extracting metadata...' };
  let deleted = 0;

  const { window, dom, eventSources } = await bootDom({
    fetchImpl: baseStub((url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') return json({ job: created }, 202);
      if (url === '/api/jobs/job-4' && init?.method === 'DELETE') {
        deleted += 1;
        return json({ ok: true });
      }
      return json({}, 404);
    }),
  });

  const { document } = window;
  document.getElementById('url').value = 'https://www.youtube.com/watch?v=abc';
  document.getElementById('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);

  document.getElementById('cancel-btn').click();
  await sleep(60);

  assert.equal(deleted, 1, 'the job should be discarded server-side');
  assert.equal(document.getElementById('form').hidden, false);
  assert.equal(document.getElementById('loading-panel').hidden, true);
  assert.equal(eventSources[0].closed, true, 'the stream should be closed');
  dom.window.close();
});

await test('the engine banner degrades when a binary is missing', async () => {
  const { window, dom } = await bootDom({
    fetchImpl: async (url) => {
      if (String(url).startsWith('/api/health')) {
        return json({ ok: false, engine: { ytdlp: { available: true }, ffmpeg: { available: false } } });
      }
      if (String(url).startsWith('/api/formats')) return json({ formats: FORMAT_LIST });
      return json({}, 404);
    },
  });

  const { document } = window;
  assert.equal(document.getElementById('engine-label').textContent, 'missing ffmpeg');
  assert.match(document.getElementById('error-text').textContent, /could not find ffmpeg/i);
  dom.window.close();
});

/* ── summary ────────────────────────────────────────────────────── */

stopTestServer();

console.log(`\n${passed} passed, ${failures.length} failed\n`);

if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n\u001b[31m${name}\u001b[0m\n${err.stack}\n`);
  }
  process.exit(1);
}
