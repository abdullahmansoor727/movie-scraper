'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, '..', 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  debugger;
  return {
    url: playlist,
    tracks: collectSubtitleTracks(data),
    previewThumbnails: collectPreviewThumbnails(data, playlist),
  };
}

// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function proxiedPathForUrl(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\.m3u8?$/.test(pathname)) return '/api/playlist.m3u8';
  if (/\.(vtt|webvtt|srt)$/.test(pathname)) return '/api/subtitle.vtt';
  if (/\.(key|bin)$/.test(pathname)) return '/api/key.bin';
  return '/api/segment.ts';
}

function toProxiedUrl(value, playlistUrl) {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return value;
  const absolute = new URL(value, playlistUrl);
  const hash = absolute.hash;
  absolute.hash = '';
  const absoluteUrl = absolute.href;
  return proxiedPathForUrl(absoluteUrl) + '?url=' + encodeURIComponent(absoluteUrl) + hash;
}

function rewriteM3u8(body, url) {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, function(_, uri) {
        return 'URI="' + toProxiedUrl(uri, url) + '"';
      });
    }
    return toProxiedUrl(t, url);
  }).join('\n');
}

function srtToVtt(body) {
  return 'WEBVTT\n\n' + body
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3})/gm, '');
}

function rewriteVttUrls(body, url) {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (
      !t ||
      t === 'WEBVTT' ||
      t.includes('-->') ||
      /^(NOTE|STYLE|REGION)(\s|$)/.test(t)
    ) {
      return line;
    }

    if (!/#xywh=|\/|\.([a-z0-9]{2,5})(\?|#|$)/i.test(t)) return line;

    return line.replace(/\S+/g, value => {
      try {
        return toProxiedUrl(value, url);
      } catch (err) {
        return value;
      }
    });
  }).join('\n');
}

function trackFieldsFrom(value) {
  debugger;
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    if (value.url || value.src || value.file || value.link || value.href) return [value];
    return Object.entries(value).flatMap(([label, item]) => {
      return trackFieldsFrom(item).map(track => {
        if (typeof track === 'string') {
          return { url: track, label, language: label };
        }
        if (track && typeof track === 'object') {
          return { label, language: label, ...track };
        }
        return track;
      });
    });
  }
  return [value];
}

function rawTrackUrl(track) {
  return track && (track.url || track.src || track.file || track.link || track.href);
}

function descriptorForTrack(track) {
  return [
    track?.kind,
    track?.type,
    track?.role,
    track?.label,
    track?.name,
    track?.title,
    track?.language,
    rawTrackUrl(track),
  ].filter(Boolean).join(' ').toLowerCase();
}

