import { SlackWorkspace } from '@supportpilot/database/models';
import { Connections } from '@supportpilot/lib/types/common';
import { ConversationState } from '@supportpilot/database/models';
import { BaseMessage } from '@langchain/core/messages';
import { SupportPilotCallBackManager } from './callback-manager';
import { PlanStepSchema } from './schema';
import { z } from 'zod';
import { Toolkit } from 'supportPilot-common-agent';

export type LLMContext = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export enum SupportedChatModels {
  OPENAI = 'openai',
  GEMINI = 'gemini',
  GROQ = 'groq',
  OPENROUTER = 'openrouter'
}

export interface MessageProcessingArgs {
  message: string;
  slackWorkspace: SlackWorkspace;
  threadTs: string;
  previousMessages: LLMContext[];
  channelId: string;
  authorName: string;
}

export type AvailableToolsWithConfig = Record<
  string,
  { toolKit: Toolkit; config?: Connections | SlackWorkspace }
>;

export type IntentClassification = {
  intent: 'tool_request' | 'chat' | 'noise';
  domain: string | 'none';
  confidence: number;
  reason: string;
};

export type ToolSelectionResult = {
  selectedToolNames: string[];
  reason: string;
};

export interface ToolContextParams {
  previousMessages: LLMContext[];
  lastToolCalls: ConversationState['last_tool_calls'];
  channelId: string;
  threadTs?: string;
  slackWorkspaceDomain?: string;
}

export type SupportPilotAgentResultToolSelectionOutput = {
  selectedTools: string[] | 'none';
  content: string;
  reason: string;
};

export type SupportPilotAgentPlan = {
  type: 'tool' | 'reason';
  tool?: string | undefined;
  args?: {} | undefined;
  input?: string | undefined;
}[];

export type SupportPilotAgentResult =
  | {
      stepCompleted: 'tool_selection';
      toolSelectionOutput: SupportPilotAgentResultToolSelectionOutput;
      incompleteExecutionOutput: string;
    }
  | {
      stepCompleted: 'agent_execution';
      toolSelectionOutput: SupportPilotAgentResultToolSelectionOutput;
      plan: SupportPilotAgentPlan;
      formattedPlan: string;
      agentExecutionOutput: { messages: BaseMessage[] };
      toolCallTracker: SupportPilotCallBackManager;
    };

export type PlanResult = z.infer<typeof PlanStepSchema>;
