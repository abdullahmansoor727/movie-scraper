"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = Number(process.env.DOWNLOAD_SERVICE_PORT || 5050);
const HOST = process.env.DOWNLOAD_SERVICE_HOST || "127.0.0.1";
const DOWNLOAD_PROXY_PUBLIC_BASE =
  process.env.DOWNLOAD_PROXY_PUBLIC_BASE || `http://${HOST}:${PORT}`;
const RESUME_PREFETCH_WINDOW = Number(
  process.env.DOWNLOAD_RESUME_PREFETCH_WINDOW || 12,
);
const SKIP_SEGMENT_PROBE_COUNT = Number(
  process.env.DOWNLOAD_SKIP_SEGMENT_PROBE_COUNT || 2,
);
const MAX_SKIPPED_SEGMENTS = Number(
  process.env.DOWNLOAD_MAX_SKIPPED_SEGMENTS || 3,
);
const MAX_ACTIVE_DOWNLOADS = Number(process.env.DOWNLOAD_MAX_ACTIVE_JOBS || 4);
const FILE_RANGE_CHUNK_SIZE = 8 * 1024 * 1024;
const FAILURE_RATE_WINDOW = Number(
  process.env.DOWNLOAD_FAILURE_RATE_WINDOW || 20,
);
const FAILURE_RATE_MIN_SAMPLES = Number(
  process.env.DOWNLOAD_FAILURE_RATE_MIN_SAMPLES || 10,
);
const FAILURE_RATE_THRESHOLD = Number(
  process.env.DOWNLOAD_FAILURE_RATE_THRESHOLD || 0.5,
);
const FAILURE_RATE_COOLDOWN = Number(
  process.env.DOWNLOAD_FAILURE_RATE_COOLDOWN || 5,
);
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const JOB_DIR = path.join(DOWNLOAD_DIR, ".jobs");
const TMDB_KEY = "3a73619bbb8fc6d47742d1b5b2b707b5";
const REFERER = "https://vidlink.pro/";
const ORIGIN = "https://vidlink.pro";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124";
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16 });

let bootPromise = null;
const jobs = new Map();
let schedulerPending = false;

function logJob(job, event, details) {
  const prefix = `[download:${job.id.slice(0, 8)}] ${event}`;
  if (details) {
    console.log(prefix, details);
    return;
  }
  console.log(prefix);
}

function logProxy(event, details) {
  const prefix = `[proxy] ${event}`;
  if (details) {
    console.log(prefix, details);
    return;
  }
  console.log(prefix);
}

function summarizeProxyUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const lastPath =
      parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return `${parsed.hostname} ${lastPath}`;
  } catch (_) {
    return rawUrl.slice(0, 120);
  }
}

function describeError(err) {
  if (!err) return "unknown error";
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (typeof err.status !== "undefined") parts.push(`status=${err.status}`);
  if (typeof err.retryAfter !== "undefined" && err.retryAfter)
    parts.push(`retryAfter=${err.retryAfter}`);
  if (err.responseBody) parts.push(`body=${JSON.stringify(err.responseBody)}`);
  if (err.stack) {
    const stackLine = String(err.stack).split("\n")[1];
    if (stackLine) parts.push(`at=${stackLine.trim()}`);
  }
  return parts.join(", ") || String(err);
}

class QueuePauseError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueuePauseError";
  }
}

function corsHeaders(extra) {
  return Object.assign(
    {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    extra || {},
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(
    statusCode,
    corsHeaders({
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    }),
  );
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(
    statusCode,
    corsHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    }),
  );
  res.end(body);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(tail || `ffmpeg exited with code ${code}`));
    });
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new Error(tail || `ffprobe exited with code ${code}`));
    });
  });
}

async function verifyMp4Output(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.size) {
    throw new Error("remuxed mp4 is 0 bytes");
  }
  const probeOutput = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "json",
    filePath,
  ]);
  const data = JSON.parse(probeOutput);
  if (!data.streams || !data.streams.length) {
    throw new Error("remuxed mp4 contains no streams");
  }
  const videoStreams = data.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  if (!videoStreams.length) {
    throw new Error("remuxed mp4 contains no video stream");
  }
  const badVideo = videoStreams.find((stream) =>
    /png|mjpeg|jpeg|webp|gif/i.test(stream.codec_name || ""),
  );
  if (badVideo) {
    throw new Error(
      `remuxed mp4 has unsupported video codec ${badVideo.codec_name}`,
    );
  }
  return stat.size;
}

async function inspectMediaFile(filePath) {
  const probeOutput = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=format_name:stream=codec_type,codec_name",
    "-of",
    "json",
    filePath,
  ]);
  return JSON.parse(probeOutput);
}

function sourceLooksRemuxable(probeData) {
  const formatName =
    (probeData && probeData.format && probeData.format.format_name) || "";
  const streams = (probeData && probeData.streams) || [];
  const videoStreams = streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const badVideo = videoStreams.find((stream) =>
    /png|mjpeg|jpeg|webp|gif/i.test(stream.codec_name || ""),
  );
  if (badVideo) {
    return {
      ok: false,
      reason: `source looks like image sequence (${badVideo.codec_name})`,
    };
  }
  if (/png_pipe|image2/i.test(formatName)) {
    return {
      ok: false,
      reason: `source format ${formatName} is not a remuxable media container`,
    };
  }
  if (!videoStreams.length && !audioStreams.length) {
    return {
      ok: false,
      reason: "source has no audio/video streams",
    };
  }
  return { ok: true, reason: "" };
}

async function ensureStorage() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(JOB_DIR, { recursive: true });
}

