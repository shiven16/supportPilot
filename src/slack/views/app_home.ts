import { SLACK_ACTIONS, TRIAL_DAYS } from '@supportpilot/lib/utils/slack-constants';
import { HomeViewArgs } from './types';
import { INTEGRATIONS, SUPPORTED_INTEGRATIONS } from '@supportpilot/lib/constants';
import { getInstallUrl } from '@supportpilot/lib/utils/slack';
import {
  HubspotConfig,
  JiraConfig,
  PostgresConfig,
  SlackWorkspace,
  GithubConfig,
  SalesforceConfig,
  NotionConfig,
  LinearConfig,
  McpConnection,
  OktaConfig,
  ZendeskConfig,
  JumpCloudConfig
} from '@supportpilot/database/models';
import {
  Elements,
  Bits,
  Blocks,
  Md,
  BlockBuilder,
  OptionBuilder,
  OptionGroupBuilder
} from 'slack-block-builder';
import { createGitHubToolsExport } from 'supportPilot-github-agent';
import { partition, isEmpty } from 'lodash';

export const getToolData = async (
  selectedTool: (typeof INTEGRATIONS)[number]['value'] | string | undefined
) => {
  let tool, availableFns;

  // Only process standard integrations
  if (
    selectedTool &&
    typeof selectedTool === 'string' &&
    !selectedTool.startsWith('mcp:') &&
    selectedTool !== 'add_mcp_server'
  ) {
    const integrationValue = selectedTool as SUPPORTED_INTEGRATIONS;
    tool = INTEGRATIONS.find((integration) => integration.value === integrationValue);
    availableFns = await getAvailableFns(integrationValue);
  }

  return {
    availableFns
  };
};

const getAvailableFns = async (selectedTool: SUPPORTED_INTEGRATIONS) => {
  if (selectedTool === SUPPORTED_INTEGRATIONS.GITHUB) {
    const toolConfigs = (
      await createGitHubToolsExport({
        token: 'test-access-token',
        owner: 'test-github-owner',
        repo: 'test-github-repo'
      })
    ).toolConfigs;

    return toolConfigs.map(
      (toolConfig) => '• `' + toolConfig.tool.name + '`: ' + toolConfig.tool.description
    );
  }

  return [];
};

export const getMCPConnectionDropDownValue = (mcpConnection: McpConnection): string => {
  return `mcp:${mcpConnection.id}`;
};

export const getToolConnectionView = (
  selectedTool: (typeof INTEGRATIONS)[number]['value'] | string | undefined,
  mcpConnections: McpConnection[] = [],
  slackWorkspace: SlackWorkspace
): BlockBuilder[] => {
  const select = Elements.StaticSelect({
    placeholder: 'Select a tool',
    actionId: SLACK_ACTIONS.CONNECT_TOOL
  });

  const [connectedIntegrations, nonConnectedIntegrations] = partition(
    INTEGRATIONS,
    (integration) => {
      const relationKey = integration.relation as keyof SlackWorkspace;
      return !isEmpty(slackWorkspace[relationKey]);
    }
  );

  let connectedOptions: OptionBuilder[] = [];
  connectedIntegrations.forEach((integration) => {
    connectedOptions.push(
      Bits.Option({
        text: integration.name,
        value: integration.value
      })
    );
  });

  mcpConnections.forEach((conn) =>
    connectedOptions.push(
      Bits.Option({
        text: conn.name,
        value: `mcp:${conn.id}`
      })
    )
  );

  const integrationOptions = nonConnectedIntegrations.map((integration) =>
    Bits.Option({
      text: integration.name,
      value: integration.value
    })
  );

  const addYourOwnOption = Bits.Option({
    text: 'Add your MCP Server',
    value: 'add_mcp_server'
  });

  // Build sections in correct order
  const optionGroups: OptionGroupBuilder[] = [];

  if (connectedOptions.length) {
    optionGroups.push(
      Bits.OptionGroup()
        .label('Connected Tools')
        .options(...connectedOptions)
    );
  }

  if (integrationOptions.length) {
    optionGroups.push(
      Bits.OptionGroup()
        .label('Integrations')
        .options(...integrationOptions)
    );
  }

  optionGroups.push(Bits.OptionGroup().label('Add Your Own').options(addYourOwnOption));

  select.optionGroups(...optionGroups);

  // Set selected option properly
  if (selectedTool) {
    if (selectedTool.startsWith('mcp:')) {
      const mcpId = selectedTool.split(':')[1];
      const conn = mcpConnections.find((c) => c.id === mcpId);
      if (conn) {
        select.initialOption(
          Bits.Option({
            text: conn.name,
            value: selectedTool
          })
        );
      }
    } else if (selectedTool === 'add_mcp_server') {
      select.initialOption(addYourOwnOption);
    } else {
      const integration = INTEGRATIONS.find((i) => i.value === selectedTool);
      if (integration) {
        select.initialOption(
          Bits.Option({
            text: integration.name,
            value: selectedTool
          })
        );
      }
    }
  }

  return [
    Blocks.Input({
      label: 'Connect your tools to get started'
    })
      .element(select)
      .dispatchAction(true)
  ];
};



