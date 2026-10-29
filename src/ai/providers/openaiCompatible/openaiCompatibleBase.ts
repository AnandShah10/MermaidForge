import {
  AICapabilities,
  AIModelInfo,
  AIProvider,
  AIProviderError,
  AIProviderId,
  ChatMessage,
  ConfigValidationResult,
  GenerateOptions,
  GenerateResult,
  StreamChunk,
} from '../../types';
import { fetchJson } from '../httpUtils';

export interface OpenAICompatibleConfig {
  id: AIProviderId;
  displayName: string;
  /** Builds the full chat completions URL, e.g. `${baseUrl}/chat/completions`. */
  chatUrl: () => string;
  /** Builds the full models-list URL, or null if listing isn't supported (caller falls back to a configured default). */
  modelsUrl: () => string | null;
  headers: () => Promise<Record<string, string>>;
  validate: () => Promise<ConfigValidationResult>;
  defaultCapabilities: AICapabilities;
  /** Maps a raw /models entry to an AIModelInfo; return null to skip it. */
  mapModel?: (raw: any) => AIModelInfo | null;
}

const FALLBACK_CAPABILITIES: AICapabilities = {
  streaming: true,
  structuredOutput: false,
  vision: false,
  toolCalling: true,
  jsonMode: true,
  localExecution: false,
};

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: AIProviderId;
  readonly displayName: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
  }

  async getModels(): Promise<AIModelInfo[]> {
    const url = this.config.modelsUrl();
    if (!url) return [];
    try {
      const headers = await this.config.headers();
      const data = await fetchJson<{ data?: any[] }>({ url, method: 'GET', headers, providerId: this.id });
      const list = data.data ?? [];
      const mapped = list
        .map((m) => (this.config.mapModel ? this.config.mapModel(m) : this.defaultMap(m)))
        .filter((m): m is AIModelInfo => m !== null);
      return mapped;
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      throw new AIProviderError(`Failed to list models: ${(err as Error).message}`, this.id, 'unknown');
    }
  }

  private defaultMap(raw: any): AIModelInfo | null {
    if (!raw?.id) return null;
    return { id: raw.id, displayName: raw.id, capabilities: this.config.defaultCapabilities ?? FALLBACK_CAPABILITIES };
  }

  async generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const headers = await this.config.headers();
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2,
      stream: false,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.jsonMode) body.response_format = { type: 'json_object' };

    const data = await fetchJson<any>({ url: this.config.chatUrl(), headers, body, signal: options.signal, providerId: this.id });
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = mapFinishReason(choice?.finish_reason);
    return { text, finishReason, raw: data };
  }

  async *stream(messages: ChatMessage[], options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const headers = await this.config.headers();
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2,
      stream: true,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;

    let response: Response;
    try {
      response = await fetch(this.config.chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      throw new AIProviderError(`Streaming request failed: ${(err as Error).message}`, this.id, 'network');
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new AIProviderError(`${this.id} streaming returned HTTP ${response.status}: ${text.slice(0, 300)}`, this.id, 'invalidRequest');
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
        if (payload === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { delta, done: false };
        } catch {
          // Ignore malformed SSE fragments (e.g. keep-alive comments).
        }
      }
    }
    yield { delta: '', done: true };
  }

  async chat(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
    return this.generate(messages, options);
  }

  async validateConfiguration(): Promise<ConfigValidationResult> {
    return this.config.validate();
  }

  supportsCapability(_model: string, capability: keyof AICapabilities): boolean {
    return this.config.defaultCapabilities[capability];
  }
}

function mapFinishReason(reason: string | undefined): GenerateResult['finishReason'] {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (!reason) return 'unknown';
  return 'unknown';
}
