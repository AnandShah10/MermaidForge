import * as vscode from 'vscode';
import { ALL_PROVIDER_IDS, PROVIDER_DISPLAY_NAMES, createProvider } from './providerRegistry';
import { SecretsManager } from '../utils/secrets';
import { AIProviderId } from './types';

export async function runConfigureProviderCommand(secrets: SecretsManager): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    ALL_PROVIDER_IDS.map((id) => ({ label: PROVIDER_DISPLAY_NAMES[id], id })),
    { placeHolder: 'Select an AI provider to configure' },
  );
  if (!pick) return;
  const providerId = pick.id as AIProviderId;

  if (providerId === 'ollama') {
    vscode.window.showInformationMessage(
      'Ollama runs locally and needs no API key — just set mermaidForge.ai.providers.ollama.host if it is not on the default localhost:11434.',
    );
    return;
  }

  const key = await vscode.window.showInputBox({
    prompt: `Enter the API key for ${PROVIDER_DISPLAY_NAMES[providerId]}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return; // cancelled
  if (key.trim().length === 0) {
    await secrets.deleteApiKey(providerId);
    vscode.window.showInformationMessage(`Cleared the stored API key for ${PROVIDER_DISPLAY_NAMES[providerId]}.`);
    return;
  }
  await secrets.setApiKey(providerId, key.trim());

  const config = vscode.workspace.getConfiguration('mermaidForge');
  if (providerId === 'azure' && !config.get<string>('ai.providers.azure.endpoint')) {
    vscode.window.showWarningMessage('API key saved. Remember to also set mermaidForge.ai.providers.azure.endpoint and .deployment in settings.');
  } else if (providerId === 'custom' && !config.get<string>('ai.providers.custom.baseUrl')) {
    vscode.window.showWarningMessage('API key saved. Remember to also set mermaidForge.ai.providers.custom.baseUrl in settings.');
  } else {
    vscode.window.showInformationMessage(`API key saved for ${PROVIDER_DISPLAY_NAMES[providerId]}.`);
  }

  const setDefault = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: `Make ${PROVIDER_DISPLAY_NAMES[providerId]} the default AI provider?` });
  if (setDefault === 'Yes') {
    await config.update('ai.defaultProvider', providerId, vscode.ConfigurationTarget.Global);
  }
}

/** Prompts the user to pick a model for a provider, listing live models when the provider supports it and falling back to a manual text entry on failure. */
export async function pickModel(providerId: AIProviderId, secrets: SecretsManager): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  const configuredDefault = config.get<string>('ai.defaultModel');
  if (configuredDefault) return configuredDefault;

  const provider = createProvider(providerId, secrets);
  try {
    const models = await provider.getModels();
    if (models.length > 0) {
      const pick = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.displayName, description: m.id, id: m.id })),
        { placeHolder: `Select a model for ${PROVIDER_DISPLAY_NAMES[providerId]}` },
      );
      return pick?.id;
    }
  } catch {
    // fall through to manual entry
  }

  return vscode.window.showInputBox({ prompt: `Enter a model id for ${PROVIDER_DISPLAY_NAMES[providerId]}`, ignoreFocusOut: true });
}
