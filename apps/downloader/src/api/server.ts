import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import { config } from "../infra/config/index.ts";
import { createLogger } from "../infra/logging/logger.ts";
import { database } from "../infra/db/database.ts";
import { resolveVariants } from "../integrations/vidlink/client.ts";
import {
  fetchSegmentBody,
  fetchUpstream,
  readUpstreamBody,
} from "../infra/http/fetch.ts";
import { fileSize, getDiskSpace } from "../infra/files/disk.ts";
import type { DownloadRequest } from "../shared/types.ts";

const log = createLogger("api");
const fileHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const fileHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

type IdParams = { id: string };
type ActionParams = { id: string; action: "pause" | "resume" | "cancel" };
type OptionsQuery = { id?: string; s?: string; e?: string };
type ListJobsQuery = { includeDeleted?: string; limit?: string };
type ProxyQuery = { url?: string };

function proxyPathForUrl(rawUrl: string): string {
  const pathname = new URL(rawUrl).pathname.toLowerCase();
  return /\.m3u8?(\?|$)/i.test(pathname)
    ? "/proxy/playlist.m3u8"
    : "/proxy/segment";
}

function toProxyUrl(value: string, playlistUrl: string): string {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value))
    return value;
  const absolute = new URL(value, playlistUrl).href;
  const proxyUrl = new URL(proxyPathForUrl(absolute), config.apiBaseUrl);
  proxyUrl.searchParams.set("url", absolute);
  return proxyUrl.href;
}

function rewritePlaylist(body: string, url: string): string {
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_, uri: string) => `URI="${toProxyUrl(uri, url)}"`,
        );
      }
      return toProxyUrl(trimmed, url);
    })
    .join("\n");
}

function errorPayload(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

function fileProxyHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": String(
      upstreamHeaders["content-type"] || "application/octet-stream",
    ),
    "Accept-Ranges": String(upstreamHeaders["accept-ranges"] || "bytes"),
  };
  [
    "content-length",
    "content-range",
    "cache-control",
    "etag",
    "last-modified",
  ].forEach((name) => {
    const value = upstreamHeaders[name];
    if (typeof value === "string") headers[name] = value;
  });
  return headers;
}

function fetchRawFileUpstream(
  rawUrl: string,
  range: string | undefined,
  redirects = 0,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("too many redirects"));
      return;
    }
    const requestUrl = new URL(rawUrl);
    const isHttps = requestUrl.protocol === "https:";
    const headers: Record<string, string> = {
      Accept: "*/*",
      "Accept-Encoding": "identity",
      Referer: config.referer,
      "User-Agent": config.userAgent,
    };
    if (range) headers.Range = range;

    const request = (isHttps ? https : http).get(
      requestUrl,
      {
        agent: isHttps ? fileHttpsAgent : fileHttpAgent,
        headers,
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
          resolve(fetchRawFileUpstream(location, range, redirects + 1));
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

function jobNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "job not found" });
}

async function createDownload(
  body: DownloadRequest,
): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  if (!body.id) {
    return { statusCode: 400, payload: { error: "missing id" } };
  }
  let playlistUrl = body.playlistUrl || "";
  let subtitles = body.subtitles || [];
  let label = body.label || "default stream";
  if (!playlistUrl) {
    const resolved = await resolveVariants(body.id, body.s, body.e);
    const chosen = resolved.variants[0];
    playlistUrl = chosen.url;
    label = chosen.label;
    subtitles = resolved.subtitles || [];
  }
  const payload: DownloadRequest = { ...body, playlistUrl, subtitles, label };
  const existingActive = database.findJobForPayload(payload, false);
  if (existingActive) {
    return {
      statusCode: 202,
      payload: { job: database.serializeJob(existingActive) },
    };
  }
  const existingAny = database.findJobForPayload(payload, true);
  if (
    existingAny &&
    (existingAny.status === "completed" ||
      existingAny.status === "completed_with_warnings")
  ) {
    try {
      await fsp.stat(existingAny.finalFilePath || existingAny.stagingPath);
      return {
        statusCode: 200,
        payload: { job: database.serializeJob(existingAny) },
      };
    } catch (_) {
      // Stale metadata; fall through to a new job.
    }
  }
  const job = database.createJob(payload, playlistUrl, label);
  return { statusCode: 202, payload: { job: database.serializeJob(job) } };
}

async function cleanupPreview(): Promise<{
  items: Array<Record<string, unknown>>;
  reclaimableBytes: number;
}> {
  const items: Array<Record<string, unknown>> = [];
  for (const job of database.listJobs(500)) {
    let warnings: unknown[] = [];
    try {
      const parsed = JSON.parse(job.warningsJson || "[]");
      warnings = Array.isArray(parsed) ? parsed : [];
    } catch (_) {}
    if (
      job.sourceFilePath &&
      job.finalFilePath &&
      job.finalFileKind !== "ts" &&
      warnings.length === 0
    ) {
      try {
        const size = await fileSize(job.sourceFilePath);
        items.push({
          type: "source_ts",
          jobId: job.id,
          path: job.sourceFilePath,
          size,
        });
      } catch (_) {}
    }
    if (
      (job.status === "completed" ||
        job.status === "completed_with_warnings" ||
        job.status === "failed_terminal") &&
      job.stagingPath
    ) {
      try {
        const size = await fileSize(job.stagingPath);
        items.push({
          type: "staging_part",
          jobId: job.id,
          path: job.stagingPath,
          size,
        });
      } catch (_) {}
    }
  }
  const reclaimableBytes = items.reduce(
    (sum, item) => sum + Number(item.size || 0),
    0,
  );
  return { items, reclaimableBytes };
}

