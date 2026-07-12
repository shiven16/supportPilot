import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { SlackWorkspace } from '../database/models';
import { Md } from 'slack-block-builder';
import { SupportedChatModels } from './types';

type ProviderConfig = {
  provider: SupportedChatModels;
  apiKey?: string | null;
  baseURL?: string;
  model: string;
  defaultHeaders?: Record<string, string>;
};

const DEFAULT_PROVIDER_PRIORITY = [
  SupportedChatModels.OPENAI,
  SupportedChatModels.GEMINI,
  SupportedChatModels.GROQ,
  SupportedChatModels.OPENROUTER
];

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);

  constructor(private readonly config: ConfigService) {}

  async getProvider(slackWorkspace: SlackWorkspace): Promise<BaseChatModel> {
    const providerConfig = this.getSelectedProviderConfig(slackWorkspace);
    if (!providerConfig) {
      this.logger.log('No LLM provider key found', { teamId: slackWorkspace.team_id });
      throw new BadRequestException(
        `No AI provider API key is configured. Add one ${Md.link(slackWorkspace.getAppHomeRedirectUrl('messages'), 'here')} or set an API key in the environment.`
      );
    }

    return new ChatOpenAI({
      model: providerConfig.model,
      temperature: 0.1,
      apiKey: providerConfig.apiKey || undefined,
      configuration: {
        ...(providerConfig.baseURL ? { baseURL: providerConfig.baseURL } : {}),
        ...(providerConfig.defaultHeaders ? { defaultHeaders: providerConfig.defaultHeaders } : {})
      }
    });
  }

  private getSelectedProviderConfig(slackWorkspace: SlackWorkspace): ProviderConfig | undefined {
    const configs = this.getProviderConfigs(slackWorkspace);
    const byProvider = new Map(configs.map((providerConfig) => [providerConfig.provider, providerConfig]));

    for (const provider of this.getProviderPriority()) {
      const providerConfig = byProvider.get(provider);
      if (providerConfig?.apiKey) return providerConfig;
    }

    return undefined;
  }

  private getProviderPriority(): SupportedChatModels[] {
    const configuredPriority =
      this.config.get<string>('AI_PROVIDER_PRIORITY') ||
      this.config.get<string>('SUPPORTPILOT_AI_PROVIDER_PRIORITY');

    if (!configuredPriority) return DEFAULT_PROVIDER_PRIORITY;

    const parsed = configuredPriority
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean) as SupportedChatModels[];

    const allowed = new Set(Object.values(SupportedChatModels));
    const valid = parsed.filter((provider) => allowed.has(provider));
    return valid.length ? valid : DEFAULT_PROVIDER_PRIORITY;
  }

  private getProviderConfigs(slackWorkspace: SlackWorkspace): ProviderConfig[] {
    return [
      {
        provider: SupportedChatModels.OPENAI,
        apiKey: this.config.get<string>('OPENAI_API_KEY') || slackWorkspace.openai_key,
        baseURL: this.config.get<string>('OPENAI_BASE_URL'),
        model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o'
      },
      {
        provider: SupportedChatModels.GEMINI,
        apiKey: this.config.get<string>('GEMINI_API_KEY'),
        baseURL:
          this.config.get<string>('GEMINI_BASE_URL') ||
          'https://generativelanguage.googleapis.com/v1beta/openai',
        model: this.config.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash'
      },
      {
        provider: SupportedChatModels.GROQ,
        apiKey: this.config.get<string>('GROQ_API_KEY'),
        baseURL: this.config.get<string>('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1',
        model: this.config.get<string>('GROQ_MODEL') || 'llama-3.3-70b-versatile'
      },
      {
        provider: SupportedChatModels.OPENROUTER,
        apiKey:
          this.config.get<string>('OPENROUTER_API_KEY') ||
          this.config.get<string>('OPEN_ROUTER_API_KEY'),
        baseURL:
          this.config.get<string>('OPENROUTER_BASE_URL') ||
          this.config.get<string>('OPEN_ROUTER_BASE_URL') ||
          'https://openrouter.ai/api/v1',
        model:
          this.config.get<string>('OPENROUTER_MODEL') ||
          this.config.get<string>('OPEN_ROUTER_MODEL') ||
          'openai/gpt-4o',
        defaultHeaders: {
          'HTTP-Referer': this.config.get<string>('OPENROUTER_SITE_URL') || 'https://supportpilot.app',
          'X-Title': this.config.get<string>('OPENROUTER_APP_NAME') || 'SupportPilot'
        }
      }
    ];
  }
}
