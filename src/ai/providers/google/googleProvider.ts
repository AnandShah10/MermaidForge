import * as vscode from 'vscode';
import {
  AICapabilities,
  AIModelInfo,
  AIProvider,
  ChatMessage,
  ConfigValidationResult,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
} from '../../types';
import { fetchJson } from '../httpUtils';
import { SecretsManager } from '../../../utils/secrets';

const CAPS: AICapabilities = { streaming: true, structuredOutput: true, vision: true, toolCalling: true, jsonMode: true, localExecution: false };

function toGeminiContents(messages: ChatMessage[]): { systemInstruction: { parts: [{ text: string }] } | undefined; contents: any[] } {
  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  return { systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined, contents };
}

export function createGoogleProvider(config: vscode.WorkspaceConfiguration, secrets: SecretsManager): AIProvider {
  const baseUrl = (config.get<string>('ai.providers.google.baseUrl') || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

  async function apiKeyParam(): Promise<string> {
    const key = await secrets.getApiKey('google');
    return key ? `?key=${encodeURIComponent(key)}` : '';
  }

  return {
    id: 'google',
    displayName: 'Google Gemini',

    async getModels(): Promise<AIModelInfo[]> {
      const qs = await apiKeyParam();
      const data = await fetchJson<{ models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }>({
        url: `${baseUrl}/models${qs}`,
        method: 'GET',
        providerId: 'google',
      });
      return (data.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), displayName: m.displayName ?? m.name, capabilities: CAPS }));
    },

    async generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      const qs = await apiKeyParam();
      const { systemInstruction, contents } = toGeminiContents(messages);
      const body: Record<string, unknown> = {
        contents,
        systemInstruction,
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens,
          ...(options.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      };
      const data = await fetchJson<any>({
        url: `${baseUrl}/models/${encodeURIComponent(options.model)}:generateContent${qs}`,
        body,
        signal: options.signal,
        providerId: 'google',
      });
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      const finishReason = candidate?.finishReason === 'STOP' ? 'stop' : candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'unknown';
      return { text, finishReason, raw: data };
    },

    async *stream(messages: ChatMessage[], options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
      // Gemini's streaming endpoint uses a JSON-array-over-SSE-ish transport
      // that differs enough from OpenAI/Anthropic's line-delimited SSE that
      // faithfully streaming it needs response-shape-specific parsing we
      // haven't hardened yet. Rather than emit subtly-wrong partial chunks,
      // fall back to a single non-streaming call surfaced as one chunk — the
      // UI still works, just without token-by-token updates for this provider.
      const result = await this.generate(messages, options);
      yield { delta: result.text, done: false };
      yield { delta: '', done: true };
    },

    async chat(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
      return this.generate(messages, options);
    },

    async validateConfiguration(): Promise<ConfigValidationResult> {
      const key = await secrets.getApiKey('google');
      if (!key) {
        return { valid: false, message: 'No Google API key is configured. Run "AI Mermaid: Configure Provider" to add one.' };
      }
      return { valid: true };
    },

    supportsCapability(_model: string, capability: keyof AICapabilities): boolean {
      if (capability === 'streaming') return false; // see note in stream() above
      return CAPS[capability];
    },
  };
}
