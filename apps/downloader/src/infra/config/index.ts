import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const config = {
  appRoot,
  apiHost: stringEnv("DOWNLOAD_API_HOST", "127.0.0.1"),
  apiPort: numberEnv("DOWNLOAD_API_PORT", 5050),
  apiBaseUrl: stringEnv("DOWNLOAD_API_BASE_URL", `http://127.0.0.1:5050`),
  maxActiveDownloads: numberEnv("DOWNLOAD_MAX_ACTIVE_JOBS", 4),
  workerPollIntervalMs: numberEnv("DOWNLOAD_WORKER_POLL_MS", 1000),
  notifierPollIntervalMs: numberEnv("DOWNLOAD_NOTIFIER_POLL_MS", 1500),
  workerLeaseMs: numberEnv("DOWNLOAD_WORKER_LEASE_MS", 20000),
  stallAfterMs: numberEnv("DOWNLOAD_STALL_AFTER_MS", 90000),
  baseConcurrency: numberEnv("DOWNLOAD_BASE_CONCURRENCY", 2),
  maxConcurrency: numberEnv("DOWNLOAD_MAX_CONCURRENCY", 16),
  globalMaxConcurrency: numberEnv("DOWNLOAD_GLOBAL_MAX_CONCURRENCY", 24),
  maxRetryCount: numberEnv("DOWNLOAD_MAX_RETRY_COUNT", 12),
  skipAfterRetries: numberEnv("DOWNLOAD_SKIP_AFTER_RETRIES", 6),
  progressEventEverySegments: numberEnv("DOWNLOAD_PROGRESS_EVENT_EVERY", 25),
  minFreeSpaceBytes:
    numberEnv("DOWNLOAD_MIN_FREE_SPACE_GB", 10) * 1024 * 1024 * 1024,
  deleteTsAfterCleanMp4: booleanEnv("DOWNLOAD_DELETE_TS_AFTER_CLEAN_MP4", true),
  deleteTsAfterCleanMkv: booleanEnv("DOWNLOAD_DELETE_TS_AFTER_CLEAN_MKV", true),
  optimizerPollIntervalMs: numberEnv("OPTIMIZER_POLL_MS", 5000),
  optimizerEnabled: booleanEnv("OPTIMIZER_ENABLED", true),
  optimizerAutoQueue: booleanEnv("OPTIMIZER_AUTO_QUEUE", true),
  optimizerCodec: stringEnv("OPTIMIZER_CODEC", "libx265"),
  optimizerCrf: numberEnv("OPTIMIZER_CRF", 24), // Optimized for 1080p storage
  optimizerPreset: stringEnv("OPTIMIZER_PRESET", "slow"),
  optimizerAudioMode: stringEnv("OPTIMIZER_AUDIO_MODE", "aac"), // More compatible than 'copy'
  optimizerAudioBitrate: stringEnv("OPTIMIZER_AUDIO_BITRATE", "128k"), // Standard for 2.0 audio
  optimizerMaxHeight: numberEnv("OPTIMIZER_MAX_HEIGHT", 0),

  optimizerDeleteSourceAfterSuccess: booleanEnv(
    "OPTIMIZER_DELETE_SOURCE_AFTER_SUCCESS",
    false,
  ),
  sqlitePath: stringEnv(
    "DOWNLOAD_SQLITE_PATH",
    path.join(appRoot, "downloads", "downloader.sqlite"),
  ),
  stagingDir: stringEnv(
    "DOWNLOAD_STAGING_DIR",
    path.join(appRoot, "downloads", ".staging"),
  ),
  finalDir: stringEnv("DOWNLOAD_FINAL_DIR", path.join(appRoot, "downloads")),
  plexWatchDir: stringEnv("PLEX_WATCH_DIR", path.join(appRoot, "downloads")),
  ffmpegPath: stringEnv("FFMPEG_PATH", "ffmpeg"),
  ffprobePath: stringEnv("FFPROBE_PATH", "ffprobe"),
  overseerrWebhookUrl: stringEnv("OVERSEERR_WEBHOOK_URL", ""),
  plexWebhookUrl: stringEnv("PLEX_WEBHOOK_URL", ""),
  plexUrl: stringEnv("PLEX_URL", ""),
  plexToken: stringEnv("PLEX_TOKEN", ""),
  plexLibrarySectionId: stringEnv("PLEX_LIBRARY_SECTION_ID", ""),
  plexRefreshUrl: stringEnv("PLEX_REFRESH_URL", ""),
  referer: stringEnv("VIDLINK_REFERER", "https://vidlink.pro/"),
  origin: stringEnv("VIDLINK_ORIGIN", "https://vidlink.pro"),
  userAgent: stringEnv(
    "VIDLINK_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124",
  ),
  tmdbKey: stringEnv("TMDB_KEY", "3a73619bbb8fc6d47742d1b5b2b707b5"),
  softStrictMissBudgetPercent: numberEnv("DOWNLOAD_MISS_BUDGET_PERCENT", 1),
};
