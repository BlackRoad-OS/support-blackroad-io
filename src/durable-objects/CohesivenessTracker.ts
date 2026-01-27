/**
 * ⬛⬜🛣️ BlackRoad Support Center - Cohesiveness Tracker
 * Durable Object for tracking and enforcing consistency across repos
 */

import type {
  Env,
  CohesivenessReport,
  CohesivenessIssue,
  RepoCohesivenessScore,
  CohesivenessFactor,
} from '../types';
import { createLogger } from '../utils/logger';
import { generateReportId } from '../utils/id';

interface CohesivenessState {
  reports: CohesivenessReport[];
  currentIssues: CohesivenessIssue[];
  repoConfigs: Map<string, Record<string, unknown>>;
  standards: CohesivenessStandards;
}

interface CohesivenessStandards {
  requiredFiles: string[];
  requiredWorkflows: string[];
  brandColors: string[];
  forbiddenColors: string[];
  licenseType: string;
  nodeVersion: string;
  typescriptVersion: string;
  requiredDevDeps: string[];
  requiredScripts: string[];
}

const DEFAULT_STANDARDS: CohesivenessStandards = {
  requiredFiles: [
    'package.json',
    'tsconfig.json',
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    '.github/CODEOWNERS',
  ],
  requiredWorkflows: ['ci.yml', 'deploy.yml'],
  brandColors: ['#FF1D6C', '#F5A623', '#2979FF', '#9C27B0'],
  forbiddenColors: ['#FF9D00', '#FF6B00', '#FF0066', '#FF006B', '#D600AA', '#7700FF', '#0066FF'],
  licenseType: 'PROPRIETARY',
  nodeVersion: '>=18.0.0',
  typescriptVersion: '^5.0.0',
  requiredDevDeps: ['typescript', 'eslint', 'prettier'],
  requiredScripts: ['build', 'test', 'lint'],
};

