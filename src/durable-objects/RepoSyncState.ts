/**
 * ⬛⬜🛣️ BlackRoad Support Center - Repository Sync State
 * Durable Object for tracking repo sync state and managing scraped data
 */

import type { Env, RepoInfo, RepoSyncResult, RepoContent } from '../types';
import { GitHubClient } from '../services/github';
import { createLogger } from '../utils/logger';
import { generateReportId } from '../utils/id';

interface SyncState {
  repos: Map<string, RepoInfo>;
  lastSync: Map<string, string>;
  syncHistory: RepoSyncResult[];
  fileIndex: Map<string, string[]>; // repo -> file paths
  configFiles: Map<string, Record<string, unknown>>; // path -> parsed config
}

interface SyncOptions {
  repos?: string[];
  full?: boolean;
  includeContent?: boolean;
}

// Important files to track for cohesiveness
const IMPORTANT_FILES = [
  'package.json',
  'wrangler.toml',
  'tsconfig.json',
  '.eslintrc.json',
  '.prettierrc',
  'CONTRIBUTING.md',
  'LICENSE',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy.yml',
  '.github/CODEOWNERS',
  'README.md',
];

export class RepoSyncState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger;
  private github: GitHubClient;
  private syncState: SyncState = {
    repos: new Map(),
    lastSync: new Map(),
    syncHistory: [],
    fileIndex: new Map(),
    configFiles: new Map(),
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env, { durableObject: 'RepoSyncState' });
    this.github = new GitHubClient(env);

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SyncState>('syncState');
      if (stored) {
        this.syncState = {
          repos: new Map(Object.entries(stored.repos || {})),
          lastSync: new Map(Object.entries(stored.lastSync || {})),
          syncHistory: stored.syncHistory || [],
          fileIndex: new Map(Object.entries(stored.fileIndex || {})),
          configFiles: new Map(Object.entries(stored.configFiles || {})),
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('syncState', {
      repos: Object.fromEntries(this.syncState.repos),
      lastSync: Object.fromEntries(this.syncState.lastSync),
      syncHistory: this.syncState.syncHistory.slice(-100), // Keep last 100 syncs
      fileIndex: Object.fromEntries(this.syncState.fileIndex),
      configFiles: Object.fromEntries(this.syncState.configFiles),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST' && path === '/sync') {
        return this.handleSync(request);
      }
      if (request.method === 'GET' && path === '/repos') {
        return this.handleGetRepos();
      }
      if (request.method === 'GET' && path.startsWith('/repos/')) {
        const repoName = path.split('/')[2];
        if (repoName) return this.handleGetRepo(repoName);
      }
      if (request.method === 'GET' && path === '/status') {
        return this.handleGetStatus();
      }
      if (request.method === 'GET' && path === '/files') {
        return this.handleGetFiles(url.searchParams.get('repo') || undefined);
      }
      if (request.method === 'GET' && path === '/configs') {
        return this.handleGetConfigs();
      }
      if (request.method === 'GET' && path === '/history') {
        return this.handleGetHistory();
      }
      if (request.method === 'POST' && path === '/scrape') {
        return this.handleScrapeRepo(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      this.logger.error('Repo sync error', error as Error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleSync(request: Request): Promise<Response> {
    const options = (await request.json()) as SyncOptions;
    const results = await this.syncRepos(options);

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetRepos(): Promise<Response> {
    const repos = Array.from(this.syncState.repos.values());

    return new Response(JSON.stringify({ repos }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetRepo(repoName: string): Promise<Response> {
    const repo = this.syncState.repos.get(repoName);
    const lastSync = this.syncState.lastSync.get(repoName);
    const files = this.syncState.fileIndex.get(repoName) || [];

    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repo not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ repo, lastSync, fileCount: files.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStatus(): Promise<Response> {
    const repoCount = this.syncState.repos.size;
    const lastSyncs = Object.fromEntries(this.syncState.lastSync);
    const totalFiles = Array.from(this.syncState.fileIndex.values()).reduce(
      (sum, files) => sum + files.length,
      0
    );

    return new Response(
      JSON.stringify({
        repoCount,
        totalFiles,
        lastSyncs,
        configFilesTracked: this.syncState.configFiles.size,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleGetFiles(repo?: string): Promise<Response> {
    if (repo) {
      const files = this.syncState.fileIndex.get(repo) || [];
      return new Response(JSON.stringify({ repo, files }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const allFiles = Object.fromEntries(this.syncState.fileIndex);
    return new Response(JSON.stringify({ files: allFiles }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetConfigs(): Promise<Response> {
    const configs = Object.fromEntries(this.syncState.configFiles);

    return new Response(JSON.stringify({ configs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetHistory(): Promise<Response> {
    return new Response(JSON.stringify({ history: this.syncState.syncHistory }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleScrapeRepo(request: Request): Promise<Response> {
    const body = (await request.json()) as { repo: string; paths?: string[] };
    const result = await this.scrapeRepository(body.repo, body.paths);

    return new Response(JSON.stringify({ result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Core sync methods

  async syncRepos(options: SyncOptions = {}): Promise<RepoSyncResult[]> {
    const results: RepoSyncResult[] = [];

    // Get target repos
    let targetRepos: string[];
    if (options.repos && options.repos.length > 0) {
      targetRepos = options.repos;
    } else {
      // Use primary repos from env
      targetRepos = this.env.PRIMARY_REPOS?.split(',') || [];
    }

    this.logger.info('Starting repo sync', { repos: targetRepos, full: options.full });

    for (const repoName of targetRepos) {
      const result = await this.syncSingleRepo(repoName, options);
      results.push(result);
      this.syncState.syncHistory.push(result);
    }

    await this.saveState();

    // Cache results in KV for quick access
    await this.env.REPO_CACHE.put('lastSyncResults', JSON.stringify(results), {
      expirationTtl: 3600, // 1 hour
    });

    return results;
  }

  private async syncSingleRepo(
    repoName: string,
    options: SyncOptions
  ): Promise<RepoSyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let filesScanned = 0;
    let filesUpdated = 0;

    try {
      // Fetch repo info
      const repoInfo = await this.github.getRepo(repoName);
      if (!repoInfo) {
        throw new Error(`Repository ${repoName} not found`);
      }

      // Check if we need a full sync
      const lastSync = this.syncState.lastSync.get(repoName);
      const needsFullSync =
        options.full || !lastSync || this.isStale(lastSync, repoInfo.lastPushed);

      if (needsFullSync) {
        // Get full repo tree
        const tree = await this.github.getRepoTree(repoName);
        const filePaths = tree.filter((item) => item.type === 'file').map((item) => item.path);

        this.syncState.fileIndex.set(repoName, filePaths);
        filesScanned = filePaths.length;

        // Fetch important config files
        for (const importantFile of IMPORTANT_FILES) {
          if (filePaths.includes(importantFile)) {
            try {
              const content = await this.github.getFileContent(repoName, importantFile);
              if (content) {
                const key = `${repoName}/${importantFile}`;
                const parsed = this.parseConfigFile(importantFile, content);
                if (parsed) {
                  this.syncState.configFiles.set(key, parsed);
                  filesUpdated++;
                }
              }
            } catch (e) {
              errors.push(`Failed to fetch ${importantFile}: ${(e as Error).message}`);
            }
          }
        }
      }

      // Update repo info
      repoInfo.lastSynced = new Date().toISOString();
      this.syncState.repos.set(repoName, repoInfo);
      this.syncState.lastSync.set(repoName, new Date().toISOString());

      return {
        repo: repoName,
        status: errors.length > 0 ? 'partial' : 'success',
        filesScanned,
        filesUpdated,
        errors,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Repo sync failed', error as Error, { repo: repoName });

      return {
        repo: repoName,
        status: 'failed',
        filesScanned: 0,
        filesUpdated: 0,
        errors: [(error as Error).message],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async scrapeRepository(
    repoName: string,
    paths?: string[]
  ): Promise<{ files: Record<string, string>; errors: string[] }> {
    const files: Record<string, string> = {};
    const errors: string[] = [];

    const targetPaths = paths || IMPORTANT_FILES;

    for (const path of targetPaths) {
      try {
        const content = await this.github.getFileContent(repoName, path);
        if (content) {
          files[path] = content;
        }
      } catch (e) {
        errors.push(`${path}: ${(e as Error).message}`);
      }
    }

    this.logger.info('Repository scraped', {
      repo: repoName,
      filesFound: Object.keys(files).length,
      errors: errors.length,
    });

    return { files, errors };
  }

  private isStale(lastSync: string, lastPushed: string): boolean {
    const syncDate = new Date(lastSync);
    const pushDate = new Date(lastPushed);
    return pushDate > syncDate;
  }

  private parseConfigFile(
    filename: string,
    content: string
  ): Record<string, unknown> | null {
    try {
      if (filename.endsWith('.json')) {
        return JSON.parse(content) as Record<string, unknown>;
      }
      if (filename === 'wrangler.toml') {
        // Simple TOML parser for key configs
        return this.parseSimpleToml(content);
      }
      // For other files, store as raw content
      return { _raw: content };
    } catch {
      return null;
    }
  }

  private parseSimpleToml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentSection = '';

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') continue;

      // Section header
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        currentSection = trimmed.slice(1, -1);
        result[currentSection] = {};
        continue;
      }

      // Key-value pair
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value: unknown = trimmed.slice(eqIndex + 1).trim();

        // Parse value
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (typeof value === 'string' && !isNaN(Number(value))) value = Number(value);
        else if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }

        if (currentSection) {
          (result[currentSection] as Record<string, unknown>)[key] = value;
        } else {
          result[key] = value;
        }
      }
    }

    return result;
  }

  // Methods for accessing sync data

  getRepoInfo(repoName: string): RepoInfo | undefined {
    return this.syncState.repos.get(repoName);
  }

  getAllRepos(): RepoInfo[] {
    return Array.from(this.syncState.repos.values());
  }

  getConfigFile(repoName: string, filename: string): Record<string, unknown> | undefined {
    return this.syncState.configFiles.get(`${repoName}/${filename}`);
  }

  getFileList(repoName: string): string[] {
    return this.syncState.fileIndex.get(repoName) || [];
  }
}
