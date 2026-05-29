import { startOptimizerLoop } from '../optimizer/optimizer.ts';
import { createLogger } from '../infra/logging/logger.ts';

createLogger('main.optimizer').info('starting optimizer loop');
startOptimizerLoop();
