import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../infra/config/index.ts";
import { database } from "../infra/db/database.ts";
import { createLogger } from "../infra/logging/logger.ts";
import { assertEnoughFreeSpace, fileSize } from "../infra/files/disk.ts";

const log = createLogger("optimizer");

async function runTool(
  tool: string,
  args: string[],
  onStdoutLine?: (line: string) => void,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (onStdoutLine) {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) onStdoutLine(trimmed);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code || 0 }));
  });
}

async function inputDurationMs(inputPath: string): Promise<number> {
  const probe = await runTool(config.ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ]);
  if (probe.code !== 0) return 0;
  const seconds = Number((probe.stdout || "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000);
}

function profileArgs(profile: Record<string, unknown>): string[] {
  const codec = String(profile.codec || config.optimizerCodec);
  const crf = String(profile.crf || config.optimizerCrf);
  const preset = String(profile.preset || config.optimizerPreset);
  const audioMode = String(profile.audioMode || config.optimizerAudioMode);
  const audioBitrate = String(
    profile.audioBitrate || config.optimizerAudioBitrate,
  );

  const args = [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map",
    "-0:d?",
    "-c:v",
    codec,
    "-crf",
    crf,
    "-preset",
    preset,
    "-pix_fmt",
    "yuv420p", // <--- ADD THIS for hardware compatibility
  ];

  if (audioMode === "aac") {
    args.push("-c:a", "aac", "-b:a", audioBitrate, "-ac", "2"); // Added -ac 2 for standard stereo
  } else {
    args.push("-c:a", "copy");
  }

  return args;
}

async function validateOptimized(filePath: string): Promise<void> {
  const probe = await runTool(config.ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "json",
    filePath,
  ]);
  if (probe.code !== 0)
    throw new Error(probe.stderr.trim() || "ffprobe failed");
  const parsed = JSON.parse(probe.stdout || "{}") as {
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  if (!streams.some((stream) => stream.codec_type === "video"))
    throw new Error("optimized file has no video stream");
}

async function runOptimization(record: Record<string, unknown>): Promise<void> {
  const id = String(record.id);
  const jobId = String(record.job_id);
  const job = database.getJob(jobId);
  if (!job) {
    database.updateOptimizationJob(id, {
      status: "failed",
      status_reason: "Source job no longer exists",
    });
    return;
  }
  const inputPath = String(
    record.input_path || job.finalFilePath || job.sourceFilePath,
  );
  const outputPath = String(
    record.output_path || inputPath.replace(/\.[^.]+$/i, ".optimized.mkv"),
  );
  const tempPath = outputPath.replace(/\.mkv$/i, ".part.mkv");
  const sourceSize = await fileSize(inputPath);
  const totalDurationMs = await inputDurationMs(inputPath);
  await assertEnoughFreeSpace(sourceSize, config.plexWatchDir);
  await fsp.unlink(tempPath).catch(() => {});
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const profile = JSON.parse(String(record.profile_json || "{}")) as Record<
    string,
    unknown
  >;
  const args = [
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-i",
    inputPath,
    ...profileArgs(profile),
    "-f",
    "matroska",
    tempPath,
  ];
  log.info("optimization started", { id, jobId, inputPath, outputPath });
  const progressState: Record<string, string> = {};
  let lastProgressUpdate = 0;
  let lastPartBytes = 0;
  let lastPartTs = 0;
  const result = await runTool(config.ffmpegPath, args, (line) => {
    const [k, v] = line.split("=");
    if (!k || v == null) return;
    progressState[k.trim()] = v.trim();
    if (k.trim() !== "progress") return;
    const nowTs = Date.now();
    if (nowTs - lastProgressUpdate < 1000) return;
    lastProgressUpdate = nowTs;
    const outTimeMs = Number(progressState.out_time_ms || "0");
    const fps = Number(progressState.fps || "0");
    const speedRaw = String(progressState.speed || "0x").replace("x", "");
    const speed = Number(speedRaw);
    const rawPercent =
      totalDurationMs > 0
        ? Math.max(0, Math.min(100, (outTimeMs / totalDurationMs) * 100))
        : 0;
    const percent = Math.min(rawPercent, 99.5);
    const etaSeconds =
      totalDurationMs > 0 && speed > 0
        ? Math.max(0, Math.round((totalDurationMs - outTimeMs) / 1000 / speed))
        : 0;
    let partBytes = 0;
    let partBps = 0;
    void fsp
      .stat(tempPath)
      .then((st) => {
        partBytes = st.size;
        if (lastPartTs > 0 && nowTs > lastPartTs) {
          const dt = (nowTs - lastPartTs) / 1000;
          partBps = dt > 0 ? Math.max(0, (partBytes - lastPartBytes) / dt) : 0;
        }
        lastPartBytes = partBytes;
        lastPartTs = nowTs;
        const confidence =
          percent >= 98 || etaSeconds <= 20
            ? "low"
            : speed > 0 && partBps > 0
              ? "high"
              : "medium";
        database.updateOptimizationJob(id, {
          progress_percent: Number(percent.toFixed(2)),
          progress_fps: Number.isFinite(fps) ? fps : 0,
          progress_speed: Number.isFinite(speed) ? speed : 0,
          eta_seconds: etaSeconds,
          progress_part_bytes: partBytes,
          progress_part_bps: Number(partBps.toFixed(2)),
          progress_confidence: confidence,
          status_reason:
            percent > 0
              ? `Optimizing media (${percent.toFixed(1)}%, eta ${etaSeconds}s)`
              : "Optimizing media",
        });
      })
      .catch(() => {
        database.updateOptimizationJob(id, {
          progress_percent: Number(percent.toFixed(2)),
          progress_fps: Number.isFinite(fps) ? fps : 0,
          progress_speed: Number.isFinite(speed) ? speed : 0,
          eta_seconds: etaSeconds,
          progress_part_bytes: 0,
          progress_part_bps: 0,
          progress_confidence: "low",
          status_reason:
            percent > 0
              ? `Optimizing media (${percent.toFixed(1)}%, eta ${etaSeconds}s)`
              : "Optimizing media",
        });
      });
  });
  if (result.code !== 0) {
    await fsp.unlink(tempPath).catch(() => {});
    throw new Error(
      result.stderr.trim().split("\n").slice(-2).join(" ") ||
        "ffmpeg optimizer failed",
    );
  }

  await validateOptimized(tempPath);
  await fsp.rename(tempPath, outputPath);
  const outputSize = await fileSize(outputPath);
  const previousFinal = job.finalFilePath;
  job.sourceFilePath = previousFinal;
  job.finalFilePath = outputPath;
  job.fileBasename = path.basename(outputPath);
  job.finalFileKind = "mkv";
  job.finalArtifactClass = job.warningCount > 0 ? "warning" : "clean";
  database.insertOrReplaceJob(job);

  if (
    config.optimizerDeleteSourceAfterSuccess &&
    previousFinal &&
    previousFinal !== outputPath
  ) {
    await fsp.unlink(previousFinal).catch(() => {});
    job.sourceFilePath = "";
    database.insertOrReplaceJob(job);
  }

  database.updateOptimizationJob(id, {
    status: "completed",
    status_reason: `Optimized ${Math.round((1 - outputSize / sourceSize) * 100)}% smaller`,
    source_size: sourceSize,
    output_size: outputSize,
    progress_percent: 100,
    eta_seconds: 0,
    progress_part_bytes: outputSize,
    progress_part_bps: 0,
    progress_confidence: "high",
  });
  log.info("optimization completed", { id, jobId, sourceSize, outputSize });
}

export function startOptimizerLoop(): void {
  if (!config.optimizerEnabled) {
    log.info("optimizer disabled");
    return;
  }
  const tick = async () => {
    try {
      const record = database.acquireOptimizationJob();
      if (record) {
        try {
          await runOptimization(record);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          database.updateOptimizationJob(String(record.id), {
            status: "failed",
            status_reason: message,
          });
          log.error("optimization failed", {
            id: String(record.id),
            message,
            stack: err instanceof Error ? err.stack || "" : "",
          });
        }
      }
    } catch (err) {
      log.error("optimizer tick failed", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack || "" : "",
      });
    } finally {
      setTimeout(tick, config.optimizerPollIntervalMs);
    }
  };
  void tick();
}
