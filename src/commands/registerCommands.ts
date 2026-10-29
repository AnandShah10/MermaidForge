import * as vscode from 'vscode';
import { PreviewPanel } from '../webviews/previewPanel';
import { StudioPanel } from '../webviews/studioPanel';
import { DiagramIndexer } from '../workspace/indexer';
import { DiagramNavigatorProvider, openDiagramAtLine } from '../workspace/navigator';
import { DiagnosticsController } from '../workspace/diagnostics';
import { extractDiagramSourceForActiveEditor } from '../workspace/activeDiagram';
import { formatMermaid } from '../core/formatter/formatter';
import { parseMermaid } from '../core/parser/mermaidParser';
import { lintDiagram } from '../core/linter/linter';
import { analyzeComplexity } from '../core/complexity/complexity';
import { diffDiagrams, formatDiffReport } from '../core/diff/semanticDiff';
import { renameNode, renamableIds, removeUnusedNodes, extractSubgraph } from '../core/refactoring/refactoring';
import { isFlowchart } from '../core/diagram/types';
import { extractableIds } from '../core/refactoring/structuralRefactor';
import { runExportCommand } from '../rendering/exporter';
import { convertDrawioToMermaid } from '../converters/drawio/drawioToMermaid';
import { getHeadRevisionContent } from '../git/gitIntegration';
import { SecretsManager } from '../utils/secrets';
import { Logger } from '../utils/logger';
import { runConfigureProviderCommand, pickModel } from '../ai/configureProviderCommand';
import { createProvider, getDefaultProviderId } from '../ai/providerRegistry';
import { AIService } from '../ai/service';
import { buildDiagramContext } from '../ai/contextBuilder';
import { reviewAndApply, registerDiffWorkflow } from './diffWorkflow';
import { AIProviderError } from '../ai/types';
import { CommentBackend } from '../comments/types';
import { runAddCommentCommand } from '../comments/addCommentCommand';
import { runGenerateFromCodeCommand } from '../analyzers/generateFromCodeCommand';
import { runGitHistoryTimelineCommand } from '../git/gitHistoryTimelineCommand';

export interface CommandContext {
  extensionContext: vscode.ExtensionContext;
  preview: PreviewPanel;
  studio: StudioPanel;
  indexer: DiagramIndexer;
  diagnostics: DiagnosticsController;
  secrets: SecretsManager;
  logger: Logger;
  commentStore: CommentBackend;
}

