# MD-TOOL

A minimalist web media downloader: paste a link, pick a format, save the file.
Express backend wrapping **yt-dlp** + **FFmpeg**, with a single-page dark UI.

Not YouTube-specific: any public video or audio page works, because the URL is
handed straight to yt-dlp. That covers YouTube, Vimeo, TikTok, Instagram,
SoundCloud, Bandcamp, Dailymotion and hundreds more sites.

```
Browser ──POST /api/jobs──▶ Express ──spawn──▶ yt-dlp ──▶ ffmpeg
                               │                 │
                               │      staged in a private temp dir
                               ▼                 │
                     SSE phase updates           │
                               │                 │
        success card ──GET /api/jobs/:id/file──▶ streamed attachment
```

## Requirements

| Dependency | Notes |
| --- | --- |
| Node.js ≥ 18 | ESM |
| `yt-dlp` | on `PATH`, or set `YTDLP_PATH` |
| `ffmpeg` **and** `ffprobe` | merging, extraction and remuxing; or set `FFMPEG_PATH` |

`GET /api/health` reports both; the UI shows a status pill in the header.

> `FFMPEG_PATH` / `YTDLP_PATH` must be a real **path** when set. yt-dlp does not
> resolve bare command names against `PATH` for `--ffmpeg-location`, so the flag
> is only forwarded when the value contains a separator.

## Setup

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, with --watch
```

## Deploy

A container host is required. The app spawns `yt-dlp` and `ffmpeg`, runs
conversions that take minutes, streams progress over SSE, and keeps job state in
memory — none of which fits a serverless platform.

> **Vercel will not work here.** Serverless functions have no `yt-dlp`/`ffmpeg`
> and can't install them, time out long before a 15-minute download finishes,
> freeze after the `202` response so the background job never completes, and
> don't keep the in-memory job map or the SSE connection across invocations.

The `Dockerfile` installs both binaries (yt-dlp as a standalone build, so no
Python is needed) and runs the server unchanged:

```bash
docker build -t md-tool .
docker run -p 3000:3000 md-tool
```

### Fly.io

```bash
fly launch --no-deploy     # accept the Dockerfile; pick a unique app name
fly deploy
fly secrets set SITE_URL="https://<your-app>.fly.dev"   # canonical/OG/sitemap origin
```

`fly.toml` ships with an `/api/health` check and `force_https = true`. Because
jobs live in memory and progress is streamed with SSE, **run a single machine**
(`auto_stop_machines = false` is already set) — a second instance would not see
the first one's jobs. Any Docker host (Render, Railway, a VPS) works the same
way; only `fly.toml` is Fly-specific.

## SEO & deployment

The page ships with canonical + Open Graph/Twitter tags, JSON-LD schema and a
single `<h1>`. Crawler routes are generated per request so they always carry the
right origin:

| Route | Contents |
| --- | --- |
| `/robots.txt` | `Allow: /`, `Disallow: /api/`, sitemap pointer |
| `/sitemap.xml` | the single page |
| `/llms.txt` | a short plain-text summary for AI crawlers |
| `/og.svg` | 1200×630 social preview image |

Set these before deploying:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SITE_URL` | `http://localhost:$PORT` | Origin used by canonical/OG tags, the sitemap and robots.txt |
| `GOOGLE_SITE_VERIFICATION` | — | Search Console token; injected into `<head>` when set |

`/index.html` 301-redirects to `/`, so the page has exactly one canonical URL.
With an `https://` `SITE_URL` the app also sends `Strict-Transport-Security` and
308-redirects requests whose `X-Forwarded-Proto` is `http`; both are inert on
localhost.

> The OG image is an SVG. Facebook and X do not render SVG previews, so rasterise
> `public/og.svg` to `public/og.png` and update the `og:image` / `twitter:image`
> tags before relying on it. Search Console verification needs a token from your
> own Google account and cannot be automated here.

## The UI

Three states, driven by one job:

1. **Form** — paste a link, pick a format tab (`MP4 Video` / `MP3 Audio`), press
   **Fetch & Convert**. Invalid URLs are rejected client-side, with no request.
2. **Loading** — a spinner with status text driven by the real yt-dlp stage,
   pushed over Server-Sent Events: `Extracting metadata...`, then live download
   progress, then `Converting stream...`, then `Finalizing file...`. A cancel
   button discards the job.
3. **Success card** — thumbnail, title, duration, uploader, size, plus a
   **Download File to Device** button. The file is already staged on the server,
   so that click is a plain link navigation: the browser streams it straight to
   disk using the `Content-Disposition` filename, with nothing buffered in JS.

The phase labels are derived from actual yt-dlp output, not a timer — see
`lib/phases.js` for the observed markers.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Binary availability, versions, concurrency, job counts |
| `GET` | `/api/formats` | Selectable output formats |
| `GET` | `/api/info?url=` | Title, thumbnail, duration and available resolutions |
| `POST` | `/api/jobs` | `{ url, format }` → `202` with a job; starts processing |
| `GET` | `/api/jobs/:id` | Poll a job's state |
| `GET` | `/api/jobs/:id/events` | SSE stream of phase updates |
| `GET` | `/api/jobs/:id/file` | Stream the finished file as an attachment |
| `DELETE` | `/api/jobs/:id` | Cancel and discard a job |
| `POST` | `/api/download` | `{ url, format }` → process **and** stream in one request |
| `GET` | `/api/download?url=&format=` | Same, as a plain downloadable link |

