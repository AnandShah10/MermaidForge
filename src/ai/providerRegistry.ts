import * as vscode from 'vscode';
import { AIProvider, AIProviderId } from './types';
import { SecretsManager } from '../utils/secrets';
import { createOpenAIProvider } from './providers/openai/openaiProvider';
import { createAzureProvider } from './providers/azure/azureProvider';
import { createAnthropicProvider } from './providers/anthropic/anthropicProvider';
import { createGoogleProvider } from './providers/google/googleProvider';
import { createOllamaProvider } from './providers/ollama/ollamaProvider';
import { createCustomProvider } from './providers/openaiCompatible/customProvider';

export const ALL_PROVIDER_IDS: AIProviderId[] = ['openai', 'azure', 'anthropic', 'google', 'ollama', 'custom'];

export const PROVIDER_DISPLAY_NAMES: Record<AIProviderId, string> = {
  openai: 'OpenAI',
  azure: 'Azure OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama (local)',
  custom: 'Custom (OpenAI-compatible)',
};

/**
 * Builds a fresh AIProvider instance for the given id, reading current
 * settings each time (deliberately not cached across calls — settings can
 * change between commands, and provider construction is cheap since it does
 * no I/O itself).
 */
export function createProvider(providerId: AIProviderId, secrets: SecretsManager): AIProvider {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  switch (providerId) {
    case 'openai':
      return createOpenAIProvider(config, secrets);
    case 'azure':
      return createAzureProvider(config, secrets);
    case 'anthropic':
      return createAnthropicProvider(config, secrets);
    case 'google':
      return createGoogleProvider(config, secrets);
    case 'ollama':
      return createOllamaProvider(config);
    case 'custom':
      return createCustomProvider(config, secrets);
    default: {
      const _exhaustive: never = providerId;
      throw new Error(`Unknown provider id: ${_exhaustive}`);
    }
  }
}

export function getDefaultProviderId(): AIProviderId {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  return (config.get<AIProviderId>('ai.defaultProvider') ?? 'anthropic') as AIProviderId;
}

export function getDefaultModel(): string {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  return config.get<string>('ai.defaultModel') ?? '';
}
