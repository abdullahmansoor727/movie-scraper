![Example](example.gif)

# 🎬 Zenith Movies (Ad-Free Scraper)

A simple movie streaming frontend that pulls video sources using scripts originally based on Vidlink. This version removes ads and provides a clean, minimal playback experience.

## 🚀 Features

* 🎥 Stream movies directly in-browser
* ⚡ Fast loading using HLS streams
* 🚫 No ads (cleaned version of original scripts)
* 🌐 Deployed easily with Netlify
* 🔗 Simple URL-based playback system
* 🔎 Copy the proxied HLS playlist URL for debugging
* ⬇️ Experimental browser download through the Netlify HLS proxy
* 💬 Best-effort subtitle loading when the stream source provides tracks

## 🧠 How It Works

This project uses a scraping/proxy approach to retrieve video streams and display them in a native HTML5 player.

Example:

```
https://your-site.netlify.app/?id=550
```

* `id` = Movie ID (typically from TMDB or similar source)
* The app fetches and injects the stream into a video player
* Playback is handled using HLS

## 📁 Project Structure

```
/
├── index.html        # Main frontend/player
├── netlify.toml      # Netlify functions + redirect config
├── script.js         # WASM helper script loaded by the function
├── fu.wasm           # WASM helper loaded by the function
└── /api
    └── index.js      # Netlify function for stream lookup + proxying
```

## 🧑‍💻 Local Development

Install dependencies:

```bash
npm install
```

Run the app with the Netlify CLI:

```bash
npm install -g netlify-cli
npm start
```

Or without installing the CLI globally:

```bash
npx netlify-cli dev
```

Then open:

```text
http://localhost:8888/?id=550
```

For the stable backend downloader, run this in a second terminal:

```bash
npm run download-service
```

That starts a local service on:

```text
http://localhost:5050
```

The new downloader is a separate TypeScript-first service under:

```text
apps/downloader
```

It runs as one local stack by default:

- API service
- worker loop
- notifier loop

You can also start them separately:

```bash
npm run download-api
npm run download-worker
npm run download-notifier
npm run download-optimizer
```

Optional Plex refresh config:

```bash
PLEX_URL=http://127.0.0.1:32400
PLEX_TOKEN=your-plex-token
PLEX_LIBRARY_SECTION_ID=1
PLEX_WATCH_DIR=/path/plex/can-see
npm run download-service
```

After a download reaches `completed` or `completed_with_warnings`, the downloader calls Plex's library refresh endpoint for the configured section and final file path. You can also provide `PLEX_REFRESH_URL` with `{path}` and `{token}` placeholders if your Plex setup needs a custom refresh URL.

Optional disk/space controls:

```bash
DOWNLOAD_MIN_FREE_SPACE_GB=10
DOWNLOAD_GLOBAL_MAX_CONCURRENCY=24
DOWNLOAD_DELETE_TS_AFTER_CLEAN_MP4=false
npm run download-service
```

The worker will not start or resume downloads when free disk is below `DOWNLOAD_MIN_FREE_SPACE_GB`. Active jobs that hit disk exhaustion are stalled with a clear disk-space reason and retried later instead of becoming terminal failures. `DOWNLOAD_GLOBAL_MAX_CONCURRENCY` caps total segment pressure across active jobs; each job gets a fair per-job ceiling based on active download count. By default clean MP4 jobs delete the TS source after successful remux, while warning/skipped-segment jobs keep their TS fallback.

Optional optimizer config:

```bash
OPTIMIZER_ENABLED=true
OPTIMIZER_CODEC=libx265
OPTIMIZER_CRF=23
OPTIMIZER_PRESET=slow
OPTIMIZER_AUDIO_MODE=copy
OPTIMIZER_AUTO_QUEUE=true
OPTIMIZER_DELETE_SOURCE_AFTER_SUCCESS=false
npm run download-service
```

The optimizer is a separate background queue. Completed downloads are automatically queued when `OPTIMIZER_AUTO_QUEUE=true`; it can also be started manually with `POST /downloads/:id/optimize`. It writes an H.265 MKV beside the completed file, validates it with `ffprobe`, and then updates the job to point at the optimized artifact. The cleanup API is intentionally explicit:

```text
GET  /cleanup/preview
POST /cleanup/apply
GET  /optimizations
```

`/cleanup/preview` reports reclaimable source TS files for clean MP4/MKV jobs plus stale completed staging files. `/cleanup/apply` deletes only those previewed safe files.

## 🛠️ Deployment (Netlify)

1. Clone or fork this repo
2. Go to https://netlify.com
3. Click **"Add New Project"**
4. Import your repo
5. Deploy

Netlify reads `netlify.toml`, serves `index.html`, and routes `/api` to the serverless function at `api/index.js`.

Once deployed, your site will be live instantly.

## ⚠️ Important Notes

* This project is for **educational purposes only**
* Streaming copyrighted content without permission may violate laws in your country
* The original scripts were modified to remove ads, but credit belongs to their respective creators

## 📌 Usage

Just open:

```
https://your-netlify-site.netlify.app/?id=MOVIE_ID
```

For TV episodes:

```text
https://your-netlify-site.netlify.app/?id=TV_ID&s=1&e=1
```

When a stream is ready, use the `HLS URL` button to copy the proxied playlist URL.

Use `Download` to try a browser-side HLS download through the Netlify proxy. If the stream has multiple variants, the app will ask which quality to fetch, and the chosen quality is included in the suggested filename. Filenames now use the movie or series title when TMDB metadata is available, for example `Movie Name (2024)-1920x1080-4500-kbps.ts` or `Show Name - S01E02 - Episode Title-1280x720-1800-kbps.ts`. On Chromium browsers that support the File System Access API, the downloader opens the save picker on the click path and streams segments directly into the chosen file instead of buffering the whole video in memory. Other browsers fall back to the in-memory `.ts` / `.mp4` assembly path. The downloader starts at concurrency `3`, can step up to `4` when the proxy is healthy, and drops back under rate limiting. If a download fails mid-stream, the app keeps the partial file and stores resume progress in the browser so the next `Download` can continue from the last completed segment. Reloading or closing the page during an active streamed write can still invalidate the browser temp file, so the app now warns before navigation while a download is running.

When the stream source exposes subtitle tracks, the player adds them to the native HTML5 subtitle menu through the existing subtitle proxy route.

Use `Server Download` to start a parallel local backend job instead. This path keeps the browser UI light while the downloader API/worker/notifier stack resolves the stream, downloads segments through its own internal proxy/fetch layer, and persists state in SQLite under `downloads/downloader.sqlite`. It uses the same human-readable naming scheme as the browser downloader when title metadata is available. Downloads are written to a staging path first, then promoted into the final output path only after validation. For transport-stream HLS sources, the backend attempts an MP4 remux with local `ffmpeg`; if remux is unsafe or fails, the original TS artifact is kept and the job is surfaced as completed with warnings instead of pretending the MP4 is clean. The service exposes a responsive API on `http://localhost:5050`, keeps running even if the frontend tab is closed, and offers a `Fetch completed file` action once a job reaches a final state.

## 💡 Future Improvements

* Custom video player UI
* Subtitles support
* TV / remote-friendly controls
* Better error handling

---

## ⭐ Support

If you like this project, consider giving it a star ⭐ on GitHub!