async function applyCleanup(): Promise<{
  deleted: Array<Record<string, unknown>>;
  reclaimedBytes: number;
}> {
  const preview = await cleanupPreview();
  const deleted: Array<Record<string, unknown>> = [];
  for (const item of preview.items) {
    const filePath = String(item.path || "");
    if (!filePath) continue;
    await fsp
      .unlink(filePath)
      .then(() => {
        deleted.push(item);
        if (item.type === "source_ts") {
          const job = database.getJob(String(item.jobId));
          if (job && job.sourceFilePath === filePath) {
            job.sourceFilePath = "";
            database.insertOrReplaceJob(job);
          }
        }
      })
      .catch(() => {});
  }
  return {
    deleted,
    reclaimedBytes: deleted.reduce(
      (sum, item) => sum + Number(item.size || 0),
      0,
    ),
  };
}

function registerRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    const disk = await getDiskSpace(config.plexWatchDir);
    return {
      ok: disk.availableBytes >= config.minFreeSpaceBytes,
      db: true,
      jobs: database.listJobs(1).length >= 0,
      disk: {
        availableBytes: disk.availableBytes,
        minFreeSpaceBytes: config.minFreeSpaceBytes,
      },
    };
  });

  app.get("/metrics", async () => {
    const disk = await getDiskSpace(config.plexWatchDir);
    return {
      ...database.getMetrics(),
      disk_available_bytes: disk.availableBytes,
      disk_total_bytes: disk.totalBytes,
      disk_min_free_space_bytes: config.minFreeSpaceBytes,
    };
  });

  app.get<{ Querystring: OptionsQuery }>("/options", async (request, reply) => {
    const { id, s = "", e = "" } = request.query;
    if (!id) return reply.code(400).send({ error: "missing id" });
    return resolveVariants(id, s, e);
  });

  app.get<{ Querystring: ProxyQuery }>(
    "/proxy/segment",
    async (request, reply) => {
      const rawUrl = request.query.url;
      if (!rawUrl) return reply.code(400).send({ error: "missing url" });
      try {
        const segment = await fetchSegmentBody(rawUrl);
        return reply
          .header("Content-Type", segment.contentType)
          .header("Content-Length", segment.body.length)
          .send(segment.body);
      } catch (err) {
        return reply.code(502).send(errorPayload(err));
      }
    },
  );

  app.get<{ Querystring: ProxyQuery }>(
    "/proxy/file",
    async (request, reply) => {
      const rawUrl = request.query.url;
      if (!rawUrl) return reply.code(400).send({ error: "missing url" });
      try {
        const range =
          typeof request.headers.range === "string"
            ? request.headers.range
            : undefined;
        const upstream = await fetchRawFileUpstream(rawUrl, range);
        reply.hijack();
        reply.raw.writeHead(
          upstream.statusCode || 200,
          fileProxyHeaders(upstream.headers),
        );
        request.raw.on("close", () => upstream.destroy());
        upstream.pipe(reply.raw);
      } catch (err) {
        if (!reply.sent) return reply.code(502).send(errorPayload(err));
      }
    },
  );

  app.get<{ Querystring: ProxyQuery }>(
    "/proxy/playlist.m3u8",
    async (request, reply) => {
      const rawUrl = request.query.url;
      if (!rawUrl) return reply.code(400).send({ error: "missing url" });
      try {
        const upstream = await fetchUpstream(rawUrl);
        const contentType = String(
          upstream.headers["content-type"] || "",
        ).toLowerCase();
        const isM3u8 =
          contentType.includes("mpegurl") || contentType.includes("m3u8");
        const body = await readUpstreamBody(upstream);
        if (!isM3u8) {
          return reply
            .code(upstream.statusCode || 200)
            .header("Content-Type", contentType || "application/octet-stream")
            .header("Content-Length", body.length)
            .send(body);
        }
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .send(rewritePlaylist(body.toString("utf8"), rawUrl));
      } catch (err) {
        return reply.code(502).send(errorPayload(err));
      }
    },
  );

  app.post<{ Body: DownloadRequest }>("/downloads", async (request, reply) => {
    const result = await createDownload(
      request.body || ({} as DownloadRequest),
    );
    return reply.code(result.statusCode).send(result.payload);
  });

  app.get<{ Querystring: ListJobsQuery }>("/downloads", async (request) => {
    const includeDeleted =
      request.query.includeDeleted === "1" ||
      request.query.includeDeleted === "true";
    const limit = Number(request.query.limit || 50);
    return {
      jobs: database
        .listJobs(Number.isFinite(limit) ? limit : 50, includeDeleted)
        .map((job) => database.serializeJob(job)),
    };
  });

  app.get("/optimizations", async () => ({
    optimizations: database.listOptimizationJobs(),
  }));

  app.get("/cleanup/preview", async () => cleanupPreview());

  app.post("/cleanup/apply", async () => applyCleanup());

  app.get<{ Params: IdParams }>("/downloads/:id", async (request, reply) => {
    const job = database.getJob(request.params.id);
    if (!job) return jobNotFound(reply);
    return { job: database.serializeJob(job) };
  });

  app.get<{ Params: IdParams }>(
    "/downloads/:id/file",
    async (request, reply) => {
      const job = database.getJob(request.params.id);
      if (!job) return jobNotFound(reply);
      if (
        job.status !== "completed" &&
        job.status !== "completed_with_warnings"
      ) {
        return reply.code(409).send({ error: "file is not ready yet" });
      }
      const filePath = job.finalFilePath || job.stagingPath;
      try {
        const stat = await fsp.stat(filePath);
        const contentType =
          job.finalFileKind === "mp4"
            ? "video/mp4"
            : job.finalFileKind === "mkv"
              ? "video/x-matroska"
              : "video/mp2t";
        return reply
          .header("Content-Type", contentType)
          .header("Content-Length", stat.size)
          .header(
            "Content-Disposition",
            `attachment; filename="${job.fileBasename}"`,
          )
          .send(fs.createReadStream(filePath));
      } catch (err) {
        return reply.code(404).send(errorPayload(err));
      }
    },
  );

  app.post<{ Params: IdParams; Body: Record<string, unknown> }>(
    "/downloads/:id/soft-delete",
    async (request, reply) => {
      const job = database.getJob(request.params.id);
      if (!job) return jobNotFound(reply);
      if (
        ["running", "resolving", "validating", "promoting"].includes(job.status)
      ) {
        return reply.code(409).send({
          error: "job is active; pause or cancel it before soft deleting",
        });
      }
      const reason = String(request.body?.reason || "soft deleted");
      const next = database.softDeleteJob(request.params.id, reason);
      if (!next) return jobNotFound(reply);
      return { job: database.serializeJob(next) };
    },
  );

  app.post<{ Params: IdParams; Body: Record<string, unknown> }>(
    "/downloads/:id/optimize",
    async (request, reply) => {
      const job = database.getJob(request.params.id);
      if (!job) return jobNotFound(reply);
      if (
        job.status !== "completed" &&
        job.status !== "completed_with_warnings"
      ) {
        return reply.code(409).send({ error: "job is not complete" });
      }
      if (!job.finalFilePath) {
        return reply.code(409).send({ error: "job has no final file" });
      }
      const body = request.body || {};
      const record = database.createOptimizationJob(job, {
        codec: body.codec || config.optimizerCodec,
        crf: body.crf || config.optimizerCrf,
        preset: body.preset || config.optimizerPreset,
        audioMode: body.audioMode || config.optimizerAudioMode,
        audioBitrate: body.audioBitrate || config.optimizerAudioBitrate,
      });
      return reply.code(202).send({ optimization: record });
    },
  );

  app.post<{ Params: ActionParams }>(
    "/downloads/:id/:action",
    async (request, reply) => {
      const { id, action } = request.params;
      if (action !== "pause" && action !== "resume" && action !== "cancel") {
        return reply.code(404).send({ error: "not found" });
      }
      const job = database.getJob(id);
      if (!job) return jobNotFound(reply);
      if (action === "pause") {
        const next = database.updateJobStatus(
          job.id,
          "paused",
          "Paused by user",
          job,
          "job.stalled",
        );
        return { job: database.serializeJob(next) };
      }
      if (action === "resume") {
        const next = database.updateJobStatus(
          job.id,
          "queued",
          "Resume requested",
          {
            ...job,
            nextRetryAt: 0,
            stalledAt: 0,
          },
          "job.resumed",
        );
        return { job: database.serializeJob(next) };
      }
      const next = database.updateJobStatus(
        job.id,
        "failed_terminal",
        "Cancelled by user",
        job,
        "job.failed_terminal",
      );
      return { job: database.serializeJob(next) };
    },
  );

  app.post("/queue-download", async (request, reply) => {
    const disk = await getDiskSpace(config.plexWatchDir);
    console.log("Queue download requested", request.body);
  });
}

export function startApiServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  void app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range"],
    exposedHeaders: [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
    ],
  });

  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const statusCode =
      err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    log.error("downloader api request failed", {
      message: err.message,
      statusCode,
    });
    reply.code(statusCode).send({ error: err.message });
  });

  registerRoutes(app);

  void app
    .listen({ port: config.apiPort, host: config.apiHost })
    .then(() => {
      log.info("downloader api listening", {
        host: config.apiHost,
        port: config.apiPort,
        baseUrl: config.apiBaseUrl,
      });
    })
    .catch((err) => {
      log.error("downloader api listen failed", {
        message: err instanceof Error ? err.message : String(err),
        host: config.apiHost,
        port: config.apiPort,
      });
    });

  return app;
}