async function remuxCompletedFile(job) {
  if (!job.filePath || !/\.ts$/i.test(job.filePath)) return false;
  const sourceProbe = await inspectMediaFile(job.filePath);
  const sourceCheck = sourceLooksRemuxable(sourceProbe);
  if (!sourceCheck.ok) {
    job.note = `${sourceCheck.reason}; kept TS file`;
    logJob(job, "remux-skipped", sourceCheck.reason);
    return false;
  }
  const outputFileName = job.fileName.replace(/\.ts$/i, ".mp4");
  const outputPath = path.join(path.dirname(job.filePath), outputFileName);
  const tempOutputPath = outputPath.replace(/\.mp4$/i, ".partial.mp4");
  await fsp.unlink(tempOutputPath).catch(() => {});
  await fsp.unlink(outputPath).catch(() => {});
  job.note = "Remuxing to MP4...";
  await persistJob(job);
  logJob(job, "remux", `${path.basename(job.filePath)} -> ${outputFileName}`);
  try {
    await runFfmpeg([
      "-y",
      "-fflags",
      "+genpts+discardcorrupt",
      "-err_detect",
      "ignore_err",
      "-i",
      job.filePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-dn",
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      tempOutputPath,
    ]);
    await verifyMp4Output(tempOutputPath);
    await fsp.rename(tempOutputPath, outputPath);
    job.fileName = outputFileName;
    job.filePath = outputPath;
    job.sourceFilePath =
      job.sourceFilePath || job.filePath.replace(/\.mp4$/i, ".ts");
    job.note = "Saved to disk as MP4 (TS kept)";
    logJob(job, "remux", `completed ${outputFileName}`);
    return true;
  } catch (err) {
    await fsp.unlink(tempOutputPath).catch(() => {});
    await fsp.unlink(outputPath).catch(() => {});
    job.note = "MP4 remux failed; kept TS file";
    logJob(job, "remux-failed", err.message);
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function downloadFilename(
  id,
  season,
  episode,
  label,
  hasMap,
  title,
  year,
  episodeTitle,
) {
  const readableBase = season
    ? [
        sanitizeFilenamePart(title || `tv-${id}`),
        `S${String(season).padStart(2, "0")}E${String(episode || "1").padStart(2, "0")}`,
        sanitizeFilenamePart(episodeTitle || ""),
      ]
        .filter(Boolean)
        .join(" - ")
    : [sanitizeFilenamePart(title || `movie-${id}`), year ? `(${year})` : ""]
        .filter(Boolean)
        .join(" ");
  const fallbackBase = season
    ? `tv-${id}-s${season}e${episode || "1"}`
    : `movie-${id}`;
  const base = readableBase || fallbackBase;
  const quality = sanitizeSegment(label);
  return `${base}${quality ? "-" + quality : ""}${hasMap ? ".mp4" : ".ts"}`;
}

async function fetchTmdbMeta(id, season, episode) {
  const type = season ? "tv" : "movie";
  const res = await fetch(
    `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}`,
  );
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

function parseAttributes(value) {
  const attrs = {};
  value.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, key, raw) => {
    attrs[key] = raw.charAt(0) === '"' ? raw.slice(1, -1) : raw;
    return "";
  });
  return attrs;
}

function absoluteUrl(value, base) {
  return new URL(value, base).href;
}

function proxiedPlaylistUrl(rawUrl) {
  const proxyUrl = new URL("/proxy/playlist.m3u8", DOWNLOAD_PROXY_PUBLIC_BASE);
  proxyUrl.searchParams.set("url", rawUrl);
  return proxyUrl.href;
}

function proxyPathForUrl(rawUrl) {
  const pathname = new URL(rawUrl).pathname.toLowerCase();
  return /\.m3u8?(\?|$)/i.test(pathname)
    ? "/proxy/playlist.m3u8"
    : "/proxy/segment";
}

function toDownloadProxyUrl(value, playlistUrl) {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value))
    return value;
  const absolute = new URL(value, playlistUrl).href;
  const proxyUrl = new URL(
    proxyPathForUrl(absolute),
    DOWNLOAD_PROXY_PUBLIC_BASE,
  );
  proxyUrl.searchParams.set("url", absolute);
  return proxyUrl.href;
}

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    let uri = "";
    while (++i < lines.length) {
      uri = lines[i].trim();
      if (uri && !uri.startsWith("#")) break;
    }
    if (!uri) continue;
    const bandwidth = attrs.BANDWIDTH
      ? Math.round(Number(attrs.BANDWIDTH) / 1000) + " kbps"
      : "unknown bitrate";
    const resolution = attrs.RESOLUTION || "auto";
    variants.push({
      url: absoluteUrl(uri, baseUrl),
      label: `${resolution} - ${bandwidth}`,
    });
  }
  return variants;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let hasMap = false;
  const entries = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(trimmed.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        hasMap = true;
        const url = absoluteUrl(attrs.URI, baseUrl);
        items.push(url);
        entries.push({
          type: "map",
          raw: trimmed,
          url: url,
          index: items.length,
        });
      }
      return;
    }
    if (trimmed.startsWith("#")) {
      entries.push({ type: "tag", raw: trimmed });
      return;
    }
    if (!trimmed.startsWith("#")) {
      const url = absoluteUrl(trimmed, baseUrl);
      items.push(url);
      entries.push({
        type: "segment",
        raw: trimmed,
        url: url,
        index: items.length,
      });
    }
  });
  return { items, hasMap, entries };
}

function logPlaylistWindow(job, mediaState, index) {
  if (!mediaState.entries || !mediaState.entries.length) return;
  const targetIndex = Math.max(1, index);
  const numbered = mediaState.entries.filter(
    (entry) => typeof entry.index === "number",
  );
  const targetPos = numbered.findIndex((entry) => entry.index === targetIndex);
  if (targetPos === -1) return;
  const startPos = Math.max(0, targetPos - 6);
  const endPos = Math.min(numbered.length - 1, targetPos + 2);
  const startIndex = numbered[startPos].index;
  const endIndex = numbered[endPos].index;
  const windowLines = [];
  let include = false;
  for (const entry of mediaState.entries) {
    if (typeof entry.index === "number") {
      include = entry.index >= startIndex && entry.index <= endIndex;
    }
    if (include) {
      if (entry.type === "segment" || entry.type === "map") {
        windowLines.push(`${entry.index}: ${entry.raw}`);
      } else {
        windowLines.push(`tag: ${entry.raw}`);
      }
    }
    if (typeof entry.index === "number" && entry.index >= endIndex) {
      include = false;
    }
  }
  logJob(
    job,
    "playlist-window",
    `around segment ${targetIndex}\n${windowLines.join("\n")}`,
  );
}

async function fetchBuffer(url, options) {
  const opts = options || {};
  const job = opts.job;
  const label = opts.label;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("request timed out")),
    25000,
  );
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const trimmedBody = body.trim();
    const err = new Error(
      trimmedBody
        ? `HTTP ${res.status} from proxy: ${trimmedBody}`
        : `HTTP ${res.status} from proxy`,
    );
    err.status = res.status || 500;
    err.retryAfter = Number(res.headers.get("retry-after") || 0) || 0;
    err.responseBody = trimmedBody;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url, options) {
  const buffer = await fetchBuffer(url, options);
  return buffer.toString("utf8");
}

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

function normalizedRangeHeader(rangeHeader, shouldClamp) {
  if (!rangeHeader || !shouldClamp) return rangeHeader;
  const match = String(rangeHeader).match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return rangeHeader;

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return rangeHeader;

  const requestedEnd = match[2]
    ? Number(match[2])
    : start + FILE_RANGE_CHUNK_SIZE - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return rangeHeader;
  }

  const end = Math.min(requestedEnd, start + FILE_RANGE_CHUNK_SIZE - 1);
  return `bytes=${start}-${end}`;
}

function parseByteRange(rangeHeader) {
  const match = String(rangeHeader).match(/^bytes=(\d+)-(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return null;
  }
  return { start, end };
}

function rangeBodyLength(rangeHeader) {
  const parsed = parseByteRange(rangeHeader);
  return parsed ? parsed.end - parsed.start + 1 : FILE_RANGE_CHUNK_SIZE;
}

function pipeUpstreamWithByteLimit(upstream, dest, maxBytes) {
  let sent = 0;
  const finish = () => {
    if (!dest.writableEnded) dest.end();
  };
  upstream.on("data", (chunk) => {
    if (sent >= maxBytes) {
      upstream.destroy();
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const take = Math.min(buf.length, maxBytes - sent);
    if (take > 0) {
      dest.write(take === buf.length ? buf : buf.subarray(0, take));
      sent += take;
    }
    if (sent >= maxBytes) {
      upstream.destroy();
      finish();
    }
  });
  upstream.on("end", finish);
  upstream.on("error", (err) => {
    if (!dest.writableEnded) dest.destroy(err);
  });
}

function upstreamFileRequestHeaders(rawUrl, range) {
  const headers = {
    Referer: REFERER,
    Origin: ORIGIN,
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
  try {
    const embedded = new URL(rawUrl).searchParams.get("headers");
    if (embedded) {
      const parsed = JSON.parse(embedded);
      if (parsed.referer) headers.Referer = parsed.referer;
      if (parsed.origin) headers.Origin = parsed.origin;
    }
  } catch (_) {}
  if (range) headers.Range = range;
  return headers;
}

function buildFileProxyResponse(upstream, requestedRange) {
  const parsed = parseByteRange(requestedRange);
  const headers = fileProxyHeaders(upstream.headers);
  if (!parsed) {
    return { statusCode: upstream.statusCode || 200, headers };
  }
  const chunkLength = rangeBodyLength(requestedRange);
  const total = upstream.headers["content-length"];
  const upstreamStatus = upstream.statusCode || 200;
  if (upstreamStatus === 206 && headers["content-range"]) {
    headers["content-length"] = String(chunkLength);
    return { statusCode: 206, headers };
  }
  headers["content-range"] = total
    ? `bytes ${parsed.start}-${parsed.end}/${total}`
    : `bytes ${parsed.start}-${parsed.end}/*`;
  headers["content-length"] = String(chunkLength);
  return { statusCode: 206, headers };
}

function fileProxyHeaders(upstreamHeaders) {
  const headers = {
    "Content-Type": upstreamHeaders["content-type"] || "application/octet-stream",
    "Accept-Ranges": upstreamHeaders["accept-ranges"] || "bytes",
  };
  [
    "content-length",
    "content-range",
    "cache-control",
    "etag",
    "last-modified",
  ].forEach((name) => {
    if (upstreamHeaders[name]) headers[name] = upstreamHeaders[name];
  });
  return headers;
}

function fetchFileUpstream(url, range, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const isHttps = url.startsWith("https");
    const headers = upstreamFileRequestHeaders(url, range);
    const request = (isHttps ? https : http).get(
      url,
      {
        agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
        headers,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const location = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          resolve(fetchFileUpstream(location, range, redirects + 1));
          return;
        }
        resolve(res);
      },
    );
    request.setTimeout(30000, () =>
      request.destroy(new Error("request timed out")),
    );
    request.on("error", reject);
  });
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
          const location = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          resolve(fetchUpstream(location, redirects + 1));
          return;
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

function readUpstreamBody(upstream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    upstream.on("data", (chunk) => {
      chunks.push(chunk);
    });
    upstream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    upstream.on("error", reject);
  });
}