export class CohesivenessTracker implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger;
  private cohesivenessState: CohesivenessState = {
    reports: [],
    currentIssues: [],
    repoConfigs: new Map(),
    standards: DEFAULT_STANDARDS,
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env, { durableObject: 'CohesivenessTracker' });

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CohesivenessState>('cohesivenessState');
      if (stored) {
        this.cohesivenessState = {
          reports: stored.reports || [],
          currentIssues: stored.currentIssues || [],
          repoConfigs: new Map(Object.entries(stored.repoConfigs || {})),
          standards: stored.standards || DEFAULT_STANDARDS,
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('cohesivenessState', {
      reports: this.cohesivenessState.reports.slice(-50), // Keep last 50 reports
      currentIssues: this.cohesivenessState.currentIssues,
      repoConfigs: Object.fromEntries(this.cohesivenessState.repoConfigs),
      standards: this.cohesivenessState.standards,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/check') {
        return this.handleCheck(request);
      }
      if (request.method === 'GET' && path === '/report') {
        return this.handleGetReport();
      }
      if (request.method === 'GET' && path === '/issues') {
        return this.handleGetIssues();
      }
      if (request.method === 'POST' && path === '/update-configs') {
        return this.handleUpdateConfigs(request);
      }
      if (request.method === 'GET' && path === '/standards') {
        return this.handleGetStandards();
      }
      if (request.method === 'PUT' && path === '/standards') {
        return this.handleUpdateStandards(request);
      }
      if (request.method === 'GET' && path === '/history') {
        return this.handleGetHistory();
      }
      if (request.method === 'POST' && path === '/resolve') {
        return this.handleResolveIssue(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      this.logger.error('Cohesiveness tracker error', error as Error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleCheck(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      configs: Record<string, Record<string, unknown>>;
    };

    // Update stored configs
    for (const [key, config] of Object.entries(body.configs)) {
      this.cohesivenessState.repoConfigs.set(key, config);
    }

    // Run cohesiveness check
    const report = this.runCohesivenessCheck();
    this.cohesivenessState.reports.push(report);
    this.cohesivenessState.currentIssues = report.issues;

    await this.saveState();

    // Cache report in KV
    await this.env.REPO_CACHE.put('latestCohesivenessReport', JSON.stringify(report), {
      expirationTtl: 3600,
    });

    this.logger.info('Cohesiveness check completed', {
      score: report.overallScore,
      issues: report.issues.length,
    });

    return new Response(JSON.stringify({ report }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetReport(): Promise<Response> {
    const latestReport = this.cohesivenessState.reports[this.cohesivenessState.reports.length - 1];

    return new Response(JSON.stringify({ report: latestReport || null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetIssues(): Promise<Response> {
    return new Response(JSON.stringify({ issues: this.cohesivenessState.currentIssues }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUpdateConfigs(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      configs: Record<string, Record<string, unknown>>;
    };

    for (const [key, config] of Object.entries(body.configs)) {
      this.cohesivenessState.repoConfigs.set(key, config);
    }

    await this.saveState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStandards(): Promise<Response> {
    return new Response(JSON.stringify({ standards: this.cohesivenessState.standards }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUpdateStandards(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<CohesivenessStandards>;

    this.cohesivenessState.standards = {
      ...this.cohesivenessState.standards,
      ...body,
    };

    await this.saveState();

    return new Response(JSON.stringify({ success: true, standards: this.cohesivenessState.standards }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetHistory(): Promise<Response> {
    return new Response(JSON.stringify({ reports: this.cohesivenessState.reports }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleResolveIssue(request: Request): Promise<Response> {
    const body = (await request.json()) as { issueId: string };

    const issueIndex = this.cohesivenessState.currentIssues.findIndex(
      (i) => i.id === body.issueId
    );

    if (issueIndex === -1) {
      return new Response(JSON.stringify({ error: 'Issue not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.cohesivenessState.currentIssues.splice(issueIndex, 1);
    await this.saveState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Core cohesiveness checking logic

  private runCohesivenessCheck(): CohesivenessReport {
    const repoScores: RepoCohesivenessScore[] = [];
    const issues: CohesivenessIssue[] = [];

    // Group configs by repo
    const repoConfigs = new Map<string, Map<string, Record<string, unknown>>>();

    for (const [key, config] of this.cohesivenessState.repoConfigs) {
      const [repo, ...pathParts] = key.split('/');
      if (!repo) continue;
      const path = pathParts.join('/');

      if (!repoConfigs.has(repo)) {
        repoConfigs.set(repo, new Map());
      }
      repoConfigs.get(repo)!.set(path, config);
    }

    // Check each repo
    for (const [repo, configs] of repoConfigs) {
      const { score, factors, repoIssues } = this.checkRepo(repo, configs);
      repoScores.push({ repo, score, factors });
      issues.push(...repoIssues);
    }

    // Check cross-repo consistency
    const crossRepoIssues = this.checkCrossRepoConsistency(repoConfigs);
    issues.push(...crossRepoIssues);

    // Calculate overall score
    const overallScore =
      repoScores.length > 0
        ? repoScores.reduce((sum, r) => sum + r.score, 0) / repoScores.length
        : 0;

    // Generate recommendations
    const recommendations = this.generateRecommendations(issues);

    return {
      id: generateReportId(),
      timestamp: new Date().toISOString(),
      overallScore: Math.round(overallScore * 100) / 100,
      repos: repoScores,
      issues,
      recommendations,
    };
  }

  private checkRepo(
    repo: string,
    configs: Map<string, Record<string, unknown>>
  ): {
    score: number;
    factors: CohesivenessFactor[];
    repoIssues: CohesivenessIssue[];
  } {
    const factors: CohesivenessFactor[] = [];
    const repoIssues: CohesivenessIssue[] = [];
    const standards = this.cohesivenessState.standards;

    // Check required files
    const fileScore = this.checkRequiredFiles(repo, configs, standards.requiredFiles, repoIssues);
    factors.push({ name: 'Required Files', weight: 0.2, score: fileScore });

    // Check package.json
    const packageJson = configs.get('package.json');
    if (packageJson) {
      const packageScore = this.checkPackageJson(repo, packageJson, standards, repoIssues);
      factors.push({ name: 'Package Configuration', weight: 0.25, score: packageScore });
    } else {
      factors.push({ name: 'Package Configuration', weight: 0.25, score: 0 });
      repoIssues.push({
        id: `${repo}-no-package`,
        severity: 'critical',
        category: 'configuration',
        repos: [repo],
        description: 'Missing package.json',
        suggestedFix: 'Add a package.json file with required configurations',
        autoFixable: false,
      });
    }

    // Check TypeScript config
    const tsConfig = configs.get('tsconfig.json');
    if (tsConfig) {
      const tsScore = this.checkTsConfig(repo, tsConfig, repoIssues);
      factors.push({ name: 'TypeScript Configuration', weight: 0.15, score: tsScore });
    } else {
      factors.push({ name: 'TypeScript Configuration', weight: 0.15, score: 0 });
    }

    // Check workflows
    const workflowScore = this.checkWorkflows(repo, configs, standards.requiredWorkflows, repoIssues);
    factors.push({ name: 'CI/CD Workflows', weight: 0.2, score: workflowScore });

    // Check license
    const licenseScore = this.checkLicense(repo, configs, standards.licenseType, repoIssues);
    factors.push({ name: 'Licensing', weight: 0.1, score: licenseScore });

    // Check documentation
    const docsScore = this.checkDocumentation(repo, configs, repoIssues);
    factors.push({ name: 'Documentation', weight: 0.1, score: docsScore });

    // Calculate weighted score
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const score = factors.reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight;

    return { score, factors, repoIssues };
  }

  private checkRequiredFiles(
    repo: string,
    configs: Map<string, Record<string, unknown>>,
    requiredFiles: string[],
    issues: CohesivenessIssue[]
  ): number {
    let found = 0;

    for (const file of requiredFiles) {
      if (configs.has(file)) {
        found++;
      } else {
        issues.push({
          id: `${repo}-missing-${file.replace(/\//g, '-')}`,
          severity: 'warning',
          category: 'files',
          repos: [repo],
          description: `Missing required file: ${file}`,
          suggestedFix: `Add ${file} to the repository`,
          autoFixable: false,
        });
      }
    }

    return requiredFiles.length > 0 ? found / requiredFiles.length : 1;
  }

  private checkPackageJson(
    repo: string,
    packageJson: Record<string, unknown>,
    standards: CohesivenessStandards,
    issues: CohesivenessIssue[]
  ): number {
    let score = 1;

    // Check Node version
    const engines = packageJson.engines as { node?: string } | undefined;
    if (!engines?.node) {
      score -= 0.1;
      issues.push({
        id: `${repo}-no-node-version`,
        severity: 'warning',
        category: 'configuration',
        repos: [repo],
        description: 'No Node.js version specified in engines',
        suggestedFix: `Add "engines": { "node": "${standards.nodeVersion}" }`,
        autoFixable: true,
      });
    }

    // Check required scripts
    const scripts = packageJson.scripts as Record<string, string> | undefined;
    if (scripts) {
      for (const script of standards.requiredScripts) {
        if (!scripts[script]) {
          score -= 0.1;
          issues.push({
            id: `${repo}-missing-script-${script}`,
            severity: 'info',
            category: 'configuration',
            repos: [repo],
            description: `Missing npm script: ${script}`,
            suggestedFix: `Add "${script}" script to package.json`,
            autoFixable: false,
          });
        }
      }
    }

    // Check required devDependencies
    const devDeps = packageJson.devDependencies as Record<string, string> | undefined;
    if (devDeps) {
      for (const dep of standards.requiredDevDeps) {
        if (!devDeps[dep]) {
          score -= 0.05;
          issues.push({
            id: `${repo}-missing-devdep-${dep}`,
            severity: 'info',
            category: 'dependencies',
            repos: [repo],
            description: `Missing recommended devDependency: ${dep}`,
            suggestedFix: `Add ${dep} to devDependencies`,
            autoFixable: true,
          });
        }
      }
    }

    return Math.max(0, score);
  }

  private checkTsConfig(
    repo: string,
    tsConfig: Record<string, unknown>,
    issues: CohesivenessIssue[]
  ): number {
    let score = 1;

    const compilerOptions = tsConfig.compilerOptions as Record<string, unknown> | undefined;
    if (!compilerOptions) {
      return 0.5;
    }

    // Check strict mode
    if (!compilerOptions.strict) {
      score -= 0.2;
      issues.push({
        id: `${repo}-ts-not-strict`,
        severity: 'warning',
        category: 'configuration',
        repos: [repo],
        description: 'TypeScript strict mode is not enabled',
        suggestedFix: 'Set "strict": true in tsconfig.json',
        autoFixable: true,
      });
    }

    return Math.max(0, score);
  }

  private checkWorkflows(
    repo: string,
    configs: Map<string, Record<string, unknown>>,
    requiredWorkflows: string[],
    issues: CohesivenessIssue[]
  ): number {
    let found = 0;

    for (const workflow of requiredWorkflows) {
      const workflowPath = `.github/workflows/${workflow}`;
      if (configs.has(workflowPath)) {
        found++;
      } else {
        issues.push({
          id: `${repo}-missing-workflow-${workflow}`,
          severity: 'warning',
          category: 'ci-cd',
          repos: [repo],
          description: `Missing required workflow: ${workflow}`,
          suggestedFix: `Add ${workflowPath} workflow file`,
          autoFixable: false,
        });
      }
    }

    return requiredWorkflows.length > 0 ? found / requiredWorkflows.length : 1;
  }

  private checkLicense(
    repo: string,
    configs: Map<string, Record<string, unknown>>,
    requiredType: string,
    issues: CohesivenessIssue[]
  ): number {
    const license = configs.get('LICENSE');
    if (!license) {
      issues.push({
        id: `${repo}-no-license`,
        severity: 'critical',
        category: 'legal',
        repos: [repo],
        description: 'Missing LICENSE file',
        suggestedFix: 'Add a LICENSE file',
        autoFixable: false,
      });
      return 0;
    }

    const raw = license._raw as string | undefined;
    if (raw && !raw.includes(requiredType) && !raw.includes('BlackRoad')) {
      issues.push({
        id: `${repo}-wrong-license`,
        severity: 'warning',
        category: 'legal',
        repos: [repo],
        description: `License may not match required type: ${requiredType}`,
        suggestedFix: 'Verify license matches organizational standards',
        autoFixable: false,
      });
      return 0.5;
    }

    return 1;
  }

  private checkDocumentation(
    repo: string,
    configs: Map<string, Record<string, unknown>>,
    issues: CohesivenessIssue[]
  ): number {
    let score = 1;

    if (!configs.has('README.md')) {
      score -= 0.5;
      issues.push({
        id: `${repo}-no-readme`,
        severity: 'warning',
        category: 'documentation',
        repos: [repo],
        description: 'Missing README.md',
        suggestedFix: 'Add a README.md with project documentation',
        autoFixable: false,
      });
    }

    if (!configs.has('CONTRIBUTING.md')) {
      score -= 0.3;
    }

    return Math.max(0, score);
  }

  private checkCrossRepoConsistency(
    repoConfigs: Map<string, Map<string, Record<string, unknown>>>
  ): CohesivenessIssue[] {
    const issues: CohesivenessIssue[] = [];
    const repos = Array.from(repoConfigs.keys());

    if (repos.length < 2) return issues;

    // Check TypeScript version consistency
    const tsVersions = new Map<string, string[]>();
    for (const [repo, configs] of repoConfigs) {
      const packageJson = configs.get('package.json');
      if (packageJson) {
        const devDeps = packageJson.devDependencies as Record<string, string> | undefined;
        if (devDeps?.typescript) {
          const version = devDeps.typescript;
          if (!tsVersions.has(version)) {
            tsVersions.set(version, []);
          }
          tsVersions.get(version)!.push(repo);
        }
      }
    }

    if (tsVersions.size > 1) {
      issues.push({
        id: 'cross-repo-ts-version-mismatch',
        severity: 'warning',
        category: 'consistency',
        repos,
        description: `TypeScript version mismatch across repos: ${Array.from(tsVersions.entries())
          .map(([v, r]) => `${v} (${r.join(', ')})`)
          .join(' vs ')}`,
        suggestedFix: 'Standardize TypeScript version across all repositories',
        autoFixable: true,
      });
    }

    // Check Node version consistency
    const nodeVersions = new Map<string, string[]>();
    for (const [repo, configs] of repoConfigs) {
      const packageJson = configs.get('package.json');
      if (packageJson) {
        const engines = packageJson.engines as { node?: string } | undefined;
        if (engines?.node) {
          const version = engines.node;
          if (!nodeVersions.has(version)) {
            nodeVersions.set(version, []);
          }
          nodeVersions.get(version)!.push(repo);
        }
      }
    }

    if (nodeVersions.size > 1) {
      issues.push({
        id: 'cross-repo-node-version-mismatch',
        severity: 'info',
        category: 'consistency',
        repos,
        description: `Node.js version requirement mismatch across repos`,
        suggestedFix: 'Consider standardizing Node.js version requirements',
        autoFixable: true,
      });
    }

    return issues;
  }

  private generateRecommendations(issues: CohesivenessIssue[]): string[] {
    const recommendations: string[] = [];

    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const autoFixableCount = issues.filter((i) => i.autoFixable).length;

    if (criticalCount > 0) {
      recommendations.push(
        `Address ${criticalCount} critical issue(s) immediately to ensure compliance`
      );
    }

    if (warningCount > 3) {
      recommendations.push(
        `Consider scheduling a maintenance sprint to address ${warningCount} warnings`
      );
    }

    if (autoFixableCount > 0) {
      recommendations.push(
        `${autoFixableCount} issue(s) can be auto-fixed - consider running the self-healer`
      );
    }

    const consistencyIssues = issues.filter((i) => i.category === 'consistency');
    if (consistencyIssues.length > 0) {
      recommendations.push(
        'Cross-repo inconsistencies detected - consider creating shared configuration packages'
      );
    }

    return recommendations;
  }
}
