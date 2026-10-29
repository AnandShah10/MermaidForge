import * as vscode from 'vscode';
import { AIProviderId } from '../ai/types';

const SECRET_KEY_PREFIX = 'mermaidForge.apiKey.';

/**
 * All API keys are stored exclusively in VS Code SecretStorage — never in
 * settings.json, never logged, never sent anywhere except the corresponding
 * provider's own API host as an Authorization header.
 */
export class SecretsManager {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getApiKey(providerId: AIProviderId): Promise<string | undefined> {
    return this.secretStorage.get(SECRET_KEY_PREFIX + providerId);
  }

  async setApiKey(providerId: AIProviderId, value: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_PREFIX + providerId, value);
  }

  async deleteApiKey(providerId: AIProviderId): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY_PREFIX + providerId);
  }
}
