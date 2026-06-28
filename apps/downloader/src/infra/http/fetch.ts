import http from "node:http";
import https from "node:https";
import type { Writable } from "node:stream";
import { config } from "../config/index.ts";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export const FILE_RANGE_CHUNK_SIZE = 8 * 1024 * 1024;

export function normalizedRangeHeader(
  rangeHeader: string | undefined,
  shouldClamp: boolean,
): string | undefined {
  if (!rangeHeader) return undefined;
  if (!shouldClamp) return rangeHeader;
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

export function parseByteRange(
  rangeHeader: string,
): { start: number; end: number } | null {
  const match = String(rangeHeader).match(/^bytes=(\d+)-(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start
  ) {
    return null;
  }
  return { start, end };
}

export function rangeBodyLength(rangeHeader: string): number {
  const parsed = parseByteRange(rangeHeader);
  return parsed ? parsed.end - parsed.start + 1 : FILE_RANGE_CHUNK_SIZE;
}

export function pipeUpstreamWithByteLimit(
  upstream: http.IncomingMessage,
  dest: Writable,
  maxBytes: number,
): void {
  let sent = 0;
  const finish = () => {
    if (!dest.writableEnded) dest.end();
  };
  upstream.on("data", (chunk: Buffer | string) => {
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

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  return /timed out|aborted|socket hang up|econnreset|epipe|network/i.test(
    message,
  );
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (res.status === 204) return {};
  const body = await res.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (err) {
    const contentType = String(res.headers.get("content-type") || "");
    throw new Error(
      `Expected JSON from ${url}, got ${contentType || "unknown content type"}`,
    );
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchBuffer(
  url: string,
  init?: RequestInit,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("request timed out")),
    25000,
  );
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchUpstream(
  url: string,
  redirects = 0,
  extraHeaders: Record<string, string> = {},
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("too many redirects"));
      return;
    }

    const parsedUrl = new URL(url);
    const requestHeaders: Record<string, string> = {
      Referer: config.referer,
      Origin: config.origin,
      "User-Agent": config.userAgent,
      Accept: "*/*",
    };

    const headersJson = parsedUrl.searchParams.get("headers");
    if (headersJson) {
      try {
        const fromUrl = JSON.parse(headersJson) as Record<string, unknown>;
        for (const [key, value] of Object.entries(fromUrl)) {
          if (value != null) requestHeaders[key] = String(value);
        }
      } catch (_) {
        // ignore invalid JSON
      }
    }
    Object.assign(requestHeaders, extraHeaders);

    const hostOverride = parsedUrl.searchParams.get("host");
    if (hostOverride) {
      const overrideUrl = new URL(hostOverride);
      overrideUrl.pathname = parsedUrl.pathname;
      overrideUrl.search = parsedUrl.search;
      parsedUrl.href = overrideUrl.href;
      requestHeaders.Host = overrideUrl.host;
    }

    parsedUrl.searchParams.delete("headers");
    parsedUrl.searchParams.delete("host");

    const requestUrl = parsedUrl.href;
    const isHttps = requestUrl.startsWith("https");
    const request = (isHttps ? https : http).get(
      requestUrl,
      {
        agent: isHttps ? httpsAgent : httpAgent,
        headers: requestHeaders,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const location = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, requestUrl).href;
          res.resume();
          resolve(fetchUpstream(location, redirects + 1, extraHeaders));
          return;
        }
        resolve(res);
      },
    );
    request.setTimeout(25000, () =>
      request.destroy(new Error("request timed out")),
    );
    request.on("error", reject);
  });
}
export async function readUpstreamBody(
  res: http.IncomingMessage,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

export async function fetchSegmentUpstream(
  url: string,
  maxAttempts = 3,
): Promise<http.IncomingMessage> {
  let attempt = 0;
  while (true) {
    try {
      return await fetchUpstream(url);
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;
      await wait(750 * Math.pow(2, attempt - 1));
    }
  }
}
