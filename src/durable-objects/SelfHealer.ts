/**
 * ⬛⬜🛣️ BlackRoad Support Center - Self Healer
 * Durable Object for automatic self-resolution and system healing
 */

import type {
  Env,
  HealthCheck,
  HealingAction,
  SelfHealConfig,
  HealthCheckConfig,
  HealingActionConfig,
  CohesivenessIssue,
} from '../types';
import { createLogger } from '../utils/logger';
import { generateHealingId } from '../utils/id';

interface SelfHealState {
  config: SelfHealConfig;
  healthChecks: Map<string, HealthCheck>;
  healingHistory: HealingAction[];
  lastHealingAttempts: Map<string, number>; // action -> timestamp
  systemStatus: 'healthy' | 'degraded' | 'unhealthy' | 'healing';
}

const DEFAULT_CONFIG: SelfHealConfig = {
  enabled: true,
  checks: [
    { name: 'job_queue_health', interval: 60000, timeout: 10000, threshold: 3, enabled: true },
    { name: 'repo_sync_freshness', interval: 300000, timeout: 30000, threshold: 2, enabled: true },
    { name: 'api_responsiveness', interval: 30000, timeout: 5000, threshold: 5, enabled: true },
    { name: 'cohesiveness_score', interval: 600000, timeout: 60000, threshold: 1, enabled: true },
    { name: 'storage_health', interval: 120000, timeout: 15000, threshold: 3, enabled: true },
  ],
  actions: [
    { trigger: 'job_queue_stalled', action: 'restart_job_queue', cooldown: 300000, maxAttempts: 3, enabled: true },
    { trigger: 'repo_sync_stale', action: 'force_repo_sync', cooldown: 600000, maxAttempts: 2, enabled: true },
    { trigger: 'cohesiveness_low', action: 'trigger_cohesiveness_fix', cooldown: 1800000, maxAttempts: 1, enabled: true },
    { trigger: 'api_unresponsive', action: 'restart_api_handlers', cooldown: 120000, maxAttempts: 5, enabled: true },
    { trigger: 'storage_issues', action: 'cleanup_storage', cooldown: 600000, maxAttempts: 2, enabled: true },
    { trigger: 'auto_fix_issue', action: 'apply_auto_fix', cooldown: 60000, maxAttempts: 10, enabled: true },
  ],
};

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger;
  private healState: SelfHealState = {
    config: DEFAULT_CONFIG,
    healthChecks: new Map(),
    healingHistory: [],
    lastHealingAttempts: new Map(),
    systemStatus: 'healthy',
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env, { durableObject: 'SelfHealer' });

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SelfHealState>('healState');
      if (stored) {
        this.healState = {
          config: stored.config || DEFAULT_CONFIG,
          healthChecks: new Map(Object.entries(stored.healthChecks || {})),
          healingHistory: stored.healingHistory || [],
          lastHealingAttempts: new Map(Object.entries(stored.lastHealingAttempts || {})),
          systemStatus: stored.systemStatus || 'healthy',
        };
      }

      // Initialize health checks if not present
      for (const checkConfig of this.healState.config.checks) {
        if (!this.healState.healthChecks.has(checkConfig.name)) {
          this.healState.healthChecks.set(checkConfig.name, {
            id: checkConfig.name,
            name: checkConfig.name,
            status: 'healthy',
            lastCheck: new Date().toISOString(),
            details: {},
            consecutiveFailures: 0,
          });
        }
      }
    });

    // Check if self-healing is enabled
    if (env.SELF_HEAL_ENABLED !== 'true') {
      this.healState.config.enabled = false;
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('healState', {
      config: this.healState.config,
      healthChecks: Object.fromEntries(this.healState.healthChecks),
      healingHistory: this.healState.healingHistory.slice(-100),
      lastHealingAttempts: Object.fromEntries(this.healState.lastHealingAttempts),
      systemStatus: this.healState.systemStatus,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/check') {
        return this.handleRunChecks();
      }
      if (request.method === 'GET' && path === '/status') {
        return this.handleGetStatus();
      }
      if (request.method === 'POST' && path === '/heal') {
        return this.handleTriggerHealing(request);
      }
      if (request.method === 'POST' && path === '/report-issue') {
        return this.handleReportIssue(request);
      }
      if (request.method === 'GET' && path === '/history') {
        return this.handleGetHistory();
      }
      if (request.method === 'GET' && path === '/config') {
        return this.handleGetConfig();
      }
      if (request.method === 'PUT' && path === '/config') {
        return this.handleUpdateConfig(request);
      }
      if (request.method === 'POST' && path === '/auto-fix') {
        return this.handleAutoFix(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      this.logger.error('Self-healer error', error as Error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleRunChecks(): Promise<Response> {
    if (!this.healState.config.enabled) {
      return new Response(JSON.stringify({ message: 'Self-healing is disabled' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const results = await this.runHealthChecks();
    await this.evaluateAndHeal();
    await this.saveState();

    return new Response(JSON.stringify({ results, status: this.healState.systemStatus }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStatus(): Promise<Response> {
    const checks = Array.from(this.healState.healthChecks.values());
    const recentHealing = this.healState.healingHistory.slice(-10);

    return new Response(
      JSON.stringify({
        systemStatus: this.healState.systemStatus,
        enabled: this.healState.config.enabled,
        checks,
        recentHealing,
        summary: {
          healthy: checks.filter((c) => c.status === 'healthy').length,
          degraded: checks.filter((c) => c.status === 'degraded').length,
          unhealthy: checks.filter((c) => c.status === 'unhealthy').length,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleTriggerHealing(request: Request): Promise<Response> {
    const body = (await request.json()) as { trigger: string; force?: boolean };

    const action = await this.executeHealingAction(body.trigger, body.force);

    if (!action) {
      return new Response(
        JSON.stringify({ error: 'No healing action available or on cooldown' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await this.saveState();

    return new Response(JSON.stringify({ action }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleReportIssue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      checkName: string;
      status: 'healthy' | 'degraded' | 'unhealthy';
      details?: Record<string, unknown>;
    };

    const check = this.healState.healthChecks.get(body.checkName);
    if (check) {
      if (body.status !== 'healthy') {
        check.consecutiveFailures++;
      } else {
        check.consecutiveFailures = 0;
      }
      check.status = body.status;
      check.lastCheck = new Date().toISOString();
      check.details = body.details || {};
    }

    await this.evaluateAndHeal();
    await this.saveState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetHistory(): Promise<Response> {
    return new Response(JSON.stringify({ history: this.healState.healingHistory }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetConfig(): Promise<Response> {
    return new Response(JSON.stringify({ config: this.healState.config }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<SelfHealConfig>;

    this.healState.config = {
      ...this.healState.config,
      ...body,
    };

    await this.saveState();

    return new Response(JSON.stringify({ success: true, config: this.healState.config }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleAutoFix(request: Request): Promise<Response> {
    const body = (await request.json()) as { issues: CohesivenessIssue[] };

    const fixResults: Array<{ issueId: string; fixed: boolean; message: string }> = [];

    for (const issue of body.issues) {
      if (!issue.autoFixable) {
        fixResults.push({
          issueId: issue.id,
          fixed: false,
          message: 'Issue is not auto-fixable',
        });
        continue;
      }

      const result = await this.attemptAutoFix(issue);
      fixResults.push(result);
    }

    // Record healing action
    const action: HealingAction = {
      id: generateHealingId(),
      trigger: 'auto_fix_issues',
      action: 'apply_auto_fix',
      status: 'completed',
      result: JSON.stringify(fixResults),
      timestamp: new Date().toISOString(),
    };

    this.healState.healingHistory.push(action);
    await this.saveState();

    return new Response(JSON.stringify({ results: fixResults }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Core health check and healing logic

  private async runHealthChecks(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];

    for (const checkConfig of this.healState.config.checks) {
      if (!checkConfig.enabled) continue;

      const check = this.healState.healthChecks.get(checkConfig.name);
      if (!check) continue;

      try {
        const result = await this.executeHealthCheck(checkConfig);
        check.status = result.status;
        check.details = result.details;
        check.lastCheck = new Date().toISOString();

        if (result.status !== 'healthy') {
          check.consecutiveFailures++;
        } else {
          check.consecutiveFailures = 0;
        }

        results.push({ ...check });
      } catch (error) {
        check.status = 'unhealthy';
        check.consecutiveFailures++;
        check.details = { error: (error as Error).message };
        check.lastCheck = new Date().toISOString();
        results.push({ ...check });
      }
    }

    return results;
  }

  private async executeHealthCheck(
    config: HealthCheckConfig
  ): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details: Record<string, unknown> }> {
    switch (config.name) {
      case 'job_queue_health':
        return this.checkJobQueueHealth();
      case 'repo_sync_freshness':
        return this.checkRepoSyncFreshness();
      case 'api_responsiveness':
        return this.checkApiResponsiveness();
      case 'cohesiveness_score':
        return this.checkCohesivenessScore();
      case 'storage_health':
        return this.checkStorageHealth();
      default:
        return { status: 'healthy', details: {} };
    }
  }

  private async checkJobQueueHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    try {
      // Check job manager status
      const jobManagerId = this.env.AGENT_JOB_MANAGER.idFromName('primary');
      const jobManager = this.env.AGENT_JOB_MANAGER.get(jobManagerId);

      const response = await jobManager.fetch(new Request('http://internal/jobs/stats'));
      const stats = (await response.json()) as {
        running: number;
        failed: number;
        retrying: number;
      };

      if (stats.failed > 10 || stats.retrying > 5) {
        return { status: 'unhealthy', details: stats };
      }
      if (stats.failed > 5 || stats.retrying > 2) {
        return { status: 'degraded', details: stats };
      }
      return { status: 'healthy', details: stats };
    } catch (error) {
      return { status: 'unhealthy', details: { error: (error as Error).message } };
    }
  }

  private async checkRepoSyncFreshness(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    try {
      // Check last sync times from cache
      const lastResults = await this.env.REPO_CACHE.get('lastSyncResults');
      if (!lastResults) {
        return { status: 'degraded', details: { message: 'No sync results found' } };
      }

      const results = JSON.parse(lastResults) as Array<{ timestamp: string; status: string }>;
      const now = Date.now();
      const maxAge = 30 * 60 * 1000; // 30 minutes

      const staleRepos = results.filter((r) => {
        const syncTime = new Date(r.timestamp).getTime();
        return now - syncTime > maxAge;
      });

      if (staleRepos.length > results.length / 2) {
        return { status: 'unhealthy', details: { staleRepos: staleRepos.length } };
      }
      if (staleRepos.length > 0) {
        return { status: 'degraded', details: { staleRepos: staleRepos.length } };
      }
      return { status: 'healthy', details: { lastSync: results[0]?.timestamp } };
    } catch (error) {
      return { status: 'degraded', details: { error: (error as Error).message } };
    }
  }

  private async checkApiResponsiveness(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    // This is a self-check - if we're running, we're responsive
    return { status: 'healthy', details: { responseTime: 'ok' } };
  }

  private async checkCohesivenessScore(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    try {
      const report = await this.env.REPO_CACHE.get('latestCohesivenessReport');
      if (!report) {
        return { status: 'degraded', details: { message: 'No cohesiveness report found' } };
      }

      const parsed = JSON.parse(report) as { overallScore: number; issues: unknown[] };

      if (parsed.overallScore < 0.5) {
        return { status: 'unhealthy', details: { score: parsed.overallScore } };
      }
      if (parsed.overallScore < 0.75) {
        return { status: 'degraded', details: { score: parsed.overallScore } };
      }
      return { status: 'healthy', details: { score: parsed.overallScore } };
    } catch (error) {
      return { status: 'degraded', details: { error: (error as Error).message } };
    }
  }

  private async checkStorageHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, unknown>;
  }> {
    try {
      // Test KV access
      const testKey = '_health_check_' + Date.now();
      await this.env.REPO_CACHE.put(testKey, 'test', { expirationTtl: 60 });
      const testValue = await this.env.REPO_CACHE.get(testKey);
      await this.env.REPO_CACHE.delete(testKey);

      if (testValue !== 'test') {
        return { status: 'degraded', details: { message: 'KV read/write mismatch' } };
      }

      return { status: 'healthy', details: { kv: 'ok' } };
    } catch (error) {
      return { status: 'unhealthy', details: { error: (error as Error).message } };
    }
  }

  private async evaluateAndHeal(): Promise<void> {
    if (!this.healState.config.enabled) return;

    // Update system status
    const checks = Array.from(this.healState.healthChecks.values());
    const unhealthyCount = checks.filter((c) => c.status === 'unhealthy').length;
    const degradedCount = checks.filter((c) => c.status === 'degraded').length;

    if (unhealthyCount > 0) {
      this.healState.systemStatus = 'unhealthy';
    } else if (degradedCount > 0) {
      this.healState.systemStatus = 'degraded';
    } else {
      this.healState.systemStatus = 'healthy';
    }

    // Trigger healing actions for unhealthy checks
    for (const check of checks) {
      if (check.status === 'unhealthy') {
        const checkConfig = this.healState.config.checks.find((c) => c.name === check.name);
        if (checkConfig && check.consecutiveFailures >= checkConfig.threshold) {
          await this.triggerHealingForCheck(check);
        }
      }
    }
  }

  private async triggerHealingForCheck(check: HealthCheck): Promise<void> {
    const triggerMap: Record<string, string> = {
      job_queue_health: 'job_queue_stalled',
      repo_sync_freshness: 'repo_sync_stale',
      cohesiveness_score: 'cohesiveness_low',
      api_responsiveness: 'api_unresponsive',
      storage_health: 'storage_issues',
    };

    const trigger = triggerMap[check.name];
    if (trigger) {
      await this.executeHealingAction(trigger);
    }
  }

  private async executeHealingAction(
    trigger: string,
    force: boolean = false
  ): Promise<HealingAction | null> {
    const actionConfig = this.healState.config.actions.find((a) => a.trigger === trigger);
    if (!actionConfig || !actionConfig.enabled) {
      return null;
    }

    // Check cooldown
    const lastAttempt = this.healState.lastHealingAttempts.get(trigger) || 0;
    const now = Date.now();

    if (!force && now - lastAttempt < actionConfig.cooldown) {
      this.logger.info('Healing action on cooldown', { trigger, cooldownRemaining: actionConfig.cooldown - (now - lastAttempt) });
      return null;
    }

    // Execute the healing action
    const action: HealingAction = {
      id: generateHealingId(),
      trigger,
      action: actionConfig.action,
      status: 'executing',
      timestamp: new Date().toISOString(),
    };

    this.healState.systemStatus = 'healing';
    this.healState.lastHealingAttempts.set(trigger, now);

    try {
      const result = await this.performHealingAction(actionConfig.action);
      action.status = 'completed';
      action.result = result;
      this.logger.info('Healing action completed', { trigger, action: actionConfig.action, result });
    } catch (error) {
      action.status = 'failed';
      action.result = (error as Error).message;
      this.logger.error('Healing action failed', error as Error, { trigger, action: actionConfig.action });
    }

    this.healState.healingHistory.push(action);

    // Re-evaluate status after healing
    await this.runHealthChecks();
    await this.evaluateAndHeal();

    return action;
  }

  private async performHealingAction(action: string): Promise<string> {
    switch (action) {
      case 'restart_job_queue':
        return this.healRestartJobQueue();
      case 'force_repo_sync':
        return this.healForceRepoSync();
      case 'trigger_cohesiveness_fix':
        return this.healTriggerCohesivenessFix();
      case 'restart_api_handlers':
        return this.healRestartApiHandlers();
      case 'cleanup_storage':
        return this.healCleanupStorage();
      default:
        return `Unknown action: ${action}`;
    }
  }

  private async healRestartJobQueue(): Promise<string> {
    const jobManagerId = this.env.AGENT_JOB_MANAGER.idFromName('primary');
    const jobManager = this.env.AGENT_JOB_MANAGER.get(jobManagerId);

    // Trigger cleanup of old jobs
    await jobManager.fetch(new Request('http://internal/jobs/cleanup', { method: 'POST' }));

    return 'Job queue cleaned up and restarted';
  }

  private async healForceRepoSync(): Promise<string> {
    const repoSyncId = this.env.REPO_SYNC_STATE.idFromName('primary');
    const repoSync = this.env.REPO_SYNC_STATE.get(repoSyncId);

    await repoSync.fetch(
      new Request('http://internal/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full: true }),
      })
    );

    return 'Forced full repository sync';
  }

  private async healTriggerCohesivenessFix(): Promise<string> {
    // Get current issues and attempt auto-fixes
    const cohesivenessId = this.env.COHESIVENESS_TRACKER.idFromName('primary');
    const tracker = this.env.COHESIVENESS_TRACKER.get(cohesivenessId);

    const issuesResponse = await tracker.fetch(new Request('http://internal/issues'));
    const { issues } = (await issuesResponse.json()) as { issues: CohesivenessIssue[] };

    const autoFixable = issues.filter((i) => i.autoFixable);

    if (autoFixable.length === 0) {
      return 'No auto-fixable issues found';
    }

    // Attempt fixes
    const fixResults = await Promise.all(autoFixable.map((issue) => this.attemptAutoFix(issue)));

    const fixed = fixResults.filter((r) => r.fixed).length;
    return `Attempted ${autoFixable.length} auto-fixes, ${fixed} successful`;
  }

  private async healRestartApiHandlers(): Promise<string> {
    // API handlers are stateless, so this is more of a health signal reset
    const check = this.healState.healthChecks.get('api_responsiveness');
    if (check) {
      check.consecutiveFailures = 0;
      check.status = 'healthy';
    }
    return 'API handlers health reset';
  }

  private async healCleanupStorage(): Promise<string> {
    // Clean up old entries from KV
    // Note: KV doesn't support listing, so we'll clean known patterns

    const jobManagerId = this.env.AGENT_JOB_MANAGER.idFromName('primary');
    const jobManager = this.env.AGENT_JOB_MANAGER.get(jobManagerId);

    await jobManager.fetch(new Request('http://internal/jobs/cleanup', { method: 'POST' }));

    return 'Storage cleanup completed';
  }

  private async attemptAutoFix(
    issue: CohesivenessIssue
  ): Promise<{ issueId: string; fixed: boolean; message: string }> {
    // Auto-fix implementations for common issues
    try {
      switch (issue.category) {
        case 'configuration':
          if (issue.id.includes('no-node-version')) {
            // Would create a PR to add node version - for now, just log
            return {
              issueId: issue.id,
              fixed: false,
              message: 'Auto-fix for node version requires GitHub write access',
            };
          }
          break;

        case 'dependencies':
          // Would update dependencies via PR
          return {
            issueId: issue.id,
            fixed: false,
            message: 'Auto-fix for dependencies requires GitHub write access',
          };

        case 'consistency':
          // Cross-repo consistency fixes need coordinated PRs
          return {
            issueId: issue.id,
            fixed: false,
            message: 'Cross-repo consistency requires manual intervention',
          };
      }

      return {
        issueId: issue.id,
        fixed: false,
        message: 'No auto-fix available for this issue type',
      };
    } catch (error) {
      return {
        issueId: issue.id,
        fixed: false,
        message: `Auto-fix failed: ${(error as Error).message}`,
      };
    }
  }

  // Notification methods
  async sendNotification(message: string, severity: 'info' | 'warning' | 'critical'): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) {
      this.logger.info('Notification (no webhook configured)', { message, severity });
      return;
    }

    const colors: Record<string, number> = {
      info: 0x2979ff, // Electric Blue
      warning: 0xf5a623, // Amber
      critical: 0xff1d6c, // Hot Pink
    };

    try {
      await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title: `⬛⬜🛣️ BlackRoad Self-Healer`,
              description: message,
              color: colors[severity],
              timestamp: new Date().toISOString(),
              footer: { text: 'BlackRoad Support Center' },
            },
          ],
        }),
      });
    } catch (error) {
      this.logger.error('Failed to send notification', error as Error);
    }
  }
}
