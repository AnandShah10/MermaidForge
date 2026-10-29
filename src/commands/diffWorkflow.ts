import * as vscode from 'vscode';

const SCHEME = 'mermaidforge-proposed';

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(id: string, content: string): vscode.Uri {
    this.store.set(id, content);
    return vscode.Uri.parse(`${SCHEME}:/${id}.mmd`);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.replace(/^\//, '').replace(/\.mmd$/, '');
    return this.store.get(id) ?? '';
  }
}

let provider: ProposedContentProvider | undefined;

export function registerDiffWorkflow(context: vscode.ExtensionContext): void {
  provider = new ProposedContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
}

/**
 * Shows a VS Code diff editor (current vs. AI-proposed) and asks the user to
 * accept or reject before anything is written. This is the single choke
 * point every AI diagram-modifying command routes through — no command
 * writes AI output to a document directly.
 */
export async function reviewAndApply(
  editor: vscode.TextEditor,
  targetRange: vscode.Range | undefined,
  proposedContent: string,
  diffTitle: string,
): Promise<boolean> {
  if (!provider) {
    throw new Error('Diff workflow was not initialized.');
  }
  const originalUri = editor.document.uri;
  const proposedUri = provider.set(`${Date.now()}-${Math.random().toString(36).slice(2)}`, proposedContent);

  await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, diffTitle);

  const choice = await vscode.window.showInformationMessage(
    'Apply the AI-proposed changes to your diagram?',
    { modal: true },
    'Apply',
    'Discard',
  );
  if (choice !== 'Apply') {
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  const range = targetRange ?? new vscode.Range(0, 0, editor.document.lineCount, 0);
  edit.replace(originalUri, range, proposedContent);
  await vscode.workspace.applyEdit(edit);
  return true;
}
