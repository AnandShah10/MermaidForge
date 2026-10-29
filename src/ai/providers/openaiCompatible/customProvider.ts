import * as vscode from 'vscode';
import { AIProvider, ConfigValidationResult } from '../../types';
import { OpenAICompatibleProvider } from './openaiCompatibleBase';
import { SecretsManager } from '../../../utils/secrets';

/**
 * Generic OpenAI-compatible endpoint. This single provider is what lets
 * MermaidForge support Mistral, Groq, Together, OpenRouter, LM Studio, and
 * most future OpenAI-protocol-compatible services without new code — the
 * user just points it at a base URL. A dedicated provider (like OpenAI or
 * Azure above) is only worth adding when a service needs auth or URL
 * handling this generic path can't express.
 */
export function createCustomProvider(config: vscode.WorkspaceConfiguration, secrets: SecretsManager): AIProvider {
  const baseUrl = (config.get<string>('ai.providers.custom.baseUrl') || '').replace(/\/$/, '');
  const extraHeaders = config.get<Record<string, string>>('ai.providers.custom.headers') || {};

  const headers = async () => {
    const key = await secrets.getApiKey('custom');
    return { ...extraHeaders, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  };

  const validate = async (): Promise<ConfigValidationResult> => {
    if (!baseUrl) {
      return { valid: false, message: 'No base URL configured for the custom provider. Set mermaidForge.ai.providers.custom.baseUrl.' };
    }
    return { valid: true };
  };

  return new OpenAICompatibleProvider({
    id: 'custom',
    displayName: 'Custom (OpenAI-compatible)',
    chatUrl: () => `${baseUrl}/chat/completions`,
    modelsUrl: () => `${baseUrl}/models`,
    headers,
    validate,
    defaultCapabilities: {
      streaming: true,
      structuredOutput: false,
      vision: false,
      toolCalling: false,
      jsonMode: false,
      localExecution: false,
    },
  });
}
