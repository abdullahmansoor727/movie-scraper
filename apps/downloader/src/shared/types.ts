export type JobStatus =
  | 'queued'
  | 'resolving'
  | 'running'
  | 'backing_off'
  | 'stalled'
  | 'paused'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed_terminal';

export type FileKind = 'ts' | 'mp4' | 'mkv' | 'unknown';
export type FinalArtifactClass = 'clean' | 'warning' | 'failed' | 'none';
export type NotificationTarget = 'overseerr' | 'plex';
export type StreamSourceType = 'hls' | 'file';

export type SubtitleTrack = {
  url: string;
  label: string;
  language: string;
};

export type DownloadRequest = {
  id: string;
  s?: string;
  e?: string;
  label?: string;
  playlistUrl?: string;
  directUrl?: string;
  sourceType?: StreamSourceType;
  expiresAt?: number;
  subtitles?: SubtitleTrack[];
  title?: string;
  year?: string;
  episodeTitle?: string;
  requestId?: string;
};

export type JobRecord = {
  id: string;
  requestId: string;
  tmdbId: string;
  season: string;
  episode: string;
  title: string;
  year: string;
  episodeTitle: string;
  label: string;
  playlistUrl: string;
  directUrl: string;
  sourceType: StreamSourceType;
  expiresAt: number;
  subtitlesJson: string;
  status: JobStatus;
  statusReason: string;
  warningCount: number;
  warningsJson: string;
  totalSegments: number;
  completedSegments: number;
  bytesWritten: number;
  totalBytesEstimate: number;
  currentSegment: number;
  currentConcurrency: number;
  maxConcurrency: number;
  backoffLevel: number;
  retryCount: number;
  maxRetryCount: number;
  nextRetryAt: number;
  lastProgressAt: number;
  stalledAt: number;
  fileBasename: string;
  stagingPath: string;
  finalFilePath: string;
  sourceFilePath: string;
  finalFileKind: FileKind;
  finalArtifactClass: FinalArtifactClass;
  skippedSegmentsJson: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
  deletedAt: number;
  deleteReason: string;
};

export type JobEventType =
  | 'job.created'
  | 'job.started'
  | 'job.progress'
  | 'job.backing_off'
  | 'job.stalled'
  | 'job.resumed'
  | 'job.completed'
  | 'job.completed_with_warnings'
  | 'job.failed_terminal'
  | 'job.promoted'
  | 'notification.sent'
  | 'notification.failed';

export type JobResponse = {
  id: string;
  requestId: string;
  status: JobStatus;
  label: string;
  title: string;
  year: string;
  episodeTitle: string;
  fileName: string;
  filePath: string;
  sourceType: StreamSourceType;
  directUrl: string;
  expiresAt: number;
  subtitles: SubtitleTrack[];
  totalSegments: number;
  completedSegments: number;
  bytesWritten: number;
  totalBytesEstimate: number;
  currentSegment: number;
  concurrency: number;
  maxConcurrency: number;
  backoffLevel: number;
  skippedSegments: number[];
  warningCount: number;
  warnings: string[];
  note: string;
  error: string;
  finalArtifactClass: FinalArtifactClass;
  currentSegmentsPerSecond: number;
  bytesPerSecond: number;
  etaSeconds: number;
  concurrencyInsights: Array<{
    concurrency: number;
    segments: number;
    seconds: number;
    segmentsPerSecond: number;
  }>;
  notifier: {
    pending: number;
    failed: number;
  };
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
  deletedAt: number;
  deleteReason: string;
};

export type VariantOption = {
  url: string;
  label: string;
  sourceType?: StreamSourceType;
  directUrl?: string;
  expiresAt?: number;
};

export type ResolveVariantsResult = {
  streamUrl: string;
  streamType: StreamSourceType;
  directUrl?: string;
  expiresAt?: number;
  subtitles?: SubtitleTrack[];
  variants: VariantOption[];
};

export type WorkerLease = {
  workerId: string;
  role: 'worker' | 'notifier';
  lastHeartbeatAt: number;
};
