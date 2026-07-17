import { tool } from '@langchain/core/tools';
import { ToolConfig, ToolOperation, Toolkit } from 'supportPilot-common-agent';
import { z } from 'zod';
import {
  addJiraCommentSchema,
  assignJiraIssueSchema,
  createJiraIssueSchema,
  getJiraIssueSchema,
  getJiraIssueTransitionsSchema,
  JiraToolConfig,
  listJiraProjectsSchema,
  searchJiraIssuesSchema,
  searchJiraUsersSchema,
  transitionJiraIssueSchema,
  updateJiraIssueSchema
} from './schema.js';
import { JiraService } from './service.js';

const JIRA_TOOL_SELECTION_PROMPT = `
Use Jira tools for requests about Jira issues, tickets, backlogs, project work, assignees, comments, or issue status.
Before assigning a person, search Jira users to obtain their account ID. Before changing status, get the available issue transitions when the transition ID is unknown.
`;

const JIRA_RESPONSE_GENERATION_PROMPT = `
When responding with Jira data, include issue keys and status. Present issue lists as concise bullets and link to the issue URL when available.
`;

export function createJiraToolsExport(config: JiraToolConfig): Toolkit {
  const service = new JiraService(config);
  const toolConfigs: ToolConfig[] = [
    {
      tool: tool(async (args: z.infer<ReturnType<typeof searchJiraIssuesSchema>>) => service.searchIssues(args), {
        name: 'search_jira_issues',
        description: 'Search Jira issues in a project using Jira Query Language (JQL).',
        schema: searchJiraIssuesSchema(config)
      }),
      operations: [ToolOperation.READ]
    },
    {
      tool: tool(async (args: z.infer<typeof getJiraIssueSchema>) => service.getIssue(args.issueKey), {
        name: 'get_jira_issue',
        description: 'Get details, current status, and recent comments for a Jira issue.',
        schema: getJiraIssueSchema
      }),
      operations: [ToolOperation.READ]
    },
    {
      tool: tool(async (args: z.infer<ReturnType<typeof createJiraIssueSchema>>) => service.createIssue(args), {
        name: 'create_jira_issue',
        description: 'Create a Jira issue, bug, task, or story in a project.',
        schema: createJiraIssueSchema(config)
      }),
      operations: [ToolOperation.CREATE]
    },
    {
      tool: tool(async (args: z.infer<typeof updateJiraIssueSchema>) => service.updateIssue(args), {
        name: 'update_jira_issue',
        description: 'Update a Jira issue summary, description, priority, labels, or due date.',
        schema: updateJiraIssueSchema
      }),
      operations: [ToolOperation.UPDATE]
    },
    {
      tool: tool(async (args: z.infer<typeof addJiraCommentSchema>) => service.addComment(args.issueKey, args.comment), {
        name: 'add_jira_comment',
        description: 'Add a comment to a Jira issue.',
        schema: addJiraCommentSchema
      }),
      operations: [ToolOperation.CREATE]
    },
    {
      tool: tool(async (args: z.infer<typeof getJiraIssueTransitionsSchema>) => service.getTransitions(args.issueKey), {
        name: 'get_jira_issue_transitions',
        description: 'List valid status transitions for a Jira issue.',
        schema: getJiraIssueTransitionsSchema
      }),
      operations: [ToolOperation.READ]
    },
    {
      tool: tool(async (args: z.infer<typeof transitionJiraIssueSchema>) => service.transitionIssue(args.issueKey, args.transitionId), {
        name: 'transition_jira_issue',
        description: 'Change a Jira issue status using a transition ID.',
        schema: transitionJiraIssueSchema
      }),
      operations: [ToolOperation.UPDATE]
    },
    {
      tool: tool(async (args: z.infer<ReturnType<typeof searchJiraUsersSchema>>) => service.searchUsers(args.projectKey, args.query, args.maxResults), {
        name: 'search_jira_users',
        description: 'Find assignable Jira users and return their account IDs.',
        schema: searchJiraUsersSchema(config)
      }),
      operations: [ToolOperation.READ]
    },
    {
      tool: tool(async (args: z.infer<typeof assignJiraIssueSchema>) => service.assignIssue(args.issueKey, args.accountId), {
        name: 'assign_jira_issue',
        description: 'Assign a Jira issue to a user by Jira account ID.',
        schema: assignJiraIssueSchema
      }),
      operations: [ToolOperation.UPDATE]
    },
    {
      tool: tool(async (args: z.infer<typeof listJiraProjectsSchema>) => service.listProjects(args.query, args.maxResults), {
        name: 'list_jira_projects',
        description: 'List accessible Jira projects and their project keys.',
        schema: listJiraProjectsSchema
      }),
      operations: [ToolOperation.READ]
    }
  ];

  return {
    toolConfigs,
    prompts: {
      toolSelection: JIRA_TOOL_SELECTION_PROMPT,
      responseGeneration: JIRA_RESPONSE_GENERATION_PROMPT
    }
  };
}
