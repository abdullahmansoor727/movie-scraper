import { config } from '../../infra/config/index.ts';
import { createLogger } from '../../infra/logging/logger.ts';
import { fetchJson } from '../../infra/http/fetch.ts';

const log = createLogger('notifier.overseerr');

export async function sendOverseerrUpdate(eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (!config.overseerrWebhookUrl) return;
  await fetchJson(config.overseerrWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'stable-downloader',
      eventType,
      payload,
    }),
  });
  log.info('overseerr notification sent', { eventType });
}
