/**
 * Provider-agnostic AI abstraction. Nothing in core/ (diagram logic) or in
 * commands/ imports a provider-specific type — everything talks to
 * `AIProvider`. Provider-specific request/response shapes are translated at
 * the edge, inside each provider's implementation file.
 */

export type AIProviderId = 'openai' | 'azure' | 'anthropic' | 'google' | 'ollama' | 'custom';

export interface AICapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  localExecution: boolean;
}

export interface AIModelInfo {
  id: string;
  displayName: string;
  capabilities: AICapabilities;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  finishReason: 'stop' | 'length' | 'error' | 'unknown';
  raw?: unknown;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  message?: string;
}

/**
 * Common surface every AI provider implements. Diagram/business logic (the
 * ai/service.ts orchestrator) depends only on this interface, never on a
 * concrete provider class, so adding a provider never requires touching
 * unrelated code — register it in providerRegistry.ts and it's available
 * everywhere AI features are used.
 */
export interface AIProvider {
  readonly id: AIProviderId;
  readonly displayName: string;

  /** Lists models this provider currently exposes (may hit the network; callers should cache). */
  getModels(): Promise<AIModelInfo[]>;

  /** Single-shot, non-streaming completion from a chat-style message list. */
  generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult>;

  /** Streaming completion. Providers without native streaming support should reject via supportsCapability('streaming') === false rather than faking chunks. */
  stream(messages: ChatMessage[], options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown>;

  /** Convenience wrapper most callers use — equivalent to generate() with role bookkeeping handled by the caller. */
  chat(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult>;

  /** Checks that required configuration (base URL, endpoint, deployment, etc.) and credentials are present, without necessarily making a network call. */
  validateConfiguration(): Promise<ConfigValidationResult>;

  supportsCapability(model: string, capability: keyof AICapabilities): boolean;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: AIProviderId,
    public readonly kind: 'auth' | 'network' | 'rateLimit' | 'invalidRequest' | 'unsupported' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
