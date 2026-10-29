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

const CAPS: AICapabilities = { streaming: true, structuredOutput: false, vision: false, toolCalling: false, jsonMode: true, localExecution: true };

/** Ollama needs no SecretsManager — it's a fully local provider by design (no API key concept). */
export function createOllamaProvider(config: vscode.WorkspaceConfiguration): AIProvider {
  const host = (config.get<string>('ai.providers.ollama.host') || 'http://localhost:11434').replace(/\/$/, '');

  return {
    id: 'ollama',
    displayName: 'Ollama (local)',

    async getModels(): Promise<AIModelInfo[]> {
      const data = await fetchJson<{ models?: Array<{ name: string }> }>({ url: `${host}/api/tags`, method: 'GET', providerId: 'ollama' });
      return (data.models ?? []).map((m) => ({ id: m.name, displayName: m.name, capabilities: CAPS }));
    },

    async generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      const body = {
        model: options.model,
        messages,
        stream: false,
        options: { temperature: options.temperature ?? 0.2 },
      };
      const data = await fetchJson<any>({ url: `${host}/api/chat`, body, signal: options.signal, providerId: 'ollama' });
      return { text: data.message?.content ?? '', finishReason: data.done ? 'stop' : 'unknown', raw: data };
    },

    async *stream(messages: ChatMessage[], options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
      const body = { model: options.model, messages, stream: true, options: { temperature: options.temperature ?? 0.2 } };
      let response: Response;
      try {
        response = await fetch(`${host}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: options.signal,
        });
      } catch (err) {
        throw new AIProviderError(
          `Could not reach Ollama at ${host}. Is "ollama serve" running? (${(err as Error).message})`,
          'ollama',
          'network',
        );
      }
      if (!response.ok || !response.body) {
        throw new AIProviderError(`Ollama returned HTTP ${response.status}.`, 'ollama', 'invalidRequest');
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
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) yield { delta: json.message.content, done: false };
            if (json.done) {
              yield { delta: '', done: true };
              return;
            }
          } catch {
            // partial line; ignore
          }
        }
      }
      yield { delta: '', done: true };
    },

    async chat(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      return this.generate(messages, options);
    },

    async validateConfiguration(): Promise<ConfigValidationResult> {
      try {
        await fetchJson<unknown>({ url: `${host}/api/tags`, method: 'GET', providerId: 'ollama' });
        return { valid: true };
      } catch (err) {
        return { valid: false, message: err instanceof Error ? err.message : `Could not reach Ollama at ${host}.` };
      }
    },

    supportsCapability(_model: string, capability: keyof AICapabilities): boolean {
      return CAPS[capability];
    },
  };
}