function rewriteDownloadPlaylist(body, url) {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, function (_, uri) {
          return 'URI="' + toDownloadProxyUrl(uri, url) + '"';
        });
      }
      return toDownloadProxyUrl(trimmed, url);
    })
    .join("\n");
}

async function bootWasm() {
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

    eval(fs.readFileSync(path.join(__dirname, "script.js"), "utf8"));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, "fu.wasm"));
    const { instance } = await WebAssembly.instantiate(
      wasmBuf,
      go.importObject,
    );
    go.run(instance);

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (typeof globalThis.getAdv !== "function")
      throw new Error("getAdv not found after WASM boot");
  })();
  return bootPromise;
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
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
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

function normalizeQualities(qualities) {
  if (Array.isArray(qualities)) {
    return qualities.map((value, idx) => ({ key: String(idx), value }));
  }
  const rec = asRecord(qualities);
  if (!rec) return [];
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
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

function extractPlaylist(data) {
  const root = asRecord(data);
  if (!root) return null;
  const dataNode = asRecord(root.data);
  const streamNode = (dataNode && dataNode.stream) || root.stream;
  return (
    pickFromStream(streamNode) ||
    deepFindUrl(dataNode, 4) ||
    deepFindUrl(root, 4)
  );
}

async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error("getAdv returned null");

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  console.log("vidlink API response", {
    id,
    season,
    episode,
    data: JSON.stringify(data),
  });
  const playlist = extractPlaylist(data);
  if (!playlist) throw new Error("No playlist in response");
  return playlist;
}

