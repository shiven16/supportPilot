import { z } from 'zod';
import { BaseConfig } from 'supportPilot-common-agent';

export type JiraToolConfig = BaseConfig & {
  url: string;
  email: string;
  apiToken: string;
  projectKey?: string;
};

const optionalText = (description: string) =>
  z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .describe(description);

const projectKeySchema = (config: JiraToolConfig) =>
  config.projectKey
    ? z
        .string()
        .default(config.projectKey)
        .describe('Jira project key. Defaults to the workspace Jira project when configured.')
    : z.string().describe('Jira project key, for example PROJ.');

export const searchJiraIssuesSchema = (config: JiraToolConfig) =>
  z.object({
    projectKey: projectKeySchema(config),
    jql: z
      .string()
      .describe(
        'Jira Query Language expression without a project clause, for example "statusCategory != Done ORDER BY updated DESC".'
      ),
    maxResults: z.number().int().min(1).max(20).default(10).describe('Maximum issues to return.')
  });

export const getJiraIssueSchema = z.object({
  issueKey: z.string().describe('Jira issue key, for example PROJ-123.')
});

export const createJiraIssueSchema = (config: JiraToolConfig) =>
  z.object({
    projectKey: projectKeySchema(config),
    summary: z.string().describe('Short, descriptive issue title.'),
    description: optionalText('Issue description in plain text. It will be converted to Jira rich text.'),
    issueType: z.string().default('Task').describe('Jira issue type name, such as Task, Bug, or Story.'),
    priorityName: optionalText('Jira priority name, such as High or Highest.'),
    labels: z.array(z.string()).default([]).describe('Labels to apply to the issue.'),
    assigneeAccountId: optionalText(
      'Jira account ID to assign. Use search_jira_users first when the account ID is unknown.'
    )
  });

export const updateJiraIssueSchema = z
  .object({
    issueKey: z.string().describe('Jira issue key to update.'),
    summary: optionalText('Replacement issue summary.'),
    description: optionalText('Replacement issue description in plain text.'),
    priorityName: optionalText('Replacement Jira priority name.'),
    labels: z.array(z.string()).nullish().describe('Replacement labels. Pass an empty array to clear labels.'),
    dueDate: optionalText('Due date in YYYY-MM-DD format.')
  })
  .refine(
    (value) =>
      value.summary !== undefined ||
      value.description !== undefined ||
      value.priorityName !== undefined ||
      value.labels !== undefined ||
      value.dueDate !== undefined,
    { message: 'Provide at least one field to update.' }
  );

export const addJiraCommentSchema = z.object({
  issueKey: z.string().describe('Jira issue key to comment on.'),
  comment: z.string().describe('Comment text in plain text. It will be converted to Jira rich text.')
});

export const getJiraIssueTransitionsSchema = z.object({
  issueKey: z.string().describe('Jira issue key whose available transitions should be retrieved.')
});

export const transitionJiraIssueSchema = z.object({
  issueKey: z.string().describe('Jira issue key to transition.'),
  transitionId: z
    .string()
    .describe('Jira transition ID. Use get_jira_issue_transitions first if it is unknown.')
});

export const searchJiraUsersSchema = (config: JiraToolConfig) =>
  z.object({
    projectKey: projectKeySchema(config),
    query: z.string().describe('Name or email fragment to search for assignable Jira users.'),
    maxResults: z.number().int().min(1).max(20).default(10).describe('Maximum users to return.')
  });

export const assignJiraIssueSchema = z.object({
  issueKey: z.string().describe('Jira issue key to assign.'),
  accountId: z.string().describe('Jira account ID of the assignee.')
});

export const listJiraProjectsSchema = z.object({
  query: optionalText('Optional project name or key filter.'),
  maxResults: z.number().int().min(1).max(50).default(20).describe('Maximum projects to return.')
});
