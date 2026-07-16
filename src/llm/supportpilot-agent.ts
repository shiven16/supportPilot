import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AvailableToolsWithConfig, LLMContext, PlanResult, SupportPilotAgentResult } from './types';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import {
  ChatPromptTemplate,
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder
} from '@langchain/core/prompts';
import { RunnableSequence, Runnable } from '@langchain/core/runnables';
import { ToolConfig } from 'supportPilot-common-agent';
import { SupportPilotPrompts } from '../lib/constants';
import { createAgent } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { SupportPilotCallBackManager } from './callback-manager';
import { isEqual } from 'lodash';
import { Logger } from '@nestjs/common';
import { encryptForLogs } from '../lib/utils/encryption';
import { PlanStepSchema } from './schema';
import { invokeWithStructuredOutput } from './utils';

export class SupportPilotAgent {
  private readonly logger = new Logger(SupportPilotAgent.name);
  private readonly schemaCache = new Map<string, string>();
  constructor() {}

  public async processWithTools(
    userQuery: string,
    tools: AvailableToolsWithConfig,
    previousMessages: LLMContext[],
    llm: BaseChatModel,
    queryingUserName: string
  ): Promise<SupportPilotAgentResult> {
    const toolSelectionOutput = await this.toolSelection(
      userQuery,
      tools,
      previousMessages,
      llm,
      queryingUserName
    );
    this.logger.log(`Tool selection complete`, {
      selectedTools: toolSelectionOutput.selectedTools,
      reason: encryptForLogs(toolSelectionOutput.reason)
    });

    if (
      toolSelectionOutput.selectedTools === 'none' ||
      isEqual(toolSelectionOutput.selectedTools, ['none'])
    ) {
      return {
        stepCompleted: 'tool_selection',
        incompleteExecutionOutput: toolSelectionOutput.content
          ? toolSelectionOutput.content
          : `I could not find any tools to fulfill your request.`,
        toolSelectionOutput
      };
    }

    const availableFunctions: {
      availableTools: ToolConfig[];
      config?: AvailableToolsWithConfig[keyof AvailableToolsWithConfig]['config'];
    }[] = toolSelectionOutput.selectedTools
      .map((tool) => {
        return {
          availableTools: tools[tool].toolKit.toolConfigs,
          config: tools[tool].config
        };
      })
      .flat();

    if (!availableFunctions || availableFunctions.length === 0) {
      return {
        stepCompleted: 'tool_selection',
        incompleteExecutionOutput:
          "I apologize, but I don't have any tools configured to help with your request at the moment.",
        toolSelectionOutput
      };
    }

    const customInstructions = availableFunctions
      .map((func) => {
        return func.config && 'default_prompt' in func.config && func.config.default_prompt
          ? func.config.default_prompt
          : '';
      })
      .filter(Boolean);

    const plan = await this.generatePlan(
      availableFunctions.flatMap((func) => func.availableTools),
      customInstructions,
      previousMessages,
      userQuery,
      llm,
      SupportPilotPrompts.basePrompt(queryingUserName)
    );
    const formattedPlan = plan
      .map((step, i) => {
        if (step.type === 'tool') {
          return `${i + 1}. Call tool \`${step.tool}\`. ${step.input || ''}`.trim();
        } else {
          return `${i + 1}. ${step.input}`;
        }
      })
      .join('\n');
    this.logger.log(`Plan generated for user's request`, {
      plan: encryptForLogs(formattedPlan)
    });
    const availableTools = availableFunctions.flatMap((func) =>
      func.availableTools.map((tc) => tc.tool)
    );
    const agent = createAgent({
      model: llm,
      tools: availableTools,
      systemPrompt: SupportPilotPrompts.multiStepBasePrompt(
        formattedPlan,
        queryingUserName,
        customInstructions
      )
    });

    // Create a callback to track tool calls
    const toolCallTracker = new SupportPilotCallBackManager();
    toolCallTracker.captureToolCalls = true;

    const agentExecutionOutput = await agent.invoke(
      { messages: [...previousMessages, { role: 'user', content: userQuery }] },
      { callbacks: [toolCallTracker] }
    );
    return {
      stepCompleted: 'agent_execution',
      plan,
      formattedPlan,
      toolCallTracker,
      toolSelectionOutput,
      agentExecutionOutput
    };
  }

