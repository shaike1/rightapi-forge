// Jira integration skill

import type { Skill } from '../types/index.js';
import axios from 'axios';
import { encode, ok, fail } from './SkillResult.js';

export class JiraSkill {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor() {
    this.baseUrl = process.env.JIRA_BASE_URL || '';
    this.email = process.env.JIRA_EMAIL || '';
    this.apiToken = process.env.JIRA_API_TOKEN || '';
  }

  getSkill(): Skill {
    return {
      id: 'jira',
      name: 'Jira Service Management',
      description: 'Manage Jira tickets, issues, and service desk requests',
      category: 'service-management',
      enabled: true,
      commands: [
        {
          name: 'jira.search',
          description: 'Search for Jira issues',
          handler: 'jiraSearch',
          parameters: { jql: 'string', maxResults: 'number' }
        },
        {
          name: 'jira.get',
          description: 'Get issue details',
          handler: 'jiraGet',
          parameters: { issueKey: 'string' }
        },
        {
          name: 'jira.create',
          description: 'Create a new Jira issue',
          handler: 'jiraCreate',
          parameters: { 
            projectKey: 'string', 
            issueType: 'string', 
            summary: 'string', 
            description: 'string',
            priority: 'string'
          }
        },
        {
          name: 'jira.update',
          description: 'Update an existing issue',
          handler: 'jiraUpdate',
          parameters: { issueKey: 'string', fields: 'object' }
        },
        {
          name: 'jira.comment',
          description: 'Add comment to issue',
          handler: 'jiraComment',
          parameters: { issueKey: 'string', comment: 'string' }
        },
        {
          name: 'jira.assign',
          description: 'Assign issue to user',
          handler: 'jiraAssign',
          parameters: { issueKey: 'string', assignee: 'string' }
        },
        {
          name: 'jira.transition',
          description: 'Transition issue to new status',
          handler: 'jiraTransition',
          parameters: { issueKey: 'string', transitionId: 'string' }
        },
        {
          name: 'jira.listprojects',
          description: 'List all projects',
          handler: 'jiraListProjects'
        },
        {
          name: 'jira.myissues',
          description: 'Get my assigned issues',
          handler: 'jiraMyIssues'
        },
        {
          name: 'jira.sprints',
          description: 'List active sprints',
          handler: 'jiraSprints',
          parameters: { boardId: 'string' }
        }
      ]
    };
  }

  private async makeRequest(method: string, endpoint: string, data?: unknown, summary?: string): Promise<string> {
    if (!this.baseUrl || !this.apiToken) {
      return encode(fail('Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.'));
    }

    try {
      const url = this.baseUrl + '/rest/api/3/' + endpoint;
      const response = await axios({
        method,
        url,
        data,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(this.email + ':' + this.apiToken).toString('base64'),
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });
      return encode(ok({ status: response.status, body: response.data }, summary || `${method} ${endpoint} → ${response.status}`));
    } catch (error: unknown) {
      const err = error as any;
      if (axios.isAxiosError(err) && err.response) {
        const detail = typeof err.response.data === 'string'
          ? err.response.data
          : JSON.stringify(err.response.data);
        return encode(fail(
          `${method} ${endpoint}: ${err.response.status} ${err.response.statusText} — ${detail.slice(0, 500)}`,
          `jira ${err.response.status}`
        ));
      }
      return encode(fail(`${method} ${endpoint}: ${err?.code || ''} ${err?.message || String(err)}`.trim(), 'jira request failed'));
    }
  }

  async jiraSearch(params: { jql: string; maxResults?: number }): Promise<string> {
    const maxResults = params.maxResults || 50;
    const jql = encodeURIComponent(params.jql);
    return this.makeRequest('GET', 'search?jql=' + jql + '&maxResults=' + maxResults);
  }

  async jiraGet(params: { issueKey: string }): Promise<string> {
    return this.makeRequest('GET', 'issue/' + params.issueKey);
  }

  async jiraCreate(params: { 
    projectKey: string; 
    issueType: string; 
    summary: string; 
    description?: string;
    priority?: string;
  }): Promise<string> {
    const data = {
      fields: {
        project: { key: params.projectKey },
        issuetype: { name: params.issueType },
        summary: params.summary,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: params.description || '' }]
            }
          ]
        }
      }
    };
    if (params.priority) {
      (data.fields as any).priority = { name: params.priority };
    }
    return this.makeRequest('POST', 'issue', data);
  }

  async jiraUpdate(params: { issueKey: string; fields: unknown }): Promise<string> {
    return this.makeRequest('PUT', 'issue/' + params.issueKey + '?notifyUsers=false', { fields: params.fields });
  }

  async jiraComment(params: { issueKey: string; comment: string }): Promise<string> {
    const data = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: params.comment }]
          }
        ]
      }
    };
    return this.makeRequest('POST', 'issue/' + params.issueKey + '/comment', data);
  }

  async jiraAssign(params: { issueKey: string; assignee: string }): Promise<string> {
    return this.makeRequest('PUT', 'issue/' + params.issueKey + '/assignee', { name: params.assignee });
  }

  async jiraTransition(params: { issueKey: string; transitionId: string }): Promise<string> {
    const data = {
      transition: { id: params.transitionId }
    };
    return this.makeRequest('POST', 'issue/' + params.issueKey + '/transitions', data);
  }

  async jiraListProjects(): Promise<string> {
    return this.makeRequest('GET', 'project');
  }

  async jiraMyIssues(): Promise<string> {
    const jql = encodeURIComponent('assignee = currentUser() ORDER BY updated DESC');
    return this.makeRequest('GET', 'search?jql=' + jql + '&maxResults=20');
  }

  async jiraSprints(params: { boardId?: string }): Promise<string> {
    const boardId = params.boardId || '1';
    return this.makeRequest('GET', 'board/' + boardId + '/sprint?state=active');
  }
}
