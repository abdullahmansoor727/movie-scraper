import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../infra/config/index.ts";
import { fetchJson, fetchText } from "../../infra/http/fetch.ts";
import { parseMasterPlaylist } from "../../domain/media/hls.ts";
import type {
  ResolveVariantsResult,
  SubtitleTrack,
  VariantOption,
} from "../../shared/types.ts";

const localRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
let bootPromise: Promise<void> | null = null;

async function bootWasm(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).self = globalThis;
    globalThis.document = {
      createElement: () => ({}),
      body: { appendChild: () => {} },
    } as unknown as Document;

    const sodium = await import("libsodium-wrappers");
    await sodium.default.ready;
    (
      globalThis as typeof globalThis & { sodium: typeof sodium.default }
    ).sodium = sodium.default;

    const scriptPath = path.join(localRoot, "script.js");
    const wasmPath = path.join(localRoot, "fu.wasm");
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(scriptPath, "utf8"));
    const go = new (
      globalThis as unknown as {
        Dm: new () => {
          importObject: WebAssembly.Imports;
          run: (instance: WebAssembly.Instance) => void;
        };
      }
    ).Dm();
    const wasmBuf = fs.readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(
      wasmBuf,
      go.importObject,
    );
    go.run(instance);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (
      typeof (
        globalThis as typeof globalThis & {
          getAdv?: (value: string) => string | null;
        }
      ).getAdv !== "function"
    ) {
      throw new Error("getAdv not found after WASM boot");
    }
  })();
  return bootPromise;
}

type QualityEntry = { key: string; value: unknown };

