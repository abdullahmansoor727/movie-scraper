import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { config } from "../../infra/config/index.ts";
import { createLogger } from "../../infra/logging/logger.ts";
import { database } from "../../infra/db/database.ts";
import { resolveVariants } from "../../integrations/vidlink/client.ts";
import { parseMediaPlaylist } from "../../domain/media/hls.ts";
import {
  downloadFilename,
  libraryRelativeMediaPath,
} from "../../domain/files/naming.ts";
import {
  fetchBuffer,
  fetchText,
  wait,
} from "../../infra/http/fetch.ts";
import {
  assertEnoughFreeSpace,
  fileSize,
  isDiskSpaceError,
} from "../../infra/files/disk.ts";
import type {
  JobRecord,
  ResolveVariantsResult,
  VariantOption,
} from "../../shared/types.ts";

const log = createLogger("worker.executor");

type SegmentResult = {
  index: number;
  skipped: boolean;
  failures: number;
  error?: unknown;
};

function maxConcurrencyForActiveJobs(activeJobs: number): number {
  const active = Math.max(1, activeJobs);
  const globalShare = Math.max(
    1,
    Math.floor(config.globalMaxConcurrency / active),
  );
  let fairnessCap = 4;
  if (active <= 1) fairnessCap = 16;
  else if (active === 2) fairnessCap = 8;
  else if (active <= 4) fairnessCap = 6;
  return Math.max(1, Math.min(config.maxConcurrency, globalShare, fairnessCap));
}

function shouldRetry(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  return /HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504|timed out|aborted|socket hang up|econnreset|epipe|network/i.test(
    message,
  );
}

function retryDelay(attempt: number, err: unknown): number {
  const message = err instanceof Error ? err.message : String(err || "");
  const base = Math.min(30000, 1500 * Math.pow(2, attempt));
  return /429/.test(message) ? Math.max(base, 8000) : base;
}

function missBudget(totalSegments: number): number {
  return Math.max(
    1,
    Math.floor((totalSegments * config.softStrictMissBudgetPercent) / 100),
  );
}

function canSkipSegment(job: JobRecord, skipped: Set<number>): boolean {
  return skipped.size + 1 <= missBudget(job.totalSegments);
}

function segmentCacheDir(job: JobRecord): string {
  return path.join(config.stagingDir, `${job.id}.segments`);
}

function mediaTargetPath(job: JobRecord, extension: string): string {
  return path.join(
    config.plexWatchDir,
    libraryRelativeMediaPath(
      job.tmdbId,
      job.season,
      job.episode,
      job.label,
      extension,
      job.title,
      job.year,
      job.episodeTitle,
    ),
  );
}

function segmentCachePath(job: JobRecord, index: number): string {
  return path.join(
    segmentCacheDir(job),
    `${String(index + 1).padStart(8, "0")}.tsseg`,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function writeSegmentCache(
  job: JobRecord,
  index: number,
  buffer: Buffer,
): Promise<void> {
  const target = segmentCachePath(job, index);
  const temp = `${target}.part`;
  try {
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.unlink(temp).catch(() => {});
    throw err;
  }
}

function parseWarnings(job: JobRecord): string[] {
  try {
    const value = JSON.parse(job.warningsJson || "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch (_) {
    return [];
  }
}

function unwrapProxyUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get("url") || rawUrl;
  } catch {
    return rawUrl;
  }
}

function pushWarning(job: JobRecord, warning: string): JobRecord {
  const warnings = parseWarnings(job);
  warnings.push(warning);
  job.warningCount = warnings.length;
  job.warningsJson = JSON.stringify(warnings);
  return job;
}

function probeHasPlayableVideo(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string }>;
    };
    const streams = Array.isArray(value.streams) ? value.streams : [];
    return streams.some((stream) => {
      const codecType = String(stream.codec_type || "");
      const codecName = String(stream.codec_name || "");
      return (
        codecType === "video" && !/png|mjpeg|jpeg|webp|gif/i.test(codecName)
      );
    });
  } catch (_) {
    return false;
  }
}

