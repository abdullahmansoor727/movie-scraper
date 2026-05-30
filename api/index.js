"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const REFERER = "https://vidlink.pro/";
const ORIGIN = "https://vidlink.pro";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124";
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16 });
const TMDB_KEY = "3a73619bbb8fc6d47742d1b5b2b707b5";
const FILE_RANGE_CHUNK_SIZE = 8 * 1024 * 1024;

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = {
      createElement: () => ({}),
      body: { appendChild: () => {} },
    };

    const sodium = require("libsodium-wrappers");
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8"));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, "..", "fu.wasm"));
    const { instance } = await WebAssembly.instantiate(
      wasmBuf,
      go.importObject,
    );
    go.run(instance);

    await new Promise((r) => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== "function")
      throw new Error("getAdv not found after WASM boot");
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
function absoluteUrl(value, base) {
  return new URL(value, base).href;
}

function normalizeSubtitleTrack(track, baseUrl) {
  if (!track || typeof track !== "object") return null;
  const rawUrl = track.url || track.file || track.src || track.link;
  if (!rawUrl) return null;
  const language =
    track.lang || track.language || track.srclang || track.code || "Unknown";
  const label = track.label || track.name || track.title || language;
  return {
    url: absoluteUrl(rawUrl, baseUrl || rawUrl),
    language: String(language),
    label: String(label),
  };
}

function collectSubtitleTracks(value, baseUrl, out, seen) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => {
      const normalized = normalizeSubtitleTrack(item, baseUrl);
      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        out.push(normalized);
      }
      collectSubtitleTracks(item, baseUrl, out, seen);
    });
    return;
  }
  if (typeof value !== "object") return;

  const direct = normalizeSubtitleTrack(value, baseUrl);
  if (direct && !seen.has(direct.url)) {
    seen.add(direct.url);
    out.push(direct);
  }

  Object.keys(value).forEach((key) => {
    if (/subtitle|caption|track/i.test(key)) {
      collectSubtitleTracks(value[key], baseUrl, out, seen);
    }
  });
}

function extractSubtitleTracks(data, playlistUrl) {
  const tracks = [];
  const seen = new Set();
  collectSubtitleTracks(data, playlistUrl, tracks, seen);
  return tracks;
}

async function fetchTmdbMeta(id, season, episode) {
  const type = season ? "tv" : "movie";
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!season) {
    return {
      title: data.title || data.original_title || `movie-${id}`,
      year: (data.release_date || "").slice(0, 4) || "",
    };
  }
  let episodeTitle = "";
  if (season && episode) {
    const epRes = await fetch(
      `https://api.themoviedb.org/3/tv/${id}/season/${season}/episode/${episode}?api_key=${TMDB_KEY}`,
    );
    if (epRes.ok) {
      const epData = await epRes.json();
      episodeTitle = epData.name || "";
    }
  }
  return {
    title: data.name || data.original_name || `tv-${id}`,
    year: (data.first_air_date || "").slice(0, 4) || "",
    episodeTitle,
  };
}
function asRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function pickUrl(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const fields = ["url", "src", "file", "playlist", "manifest", "hls"];
  for (const field of fields) {
    const candidate = rec[field];
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate))
      return candidate;
  }
  return null;
}

function deepFindUrl(value, maxDepth = 4, seen = new Set()) {
  if (maxDepth < 0) return null;
  if (typeof value === "string")
    return /^https?:\/\//i.test(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const direct = pickUrl(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = deepFindUrl(item, maxDepth - 1, seen);
      if (nested) return nested;
    }
    return null;
  }
  const rec = value;
  const preferred = [
    "playlist",
    "manifest",
    "hls",
    "url",
    "src",
    "file",
    "link",
    "path",
  ];
  for (const key of preferred) {
    if (key in rec) {
      const nested = deepFindUrl(rec[key], maxDepth - 1, seen);
      if (nested) return nested;
    }
  }
  for (const nestedValue of Object.values(rec)) {
    const nested = deepFindUrl(nestedValue, maxDepth - 1, seen);
    if (nested) return nested;
  }
  return null;
}