type StreamInfo = {
  streamUrl: string;
  subtitles: SubtitleTrack[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function pickUrl(value: unknown): string | null {
  if (typeof value === "string" && isHttpUrl(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const fields = ["url", "src", "file", "playlist", "manifest", "hls"];
  for (const field of fields) {
    const candidate = rec[field];
    if (typeof candidate === "string" && isHttpUrl(candidate)) return candidate;
  }
  return null;
}

function deepFindUrl(
  value: unknown,
  maxDepth = 4,
  seen = new Set<unknown>(),
): string | null {
  if (maxDepth < 0) return null;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return value;
    return null;
  }
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
  const rec = value as Record<string, unknown>;
  const preferredKeys = [
    "playlist",
    "manifest",
    "hls",
    "url",
    "src",
    "file",
    "link",
    "path",
  ];
  for (const key of preferredKeys) {
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

function qualityRank(label: string): number {
  const m = label.match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

function qualityLabel(entry: QualityEntry): string {
  const rec = asRecord(entry.value);
  const raw = String(
    rec?.label ||
      rec?.quality ||
      rec?.name ||
      rec?.title ||
      rec?.resolution ||
      entry.key ||
      "default stream",
  );
  const resolution = raw.match(/(\d{3,4})p?/i) || raw.match(/\d+x(\d{3,4})/i);
  if (resolution) return `${Number(resolution[1])}p`;
  return raw === "default stream" ? raw : `${raw}`;
}

function normalizeQualities(qualities: unknown): QualityEntry[] {
  if (Array.isArray(qualities)) {
    return qualities.map((value, idx) => ({ key: String(idx), value }));
  }
  const rec = asRecord(qualities);
  if (!rec) return [];
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

function pickFromStream(stream: unknown): string | null {
  const rec = asRecord(stream);
  if (!rec) return null;
  const direct = deepFindUrl(rec, 4);
  if (direct) return direct;
  const qualities = normalizeQualities(rec.qualities);
  if (!qualities.length) return null;
  const sorted = qualities
    .map((entry) => ({ ...entry, rank: qualityRank(entry.key) }))
    .sort((a, b) => b.rank - a.rank);
  for (const entry of sorted) {
    const url = deepFindUrl(entry.value, 4);
    if (url) return url;
  }
  return null;
}

function isPlaylistUrl(value: string): boolean {
  try {
    return /\.m3u8(?:$|\?)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function normalizeSubtitleTrack(
  track: unknown,
  baseUrl?: string,
): SubtitleTrack | null {
  const rec = asRecord(track);
  if (!rec) return null;
  const rawUrl = rec.url || rec.file || rec.src || rec.link;
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  const language = String(
    rec.lang || rec.language || rec.srclang || rec.code || "Unknown",
  );
  const label = String(rec.label || rec.name || rec.title || language);
  try {
    return {
      url: new URL(rawUrl, baseUrl || rawUrl).href,
      language,
      label,
    };
  } catch (_) {
    return null;
  }
}

function collectSubtitleTracks(
  value: unknown,
  baseUrl: string | undefined,
  out: SubtitleTrack[],
  seen: Set<string>,
): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeSubtitleTrack(item, baseUrl);
      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        out.push(normalized);
      }
      collectSubtitleTracks(item, baseUrl, out, seen);
    }
    return;
  }
  if (typeof value !== "object") return;

  const direct = normalizeSubtitleTrack(value, baseUrl);
  if (direct && !seen.has(direct.url)) {
    seen.add(direct.url);
    out.push(direct);
  }

  const rec = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(rec)) {
    if (/subtitle|caption|track/i.test(key)) {
      collectSubtitleTracks(nested, baseUrl, out, seen);
    }
  }
}

function extractSubtitleTracks(
  payload: unknown,
  baseUrl?: string,
): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  collectSubtitleTracks(payload, baseUrl, tracks, new Set());
  return tracks;
}

function extractStreamInfoFromVidlinkResponse(
  payload: unknown,
): StreamInfo | null {
  const root = asRecord(payload);
  if (!root) return null;
  const dataNode = asRecord(root.data);
  const streamNode = dataNode?.stream ?? root.stream;
  const fromStream = pickFromStream(streamNode);
  const streamUrl =
    fromStream || deepFindUrl(dataNode, 4) || deepFindUrl(root, 4);
  if (!streamUrl || !isPlaylistUrl(streamUrl)) return null;
  return {
    streamUrl,
    subtitles: extractSubtitleTracks(payload, streamUrl),
  };
}

async function getStream(
  id: string,
  season?: string,
  episode?: string,
): Promise<StreamInfo> {
  await bootWasm();
  const token = (
    globalThis as typeof globalThis & {
      getAdv: (value: string) => string | null;
    }
  ).getAdv(String(id));
  if (!token) throw new Error("getAdv returned null");
  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=1`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;
  const data = await fetchJson(apiUrl, {
    headers: {
      Referer: config.referer,
      Origin: config.origin,
      "User-Agent": config.userAgent,
    },
  });
  const stream = extractStreamInfoFromVidlinkResponse(data);
  if (!stream) {
    throw new Error("No stream in vidlink response");
  }
  return stream;
}

export function proxiedPlaylistUrl(rawUrl: string): string {
  const proxyUrl = new URL("/proxy/playlist.m3u8", config.apiBaseUrl);
  proxyUrl.searchParams.set("url", rawUrl);
  return proxyUrl.href;
}

export function proxiedStreamUrl(rawUrl: string): string {
  const proxyUrl = new URL("/proxy/segment", config.apiBaseUrl);
  proxyUrl.searchParams.set("url", rawUrl);
  return proxyUrl.href;
}

export async function resolveVariants(
  id: string,
  season?: string,
  episode?: string,
): Promise<ResolveVariantsResult> {
  const stream = await getStream(id, season, episode);
  const rootProxyPlaylistUrl = proxiedPlaylistUrl(stream.streamUrl);
  const playlistText = await fetchText(rootProxyPlaylistUrl);
  const variants = parseMasterPlaylist(playlistText, rootProxyPlaylistUrl).map(
    (variant) => ({
      ...variant,
      sourceType: "hls" as const,
    }),
  );
  return {
    streamUrl: rootProxyPlaylistUrl,
    streamType: "hls",
    subtitles: stream.subtitles,
    variants: variants.length
      ? variants
      : [{ url: rootProxyPlaylistUrl, label: "default stream" }],
  };
}