async function runTool(
  tool: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code || 0 }));
  });
}

async function stripPngHeader(filePath: string): Promise<void> {
  try {
    const buf = await fsp.readFile(filePath);
    if (buf.length < 2048) return;
    const pngSig = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!buf.subarray(0, 8).equals(pngSig)) return;
    const iendIdx = buf.indexOf("IEND");
    if (iendIdx === -1) return;
    const streamStart = iendIdx + 12;
    if (streamStart + 188 >= buf.length) return;
    const candidate = buf.subarray(streamStart);
    // Verify MPEG-TS packet sync byte cadence before destructive rewrite.
    let syncCount = 0;
    for (
      let offset = 0;
      offset < Math.min(188 * 8, candidate.length - 1);
      offset += 188
    ) {
      if (candidate[offset] === 0x47) syncCount += 1;
    }
    if (syncCount < 3) return;
    const temp = filePath + ".png-stripped.tmp";
    await fsp.writeFile(temp, candidate);
    await fsp.rename(temp, filePath);
    log.info("stripped PNG header from corrupted TS file", {
      filePath,
      removedBytes: streamStart,
    });
  } catch (err) {
    log.warn("failed to strip PNG header", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function optimizeProfileArgs(): string[] {
  const args = [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map",
    "-0:d?",
    "-c:v",
    config.optimizerCodec,
    "-crf",
    String(config.optimizerCrf),
    "-preset",
    config.optimizerPreset,
    "-pix_fmt",
    "yuv420p",
  ];
  if (config.optimizerMaxHeight > 0) {
    args.push("-vf", `scale=-2:'min(${config.optimizerMaxHeight},ih)'`);
  }
  if (config.optimizerAudioMode === "aac") {
    args.push("-c:a", "aac", "-b:a", config.optimizerAudioBitrate, "-ac", "2");
  } else {
    args.push("-c:a", "copy");
  }
  return args;
}

async function tryOptimizeToMkv(job: JobRecord): Promise<JobRecord> {
  if (!job.finalFilePath || !/\.ts$/i.test(job.finalFilePath)) return job;
  await stripPngHeader(job.finalFilePath);
  const sourceSize = await fileSize(job.finalFilePath);
  try {
    const reserve = Math.max(
      Math.ceil(sourceSize * 1.1),
      sourceSize + 2 * 1024 * 1024 * 1024,
    );
    await assertEnoughFreeSpace(reserve, config.plexWatchDir);
  } catch (err) {
    pushWarning(
      job,
      err instanceof Error
        ? `mkv optimize skipped; kept TS (${err.message})`
        : "mkv optimize skipped; kept TS",
    );
    return job;
  }
  const finalMkv = job.finalFilePath.replace(/\.ts$/i, ".mkv");
  const tempMkv = `${finalMkv}.part.mkv`;
  await fsp.unlink(tempMkv).catch(() => {});
  const optimize = await runTool(config.ffmpegPath, [
    "-y",
    "-fflags",
    "+genpts+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-i",
    job.finalFilePath,
    ...optimizeProfileArgs(),
    "-f",
    "matroska",
    tempMkv,
  ]);
  if (optimize.code !== 0) {
    pushWarning(
      job,
      `mkv optimize failed; kept TS (${optimize.stderr.trim().split("\n").slice(-1)[0] || "ffmpeg error"})`,
    );
    return job;
  }
  const probe = await runTool(config.ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "json",
    tempMkv,
  ]);
  if (probe.code !== 0 || !probeHasPlayableVideo(probe.stdout)) {
    await fsp.unlink(tempMkv).catch(() => {});
    pushWarning(job, "mkv optimize produced invalid artifact; kept TS");
    return job;
  }
  await fsp.rename(tempMkv, finalMkv);
  job.sourceFilePath = job.finalFilePath;
  job.finalFilePath = finalMkv;
  job.fileBasename = path.basename(finalMkv);
  job.finalFileKind = "mkv";
  if (config.deleteTsAfterCleanMkv && parseWarnings(job).length === 0) {
    await fsp.unlink(job.sourceFilePath).catch(() => {});
    job.sourceFilePath = "";
  }
  return job;
}

async function promoteFile(job: JobRecord): Promise<JobRecord> {
  const finalTarget = mediaTargetPath(job, path.extname(job.fileBasename || job.stagingPath || ".ts"));
  await fsp.mkdir(path.dirname(finalTarget), { recursive: true });
  await fsp.rename(job.stagingPath, finalTarget);
  job.finalFilePath = finalTarget;
  job.fileBasename = path.basename(finalTarget);
  job.finalFileKind = finalTarget.endsWith(".mp4") ? "mp4" : "ts";
  return job;
}

function applyResolvedVariant(
  job: JobRecord,
  resolved: ResolveVariantsResult,
  variant: VariantOption,
): JobRecord {
  job.playlistUrl = variant.url;
  job.label = variant.label;
  job.sourceType = "hls";
  job.directUrl = "";
  job.expiresAt = 0;
  job.subtitlesJson = JSON.stringify(resolved.subtitles || []);
  return job;
}

function pickResolvedVariant(
  job: JobRecord,
  resolved: ResolveVariantsResult,
): VariantOption | null {
  return (
    resolved.variants.find((variant) => variant.label === job.label) ||
    resolved.variants[0] ||
    null
  );
}

async function refreshJobSource(job: JobRecord): Promise<JobRecord> {
  const refreshed = await resolveVariants(job.tmdbId, job.season, job.episode);
  const matchingVariant = pickResolvedVariant(job, refreshed);
  if (!matchingVariant) throw new Error("No playable variants resolved");
  return applyResolvedVariant(job, refreshed, matchingVariant);
}

async function finalizeCompletedArtifact(
  job: JobRecord,
  bytesWritten: number,
  completedSegments: number,
): Promise<void> {
  job = database.updateJobStatus(job.id, "validating", "Validating artifact", {
    ...job,
    bytesWritten,
    completedSegments,
    currentSegment: completedSegments,
  });

  try {
    await promoteFile(job);
    job = database.updateJobStatus(
      job.id,
      "promoting",
      "Promoting artifact into Plex watch path",
      job,
      "job.promoted",
    );
    job = await tryOptimizeToMkv(job);
    await fsp
      .rm(segmentCacheDir(job), { recursive: true, force: true })
      .catch(() => {});
    const warnings = parseWarnings(job);
    const finalStatus =
      warnings.length > 0 ? "completed_with_warnings" : "completed";
    job.finalArtifactClass = warnings.length > 0 ? "warning" : "clean";
    const completedJob = database.updateJobStatus(
      job.id,
      finalStatus,
      warnings.length > 0 ? warnings[warnings.length - 1] : "Saved to disk",
      job,
      finalStatus === "completed"
        ? "job.completed"
        : "job.completed_with_warnings",
    );
    if (
      config.optimizerEnabled &&
      config.optimizerAutoQueue &&
      completedJob.finalFilePath
    ) {
      database.createOptimizationJob(completedJob, {
        codec: config.optimizerCodec,
        crf: config.optimizerCrf,
        preset: config.optimizerPreset,
        audioMode: config.optimizerAudioMode,
        audioBitrate: config.optimizerAudioBitrate,
        auto: true,
      });
    }
    log.info("job completed", {
      jobId: job.id,
      status: finalStatus,
      filePath: job.finalFilePath,
      warnings: warnings.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    database.updateJobStatus(
      job.id,
      "failed_terminal",
      `Validation/promotion failed: ${message}`,
      job,
      "job.failed_terminal",
    );
  }
}

export async function executeDownload(
  workerId: string,
  originalJob: JobRecord,
): Promise<void> {
  const persistedJob = database.getJob(originalJob.id);
  if (!persistedJob) return;
  let job: JobRecord = persistedJob;
  try {
    await assertEnoughFreeSpace(0, config.plexWatchDir);
  } catch (err) {
    database.updateJobStatus(
      job.id,
      "stalled",
      err instanceof Error ? err.message : String(err),
      {
        ...job,
        stalledAt: Date.now(),
        nextRetryAt: Date.now() + 60000,
        lastProgressAt: Date.now(),
      },
      "job.stalled",
    );
    return;
  }
  const activeJobs = database.countActiveJobs();
  job.currentConcurrency = Math.min(
    Math.max(job.currentConcurrency || config.baseConcurrency, 1),
    maxConcurrencyForActiveJobs(activeJobs),
  );
  job.maxConcurrency = maxConcurrencyForActiveJobs(activeJobs);
  job = database.updateJobStatus(
    job.id,
    "resolving",
    "Resolving stream and playlist",
    job,
    "job.resumed",
  );
  database.recordLease(
    workerId,
    "worker",
    job.id,
    Date.now() + config.workerLeaseMs,
  );

  const refreshed = await resolveVariants(job.tmdbId, job.season, job.episode);
  const matchingVariant = pickResolvedVariant(job, refreshed);
  if (!matchingVariant) {
    database.updateJobStatus(
      job.id,
      "failed_terminal",
      "No playable variants resolved",
      job,
      "job.failed_terminal",
    );
    return;
  }
  job = applyResolvedVariant(job, refreshed, matchingVariant);

  const sourceUrl = unwrapProxyUrl(job.playlistUrl);
  const media = parseMediaPlaylist(await fetchText(job.playlistUrl), job.playlistUrl);

  if (!media.items.length) {
    database.updateJobStatus(
      job.id,
      "failed_terminal",
      "No media segments found",
      job,
      "job.failed_terminal",
    );
    return;
  }

  const checkpoint = database.getCheckpoint(job.id);
  job.totalSegments = media.items.length;
  job.completedSegments = checkpoint
    ? checkpoint.completedSegments
    : job.completedSegments;
  job.bytesWritten = checkpoint ? checkpoint.bytesWritten : job.bytesWritten;
  job.currentSegment = checkpoint
    ? checkpoint.currentSegment
    : job.currentSegment;
  job.totalBytesEstimate =
    job.completedSegments > 0
      ? Math.round(
          (job.bytesWritten / job.completedSegments) * job.totalSegments,
        )
      : job.totalBytesEstimate;
  const preferMp4Extension = media.hasMap;
  job.fileBasename =
    job.fileBasename ||
    downloadFilename(
      job.tmdbId,
      job.season,
      job.episode,
      job.label,
      preferMp4Extension,
      job.title,
      job.year,
      job.episodeTitle,
    );
  job.stagingPath =
    job.stagingPath ||
    path.join(config.stagingDir, `${job.id}.${job.fileBasename}.part`);
  job.finalFilePath =
    job.finalFilePath ||
    mediaTargetPath(job, preferMp4Extension ? ".mp4" : ".ts");
  await fsp.mkdir(path.dirname(job.stagingPath), { recursive: true });
  await fsp.mkdir(segmentCacheDir(job), { recursive: true });
  const fileHandle = await fsp.open(
    job.stagingPath,
    job.completedSegments > 0 ? "r+" : "w",
  );

  job = database.updateJobStatus(
    job.id,
    "running",
    `Downloading ${job.label}`,
    {
      ...job,
      startedAt: job.startedAt || Date.now(),
      lastProgressAt: Date.now(),
    },
    "job.started",
  );

  let nextIndex = job.completedSegments;
  let nextLaunchIndex = job.completedSegments;
  let bytesWritten = job.bytesWritten;
  const skipped = new Set<number>(
    JSON.parse(job.skippedSegmentsJson || "[]") as number[],
  );
  const cached = new Set<number>();
  const inFlight = new Map<number, Promise<SegmentResult>>();
  let healthySegmentsSinceRamp = 0;

  for (let index = nextIndex; index < media.items.length; index += 1) {
    if (await pathExists(segmentCachePath(job, index))) cached.add(index);
  }

  async function fetchSegmentWithRetry(index: number): Promise<SegmentResult> {
    let failures = 0;
    for (let attempt = 0; attempt < job.maxRetryCount; attempt += 1) {
      try {
        database.recordLease(
          workerId,
          "worker",
          job.id,
          Date.now() + config.workerLeaseMs,
        );
        const buffer = await fetchBuffer(media.items[index]);
        await writeSegmentCache(job, index, buffer);
        return { index, skipped: false, failures };
      } catch (err) {
        failures += 1;
        const message = err instanceof Error ? err.message : String(err);
        job.retryCount += 1;
        if (!shouldRetry(err)) {
          throw new Error(
            `Non-retryable error at segment ${index + 1}: ${message}`,
          );
        }

        const skipAt = Math.min(
          job.maxRetryCount,
          Math.max(1, config.skipAfterRetries),
        );
        if (attempt + 1 >= skipAt && canSkipSegment(job, skipped)) {
          skipped.add(index + 1);
          job.skippedSegmentsJson = JSON.stringify(
            Array.from(skipped.values()),
          );
          pushWarning(job, `Skipped poisoned segment ${index + 1}`);
          return { index, skipped: true, failures };
        }

        if (attempt + 1 >= job.maxRetryCount) {
          throw new Error(
            `Retry budget exceeded at segment ${index + 1}: ${message}`,
          );
        }

        job.backoffLevel = Math.min(6, job.backoffLevel + 1);
        const delay = retryDelay(attempt, err);
        job = database.updateJobStatus(
          job.id,
          "backing_off",
          `Segment ${index + 1} failed (${message}), retrying in ${Math.ceil(delay / 1000)}s`,
          {
            ...job,
            nextRetryAt: Date.now() + delay,
            currentConcurrency: Math.max(1, job.currentConcurrency - 1),
            lastProgressAt: Date.now(),
          },
          "job.backing_off",
        );
        await wait(delay);
        job = database.updateJobStatus(
          job.id,
          "running",
          `Resuming after retry delay`,
          {
            ...job,
            nextRetryAt: 0,
            lastProgressAt: Date.now(),
          },
          "job.resumed",
        );
      }
    }
    throw new Error(`Retry loop exhausted at segment ${index + 1}`);
  }

  function adjustConcurrency(batchSize: number, batchFailures: number): void {
    if (batchSize <= 0) return;
    if (batchFailures >= Math.ceil(batchSize / 2)) {
      const next = Math.max(1, job.currentConcurrency - 1);
      if (next !== job.currentConcurrency) {
        job.currentConcurrency = next;
        healthySegmentsSinceRamp = 0;
        log.warn("concurrency stepped down after failing batch", {
          jobId: job.id,
          concurrency: next,
          batchFailures,
          batchSize,
        });
      }
      return;
    }

    if (batchFailures === 0) {
      healthySegmentsSinceRamp += batchSize;
      if (
        healthySegmentsSinceRamp >=
        Math.max(config.progressEventEverySegments, job.currentConcurrency * 4)
      ) {
        const next = Math.min(job.maxConcurrency, job.currentConcurrency + 1);
        if (next !== job.currentConcurrency) {
          job.currentConcurrency = next;
          healthySegmentsSinceRamp = 0;
          log.info("concurrency stepped up after healthy batch", {
            jobId: job.id,
            concurrency: next,
          });
        }
      }
      return;
    }

    healthySegmentsSinceRamp = 0;
  }

  try {
    while (nextIndex < media.items.length) {
      const fresh = database.getJob(job.id);
      if (!fresh) throw new Error("job disappeared");
      await assertEnoughFreeSpace(0, config.plexWatchDir);
      if (fresh.status === "paused") {
        await fileHandle.close();
        return;
      }
      if (fresh.status === "failed_terminal") {
        throw new Error("job cancelled");
      }
      job.maxConcurrency = maxConcurrencyForActiveJobs(
        database.countActiveJobs(),
      );
      if (job.currentConcurrency > job.maxConcurrency) {
        job.currentConcurrency = job.maxConcurrency;
      }

      while (
        inFlight.size < job.currentConcurrency &&
        nextLaunchIndex < media.items.length
      ) {
        if (cached.has(nextLaunchIndex) || skipped.has(nextLaunchIndex + 1)) {
          nextLaunchIndex += 1;
          continue;
        }
        const launchIndex = nextLaunchIndex;
        inFlight.set(
          launchIndex,
          fetchSegmentWithRetry(launchIndex).catch((error) => ({
            index: launchIndex,
            skipped: false,
            failures: 1,
            error,
          })),
        );
        nextLaunchIndex += 1;
      }

      let assembledAny = false;
      while (
        nextIndex < media.items.length &&
        (cached.has(nextIndex) || skipped.has(nextIndex + 1))
      ) {
        if (!skipped.has(nextIndex + 1)) {
          const segmentPath = segmentCachePath(job, nextIndex);
          const buffer = await fsp.readFile(segmentPath);
          await fileHandle.write(buffer, 0, buffer.length, bytesWritten);
          bytesWritten += buffer.length;
          await fsp.unlink(segmentPath).catch(() => {});
        }
        nextIndex += 1;
        assembledAny = true;
      }

      if (!assembledAny) {
        if (!inFlight.size) {
          throw new Error(
            `No cached or in-flight segment can advance at ${nextIndex + 1}`,
          );
        }
        const result = await Promise.race(inFlight.values());
        inFlight.delete(result.index);
        if (result.error) throw result.error;
        if (result.skipped) {
          skipped.add(result.index + 1);
        } else {
          cached.add(result.index);
        }
        adjustConcurrency(1, result.failures > 0 ? 1 : 0);
        continue;
      }

      job.completedSegments = nextIndex;
      job.currentSegment = nextIndex;
      job.bytesWritten = bytesWritten;
      job.backoffLevel = 0;
      job.lastProgressAt = Date.now();
      job.totalBytesEstimate = Math.round(
        (bytesWritten / Math.max(1, nextIndex - skipped.size)) *
          media.items.length,
      );
      database.upsertCheckpoint(job.id, nextIndex, bytesWritten, nextIndex);
      const progressStatus =
        nextIndex >= media.items.length ? "validating" : "running";
      const progressReason =
        nextIndex >= media.items.length
          ? "Download finished, validating artifact"
          : `Downloading ${nextIndex} / ${media.items.length}`;
      job = database.updateJobStatus(
        job.id,
        progressStatus,
        progressReason,
        job,
        nextIndex % config.progressEventEverySegments === 0
          ? "job.progress"
          : undefined,
      );
      if (
        nextIndex % config.progressEventEverySegments === 0 ||
        nextIndex >= media.items.length
      ) {
        const elapsedSeconds =
          job.startedAt && job.lastProgressAt > job.startedAt
            ? (job.lastProgressAt - job.startedAt) / 1000
            : 0;
        const bytesPerSecond =
          elapsedSeconds > 0 ? job.bytesWritten / elapsedSeconds : 0;
        const segmentsPerSecond =
          elapsedSeconds > 0 ? job.completedSegments / elapsedSeconds : 0;
        log.info("download progress", {
          jobId: job.id,
          completedSegments: job.completedSegments,
          totalSegments: job.totalSegments,
          concurrency: job.currentConcurrency,
          bytesPerSecond: Math.round(bytesPerSecond),
          segmentsPerSecond: Number(segmentsPerSecond.toFixed(3)),
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    database.updateJobStatus(
      job.id,
      "stalled",
      message,
      {
        ...job,
        nextRetryAt: Date.now() + (isDiskSpaceError(err) ? 60000 : 5000),
        stalledAt: Date.now(),
        lastProgressAt: Date.now(),
      },
      "job.stalled",
    );
    await fileHandle.close().catch(() => {});
    return;
  }

  await fileHandle.truncate(bytesWritten);
  await fileHandle.close();

  await finalizeCompletedArtifact(job, bytesWritten, nextIndex);
}
