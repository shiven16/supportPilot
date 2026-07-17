import { createGitHubToolsExport } from 'supportPilot-github-agent';
import { createJiraToolsExport } from 'supportPilot-jira-agent';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/sequelize';
import { SlackWorkspace } from '../database/models';
import { McpServerCleanupFn, McpService } from '../integrations/mcp.service';
import { SupportPilotPrompts, SUPPORTED_INTEGRATIONS } from '../lib/constants';
import { createCommonToolsExport } from 'supportPilot-common-agent';
import { AvailableToolsWithConfig } from './types';
import { createSlackToolsExport } from 'supportPilot-slack-agent';
import { EVENT_NAMES, IntegrationConnectedEvent } from '../types/events';

@Injectable()
export class ToolService {
  constructor(
    @InjectModel(SlackWorkspace)
    private readonly slackWorkspaceModel: typeof SlackWorkspace,
    private readonly mcpService: McpService
  ) {}

  private runningTools: McpServerCleanupFn[] = [];
  private readonly availableToolsCache = new Map<
    string,
    { expiresAt: number; tools: AvailableToolsWithConfig }
  >();

  async getAvailableTools(
    teamId: string,
    requestedCategories: string[] = []
  ): Promise<AvailableToolsWithConfig | undefined> {
    const requestedCategorySet = new Set(requestedCategories.filter(Boolean));
    const shouldLoadAll = requestedCategorySet.size === 0;
    const shouldLoad = (category: string) => shouldLoadAll || requestedCategorySet.has(category);
    const cacheKey = `${teamId}:${[...requestedCategorySet].sort().join(',') || 'all'}`;
    const cached = this.availableToolsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    const slackWorkspace = await this.slackWorkspaceModel.findByPk(teamId, {
      include: [
        'jiraConfig',
        'githubConfig',
        'linearConfig',
        'mcpConnections'
      ]
    });
    if (!slackWorkspace) return;
    const tools: AvailableToolsWithConfig = {
      common: {
        toolKit: createCommonToolsExport(),
        config: slackWorkspace
      }
    };
    if (shouldLoad('slack')) {
      tools.slack = {
        toolKit: createSlackToolsExport({
          token: slackWorkspace.bot_access_token,
          teamId: slackWorkspace.team_id
        })
      };
    }
    const githubConfig = slackWorkspace.githubConfig;
    if (githubConfig && shouldLoad('github')) {
      tools.github = {
        toolKit: await createGitHubToolsExport({
          token: githubConfig.access_token,
          owner: githubConfig.default_config?.owner,
          repo: githubConfig.default_config?.repo
        }),
        config: githubConfig
      };
    }
    const jiraConfig = slackWorkspace.jiraConfig;
    if (jiraConfig?.email && jiraConfig.access_token && shouldLoad('jira')) {
      tools.jira = {
        toolKit: createJiraToolsExport({
          url: jiraConfig.url,
          email: jiraConfig.email,
          apiToken: jiraConfig.access_token,
          projectKey: jiraConfig.default_config?.projectKey
        }),
        config: jiraConfig
      };
    }
    // Handle MCP-based integrations
    try {
      // Call MCP service to get tools for all integrations
      if (slackWorkspace.linearConfig && shouldLoad('linear')) {
        const linearMcpTools = await this.mcpService.getMcpServerTools(
          SUPPORTED_INTEGRATIONS.LINEAR,
          {
            LINEAR_API_KEY: slackWorkspace.linearConfig.access_token
          },
          slackWorkspace.linearConfig.default_config?.team_id
            ? { teamId: slackWorkspace.linearConfig.default_config.team_id }
            : undefined
        );
        if (linearMcpTools && linearMcpTools.tools.length > 0) {
          this.runningTools.push(linearMcpTools.cleanup);
          tools.linear = {
            toolKit: {
              toolConfigs: linearMcpTools.tools.map((tool) => ({
                tool,
                operations: []
              })),
              prompts: {
                toolSelection: SupportPilotPrompts.LINEAR.toolSelection,
                responseGeneration: SupportPilotPrompts.LINEAR.responseGeneration
              }
            },
            config: slackWorkspace.linearConfig
          };
        }
      }
      if ((shouldLoadAll || requestedCategorySet.has('mcp')) && slackWorkspace.mcpConnections?.length) {
        const mcpTools = await this.mcpService.getToolsFromMCPConnections(
          slackWorkspace.mcpConnections
        );
        for (const mcpTool of mcpTools) {
          this.runningTools.push(mcpTool.cleanup);
          tools[`${mcpTool.mcpConnection.name}-${mcpTool.mcpConnection.id}`] = {
            toolKit: {
              toolConfigs: mcpTool.tools.map((tool) => ({
                tool,
                operations: []
              })),
              prompts: {
                toolSelection: mcpTool.mcpConnection.request_config.tool_selection_prompt
              }
            },
            config: mcpTool.mcpConnection
          };
        }
      }
    } catch (error) {
      // Log error but continue with other tools
      console.error('Failed to load MCP tools:', error);
    }

    if (!tools.linear && !Object.keys(tools).some((key) => key.includes('-'))) {
      this.availableToolsCache.set(cacheKey, {
        expiresAt: Date.now() + 60_000,
        tools
      });
    }

    return tools;
  }

  invalidateAvailableTools(teamId: string) {
    for (const key of this.availableToolsCache.keys()) {
      if (key.startsWith(`${teamId}:`)) this.availableToolsCache.delete(key);
    }
  }

  @OnEvent(EVENT_NAMES.JIRA_CONNECTED)
  handleJiraConnectionChanged(event: IntegrationConnectedEvent) {
    this.invalidateAvailableTools(event.teamId);
  }

  async shutDownMcpServers() {
    await Promise.all(this.runningTools.map((cleanup) => cleanup()));
    this.runningTools = [];
  }
}
