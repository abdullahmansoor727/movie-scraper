import { startApiServer } from '../api/server.ts';
import { startWorkerLoop } from '../worker/worker.ts';
import { startNotifierLoop } from '../notifier/dispatcher.ts';
import { startOptimizerLoop } from '../optimizer/optimizer.ts';
import { createLogger } from '../infra/logging/logger.ts';
import { config } from '../infra/config/index.ts';
import { migrateExistingLibraryLayout } from './migrate-jellyfin-layout.ts';
import fs from 'node:fs';

const log = createLogger('main.stack');

fs.mkdirSync(config.stagingDir, { recursive: true });
fs.mkdirSync(config.finalDir, { recursive: true });
fs.mkdirSync(config.plexWatchDir, { recursive: true });

async function main(): Promise<void> {
  await migrateExistingLibraryLayout();

  startApiServer();
  startWorkerLoop();
  startNotifierLoop();
  startOptimizerLoop();

  log.info('stable downloader stack started', {
    apiBaseUrl: config.apiBaseUrl,
    sqlitePath: config.sqlitePath,
    stagingDir: config.stagingDir,
    plexWatchDir: config.plexWatchDir,
  });
}

main().catch((err) => {
  log.error('failed to start downloader stack', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
