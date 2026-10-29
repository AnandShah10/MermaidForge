import * as vscode from 'vscode';
import { AIProvider, ConfigValidationResult } from '../../types';
import { OpenAICompatibleProvider } from '../openaiCompatible/openaiCompatibleBase';
import { SecretsManager } from '../../../utils/secrets';

/**
 * Azure OpenAI speaks the same chat/completions JSON shape as OpenAI, but
 * with a resource-scoped URL (endpoint + deployment + api-version) and an
 * `api-key` header instead of `Authorization: Bearer`. Reusing
 * OpenAICompatibleProvider keeps the request/response/streaming logic in one
 * place; only URL construction and auth differ.
 */
export function createAzureProvider(config: vscode.WorkspaceConfiguration, secrets: SecretsManager): AIProvider {
  const endpoint = (config.get<string>('ai.providers.azure.endpoint') || '').replace(/\/$/, '');
  const deployment = config.get<string>('ai.providers.azure.deployment') || '';
  const apiVersion = config.get<string>('ai.providers.azure.apiVersion') || '2024-06-01';

  const chatUrl = () => `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const headers = async (): Promise<Record<string, string>> => {
    const key = await secrets.getApiKey('azure');
    return key ? { 'api-key': key } : {};
  };

  const validate = async (): Promise<ConfigValidationResult> => {
    const key = await secrets.getApiKey('azure');
    const problems: string[] = [];
    if (!endpoint) problems.push('endpoint');
    if (!deployment) problems.push('deployment name');
    if (!key) problems.push('API key');
    if (problems.length) {
      return { valid: false, message: `Azure OpenAI is missing: ${problems.join(', ')}. Set the endpoint/deployment in settings and the key via "AI Mermaid: Configure Provider".` };
    }
    return { valid: true };
  };

  return new OpenAICompatibleProvider({
    id: 'azure',
    displayName: 'Azure OpenAI',
    chatUrl,
    // Azure's model listing is management-plane, not data-plane; deployments
    // are configured per-resource, so there is no useful /models call here.
    // The configured deployment name is treated as the "model" to select.
    modelsUrl: () => null,
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
  });
}