async function resolveVariants(id, season, episode) {
  const streamUrl = await getStream(id, season, episode);
  const rootProxyPlaylistUrl = proxiedPlaylistUrl(streamUrl);
  const playlistText = await fetchText(rootProxyPlaylistUrl);
  const variants = parseMasterPlaylist(playlistText, rootProxyPlaylistUrl);
  return {
    streamUrl: rootProxyPlaylistUrl,
    variants: variants.length
      ? variants
      : [{ url: rootProxyPlaylistUrl, label: "default stream" }],
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    label: job.label,
    title: job.title || "",
    year: job.year || "",
    episodeTitle: job.episodeTitle || "",
    fileName: job.fileName,
    filePath: job.filePath,
    totalSegments: job.totalSegments,
    completedSegments: job.completedSegments,
    bytesWritten: job.bytesWritten,
    totalBytesEstimate: estimateTotalBytes(job),
    currentSegment: job.currentSegment,
    concurrency: job.concurrency,
    maxConcurrency: job.maxConcurrency,
    backoffLevel: job.backoffLevel,
    skippedSegments: job.skippedSegments || [],
    currentSegmentsPerSecond: currentSegmentsPerSecond(job),
    concurrencyInsights: summarizeConcurrencyStats(job),
    note: job.note,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function jobMetaPath(jobId) {
  return path.join(JOB_DIR, `${jobId}.json`);
}

function completedJobMetaPath(jobId) {
  return path.join(JOB_DIR, `${jobId}.completed.json`);
}

function remainingSegments(job) {
  if (!job || !job.totalSegments) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, job.totalSegments - (job.completedSegments || 0));
}

function queueSortValue(job) {
  return {
    unknown: job.totalSegments ? 0 : 1,
    remaining: remainingSegments(job),
    createdAt: job.createdAt || 0,
  };
}

function compareQueuedJobs(a, b) {
  const left = queueSortValue(a);
  const right = queueSortValue(b);
  if (left.unknown !== right.unknown) return left.unknown - right.unknown;
  if (left.remaining !== right.remaining)
    return left.remaining - right.remaining;
  return left.createdAt - right.createdAt;
}

function compareActiveJobsForPause(a, b) {
  const left = queueSortValue(a);
  const right = queueSortValue(b);
  if (left.unknown !== right.unknown) return left.unknown - right.unknown;
  if (left.remaining !== right.remaining)
    return right.remaining - left.remaining;
  return left.createdAt - right.createdAt;
}

function reduceConcurrency(job, floor) {
  const minimum = typeof floor === "number" ? floor : 2;
  const next = Math.max(minimum, job.concurrency - 1);
  setJobConcurrency(job, next);
}

function ensurePerformanceState(job) {
  job.rateSamples = Array.isArray(job.rateSamples) ? job.rateSamples : [];
  job.concurrencyStats =
    job.concurrencyStats && typeof job.concurrencyStats === "object"
      ? job.concurrencyStats
      : {};
  if (!job.currentConcurrencyLevel) {
    job.currentConcurrencyLevel = job.concurrency || 1;
  }
  if (!job.currentConcurrencySince) {
    job.currentConcurrencySince = Date.now();
  }
}

function settleConcurrencyWindow(job, now) {
  ensurePerformanceState(job);
  const ts = now || Date.now();
  const level = job.currentConcurrencyLevel || job.concurrency || 1;
  const stat = job.concurrencyStats[level] || { segments: 0, ms: 0 };
  stat.ms += Math.max(0, ts - (job.currentConcurrencySince || ts));
  job.concurrencyStats[level] = stat;
  job.currentConcurrencySince = ts;
}

function setJobConcurrency(job, next) {
  const value = Math.max(1, next);
  ensurePerformanceState(job);
  if ((job.currentConcurrencyLevel || job.concurrency) === value) {
    job.concurrency = value;
    return false;
  }
  settleConcurrencyWindow(job, Date.now());
  job.currentConcurrencyLevel = value;
  job.currentConcurrencySince = Date.now();
  job.concurrency = value;
  return true;
}

function recordSegmentCompletion(job, completedSegments) {
  ensurePerformanceState(job);
  const now = Date.now();
  job.rateSamples.push({ ts: now, completed: completedSegments });
  if (job.rateSamples.length > 60) {
    job.rateSamples.shift();
  }
  const level = job.currentConcurrencyLevel || job.concurrency || 1;
  const stat = job.concurrencyStats[level] || { segments: 0, ms: 0 };
  stat.segments += 1;
  job.concurrencyStats[level] = stat;
}

function currentSegmentsPerSecond(job) {
  const samples = Array.isArray(job.rateSamples) ? job.rateSamples : [];
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsed = (last.ts - first.ts) / 1000;
  if (elapsed <= 0) return 0;
  return Math.max(0, (last.completed - first.completed) / elapsed);
}

function estimateTotalBytes(job) {
  if (!job) return 0;
  const bytesWritten = Number(job.bytesWritten || 0);
  const completedSegments = Number(job.completedSegments || 0);
  const totalSegments = Number(job.totalSegments || 0);
  if (bytesWritten <= 0 || completedSegments <= 0 || totalSegments <= 0)
    return 0;
  return Math.round((bytesWritten / completedSegments) * totalSegments);
}

function summarizeConcurrencyStats(job) {
  ensurePerformanceState(job);
  const summary = [];
  const now = Date.now();
  const levels = new Set(Object.keys(job.concurrencyStats || {}).map(Number));
  if (job.currentConcurrencyLevel)
    levels.add(Number(job.currentConcurrencyLevel));
  Array.from(levels)
    .sort(function (a, b) {
      return a - b;
    })
    .forEach(function (level) {
      const base = job.concurrencyStats[level] || { segments: 0, ms: 0 };
      let ms = base.ms;
      let segments = base.segments;
      if (Number(level) === Number(job.currentConcurrencyLevel)) {
        ms += Math.max(0, now - (job.currentConcurrencySince || now));
      }
      summary.push({
        concurrency: Number(level),
        segments: segments,
        seconds: ms / 1000,
        segmentsPerSecond: ms > 0 ? segments / (ms / 1000) : 0,
      });
    });
  return summary.filter(function (entry) {
    return entry.seconds > 0 || entry.segments > 0;
  });
}

function recordRecentOutcome(job, ok) {
  job.recentOutcomes = Array.isArray(job.recentOutcomes)
    ? job.recentOutcomes
    : [];
  job.recentFailureCooldown = Math.max(
    0,
    Number(job.recentFailureCooldown || 0) - 1,
  );
  job.recentOutcomes.push(ok ? 1 : 0);
  if (job.recentOutcomes.length > FAILURE_RATE_WINDOW) {
    job.recentOutcomes.shift();
  }
}

function maybeReduceForFailureRate(job, reasonLabel) {
  const outcomes = Array.isArray(job.recentOutcomes) ? job.recentOutcomes : [];
  if (outcomes.length < FAILURE_RATE_MIN_SAMPLES) return false;
  if ((job.recentFailureCooldown || 0) > 0) return false;
  const failures = outcomes.reduce((sum, value) => sum + (value ? 0 : 1), 0);
  const failureRate = failures / outcomes.length;
  if (failureRate <= FAILURE_RATE_THRESHOLD || job.concurrency <= 2)
    return false;
  const previousConcurrency = job.concurrency;
  reduceConcurrency(job, 2);
  if (job.concurrency === previousConcurrency) return false;
  job.recentFailureCooldown = FAILURE_RATE_COOLDOWN;
  job.note = `${reasonLabel}, dropped to x${job.concurrency} after ${(failureRate * 100).toFixed(0)}% recent failures`;
  return { previousConcurrency, failureRate };
}

async function persistJob(job) {
  job.persistChain = (job.persistChain || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      job.updatedAt = Date.now();
      const metaPath = job.metaPath || jobMetaPath(job.id);
      job.metaPath = metaPath;
      const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
      const snapshot = {
        id: job.id,
        status: job.status,
        label: job.label,
        playlistUrl: job.playlistUrl,
        tmdbId: job.tmdbId,
        season: job.season,
        episode: job.episode,
        title: job.title || "",
        year: job.year || "",
        episodeTitle: job.episodeTitle || "",
        totalSegments: job.totalSegments,
        completedSegments: job.completedSegments,
        bytesWritten: job.bytesWritten,
        totalBytesEstimate: estimateTotalBytes(job),
        currentSegment: job.currentSegment,
        fileName: job.fileName,
        filePath: job.filePath,
        error: job.error,
        note: job.note,
        concurrency: job.concurrency,
        maxConcurrency: job.maxConcurrency,
        backoffLevel: job.backoffLevel,
        skippedSegments: job.skippedSegments || [],
        rateSamples: (job.rateSamples || []).slice(-60),
        concurrencyStats: job.concurrencyStats || {},
        currentConcurrencyLevel:
          job.currentConcurrencyLevel || job.concurrency || 1,
        currentConcurrencySince: job.currentConcurrencySince || Date.now(),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
      await fsp.writeFile(tmpPath, JSON.stringify(snapshot, null, 2));
      await fsp.rename(tmpPath, metaPath);
    });
  return job.persistChain;
}

async function finalizeCompletedJob(job) {
  await persistJob(job);
  const currentMetaPath = job.metaPath || jobMetaPath(job.id);
  const completedMetaPath = completedJobMetaPath(job.id);
  if (currentMetaPath !== completedMetaPath) {
    try {
      await fsp.rename(currentMetaPath, completedMetaPath);
      job.metaPath = completedMetaPath;
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
      job.metaPath = completedMetaPath;
    }
  }
}

function requestSchedulerPause(job, reason) {
  if (!job || !job.runnerPromise || job.pauseRequested) return false;
  job.pauseRequested = true;
  job.pauseReason = reason || "Paused by scheduler";
  job.note = job.pauseReason;
  logJob(job, "queue-pause", job.pauseReason);
  persistJob(job).catch(() => {});
  return true;
}

function scheduleDownloads() {
  if (schedulerPending) return;
  schedulerPending = true;
  setImmediate(() => {
    schedulerPending = false;
    const active = Array.from(jobs.values()).filter((job) => job.runnerPromise);
    const queued = Array.from(jobs.values()).filter(
      (job) =>
        !job.runnerPromise &&
        (job.status === "queued" || job.status === "paused"),
    );

    if (active.length >= MAX_ACTIVE_DOWNLOADS && queued.length) {
      const bestQueued = queued.slice().sort(compareQueuedJobs)[0];
      const pausableActive = active
        .filter((job) => !job.pauseRequested && job.totalSegments)
        .sort(compareActiveJobsForPause);
      const worstActive = pausableActive[0];
      if (
        bestQueued &&
        worstActive &&
        bestQueued.totalSegments &&
        remainingSegments(bestQueued) + 25 < remainingSegments(worstActive)
      ) {
        requestSchedulerPause(
          worstActive,
          `Paused by scheduler to let shorter job ${bestQueued.id.slice(0, 8)} finish first`,
        );
      }
    }

    let activeCount = Array.from(jobs.values()).filter(
      (job) => job.runnerPromise,
    ).length;
    const startable = Array.from(jobs.values())
      .filter(
        (job) =>
          !job.runnerPromise &&
          (job.status === "queued" || job.status === "paused"),
      )
      .sort(compareQueuedJobs);

    for (const job of startable) {
      if (activeCount >= MAX_ACTIVE_DOWNLOADS) break;
      activeCount += 1;
      runDownload(job).catch((err) => {
        job.status = "failed";
        job.error = err.message;
        logJob(job, "failed", err.message);
        logJob(job, "failed-error", describeError(err));
        persistJob(job).catch(() => {});
      });
    }
  });
}

function shouldRetry(err) {
  const message = err && err.message ? err.message : "";
  return !!(
    err &&
    (err.status === 429 ||
      err.status === 500 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504 ||
      /timed out|aborted|socket hang up|econnreset|epipe|network/i.test(
        message,
      ) ||
      err.code === "ECONNRESET" ||
      err.code === "EPIPE")
  );
}

function retryDelayFor(err, job, attempt) {
  const baseDelay = Math.min(30000, 1500 * Math.pow(2, attempt || 0));
  const rateLimitedDelay =
    err && err.status === 429 ? Math.max(baseDelay, 8000) : baseDelay;
  const retryAfterDelay = err && err.retryAfter ? err.retryAfter * 1000 : 0;
  return Math.max(rateLimitedDelay, retryAfterDelay);
}

async function refreshVariantPlaylistUrl(job) {
  if (!job.tmdbId) return;
  const data = await resolveVariants(job.tmdbId, job.season, job.episode);
  const match = (data.variants || []).find(
    (variant) => variant.label === job.label,
  );
  const nextUrl = match ? match.url : data.variants[0] && data.variants[0].url;
  if (nextUrl && nextUrl !== job.playlistUrl) {
    job.playlistUrl = nextUrl;
    logJob(
      job,
      "playlist-refresh",
      "refreshed signed variant URL from source lookup",
    );
    await persistJob(job);
  }
}

async function refreshMediaState(job, mediaState, index) {
  await refreshVariantPlaylistUrl(job);
  const mediaText = await fetchText(job.playlistUrl);
  const refreshed = parseMediaPlaylist(mediaText, job.playlistUrl);
  if (!refreshed.items.length)
    throw new Error("No media segments found after playlist refresh");
  if (refreshed.items.length < index) {
    throw new Error(
      `Playlist refresh returned only ${refreshed.items.length} segments for resume index ${index}`,
    );
  }
  mediaState.items = refreshed.items;
  mediaState.total = refreshed.items.length;
  mediaState.hasMap = refreshed.hasMap;
  mediaState.entries = refreshed.entries;
  logJob(
    job,
    "playlist-refresh",
    `refreshed media playlist at segment ${index}; ${refreshed.items.length} segments available`,
  );
  logPlaylistWindow(job, mediaState, index);
}

async function fetchSegmentWithRetry(index, job, mediaState, attempt) {
  const tryNumber = (attempt || 0) + 1;
  const total = mediaState.total;
  job.currentSegment = index;
  await persistJob(job);
  try {
    const buffer = await fetchBuffer(mediaState.items[index - 1], {
      job: null,
      label: `segment ${index}/${total}, try ${tryNumber}`,
    });
    recordRecentOutcome(job, true);
    return buffer;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (shouldRetry(err) && (attempt || 0) < 5) {
      job.status = "backing_off";
      job.backoffLevel = Math.min((job.backoffLevel || 0) + 1, 6);
      recordRecentOutcome(job, false);
      var previousConcurrency = job.concurrency;
      var reduction = null;
      if (err.status === 429) {
        reduction = maybeReduceForFailureRate(job, "Rate limited");
      } else if (
        err.status === 502 ||
        err.status === 503 ||
        err.status === 504 ||
        /aborted|socket hang up|econnreset|epipe|network/i.test(message)
      ) {
        reduction = maybeReduceForFailureRate(job, "Proxy unstable");
      }
      const delay = retryDelayFor(err, job, attempt);
      job.error = `segment ${index} failed (${message}), retrying in ${Math.ceil(delay / 1000)}s`;
      logJob(
        job,
        "retry",
        `segment ${index}/${total}, try ${tryNumber}, reason=${message}, delay=${Math.ceil(delay / 1000)}s, concurrency=${job.concurrency}` +
          (reduction
            ? ` (was x${reduction.previousConcurrency}, recent failure rate ${(reduction.failureRate * 100).toFixed(0)}%)`
            : ""),
      );
      logJob(job, "retry-error", describeError(err));
      if ((attempt || 0) >= 1) {
        try {
          await refreshMediaState(job, mediaState, index);
        } catch (refreshErr) {
          logJob(job, "playlist-refresh-failed", refreshErr.message);
          logJob(job, "playlist-refresh-error", describeError(refreshErr));
        }
      }
      await persistJob(job);
      await new Promise((resolve) => setTimeout(resolve, delay));
      job.status = "running";
      await persistJob(job);
      return fetchSegmentWithRetry(index, job, mediaState, (attempt || 0) + 1);
    }
    throw new Error(
      `segment ${index} failed: ${message} after try ${tryNumber}`,
    );
  }
}

async function prefetchResumeWindow(job, mediaState, resumeIndex) {
  if (resumeIndex <= 1) return;
  const start = Math.max(1, resumeIndex - RESUME_PREFETCH_WINDOW);
  const end = resumeIndex - 1;
  job.prefetchingResumeWindow = true;
  logJob(
    job,
    "resume-prefetch",
    `warming fresh session with segments ${start}-${end} before resuming at ${resumeIndex}`,
  );
  try {
    for (let index = start; index <= end; index++) {
      await fetchSegmentWithRetry(index, job, mediaState, 0);
    }
  } finally {
    job.prefetchingResumeWindow = false;
  }
  logJob(
    job,
    "resume-prefetch",
    `prefetch complete for segments ${start}-${end}`,
  );
}

async function runDownload(job) {
  if (job.runnerPromise) return job.runnerPromise;
  job.runnerPromise = (async () => {
    await ensureStorage();
    job.pauseRequested = false;
    job.pauseReason = "";
    job.error = "";
    logJob(
      job,
      "start",
      `${job.completedSegments ? "resuming" : "starting"} ${job.label}`,
    );
    if (job.completedSegments > 0) {
      await refreshVariantPlaylistUrl(job);
    }
    const mediaText = await fetchText(job.playlistUrl);
    const media = parseMediaPlaylist(mediaText, job.playlistUrl);
    if (!media.items.length) throw new Error("No media segments found");
    const mediaState = {
      items: media.items,
      total: media.items.length,
      hasMap: media.hasMap,
      entries: media.entries,
    };

    job.totalSegments = mediaState.total;
    job.hasMap = mediaState.hasMap;
    job.fileName =
      job.fileName ||
      downloadFilename(
        job.tmdbId,
        job.season,
        job.episode,
        job.label,
        mediaState.hasMap,
        job.title,
        job.year,
        job.episodeTitle,
      );
    job.filePath = job.filePath || path.join(DOWNLOAD_DIR, job.fileName);
    job.status = "running";
    if (job.completedSegments > 0 && !job.resumeWarmupDone) {
      job.note = `Resuming gently from ${job.completedSegments} / ${job.totalSegments} at x1`;
      setJobConcurrency(job, 1);
    } else {
      job.note = job.completedSegments
        ? `Resuming from ${job.completedSegments} / ${job.totalSegments}`
        : "";
      setJobConcurrency(
        job,
        Math.max(2, Math.min(job.concurrency || 3, job.maxConcurrency || 16)),
      );
    }
    job.maxConcurrency = Math.max(job.concurrency, job.maxConcurrency || 16);
    job.backoffLevel = job.backoffLevel || 0;
    await persistJob(job);

    let existingSize = 0;
    try {
      const stat = await fsp.stat(job.filePath);
      existingSize = stat.size;
    } catch (_) {}
    if (existingSize && existingSize < (job.bytesWritten || 0)) {
      throw new Error(
        `partial file is smaller than saved progress (${existingSize} < ${job.bytesWritten})`,
      );
    }
    if (job.completedSegments > 0 && !job.resumeWarmupDone) {
      logPlaylistWindow(job, mediaState, job.completedSegments + 1);
      await prefetchResumeWindow(job, mediaState, job.completedSegments + 1);
      job.note = `Resume prefetch complete, continuing at segment ${job.completedSegments + 1}`;
      job.resumeLiveStarted = true;
      logJob(
        job,
        "resume-continue",
        `starting live write from segment ${job.completedSegments + 1}`,
      );
      await persistJob(job);
    }
    const fileHandle = await fsp.open(
      job.filePath,
      job.completedSegments ? "r+" : "w",
    );
    let nextFetch = job.completedSegments || 0;
    let nextWrite = job.completedSegments || 0;
    let bytesWritten = job.bytesWritten || 0;
    let lastLoggedSegments = nextWrite;
    const pending = new Map();
    const skippedIndexes = new Set(
      (job.skippedSegments || []).map((value) => value - 1),
    );
    let flushChain = Promise.resolve();
    let inFlight = 0;
    let failed = null;
    let resolveDone;
    let rejectDone;
    const donePromise = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    async function flushPending() {
      while (pending.has(nextWrite) || skippedIndexes.has(nextWrite)) {
        if (skippedIndexes.has(nextWrite)) {
          skippedIndexes.delete(nextWrite);
          nextWrite += 1;
          job.completedSegments = nextWrite;
          job.skippedSegments = (job.skippedSegments || []).slice();
          job.note = `Skipped bad segment ${nextWrite}; continuing download`;
          logJob(job, "skip", job.note);
          await persistJob(job);
          continue;
        }
        const buffer = pending.get(nextWrite);
        pending.delete(nextWrite);
        await fileHandle.write(buffer, 0, buffer.length, bytesWritten);
        bytesWritten += buffer.length;
        nextWrite += 1;
        job.completedSegments = nextWrite;
        job.bytesWritten = bytesWritten;
        recordSegmentCompletion(job, nextWrite);
        job.backoffLevel = Math.max(0, (job.backoffLevel || 0) - 1);
        job.successStreak = (job.successStreak || 0) + 1;
        if (
          job.completedSegments > 0 &&
          !job.resumeWarmupDone &&
          job.successStreak >= 8
        ) {
          job.resumeWarmupDone = true;
          job.resumeLiveStarted = false;
          setJobConcurrency(job, Math.max(job.concurrency, 2));
          job.note = `Resume stabilized, stepped up to x${job.concurrency}`;
          logJob(job, "concurrency", job.note);
        }
        if (
          !job.resumeWarmupDone &&
          job.completedSegments > 0 &&
          nextWrite - lastLoggedSegments >= 5
        ) {
          lastLoggedSegments = nextWrite;
          logJob(
            job,
            "progress",
            `${nextWrite}/${media.items.length} segments, ${(bytesWritten / 1024 / 1024).toFixed(1)} MB, x${job.concurrency} (resume warmup)`,
          );
        }
        if (job.concurrency < job.maxConcurrency && job.successStreak >= 96) {
          setJobConcurrency(job, job.concurrency + 1);
          job.successStreak = 0;
          job.note = `Proxy healthy, stepped up to x${job.concurrency}`;
          logJob(job, "concurrency", job.note);
        }
        if (
          nextWrite === media.items.length ||
          nextWrite - lastLoggedSegments >= 25
        ) {
          lastLoggedSegments = nextWrite;
          logJob(
            job,
            "progress",
            `${nextWrite}/${media.items.length} segments, ${(bytesWritten / 1024 / 1024).toFixed(1)} MB, x${job.concurrency}`,
          );
        }
        await persistJob(job);
      }
    }

    async function trySkipFailedSegment(failedZeroIndex, err) {
      const failedOneIndex = failedZeroIndex + 1;
      const skipped = job.skippedSegments || [];
      if (skipped.length >= MAX_SKIPPED_SEGMENTS) return false;
      if (skipped.includes(failedOneIndex)) return false;
      const probeResults = [];
      for (let offset = 1; offset <= SKIP_SEGMENT_PROBE_COUNT; offset++) {
        const probeOneIndex = failedOneIndex + offset;
        if (probeOneIndex > mediaState.total) break;
        try {
          const buffer = await fetchSegmentWithRetry(
            probeOneIndex,
            job,
            mediaState,
            0,
          );
          probeResults.push({ zeroIndex: probeOneIndex - 1, buffer: buffer });
        } catch (probeErr) {
          logJob(
            job,
            "skip-probe-failed",
            `segment ${failedOneIndex} could not be skipped because probe ${probeOneIndex} also failed`,
          );
          logJob(job, "skip-probe-error", describeError(probeErr));
          return false;
        }
      }
      if (!probeResults.length) return false;
      job.skippedSegments = skipped.concat([failedOneIndex]);
      skippedIndexes.add(failedZeroIndex);
      for (const result of probeResults) {
        pending.set(result.zeroIndex, result.buffer);
      }
      job.note = `Skipping poisoned segment ${failedOneIndex} after ${SKIP_SEGMENT_PROBE_COUNT} successful probe(s)`;
      logJob(job, "skip-armed", `${job.note}; original error: ${err.message}`);
      await persistJob(job);
      flushChain = flushChain.then(flushPending);
      await flushChain;
      return true;
    }

    function maybeFinish() {
      if (!failed && job.pauseRequested && inFlight === 0) {
        failed = new QueuePauseError(job.pauseReason || "Paused by scheduler");
      }
      if (failed && inFlight === 0) {
        rejectDone(failed);
        return;
      }
      if (
        !failed &&
        nextWrite >= mediaState.total &&
        inFlight === 0 &&
        pending.size === 0
      ) {
        resolveDone();
        return;
      }
      while (
        !failed &&
        !job.pauseRequested &&
        inFlight < job.concurrency &&
        nextFetch < mediaState.total
      ) {
        const index = nextFetch++;
        inFlight += 1;
        fetchSegmentWithRetry(index + 1, job, mediaState, 0)
          .then((buffer) => {
            pending.set(index, buffer);
            flushChain = flushChain.then(flushPending);
            return flushChain;
          })
          .catch(async (err) => {
            job.successStreak = 0;
            const skipped = await trySkipFailedSegment(index, err);
            if (!skipped) {
              failed = err;
            }
          })
          .finally(() => {
            inFlight -= 1;
            maybeFinish();
          });
      }
    }

    try {
      maybeFinish();
      await donePromise;
      await flushChain;
      await fileHandle.truncate(bytesWritten);
      await fileHandle.close();
      settleConcurrencyWindow(job, Date.now());
      await remuxCompletedFile(job);
      job.status = "completed";
      job.error = "";
      job.note = job.note || "Saved to disk";
      logJob(
        job,
        "completed",
        `${job.fileName} | ${job.completedSegments}/${job.totalSegments} segments | ${(bytesWritten / 1024 / 1024).toFixed(1)} MB`,
      );
      await finalizeCompletedJob(job);
    } catch (err) {
      await flushChain.catch(() => {});
      try {
        await fileHandle.truncate(bytesWritten);
      } catch (_) {}
      await fileHandle.close().catch(() => {});
      settleConcurrencyWindow(job, Date.now());
      if (err instanceof QueuePauseError) {
        job.status = "paused";
        job.error = "";
        job.note = err.message;
      } else {
        job.status = "failed";
        job.error = err.message;
        job.note = "Partial file preserved for resume";
      }
      job.bytesWritten = bytesWritten;
      job.completedSegments = nextWrite;
      if (err instanceof QueuePauseError) {
        logJob(
          job,
          "paused",
          `${err.message} | kept ${job.completedSegments}/${job.totalSegments} segments | ${(bytesWritten / 1024 / 1024).toFixed(1)} MB`,
        );
      } else {
        logJob(
          job,
          "failed",
          `${err.message} | kept ${job.completedSegments}/${job.totalSegments} segments | ${(bytesWritten / 1024 / 1024).toFixed(1)} MB`,
        );
        logJob(job, "failed-error", describeError(err));
      }
      await persistJob(job);
    }
  })();
  try {
    return await job.runnerPromise;
  } finally {
    job.runnerPromise = null;
    scheduleDownloads();
  }
}

function createJob(payload) {
  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    label: payload.label || "default stream",
    playlistUrl: payload.playlistUrl,
    tmdbId: payload.id,
    season: payload.s || "",
    episode: payload.e || "",
    title: payload.title || "",
    year: payload.year || "",
    episodeTitle: payload.episodeTitle || "",
    totalSegments: 0,
    completedSegments: 0,
    bytesWritten: 0,
    currentSegment: 0,
    fileName: "",
    filePath: "",
    concurrency: 2,
    maxConcurrency: 8,
    backoffLevel: 0,
    successStreak: 0,
    resumeWarmupDone: false,
    skippedSegments: [],
    note: "",
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  job.metaPath = jobMetaPath(job.id);
  jobs.set(job.id, job);
  job.note = `Waiting in queue (max ${MAX_ACTIVE_DOWNLOADS} active downloads)`;
  logJob(job, "queued", `${job.label} for tmdb ${job.tmdbId}`);
  persistJob(job).catch(() => {});
  scheduleDownloads();
  return job;
}

function matchingCompletedJob(payload) {
  for (const job of jobs.values()) {
    if (job.tmdbId !== payload.id) continue;
    if ((job.season || "") !== (payload.s || "")) continue;
    if ((job.episode || "") !== (payload.e || "")) continue;
    if ((job.label || "default stream") !== (payload.label || "default stream"))
      continue;
    if (job.status !== "completed") continue;
    return job;
  }
  return null;
}

async function targetFileExistsForPayload(payload) {
  const labels = [payload.label || "default stream"];
  const title = payload.title || "";
  const year = payload.year || "";
  const episodeTitle = payload.episodeTitle || "";
  const candidateNames = [
    ...labels.flatMap((label) => [
      downloadFilename(
        payload.id,
        payload.s,
        payload.e,
        label,
        false,
        title,
        year,
        episodeTitle,
      ),
      downloadFilename(
        payload.id,
        payload.s,
        payload.e,
        label,
        true,
        title,
        year,
        episodeTitle,
      ),
      downloadFilename(payload.id, payload.s, payload.e, label, false),
      downloadFilename(payload.id, payload.s, payload.e, label, true),
    ]),
  ];
  for (const name of Array.from(new Set(candidateNames))) {
    const filePath = path.join(DOWNLOAD_DIR, name);
    try {
      await fsp.stat(filePath);
      return filePath;
    } catch (_) {}
  }
  return "";
}

function findMatchingJob(payload) {
  for (const job of jobs.values()) {
    if (job.tmdbId !== payload.id) continue;
    if ((job.season || "") !== (payload.s || "")) continue;
    if ((job.episode || "") !== (payload.e || "")) continue;
    if ((job.label || "default stream") !== (payload.label || "default stream"))
      continue;
    if (job.status === "completed") continue;
    return job;
  }
  return null;
}

async function removeJobArtifacts(job) {
  if (!job) return;
  jobs.delete(job.id);
  const metaCandidates = [
    job.metaPath,
    jobMetaPath(job.id),
    completedJobMetaPath(job.id),
  ].filter(Boolean);
  for (const metaPath of Array.from(new Set(metaCandidates))) {
    await fsp.unlink(metaPath).catch(() => {});
  }
}

async function materializeCompletedJobFromFile(payload, filePath, existingJob) {
  const stat = await fsp.stat(filePath);
  const now = Date.now();
  const job = existingJob || {
    id: crypto.randomUUID(),
    tmdbId: payload.id,
    season: payload.s || "",
    episode: payload.e || "",
    label: payload.label || "default stream",
    title: payload.title || "",
    year: payload.year || "",
    episodeTitle: payload.episodeTitle || "",
    createdAt: now,
  };
  job.status = "completed";
  job.tmdbId = payload.id;
  job.season = payload.s || "";
  job.episode = payload.e || "";
  job.label = payload.label || "default stream";
  job.title = payload.title || job.title || "";
  job.year = payload.year || job.year || "";
  job.episodeTitle = payload.episodeTitle || job.episodeTitle || "";
  job.filePath = filePath;
  job.fileName = path.basename(filePath);
  job.sourceFilePath = /\.ts$/i.test(filePath)
    ? filePath
    : job.sourceFilePath || "";
  job.totalSegments = Math.max(
    job.totalSegments || 0,
    job.completedSegments || 0,
  );
  job.completedSegments = Math.max(
    job.completedSegments || 0,
    job.totalSegments || 0,
  );
  job.bytesWritten = stat.size;
  job.error = "";
  job.note = "Found completed file on disk";
  job.updatedAt = now;
  job.metaPath = completedJobMetaPath(job.id);
  jobs.set(job.id, job);
  await finalizeCompletedJob(job);
  return job;
}

async function reconcileJobForPayload(payload) {
  const resumableJob = findMatchingJob(payload);
  if (resumableJob) {
    try {
      await fsp.stat(resumableJob.filePath);
      return { completedJob: null, resumableJob };
    } catch (_) {
      await removeJobArtifacts(resumableJob);
    }
  }

  const completedJob = matchingCompletedJob(payload);
  if (completedJob) {
    try {
      await fsp.stat(completedJob.filePath);
      return { completedJob, resumableJob: null };
    } catch (_) {
      await removeJobArtifacts(completedJob);
    }
  }

  const existingFilePath = await targetFileExistsForPayload(payload);
  if (existingFilePath) {
    const recoveredJob = await materializeCompletedJobFromFile(
      payload,
      existingFilePath,
      completedJob || null,
    );
    return { completedJob: recoveredJob, resumableJob: null };
  }
  return { completedJob: null, resumableJob: null };
}

function resumeJob(job, payload) {
  if (
    payload &&
    payload.playlistUrl &&
    payload.playlistUrl !== job.playlistUrl
  ) {
    logJob(job, "playlist-refresh", "updating signed playlist URL for resume");
    job.playlistUrl = payload.playlistUrl;
  }
  if (payload && payload.label) {
    job.label = payload.label;
  }
  if (payload && payload.title) job.title = payload.title;
  if (payload && payload.year) job.year = payload.year;
  if (payload && payload.episodeTitle) job.episodeTitle = payload.episodeTitle;
  if (
    job.status === "running" ||
    job.status === "backing_off" ||
    job.status === "queued"
  ) {
    persistJob(job).catch(() => {});
    logJob(
      job,
      "resume-request",
      `reusing active job at ${job.completedSegments}/${job.totalSegments || "?"}`,
    );
    return job;
  }
  job.status = "queued";
  job.error = "";
  job.note =
    job.completedSegments > 0
      ? `Manual resume requested from ${job.completedSegments} / ${job.totalSegments || "?"}`
      : "Manual restart requested";
  job.successStreak = 0;
  job.resumeWarmupDone = false;
  if (job.completedSegments > 0) {
    job.concurrency = 1;
  }
  logJob(job, "resume-request", job.note);
  persistJob(job).catch(() => {});
  scheduleDownloads();
  return job;
}

async function restoreJobs() {
  await ensureStorage();
  const entries = await fsp.readdir(JOB_DIR).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const metaPath = path.join(JOB_DIR, entry);
    try {
      const job = JSON.parse(await fsp.readFile(metaPath, "utf8"));
      job.metaPath = metaPath;
      job.concurrency = Math.max(2, job.concurrency || 3);
      job.maxConcurrency = Math.max(job.concurrency, job.maxConcurrency || 16);
      job.backoffLevel = job.backoffLevel || 0;
      job.successStreak = 0;
      job.resumeWarmupDone = !!job.resumeWarmupDone;
      job.skippedSegments = Array.isArray(job.skippedSegments)
        ? job.skippedSegments
        : [];
      job.rateSamples = Array.isArray(job.rateSamples) ? job.rateSamples : [];
      job.concurrencyStats =
        job.concurrencyStats && typeof job.concurrencyStats === "object"
          ? job.concurrencyStats
          : {};
      job.currentConcurrencyLevel =
        job.currentConcurrencyLevel || job.concurrency || 1;
      job.currentConcurrencySince = job.currentConcurrencySince || Date.now();
      job.title = job.title || "";
      job.year = job.year || "";
      job.episodeTitle = job.episodeTitle || "";
      job.note = job.note || "";
      job.error = job.status === "completed" ? "" : job.error || "";
      if (job.status === "completed") {
        const candidatePaths = [job.filePath, job.sourceFilePath].filter(
          Boolean,
        );
        let hasExistingFile = false;
        for (const candidatePath of candidatePaths) {
          try {
            await fsp.stat(candidatePath);
            hasExistingFile = true;
            break;
          } catch (_) {}
        }
        if (!hasExistingFile) {
          console.warn(
            `Removing stale completed job metadata for ${job.id} because no output file exists`,
          );
          await fsp.unlink(metaPath).catch(() => {});
          continue;
        }
      }
      jobs.set(job.id, job);
      if (job.status === "completed") {
        logJob(
          job,
          "restore",
          `Recovered completed job ${job.fileName || job.id}`,
        );
        continue;
      }
      if (
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "backing_off" ||
        job.status === "paused" ||
        (job.status === "failed" && job.completedSegments > 0)
      ) {
        job.status = "queued";
        job.note = "Recovered after service restart";
        job.error = "";
        logJob(
          job,
          "restore",
          `${job.note} at ${job.completedSegments}/${job.totalSegments || "?"}`,
        );
        persistJob(job).catch(() => {});
      }
    } catch (err) {
      console.warn("Failed to restore job from", metaPath, err.message);
    }
  }
  scheduleDownloads();
}

