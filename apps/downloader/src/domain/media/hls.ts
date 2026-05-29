export function parseAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  value.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, key: string, raw: string) => {
    attrs[key] = raw.charAt(0) === '"' ? raw.slice(1, -1) : raw;
    return '';
  });
  return attrs;
}

export function absoluteUrl(value: string, base: string): string {
  return new URL(value, base).href;
}

export function parseMasterPlaylist(text: string, baseUrl: string): Array<{ url: string; label: string; }> {
  const lines = text.split(/\r?\n/);
  const variants: Array<{ url: string; label: string; }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    while ((i += 1) < lines.length) {
      uri = lines[i].trim();
      if (uri && !uri.startsWith('#')) break;
    }
    if (!uri) continue;
    const bandwidth = attrs.BANDWIDTH ? `${Math.round(Number(attrs.BANDWIDTH) / 1000)} kbps` : 'unknown bitrate';
    const resolution = attrs.RESOLUTION || 'auto';
    variants.push({
      url: absoluteUrl(uri, baseUrl),
      label: `${resolution} - ${bandwidth}`,
    });
  }
  return variants;
}

export type MediaPlaylist = {
  items: string[];
  hasMap: boolean;
};

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  let hasMap = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(trimmed.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        hasMap = true;
        items.push(absoluteUrl(attrs.URI, baseUrl));
      }
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    items.push(absoluteUrl(trimmed, baseUrl));
  }
  return { items, hasMap };
}
