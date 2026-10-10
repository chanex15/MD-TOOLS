/**
 * Output format catalogue.
 *
 * Each entry maps a UI toggle to the exact yt-dlp arguments needed to produce
 * that output. Anything that requires a container change or a re-encode is
 * delegated to ffmpeg by yt-dlp itself (`--merge-output-format`,
 * `--remux-video`, `-x --audio-format`), which is why ffmpeg must be on PATH.
 */

/**
 * Optional resolution ceiling for video output.
 *
 * Unset (the default) means "best available", matching the documented
 * `bestvideo+bestaudio` behaviour. Set `MAX_VIDEO_HEIGHT=720` (etc.) to trade
 * quality for smaller, faster downloads.
 */
export const VIDEO_HEIGHT_CAP = Number(process.env.MAX_VIDEO_HEIGHT || 0) || 0;

/**
 * Video selector for MP4 output.
 *
 * Prefers an H.264/AAC pair because that is the combination that plays
 * everywhere, then falls back to whatever is best — which is what the spec's
 * plain `bestvideo+bestaudio` would have chosen anyway. `--merge-output-format`
 * and `--remux-video` guarantee the container really is mp4.
 */
function videoSelector() {
  const cap = VIDEO_HEIGHT_CAP > 0 ? `[height<=${VIDEO_HEIGHT_CAP}]` : '';
  return [
    `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo${cap}+bestaudio`,
    `bv*${cap}+ba`,
    `b${cap}`,
  ].join('/');
}

export const DEFAULT_FORMAT = 'mp4';

export const FORMATS = {
  mp4: {
    id: 'mp4',
    label: 'MP4',
    tabLabel: 'MP4 Video',
    featured: true,
    hint:
      VIDEO_HEIGHT_CAP > 0
        ? `Video + audio, capped at ${VIDEO_HEIGHT_CAP}p`
        : 'Video + audio, best available quality',
    kind: 'video',
    ext: 'mp4',
    mime: 'video/mp4',
    ytdlpArgs: [
      '-f',
      videoSelector(),
      '--merge-output-format',
      'mp4',
      '--remux-video',
      'mp4',
    ],
  },

  mp3: {
    id: 'mp3',
    label: 'MP3',
    tabLabel: 'MP3 Audio',
    featured: true,
    hint: 'Audio only, best quality',
    kind: 'audio',
    ext: 'mp3',
    mime: 'audio/mpeg',
    ytdlpArgs: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  },

  // Reachable through the API (?format=m4a) but intentionally not shown as a
  // tab: the UI spec calls for exactly two, MP4 Video and MP3 Audio.
  m4a: {
    id: 'm4a',
    label: 'M4A',
    tabLabel: 'M4A Audio',
    featured: false,
    hint: 'Audio only, AAC in MP4',
    kind: 'audio',
    ext: 'm4a',
    mime: 'audio/mp4',
    ytdlpArgs: ['-x', '--audio-format', 'm4a', '--audio-quality', '0'],
  },
};

/** Public, serialisable description of the format list for the frontend. */
export const FORMAT_LIST = Object.values(FORMATS).map(
  ({ id, label, tabLabel, featured, hint, kind, ext }) => ({ id, label, tabLabel, featured, hint, kind, ext })
);

/** The subset the UI renders as format tabs. */
export const FORMAT_TABS = FORMAT_LIST.filter((format) => format.featured);

export function resolveFormat(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return FORMATS[key] ?? FORMATS[DEFAULT_FORMAT];
}

/**
 * Best-effort MIME type from the extension yt-dlp actually produced. yt-dlp can
 * legitimately hand back a different container than requested (e.g. it keeps
 * `.webm` if a remux fails), so the real extension wins over the requested one.
 */
const EXT_MIME = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

export function mimeForExtension(ext, fallback = 'application/octet-stream') {
  return EXT_MIME[String(ext).toLowerCase()] ?? fallback;
}