  public async processWithSelectedTools(
    userQuery: string,
    tools: AvailableToolsWithConfig,
    selectedToolNames: string[],
    previousMessages: LLMContext[],
    llm: BaseChatModel,
    queryingUserName: string
  ): Promise<SupportPilotAgentResult> {
    const availableFunctions = Object.values(tools).map((entry) => ({
      availableTools: entry.toolKit.toolConfigs,
      config: entry.config
    }));

    const selectedToolNameSet = new Set(selectedToolNames);
    const filteredFunctions = availableFunctions
      .map((func) => ({
        ...func,
        availableTools: selectedToolNameSet.size
          ? func.availableTools.filter((toolConfig) => selectedToolNameSet.has(toolConfig.tool.name))
          : func.availableTools
      }))
      .filter((func) => func.availableTools.length > 0);

    const executionFunctions = filteredFunctions.length ? filteredFunctions : availableFunctions;
    const availableToolConfigs = executionFunctions.flatMap((func) => func.availableTools);

    if (!availableToolConfigs.length) {
      return {
        stepCompleted: 'tool_selection',
        incompleteExecutionOutput:
          "I apologize, but I don't have any tools configured to help with your request at the moment.",
        toolSelectionOutput: {
          selectedTools: 'none',
          content: '',
          reason: 'No selected tools were available for execution.'
        }
      };
    }

    const customInstructions = executionFunctions
      .map((func) => {
        return func.config && 'default_prompt' in func.config && func.config.default_prompt
          ? func.config.default_prompt
          : '';
      })
      .filter(Boolean);

    const plan = await this.generatePlan(
      availableToolConfigs,
      customInstructions,
      previousMessages,
      userQuery,
      llm,
      SupportPilotPrompts.basePrompt(queryingUserName)
    );
    const formattedPlan = plan
      .map((step, i) => {
        if (step.type === 'tool') {
          return `${i + 1}. Call tool \`${step.tool}\`. ${step.input || ''}`.trim();
        }
        return `${i + 1}. ${step.input}`;
      })
      .join('\n');

    this.logger.log(`Plan generated for user's request`, {
      plan: encryptForLogs(formattedPlan)
    });

    const agent = createAgent({
      model: llm,
      tools: availableToolConfigs.map((tc) => tc.tool),
      systemPrompt: SupportPilotPrompts.multiStepBasePrompt(
        formattedPlan,
        queryingUserName,
        customInstructions
      )
    });

    const toolCallTracker = new SupportPilotCallBackManager();
    toolCallTracker.captureToolCalls = true;

    const agentExecutionOutput = await agent.invoke(
      { messages: [...previousMessages, { role: 'user', content: userQuery }] },
      { callbacks: [toolCallTracker] }
    );

    return {
      stepCompleted: 'agent_execution',
      plan,
      formattedPlan,
      toolCallTracker,
      toolSelectionOutput: {
        selectedTools: Object.keys(tools),
        content: '',
        reason: selectedToolNames.length
          ? `Selected tools: ${selectedToolNames.join(', ')}`
          : 'No narrowed tools were provided; using domain-scoped tools.'
      },
      agentExecutionOutput
    };
  }

