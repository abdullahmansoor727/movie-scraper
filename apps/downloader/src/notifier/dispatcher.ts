import { database } from '../infra/db/database.ts';
import { createLogger } from '../infra/logging/logger.ts';
import { wait } from '../infra/http/fetch.ts';
import { config } from '../infra/config/index.ts';
import { sendOverseerrUpdate } from '../integrations/overseerr/client.ts';
import { sendPlexUpdate } from '../integrations/plex/client.ts';

const log = createLogger('notifier.dispatcher');

export function startNotifierLoop(): void {
  const workerId = `notifier-${process.pid}`;
  const tick = async () => {
    try {
      database.recordLease(workerId, 'notifier', '', Date.now() + config.workerLeaseMs);
      const backfilled = database.enqueueMissingPlexCompletionNotifications();
      if (backfilled) {
        log.info('queued missing plex completion notifications', { count: backfilled });
      }
      const rows = database.getPendingNotifications(25);
      for (const row of rows) {
        const id = Number(row.id);
        const target = String(row.target);
        const attempts = Number(row.attempts || 0) + 1;
        try {
          const payload = JSON.parse(String(row.event_payload_json || '{}'));
          const eventType = String(row.event_type || '');
          if (target === 'overseerr') {
            await sendOverseerrUpdate(eventType, payload);
          } else if (target === 'plex') {
            await sendPlexUpdate(eventType, payload);
          }
          database.markNotificationSent(id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempts >= 10) {
            database.markNotificationFailed(id, attempts, message);
            log.error('notification permanently failed', { id, target, attempts, message });
          } else {
            database.markNotificationRetry(id, attempts, message, Math.min(60000, 1500 * Math.pow(2, attempts - 1)));
            log.warn('notification retry scheduled', { id, target, attempts, message });
          }
        }
      }
    } catch (err) {
      log.error('notifier tick failed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTimeout(tick, config.notifierPollIntervalMs);
    }
  };
  void tick();
}
