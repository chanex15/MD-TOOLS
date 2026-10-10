/**
 * Translation of yt-dlp's stdout into UI-facing progress phases.
 *
 * yt-dlp writes its progress *and* its status lines to **stdout** (stderr is
 * reserved for warnings and errors), which was confirmed empirically:
 *
 *   [youtube] Extracting URL: …      -> metadata
 *   [info] … Downloading 1 format(s) -> metadata
 *   [download] Destination: …        -> media transfer begins
 *   [download]  45.2% of 9.73MiB…    -> media transfer progress
 *   [Merger] Merging formats into …  -> ffmpeg post-processing
 *   [ExtractAudio] Destination: …    -> ffmpeg post-processing
 *   [VideoRemuxer] …                 -> ffmpeg post-processing
 *
 * The phase labels therefore reflect work that has actually started, rather
 * than being cycled on a timer.
 */

export const PHASE_TEXT = {
  queued: 'Queued...',
  metadata: 'Extracting metadata...',
  downloading: 'Downloading media...',
  converting: 'Converting stream...',
  finalizing: 'Finalizing file...',
};

/** Post-processing stages, all of which are ffmpeg work. */
const CONVERTING_PREFIXES = [
  '[ExtractAudio]',
  '[Merger]',
  '[Muxer]',
  '[VideoConvertor]',
  '[VideoRemuxer]',
  '[FixupM4a]',
  '[FixupStretched]',
  '[FixupM3u8]',
  '[Metadata]',
  '[EmbedThumbnail]',
  '[ThumbnailsConvertor]',
  '[SplitChapters]',
];

const METADATA_PREFIXES = ['[youtube]', '[info]', '[generic]', '[vimeo]', '[twitch]', '[soundcloud]'];

/**
 * Interpret one line of yt-dlp stdout.
 * @returns {{ phase: string, pct?: number } | null} null when the line carries
 *   no phase information (most lines).
 */
export function interpretYtDlpLine(line) {
  if (typeof line !== 'string' || line === '') return null;

  const percent = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (percent) {
    const pct = Number(percent[1]);
    return { phase: 'downloading', pct: Number.isFinite(pct) ? pct : 0 };
  }

  if (/^\[download\]\s+Destination:/.test(line)) {
    return { phase: 'downloading', pct: 0 };
  }

  // Already-downloaded fragment, e.g. resuming or a cached fragment.
  if (/^\[download\]\s+.*has already been downloaded/.test(line)) {
    return { phase: 'downloading', pct: 100 };
  }

  const prefix = /^(\[[A-Za-z0-9]+\])/.exec(line);
  if (prefix) {
    if (CONVERTING_PREFIXES.some((p) => p.toLowerCase() === prefix[1].toLowerCase())) {
      return { phase: 'converting' };
    }
    if (METADATA_PREFIXES.some((p) => p.toLowerCase() === prefix[1].toLowerCase())) {
      return { phase: 'metadata' };
    }
  }

  return null;
}

export function phaseText(phase) {
  return PHASE_TEXT[phase] ?? PHASE_TEXT.queued;
}
