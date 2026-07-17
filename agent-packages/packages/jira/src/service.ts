import axios, { AxiosError, AxiosInstance } from 'axios';
import { BaseResponse, BaseService } from 'supportPilot-common-agent';
import { JiraToolConfig } from './schema.js';

type JiraIssue = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, any>;
};

const toAdf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split(/\n{2,}/).map((paragraph) => ({
    type: 'paragraph',
    content: paragraph
      ? [{ type: 'text', text: paragraph }]
      : []
  }))
});

const trimText = (value: unknown, limit = 1200): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return value.length > limit ? `${value.slice(0, limit)}... [TRUNCATED]` : value;
};

const adfToText = (value: any): string | undefined => {
  if (!value?.content) return undefined;
  const collect = (node: any): string => {
    if (!node) return '';
    if (node.type === 'text') return node.text ?? '';
    return (node.content ?? []).map(collect).join(node.type === 'paragraph' ? '\n' : '');
  };
  return trimText(collect(value));
};

export class JiraService implements BaseService<JiraToolConfig> {
  private readonly client: AxiosInstance;

  constructor(private readonly config: JiraToolConfig) {
    this.client = axios.create({
      baseURL: config.url.replace(/\/$/, ''),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`
      },
      timeout: 20_000
    });
  }

  private errorResponse(error: unknown, fallback: string): BaseResponse<never> {
    if (error instanceof AxiosError) {
      const data = error.response?.data as { errorMessages?: string[]; errors?: Record<string, string> };
      const details = [data?.errorMessages?.join('; '), ...Object.values(data?.errors ?? {})]
        .filter(Boolean)
        .join('; ');
      return { success: false, error: details || fallback };
    }
    return { success: false, error: error instanceof Error ? error.message : fallback };
  }

  private compactIssue(issue: JiraIssue) {
    const fields = issue.fields ?? {};
    return {
      id: issue.id,
      key: issue.key,
      url: issue.key ? `${this.config.url.replace(/\/$/, '')}/browse/${issue.key}` : undefined,
      summary: fields.summary,
      status: fields.status ? { name: fields.status.name, category: fields.status.statusCategory?.name } : undefined,
      issueType: fields.issuetype?.name,
      priority: fields.priority?.name,
      assignee: fields.assignee
        ? { accountId: fields.assignee.accountId, displayName: fields.assignee.displayName }
        : undefined,
      reporter: fields.reporter?.displayName,
      labels: fields.labels,
      created: fields.created,
      updated: fields.updated,
      dueDate: fields.duedate,
      description: adfToText(fields.description)
    };
  }

  async searchIssues(params: { projectKey: string; jql: string; maxResults: number }) {
    try {
      const projectKey = params.projectKey.replace(/"/g, '\\"');
      const response = await this.client.post('/rest/api/3/search/jql', {
        jql: `project = "${projectKey}" AND (${params.jql})`,
        maxResults: params.maxResults,
        fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'duedate']
      });
      return {
        success: true,
        data: {
          issues: (response.data.issues ?? []).map((issue: JiraIssue) => this.compactIssue(issue)),
          nextPageToken: response.data.nextPageToken
        }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to search Jira issues');
    }
  }

  async getIssue(issueKey: string) {
    try {
      const response = await this.client.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        params: {
          fields: 'summary,status,issuetype,priority,assignee,reporter,labels,created,updated,duedate,description,comment'
        }
      });
      const issue = this.compactIssue(response.data);
      const comments = (response.data.fields?.comment?.comments ?? []).slice(-10).map((comment: any) => ({
        id: comment.id,
        author: comment.author?.displayName,
        created: comment.created,
        body: adfToText(comment.body)
      }));
      return { success: true, data: { ...issue, comments } } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to get Jira issue');
    }
  }

  async createIssue(params: {
    projectKey: string;
    summary: string;
    description?: string;
    issueType: string;
    priorityName?: string;
    labels: string[];
    assigneeAccountId?: string;
  }) {
    try {
      const fields: Record<string, unknown> = {
        project: { key: params.projectKey },
        summary: params.summary,
        issuetype: { name: params.issueType },
        labels: params.labels
      };
      if (params.description) fields.description = toAdf(params.description);
      if (params.priorityName) fields.priority = { name: params.priorityName };
      if (params.assigneeAccountId) fields.assignee = { accountId: params.assigneeAccountId };

      const response = await this.client.post('/rest/api/3/issue', { fields });
      return {
        success: true,
        data: {
          id: response.data.id,
          key: response.data.key,
          url: `${this.config.url.replace(/\/$/, '')}/browse/${response.data.key}`
        }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to create Jira issue');
    }
  }

  async updateIssue(params: {
    issueKey: string;
    summary?: string;
    description?: string;
    priorityName?: string;
    labels?: string[] | null;
    dueDate?: string;
  }) {
    try {
      const fields: Record<string, unknown> = {};
      if (params.summary !== undefined) fields.summary = params.summary;
      if (params.description !== undefined) fields.description = toAdf(params.description);
      if (params.priorityName !== undefined) fields.priority = { name: params.priorityName };
      if (params.labels !== undefined) fields.labels = params.labels ?? [];
      if (params.dueDate !== undefined) fields.duedate = params.dueDate;
      await this.client.put(`/rest/api/3/issue/${encodeURIComponent(params.issueKey)}`, { fields });
      return { success: true, data: { key: params.issueKey, updatedFields: Object.keys(fields) } } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to update Jira issue');
    }
  }

  async addComment(issueKey: string, comment: string) {
    try {
      const response = await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        body: toAdf(comment)
      });
      return {
        success: true,
        data: { id: response.data.id, issueKey, created: response.data.created }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to add Jira comment');
    }
  }

  async getTransitions(issueKey: string) {
    try {
      const response = await this.client.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
      return {
        success: true,
        data: {
          transitions: (response.data.transitions ?? []).map((transition: any) => ({
            id: transition.id,
            name: transition.name,
            toStatus: transition.to?.name
          }))
        }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to get Jira issue transitions');
    }
  }

  async transitionIssue(issueKey: string, transitionId: string) {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        transition: { id: transitionId }
      });
      return { success: true, data: { key: issueKey, transitionId } } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to transition Jira issue');
    }
  }

  async searchUsers(projectKey: string, query: string, maxResults: number) {
    try {
      const response = await this.client.get('/rest/api/3/user/assignable/search', {
        params: { project: projectKey, query, maxResults }
      });
      return {
        success: true,
        data: {
          users: response.data.map((user: any) => ({
            accountId: user.accountId,
            displayName: user.displayName,
            emailAddress: user.emailAddress,
            active: user.active
          }))
        }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to search Jira users');
    }
  }

  async assignIssue(issueKey: string, accountId: string) {
    try {
      await this.client.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId });
      return { success: true, data: { key: issueKey, accountId } } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to assign Jira issue');
    }
  }

  async listProjects(query: string | undefined, maxResults: number) {
    try {
      const response = await this.client.get('/rest/api/3/project/search', {
        params: { query, maxResults }
      });
      return {
        success: true,
        data: {
          projects: (response.data.values ?? []).map((project: any) => ({
            id: project.id,
            key: project.key,
            name: project.name,
            projectTypeKey: project.projectTypeKey
          }))
        }
      } satisfies BaseResponse;
    } catch (error) {
      return this.errorResponse(error, 'Failed to list Jira projects');
    }
  }
}
