import * as vscode from 'vscode';
import { runToolbarAction } from './toolbarActions';
import { BaseWebviewPanel, WebviewMessage } from './webviewPanel';
import { buildStudioHtml } from './html/studioTemplate';
import { extractDiagramSourceForActiveEditor } from '../workspace/activeDiagram';
import { parseMermaid } from '../core/parser/mermaidParser';
import { lintDiagram } from '../core/linter/linter';
import { analyzeComplexity } from '../core/complexity/complexity';
import { buildDiagramContext } from '../ai/contextBuilder';
import { AIService } from '../ai/service';
import { createProvider, getDefaultProviderId } from '../ai/providerRegistry';
import { SecretsManager } from '../utils/secrets';
import { pickModel } from '../ai/configureProviderCommand';
import { reviewAndApply } from '../commands/diffWorkflow';
import { AIProviderError } from '../ai/types';
import { Logger } from '../utils/logger';
import { CommentBackend, DiagramComment } from '../comments/types';
import { commentTargetsFor } from '../comments/targets';
import { documentKeyForActiveDiagram } from '../workspace/activeDiagram';
import { resolveAuthorName } from '../comments/addCommentCommand';

export class StudioPanel extends BaseWebviewPanel {
  private readonly studioExtensionUri: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    private readonly secrets: SecretsManager,
    private readonly logger: Logger,
    private readonly commentStore: CommentBackend,
  ) {
    super('mermaidForge.studio', 'MermaidForge Studio', extensionUri);
    this.studioExtensionUri = extensionUri;
  }

  protected getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.studioExtensionUri, 'dist', 'webview', 'previewMain.js'));
    return buildStudioHtml(webview, scriptUri);
  }

  protected onMessage(message: WebviewMessage): void {
    if (this.handleBaseMessage(message)) return;
    switch (message.type) {
      case 'ready':
        this.updateDiagramNow();
        break;
      case 'toolbar':
        void runToolbarAction(String(message.action), typeof message.format === 'string' ? message.format : undefined, 'studio');
        break;
      case 'chatSend':
        void this.handleChat(String(message.text));
        break;
      case 'commentAdd':
        void this.handleCommentAdd(String(message.target ?? ''), String(message.text ?? ''));
        break;
      case 'commentResolve':
        void this.handleCommentUpdate(String(message.id), { resolved: true });
        break;
      case 'commentReopen':
        void this.handleCommentUpdate(String(message.id), { resolved: false });
        break;
      case 'commentDelete':
        void this.handleCommentDelete(String(message.id));
        break;
      case 'renderResult':
        break;
      default:
        break;
    }
  }

  showAssistantMessage(text: string): void {
    this.post({ type: 'chatMessage', text });
  }

  updateDiagramNow(): void {
    if (!this.isOpen) return;
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;

    const config = vscode.workspace.getConfiguration('mermaidForge');
    this.post({
      type: 'update',
      source: active.source,
      theme: config.get<string>('preview.theme') ?? 'auto',
      background: config.get<string>('preview.background') ?? 'auto',
      kind: parseMermaid(active.source).kind,
    });

    const diagram = parseMermaid(active.source);
    const threshold = config.get<number>('complexity.threshold', 7);
    const complexity = analyzeComplexity(diagram, threshold);
    this.post({ type: 'complexityUpdate', html: renderComplexityHtml(complexity) });

    const diagnostics = lintDiagram(diagram);
    this.post({ type: 'problemsUpdate', html: renderProblemsHtml(diagnostics) });

    const targets: Array<{ value: string; label: string }> = [{ value: '', label: 'Diagram (general)' }];
    for (const t of commentTargetsFor(diagram)) targets.push({ value: `${t.type}:${t.id}`, label: t.label });
    this.post({ type: 'commentTargetsUpdate', targets });

    void this.refreshComments();
  }

  async refreshComments(): Promise<void> {
    if (!this.isOpen) return;
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;
    const documentKey = documentKeyForActiveDiagram(active);
    const comments = await this.commentStore.listComments(documentKey);
    this.post({ type: 'commentsUpdate', html: renderCommentsHtml(comments) });
    this.post({
      type: 'comments',
      kind: parseMermaid(active.source).kind,
      items: comments.map((c) => ({ id: c.id, targetType: c.targetType, targetId: c.targetId, author: c.author, text: c.text, resolved: c.resolved })),
    });
  }

  private async handleCommentAdd(target: string, text: string): Promise<void> {
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;
    const trimmedText = text.trim();
    if (!trimmedText) return;

    // The webview sends a single encoded "target" string like
    // "node:PaymentService", "edge:A→B", or "" for a diagram-level comment —
    // decoded here rather than trusting separate type/id fields from the webview.
    let targetType: 'node' | 'edge' | 'diagram' = 'diagram';
    let targetId: string | null = null;
    if (target.startsWith('node:')) {
      targetType = 'node';
      targetId = target.slice('node:'.length);
    } else if (target.startsWith('edge:')) {
      targetType = 'edge';
      targetId = target.slice('edge:'.length);
    }

    const documentKey = documentKeyForActiveDiagram(active);
    await this.commentStore.addComment(documentKey, { targetType, targetId, author: resolveAuthorName(), text: trimmedText });
    await this.refreshComments();
  }

  private async handleCommentUpdate(id: string, patch: { resolved?: boolean; text?: string }): Promise<void> {
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;
    const documentKey = documentKeyForActiveDiagram(active);
    await this.commentStore.updateComment(documentKey, id, patch);
    await this.refreshComments();
  }

  private async handleCommentDelete(id: string): Promise<void> {
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;
    const documentKey = documentKeyForActiveDiagram(active);
    await this.commentStore.deleteComment(documentKey, id);
    await this.refreshComments();
  }

  private async handleChat(text: string): Promise<void> {
    const active = extractDiagramSourceForActiveEditor();
    if (!active) {
      this.showAssistantMessage('Open a .mmd file (or place your cursor in a ```mermaid block) so I have a diagram to work with.');
      return;
    }

    const providerId = getDefaultProviderId();
    const provider = createProvider(providerId, this.secrets);
    const validation = await provider.validateConfiguration();
    if (!validation.valid) {
      this.showAssistantMessage(validation.message ?? `${provider.displayName} is not configured. Run "AI Mermaid: Configure Provider".`);
      return;
    }
    const model = await pickModel(providerId, this.secrets);
    if (!model) return;

    const config = vscode.workspace.getConfiguration('mermaidForge');
    const diagram = parseMermaid(active.source);
    const lintDiagnostics = lintDiagram(diagram);
    const context = buildDiagramContext({
      diagramSource: active.source,
      sendSourceContext: config.get<boolean>('ai.sendSourceContext', true),
      lintDiagnostics,
      maxContextTokens: config.get<number>('ai.maxContextTokens', 4000),
    });
    const options = { model, temperature: config.get<number>('ai.temperature', 0.2) };

    const isQuestion = /\?\s*$/.test(text.trim());

    try {
      const result = isQuestion
        ? await AIService.askAboutDiagram(provider, context, text, options)
        : await AIService.modifyDiagram(provider, context, text, options);

      if (result.response.mermaid.trim() && !isQuestion) {
        this.showAssistantMessage(`${result.response.explanation}\n\nReview the proposed change in the diff view that just opened.`);
        await reviewAndApply(active.editor, active.rangeInDocument, result.response.mermaid, `AI Mermaid: ${text}`);
        if (result.validationIssues.length) {
          this.showAssistantMessage(`Note: the proposed diagram still has issues: ${result.validationIssues.join('; ')}`);
        }
      } else {
        this.showAssistantMessage(result.response.explanation || '(no response text)');
      }
    } catch (err) {
      const message = err instanceof AIProviderError ? err.message : err instanceof Error ? err.message : String(err);
      this.logger.error('Studio chat request failed', err);
      this.showAssistantMessage(`Error: ${message}`);
    }
  }
}

