import axios from 'axios';
import { logger } from '../utils/logger.js';

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  enabled?: boolean;
}

export interface GitHubIssuePayload {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export class GitHubIssuesService {
  private config: GitHubConfig;
  private get baseUrl() {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues`;
  }

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async createIssue(payload: GitHubIssuePayload): Promise<{ number: number; url: string } | null> {
    if (!this.config.enabled || !this.config.token || !this.config.owner || !this.config.repo) {
      logger.warn('[GitHub] disabled or missing config');
      return null;
    }
    try {
      const resp = await axios.post(this.baseUrl, payload, { headers: this.headers(), timeout: 10000 });
      logger.info('[GitHub] issue created', { number: resp.data.number });
      return { number: resp.data.number, url: resp.data.html_url };
    } catch (e: any) {
      logger.error('[GitHub] createIssue failed', { message: e.message });
      return null;
    }
  }

  async closeIssue(issueNumber: number): Promise<boolean> {
    if (!this.config.enabled || !this.config.token || !this.config.owner || !this.config.repo) return false;
    try {
      await axios.patch(`${this.baseUrl}/${issueNumber}`, { state: 'closed' }, { headers: this.headers(), timeout: 10000 });
      logger.info('[GitHub] issue closed', { number: issueNumber });
      return true;
    } catch (e: any) {
      logger.error('[GitHub] closeIssue failed', { message: e.message });
      return false;
    }
  }

  async listOpenIssues(): Promise<{ number: number; title: string; url: string }[]> {
    if (!this.config.enabled || !this.config.token || !this.config.owner || !this.config.repo) return [];
    try {
      const resp = await axios.get(this.baseUrl, {
        headers: this.headers(),
        params: { state: 'open', per_page: 50 },
        timeout: 10000,
      });
      return resp.data.map((i: any) => ({ number: i.number, title: i.title, url: i.html_url }));
    } catch (e: any) {
      logger.error('[GitHub] listOpenIssues failed', { message: e.message });
      return [];
    }
  }
}
