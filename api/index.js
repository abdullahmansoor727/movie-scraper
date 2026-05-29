'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16 });
const TMDB_KEY = "3a73619bbb8fc6d47742d1b5b2b707b5";

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

function isPlaylistUrl(value) {
  try {
    return /\.m3u8(?:$|\?)/i.test(new URL(value).pathname);
  } catch (_) {
    return false;
  }
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
  const url =
    pickFromStream(streamNode) ||
    deepFindUrl(dataNode, 4) ||
    deepFindUrl(root, 4);
  if (!url || !isPlaylistUrl(url)) return null;
  return { url, variants: [] };
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
  console.log("vidlink API response", { id, season, episode, data });
  const stream = extractStreamData(data);
  if (!stream || !stream.url) throw new Error("No stream in response");
  const subtitles = extractSubtitleTracks(data, stream.url);
  const meta = await fetchTmdbMeta(id, season, episode).catch(() => null);
  return {
    url: stream.url,
    variants: stream.variants || [],
    subtitles,
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

function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const isHttps = url.startsWith("https");
    const request = (isHttps ? https : http).get(
      url,
      {
        agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
        headers: {
          Referer: REFERER,
          Origin: ORIGIN,
          "User-Agent": UA,
          Accept: "*/*",
        },
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
  if (/\.m3u8?$/.test(pathname)) return '/api/playlist.m3u8';
  if (/\.(vtt|webvtt)$/.test(pathname)) return '/api/subtitle.vtt';
  if (/\.(key|bin)$/.test(pathname)) return '/api/key.bin';
  return '/api/segment.ts';
}

function toProxiedUrl(value, playlistUrl, origin = "") {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return value;
  const absoluteUrl = new URL(value, playlistUrl).href;
  const proxiedPath =
    proxiedPathForUrl(absoluteUrl) + '?url=' + encodeURIComponent(absoluteUrl);
  return origin ? new URL(proxiedPath, origin).href : proxiedPath;
}

function rewriteM3u8(body, url, origin = "") {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, function(_, uri) {
        return 'URI="' + toProxiedUrl(uri, url, origin) + '"';
      });
    }
    return toProxiedUrl(t, url, origin);
  }).join('\n');
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
  // debugger;
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
    console.log("Proxying URL", url);
    try {
      const upstream = await fetchUpstreamWithRetry(url);
      const ct = (upstream.headers["content-type"] || "").toLowerCase();
      const isM3u8 =
        ct.includes("mpegurl") ||
        ct.includes("m3u8") ||
        /\.m3u8?(\?|$)/i.test(url.split("?")[0]);
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

      return {
        statusCode: upstream.statusCode || 200,
        headers: {
          ...headers,
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
