import { AIProviderError, AIProviderId } from '../types';

export interface FetchJsonOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  providerId: AIProviderId;
}

/**
 * Thin wrapper around the global fetch (available in the VS Code extension
 * host's Node runtime) that normalizes error handling into AIProviderError so
 * command handlers can present consistent, actionable messages regardless of
 * which provider failed.
 */
export async function fetchJson<T>(opts: FetchJsonOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: opts.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new AIProviderError('Request was cancelled.', opts.providerId, 'network');
    }
    throw new AIProviderError(
      `Could not reach ${opts.url}. Check the base URL / host and your network connection. (${(err as Error).message})`,
      opts.providerId,
      'network',
    );
  }

  if (!response.ok) {
    const bodyText = await safeText(response);
    const kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rateLimit' : 'invalidRequest';
    throw new AIProviderError(
      `${opts.providerId} returned HTTP ${response.status}: ${truncate(bodyText, 500)}`,
      opts.providerId,
      kind,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new AIProviderError(`${opts.providerId} returned a response that was not valid JSON.`, opts.providerId, 'unknown');
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
