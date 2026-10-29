import * as vscode from 'vscode';
import { AIProvider, ConfigValidationResult } from '../../types';
import { OpenAICompatibleProvider } from '../openaiCompatible/openaiCompatibleBase';
import { SecretsManager } from '../../../utils/secrets';

export function createOpenAIProvider(config: vscode.WorkspaceConfiguration, secrets: SecretsManager): AIProvider {
  const baseUrl = (config.get<string>('ai.providers.openai.baseUrl') || 'https://api.openai.com/v1').replace(/\/$/, '');

  const headers = async (): Promise<Record<string, string>> => {
    const key = await secrets.getApiKey('openai');
    return key ? { Authorization: `Bearer ${key}` } : {};
  };

  const validate = async (): Promise<ConfigValidationResult> => {
    const key = await secrets.getApiKey('openai');
    if (!key) {
      return { valid: false, message: 'No OpenAI API key is configured. Run "AI Mermaid: Configure Provider" to add one.' };
    }
    if (!baseUrl) {
      return { valid: false, message: 'OpenAI base URL is empty.' };
    }
    return { valid: true };
  };

  return new OpenAICompatibleProvider({
    id: 'openai',
    displayName: 'OpenAI',
    chatUrl: () => `${baseUrl}/chat/completions`,
    modelsUrl: () => `${baseUrl}/models`,
    headers,
    validate,
    defaultCapabilities: {
      streaming: true,
      structuredOutput: true,
      vision: true,
      toolCalling: true,
      jsonMode: true,
      localExecution: false,
    },
    mapModel: (raw) => {
      if (!raw?.id || typeof raw.id !== 'string') return null;
      // Filter down to chat-capable model families; the /models endpoint
      // also lists embeddings/moderation/etc. models that aren't chat targets.
      if (!/^(gpt-|o[0-9]|chatgpt)/.test(raw.id)) return null;
      return {
        id: raw.id,
        displayName: raw.id,
        capabilities: { streaming: true, structuredOutput: true, vision: /gpt-4o|gpt-5|vision/.test(raw.id), toolCalling: true, jsonMode: true, localExecution: false },
      };
    },
  });
}