export function registerCommands(ctx: CommandContext): void {
  const { extensionContext: context } = ctx;

  registerDiffWorkflow(context);

  // ---- Preview / Studio -------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.openPreview', () => {
      ctx.preview.reveal();
      ctx.preview.updateNow();
    }),
    vscode.commands.registerCommand('mermaidForge.openStudio', () => {
      ctx.studio.reveal();
      ctx.studio.updateDiagramNow();
    }),
    vscode.commands.registerCommand('mermaidForge.presentationMode', () => {
      ctx.preview.reveal();
      ctx.preview.updateNow();
      // Give the preview a moment to render before applying step dimming to it.
      setTimeout(() => ctx.preview.startPresentation(), 350);
    }),
    vscode.commands.registerCommand('mermaidForge.comments.add', async () => {
      await runAddCommentCommand(ctx.commentStore);
      ctx.studio.refreshComments();
    }),
    vscode.commands.registerCommand('mermaidForge.generateFromCode', () => runGenerateFromCodeCommand()),
    vscode.commands.registerCommand('mermaidForge.generateFromGitHistory', () => runGitHistoryTimelineCommand()),
  );

  // ---- Formatter ----------------------------------------------------------
  const formatterSelector: vscode.DocumentSelector = [{ language: 'mermaid' }];
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(formatterSelector, {
      provideDocumentFormattingEdits(document) {
        const config = vscode.workspace.getConfiguration('mermaidForge');
        if (!config.get<boolean>('formatter.enabled', true)) return [];
        const indentSize = config.get<number>('formatter.indentSize', 2);
        const formatted = formatMermaid(document.getText(), { indentSize });
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        return [vscode.TextEdit.replace(fullRange, formatted)];
      },
    }),
    vscode.commands.registerCommand('mermaidForge.formatDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.commands.executeCommand('editor.action.formatDocument');
    }),
    vscode.commands.registerCommand('mermaidForge.formatSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Select some Mermaid text first.');
        return;
      }
      const config = vscode.workspace.getConfiguration('mermaidForge');
      const indentSize = config.get<number>('formatter.indentSize', 2);
      const selectedText = editor.document.getText(editor.selection);
      const formatted = formatMermaid(selectedText, { indentSize });
      await editor.edit((builder) => builder.replace(editor.selection, formatted));
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      const config = vscode.workspace.getConfiguration('mermaidForge');
      if (e.document.languageId !== 'mermaid' || !config.get<boolean>('formatter.formatOnSave', false)) return;
      const indentSize = config.get<number>('formatter.indentSize', 2);
      const formatted = formatMermaid(e.document.getText(), { indentSize });
      const fullRange = new vscode.Range(e.document.positionAt(0), e.document.positionAt(e.document.getText().length));
      e.waitUntil(Promise.resolve([vscode.TextEdit.replace(fullRange, formatted)]));
    }),
  );

  // ---- Linter (manual trigger; diagnostics also update automatically) -----
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.lintDiagram', () => {
      ctx.diagnostics.lintAllOpenDocuments();
      vscode.window.showInformationMessage('Mermaid lint refreshed — see the Problems panel.');
    }),
  );

  // ---- Complexity -----------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.analyzeComplexity', () => {
      const active = requireActiveDiagram();
      if (!active) return;
      const diagram = parseMermaid(active.source);
      const config = vscode.workspace.getConfiguration('mermaidForge');
      const threshold = config.get<number>('complexity.threshold', 7);
      const report = analyzeComplexity(diagram, threshold);
      if (!report.supported) {
        vscode.window.showInformationMessage(report.reason);
        return;
      }
      const lines = [
        `Nodes: ${report.nodeCount}`,
        `Edges: ${report.edgeCount}`,
        `Density: ${report.density}`,
        `Connected components: ${report.connectedComponents}`,
        `Cycles: ${report.cycles.length}`,
        `Subgraphs: ${report.subgraphCount}`,
        `Complexity: ${report.complexityScore}/10`,
        '',
        report.recommendation,
      ];
      ctx.logger.info(`Complexity report:\n${lines.join('\n')}`);
      vscode.window.showInformationMessage(`Complexity ${report.complexityScore}/10 — ${report.recommendation}`, 'Open Studio').then((choice) => {
        if (choice === 'Open Studio') {
          ctx.studio.reveal();
          ctx.studio.updateDiagramNow();
        }
      });
    }),
  );

  // ---- Export -----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.exportDiagram', () => runExportCommand(ctx.preview)),
  );

  // ---- Draw.io import ------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.convertDrawio', async () => {
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Draw.io / XML': ['drawio', 'xml'] },
        openLabel: 'Convert to Mermaid',
      });
      if (!fileUris || fileUris.length === 0) return;

      let sourceXml: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUris[0]);
        sourceXml = Buffer.from(bytes).toString('utf8');
      } catch (err) {
        vscode.window.showErrorMessage(`Could not read the file: ${(err as Error).message}`);
        return;
      }

      const result = convertDrawioToMermaid(sourceXml);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Draw.io conversion failed: ${result.reason}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: result.mermaid });
      await vscode.window.showTextDocument(doc);

      if (result.warnings.length > 0) {
        const summary = result.warnings.map((w) => `[${w.severity}] ${w.message}`).join('\n');
        ctx.logger.info(`Draw.io conversion notes:\n${summary}`);
        vscode.window.showWarningMessage(
          `Converted with ${result.warnings.length} note(s) — review before relying on this diagram. See the MermaidForge output channel for details.`,
        );
      } else {
        vscode.window.showInformationMessage('Converted Draw.io diagram to Mermaid. Review the result — this is a structural best-effort conversion, not a pixel-perfect one.');
      }
    }),
  );

  // ---- Git compare --------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.compareWithGit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'mermaid') {
        vscode.window.showInformationMessage('Open a .mmd file to compare it with its Git HEAD version.');
        return;
      }
      const head = await getHeadRevisionContent(editor.document.uri);
      if (!head.ok) {
        vscode.window.showWarningMessage(head.reason);
        return;
      }
      const before = parseMermaid(head.content);
      const after = parseMermaid(editor.document.getText());
      const diff = diffDiagrams(before, after);
      if (!diff.supported) {
        vscode.window.showInformationMessage(diff.reason);
      } else {
        ctx.logger.info(`Semantic diff vs HEAD:\n${formatDiffReport(diff)}`);
        void vscode.window.showInformationMessage(`Diagram vs HEAD: ${diff.summary}`, 'Show details').then(async (choice) => {
          if (choice === 'Show details') {
            const doc = await vscode.workspace.openTextDocument({ content: `Semantic diff vs HEAD\n\n${formatDiffReport(diff)}\n`, language: 'plaintext' });
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          }
        });
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        editor.document.uri.with({ scheme: 'git', query: JSON.stringify({ path: editor.document.uri.fsPath, ref: 'HEAD' }) }),
        editor.document.uri,
        'Diagram vs HEAD',
      );
    }),
  );

  // ---- Refactoring --------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.renameNode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'mermaid') return;
      const diagram = parseMermaid(editor.document.getText());
      const renamable = renamableIds(diagram);
      if (!renamable) {
        vscode.window.showInformationMessage(`Rename supports flowchart, class, ER, state and sequence diagrams (this one is "${diagram.kind}").`);
        return;
      }
      if (renamable.length === 0) {
        vscode.window.showInformationMessage('This diagram has nothing to rename yet.');
        return;
      }
      const oldId = await vscode.window.showQuickPick(renamable, { placeHolder: 'Which id to rename' });
      if (!oldId) return;
      const newId = await vscode.window.showInputBox({ prompt: `New id for "${oldId}"`, value: oldId });
      if (!newId || newId === oldId) return;
      const result = renameNode(diagram, oldId, newId);
      if (!result.ok) {
        vscode.window.showErrorMessage(result.reason);
        return;
      }
      await replaceWholeDocument(editor, result.newSource);
      vscode.window.showInformationMessage(result.description);
    }),
    vscode.commands.registerCommand('mermaidForge.removeUnusedNodes', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'mermaid') return;
      const diagram = parseMermaid(editor.document.getText());
      const result = removeUnusedNodes(diagram);
      if (!result.ok) {
        vscode.window.showInformationMessage(result.reason);
        return;
      }
      await replaceWholeDocument(editor, result.newSource);
      vscode.window.showInformationMessage(result.description);
    }),
    vscode.commands.registerCommand('mermaidForge.extractSubgraph', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'mermaid') return;
      const diagram = parseMermaid(editor.document.getText());
      const extractable = isFlowchart(diagram) ? [...diagram.nodes.keys()] : extractableIds(diagram);
      if (!extractable) {
        vscode.window.showInformationMessage(`Extract supports flowchart (subgraph), class (namespace), C4 (boundary) and architecture (group) diagrams (this one is "${diagram.kind}").`);
        return;
      }
      if (extractable.length === 0) {
        vscode.window.showInformationMessage('Nothing in this diagram can be extracted (items must be declared and not already grouped).');
        return;
      }
      const picked = await vscode.window.showQuickPick(extractable, {
        placeHolder: 'Select items to group',
        canPickMany: true,
      });
      if (!picked || picked.length === 0) return;
      const subgraphId = await vscode.window.showInputBox({ prompt: 'New subgraph id' });
      if (!subgraphId) return;
      const title = (await vscode.window.showInputBox({ prompt: 'Subgraph title', value: subgraphId })) ?? subgraphId;
      const result = extractSubgraph(diagram, picked, subgraphId, title);
      if (!result.ok) {
        vscode.window.showErrorMessage(result.reason);
        return;
      }
      await replaceWholeDocument(editor, result.newSource);
      vscode.window.showInformationMessage(result.description);
    }),
  );

  // ---- Navigator ----------------------------------------------------------
  const navigatorProvider = new DiagramNavigatorProvider(ctx.indexer);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mermaidForge.diagramNavigator', navigatorProvider),
    vscode.commands.registerCommand('mermaidForge.navigateDiagrams', () => ctx.indexer.fullScan()),
    vscode.commands.registerCommand('mermaidForge.navigator.openDiagram', (uri: vscode.Uri, line: number) => openDiagramAtLine(uri, line)),
  );

  // ---- AI commands ----------------------------------------------------------
  registerAICommands(ctx);
}

