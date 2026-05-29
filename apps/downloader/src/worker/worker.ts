import { database } from '../infra/db/database.ts';
import { config } from '../infra/config/index.ts';
import { createLogger } from '../infra/logging/logger.ts';
import { executeDownload } from './executor/download-job.ts';
import { getDiskSpace } from '../infra/files/disk.ts';

const log = createLogger('worker.loop');

export function startWorkerLoop(): void {
  const workerId = `worker-${process.pid}`;
  const active = new Set<string>();

  const tick = async () => {
    try {
      database.recordLease(workerId, 'worker', '', Date.now() + config.workerLeaseMs);
      const recovered = database.reconcileExpiredRunningJobs(config.stallAfterMs);
      if (recovered.length) {
        log.warn('recovered stalled jobs', { count: recovered.length });
      }
      const runningCount = database.countActiveJobs();
      const freeSlots = Math.max(0, config.maxActiveDownloads - runningCount);
      if (freeSlots > 0) {
        const disk = await getDiskSpace(config.plexWatchDir);
        if (disk.availableBytes < config.minFreeSpaceBytes) {
          log.warn('download queue held for low disk space', {
            availableGb: Number((disk.availableBytes / 1024 / 1024 / 1024).toFixed(1)),
            requiredGb: Number((config.minFreeSpaceBytes / 1024 / 1024 / 1024).toFixed(1)),
          });
          return;
        }
        const candidates = database.acquireRunnableJobs(freeSlots);
        for (const job of candidates) {
          if (active.has(job.id)) continue;
          active.add(job.id);
          void executeDownload(workerId, job)
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              log.error('download execution crashed', { jobId: job.id, message });
              database.updateJobStatus(job.id, 'stalled', message, {
                ...job,
                stalledAt: Date.now(),
                nextRetryAt: Date.now() + 5000,
              }, 'job.stalled');
            })
            .finally(() => {
              active.delete(job.id);
              database.releaseLease(workerId);
            });
        }
      }
    } catch (err) {
      log.error('worker tick failed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTimeout(tick, config.workerPollIntervalMs);
    }
  };

  void tick();
}