function renderComplexityHtml(report: ReturnType<typeof analyzeComplexity>): string {
  if (!report.supported) {
    return `<div>${escapeHtml(report.reason)}</div>`;
  }
  return [
    row('Nodes', report.nodeCount),
    row('Edges', report.edgeCount),
    row('Density', report.density),
    row('Connected components', report.connectedComponents),
    row('Cycles', report.cycles.length),
    row('Subgraphs', report.subgraphCount),
    row('Complexity score', `${report.complexityScore} / 10`),
    `<div style="margin-top:8px;">${escapeHtml(report.recommendation)}</div>`,
  ].join('');
}

function row(label: string, value: unknown): string {
  return `<div><span class="metric-label">${escapeHtml(label)}:</span> ${escapeHtml(String(value))}</div>`;
}

function renderProblemsHtml(diagnostics: ReturnType<typeof lintDiagram>): string {
  if (diagnostics.length === 0) return '<div>No issues found.</div>';
  return diagnostics.map((d) => `<div class="problem-item ${d.severity}">[${d.severity}] ${escapeHtml(d.message)}</div>`).join('');
}

function renderCommentsHtml(comments: DiagramComment[]): string {
  if (comments.length === 0) return '<div class="comments-empty">No comments yet.</div>';

  const targetLabel = (c: DiagramComment): string => {
    if (c.targetType === 'node') return `Node: ${c.targetId}`;
    if (c.targetType === 'edge') return `Edge: ${c.targetId}`;
    return 'Diagram';
  };

  return comments
    .map((c) => {
      const when = new Date(c.createdAt).toLocaleString();
      const resolvedClass = c.resolved ? ' resolved' : '';
      const toggleLabel = c.resolved ? 'Reopen' : 'Resolve';
      const toggleAction = c.resolved ? 'commentReopen' : 'commentResolve';
      return [
        `<div class="comment-item${resolvedClass}">`,
        `<div class="comment-target">${escapeHtml(targetLabel(c))}${c.resolved ? ' — resolved' : ''}</div>`,
        `<div class="comment-meta">${escapeHtml(c.author)} · ${escapeHtml(when)}</div>`,
        `<div class="comment-text">${escapeHtml(c.text)}</div>`,
        `<div class="comment-actions">`,
        `<button data-comment-action="${toggleAction}" data-comment-id="${c.id}">${toggleLabel}</button>`,
        `<button data-comment-action="commentDelete" data-comment-id="${c.id}">Delete</button>`,
        `</div>`,
        `</div>`,
      ].join('');
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
