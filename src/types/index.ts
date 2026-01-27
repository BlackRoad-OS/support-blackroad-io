/**
 * ⬛⬜🛣️ BlackRoad Support Center - Type Definitions
 * Core types for the Agent Job System
 */

// ============================================================================
// Environment Bindings
// ============================================================================
export interface Env {
  // Durable Objects
  AGENT_JOB_MANAGER: DurableObjectNamespace;
  REPO_SYNC_STATE: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;
  COHESIVENESS_TRACKER: DurableObjectNamespace;

  // KV Namespaces
  REPO_CACHE: KVNamespace;
  JOB_LOGS: KVNamespace;
  CONFIG_STORE: KVNamespace;

  // Queues
  JOBS_QUEUE: Queue<JobMessage>;
  JOBS_DLQ: Queue<JobMessage>;

  // R2 Storage
  ARTIFACTS_BUCKET: R2Bucket;

  // Environment Variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  BLACKROAD_ORG: string;
  PRIMARY_REPOS: string;
  SELF_HEAL_ENABLED: string;
  COHESIVENESS_STRICT: string;

  // Secrets
  GITHUB_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  DISCORD_WEBHOOK_URL?: string;
  ENCRYPTION_KEY?: string;
}

// ============================================================================
// Job System Types
// ============================================================================
export type JobType =
  | 'repo_sync'
  | 'cohesiveness_check'
  | 'self_heal'
  | 'deep_analysis'
  | 'reconciliation'
  | 'webhook_process'
  | 'manual_trigger';

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'dead_letter';

export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

export interface JobMessage {
  id: string;
  type: JobType;
  priority: JobPriority;
  payload: JobPayload;
  metadata: JobMetadata;
  createdAt: string;
  attempts: number;
}

export interface JobPayload {
  repos?: string[];
  targetRepo?: string;
  action?: string;
  data?: Record<string, unknown>;
  triggerSource?: 'cron' | 'webhook' | 'api' | 'self_heal';
}

export interface JobMetadata {
  correlationId: string;
  parentJobId?: string;
  scheduledBy?: string;
  cronExpression?: string;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  result?: unknown;
  error?: JobError;
  metrics?: JobMetrics;
}

export interface JobError {
  code: string;
  message: string;
  stack?: string;
  retryable: boolean;
  resolution?: string;
}

export interface JobMetrics {
  itemsProcessed: number;
  itemsFailed: number;
  bytesTransferred: number;
  apiCallsMade: number;
}

// ============================================================================
// Repository Types
// ============================================================================
export interface RepoInfo {
  name: string;
  fullName: string;
  description?: string;
  url: string;
  defaultBranch: string;
  language?: string;
  topics: string[];
  visibility: 'public' | 'private' | 'internal';
  lastPushed: string;
  lastSynced?: string;
}

export interface RepoContent {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  sha: string;
  size?: number;
  content?: string;
  encoding?: string;
}

export interface RepoSyncResult {
  repo: string;
  status: 'success' | 'partial' | 'failed';
  filesScanned: number;
  filesUpdated: number;
  errors: string[];
  duration: number;
  timestamp: string;
}

// ============================================================================
// Cohesiveness Types
// ============================================================================
export interface CohesivenessReport {
  id: string;
  timestamp: string;
  overallScore: number;
  repos: RepoCohesivenessScore[];
  issues: CohesivenessIssue[];
  recommendations: string[];
}

export interface RepoCohesivenessScore {
  repo: string;
  score: number;
  factors: CohesivenessFactor[];
}

export interface CohesivenessFactor {
  name: string;
  weight: number;
  score: number;
  details?: string;
}

export interface CohesivenessIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  repos: string[];
  description: string;
  suggestedFix?: string;
  autoFixable: boolean;
}

// ============================================================================
// Self-Healing Types
// ============================================================================
export interface HealthCheck {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: string;
  details: Record<string, unknown>;
  consecutiveFailures: number;
}

export interface HealingAction {
  id: string;
  trigger: string;
  action: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: string;
  timestamp: string;
}

export interface SelfHealConfig {
  enabled: boolean;
  checks: HealthCheckConfig[];
  actions: HealingActionConfig[];
}

export interface HealthCheckConfig {
  name: string;
  interval: number;
  timeout: number;
  threshold: number;
  enabled: boolean;
}

export interface HealingActionConfig {
  trigger: string;
  action: string;
  cooldown: number;
  maxAttempts: number;
  enabled: boolean;
}

// ============================================================================
// API Types
// ============================================================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiMeta {
  requestId: string;
  timestamp: string;
  duration?: number;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasMore: boolean;
}

// ============================================================================
// Event Types
// ============================================================================
export interface SystemEvent {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  data: Record<string, unknown>;
  processed: boolean;
}

export interface WebhookEvent {
  id: string;
  source: 'github' | 'discord' | 'custom';
  event: string;
  payload: Record<string, unknown>;
  signature?: string;
  receivedAt: string;
}
