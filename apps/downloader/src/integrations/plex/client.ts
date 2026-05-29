import { config } from '../../infra/config/index.ts';
import { createLogger } from '../../infra/logging/logger.ts';
import { fetchJson } from '../../infra/http/fetch.ts';

const log = createLogger('notifier.plex');

function buildPlexRefreshUrl(filePath: string): string {
  if (config.plexRefreshUrl) {
    return config.plexRefreshUrl
      .replace('{path}', encodeURIComponent(filePath))
      .replace('{token}', encodeURIComponent(config.plexToken));
  }

  if (!config.plexUrl || !config.plexToken || !config.plexLibrarySectionId) return '';
  const url = new URL(`/library/sections/${encodeURIComponent(config.plexLibrarySectionId)}/refresh`, config.plexUrl);
  url.searchParams.set('path', filePath);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  return url.href;
}

async function triggerPlexRefresh(eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (eventType !== 'job.completed' && eventType !== 'job.completed_with_warnings') return;
  const filePath = String(payload.filePath || '');
  const refreshUrl = buildPlexRefreshUrl(filePath);
  if (!refreshUrl) return;

  const res = await fetch(refreshUrl, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body ? `Plex refresh failed HTTP ${res.status}: ${body}` : `Plex refresh failed HTTP ${res.status}`);
  }
  log.info('plex library refresh triggered', { eventType, filePath, sectionId: config.plexLibrarySectionId || 'custom' });
}

export async function sendPlexUpdate(eventType: string, payload: Record<string, unknown>): Promise<void> {
  await triggerPlexRefresh(eventType, payload);

  if (config.plexWebhookUrl) {
    await fetchJson(config.plexWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'stable-downloader',
        eventType,
        payload,
      }),
    });
    log.info('plex webhook sent', { eventType });
  }
}
