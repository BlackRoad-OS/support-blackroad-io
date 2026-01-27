/**
 * ⬛⬜🛣️ BlackRoad Support Center - Main Entry Point
 * Cloudflare Workers with Agent Jobs, Repo Sync, and Self-Healing
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, JobMessage, JobType, ApiResponse } from './types';
import { createLogger } from './utils/logger';
import { generateCorrelationId } from './utils/id';

// Re-export Durable Objects for Cloudflare Workers
export { AgentJobManager } from './durable-objects/AgentJobManager';
export { RepoSyncState } from './durable-objects/RepoSyncState';
export { SelfHealer } from './durable-objects/SelfHealer';
export { CohesivenessTracker } from './durable-objects/CohesivenessTracker';

// Initialize Hono app
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());

app.use('*', async (c, next) => {
  const requestId = generateCorrelationId();
  c.set('requestId' as never, requestId);
  c.header('X-Request-ID', requestId);

  const logger = createLogger(c.env, { requestId });
  c.set('logger' as never, logger);

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  logger.info('Request completed', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  });
});

// ============================================================================
// Health & Status Endpoints
// ============================================================================

app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad Support Center',
    version: '1.0.0',
    status: 'operational',
    emoji: '⬛⬜🛣️',
  });
});

app.get('/health', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  try {
    const response = await selfHealer.fetch(new Request('http://internal/status'));
    const status = await response.json();

    return c.json({
      status: 'ok',
      ...status,
    });
  } catch (error) {
    return c.json({ status: 'degraded', error: (error as Error).message }, 500);
  }
});

// ============================================================================
// Jobs API
// ============================================================================

app.get('/api/jobs/status', async (c) => {
  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const response = await jobManager.fetch(new Request('http://internal/jobs/status'));
  const data = await response.json();

  return c.json(data);
});

app.get('/api/jobs/stats', async (c) => {
  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const response = await jobManager.fetch(new Request('http://internal/jobs/stats'));
  const data = await response.json();

  return c.json(data);
});

app.post('/api/jobs/create', async (c) => {
  const body = await c.req.json<{ type: JobType; payload?: Record<string, unknown> }>();

  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const response = await jobManager.fetch(
    new Request('http://internal/jobs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const data = await response.json();
  return c.json(data, response.status as 200 | 201);
});

app.post('/api/jobs/trigger', async (c) => {
  const body = await c.req.json<{ type?: JobType; jobId?: string }>();

  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const response = await jobManager.fetch(
    new Request('http://internal/jobs/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const data = await response.json();
  return c.json(data);
});

app.post('/api/jobs/trigger-all', async (c) => {
  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const jobTypes: JobType[] = ['repo_sync', 'cohesiveness_check', 'self_heal'];
  const results: Array<{ type: string; success: boolean }> = [];

  for (const type of jobTypes) {
    try {
      const response = await jobManager.fetch(
        new Request('http://internal/jobs/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type }),
        })
      );
      results.push({ type, success: response.ok });
    } catch {
      results.push({ type, success: false });
    }
  }

  return c.json({ triggered: results });
});

app.get('/api/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
  const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

  const response = await jobManager.fetch(new Request(`http://internal/jobs/${jobId}`));
  const data = await response.json();

  return c.json(data, response.status as 200 | 404);
});

// ============================================================================
// Repository Sync API
// ============================================================================

app.get('/api/repos', async (c) => {
  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(new Request('http://internal/repos'));
  const data = await response.json();

  return c.json(data);
});

app.get('/api/repos/status', async (c) => {
  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(new Request('http://internal/status'));
  const data = await response.json();

  return c.json(data);
});

app.post('/api/repos/sync', async (c) => {
  const body = await c.req.json<{ repos?: string[]; full?: boolean }>().catch(() => ({}));

  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(
    new Request('http://internal/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const data = await response.json();
  return c.json(data);
});

app.get('/api/repos/:repoName', async (c) => {
  const repoName = c.req.param('repoName');
  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(new Request(`http://internal/repos/${repoName}`));
  const data = await response.json();

  return c.json(data, response.status as 200 | 404);
});

app.post('/api/repos/:repoName/scrape', async (c) => {
  const repoName = c.req.param('repoName');
  const body = await c.req.json<{ paths?: string[] }>().catch(() => ({}));

  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(
    new Request('http://internal/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoName, ...body }),
    })
  );

  const data = await response.json();
  return c.json(data);
});

app.get('/api/repos/history', async (c) => {
  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  const response = await repoSync.fetch(new Request('http://internal/history'));
  const data = await response.json();

  return c.json(data);
});

// ============================================================================
// Cohesiveness API
// ============================================================================

app.get('/api/cohesiveness/report', async (c) => {
  const trackerId = c.env.COHESIVENESS_TRACKER.idFromName('primary');
  const tracker = c.env.COHESIVENESS_TRACKER.get(trackerId);

  const response = await tracker.fetch(new Request('http://internal/report'));
  const data = await response.json();

  return c.json(data);
});

app.get('/api/cohesiveness/issues', async (c) => {
  const trackerId = c.env.COHESIVENESS_TRACKER.idFromName('primary');
  const tracker = c.env.COHESIVENESS_TRACKER.get(trackerId);

  const response = await tracker.fetch(new Request('http://internal/issues'));
  const data = await response.json();

  return c.json(data);
});

app.post('/api/cohesiveness/check', async (c) => {
  // First sync repos, then run cohesiveness check
  const repoSyncId = c.env.REPO_SYNC_STATE.idFromName('primary');
  const repoSync = c.env.REPO_SYNC_STATE.get(repoSyncId);

  // Sync repos
  await repoSync.fetch(
    new Request('http://internal/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  // Get configs
  const configsResponse = await repoSync.fetch(new Request('http://internal/configs'));
  const { configs } = (await configsResponse.json()) as { configs: Record<string, unknown> };

  // Run cohesiveness check
  const trackerId = c.env.COHESIVENESS_TRACKER.idFromName('primary');
  const tracker = c.env.COHESIVENESS_TRACKER.get(trackerId);

  const response = await tracker.fetch(
    new Request('http://internal/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configs }),
    })
  );

  const data = await response.json();
  return c.json(data);
});

app.get('/api/cohesiveness/standards', async (c) => {
  const trackerId = c.env.COHESIVENESS_TRACKER.idFromName('primary');
  const tracker = c.env.COHESIVENESS_TRACKER.get(trackerId);

  const response = await tracker.fetch(new Request('http://internal/standards'));
  const data = await response.json();

  return c.json(data);
});

app.get('/api/cohesiveness/history', async (c) => {
  const trackerId = c.env.COHESIVENESS_TRACKER.idFromName('primary');
  const tracker = c.env.COHESIVENESS_TRACKER.get(trackerId);

  const response = await tracker.fetch(new Request('http://internal/history'));
  const data = await response.json();

  return c.json(data);
});

// ============================================================================
// Self-Healing API
// ============================================================================

app.get('/api/healing/status', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/status'));
  const data = await response.json();

  return c.json(data);
});

app.post('/api/healing/check', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(
    new Request('http://internal/check', { method: 'POST' })
  );
  const data = await response.json();

  return c.json(data);
});

app.post('/api/healing/trigger', async (c) => {
  const body = await c.req.json<{ trigger: string; force?: boolean }>();

  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(
    new Request('http://internal/heal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const data = await response.json();
  return c.json(data, response.status as 200 | 400);
});

app.get('/api/healing/history', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/history'));
  const data = await response.json();

  return c.json(data);
});

app.get('/api/healing/config', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('primary');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/config'));
  const data = await response.json();

  return c.json(data);
});

// ============================================================================
// Webhook Handlers
// ============================================================================

app.post('/webhooks/github', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const signature = c.req.header('X-Hub-Signature-256');
  const body = await c.req.text();

  const logger = createLogger(c.env);

  // Verify signature if webhook secret is configured
  if (c.env.WEBHOOK_SECRET && signature) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(c.env.WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expectedSignature =
      'sha256=' +
      Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    if (signature !== expectedSignature) {
      logger.warn('Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  logger.info('Received GitHub webhook', { event });

  // Handle relevant events
  if (event === 'push' || event === 'release') {
    // Trigger repo sync
    const jobManagerId = c.env.AGENT_JOB_MANAGER.idFromName('primary');
    const jobManager = c.env.AGENT_JOB_MANAGER.get(jobManagerId);

    await jobManager.fetch(
      new Request('http://internal/jobs/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'repo_sync' }),
      })
    );
  }

  return c.json({ received: true, event });
});

// ============================================================================
// 404 Handler
// ============================================================================

app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      path: c.req.path,
      availableEndpoints: [
        'GET /',
        'GET /health',
        'GET /api/jobs/status',
        'GET /api/repos',
        'GET /api/cohesiveness/report',
        'GET /api/healing/status',
      ],
    },
    404
  );
});

// ============================================================================
// Error Handler
// ============================================================================

app.onError((err, c) => {
  const logger = createLogger(c.env);
  logger.error('Unhandled error', err);

  return c.json(
    {
      error: 'Internal Server Error',
      message: err.message,
    },
    500
  );
});

// ============================================================================
// Worker Export
// ============================================================================

export default {
  // HTTP Request Handler
  fetch: app.fetch,

  // Scheduled (Cron) Handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger(env, { trigger: 'scheduled', cron: event.cron });
    logger.info('Scheduled job triggered', { cron: event.cron });

    try {
      switch (event.cron) {
        // Repo sync every 15 minutes
        case '*/15 * * * *': {
          const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
          const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

          ctx.waitUntil(
            repoSync.fetch(
              new Request('http://internal/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              })
            )
          );
          break;
        }

        // Cohesiveness check every hour
        case '0 * * * *': {
          const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
          const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

          // First sync repos
          await repoSync.fetch(
            new Request('http://internal/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            })
          );

          // Get configs
          const configsResponse = await repoSync.fetch(new Request('http://internal/configs'));
          const { configs } = (await configsResponse.json()) as { configs: Record<string, unknown> };

          // Run cohesiveness check
          const trackerId = env.COHESIVENESS_TRACKER.idFromName('primary');
          const tracker = env.COHESIVENESS_TRACKER.get(trackerId);

          ctx.waitUntil(
            tracker.fetch(
              new Request('http://internal/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs }),
              })
            )
          );
          break;
        }

        // Self-healing check every 5 minutes
        case '*/5 * * * *': {
          const selfHealerId = env.SELF_HEALER.idFromName('primary');
          const selfHealer = env.SELF_HEALER.get(selfHealerId);

          ctx.waitUntil(
            selfHealer.fetch(new Request('http://internal/check', { method: 'POST' }))
          );
          break;
        }

        // Deep repo analysis daily at 2 AM UTC
        case '0 2 * * *': {
          const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
          const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

          ctx.waitUntil(
            repoSync.fetch(
              new Request('http://internal/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ full: true }),
              })
            )
          );
          break;
        }

        // Weekly full reconciliation Sundays at 3 AM UTC
        case '0 3 * * 0': {
          logger.info('Running weekly reconciliation');

          // Full repo sync
          const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
          const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

          await repoSync.fetch(
            new Request('http://internal/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ full: true }),
            })
          );

          // Get configs
          const configsResponse = await repoSync.fetch(new Request('http://internal/configs'));
          const { configs } = (await configsResponse.json()) as { configs: Record<string, unknown> };

          // Full cohesiveness check
          const trackerId = env.COHESIVENESS_TRACKER.idFromName('primary');
          const tracker = env.COHESIVENESS_TRACKER.get(trackerId);

          await tracker.fetch(
            new Request('http://internal/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ configs }),
            })
          );

          // Job cleanup
          const jobManagerId = env.AGENT_JOB_MANAGER.idFromName('primary');
          const jobManager = env.AGENT_JOB_MANAGER.get(jobManagerId);

          ctx.waitUntil(
            jobManager.fetch(new Request('http://internal/jobs/cleanup', { method: 'POST' }))
          );
          break;
        }

        default:
          logger.warn('Unknown cron expression', { cron: event.cron });
      }
    } catch (error) {
      logger.error('Scheduled job failed', error as Error, { cron: event.cron });
    }
  },

  // Queue Handler
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    const logger = createLogger(env, { trigger: 'queue' });
    logger.info('Processing queue batch', { count: batch.messages.length });

    const jobManagerId = env.AGENT_JOB_MANAGER.idFromName('primary');
    const jobManager = env.AGENT_JOB_MANAGER.get(jobManagerId);

    for (const message of batch.messages) {
      const job = message.body;
      logger.info('Processing job', { jobId: job.id, type: job.type });

      try {
        await processJob(job, env);

        // Mark job as completed
        await jobManager.fetch(
          new Request('http://internal/jobs/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: job.id }),
          })
        );

        message.ack();
      } catch (error) {
        logger.error('Job processing failed', error as Error, { jobId: job.id });

        // Mark job as failed
        await jobManager.fetch(
          new Request('http://internal/jobs/fail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: job.id,
              error: {
                code: 'PROCESSING_ERROR',
                message: (error as Error).message,
                retryable: true,
              },
            }),
          })
        );

        message.retry();
      }
    }
  },
};

