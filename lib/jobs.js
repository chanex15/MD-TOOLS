/**
 * In-memory job store for the two-step flow described by the UI spec:
 * process a link, show a success card, then let the user pull the finished file
 * down on demand.
 *
 * A job owns a staged temp directory. It is deleted when the job expires, is
 * cancelled, or the process exits — see lib/downloader.js for the on-disk
 * staging itself.
 *
 * No database: jobs live in a Map and vanish on restart. That is appropriate
 * for a single-user local utility, and it keeps the file bytes off the wire
 * until the user actually clicks "Download File to Device".
 */

import crypto from 'node:crypto';
import { removeTempDir } from './downloader.js';
import { phaseText } from './phases.js';

const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 30 * 60 * 1000);
const SWEEP_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();
/** @type {Map<string, Set<import('express').Response>>} */
const subscribers = new Map();
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const processes = new Map();

let sweepTimer = null;

export function createJob({ url, format }) {
  const id = crypto.randomUUID();
  const now = Date.now();

  const job = {
    id,
    url,
    format,
    status: 'processing', // processing | ready | error | cancelled
    phase: 'queued',
    pct: null,
    info: null,
    file: null,
    error: null,
    createdAt: now,
    readyAt: null,
    expiresAt: null,
  };

  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function registerProcess(id, child) {
  processes.set(id, child);
}

/** Update a job and push the new state to anyone watching it. */
export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;

  Object.assign(job, patch);

  // Every settled job gets a deadline, not just successful ones. A failed job
  // holds no file, but without this it would never be swept and the store would
  // grow for the lifetime of the process.
  const settled = job.status === 'ready' || job.status === 'error' || job.status === 'cancelled';
  if (settled && !job.expiresAt) {
    if (job.status === 'ready') job.readyAt = Date.now();
    job.expiresAt = Date.now() + JOB_TTL_MS;
  }

  publish(job);
  return job;
}

/** Advance the phase only if it actually changed, to avoid spamming SSE. */
export function setPhase(id, phase, pct = null) {
  const job = jobs.get(id);
  if (!job || job.status !== 'processing') return;

  const changed = job.phase !== phase || (pct !== null && job.pct !== pct);
  if (!changed) return;

  job.phase = phase;
  job.pct = pct;
  publish(job);
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

/** Client-facing view. Deliberately omits the server-side temp path. */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    phaseText: phaseText(job.phase),
    pct: job.pct,
    info: job.info,
    file: job.file,
    error: job.error,
    createdAt: job.createdAt,
    readyAt: job.readyAt,
    expiresAt: job.expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function publish(job) {
  const watchers = subscribers.get(job.id);
  if (!watchers || watchers.size === 0) return;

  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of watchers) {
    try {
      res.write(payload);
    } catch {
      /* the connection is already gone; 'close' will clean it up */
    }
  }
}

export function subscribe(id, res) {
  if (!subscribers.has(id)) subscribers.set(id, new Set());
  const watchers = subscribers.get(id);
  watchers.add(res);

  // Mirror the current state immediately, so a client that subscribes after the
  // job already advanced (or even finished) is never left waiting.
  const job = jobs.get(id);
  if (job) {
    try {
      res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
    } catch {
      /* ignore */
    }
  }

  // Keep intermediaries from dropping an idle connection during a slow convert.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    watchers.delete(res);
    if (watchers.size === 0) subscribers.delete(id);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
}

export function subscriberCount(id) {
  return subscribers.get(id)?.size ?? 0;
}

/* ------------------------------------------------------------------ */
/* Teardown                                                            */
/* ------------------------------------------------------------------ */

export function cancelJob(id, reason = 'Cancelled.') {
  const job = jobs.get(id);
  const child = processes.get(id);
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    processes.delete(id);
  }
  if (job) updateJob(id, { status: 'cancelled', error: { message: reason, code: 'cancelled' } });
  return Boolean(job || child);
}

/** Release the staged file and forget the job. */
export async function deleteJob(id) {
  const job = jobs.get(id);
  processes.delete(id);

  const watchers = subscribers.get(id);
  if (watchers) {
    for (const res of watchers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    subscribers.delete(id);
  }

  jobs.delete(id);

  if (job?.dir) await removeTempDir(job.dir);
  return Boolean(job);
}

export function activeCount() {
  let processing = 0;
  let ready = 0;
  for (const job of jobs.values()) {
    if (job.status === 'processing') processing += 1;
    else if (job.status === 'ready') ready += 1;
  }
  return { processing, ready, total: jobs.size };
}

export function listJobs() {
  return [...jobs.values()].map(publicJob);
}

/** Drop jobs that have outlived their TTL, freeing their temp directories. */
export async function sweepExpiredJobs() {
  const now = Date.now();
  const doomed = [];

  for (const job of jobs.values()) {
    if (job.expiresAt && job.expiresAt <= now) doomed.push(job.id);
    // A processing job killed mid-flight (e.g. crash recovery) still needs a bound.
    else if (job.status === 'processing' && now - job.createdAt > JOB_TTL_MS * 2) doomed.push(job.id);
  }

  await Promise.all(doomed.map((id) => deleteJob(id)));
  return doomed.length;
}

export function startJobSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepExpiredJobs().catch((err) => console.warn('[jobs] sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export async function shutdownJobs() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await Promise.all([...jobs.keys()].map((id) => deleteJob(id)));
}

export { JOB_TTL_MS };