async function replaceWholeDocument(editor: vscode.TextEditor, newText: string): Promise<void> {
  const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
  await editor.edit((builder) => builder.replace(fullRange, newText));
}

function requireActiveDiagram() {
  const active = extractDiagramSourceForActiveEditor();
  if (!active) {
    vscode.window.showInformationMessage('Open a .mmd file, or place your cursor inside a ```mermaid block in Markdown.');
    return undefined;
  }
  return active;
}

function registerAICommands(ctx: CommandContext): void {
  const context = ctx.extensionContext;
  const config = () => vscode.workspace.getConfiguration('mermaidForge');

  async function resolveProviderAndModel(): Promise<{ provider: ReturnType<typeof createProvider>; model: string } | undefined> {
    const providerId = getDefaultProviderId();
    const provider = createProvider(providerId, ctx.secrets);
    const validation = await provider.validateConfiguration();
    if (!validation.valid) {
      const choice = await vscode.window.showErrorMessage(validation.message ?? `${provider.displayName} is not configured.`, 'Configure Provider');
      if (choice === 'Configure Provider') await runConfigureProviderCommand(ctx.secrets);
      return undefined;
    }
    const model = await pickModel(providerId, ctx.secrets);
    if (!model) return undefined;
    return { provider, model };
  }

  async function withProgress<T>(title: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, work);
    } catch (err) {
      const message = err instanceof AIProviderError ? err.message : err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`AI Mermaid: ${message}`);
      return undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mermaidForge.ai.configureProvider', () => runConfigureProviderCommand(ctx.secrets)),

    vscode.commands.registerCommand('mermaidForge.ai.generateDiagram', async () => {
      const request = await vscode.window.showInputBox({ prompt: 'Describe the diagram to generate', placeHolder: 'e.g. Sequence diagram for OAuth login' });
      if (!request) return;
      const resolved = await resolveProviderAndModel();
      if (!resolved) return;
      const temperature = config().get<number>('ai.temperature', 0.2);

      const result = await withProgress(`Generating diagram with ${resolved.provider.displayName}…`, () =>
        AIService.generateDiagram(resolved.provider, request, { model: resolved.model, temperature }),
      );
      if (!result) return;
      if (!result.response.mermaid.trim()) {
        vscode.window.showWarningMessage(`AI did not return a diagram. ${result.response.explanation}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: '' });
      const editor = await vscode.window.showTextDocument(doc);
      await reviewAndApply(editor, undefined, result.response.mermaid, `AI Mermaid: Generate — ${request}`);
      if (result.validationIssues.length) {
        vscode.window.showWarningMessage(`Generated diagram has issues: ${result.validationIssues.join('; ')}`);
      }
    }),

    vscode.commands.registerCommand('mermaidForge.ai.explainDiagram', async () => {
      const active = requireActiveDiagram();
      if (!active) return;
      const resolved = await resolveProviderAndModel();
      if (!resolved) return;
      const context2 = buildContextFor(active.source);
      const result = await withProgress(`Explaining diagram with ${resolved.provider.displayName}…`, () =>
        AIService.explainDiagram(resolved.provider, context2, { model: resolved.model, temperature: config().get('ai.temperature', 0.2) }),
      );
      if (!result) return;
      ctx.studio.reveal();
      ctx.studio.showAssistantMessage(result.response.explanation || '(no explanation returned)');
    }),

    vscode.commands.registerCommand('mermaidForge.ai.improveDiagram', async () => runModifyingOperation(ctx, 'improve')),
    vscode.commands.registerCommand('mermaidForge.ai.fixDiagram', async () => runModifyingOperation(ctx, 'fix')),
    vscode.commands.registerCommand('mermaidForge.ai.modifyDiagram', async () => runModifyingOperation(ctx, 'modify')),

    vscode.commands.registerCommand('mermaidForge.ai.askAboutDiagram', async () => {
      const active = requireActiveDiagram();
      if (!active) return;
      const question = await vscode.window.showInputBox({ prompt: 'Ask a question about this diagram' });
      if (!question) return;
      const resolved = await resolveProviderAndModel();
      if (!resolved) return;
      const context2 = buildContextFor(active.source);
      const result = await withProgress(`Asking ${resolved.provider.displayName}…`, () =>
        AIService.askAboutDiagram(resolved.provider, context2, question, { model: resolved.model, temperature: config().get('ai.temperature', 0.2) }),
      );
      if (!result) return;
      ctx.studio.reveal();
      ctx.studio.showAssistantMessage(result.response.explanation || '(no answer returned)');
    }),

    vscode.commands.registerCommand('mermaidForge.ai.reviewArchitecture', async () => {
      const active = requireActiveDiagram();
      if (!active) return;
      const resolved = await resolveProviderAndModel();
      if (!resolved) return;
      const diagram = parseMermaid(active.source);
      const report = analyzeComplexity(diagram, config().get('complexity.threshold', 7));
      const context2 = buildContextFor(active.source, report.supported ? report : undefined);
      const result = await withProgress(`Reviewing architecture with ${resolved.provider.displayName}…`, () =>
        AIService.reviewArchitecture(resolved.provider, context2, { model: resolved.model, temperature: config().get('ai.temperature', 0.2) }),
      );
      if (!result) return;
      ctx.studio.reveal();
      ctx.studio.showAssistantMessage(`**Architecture review (AI-generated suggestions, not verified facts):**\n\n${result.response.explanation}`);
    }),
  );
}

function buildContextFor(source: string, complexity?: import('../core/complexity/complexity').ComplexityReport) {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  const diagram = parseMermaid(source);
  const lintDiagnostics = lintDiagram(diagram);
  return buildDiagramContext({
    diagramSource: source,
    sendSourceContext: config.get<boolean>('ai.sendSourceContext', true),
    lintDiagnostics,
    complexity,
    maxContextTokens: config.get<number>('ai.maxContextTokens', 4000),
  });
}

async function runModifyingOperation(ctx: CommandContext, mode: 'improve' | 'fix' | 'modify'): Promise<void> {
  const active = requireActiveDiagramOrWarn();
  if (!active) return;
  const config = vscode.workspace.getConfiguration('mermaidForge');
  const providerId = getDefaultProviderId();
  const provider = createProvider(providerId, ctx.secrets);
  const validation = await provider.validateConfiguration();
  if (!validation.valid) {
    const choice = await vscode.window.showErrorMessage(validation.message ?? `${provider.displayName} is not configured.`, 'Configure Provider');
    if (choice === 'Configure Provider') await runConfigureProviderCommand(ctx.secrets);
    return;
  }
  const model = await pickModel(providerId, ctx.secrets);
  if (!model) return;

  let instruction = '';
  if (mode === 'modify') {
    const input = await vscode.window.showInputBox({ prompt: 'Describe how to modify the diagram', placeHolder: 'e.g. Add Redis caching between the API and database' });
    if (!input) return;
    instruction = input;
  }

  const diagram = parseMermaid(active.source);
  const lintDiagnostics = lintDiagram(diagram);
  const context2 = buildDiagramContext({
    diagramSource: active.source,
    sendSourceContext: config.get<boolean>('ai.sendSourceContext', true),
    lintDiagnostics,
    maxContextTokens: config.get<number>('ai.maxContextTokens', 4000),
  });

  const options = { model, temperature: config.get<number>('ai.temperature', 0.2) };
  const title = mode === 'improve' ? `Improving diagram with ${provider.displayName}…` : mode === 'fix' ? `Fixing diagram with ${provider.displayName}…` : `Modifying diagram with ${provider.displayName}…`;

  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, () => {
      if (mode === 'improve') return AIService.improveDiagram(provider, context2, options);
      if (mode === 'fix') {
        const errors = lintDiagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
        return AIService.fixDiagram(provider, context2, errors, options);
      }
      return AIService.modifyDiagram(provider, context2, instruction, options);
    });

    if (!result.response.mermaid.trim()) {
      vscode.window.showWarningMessage(`AI did not propose a diagram change. ${result.response.explanation}`);
      return;
    }
    const applied = await reviewAndApply(active.editor, active.rangeInDocument, result.response.mermaid, `AI Mermaid: ${mode}`);
    if (applied && result.validationIssues.length) {
      vscode.window.showWarningMessage(`Applied, but the result still has issues: ${result.validationIssues.join('; ')}`);
    }
  } catch (err) {
    const message = err instanceof AIProviderError ? err.message : err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`AI Mermaid: ${message}`);
  }
}

function requireActiveDiagramOrWarn() {
  const active = extractDiagramSourceForActiveEditor();
  if (!active) {
    vscode.window.showInformationMessage('Open a .mmd file, or place your cursor inside a ```mermaid block in Markdown.');
  }
  return active;
}
