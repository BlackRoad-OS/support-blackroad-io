/**
 * ⬛⬜🛣️ BlackRoad Support Center - GitHub API Client
 * Scrape and sync repositories from GitHub
 */

import type { RepoInfo, RepoContent, Env } from '../types';
import { createLogger } from '../utils/logger';

interface GitHubApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
  rateLimit?: {
    remaining: number;
    reset: number;
  };
}

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  topics: string[];
  visibility: string;
  pushed_at: string;
}

interface GitHubContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink';
  content?: string;
  encoding?: string;
}

interface GitHubTree {
  sha: string;
  tree: Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size?: number;
  }>;
  truncated: boolean;
}

export class GitHubClient {
  private baseUrl = 'https://api.github.com';
  private token: string | undefined;
  private org: string;
  private logger;

  constructor(env: Env) {
    this.token = env.GITHUB_TOKEN;
    this.org = env.BLACKROAD_ORG || 'BlackRoad-OS';
    this.logger = createLogger(env, { service: 'github' });
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<GitHubApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'BlackRoad-Support-Center/1.0',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers },
      });

      const rateLimit = {
        remaining: parseInt(response.headers.get('X-RateLimit-Remaining') || '60'),
        reset: parseInt(response.headers.get('X-RateLimit-Reset') || '0'),
      };

      if (!response.ok) {
        const error = await response.text();
        this.logger.warn('GitHub API error', { endpoint, status: response.status, error });
        return { error, status: response.status, rateLimit };
      }

      const data = (await response.json()) as T;
      return { data, status: response.status, rateLimit };
    } catch (error) {
      this.logger.error('GitHub API request failed', error as Error, { endpoint });
      return { error: (error as Error).message, status: 0 };
    }
  }

  /**
   * Get all repositories for the organization
   */
  async getOrgRepos(): Promise<RepoInfo[]> {
    const repos: RepoInfo[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await this.fetch<GitHubRepo[]>(
        `/orgs/${this.org}/repos?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`
      );

      if (!response.data || response.data.length === 0) break;

      for (const repo of response.data) {
        repos.push(this.mapRepo(repo));
      }

      if (response.data.length < perPage) break;
      page++;
    }

    this.logger.info('Fetched org repos', { org: this.org, count: repos.length });
    return repos;
  }

  /**
   * Get a specific repository
   */
  async getRepo(repoName: string): Promise<RepoInfo | null> {
    const response = await this.fetch<GitHubRepo>(`/repos/${this.org}/${repoName}`);

    if (!response.data) {
      this.logger.warn('Repo not found', { repo: repoName });
      return null;
    }

    return this.mapRepo(response.data);
  }

  /**
   * Get repository contents at a path
   */
  async getContents(repoName: string, path: string = ''): Promise<RepoContent[]> {
    const response = await this.fetch<GitHubContent | GitHubContent[]>(
      `/repos/${this.org}/${repoName}/contents/${path}`
    );

    if (!response.data) return [];

    const contents = Array.isArray(response.data) ? response.data : [response.data];

    return contents.map((item) => ({
      path: item.path,
      type: item.type,
      sha: item.sha,
      size: item.size,
      content: item.content,
      encoding: item.encoding,
    }));
  }

  /**
   * Get file content decoded
   */
  async getFileContent(repoName: string, path: string): Promise<string | null> {
    const response = await this.fetch<GitHubContent>(
      `/repos/${this.org}/${repoName}/contents/${path}`
    );

    if (!response.data?.content) return null;

    // GitHub returns base64 encoded content
    try {
      return atob(response.data.content.replace(/\n/g, ''));
    } catch {
      this.logger.warn('Failed to decode file content', { repo: repoName, path });
      return null;
    }
  }

  /**
   * Get full repository tree (recursive)
   */
  async getRepoTree(repoName: string, branch?: string): Promise<RepoContent[]> {
    // First get the default branch if not specified
    const repo = await this.getRepo(repoName);
    if (!repo) return [];

    const ref = branch || repo.defaultBranch;

    const response = await this.fetch<GitHubTree>(
      `/repos/${this.org}/${repoName}/git/trees/${ref}?recursive=1`
    );

    if (!response.data) return [];

    if (response.data.truncated) {
      this.logger.warn('Repository tree was truncated', { repo: repoName });
    }

    return response.data.tree.map((item) => ({
      path: item.path,
      type: item.type === 'blob' ? 'file' : 'dir',
      sha: item.sha,
      size: item.size,
    }));
  }

  /**
   * Get repository languages
   */
  async getRepoLanguages(repoName: string): Promise<Record<string, number>> {
    const response = await this.fetch<Record<string, number>>(
      `/repos/${this.org}/${repoName}/languages`
    );

    return response.data || {};
  }

  /**
   * Get repository topics
   */
  async getRepoTopics(repoName: string): Promise<string[]> {
    const response = await this.fetch<{ names: string[] }>(
      `/repos/${this.org}/${repoName}/topics`
    );

    return response.data?.names || [];
  }

  /**
   * Get recent commits
   */
  async getRecentCommits(
    repoName: string,
    since?: Date,
    limit: number = 30
  ): Promise<
    Array<{
      sha: string;
      message: string;
      author: string;
      date: string;
    }>
  > {
    let url = `/repos/${this.org}/${repoName}/commits?per_page=${limit}`;
    if (since) {
      url += `&since=${since.toISOString()}`;
    }

    const response = await this.fetch<
      Array<{
        sha: string;
        commit: {
          message: string;
          author: { name: string; date: string };
        };
      }>
    >(url);

    if (!response.data) return [];

    return response.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0] ?? commit.commit.message,
      author: commit.commit.author.name,
      date: commit.commit.author.date,
    }));
  }

  /**
   * Get open issues and PRs count
   */
  async getOpenIssuesCount(repoName: string): Promise<{ issues: number; prs: number }> {
    const [issuesResponse, prsResponse] = await Promise.all([
      this.fetch<Array<unknown>>(
        `/repos/${this.org}/${repoName}/issues?state=open&per_page=1`
      ),
      this.fetch<Array<unknown>>(
        `/repos/${this.org}/${repoName}/pulls?state=open&per_page=1`
      ),
    ]);

    // Note: This is a simplified count - for accurate counts we'd need to parse Link headers
    return {
      issues: issuesResponse.data?.length || 0,
      prs: prsResponse.data?.length || 0,
    };
  }

  /**
   * Search code across repos
   */
  async searchCode(
    query: string,
    repos?: string[]
  ): Promise<
    Array<{
      repo: string;
      path: string;
      sha: string;
      score: number;
    }>
  > {
    let searchQuery = `org:${this.org} ${query}`;
    if (repos && repos.length > 0) {
      const repoQueries = repos.map((r) => `repo:${this.org}/${r}`).join(' ');
      searchQuery = `${repoQueries} ${query}`;
    }

    const response = await this.fetch<{
      items: Array<{
        repository: { name: string };
        path: string;
        sha: string;
        score: number;
      }>;
    }>(`/search/code?q=${encodeURIComponent(searchQuery)}&per_page=100`);

    if (!response.data) return [];

    return response.data.items.map((item) => ({
      repo: item.repository.name,
      path: item.path,
      sha: item.sha,
      score: item.score,
    }));
  }

  /**
   * Get rate limit status
   */
  async getRateLimit(): Promise<{
    remaining: number;
    limit: number;
    reset: Date;
  }> {
    const response = await this.fetch<{
      rate: { remaining: number; limit: number; reset: number };
    }>('/rate_limit');

    if (!response.data) {
      return { remaining: 0, limit: 60, reset: new Date() };
    }

    return {
      remaining: response.data.rate.remaining,
      limit: response.data.rate.limit,
      reset: new Date(response.data.rate.reset * 1000),
    };
  }

  private mapRepo(repo: GitHubRepo): RepoInfo {
    return {
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description || undefined,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      language: repo.language || undefined,
      topics: repo.topics || [],
      visibility: repo.visibility as 'public' | 'private' | 'internal',
      lastPushed: repo.pushed_at,
    };
  }
}
