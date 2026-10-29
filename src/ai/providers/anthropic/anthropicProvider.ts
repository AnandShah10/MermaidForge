import * as vscode from 'vscode';
import {
  AICapabilities,
  AIModelInfo,
  AIProvider,
  AIProviderError,
  ChatMessage,
  ConfigValidationResult,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
} from '../../types';
import { fetchJson } from '../httpUtils';
import { SecretsManager } from '../../../utils/secrets';

const CAPS: AICapabilities = { streaming: true, structuredOutput: false, vision: true, toolCalling: true, jsonMode: false, localExecution: false };

const KNOWN_MODELS: AIModelInfo[] = [
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', capabilities: CAPS },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', capabilities: CAPS },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', capabilities: CAPS },
];

export function createAnthropicProvider(config: vscode.WorkspaceConfiguration, secrets: SecretsManager): AIProvider {
  const baseUrl = (config.get<string>('ai.providers.anthropic.baseUrl') || 'https://api.anthropic.com/v1').replace(/\/$/, '');

  async function headers(): Promise<Record<string, string>> {
    const key = await secrets.getApiKey('anthropic');
    return {
      ...(key ? { 'x-api-key': key } : {}),
      'anthropic-version': '2023-06-01',
    };
  }

  function splitSystem(messages: ChatMessage[]): { system: string | undefined; rest: Array<{ role: 'user' | 'assistant'; content: string }> } {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }));
    return { system, rest };
  }

  return {
    id: 'anthropic',
    displayName: 'Anthropic',

    async getModels(): Promise<AIModelInfo[]> {
      // The public models-list endpoint requires the same auth; fall back to
      // a known-good static list if it's unavailable so the picker still works.
      try {
        const h = await headers();
        const data = await fetchJson<{ data?: Array<{ id: string; display_name?: string }> }>({
          url: `${baseUrl}/models`,
          method: 'GET',
          headers: h,
          providerId: 'anthropic',
        });
        if (data.data?.length) {
          return data.data.map((m) => ({ id: m.id, displayName: m.display_name ?? m.id, capabilities: CAPS }));
        }
      } catch {
        // fall through to static list
      }
      return KNOWN_MODELS;
    },

    async generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      const { system, rest } = splitSystem(messages);
      const h = await headers();
      const body = {
        model: options.model,
        system,
        messages: rest,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.2,
      };
      const data = await fetchJson<any>({ url: `${baseUrl}/messages`, headers: h, body, signal: options.signal, providerId: 'anthropic' });
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const finishReason = data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'max_tokens' ? 'length' : 'unknown';
      return { text, finishReason, raw: data };
    },

    async *stream(messages: ChatMessage[], options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
      const { system, rest } = splitSystem(messages);
      const h = await headers();
      const body = {
        model: options.model,
        system,
        messages: rest,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.2,
        stream: true,
      };
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...h },
          body: JSON.stringify(body),
          signal: options.signal,
        });
      } catch (err) {
        throw new AIProviderError(`Anthropic streaming request failed: ${(err as Error).message}`, 'anthropic', 'network');
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new AIProviderError(`Anthropic streaming returned HTTP ${response.status}: ${text.slice(0, 300)}`, 'anthropic', 'invalidRequest');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          try {
            const json = JSON.parse(payload);
            if (json.type === 'content_block_delta' && json.delta?.text) {
              yield { delta: json.delta.text, done: false };
            }
            if (json.type === 'message_stop') {
              yield { delta: '', done: true };
              return;
            }
          } catch {
            // ignore malformed fragment
          }
        }
      }
      yield { delta: '', done: true };
    },

    async chat(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      return this.generate(messages, options);
    },

    async validateConfiguration(): Promise<ConfigValidationResult> {
      const key = await secrets.getApiKey('anthropic');
      if (!key) {
        return { valid: false, message: 'No Anthropic API key is configured. Run "AI Mermaid: Configure Provider" to add one.' };
      }
      return { valid: true };
    },

    supportsCapability(_model: string, capability: keyof AICapabilities): boolean {
      return CAPS[capability];
    },
  };
}
