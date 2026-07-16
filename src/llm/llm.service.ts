import { Injectable, Logger } from '@nestjs/common';
import { ToolService } from './tool.service';
import {
  IntentClassification,
  LLMContext,
  MessageProcessingArgs,
  ToolContextParams,
  ToolSelectionResult
} from './types';
import { LlmProviderService } from './llm.provider';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { ConversationState } from '../database/models/conversation-state.model';
import { InjectModel } from '@nestjs/sequelize';
import { TRIAL_MAX_MESSAGE_PER_CONVERSATION_COUNT } from '../lib/utils/slack-constants';
import { Md } from 'slack-block-builder';
import { encryptForLogs } from '../lib/utils/encryption';
import { INTEGRATIONS, SOFT_RETENTION_DAYS, SupportPilotPrompts } from '../lib/constants';
import { getSlackMessageUrl } from '@supportpilot/lib/utils/slack';
import { SupportPilotAgent } from './supportpilot-agent';
import slackify = require('slackify-markdown');
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { invokeWithStructuredOutput } from './utils';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly supportPilotAgent: SupportPilotAgent;

  constructor(
    private readonly llmProvider: LlmProviderService,
    private readonly tool: ToolService,
    @InjectModel(ConversationState)
    private readonly conversationStateModel: typeof ConversationState
  ) {
    this.supportPilotAgent = new SupportPilotAgent();
  }

  private isTrivialNoise(message: string): boolean {
    const normalized = message
      .replace(/<@[^>]+>/g, '')
      .replace(/:[a-z0-9_+-]+:/gi, '')
      .trim()
      .toLowerCase();

    if (!normalized) return true;
    if (/^[\s.!?,👍🙏✅✔️👌🙌🎉🙂😀😄]+$/.test(normalized)) return true;

    return [
      'thanks',
      'thank you',
      'thx',
      'ty',
      'ok',
      'okay',
      'got it',
      'sounds good',
      'sg',
      'done',
      'cool',
      'great',
      'nice'
    ].includes(normalized);
  }

  private enhanceMessagesWithToolContext({
    previousMessages,
    lastToolCalls,
    channelId,
    threadTs,
    slackWorkspaceDomain
  }: ToolContextParams): LLMContext[] {
    const enhancedPreviousMessages = [...previousMessages];

    if (slackWorkspaceDomain) {
      const slackUrl = getSlackMessageUrl({
        slackDomain: slackWorkspaceDomain,
        channelId,
        messageExternalId: threadTs ?? ''
      });

      enhancedPreviousMessages.push({
        role: 'system',
        content: `Slack thread URL: ${slackUrl}\nYou must include this link in the description or comment whenever you create or update a resource—such as an issue, ticket, record, or case.`
      });
    }

    if (lastToolCalls) {
      enhancedPreviousMessages.push({
        role: 'system',
        content: `Previous tools you have used in this conversation: ${Object.values(lastToolCalls)
          .slice(-10)
          .map((call) => {
            let resultContent =
              typeof call.result === 'string'
                ? call.result
                : (call.result?.kwargs?.content ??
                  (call.result ? JSON.stringify(call.result) : ''));
            
            // Truncate massive JSON blobs from previous tool calls to prevent token limit errors
            if (resultContent.length > 500) {
              resultContent = resultContent.substring(0, 500) + '... [TRUNCATED]';
            }
            
            return `Tool "${call.name}" with args ${JSON.stringify(call.args)} returned: ${resultContent}`;
          })
          .join('; ')}`
      });
    }

    return enhancedPreviousMessages;
  }

  async processMessage(args: MessageProcessingArgs): Promise<string | undefined> {
    const { message, threadTs, previousMessages, channelId, authorName, slackWorkspace } = args;
    this.logger.log(`Processing message for team ${slackWorkspace.team_id}`, {
      message: encryptForLogs(message)
    });

    if (this.isTrivialNoise(message)) {
      this.logger.log('Skipping trivial noise message before LLM/tool pipeline');
      return undefined;
    }

    const llm = await this.llmProvider.getProvider(args.slackWorkspace);
    const classification = await this.classifyIntent(message, llm);
    this.logger.log('Intent classification complete', {
      classification: encryptForLogs(JSON.stringify(classification))
    });

    if (classification.intent === 'noise') return undefined;

    const [conversationState] = await this.conversationStateModel.findOrCreate({
      where: {
        team_id: slackWorkspace.team_id,
        channel_id: channelId,
        thread_ts: threadTs
      },
      defaults: {
        team_id: slackWorkspace.team_id,
        channel_id: channelId,
        thread_ts: threadTs,
        last_tool_calls: null,
        last_plan: null,
        contextual_memory: {}
      }
    });
    const maxAgeMs = SOFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - conversationState.createdAt.getTime() > maxAgeMs) {
      return (
        '👋 This conversation is more than ' +
        Md.bold(`${SOFT_RETENTION_DAYS} days`) +
        ' old. ' +
        'Please start a ' +
        Md.bold('new thread') +
        ' to continue.'
      );
    }

    if (
      slackWorkspace.isTrialMode &&
      conversationState.message_count >= TRIAL_MAX_MESSAGE_PER_CONVERSATION_COUNT
    ) {
      return `You've reached the limit of ${TRIAL_MAX_MESSAGE_PER_CONVERSATION_COUNT} messages per conversation during the trial period.
	To continue, you can start a new conversation or ${Md.link(slackWorkspace.getAppHomeRedirectUrl(), 'set your OpenAI API key here')} to remove this restriction.`;
    }

    if (classification.intent === 'chat' || classification.domain === 'none') {
      const response = await this.generateDirectResponse(message, llm, authorName);
      conversationState.message_count++;
      await conversationState.save();
      return slackify(response);
    }

    const tools = await this.tool.getAvailableTools(slackWorkspace.team_id, [classification.domain]);
    const availableCategories = Object.keys(tools ?? {});
    if (!tools || availableCategories.length < 1) {
      this.logger.log('No tool categories available, returning direct response');
      return "I apologize, but I don't have any tools configured to help with your request at the moment.";
    }

    this.logger.log(`Processing message with tool categories`, {
      availableCategories
    });

    // Add previous tool calls to system context for better continuity
    let enhancedPreviousMessages: LLMContext[] = [];
    try {
      enhancedPreviousMessages = this.enhanceMessagesWithToolContext({
        previousMessages,
        lastToolCalls: conversationState.last_tool_calls,
        channelId: conversationState.channel_id,
        threadTs: conversationState.thread_ts,
        slackWorkspaceDomain: slackWorkspace.domain
      });
    } catch (error) {
      this.logger.error(`Error enhancing messages with tool context`, error);
      enhancedPreviousMessages = previousMessages;
    }
    this.logger.log(`Enhanced previous messages`, {
      enhancedPreviousMessages: encryptForLogs(JSON.stringify(enhancedPreviousMessages))
    });

    const selectedTools = await this.selectTools(message, tools, llm);
    this.logger.log('Lightweight tool selection complete', {
      selectedToolNames: selectedTools.selectedToolNames,
      reason: encryptForLogs(selectedTools.reason)
    });

    const agentResult = await this.supportPilotAgent.processWithSelectedTools(
      message,
      tools,
      selectedTools.selectedToolNames,
      enhancedPreviousMessages,
      llm,
      authorName
    );
    if (agentResult.stepCompleted === 'tool_selection') {
      return slackify(agentResult.incompleteExecutionOutput);
    }

    // Store the plan in conversation state
    conversationState.last_plan = {
      steps: agentResult.plan,
      completed: false
    };

    // Update conversation state with tool calls
    if (agentResult.toolCallTracker.toolCalls) {
      const newToolCalls = Object.fromEntries(
        Object.entries(agentResult.toolCallTracker.toolCalls).map(([runId, call]) => {
          const args = typeof call.args === 'string' ? { input: call.args } : call.args;
          const content =
            typeof call.result === 'string'
              ? call.result
              : call.result
                ? JSON.stringify(call.result)
                : '';

          return [
            runId,
            {
              name: call.name,
              args,
              result: { kwargs: { content } }
            }
          ];
        })
      );

      conversationState.last_tool_calls = {
        ...conversationState.last_tool_calls,
        ...newToolCalls
      };

      // Mark plan as completed
      if (conversationState.last_plan) {
        conversationState.last_plan.completed = true;
      }
    }
    conversationState.message_count++;
    await conversationState.save();

    const { totalTokens, toolCallCount, toolNames } =
      agentResult.agentExecutionOutput.messages.reduce(
        (acc, msg) => {
          // Add token usage from AIMessages
          const tokens =
            msg instanceof AIMessage && msg.usage_metadata ? msg.usage_metadata.total_tokens : 0;

          // Add tool calls and names if it's an AIMessage with tool calls
          if (msg instanceof AIMessage && msg.tool_calls) {
            const toolsInMessage = msg.tool_calls.map((call) => call.name);
            return {
              totalTokens: acc.totalTokens + tokens,
              toolCallCount: acc.toolCallCount + msg.tool_calls.length,
              toolNames: [...acc.toolNames, ...toolsInMessage]
            };
          }

          return {
            ...acc,
            totalTokens: acc.totalTokens + tokens
          };
        },
        { totalTokens: 0, toolCallCount: 0, toolNames: [] as string[] }
      );

    this.logger.log(
      `Token usage: ${totalTokens}, Tool calls made: ${toolCallCount}, Tools used: ${toolNames.join(', ')}`
    );
    await this.tool.shutDownMcpServers();

    const llmResponse =
      agentResult.agentExecutionOutput.messages[
        agentResult.agentExecutionOutput.messages.length - 1
      ].content;

    const finalContent = Array.isArray(llmResponse) ? llmResponse.join(' ') : llmResponse;
    return slackify(finalContent);
  }

  private async classifyIntent(message: string, llm: BaseChatModel): Promise<IntentClassification> {
    const domains = INTEGRATIONS.map((integration) => {
      return `- ${integration.value}: ${integration.oneLineSummary}. Example: ${integration.suggestedPrompt.message}`;
    }).join('\n');

    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`Classify the user's Slack message for SupportPilot.
Use only the message text. Do not use conversation history or tool schemas.

Domains:
${domains}
- common: current date/time or generic utility requests
- slack: Slack channel, thread, user, message, or conversation tasks
- none: greetings, general chat, or unsupported/no-tool messages

Return noise only for acknowledgements, emoji-only messages, or messages that do not require any response.
Infer the domain from intent even when the app name is not mentioned. For example, "merge the PR" is github.`),
      HumanMessagePromptTemplate.fromTemplate('{input}')
    ]);
    try {
      const result = await invokeWithStructuredOutput(
        llm,
        prompt,
        z.object({
          intent: z.enum(['tool_request', 'chat', 'noise']),
          domain: z.string().describe('One domain id from the prompt, or "none".'),
          confidence: z.number().min(0).max(1),
          reason: z.string()
        }),
        { input: message }
      );
      const validDomains = new Set([
        ...INTEGRATIONS.map((integration) => integration.value),
        'common',
        'slack',
        'none'
      ]);

      return {
        intent: result.intent,
        domain: validDomains.has(result.domain) ? result.domain : 'none',
        confidence: result.confidence,
        reason: result.reason
      };
    } catch (error) {
      this.logger.error('Intent classification failed; falling back to tool request', error);
      return {
        intent: 'tool_request',
        domain: 'none',
        confidence: 0,
        reason: 'Classifier failed.'
      };
    }
  }

  private async selectTools(
    message: string,
    tools: NonNullable<Awaited<ReturnType<ToolService['getAvailableTools']>>>,
    llm: BaseChatModel
  ): Promise<ToolSelectionResult> {
    const summaries = Object.values(tools)
      .flatMap((entry) => entry.toolKit.toolConfigs)
      .map((toolConfig) => `- ${toolConfig.tool.name}: ${toolConfig.tool.description}`)
      .join('\n');

    const allToolNames = Object.values(tools)
      .flatMap((entry) => entry.toolKit.toolConfigs)
      .map((toolConfig) => toolConfig.tool.name);

    if (!allToolNames.length) return { selectedToolNames: [], reason: 'No tools available.' };

    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(`Select the smallest practical set of tools for this request.
You only have tool names and one-line descriptions. Do not infer parameter schemas.
Include supporting read/status/search tools when an action needs context before execution.

Available tools:
${summaries}`),
      HumanMessagePromptTemplate.fromTemplate('{input}')
    ]);
    try {
      const result = await invokeWithStructuredOutput(
        llm,
        prompt,
        z.object({
          selectedToolNames: z.array(z.string()),
          reason: z.string()
        }),
        { input: message }
      );
      const normalizedAllNames = allToolNames.map(name => ({ original: name, normalized: name.toLowerCase().replace(/[^a-z0-9]/g, '') }));
      
      const selectedToolNames = result.selectedToolNames.map(name => {
        const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Find best match: exact normalized match, or one containing the other
        const match = normalizedAllNames.find(
          t => t.normalized === normalizedName || 
               normalizedName.includes(t.normalized) || 
               t.normalized.includes(normalizedName)
        );
        return match?.original;
      }).filter(Boolean) as string[];

      const uniqueSelected = [...new Set(selectedToolNames)];

      return {
        selectedToolNames: uniqueSelected.length ? uniqueSelected : allToolNames,
        reason: result.reason
      };
    } catch (error) {
      this.logger.error('Lightweight tool selection failed; using domain-scoped tools', error);
      return {
        selectedToolNames: allToolNames,
        reason: 'Tool selection failed.'
      };
    }
  }

  private async generateDirectResponse(
    message: string,
    llm: BaseChatModel,
    authorName: string
  ): Promise<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(SupportPilotPrompts.directResponsePrompt(authorName)),
      HumanMessagePromptTemplate.fromTemplate('{input}')
    ]);
    const chain = RunnableSequence.from([prompt, llm]);
    const result = await chain.invoke({ input: message });
    return Array.isArray(result.content) ? result.content.join(' ') : result.content;
  }
}