function isSubtitleTrackLike(track) {
  const descriptor = descriptorForTrack(track);
  if (/(thumb|thumbnail|preview|sprite|storyboard|chapter|metadata|image)/.test(descriptor)) return false;
  if (/(caption|subtitle|closed.?caption)/.test(descriptor)) return true;
  return /\.(vtt|webvtt|srt)(\?|#|$)/i.test(rawTrackUrl(track) || '');
}

function isPreviewTrackLike(track, trustedField) {
  const rawUrl = rawTrackUrl(track) || '';
  if (!/\.(vtt|webvtt)(\?|#|$)/i.test(rawUrl)) return false;
  if (trustedField) return true;
  return /(thumb|thumbnail|preview|sprite|storyboard)/.test(descriptorForTrack(track));
}

function normalizeLanguage(value) {
  if (!value) return 'und';

  // 1. Production ISO 639-1 / 639-2 Comprehensive Language Dictionary
  var isoMap = {
    // A-D
    'afar': 'aa', 'abkhaz': 'ab', 'abkhazian': 'ab', 'afrikaans': 'af', 'akan': 'ak', 'amharic': 'am', 'aragonese': 'an', 
    'arabic': 'ar', 'ara': 'ar', 'assamese': 'as', 'avaric': 'av', 'aymara': 'ay', 'azerbaijani': 'az', 'bashkir': 'ba', 
    'belarusian': 'be', 'bulgarian': 'bg', 'bul': 'bg', 'bislama': 'bi', 'bambara': 'bm', 'bengali': 'bn', 'tibetan': 'bo', 
    'breton': 'br', 'bosnian': 'bs', 'bos': 'bs', 'catalan': 'ca', 'valencian': 'ca', 'chamorro': 'ch', 'chechen': 'ce', 
    'corsican': 'co', 'cree': 'cr', 'czech': 'cs', 'ces': 'cs', 'cze': 'cs', 'welsh': 'cy', 'danish': 'da', 'dan': 'da', 
    'german': 'de', 'deu': 'de', 'ger': 'de', 'divehi': 'dv', 'dhivehi': 'dv', 'dzongkha': 'dz',
    // ADDED: Dutch & Flemish variants
    'dutch': 'nl', 'nld': 'nl', 'dut': 'nl', 'flemish': 'nl', 
    // E-H
    'ewe': 'ee', 'greek': 'el', 'ell': 'el', 'gre': 'el', 'english': 'en', 'eng': 'en', 'esperanto': 'eo', 'spanish': 'es', 
    'spa': 'es', 'castilian': 'es', 'estonian': 'et', 'basque': 'eu', 'eus': 'eu', 'baq': 'eu', 'persian': 'fa', 'fas': 'fa', 
    'per': 'fa', 'fulah': 'ff', 'finnish': 'fi', 'fin': 'fi', 'fijian': 'fj', 'faroese': 'fo', 'french': 'fr', 'fra': 'fr', 
    'fre': 'fr', 'western frisian': 'fy', 'irish': 'ga', 'gaelic': 'gd', 'scottish gaelic': 'gd', 'galician': 'gl', 
    'guarani': 'gn', 'gujarati': 'gu', 'haitian': 'ht', 'creole': 'ht', 'hausa': 'ha', 'hebrew': 'he', 'herero': 'hz', 
    'hindi': 'hi', 'hin': 'hi', 'hiri motu': 'ho', 'croatian': 'hr', 'hrv': 'hr', 'scr': 'hr', 'hungarian': 'hu', 
    'hun': 'hu', 'armenian': 'hy',
    // I-N
    'indonesian': 'id', 'ind': 'id', 'interlingue': 'ie', 'igbo': 'ig', 'sichuan yi': 'ii', 'nuosu': 'ii', 'inupiaq': 'ik', 
    'ido': 'io', 'icelandic': 'is', 'isl': 'is', 'ice': 'is', 'italian': 'it', 'ita': 'it', 'inuktitut': 'iu', 'japanese': 'ja', 
    'jpn': 'ja', 'javanese': 'jv', 'georgian': 'ka', 'kat': 'ka', 'geo': 'ka', 'kongo': 'kg', 'kikuyu': 'ki', 'gikuyu': 'ki', 
    'kuanyama': 'kj', 'kwanyama': 'kj', 'kazakh': 'kk', 'greenlandic': 'kl', 'kalaallisut': 'kl', 'khmer': 'km', 'kannada': 'kn', 
    'korean': 'ko', 'kor': 'ko', 'kanuri': 'kr', 'kashmiri': 'ks', 'kurdish': 'ku', 'komi': 'kv', 'cornish': 'kw', 
    'kyrgyz': 'ky', 'kirghiz': 'ky', 'latin': 'la', 'luxembourgish': 'lb', 'ganda': 'lg', 'luganda': 'lg', 'limburgan': 'li', 
    'limburgish': 'li', 'lingala': 'ln', 'lao': 'lo', 'lithuanian': 'lt', 'luba-katanga': 'lu', 'latvian': 'lv', 'manx': 'gv', 
    'macedonian': 'mk', 'mkd': 'mk', 'mac': 'mk', 'malagasy': 'mg', 'malay': 'ms', 'msa': 'ms', 'may': 'ms', 'maltese': 'mt', 
    'burmese': 'my', 'mya': 'my', 'bur': 'my', 'nauru': 'na', 'norwegian bokmal': 'nb', 'north ndebele': 'nd', 'nepali': 'ne', 
    'ndonga': 'ng', 'norwegian nynorsk': 'nn', 'norwegian': 'no', 'nor': 'no', 'south ndebele': 'nr', 'navajo': 'nv', 'navaho': 'nv', 
    // O-Z
    'chichewa': 'ny', 'nyanja': 'ny', 'occitan': 'oc', 'ojibwa': 'oj', 'oromo': 'om', 'oriya': 'or', 'ossetian': 'os', 
    'ossetic': 'os', 'panjabi': 'pa', 'punjabi': 'pa', 'pali': 'pi', 'polish': 'pl', 'pol': 'pl', 'pashto': 'ps', 'pushto': 'ps', 
    'portuguese': 'pt', 'por': 'pt', 'quechua': 'qu', 'romansh': 'rm', 'rundi': 'rn', 'romanian': 'ro', 'ron': 'ro', 'rum': 'ro', 
    'moldavian': 'ro', 'moldovan': 'ro', 'russian': 'ru', 'rus': 'ru', 'kinyarwanda': 'rw', 'sanskrit': 'sa', 'sardinian': 'sc', 
    'sindhi': 'sd', 'northern sami': 'se', 'samoan': 'sm', 'sango': 'sg', 'serbian': 'sr', 'srp': 'sr', 'scc': 'sr', 
    'shona': 'sn', 'sinhala': 'si', 'sinhalese': 'si', 'slovak': 'sk', 'slk': 'sk', 'slo': 'sk', 'slovenian': 'sl', 
    'slovene': 'sl', 'somali': 'so', 'southern sotho': 'st', 'sundanese': 'su', 'swedish': 'sv', 'swe': 'sv', 'swahili': 'sw', 
    'swati': 'ss', 'tamil': 'ta', 'telugu': 'te', 'tajik': 'tg', 'thai': 'th', 'tha': 'th', 'tigrinya': 'ti', 'turkmen': 'tk', 
    'tagalog': 'tl', 'tswana': 'tn', 'tonga': 'to', 'turkish': 'tr', 'tur': 'tr', 'tsonga': 'ts', 'tatar': 'tt', 'twi': 'tw', 
    'tahitian': 'ty', 'uighur': 'ug', 'uyghur': 'ug', 'ukrainian': 'uk', 'ukr': 'uk', 'urdu': 'ur', 'uzbek': 'uz', 
    'venda': 've', 'vietnamese': 'vi', 'vie': 'vi', 'volapuk': 'vo', 'walloon': 'wa', 'wolof': 'wo', 'xhosa': 'xh', 
    'yiddish': 'yi', 'yoruba': 'yo', 'zhuang': 'za', 'chuang': 'za', 'chinese': 'zh', 'zho': 'zh', 'chi': 'zh', 'zul': 'zu', 'zulu': 'zu'
  };

  // 2. Heavy Normalization Sanitizer Pipeline (Fixed syntax sequence chain)
  var tokens = String(value)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Strip accents
    .split(/[\s\-_([{,]/);                           // Split into array segments

  // Extract the very first valid alphabetical string block
  var raw = (tokens[0] || '').replace(/[^a-z]/g, '').trim();

  // 3. Evaluation Hierarchy
  if (isoMap[raw]) {
    return isoMap[raw];
  }

  // Double-Check: Handle native 2/3 letter code strings passed directly (e.g. "nl", "nld", "en-US")
  var strictCode = String(value).trim().toLowerCase().replace('_', '-');
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(strictCode)) {
    return strictCode.split('-')[0];
  }

  return 'und';
}

function normalizeSubtitleTrack(value, index) {
  debugger;
  const track = typeof value === 'string' ? { url: value } : value;
  if (!track || typeof track !== 'object') return null;
  if (!isSubtitleTrackLike(track)) return null;

  const rawUrl = rawTrackUrl(track);
  if (!rawUrl) return null;

  const language = normalizeLanguage(track.srclang || track.lang || track.languageCode || track.language || track.code);
  const label = track.label || track.name || track.title || track.language || track.lang || `Subtitle ${index + 1}`;
  const kind = ['captions', 'subtitles'].includes(track.kind) ? track.kind : 'subtitles';
  let src;

  try {
    src = toProxiedUrl(rawUrl, rawUrl);
  } catch (err) {
    return null;
  }

  return {
    kind,
    label: String(label),
    srclang: language,
    src,
  };
}

function toProxiedPreviewUrl(value, baseUrl) {
  const absolute = new URL(value, baseUrl || value);
  absolute.hash = '';
  return '/api/preview.vtt?url=' + encodeURIComponent(absolute.href);
}

function normalizePreviewThumbnail(value, index, trustedField, baseUrl) {
  const track = typeof value === 'string' ? { url: value } : value;
  if (!track || typeof track !== 'object') return null;
  if (!isPreviewTrackLike(track, trustedField)) return null;

  try {
    return toProxiedPreviewUrl(rawTrackUrl(track), baseUrl);
  } catch (err) {
    return null;
  }
}

function collectSubtitleTracks(data) {
debugger;
  const candidates = [
    data?.captions,
    data?.subtitles,
    data?.tracks,
    data?.subtitleTracks,
    data?.closedCaptions,
    data?.stream?.captions,
    data?.stream?.subtitles,
    data?.stream?.tracks,
    data?.stream?.subtitleTracks,
    data?.stream?.closedCaptions,
  ];

  const seen = new Set();
  return candidates
    .flatMap(trackFieldsFrom)
    .map(normalizeSubtitleTrack)
    .filter(track => {
      if (!track || seen.has(track.src)) return false;
      seen.add(track.src);
      return true;
    });
}

function collectPreviewThumbnails(data, baseUrl) {
  const trustedCandidates = [
    data?.preview,
    data?.previews,
    data?.previewThumbnails,
    data?.previewThumbnail,
    data?.thumbnails,
    data?.thumbnail,
    data?.storyboards,
    data?.storyboard,
    data?.stream?.preview,
    data?.stream?.previews,
    data?.stream?.previewThumbnails,
    data?.stream?.previewThumbnail,
    data?.stream?.thumbnails,
    data?.stream?.thumbnail,
    data?.stream?.storyboards,
    data?.stream?.storyboard,
  ];
  const mixedCandidates = [
    data?.tracks,
    data?.stream?.tracks,
  ];
  const seen = new Set();
  const values = trustedCandidates
    .flatMap(trackFieldsFrom)
    .map((track, index) => normalizePreviewThumbnail(track, index, true, baseUrl))
    .concat(
      mixedCandidates
        .flatMap(trackFieldsFrom)
        .map((track, index) => normalizePreviewThumbnail(track, index, false, baseUrl))
    );

  return values.filter(src => {
    if (!src || seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function getQuery(event) {
  if (event.queryStringParameters) {
    return event.queryStringParameters;
  }

  const rawUrl = event.rawUrl || event.path || '/api';
  const { searchParams } = new URL(rawUrl, 'http://localhost');
  return Object.fromEntries(searchParams);
}

async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const q = getQuery(event);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = q.url;
    try {
      const requestPath = String(event.path || event.rawUrl || '').toLowerCase();
      const isPreviewVtt = requestPath.includes('/api/preview.vtt') || q.preview === '1';
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const cleanPath = url.split('?')[0];
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?$/i.test(cleanPath);
      const isSubtitle = ct.includes('text/vtt') || ct.includes('webvtt') || /\.(vtt|webvtt|srt)$/i.test(cleanPath);
      const bodyBuffer = await streamToBuffer(upstream);

      if (isM3u8) {
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl' },
          body: rewriteM3u8(bodyBuffer.toString('utf8'), url),
        };
      }

      if (isSubtitle) {
        const isSrt = /\.srt$/i.test(cleanPath) || ct.includes('subrip');
        const textBody = isSrt ? srtToVtt(bodyBuffer.toString('utf8')) : bodyBuffer.toString('utf8');
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'text/vtt; charset=utf-8' },
          body: isPreviewVtt ? rewriteVttUrls(textBody, url) : textBody,
        };
      }

      return {
        statusCode: upstream.statusCode || 200,
        headers: { ...headers, 'Content-Type': ct || 'application/octet-stream' },
        body: bodyBuffer.toString('base64'),
        isBase64Encoded: true,
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'missing id' }),
    };
  }

  try {
    const stream = await getStream(q.id, q.s, q.e);
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(stream),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
}

exports.handler = handler;