export const getConnectionInfo = (connection: HomeViewArgs['connection']): string => {
  if (!connection) return '';
  switch (true) {
    case connection instanceof JiraConfig:
      return `Connected to ${connection.url}`;
    case connection instanceof HubspotConfig:
      return `Connected to ${connection.hub_domain}`;
    case connection instanceof PostgresConfig:
      return `Connected to ${connection.host}`;
    case connection instanceof GithubConfig:
      return `Connected to ${connection.username}`;
    case connection instanceof SalesforceConfig:
      return `Connected to ${connection.instance_url}`;
    case connection instanceof NotionConfig:
      return `Connected to ${connection.workspace_name}`;
    case connection instanceof LinearConfig:
      return `Connected to ${connection.workspace_name}`;
    case connection instanceof OktaConfig:
      return `Connected to ${connection.org_url}`;
    case connection instanceof JumpCloudConfig:
      return `Connected to JumpCloud`;
    case connection instanceof ZendeskConfig:
      return `Connected to ${connection.subdomain}.zendesk.com`;
    default:
      return '';
  }
};

export const getIntegrationInfo = (
  selectedTool: (typeof INTEGRATIONS)[number]['value'] | string,
  teamId: string,
  connection?: HomeViewArgs['connection'],
  mcpConnections?: McpConnection[]
): BlockBuilder[] => {
  // Handle MCP server or Add MCP server option
  if (selectedTool === 'add_mcp_server') {
    return [
      Blocks.Section({
        text: 'Connect to your MCP server to access its tools.'
      }).accessory(
        Elements.Button({
          text: 'Connect',
          actionId: SLACK_ACTIONS.INSTALL_MCP_SERVER
        }).primary()
      )
    ];
  }

  if (typeof selectedTool === 'string' && selectedTool.startsWith('mcp:')) {
    const mcpConnection = mcpConnections?.find((c) => c.id === selectedTool.split(':')[1]);
    if (!mcpConnection) return [];

    return [
      Blocks.Section({
        text: `Connected to ${mcpConnection.name} (${mcpConnection.url})`,
        blockId: JSON.stringify({
          type: 'mcp',
          id: mcpConnection.id
        })
      }).accessory(
        Elements.OverflowMenu({
          actionId: SLACK_ACTIONS.CONNECTION_OVERFLOW_MENU
        }).options([
          Bits.Option({
            text: `${Md.emoji('pencil')} Edit`,
            value: 'edit'
          }),
          Bits.Option({
            text: `${Md.emoji('no_entry')} Disconnect`,
            value: 'disconnect'
          })
        ])
      )
    ];
  }

  // Handle standard integrations
  const integrationValue = selectedTool as SUPPORTED_INTEGRATIONS;
  const integration = INTEGRATIONS.find((integration) => integration.value === integrationValue);
  if (!integration) return [];

  const overflowMenuOptions = [
    Bits.Option({
      text: `${Md.emoji('no_entry')} Disconnect`,
      value: 'disconnect'
    })
  ];

  if (
    connection instanceof PostgresConfig ||
    connection instanceof NotionConfig ||
    connection instanceof JiraConfig ||
    connection instanceof GithubConfig ||
    connection instanceof SalesforceConfig ||
    connection instanceof HubspotConfig ||
    connection instanceof LinearConfig ||
    connection instanceof OktaConfig ||
    connection instanceof JumpCloudConfig ||
    connection instanceof ZendeskConfig
  ) {
    overflowMenuOptions.unshift(
      Bits.Option({
        text: `${Md.emoji('pencil')} Edit`,
        value: 'edit'
      })
    );
  }

  const accessory = connection
    ? Elements.OverflowMenu({ actionId: SLACK_ACTIONS.CONNECTION_OVERFLOW_MENU }).options(
        overflowMenuOptions
      )
    : Elements.Button({
        text: 'Connect',
        actionId: SLACK_ACTIONS.INSTALL_TOOL,
        value: integrationValue,
        url:
          integration.oauth &&
          integrationValue !== SUPPORTED_INTEGRATIONS.JIRA &&
          integrationValue !== SUPPORTED_INTEGRATIONS.GITHUB
            ? getInstallUrl(integrationValue, teamId)
            : undefined
      }).primary();

  return [
    Blocks.Section({
      blockId: JSON.stringify({
        type: integration.value
      })
    })
      .text(connection ? getConnectionInfo(connection) : integration.helpText)
      .accessory(accessory)
  ];
};

