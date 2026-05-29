import { startWorkerLoop } from '../worker/worker.ts';
import { createLogger } from '../infra/logging/logger.ts';

const log = createLogger('main.worker');
log.info('starting worker loop');
startWorkerLoop();
