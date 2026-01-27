/**
 * ⬛⬜🛣️ BlackRoad Support Center - Agent Job Manager
 * Durable Object for managing and orchestrating agent jobs
 */

import type {
  Env,
  JobMessage,
  JobStatus,
  JobResult,
  JobType,
  JobPriority,
  JobPayload,
  RetryPolicy,
} from '../types';
import { generateJobId, generateCorrelationId } from '../utils/id';
import { createLogger } from '../utils/logger';

interface JobState {
  jobs: Map<string, JobMessage>;
  results: Map<string, JobResult>;
  activeJobs: Set<string>;
  scheduledJobs: Map<string, string>; // cronExpression -> jobId
}

interface JobStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  retrying: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 30000,
};

export class AgentJobManager implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger;
  private jobState: JobState = {
    jobs: new Map(),
    results: new Map(),
    activeJobs: new Set(),
    scheduledJobs: new Map(),
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env, { durableObject: 'AgentJobManager' });

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<JobState>('jobState');
      if (stored) {
        this.jobState = {
          jobs: new Map(Object.entries(stored.jobs || {})),
          results: new Map(Object.entries(stored.results || {})),
          activeJobs: new Set(stored.activeJobs || []),
          scheduledJobs: new Map(Object.entries(stored.scheduledJobs || {})),
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('jobState', {
      jobs: Object.fromEntries(this.jobState.jobs),
      results: Object.fromEntries(this.jobState.results),
      activeJobs: Array.from(this.jobState.activeJobs),
      scheduledJobs: Object.fromEntries(this.jobState.scheduledJobs),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route handling
      if (request.method === 'POST' && path === '/jobs/create') {
        return this.handleCreateJob(request);
      }
      if (request.method === 'POST' && path === '/jobs/trigger') {
        return this.handleTriggerJob(request);
      }
      if (request.method === 'GET' && path === '/jobs/status') {
        return this.handleGetStatus();
      }
      if (request.method === 'GET' && path.startsWith('/jobs/')) {
        const jobId = path.split('/')[2];
        if (jobId) return this.handleGetJob(jobId);
      }
      if (request.method === 'POST' && path === '/jobs/complete') {
        return this.handleCompleteJob(request);
      }
      if (request.method === 'POST' && path === '/jobs/fail') {
        return this.handleFailJob(request);
      }
      if (request.method === 'DELETE' && path.startsWith('/jobs/')) {
        const jobId = path.split('/')[2];
        if (jobId) return this.handleDeleteJob(jobId);
      }
      if (request.method === 'GET' && path === '/jobs/stats') {
        return this.handleGetStats();
      }
      if (request.method === 'POST' && path === '/jobs/cleanup') {
        return this.handleCleanup();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      this.logger.error('Job manager error', error as Error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleCreateJob(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      type: JobType;
      priority?: JobPriority;
      payload?: JobPayload;
      retryPolicy?: RetryPolicy;
    };

    const job = this.createJob(body.type, body.payload, body.priority, body.retryPolicy);
    await this.saveState();

    this.logger.info('Job created', { jobId: job.id, type: job.type });

    return new Response(JSON.stringify({ job }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTriggerJob(request: Request): Promise<Response> {
    const body = (await request.json()) as { jobId?: string; type?: JobType };

    let job: JobMessage | undefined;

    if (body.jobId) {
      job = this.jobState.jobs.get(body.jobId);
    } else if (body.type) {
      // Find or create a job of the specified type
      job = this.createJob(body.type, { triggerSource: 'api' });
    }

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Queue the job
    await this.queueJob(job);
    await this.saveState();

    return new Response(JSON.stringify({ success: true, jobId: job.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStatus(): Promise<Response> {
    const jobs = Array.from(this.jobState.jobs.values());
    const activeJobs = jobs.filter((j) => this.jobState.activeJobs.has(j.id));

    return new Response(
      JSON.stringify({
        totalJobs: jobs.length,
        activeJobs: activeJobs.length,
        jobs: jobs.slice(0, 50), // Return last 50 jobs
        results: Array.from(this.jobState.results.values()).slice(-50),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleGetJob(jobId: string): Promise<Response> {
    const job = this.jobState.jobs.get(jobId);
    const result = this.jobState.results.get(jobId);

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ job, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCompleteJob(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      jobId: string;
      result?: unknown;
      metrics?: JobResult['metrics'];
    };

    const job = this.jobState.jobs.get(body.jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result: JobResult = {
      jobId: body.jobId,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: body.result,
      metrics: body.metrics,
    };

    this.jobState.results.set(body.jobId, result);
    this.jobState.activeJobs.delete(body.jobId);
    await this.saveState();

    this.logger.info('Job completed', { jobId: body.jobId });

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleFailJob(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      jobId: string;
      error: { code: string; message: string; retryable?: boolean };
    };

    const job = this.jobState.jobs.get(body.jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const retryPolicy = job.metadata.retryPolicy || DEFAULT_RETRY_POLICY;
    const shouldRetry = body.error.retryable !== false && job.attempts < retryPolicy.maxRetries;

    if (shouldRetry) {
      // Schedule retry with exponential backoff
      job.attempts++;
      const backoffMs = Math.min(
        retryPolicy.backoffMs * Math.pow(retryPolicy.backoffMultiplier, job.attempts - 1),
        retryPolicy.maxBackoffMs
      );

      this.logger.info('Scheduling job retry', {
        jobId: body.jobId,
        attempt: job.attempts,
        backoffMs,
      });

      // Re-queue after backoff
      setTimeout(() => {
        this.queueJob(job).catch((e) =>
          this.logger.error('Failed to re-queue job', e as Error, { jobId: job.id })
        );
      }, backoffMs);

      const result: JobResult = {
        jobId: body.jobId,
        status: 'retrying',
        startedAt: new Date().toISOString(),
        error: { ...body.error, retryable: true },
      };

      this.jobState.results.set(body.jobId, result);
    } else {
      // Move to dead letter queue
      const result: JobResult = {
        jobId: body.jobId,
        status: 'failed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { ...body.error, retryable: false },
      };

      this.jobState.results.set(body.jobId, result);
      this.jobState.activeJobs.delete(body.jobId);

      // Send to DLQ
      await this.env.JOBS_DLQ.send(job);

      this.logger.warn('Job failed permanently', { jobId: body.jobId, error: body.error });
    }

    await this.saveState();

    return new Response(JSON.stringify({ success: true, retried: shouldRetry }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDeleteJob(jobId: string): Promise<Response> {
    const deleted = this.jobState.jobs.delete(jobId);
    this.jobState.results.delete(jobId);
    this.jobState.activeJobs.delete(jobId);

    if (deleted) {
      await this.saveState();
    }

    return new Response(JSON.stringify({ success: deleted }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStats(): Promise<Response> {
    const stats = this.getStats();

    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCleanup(): Promise<Response> {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    let cleaned = 0;

    for (const [jobId, job] of this.jobState.jobs) {
      const createdAt = new Date(job.createdAt).getTime();
      if (now - createdAt > maxAge && !this.jobState.activeJobs.has(jobId)) {
        this.jobState.jobs.delete(jobId);
        this.jobState.results.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.saveState();
    }

    this.logger.info('Job cleanup completed', { cleaned });

    return new Response(JSON.stringify({ success: true, cleaned }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Public methods for job creation and management

  createJob(
    type: JobType,
    payload?: JobPayload,
    priority: JobPriority = 'normal',
    retryPolicy?: RetryPolicy
  ): JobMessage {
    const job: JobMessage = {
      id: generateJobId(),
      type,
      priority,
      payload: payload || {},
      metadata: {
        correlationId: generateCorrelationId(),
        retryPolicy: retryPolicy || DEFAULT_RETRY_POLICY,
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    this.jobState.jobs.set(job.id, job);
    return job;
  }

  async queueJob(job: JobMessage): Promise<void> {
    this.jobState.activeJobs.add(job.id);
    await this.env.JOBS_QUEUE.send(job);
    this.logger.info('Job queued', { jobId: job.id, type: job.type });
  }

  getStats(): JobStats {
    const jobs = Array.from(this.jobState.jobs.values());
    const results = Array.from(this.jobState.results.values());

    return {
      total: jobs.length,
      pending: jobs.filter((j) => !this.jobState.activeJobs.has(j.id)).length,
      running: this.jobState.activeJobs.size,
      completed: results.filter((r) => r.status === 'completed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      retrying: results.filter((r) => r.status === 'retrying').length,
    };
  }
}