export const getNonAdminView = (slackWorkspace: SlackWorkspace): BlockBuilder[] => {
  let warningText = '';
  if (slackWorkspace.admin_user_ids.length) {
    warningText += `Please contact one of the admins (${slackWorkspace.admin_user_ids.map((admin) => `<@${admin}>`).join(', ')}) to get access.`;
  } else {
    warningText += 'Please contact a SupportPilot admin to get access.';
  }
  return [
    Blocks.Section({
      text: `${Md.emoji('warning')} You are not authorized to configure SupportPilot. ${warningText}`
    })
  ];
};

export const getAccessControlView = (): BlockBuilder[] => {
  return [
    Blocks.Section({
      text: 'Allow team members to access SupportPilot across channels and DMs.'
    }).accessory(
      Elements.Button({
        text: 'Manage Access Controls',
        actionId: SLACK_ACTIONS.MANAGE_ACCESS_CONTROLS
      })
    ),
    Blocks.Divider()
  ];
};

export const getPreferencesView = (): BlockBuilder[] => {
  return [
    Blocks.Section({
      text: 'Allow team members to configure tools that SupportPilot uses.'
    }).accessory(
      Elements.Button({
        text: 'Manage Admins',
        actionId: SLACK_ACTIONS.MANAGE_ADMINS
      })
    ),
    Blocks.Divider()
  ];
};

// New function to provide onboarding guidance when no connections are set up
export const getOnboardingView = (): BlockBuilder[] => {
  return [
    Blocks.Section({
      text: `${Md.emoji('pushpin')} *Get Started with SupportPilot*`
    }),
    Blocks.Section({
      text: 'For quick access to SupportPilot, we recommend pinning this app to your Slack workspace:'
    }),
    Blocks.Section({
      text: `${Md.emoji('one')} Click on your workspace name in the top left\n${Md.emoji('two')} Select "Preferences > Navigation > App agents & assistants"\n${Md.emoji('three')} Find and select SupportPilot to pin it to your sidebar`
    }),
    Blocks.Divider(),
    Blocks.Section({
      text: `${Md.emoji('speech_balloon')} *How to Use SupportPilot*`
    }),
    Blocks.Section({
      text: 'You can use SupportPilot by:'
    }),
    Blocks.Section({
      text: `• *Mention @SupportPilot* in any channel where the app is added\n• *Direct message* SupportPilot for private conversations`
    }),
    Blocks.Divider()
  ];
};

export const getCommunityLinkView = (): BlockBuilder[] => {
  return [
    Blocks.Section({
      text: `${Md.emoji('busts_in_silhouette')} Join our Slack community to get help and connect with other SupportPilot users.`
    }).accessory(
      Elements.Button({
        text: `${Md.emoji('slack')}  Join Community`,
        url: 'https://supportpilot.app',
        actionId: 'join_slack_community'
      })
    ),
    Blocks.Divider()
  ];
};
