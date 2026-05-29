import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';

export type DiskSpace = {
  path: string;
  availableBytes: number;
  totalBytes: number;
};

export async function getDiskSpace(targetPath = config.plexWatchDir): Promise<DiskSpace> {
  await fsp.mkdir(targetPath, { recursive: true }).catch(() => {});
  const stats = await fsp.statfs(targetPath);
  return {
    path: targetPath,
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

export async function fileSize(filePath: string): Promise<number> {
  const stats = await fsp.stat(filePath);
  return stats.size;
}

export async function assertEnoughFreeSpace(extraBytes = 0, targetPath = config.plexWatchDir): Promise<void> {
  const disk = await getDiskSpace(path.dirname(targetPath) === '.' ? config.plexWatchDir : targetPath);
  const required = config.minFreeSpaceBytes + extraBytes;
  if (disk.availableBytes < required) {
    const availableGb = (disk.availableBytes / 1024 / 1024 / 1024).toFixed(1);
    const requiredGb = (required / 1024 / 1024 / 1024).toFixed(1);
    throw new Error(`Insufficient disk space: ${availableGb}GB available, ${requiredGb}GB required`);
  }
}

export function isDiskSpaceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /ENOSPC|no space left on device|Insufficient disk space/i.test(message);
}
