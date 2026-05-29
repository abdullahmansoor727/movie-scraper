import { startNotifierLoop } from '../notifier/dispatcher.ts';
import { createLogger } from '../infra/logging/logger.ts';

const log = createLogger('main.notifier');
log.info('starting notifier loop');
startNotifierLoop();
