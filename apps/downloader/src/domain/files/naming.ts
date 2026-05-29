export function sanitizeSegment(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function sanitizeFilenamePart(value: string): string {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesFolderName(id: string, title = '', year = ''): string {
  const readable = sanitizeFilenamePart(title || `tv-${id}`);
  return [readable, year ? `(${year})` : '', `[tmdbid-${id}]`]
    .filter(Boolean)
    .join(' ');
}

function movieFolderName(id: string, title = '', year = ''): string {
  const readable = sanitizeFilenamePart(title || `movie-${id}`);
  return [readable, year ? `(${year})` : '', `[tmdbid-${id}]`]
    .filter(Boolean)
    .join(' ');
}

function seasonFolderName(season: string): string {
  return `Season ${String(season || '1').padStart(2, '0')}`;
}

function downloadBasename(
  id: string,
  season: string,
  episode: string,
  label: string,
  title = '',
  year = '',
  episodeTitle = ''
): string {
  const readableBase = season
    ? [
        sanitizeFilenamePart(title || `tv-${id}`),
        `S${String(season).padStart(2, '0')}E${String(episode || '1').padStart(2, '0')}`,
        sanitizeFilenamePart(episodeTitle || '')
      ].filter(Boolean).join(' - ')
    : [
        sanitizeFilenamePart(title || `movie-${id}`),
        year ? `(${year})` : ''
      ].filter(Boolean).join(' ');
  const fallbackBase = season
    ? `tv-${id}-s${season}e${episode || '1'}`
    : `movie-${id}`;
  const base = readableBase || fallbackBase;
  const quality = sanitizeSegment(label);
  return `${base}${quality ? '-' + quality : ''}`;
}

export function downloadFilename(
  id: string,
  season: string,
  episode: string,
  label: string,
  hasMap: boolean,
  title = '',
  year = '',
  episodeTitle = ''
): string {
  return `${downloadBasename(id, season, episode, label, title, year, episodeTitle)}${hasMap ? '.mp4' : '.ts'}`;
}

export function libraryRelativeMediaPath(
  id: string,
  season: string,
  episode: string,
  label: string,
  extension: string,
  title = '',
  year = '',
  episodeTitle = ''
): string {
  const cleanExtension = extension.startsWith('.') ? extension : `.${extension}`;
  const fileName = `${downloadBasename(id, season, episode, label, title, year, episodeTitle)}${cleanExtension}`;
  if (season) {
    return [
      seriesFolderName(id, title, year),
      seasonFolderName(season),
      fileName,
    ].join('/');
  }
  return [
    movieFolderName(id, title, year),
    fileName,
  ].join('/');
}