function qualityRank(label) {
  const m = String(label || "").match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

function qualityLabel(entry) {
  const rec = asRecord(entry.value);
  const raw = String(
    (rec &&
      (rec.label || rec.quality || rec.name || rec.title || rec.resolution)) ||
      entry.key ||
      "default stream",
  );
  const resolution = raw.match(/(\d{3,4})p?/i) || raw.match(/\d+x(\d{3,4})/i);
  if (resolution) return `${Number(resolution[1])}p`;
  return raw;
}

function normalizeQualities(qualities) {
  if (Array.isArray(qualities)) {
    return qualities.map((value, idx) => ({ key: String(idx), value }));
  }
  const rec = asRecord(qualities);
  if (!rec) return [];
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

function getStreamType(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const pathname = new URL(url).pathname;
    if (/\.m3u8(?:$|\?)/i.test(pathname)) return "hls";
    if (/\.(mp4|mkv|webm|mov)(?:$|\?)/i.test(pathname)) return "file";
  } catch (_) {}
  if (/\.m3u8/i.test(url)) return "hls";
  if (/\.(mp4|mkv|webm|mov)/i.test(url)) return "file";
  return null;
}

function pickFromStream(stream) {
  const rec = asRecord(stream);
  if (!rec) return null;
  const direct = deepFindUrl(rec, 4);
  if (direct) return direct;
  const qualities = normalizeQualities(rec.qualities);
  const sorted = qualities
    .map((entry) => ({ ...entry, rank: qualityRank(entry.key) }))
    .sort((a, b) => b.rank - a.rank);
  for (const entry of sorted) {
    const found = deepFindUrl(entry.value, 4);
    if (found) return found;
  }
  return null;
}

function extractStreamData(data) {
  const root = asRecord(data);
  if (!root) return null;
  const dataNode = asRecord(root.data);
  const streamNode = (dataNode && dataNode.stream) || root.stream;
  if (!streamNode) return null;

  let primaryUrl =
    pickFromStream(streamNode) ||
    deepFindUrl(dataNode, 4) ||
    deepFindUrl(root, 4);

  const variants = [];
  if (streamNode.qualities) {
    const normalized = normalizeQualities(streamNode.qualities);
    normalized.forEach((entry) => {
      const entryUrl = deepFindUrl(entry.value, 4);
      if (entryUrl) {
        const label = qualityLabel(entry);
        const height = qualityRank(label) || qualityRank(entry.key);
        variants.push({
          label: label,
          height: height || 0,
          url: entryUrl,
        });
      }
    });
    variants.sort((a, b) => b.height - a.height);
  }

  if (!primaryUrl && variants.length > 0) {
    primaryUrl = variants[0].url;
  }

  const finalType = getStreamType(primaryUrl);
  if (!primaryUrl || !finalType) return null;

  return {
    url: primaryUrl,
    type: finalType,
    variants: variants,
  };
}

function toPlaybackUrl(sourceUrl) {
  return toProxiedUrl(sourceUrl, sourceUrl);
}

function normalizePlaybackVariant(variant) {
  if (!variant || !variant.url) return null;
  const type = getStreamType(variant.url);
  if (!type) return null;
  return {
    label: variant.label,
    height: Number(variant.height) || 0,
    type,
    url: toPlaybackUrl(variant.url),
    sourceUrl: variant.url,
  };
}

function normalizePlaybackStream(stream) {
  const type = stream.type || getStreamType(stream.url);
  if (!type || !stream.url) return null;

  let sourceUrl = stream.url;
  let variants = (stream.variants || [])
    .map(normalizePlaybackVariant)
    .filter((variant) => variant && variant.type === type)
    .filter((variant, index, all) => {
      return all.findIndex((item) => item.sourceUrl === variant.sourceUrl) === index;
    })
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (type === "file" && variants.length) {
    sourceUrl = variants[0].sourceUrl;
  }

  return {
    type,
    url: toPlaybackUrl(sourceUrl),
    sourceUrl,
    variants,
  };
}

async function getStreamData(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error("getAdv returned null");

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=1`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();

  const stream = extractStreamData(data);
  if (!stream || !stream.url) throw new Error("No stream in response");
  const playback = normalizePlaybackStream(stream);
  if (!playback || !playback.url) throw new Error("No playable stream in response");

  const subtitles =
    typeof collectSubtitleTracks === "function"
      ? collectSubtitleTracks(data)
      : [];
  const meta = await fetchTmdbMeta(id, season, episode).catch(() => null);

  return {
    url: playback.url,
    sourceUrl: playback.sourceUrl,
    type: playback.type,
    variants: playback.variants || [],
    tracks: subtitles,
    subtitles: subtitles,
    previewThumbnails: collectPreviewThumbnails(data, playback.sourceUrl),
    meta: meta || null,
  };
}

// ── HLS upstream fetcher with redirect support ────────────────────────────────
function isTransientProxyError(err) {
  const message = err && err.message ? err.message : "";
  return !!(
    err &&
    (/aborted|timed out|socket hang up|econnreset|epipe|network/i.test(
      message,
    ) ||
      err.code === "ECONNRESET" ||
      err.code === "EPIPE")
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchUpstream(url, redirects = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const isHttps = url.startsWith("https");
    const upstreamHeaders = {
      Referer: REFERER,
      Origin: ORIGIN,
      "User-Agent": UA,
      Accept: "*/*",
    };
    Object.entries(extraHeaders).forEach(([name, value]) => {
      if (value === null || typeof value === "undefined") {
        delete upstreamHeaders[name];
      } else {
        upstreamHeaders[name] = value;
      }
    });
    const request = (isHttps ? https : http).get(
      url,
      {
        agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
        headers: upstreamHeaders,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const loc = res.headers.location;
          return resolve(
            fetchUpstream(
              loc.startsWith("http") ? loc : new URL(loc, url).href,
              redirects + 1,
              extraHeaders,
            ),
          );
        }
        resolve(res);
      },
    );
    request.setTimeout(25000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", reject);
  });
}

function upstreamRequestHeaders(url, eventHeaders) {
  const isFile = getStreamType(url) === "file";
  const rangeHeader = normalizedRangeHeader(
    eventHeaders.range || eventHeaders.Range,
    isFile,
  );
  const headers = rangeHeader ? { Range: rangeHeader } : {};
  if (isFile) {
    if (!headers.Range) {
      headers.Range = `bytes=0-${FILE_RANGE_CHUNK_SIZE - 1}`;
    }
    headers.Referer = REFERER;
    headers.Origin = null;
  }
  return headers;
}

function normalizedRangeHeader(rangeHeader, shouldClamp) {
  if (!rangeHeader || !shouldClamp) return rangeHeader;
  const match = String(rangeHeader).match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return rangeHeader;

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return rangeHeader;

  const requestedEnd = match[2] ? Number(match[2]) : start + FILE_RANGE_CHUNK_SIZE - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return rangeHeader;

  const end = Math.min(requestedEnd, start + FILE_RANGE_CHUNK_SIZE - 1);
  return `bytes=${start}-${end}`;
}

function passthroughProxyHeaders(upstream) {
  const headers = {};
  [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "etag",
    "last-modified",
  ].forEach((name) => {
    if (upstream.headers[name]) {
      headers[name] = upstream.headers[name];
    }
  });
  return headers;
}

async function fetchUpstreamWithRetry(url, attempt = 0) {
  try {
    return await fetchUpstream(url, 0);
  } catch (err) {
    if (attempt >= 2 || !isTransientProxyError(err)) {
      throw err;
    }
    await wait(750 * Math.pow(2, attempt));
    return fetchUpstreamWithRetry(url, attempt + 1);
  }
}

function proxiedPathForUrl(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\.m3u8?$/.test(pathname)) return "/api/playlist.m3u8";
  if (/\.(vtt|webvtt|srt)$/.test(pathname)) return "/api/subtitle.vtt";
  if (/\.(key|bin)$/.test(pathname)) return "/api/key.bin";
  return "/api/segment.ts";
}

function toProxiedUrl(value, playlistUrl, origin = "") {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value))
    return value;
  const absolute = new URL(value, playlistUrl);
  const hash = absolute.hash;
  absolute.hash = "";
  const absoluteUrl = absolute.href;
  return (
    proxiedPathForUrl(absoluteUrl) +
    "?url=" +
    encodeURIComponent(absoluteUrl) +
    hash
  );
  // const absoluteUrl = new URL(value, playlistUrl).href;
  // const proxiedPath =
  //   proxiedPathForUrl(absoluteUrl) + '?url=' + encodeURIComponent(absoluteUrl);
  // return origin ? new URL(proxiedPath, origin).href : proxiedPath;
}

function rewriteM3u8(body, url, origin = "") {
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, function (_, uri) {
          return 'URI="' + toProxiedUrl(uri, url, origin) + '"';
        });
      }
      return toProxiedUrl(t, url, origin);
    })
    .join("\n");
}

function srtToVtt(body) {
  return (
    "WEBVTT\n\n" +
    body
      .replace(/^\uFEFF/, "")
      .replace(/\r+/g, "")
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(
        /^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3})/gm,
        "",
      )
  );
}

function rewriteVttUrls(body, url) {
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (
        !t ||
        t === "WEBVTT" ||
        t.includes("-->") ||
        /^(NOTE|STYLE|REGION)(\s|$)/.test(t)
      ) {
        return line;
      }

      if (!/#xywh=|\/|\.([a-z0-9]{2,5})(\?|#|$)/i.test(t)) return line;

      return line.replace(/\S+/g, (value) => {
        try {
          return toProxiedUrl(value, url);
        } catch (err) {
          return value;
        }
      });
    })
    .join("\n");
}

function trackFieldsFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    if (value.url || value.src || value.file || value.link || value.href)
      return [value];
    return Object.entries(value).flatMap(([label, item]) => {
      return trackFieldsFrom(item).map((track) => {
        if (typeof track === "string") {
          return { url: track, label, language: label };
        }
        if (track && typeof track === "object") {
          return { label, language: label, ...track };
        }
        return track;
      });
    });
  }
  return [value];
}

function rawTrackUrl(track) {
  return (
    track && (track.url || track.src || track.file || track.link || track.href)
  );
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
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isSubtitleTrackLike(track) {
  const descriptor = descriptorForTrack(track);
  if (
    /(thumb|thumbnail|preview|sprite|storyboard|chapter|metadata|image)/.test(
      descriptor,
    )
  )
    return false;
  if (/(caption|subtitle|closed.?caption)/.test(descriptor)) return true;
  return /\.(vtt|webvtt|srt)(\?|#|$)/i.test(rawTrackUrl(track) || "");
}

function isPreviewTrackLike(track, trustedField) {
  const rawUrl = rawTrackUrl(track) || "";
  if (!/\.(vtt|webvtt)(\?|#|$)/i.test(rawUrl)) return false;
  if (trustedField) return true;
  return /(thumb|thumbnail|preview|sprite|storyboard)/.test(
    descriptorForTrack(track),
  );
}

function normalizeLanguage(value) {
  if (!value) return "und";

  // 1. Production ISO 639-1 / 639-2 Comprehensive Language Dictionary
  var isoMap = {
    // A-D
    afar: "aa",
    abkhaz: "ab",
    abkhazian: "ab",
    afrikaans: "af",
    akan: "ak",
    amharic: "am",
    aragonese: "an",
    arabic: "ar",
    ara: "ar",
    assamese: "as",
    avaric: "av",
    aymara: "ay",
    azerbaijani: "az",
    bashkir: "ba",
    belarusian: "be",
    bulgarian: "bg",
    bul: "bg",
    bislama: "bi",
    bambara: "bm",
    bengali: "bn",
    tibetan: "bo",
    breton: "br",
    bosnian: "bs",
    bos: "bs",
    catalan: "ca",
    valencian: "ca",
    chamorro: "ch",
    chechen: "ce",
    corsican: "co",
    cree: "cr",
    czech: "cs",
    ces: "cs",
    cze: "cs",
    welsh: "cy",
    danish: "da",
    dan: "da",
    german: "de",
    deu: "de",
    ger: "de",
    divehi: "dv",
    dhivehi: "dv",
    dzongkha: "dz",
    // ADDED: Dutch & Flemish variants
    dutch: "nl",
    nld: "nl",
    dut: "nl",
    flemish: "nl",
    // E-H
    ewe: "ee",
    greek: "el",
    ell: "el",
    gre: "el",
    english: "en",
    eng: "en",
    esperanto: "eo",
    spanish: "es",
    spa: "es",
    castilian: "es",
    estonian: "et",
    basque: "eu",
    eus: "eu",
    baq: "eu",
    persian: "fa",
    fas: "fa",
    per: "fa",
    fulah: "ff",
    finnish: "fi",
    fin: "fi",
    fijian: "fj",
    faroese: "fo",
    french: "fr",
    fra: "fr",
    fre: "fr",
    "western frisian": "fy",
    irish: "ga",
    gaelic: "gd",
    "scottish gaelic": "gd",
    galician: "gl",
    guarani: "gn",
    gujarati: "gu",
    haitian: "ht",
    creole: "ht",
    hausa: "ha",
    hebrew: "he",
    herero: "hz",
    hindi: "hi",
    hin: "hi",
    "hiri motu": "ho",
    croatian: "hr",
    hrv: "hr",
    scr: "hr",
    hungarian: "hu",
    hun: "hu",
    armenian: "hy",
    // I-N
    indonesian: "id",
    ind: "id",
    interlingue: "ie",
    igbo: "ig",
    "sichuan yi": "ii",
    nuosu: "ii",
    inupiaq: "ik",
    ido: "io",
    icelandic: "is",
    isl: "is",
    ice: "is",
    italian: "it",
    ita: "it",
    inuktitut: "iu",
    japanese: "ja",
    jpn: "ja",
    javanese: "jv",
    georgian: "ka",
    kat: "ka",
    geo: "ka",
    kongo: "kg",
    kikuyu: "ki",
    gikuyu: "ki",
    kuanyama: "kj",
    kwanyama: "kj",
    kazakh: "kk",
    greenlandic: "kl",
    kalaallisut: "kl",
    khmer: "km",
    kannada: "kn",
    korean: "ko",
    kor: "ko",
    kanuri: "kr",
    kashmiri: "ks",
    kurdish: "ku",
    komi: "kv",
    cornish: "kw",
    kyrgyz: "ky",
    kirghiz: "ky",
    latin: "la",
    luxembourgish: "lb",
    ganda: "lg",
    luganda: "lg",
    limburgan: "li",
    limburgish: "li",
    lingala: "ln",
    lao: "lo",
    lithuanian: "lt",
    "luba-katanga": "lu",
    latvian: "lv",
    manx: "gv",
    macedonian: "mk",
    mkd: "mk",
    mac: "mk",
    malagasy: "mg",
    malay: "ms",
    msa: "ms",
    may: "ms",
    maltese: "mt",
    burmese: "my",
    mya: "my",
    bur: "my",
    nauru: "na",
    "norwegian bokmal": "nb",
    "north ndebele": "nd",
    nepali: "ne",
    ndonga: "ng",
    "norwegian nynorsk": "nn",
    norwegian: "no",
    nor: "no",
    "south ndebele": "nr",
    navajo: "nv",
    navaho: "nv",
    // O-Z
    chichewa: "ny",
    nyanja: "ny",
    occitan: "oc",
    ojibwa: "oj",
    oromo: "om",
    oriya: "or",
    ossetian: "os",
    ossetic: "os",
    panjabi: "pa",
    punjabi: "pa",
    pali: "pi",
    polish: "pl",
    pol: "pl",
    pashto: "ps",
    pushto: "ps",
    portuguese: "pt",
    por: "pt",
    quechua: "qu",
    romansh: "rm",
    rundi: "rn",
    romanian: "ro",
    ron: "ro",
    rum: "ro",
    moldavian: "ro",
    moldovan: "ro",
    russian: "ru",
    rus: "ru",
    kinyarwanda: "rw",
    sanskrit: "sa",
    sardinian: "sc",
    sindhi: "sd",
    "northern sami": "se",
    samoan: "sm",
    sango: "sg",
    serbian: "sr",
    srp: "sr",
    scc: "sr",
    shona: "sn",
    sinhala: "si",
    sinhalese: "si",
    slovak: "sk",
    slk: "sk",
    slo: "sk",
    slovenian: "sl",
    slovene: "sl",
    somali: "so",
    "southern sotho": "st",
    sundanese: "su",
    swedish: "sv",
    swe: "sv",
    swahili: "sw",
    swati: "ss",
    tamil: "ta",
    telugu: "te",
    tajik: "tg",
    thai: "th",
    tha: "th",
    tigrinya: "ti",
    turkmen: "tk",
    tagalog: "tl",
    tswana: "tn",
    tonga: "to",
    turkish: "tr",
    tur: "tr",
    tsonga: "ts",
    tatar: "tt",
    twi: "tw",
    tahitian: "ty",
    uighur: "ug",
    uyghur: "ug",
    ukrainian: "uk",
    ukr: "uk",
    urdu: "ur",
    uzbek: "uz",
    venda: "ve",
    vietnamese: "vi",
    vie: "vi",
    volapuk: "vo",
    walloon: "wa",
    wolof: "wo",
    xhosa: "xh",
    yiddish: "yi",
    yoruba: "yo",
    zhuang: "za",
    chuang: "za",
    chinese: "zh",
    zho: "zh",
    chi: "zh",
    zul: "zu",
    zulu: "zu",
  };

  // 2. Heavy Normalization Sanitizer Pipeline (Fixed syntax sequence chain)
  var tokens = String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Strip accents
    .split(/[\s\-_([{,]/); // Split into array segments

  // Extract the very first valid alphabetical string block
  var raw = (tokens[0] || "").replace(/[^a-z]/g, "").trim();

  // 3. Evaluation Hierarchy
  if (isoMap[raw]) {
    return isoMap[raw];
  }

  // Double-Check: Handle native 2/3 letter code strings passed directly (e.g. "nl", "nld", "en-US")
  var strictCode = String(value).trim().toLowerCase().replace("_", "-");
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(strictCode)) {
    return strictCode.split("-")[0];
  }

  return "und";
}

function normalizeSubtitleTrack(value, index) {
  const track = typeof value === "string" ? { url: value } : value;
  if (!track || typeof track !== "object") return null;
  if (!isSubtitleTrackLike(track)) return null;

  const rawUrl = rawTrackUrl(track);
  if (!rawUrl) return null;

  const language = normalizeLanguage(
    track.srclang ||
      track.lang ||
      track.languageCode ||
      track.language ||
      track.code,
  );
  const label =
    track.label ||
    track.name ||
    track.title ||
    track.language ||
    track.lang ||
    `Subtitle ${index + 1}`;
  const kind = ["captions", "subtitles"].includes(track.kind)
    ? track.kind
    : "subtitles";
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
  absolute.hash = "";
  return "/api/preview.vtt?url=" + encodeURIComponent(absolute.href);
}

function normalizePreviewThumbnail(value, index, trustedField, baseUrl) {
  const track = typeof value === "string" ? { url: value } : value;
  if (!track || typeof track !== "object") return null;
  if (!isPreviewTrackLike(track, trustedField)) return null;

  try {
    return toProxiedPreviewUrl(rawTrackUrl(track), baseUrl);
  } catch (err) {
    return null;
  }
}

function collectSubtitleTracks(data) {
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
    .filter((track) => {
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
  const mixedCandidates = [data?.tracks, data?.stream?.tracks];
  const seen = new Set();
  const values = trustedCandidates
    .flatMap(trackFieldsFrom)
    .map((track, index) =>
      normalizePreviewThumbnail(track, index, true, baseUrl),
    )
    .concat(
      mixedCandidates
        .flatMap(trackFieldsFrom)
        .map((track, index) =>
          normalizePreviewThumbnail(track, index, false, baseUrl),
        ),
    );

  return values.filter((src) => {
    if (!src || seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function getQuery(event) {
  if (event.queryStringParameters) {
    return event.queryStringParameters;
  }

  const rawUrl = event.rawUrl || event.path || "/api";
  const { searchParams } = new URL(rawUrl, "http://localhost");
  return Object.fromEntries(searchParams);
}

async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const q = getQuery(event);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = q.url;
    try {
      const requestPath = String(
        event.path || event.rawUrl || "",
      ).toLowerCase();
      const isPreviewVtt =
        requestPath.includes("/api/preview.vtt") || q.preview === "1";
      const eventHeaders = event.headers || {};
      const upstream = await fetchUpstream(url, 0, upstreamRequestHeaders(url, eventHeaders));
      const ct = (upstream.headers["content-type"] || "").toLowerCase();
      const proxyHeaders = passthroughProxyHeaders(upstream);
      const cleanPath = url.split("?")[0];
      const isM3u8 =
        ct.includes("mpegurl") ||
        ct.includes("m3u8") ||
        /\.m3u8?$/i.test(cleanPath);
      const isSubtitle =
        ct.includes("text/vtt") ||
        ct.includes("webvtt") ||
        /\.(vtt|webvtt|srt)$/i.test(cleanPath);
      // const upstream = await fetchUpstreamWithRetry(url);
      // const ct = (upstream.headers["content-type"] || "").toLowerCase();
      // const isM3u8 =
      //   ct.includes("mpegurl") ||
      //   ct.includes("m3u8") ||
      //   /\.m3u8?(\?|$)/i.test(url.split("?")[0]);
      const bodyBuffer = await streamToBuffer(upstream);

      if (isM3u8) {
        return {
          statusCode: 200,
          headers: {
            ...headers,
            "Content-Type": "application/vnd.apple.mpegurl",
          },
          body: rewriteM3u8(bodyBuffer.toString("utf8"), url),
        };
      }

      if (isSubtitle) {
        const isSrt = /\.srt$/i.test(cleanPath) || ct.includes("subrip");
        const textBody = isSrt
          ? srtToVtt(bodyBuffer.toString("utf8"))
          : bodyBuffer.toString("utf8");
        return {
          statusCode: 200,
          headers: { ...headers, "Content-Type": "text/vtt; charset=utf-8" },
          body: isPreviewVtt ? rewriteVttUrls(textBody, url) : textBody,
        };
      }

      return {
        statusCode: upstream.statusCode || 200,
        headers: {
          ...headers,
          ...proxyHeaders,
          "Content-Type": ct || "application/octet-stream",
        },
        body: bodyBuffer.toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    return {
      statusCode: 400,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "missing id" }),
    };
  }

  try {
    const stream = await getStreamData(q.id, q.s, q.e);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      // const stream = await getStreamData(q.id, q.s, q.e);
      // return {
      //   statusCode: 200,
      //   headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(stream),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
}

exports.handler = handler;