async function handleOptions(reqUrl, res) {
  const id = reqUrl.searchParams.get("id");
  const season = reqUrl.searchParams.get("s");
  const episode = reqUrl.searchParams.get("e");
  if (!id) {
    sendJson(res, 400, { error: "missing id" });
    return;
  }
  try {
    const data = await resolveVariants(id, season, episode);
    sendJson(res, 200, data);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleFileProxy(req, reqUrl, res) {
  const rawUrl = reqUrl.searchParams.get("url");
  if (!rawUrl) {
    sendJson(res, 400, { error: "missing url" });
    return;
  }
  try {
    const clientRange = req.headers.range || req.headers.Range;
    const range =
      normalizedRangeHeader(clientRange, true) ||
      `bytes=0-${FILE_RANGE_CHUNK_SIZE - 1}`;
    const upstream = await fetchFileUpstream(rawUrl, range);
    const response = buildFileProxyResponse(upstream, range);
    res.writeHead(response.statusCode, corsHeaders(response.headers));
    req.on("close", () => upstream.destroy());
    pipeUpstreamWithByteLimit(upstream, res, rangeBodyLength(range));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

async function handleDownloadProxy(reqUrl, res) {
  const rawUrl = reqUrl.searchParams.get("url");
  if (!rawUrl) {
    sendJson(res, 400, { error: "missing url" });
    return;
  }
  try {
    const upstream = await fetchUpstreamWithRetry(rawUrl);
    const ct = (upstream.headers["content-type"] || "").toLowerCase();
    const isM3u8 =
      reqUrl.pathname.endsWith(".m3u8") ||
      ct.includes("mpegurl") ||
      ct.includes("m3u8") ||
      /\.m3u8?(\?|$)/i.test(rawUrl.split("?")[0]);
    if (isM3u8) {
      const bodyBuffer = await readUpstreamBody(upstream);
      const rewritten = rewriteDownloadPlaylist(
        bodyBuffer.toString("utf8"),
        rawUrl,
      );
      res.writeHead(
        200,
        corsHeaders({ "Content-Type": "application/vnd.apple.mpegurl" }),
      );
      res.end(rewritten);
      return;
    }

    res.writeHead(
      upstream.statusCode || 200,
      corsHeaders({
        "Content-Type": ct || "application/octet-stream",
        ...(upstream.headers["content-length"]
          ? { "Content-Length": upstream.headers["content-length"] }
          : {}),
      }),
    );
    upstream.pipe(res);
  } catch (err) {
    if (reqUrl.pathname === "/proxy/segment") {
      logProxy("segment-failed", `${summarizeProxyUrl(rawUrl)} :: ${err.message}`);
    }
    sendJson(res, 502, { error: err.message });
  }
}

async function handleCreateDownload(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (!body.id) {
    sendJson(res, 400, { error: "missing id" });
    return;
  }

  try {
    let playlistUrl = body.playlistUrl;
    let label = body.label || "default stream";
    if (!playlistUrl) {
      const data = await resolveVariants(body.id, body.s, body.e);
      playlistUrl = data.variants[0].url;
      label = data.variants[0].label;
    }
    const payload = {
      id: body.id,
      s: body.s,
      e: body.e,
      playlistUrl,
      label,
      title: body.title || "",
      year: body.year || "",
      episodeTitle: body.episodeTitle || "",
    };
    const { completedJob, resumableJob } =
      await reconcileJobForPayload(payload);
    if (completedJob) {
      sendJson(res, 200, { job: serializeJob(completedJob) });
      return;
    }
    const job = resumableJob
      ? resumeJob(resumableJob, payload)
      : createJob(payload);
    sendJson(res, 202, { job: serializeJob(job) });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleJobStatus(reqUrl, res) {
  const match = reqUrl.pathname.match(/^\/downloads\/([^/]+)$/);
  const job = match ? jobs.get(match[1]) : null;
  if (!job) {
    sendJson(res, 404, { error: "job not found" });
    return;
  }
  sendJson(res, 200, { job: serializeJob(job) });
}

async function handleJobFile(reqUrl, res) {
  const match = reqUrl.pathname.match(/^\/downloads\/([^/]+)\/file$/);
  const job = match ? jobs.get(match[1]) : null;
  if (!job || !job.filePath) {
    sendJson(res, 404, { error: "job not found" });
    return;
  }
  if (job.status !== "completed") {
    sendJson(res, 409, { error: "file is not ready yet" });
    return;
  }
  try {
    const stat = await fsp.stat(job.filePath);
    res.writeHead(
      200,
      corsHeaders({
        "Content-Type": job.fileName.endsWith(".mp4")
          ? "video/mp4"
          : "video/mp2t",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${job.fileName}"`,
      }),
    );
    fs.createReadStream(job.filePath).pipe(res);
  } catch (err) {
    sendJson(res, 404, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true, jobs: jobs.size });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/options") {
    await handleOptions(reqUrl, res);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/proxy/file") {
    await handleFileProxy(req, reqUrl, res);
    return;
  }

  if (
    req.method === "GET" &&
    (reqUrl.pathname === "/proxy/playlist.m3u8" ||
      reqUrl.pathname === "/proxy/segment")
  ) {
    await handleDownloadProxy(reqUrl, res);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/downloads") {
    await handleCreateDownload(req, res);
    return;
  }

  if (
    req.method === "GET" &&
    /^\/downloads\/[^/]+\/file$/.test(reqUrl.pathname)
  ) {
    await handleJobFile(reqUrl, res);
    return;
  }

  if (req.method === "GET" && /^\/downloads\/[^/]+$/.test(reqUrl.pathname)) {
    await handleJobStatus(reqUrl, res);
    return;
  }

  sendText(res, 404, "not found");
});

server.listen(PORT, HOST, () => {
  console.log(
    `Download service listening on http://${HOST}:${PORT} via local proxy ${DOWNLOAD_PROXY_PUBLIC_BASE}`,
  );
  restoreJobs().catch((err) => {
    console.error("Failed to restore jobs", err);
  });
});