Errors are always JSON: `{ "error": { "message": "...", "code": "..." } }`.

**Why two download paths?** `/api/jobs` exists so the UI can show metadata and a
save button *before* the bytes move. `POST /api/download` is the one-shot
endpoint: it pipes the finished file straight into the response, so a plain
`curl` or form post gets a standard file download. Both share the same engine.

`GET /api/jobs/:id/file` is also directly linkable, so very large files can be
fetched by the browser without any JS involvement.

### Formats

| id | Output |
| --- | --- |
| `mp4` | `bestvideo+bestaudio` merged and remuxed into an MP4 container |
| `mp3` | `-x --audio-format mp3 --audio-quality 0` |
| `m4a` | `-x --audio-format m4a` — reachable via the API, not shown as a tab |

The MP4 selector prefers an H.264/AAC pair (the combination that plays
everywhere) and falls back to whatever is best, which is what a plain
`bestvideo+bestaudio` would have picked anyway. Unset `MAX_VIDEO_HEIGHT` means
genuinely best available — 2160p for a 4K source.

## How a download is produced

1. The URL is validated and the format resolved to yt-dlp arguments.
2. One yt-dlp process runs into a private temp directory
   (`$TMPDIR/md-tool/job-*`). It reports metadata at the `before_dl`
   stage and the finished path at `after_move`, so a conversion costs exactly
   one process and still yields a real title, duration and thumbnail.
3. The finished file is streamed to the client with its true size and name.

**Why not pipe yt-dlp's stdout?** `-o -` is incompatible with yt-dlp's
post-processing: merging a video+audio pair, extracting audio, or remuxing all
need FFmpeg to read and write seekable files. Staging to a temp file is what
makes MP4 and MP3 work at all. The client still receives a single streamed
response.

## Guarantees (security and error handling)

- **Input validation** on both sides. Client-side checks give instant feedback
  with no request; the server independently rejects anything that is not a plain
  public `http(s)` URL — no other schemes, no embedded credentials, and no
  loopback, link-local, private-range or `.internal`/`.local` hosts, including
  IPv6 and IPv4-mapped forms (`::ffff:7f00:1`). Arguments are passed as an array
  with `shell: false` and a `--` separator, so a URL cannot be read as a flag.
- **Immediate temp cleanup.** Staged files are deleted the moment the stream
  finishes, on error, when the client disconnects, and on shutdown. Jobs that
  are never downloaded expire after `JOB_TTL_MS` (30 min). Orphans older than two
  hours are swept at startup. Because delivery deletes the file, the save button
  is intentionally one-shot; converting again produces a fresh copy.
- **Rate limiting** per client (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`),
  answering `429` with `Retry-After`. Concurrency is separately capped, so a
  client that stays within its request budget still cannot monopolise the engine.
- **Graceful failures.** Common yt-dlp failures — private, members-only,
  age-restricted, geo-blocked, removed, bot-check, 404/403, timeouts, unsupported
  URLs — are mapped to plain-language `502` JSON. Unrecognised errors fall
  through to the raw yt-dlp line rather than being swallowed, and unhandled
  rejections and exceptions are logged without taking the process down.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Concurrent conversions; excess callers get `429` |
| `RATE_LIMIT_MAX` | `30` | Requests per client per window on expensive routes |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `JOB_TTL_MS` | `1800000` | How long an undownloaded staged file is kept |
| `MAX_VIDEO_HEIGHT` | `0` (best) | Optional resolution ceiling for MP4 |
| `DOWNLOAD_TIMEOUT_MS` | `900000` | Per-conversion wall-clock limit |
| `INFO_TIMEOUT_MS` | `60000` | Metadata timeout |
| `MAX_FILENAME_BYTES` | `120` | Attachment filename budget |
| `YTDLP_PATH` / `FFMPEG_PATH` | `yt-dlp` / `ffmpeg` | Binary overrides |

## Tests

```bash
npm test          # 61 checks
npm run check     # syntax-check every source file
```

`npm test` is self-contained: it starts its own server on port `3210` with a
raised rate limit, and shuts it down afterwards. Point it at an existing server
with `BASE_URL=…` (that server's own limits then apply).

Coverage: pure helpers (validation, formats, filenames, headers, phase parsing),
the HTTP contract including error paths, the full job flow over a real SSE
connection ending in a real downloaded MP3, the one-shot `POST /api/download`,
rate limiting, and the UI. The UI section loads the real `index.html` and
executes the real `app.js` under jsdom with `fetch` and `EventSource` stubbed,
driving all three states and asserting the spec's placeholder, tab labels,
button text, phase strings and success-card contents.

Two tests hit a live third-party source. Each allows **one** retry if the
upstream refuses a burst; the assertions are identical either way.

## Limitations

- No authentication — this is a local utility. Do not expose it publicly.
- Jobs live in memory and vanish on restart; there is no database.
- The UI's save step hands the file to the browser, so download progress is the
  browser's, not the app's.
- jsdom is not a browser, so render and CSS correctness are unverified.
