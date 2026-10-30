import * as vscode from 'vscode';
import { PreviewPanel } from './webviews/previewPanel';
import { StudioPanel } from './webviews/studioPanel';
import { DiagramIndexer } from './workspace/indexer';
import { DiagnosticsController } from './workspace/diagnostics';
import { SecretsManager } from './utils/secrets';
import { Logger } from './utils/logger';
import { registerCommands } from './commands/registerCommands';
import { extractDiagramSourceForActiveEditor, rememberEditor } from './workspace/activeDiagram';
import { CommentStore } from './comments/commentStore';
import { VsCodeCommentFileStore } from './comments/vscodeFileStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('MermaidForge');
  const logger = new Logger(output);
  context.subscriptions.push(output);

  const secrets = new SecretsManager(context.secrets);
  const commentFileStore = new VsCodeCommentFileStore(vscode.workspace.workspaceFolders?.[0]);
  const commentStore = new CommentStore(commentFileStore);
  if (!commentFileStore.persists) {
    logger.info('No workspace folder is open — diagram comments will only persist for this session.');
  }

  const preview = new PreviewPanel(context.extensionUri, output, commentStore, 'preview');
  const viewer = new PreviewPanel(context.extensionUri, output, commentStore, 'viewer');
  const presentation = new PreviewPanel(context.extensionUri, output, commentStore, 'presentation');
  const studio = new StudioPanel(context.extensionUri, secrets, logger, commentStore);
  const indexer = new DiagramIndexer();
  const diagnostics = new DiagnosticsController();

  context.subscriptions.push(preview, viewer, presentation, studio, indexer, diagnostics);

  registerCommands({ extensionContext: context, preview, viewer, presentation, studio, indexer, diagnostics, secrets, logger, commentStore });

  // Keep every open diagram view in sync with the editors.
  const panels = [preview, viewer, presentation];
  rememberEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      rememberEditor(editor);
      preview.updateNow();
      studio.updateDiagramNow();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const p of panels) if (p.follows(e.document)) p.scheduleUpdate();
      const active = extractDiagramSourceForActiveEditor();
      if (active && e.document === active.editor.document) studio.updateDiagramNow();
    }),
  );

  const navigatorConfig = vscode.workspace.getConfiguration('mermaidForge');
  if (navigatorConfig.get<boolean>('navigator.enabled', true)) {
    await indexer.start();
  }

  diagnostics.lintAllOpenDocuments();

  logger.info('MermaidForge activated.');
}

export function deactivate(): void {
  // All disposables were registered on context.subscriptions; VS Code
  // disposes them automatically on deactivation.
}