// ============================================================================
// Job Processing Logic
// ============================================================================

async function processJob(job: JobMessage, env: Env): Promise<void> {
  const logger = createLogger(env, { jobId: job.id, jobType: job.type });

  switch (job.type) {
    case 'repo_sync': {
      const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
      const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

      await repoSync.fetch(
        new Request('http://internal/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repos: job.payload.repos, full: job.payload.data?.full }),
        })
      );
      break;
    }

    case 'cohesiveness_check': {
      const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
      const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

      const configsResponse = await repoSync.fetch(new Request('http://internal/configs'));
      const { configs } = (await configsResponse.json()) as { configs: Record<string, unknown> };

      const trackerId = env.COHESIVENESS_TRACKER.idFromName('primary');
      const tracker = env.COHESIVENESS_TRACKER.get(trackerId);

      await tracker.fetch(
        new Request('http://internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configs }),
        })
      );
      break;
    }

    case 'self_heal': {
      const selfHealerId = env.SELF_HEALER.idFromName('primary');
      const selfHealer = env.SELF_HEALER.get(selfHealerId);

      await selfHealer.fetch(new Request('http://internal/check', { method: 'POST' }));
      break;
    }

    case 'deep_analysis': {
      const repoSyncId = env.REPO_SYNC_STATE.idFromName('primary');
      const repoSync = env.REPO_SYNC_STATE.get(repoSyncId);

      await repoSync.fetch(
        new Request('http://internal/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full: true }),
        })
      );
      break;
    }

    case 'reconciliation': {
      logger.info('Running full reconciliation');
      // This would be a comprehensive check and fix cycle
      break;
    }

    case 'webhook_process': {
      logger.info('Processing webhook event', { data: job.payload.data });
      break;
    }

    case 'manual_trigger': {
      const action = job.payload.action;
      logger.info('Manual trigger action', { action });
      break;
    }

    default:
      logger.warn('Unknown job type', { type: job.type });
  }
}
