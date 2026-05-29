import fsp from "node:fs/promises";
import path from "node:path";
import { libraryRelativeMediaPath } from "../domain/files/naming.ts";
import { database } from "../infra/db/database.ts";
import { config } from "../infra/config/index.ts";
import { createLogger } from "../infra/logging/logger.ts";
import type { JobRecord } from "../shared/types.ts";

const log = createLogger("main.migrate-layout");

function targetPathForJob(job: JobRecord, currentPath: string): string {
  const extension = path.extname(currentPath) || ".mp4";
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function moveIfNeeded(currentPath: string, targetPath: string): Promise<boolean> {
  if (!currentPath || currentPath === targetPath) return false;
  if (!(await pathExists(currentPath))) return false;
  if (await pathExists(targetPath)) return false;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.rename(currentPath, targetPath);
  return true;
}

function isStableJob(job: JobRecord): boolean {
  return (
    job.status === "completed" ||
    job.status === "completed_with_warnings" ||
    job.status === "failed_terminal"
  );
}

export async function migrateExistingLibraryLayout(): Promise<void> {
  const jobs = database.listAllJobs(false).filter(isStableJob);
  let movedFiles = 0;
  let updatedJobs = 0;

  for (const job of jobs) {
    let dirty = false;
    const next = { ...job };

    if (job.finalFilePath) {
      const targetFinalPath = targetPathForJob(job, job.finalFilePath);
      if (await moveIfNeeded(job.finalFilePath, targetFinalPath)) {
        next.finalFilePath = targetFinalPath;
        next.fileBasename = path.basename(targetFinalPath);
        dirty = true;
        movedFiles += 1;
      }
    }

    if (job.sourceFilePath) {
      const targetSourcePath = targetPathForJob(job, job.sourceFilePath);
      if (await moveIfNeeded(job.sourceFilePath, targetSourcePath)) {
        next.sourceFilePath = targetSourcePath;
        dirty = true;
        movedFiles += 1;
      }
    }

    if (!dirty) continue;

    database.insertOrReplaceJob(next);
    const optimizerInputPath = next.finalFilePath || next.sourceFilePath;
    if (optimizerInputPath) {
      database.updateOptimizationPaths(
        next.id,
        optimizerInputPath,
        optimizerInputPath.replace(/\.[^.]+$/i, ".optimized.mkv"),
      );
    }
    updatedJobs += 1;
  }

  log.info("jellyfin layout migration finished", {
    scannedJobs: jobs.length,
    updatedJobs,
    movedFiles,
  });
}
