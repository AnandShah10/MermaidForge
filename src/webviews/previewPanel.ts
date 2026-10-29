import * as vscode from 'vscode';
import { BaseWebviewPanel, WebviewMessage } from './webviewPanel';
import { buildPreviewHtml } from './html/previewTemplate';
import { extractDiagramSourceForActiveEditor } from '../workspace/activeDiagram';
import { parseMermaid } from '../core/parser/mermaidParser';
import { isFlowchart } from '../core/diagram/types';
import { buildPresentationPlan } from '../presentation/presentationEngine';

const DEBOUNCE_MS = 250;

export interface ExportResult {
  ok: boolean;
  message?: string;
  svgText?: string;
  dataUrl?: string;
}

export class PreviewPanel extends BaseWebviewPanel {
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastSourceForNav: string | undefined;
  private lastEditorForNav: vscode.TextEditor | undefined;
  private pendingExport: ((result: ExportResult) => void) | undefined;
  private readonly previewExtensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri, private readonly output: vscode.OutputChannel) {
    super('mermaidForge.preview', 'Mermaid Preview', extensionUri);
    this.previewExtensionUri = extensionUri;
  }

  protected getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.previewExtensionUri, 'dist', 'webview', 'previewMain.js'));
    return buildPreviewHtml(webview, scriptUri);
  }

  protected onMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.updateNow();
        break;
      case 'renderResult':
        if (!message.ok) {
          this.output.appendLine(`[preview] render error: ${message.message}`);
        }
        break;
      case 'nodeClicked':
        this.navigateToNode(String(message.nodeId));
        break;
      case 'exportData':
        this.pendingExport?.(message as unknown as ExportResult);
        this.pendingExport = undefined;
        break;
      case 'presentationResult':
        if (!message.ok) {
          vscode.window.showWarningMessage(String(message.message ?? 'Presentation mode could not start.'));
        }
        break;
      case 'presentationExitRequested':
        // The webview already cleared its own dimming state; nothing else to reconcile host-side.
        break;
      default:
        break;
    }
  }

  scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.updateNow(), DEBOUNCE_MS);
  }

  updateNow(): void {
    if (!this.isOpen) return;
    const active = extractDiagramSourceForActiveEditor();
    if (!active) return;
    this.lastSourceForNav = active.source;
    this.lastEditorForNav = active.editor;

    const config = vscode.workspace.getConfiguration('mermaidForge');
    this.post({
      type: 'update',
      source: active.source,
      theme: config.get<string>('preview.theme') ?? 'default',
      background: config.get<string>('preview.background') ?? 'white',
    });
  }

  /**
   * Starts presentation mode over the currently active flowchart. Steps come
   * from `%% step:` directives in the diagram if the author wrote any,
   * otherwise one step per node in declaration order — see
   * presentation/presentationEngine.ts. Works for flowchart, class, ER, state,
   * requirement, C4, architecture, block and mindmap diagrams; the reason
   * is shown for the rest.
   */
  startPresentation(): void {
    if (!this.isOpen) {
      vscode.window.showInformationMessage('Open the Mermaid preview first ("Mermaid: Open Preview").');
      return;
    }
    const active = extractDiagramSourceForActiveEditor();
    if (!active) {
      vscode.window.showInformationMessage('Open a .mmd file, or place your cursor inside a ```mermaid block in Markdown.');
      return;
    }
    const plan = buildPresentationPlan(parseMermaid(active.source));
    if (!plan.ok) {
      vscode.window.showInformationMessage(plan.reason);
      return;
    }
    this.post({ type: 'presentationStart', kind: plan.kind, steps: plan.steps.map((s) => ({ label: s.label, revealedNodeIds: s.revealedNodeIds })) });
  }

  exitPresentation(): void {
    this.post({ type: 'presentationExit' });
  }

  async exportDiagram(format: 'svg' | 'png' | 'svgFlat', scale: number, background: string): Promise<ExportResult> {
    if (!this.isOpen) {
      return { ok: false, message: 'Open the Mermaid preview first ("Mermaid: Open Preview").' };
    }
    return new Promise((resolve) => {
      this.pendingExport = resolve;
      this.post({ type: 'exportRequest', format, scale, background });
      setTimeout(() => {
        if (this.pendingExport) {
          this.pendingExport = undefined;
          resolve({ ok: false, message: 'Export timed out waiting for the preview to respond.' });
        }
      }, 10_000);
    });
  }

  private navigateToNode(nodeId: string): void {
    if (!this.lastSourceForNav || !this.lastEditorForNav) return;
    const diagram = parseMermaid(this.lastSourceForNav);
    if (!isFlowchart(diagram)) return;
    const node = diagram.nodes.get(nodeId);
    if (!node?.sourceRange) return;
    const pos = new vscode.Position(node.sourceRange.startLine, 0);
    this.lastEditorForNav.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    this.lastEditorForNav.selection = new vscode.Selection(pos, pos);
  }
}