  async toolSelection(
    message: string,
    tools: AvailableToolsWithConfig,
    previousMessages: LLMContext[],
    llm: BaseChatModel,
    authorName: string
  ): Promise<{
    selectedTools: (keyof typeof tools)[] | 'none';
    content: string;
    reason: string;
  }> {
    const availableCategories = Object.keys(tools);

    const toolSelectionPrompts = availableCategories
      .map((category) => tools[category].toolKit.prompts?.toolSelection)
      .filter(Boolean)
      .join('\n');
    const customPrompts = availableCategories.map((category) => {
      if (tools[category].config && 'default_prompt' in tools[category].config) {
        return tools[category].config.default_prompt;
      }
      return '';
    });
    const systemPrompt = SupportPilotPrompts.basePrompt(authorName) + '\n' + toolSelectionPrompts;

    const toolSelectionFunction = tool(
      async ({ toolCategories, reason }) => {
        return { toolCategories, reason };
      },
      {
        name: 'selectTool',
        description: SupportPilotPrompts.baseToolSelection,
        schema: z.object({
          toolCategories: z.array(z.enum(availableCategories as [string, ...string[]])),
          reason: z
            .string()
            .describe(
              "An explanation of why the selected tool categories were chosen. If no tools were selected, this must include a direct answer to the user's query using general knowledge."
            )
        })
      }
    );

    let llmProviderWithTools: Runnable | undefined;
    if ('bindTools' in llm && typeof llm.bindTools === 'function') {
      llmProviderWithTools = llm.bindTools([toolSelectionFunction]);
    }

    const templateMessages = [
      SystemMessagePromptTemplate.fromTemplate(systemPrompt),
      new MessagesPlaceholder('chat_history')
    ];
    if (customPrompts.length > 0) {
      templateMessages.push(HumanMessagePromptTemplate.fromTemplate('{custom_instructions}'));
    }
    templateMessages.push(HumanMessagePromptTemplate.fromTemplate('{input}'));

    const promptTemplate = ChatPromptTemplate.fromMessages(templateMessages);

    const agentChain = RunnableSequence.from([promptTemplate, llmProviderWithTools ?? llm]);

    const result = await agentChain.invoke(
      {
        chat_history: previousMessages,
        input: message,
        tool_choice: 'auto',
        ...(customPrompts.length > 0 && { custom_instructions: customPrompts.join('\n') })
      },
      {
        callbacks: [new SupportPilotCallBackManager()]
      }
    );

    return {
      selectedTools: result.tool_calls?.[0]?.args?.toolCategories ?? 'none',
      content: Array.isArray(result.content) ? result.content.join(' ') : result.content,
      reason: result.tool_calls?.[0]?.args?.reason ?? 'No reason provided'
    };
  }

  async generatePlan(
    availableTools: ToolConfig[],
    customInstructions: string[],
    previousMessages: LLMContext[],
    message: string,
    llm: BaseChatModel,
    basePrompt: string
  ): Promise<PlanResult['steps']> {
    const allFunctions = availableTools
      .map(({ tool }) => {
        const cacheKey = `${tool.name}:${tool.description}`;
        const cachedSchema = this.schemaCache.get(cacheKey);
        if (cachedSchema) return cachedSchema;

        const jsonSchema = toJsonSchema(tool.schema as unknown as z.ZodTypeAny);
        const renderedSchema = `${tool.name}: ${tool.description} Args: ${JSON.stringify(jsonSchema, null, 2)}\n`;
        this.schemaCache.set(cacheKey, renderedSchema);
        return renderedSchema;
      })
      .flat();
    const planPrompt = ChatPromptTemplate.fromMessages([
      new SystemMessage(basePrompt),
      new SystemMessage(SupportPilotPrompts.PLANNER_PROMPT(allFunctions, customInstructions)),
      new MessagesPlaceholder('chat_history'),
      HumanMessagePromptTemplate.fromTemplate('{input}')
    ]);

    const result: PlanResult = await invokeWithStructuredOutput(
      llm,
      planPrompt,
      PlanStepSchema,
      {
        chat_history: previousMessages,
        input: message
      }
    );

    return result.steps;
  }
}
