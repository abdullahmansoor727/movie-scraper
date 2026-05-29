import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "../config/index.ts";
import type {
  DownloadRequest,
  FileKind,
  FinalArtifactClass,
  JobEventType,
  JobRecord,
  JobResponse,
  JobStatus,
  NotificationTarget,
  SubtitleTrack,
} from "../../shared/types.ts";
import { createLogger } from "../logging/logger.ts";

const log = createLogger("db");

function now(): number {
  return Date.now();
}

function parseArray(json: string): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function parseNumberArray(json: string): number[] {
  return parseArray(json)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function parseSubtitles(json: string): SubtitleTrack[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const url = String(row.url || "");
        if (!url) return null;
        return {
          url,
          label: String(row.label || row.language || "Subtitle"),
          language: String(row.language || "Unknown"),
        };
      })
      .filter(Boolean) as SubtitleTrack[];
  } catch (_) {
    return [];
  }
}

export class AppDatabase {
  db: DatabaseSync;

  constructor() {
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(config.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL DEFAULT '',
        tmdb_id TEXT NOT NULL,
        season TEXT NOT NULL DEFAULT '',
        episode TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        year TEXT NOT NULL DEFAULT '',
        episode_title TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT 'default stream',
        playlist_url TEXT NOT NULL DEFAULT '',
        direct_url TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'hls',
        expires_at INTEGER NOT NULL DEFAULT 0,
        subtitles_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        status_reason TEXT NOT NULL DEFAULT '',
        warning_count INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        total_segments INTEGER NOT NULL DEFAULT 0,
        completed_segments INTEGER NOT NULL DEFAULT 0,
        bytes_written INTEGER NOT NULL DEFAULT 0,
        total_bytes_estimate INTEGER NOT NULL DEFAULT 0,
        current_segment INTEGER NOT NULL DEFAULT 0,
        current_concurrency INTEGER NOT NULL DEFAULT 0,
        max_concurrency INTEGER NOT NULL DEFAULT 0,
        backoff_level INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry_count INTEGER NOT NULL DEFAULT 12,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_progress_at INTEGER NOT NULL DEFAULT 0,
        stalled_at INTEGER NOT NULL DEFAULT 0,
        file_basename TEXT NOT NULL DEFAULT '',
        staging_path TEXT NOT NULL DEFAULT '',
        final_file_path TEXT NOT NULL DEFAULT '',
        source_file_path TEXT NOT NULL DEFAULT '',
        final_file_kind TEXT NOT NULL DEFAULT 'unknown',
        final_artifact_class TEXT NOT NULL DEFAULT 'none',
        skipped_segments_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER NOT NULL DEFAULT 0,
        delete_reason TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_lookup ON jobs(tmdb_id, season, episode, label);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_retry_at);

      CREATE TABLE IF NOT EXISTS job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS job_checkpoints (
        job_id TEXT PRIMARY KEY,
        completed_segments INTEGER NOT NULL DEFAULT 0,
        bytes_written INTEGER NOT NULL DEFAULT 0,
        current_segment INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_event_id INTEGER NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_leases (
        worker_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        job_id TEXT NOT NULL DEFAULT '',
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS optimization_jobs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT NOT NULL DEFAULT '',
        profile_json TEXT NOT NULL DEFAULT '{}',
        input_path TEXT NOT NULL,
        output_path TEXT NOT NULL,
        source_size INTEGER NOT NULL DEFAULT 0,
        output_size INTEGER NOT NULL DEFAULT 0,
        progress_percent REAL NOT NULL DEFAULT 0,
        progress_fps REAL NOT NULL DEFAULT 0,
        progress_speed REAL NOT NULL DEFAULT 0,
        eta_seconds INTEGER NOT NULL DEFAULT 0,
        progress_part_bytes INTEGER NOT NULL DEFAULT 0,
        progress_part_bps REAL NOT NULL DEFAULT 0,
        progress_confidence TEXT NOT NULL DEFAULT 'low',
        started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_optimization_status ON optimization_jobs(status, created_at);
    `);
    this.ensureColumn("jobs", "deleted_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "delete_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("jobs", "direct_url", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("jobs", "source_type", "TEXT NOT NULL DEFAULT 'hls'");
    this.ensureColumn("jobs", "expires_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "subtitles_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn(
      "optimization_jobs",
      "progress_percent",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "progress_fps",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "progress_speed",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "eta_seconds",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "progress_part_bytes",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "progress_part_bps",
      "REAL NOT NULL DEFAULT 0",
    );
    this.ensureColumn(
      "optimization_jobs",
      "progress_confidence",
      "TEXT NOT NULL DEFAULT 'low'",
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_deleted ON jobs(deleted_at);`,
    );
  }

  ensureColumn(
    tableName: string,
    columnName: string,
    definition: string,
  ): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<Record<string, unknown>>;
    if (columns.some((column) => String(column.name) === columnName)) return;
    this.db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`,
    );
  }

  mapJob(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row.id),
      requestId: String(row.request_id || ""),
      tmdbId: String(row.tmdb_id),
      season: String(row.season || ""),
      episode: String(row.episode || ""),
      title: String(row.title || ""),
      year: String(row.year || ""),
      episodeTitle: String(row.episode_title || ""),
      label: String(row.label || "default stream"),
      playlistUrl: String(row.playlist_url || ""),
      directUrl: String(row.direct_url || ""),
      sourceType: String(row.source_type || "hls") === "file" ? "file" : "hls",
      expiresAt: Number(row.expires_at || 0),
      subtitlesJson: String(row.subtitles_json || "[]"),
      status: String(row.status) as JobStatus,
      statusReason: String(row.status_reason || ""),
      warningCount: Number(row.warning_count || 0),
      warningsJson: String(row.warnings_json || "[]"),
      totalSegments: Number(row.total_segments || 0),
      completedSegments: Number(row.completed_segments || 0),
      bytesWritten: Number(row.bytes_written || 0),
      totalBytesEstimate: Number(row.total_bytes_estimate || 0),
      currentSegment: Number(row.current_segment || 0),
      currentConcurrency: Number(row.current_concurrency || 0),
      maxConcurrency: Number(row.max_concurrency || 0),
      backoffLevel: Number(row.backoff_level || 0),
      retryCount: Number(row.retry_count || 0),
      maxRetryCount: Number(row.max_retry_count || 0),
      nextRetryAt: Number(row.next_retry_at || 0),
      lastProgressAt: Number(row.last_progress_at || 0),
      stalledAt: Number(row.stalled_at || 0),
      fileBasename: String(row.file_basename || ""),
      stagingPath: String(row.staging_path || ""),
      finalFilePath: String(row.final_file_path || ""),
      sourceFilePath: String(row.source_file_path || ""),
      finalFileKind: String(row.final_file_kind || "unknown") as FileKind,
      finalArtifactClass: String(
        row.final_artifact_class || "none",
      ) as FinalArtifactClass,
      skippedSegmentsJson: String(row.skipped_segments_json || "[]"),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      startedAt: Number(row.started_at || 0),
      completedAt: Number(row.completed_at || 0),
      deletedAt: Number(row.deleted_at || 0),
      deleteReason: String(row.delete_reason || ""),
    };
  }

  serializeJob(job: JobRecord): JobResponse {
    const warnings = parseArray(job.warningsJson);
    const skippedSegments = parseNumberArray(job.skippedSegmentsJson);
    const concurrencyInsights = this.getConcurrencyInsights(job.id);
    const currentRate =
      concurrencyInsights.find(
        (entry) => entry.concurrency === job.currentConcurrency,
      )?.segmentsPerSecond || 0;
    const rateWindowStart = job.startedAt || job.createdAt;
    const rateWindowEnd =
      job.completedAt || job.lastProgressAt || job.updatedAt;
    const elapsedSeconds =
      rateWindowStart && rateWindowEnd > rateWindowStart
        ? (rateWindowEnd - rateWindowStart) / 1000
        : 0;
    const bytesPerSecond =
      elapsedSeconds > 0 ? job.bytesWritten / elapsedSeconds : 0;
    const remainingBytes = Math.max(
      0,
      (job.totalBytesEstimate || 0) - job.bytesWritten,
    );
    const etaSeconds =
      bytesPerSecond > 0 &&
      remainingBytes > 0 &&
      job.status !== "completed" &&
      job.status !== "completed_with_warnings"
        ? remainingBytes / bytesPerSecond
        : 0;
    const pendingRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM notification_deliveries WHERE status IN ('pending', 'retry') AND job_event_id IN (SELECT id FROM job_events WHERE job_id = ?)`,
      )
      .get(job.id) as Record<string, unknown> | undefined;
    const failedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM notification_deliveries WHERE status = 'failed' AND job_event_id IN (SELECT id FROM job_events WHERE job_id = ?)`,
      )
      .get(job.id) as Record<string, unknown> | undefined;
    const notifierPending = Number(pendingRow?.count || 0);
    const notifierFailed = Number(failedRow?.count || 0);
    return {
      id: job.id,
      requestId: job.requestId,
      status: job.status,
      label: job.label,
      title: job.title,
      year: job.year,
      episodeTitle: job.episodeTitle,
      fileName: job.fileBasename,
      filePath: job.finalFilePath || job.stagingPath,
      sourceType: job.sourceType,
      directUrl: job.directUrl,
      expiresAt: job.expiresAt,
      subtitles: parseSubtitles(job.subtitlesJson),
      totalSegments: job.totalSegments,
      completedSegments: job.completedSegments,
      bytesWritten: job.bytesWritten,
      totalBytesEstimate: job.totalBytesEstimate,
      currentSegment: job.currentSegment,
      concurrency: job.currentConcurrency,
      maxConcurrency: job.maxConcurrency,
      backoffLevel: job.backoffLevel,
      skippedSegments,
      warningCount: job.warningCount,
      warnings,
      note: job.statusReason,
      error: job.status === "failed_terminal" ? job.statusReason : "",
      finalArtifactClass: job.finalArtifactClass,
      currentSegmentsPerSecond: currentRate,
      bytesPerSecond,
      etaSeconds,
      concurrencyInsights,
      notifier: { pending: notifierPending, failed: notifierFailed },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      deletedAt: job.deletedAt,
      deleteReason: job.deleteReason,
    };
  }

  createJob(
    payload: DownloadRequest,
    playlistUrl: string,
    label: string,
  ): JobRecord {
    const id = crypto.randomUUID();
    const createdAt = now();
    const job: JobRecord = {
      id,
      requestId: payload.requestId || "",
      tmdbId: payload.id,
      season: payload.s || "",
      episode: payload.e || "",
      title: payload.title || "",
      year: payload.year || "",
      episodeTitle: payload.episodeTitle || "",
      label,
      playlistUrl,
      directUrl: payload.directUrl || "",
      sourceType: payload.sourceType === "file" ? "file" : "hls",
      expiresAt: Number(payload.expiresAt || 0),
      subtitlesJson: JSON.stringify(payload.subtitles || []),
      status: "queued",
      statusReason: "Waiting in queue",
      warningCount: 0,
      warningsJson: "[]",
      totalSegments: 0,
      completedSegments: 0,
      bytesWritten: 0,
      totalBytesEstimate: 0,
      currentSegment: 0,
      currentConcurrency: config.baseConcurrency,
      maxConcurrency: config.maxConcurrency,
      backoffLevel: 0,
      retryCount: 0,
      maxRetryCount: config.maxRetryCount,
      nextRetryAt: 0,
      lastProgressAt: createdAt,
      stalledAt: 0,
      fileBasename: "",
      stagingPath: "",
      finalFilePath: "",
      sourceFilePath: "",
      finalFileKind: "unknown",
      finalArtifactClass: "none",
      skippedSegmentsJson: "[]",
      createdAt,
      updatedAt: createdAt,
      startedAt: 0,
      completedAt: 0,
      deletedAt: 0,
      deleteReason: "",
    };
    this.insertOrReplaceJob(job);
    this.recordJobEvent(job.id, "job.created", {
      status: job.status,
      reason: job.statusReason,
    });
    return job;
  }

  insertOrReplaceJob(job: JobRecord): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO jobs (
        id, request_id, tmdb_id, season, episode, title, year, episode_title, label, playlist_url, direct_url, source_type,
        expires_at, subtitles_json, status, status_reason,
        warning_count, warnings_json, total_segments, completed_segments, bytes_written, total_bytes_estimate, current_segment,
        current_concurrency, max_concurrency, backoff_level, retry_count, max_retry_count, next_retry_at, last_progress_at,
        stalled_at, file_basename, staging_path, final_file_path, source_file_path, final_file_kind, final_artifact_class,
        skipped_segments_json, created_at, updated_at, started_at, completed_at, deleted_at, delete_reason
      ) VALUES (
        @id, @requestId, @tmdbId, @season, @episode, @title, @year, @episodeTitle, @label, @playlistUrl, @directUrl, @sourceType,
        @expiresAt, @subtitlesJson, @status, @statusReason,
        @warningCount, @warningsJson, @totalSegments, @completedSegments, @bytesWritten, @totalBytesEstimate, @currentSegment,
        @currentConcurrency, @maxConcurrency, @backoffLevel, @retryCount, @maxRetryCount, @nextRetryAt, @lastProgressAt,
        @stalledAt, @fileBasename, @stagingPath, @finalFilePath, @sourceFilePath, @finalFileKind, @finalArtifactClass,
        @skippedSegmentsJson, @createdAt, @updatedAt, @startedAt, @completedAt, @deletedAt, @deleteReason
      )
    `,
      )
      .run(job as unknown as Record<string, SQLInputValue>);
  }

  recordJobEvent(
    jobId: string,
    eventType: JobEventType,
    payload: Record<string, unknown>,
  ): void {
    const createdAt = now();
    const result = this.db
      .prepare(
        `INSERT INTO job_events (job_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(jobId, eventType, JSON.stringify(payload || {}), createdAt);
    const eventId = Number(result.lastInsertRowid);
    const targets: NotificationTarget[] = [];
    if (config.overseerrWebhookUrl) targets.push("overseerr");
    if (
      (config.plexWebhookUrl ||
        config.plexRefreshUrl ||
        (config.plexUrl && config.plexToken && config.plexLibrarySectionId)) &&
      (eventType === "job.completed" ||
        eventType === "job.completed_with_warnings")
    ) {
      targets.push("plex");
    }
    for (const target of targets) {
      this.db
        .prepare(
          `
        INSERT INTO notification_deliveries (job_event_id, target, status, attempts, last_error, next_attempt_at, delivered_at, payload_json, updated_at)
        VALUES (?, ?, 'pending', 0, '', 0, 0, ?, ?)
      `,
        )
        .run(eventId, target, JSON.stringify(payload || {}), createdAt);
    }
  }

  listJobs(limit = 50, includeDeleted = false): JobRecord[] {
    const sql = includeDeleted
      ? `SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?`
      : `SELECT * FROM jobs WHERE deleted_at = 0 ORDER BY updated_at DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(limit)
      .map((row) => this.mapJob(row as Record<string, unknown>));
  }

  listAllJobs(includeDeleted = false): JobRecord[] {
    const sql = includeDeleted
      ? `SELECT * FROM jobs ORDER BY updated_at DESC`
      : `SELECT * FROM jobs WHERE deleted_at = 0 ORDER BY updated_at DESC`;
    return this.db
      .prepare(sql)
      .all()
      .map((row) => this.mapJob(row as Record<string, unknown>));
  }

  getJob(id: string): JobRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ? AND deleted_at = 0`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapJob(row) : null;
  }

  getJobIncludingDeleted(id: string): JobRecord | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapJob(row) : null;
  }

  findJobForPayload(
    payload: DownloadRequest,
    includeCompleted = true,
  ): JobRecord | null {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM jobs
      WHERE tmdb_id = ? AND season = ? AND episode = ? AND label = ?
        AND deleted_at = 0
      ORDER BY created_at DESC
    `,
      )
      .all(
        payload.id,
        payload.s || "",
        payload.e || "",
        payload.label || "default stream",
      ) as Record<string, unknown>[];
    for (const row of rows) {
      const job = this.mapJob(row);
      if (
        !includeCompleted &&
        (job.status === "completed" || job.status === "completed_with_warnings")
      )
        continue;
      return job;
    }
    return null;
  }

  updateJobStatus(
    jobId: string,
    status: JobStatus,
    reason: string,
    patch?: Partial<JobRecord>,
    eventType?: JobEventType,
  ): JobRecord {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    const next: JobRecord = {
      ...job,
      ...patch,
      status,
      statusReason: reason,
      updatedAt: now(),
    };
    if (status === "running" && !next.startedAt)
      next.startedAt = next.updatedAt;
    if (
      status === "completed" ||
      status === "completed_with_warnings" ||
      status === "failed_terminal"
    ) {
      next.completedAt = next.updatedAt;
    }
    this.insertOrReplaceJob(next);
    if (eventType) {
      this.recordJobEvent(jobId, eventType, {
        status,
        reason,
        completedSegments: next.completedSegments,
        totalSegments: next.totalSegments,
        bytesWritten: next.bytesWritten,
        filePath: next.finalFilePath || next.stagingPath,
      });
    }
    return next;
  }

  softDeleteJob(jobId: string, reason: string): JobRecord | null {
    const job = this.getJob(jobId);
    if (!job) return null;
    const next: JobRecord = {
      ...job,
      deletedAt: now(),
      deleteReason: reason,
      updatedAt: now(),
    };
    this.insertOrReplaceJob(next);
    this.recordJobEvent(jobId, "job.stalled", {
      status: job.status,
      reason: `soft deleted: ${reason}`,
    });
    return next;
  }

  importHistoricalJob(
    record: Record<string, unknown>,
    source = "legacy .jobs json",
  ): JobRecord {
    const id = String(record.id || crypto.randomUUID());
    const createdAt = Number(record.createdAt || record.updatedAt || now());
    const updatedAt = Number(record.updatedAt || createdAt);
    const skipped = Array.isArray(record.skippedSegments)
      ? record.skippedSegments
      : [];
    const note = String(record.note || "");
    const warnings = [
      ...skipped.map((segment) => `Skipped poisoned segment ${segment}`),
      ...(note && !/^saved/i.test(note) ? [note] : []),
    ];
    const finalPath = String(record.filePath || "");
    const finalKind = /\.mkv$/i.test(finalPath)
      ? "mkv"
      : /\.mp4$/i.test(finalPath)
        ? "mp4"
        : /\.ts$/i.test(finalPath)
          ? "ts"
          : "unknown";
    const job: JobRecord = {
      id,
      requestId: "legacy-import",
      tmdbId: String(record.tmdbId || ""),
      season: String(record.season || ""),
      episode: String(record.episode || ""),
      title: String(record.title || ""),
      year: String(record.year || ""),
      episodeTitle: String(record.episodeTitle || ""),
      label: String(record.label || "default stream"),
      playlistUrl: String(record.playlistUrl || ""),
      directUrl: String(record.directUrl || ""),
      sourceType: String(record.sourceType || "hls") === "file" ? "file" : "hls",
      expiresAt: Number(record.expiresAt || 0),
      subtitlesJson: JSON.stringify(record.subtitles || []),
      status: String(record.status || "completed") as JobStatus,
      statusReason: note || source,
      warningCount: warnings.length,
      warningsJson: JSON.stringify(warnings),
      totalSegments: Number(record.totalSegments || 0),
      completedSegments: Number(record.completedSegments || 0),
      bytesWritten: Number(record.bytesWritten || 0),
      totalBytesEstimate: Number(
        record.totalBytesEstimate || record.bytesWritten || 0,
      ),
      currentSegment: Number(
        record.currentSegment || record.completedSegments || 0,
      ),
      currentConcurrency: Number(
        record.concurrency || record.currentConcurrencyLevel || 0,
      ),
      maxConcurrency: Number(record.maxConcurrency || 0),
      backoffLevel: Number(record.backoffLevel || 0),
      retryCount: 0,
      maxRetryCount: config.maxRetryCount,
      nextRetryAt: 0,
      lastProgressAt: updatedAt,
      stalledAt: 0,
      fileBasename: String(
        record.fileName || (finalPath ? path.basename(finalPath) : ""),
      ),
      stagingPath: "",
      finalFilePath: finalPath,
      sourceFilePath: "",
      finalFileKind: finalKind as FileKind,
      finalArtifactClass: warnings.length ? "warning" : "clean",
      skippedSegmentsJson: JSON.stringify(skipped),
      createdAt,
      updatedAt,
      startedAt: createdAt,
      completedAt: updatedAt,
      deletedAt: 0,
      deleteReason: "",
    };
    this.insertOrReplaceJob(job);
    this.recordJobEvent(job.id, "job.completed", {
      status: job.status,
      reason: source,
      completedSegments: job.completedSegments,
      totalSegments: job.totalSegments,
      bytesWritten: job.bytesWritten,
      filePath: job.finalFilePath,
    });
    return job;
  }

  upsertCheckpoint(
    jobId: string,
    completedSegments: number,
    bytesWritten: number,
    currentSegment: number,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO job_checkpoints (job_id, completed_segments, bytes_written, current_segment, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        completed_segments = excluded.completed_segments,
        bytes_written = excluded.bytes_written,
        current_segment = excluded.current_segment,
        updated_at = excluded.updated_at
    `,
      )
      .run(jobId, completedSegments, bytesWritten, currentSegment, now());
  }

  getCheckpoint(jobId: string): {
    completedSegments: number;
    bytesWritten: number;
    currentSegment: number;
  } | null {
    const row = this.db
      .prepare(`SELECT * FROM job_checkpoints WHERE job_id = ?`)
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      completedSegments: Number(row.completed_segments || 0),
      bytesWritten: Number(row.bytes_written || 0),
      currentSegment: Number(row.current_segment || 0),
    };
  }

  acquireRunnableJobs(limit: number): JobRecord[] {
    const ts = now();
    const rows = this.db
      .prepare(
        `
      SELECT * FROM jobs
      WHERE status IN ('queued', 'stalled', 'backing_off')
        AND deleted_at = 0
        AND (next_retry_at = 0 OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(ts, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapJob(row));
  }

  countActiveJobs(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('running', 'resolving', 'backing_off', 'validating', 'promoting') AND deleted_at = 0`,
      )
      .get() as Record<string, unknown>;
    return Number(row.count || 0);
  }

  reconcileExpiredRunningJobs(stallAfterMs: number): JobRecord[] {
    const threshold = now() - stallAfterMs;
    const ts = now();
    const rows = this.db
      .prepare(
        `
      SELECT j.* FROM jobs j
      WHERE j.status IN ('running', 'resolving', 'validating', 'promoting')
        AND j.deleted_at = 0
        AND j.last_progress_at > 0
        AND j.last_progress_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM worker_leases wl
          WHERE wl.job_id = j.id
            AND wl.lease_expires_at > ?
        )
    `,
      )
      .all(threshold, ts) as Record<string, unknown>[];
    const jobs = rows.map((row) => this.mapJob(row));
    for (const job of jobs) {
      this.updateJobStatus(
        job.id,
        "stalled",
        "No progress heartbeat within stall window",
        {
          stalledAt: now(),
          nextRetryAt: now() + 1000,
        },
        "job.stalled",
      );
    }
    return jobs;
  }

  getPendingNotifications(limit = 25): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `
      SELECT d.*, e.job_id, e.event_type, e.payload_json AS event_payload_json
      FROM notification_deliveries d
      JOIN job_events e ON e.id = d.job_event_id
      WHERE d.status IN ('pending', 'retry')
        AND (d.next_attempt_at = 0 OR d.next_attempt_at <= ?)
      ORDER BY d.updated_at ASC
      LIMIT ?
    `,
      )
      .all(now(), limit) as Array<Record<string, unknown>>;
  }

  enqueueMissingPlexCompletionNotifications(limit = 25): number {
    const hasPlexTarget =
      config.plexWebhookUrl ||
      config.plexRefreshUrl ||
      (config.plexUrl && config.plexToken && config.plexLibrarySectionId);
    if (!hasPlexTarget) return 0;
    const rows = this.db
      .prepare(
        `
      SELECT j.* FROM jobs j
      WHERE j.status IN ('completed', 'completed_with_warnings')
        AND j.deleted_at = 0
        AND j.request_id != 'legacy-import'
        AND j.final_file_path != ''
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
          JOIN job_events e ON e.id = d.job_event_id
          WHERE e.job_id = j.id
            AND d.target = 'plex'
        )
      ORDER BY j.completed_at DESC
      LIMIT ?
    `,
      )
      .all(limit) as Record<string, unknown>[];
    for (const row of rows) {
      const job = this.mapJob(row);
      const eventType =
        job.status === "completed"
          ? "job.completed"
          : "job.completed_with_warnings";
      this.recordJobEvent(job.id, eventType, {
        status: job.status,
        reason: job.statusReason,
        completedSegments: job.completedSegments,
        totalSegments: job.totalSegments,
        bytesWritten: job.bytesWritten,
        filePath: job.finalFilePath,
      });
    }
    return rows.length;
  }

  markNotificationSent(id: number): void {
    this.db
      .prepare(
        `
      UPDATE notification_deliveries
      SET status = 'sent', delivered_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now(), now(), id);
  }

  markNotificationRetry(
    id: number,
    attempts: number,
    error: string,
    delayMs: number,
  ): void {
    this.db
      .prepare(
        `
      UPDATE notification_deliveries
      SET status = 'retry', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(attempts, error, now() + delayMs, now(), id);
  }

  markNotificationFailed(id: number, attempts: number, error: string): void {
    this.db
      .prepare(
        `
      UPDATE notification_deliveries
      SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(attempts, error, now(), id);
  }

  recordLease(
    workerId: string,
    role: "worker" | "notifier",
    jobId: string,
    leaseExpiresAt: number,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO worker_leases (worker_id, role, job_id, lease_expires_at, last_heartbeat_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, '{}')
      ON CONFLICT(worker_id) DO UPDATE SET
        role = excluded.role,
        job_id = excluded.job_id,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at
    `,
      )
      .run(workerId, role, jobId, leaseExpiresAt, now());
  }

  releaseLease(workerId: string): void {
    this.db
      .prepare(`DELETE FROM worker_leases WHERE worker_id = ?`)
      .run(workerId);
  }

  createOptimizationJob(
    job: JobRecord,
    profile: Record<string, unknown>,
  ): Record<string, unknown> {
    const existing = this.db
      .prepare(
        `
      SELECT * FROM optimization_jobs
      WHERE job_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(job.id) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const ts = now();
    const inputPath = job.finalFilePath || job.sourceFilePath;
    const outputPath = inputPath.replace(/\.[^.]+$/i, ".optimized.mkv");
    const record = {
      id: crypto.randomUUID(),
      job_id: job.id,
      status: "queued",
      status_reason: "Waiting for optimizer",
      profile_json: JSON.stringify(profile),
      input_path: inputPath,
      output_path: outputPath,
      source_size: 0,
      output_size: 0,
      progress_percent: 0,
      progress_fps: 0,
      progress_speed: 0,
      eta_seconds: 0,
      progress_part_bytes: 0,
      progress_part_bps: 0,
      progress_confidence: "low",
      started_at: 0,
      completed_at: 0,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `
      INSERT INTO optimization_jobs (
        id, job_id, status, status_reason, profile_json, input_path, output_path,
        source_size, output_size, progress_percent, progress_fps, progress_speed, eta_seconds, progress_part_bytes, progress_part_bps, progress_confidence, started_at, completed_at, created_at, updated_at
      ) VALUES (
        :id, :job_id, :status, :status_reason, :profile_json, :input_path, :output_path,
        :source_size, :output_size, :progress_percent, :progress_fps, :progress_speed, :eta_seconds, :progress_part_bytes, :progress_part_bps, :progress_confidence, :started_at, :completed_at, :created_at, :updated_at
      )
      `,
      )
      .run(record); // record must contain keys matching these names

    return record;
  }

  updateOptimizationPaths(jobId: string, inputPath: string, outputPath: string): void {
    this.db
      .prepare(
        `UPDATE optimization_jobs
         SET input_path = ?, output_path = ?, updated_at = ?
         WHERE job_id = ? AND status IN ('queued', 'retry', 'running')`,
      )
      .run(inputPath, outputPath, now(), jobId);
  }

  listOptimizationJobs(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM optimization_jobs ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  acquireOptimizationJob(): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT * FROM optimization_jobs WHERE status IN ('queued', 'retry') ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare(
        `UPDATE optimization_jobs SET status = 'running', status_reason = 'Optimizing media', started_at = COALESCE(NULLIF(started_at, 0), ?), updated_at = ? WHERE id = ?`,
      )
      .run(now(), now(), String(row.id));
    return this.db
      .prepare(`SELECT * FROM optimization_jobs WHERE id = ?`)
      .get(String(row.id)) as Record<string, unknown>;
  }

  updateOptimizationJob(
    id: string,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = this.db
      .prepare(`SELECT * FROM optimization_jobs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`optimization job ${id} not found`);
    const next: Record<string, unknown> = {
      ...current,
      ...patch,
      updated_at: now(),
    };
    if (
      (next.status === "completed" || next.status === "failed") &&
      !Number(next.completed_at || 0)
    ) {
      next.completed_at = now();
    }
    const params = {
      id: next.id,
      status: next.status,
      status_reason: next.status_reason,
      profile_json: next.profile_json,
      input_path: next.input_path,
      output_path: next.output_path,
      source_size: next.source_size,
      output_size: next.output_size,
      progress_percent: next.progress_percent,
      progress_fps: next.progress_fps,
      progress_speed: next.progress_speed,
      eta_seconds: next.eta_seconds,
      progress_part_bytes: next.progress_part_bytes,
      progress_part_bps: next.progress_part_bps,
      progress_confidence: next.progress_confidence,
      started_at: next.started_at,
      completed_at: next.completed_at,
      updated_at: next.updated_at,
    };
    this.db
      .prepare(
        `
      UPDATE optimization_jobs
      SET status = @status,
          status_reason = @status_reason,
          profile_json = @profile_json,
          input_path = @input_path,
          output_path = @output_path,
          source_size = @source_size,
          output_size = @output_size,
          progress_percent = @progress_percent,
          progress_fps = @progress_fps,
          progress_speed = @progress_speed,
          eta_seconds = @eta_seconds,
          progress_part_bytes = @progress_part_bytes,
          progress_part_bps = @progress_part_bps,
          progress_confidence = @progress_confidence,
          started_at = @started_at,
          completed_at = @completed_at,
          updated_at = @updated_at
      WHERE id = @id
    `,
      )
      .run(params as Record<string, SQLInputValue>);
    return next;
  }

  getMetrics(): Record<string, number> {
    const byStatus = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM jobs WHERE deleted_at = 0 GROUP BY status`,
      )
      .all() as Array<Record<string, unknown>>;
    const out: Record<string, number> = {};
    for (const row of byStatus) {
      out[`jobs_${String(row.status)}`] = Number(row.count || 0);
    }
    const deletedJobs = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE deleted_at > 0`)
      .get() as Record<string, unknown>;
    out.jobs_deleted = Number(deletedJobs.count || 0);
    const pendingNotifications = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM notification_deliveries WHERE status IN ('pending', 'retry')`,
      )
      .get() as Record<string, unknown>;
    out.notifications_pending = Number(pendingNotifications.count || 0);
    const pendingOptimizations = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM optimization_jobs WHERE status IN ('queued', 'running', 'retry')`,
      )
      .get() as Record<string, unknown>;
    out.optimizations_active = Number(pendingOptimizations.count || 0);
    return out;
  }

  getConcurrencyInsights(jobId: string): Array<{
    concurrency: number;
    segments: number;
    seconds: number;
    segmentsPerSecond: number;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT current_concurrency AS concurrency, completed_segments AS segments, last_progress_at, started_at, updated_at
      FROM jobs WHERE id = ? AND deleted_at = 0
    `,
      )
      .all(jobId) as Array<Record<string, unknown>>;
    if (!rows.length) return [];
    const row = rows[0];
    const startedAt = Number(row.started_at || 0);
    const lastProgressAt = Number(row.last_progress_at || 0);
    const elapsed =
      startedAt && lastProgressAt && lastProgressAt > startedAt
        ? (lastProgressAt - startedAt) / 1000
        : 0;
    if (!elapsed) return [];
    return [
      {
        concurrency: Number(row.concurrency || 0),
        segments: Number(row.segments || 0),
        seconds: elapsed,
        segmentsPerSecond: Number(row.segments || 0) / elapsed,
      },
    ];
  }
}

export const database = new AppDatabase();
log.info("database initialized", { sqlitePath: config.sqlitePath });
