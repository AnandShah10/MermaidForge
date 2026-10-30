import * as vscode from 'vscode';
import { BaseWebviewPanel, WebviewMessage } from './webviewPanel';
import { buildPreviewHtml } from './html/previewTemplate';
import { currentDiagramEditor, extractDiagramFromDocument, documentKeyFor, rememberEditor, showCode } from '../workspace/activeDiagram';
import { parseMermaid } from '../core/parser/mermaidParser';
import { isFlowchart } from '../core/diagram/types';
import { buildPresentationPlan } from '../presentation/presentationEngine';
import { CommentBackend } from '../comments/types';
import { runToolbarAction } from './toolbarActions';

export type { ExportResult } from './webviewPanel';

const DEBOUNCE_MS = 250;

/**
 * What a diagram panel is for:
 *  - `preview`: the side-by-side live preview; follows whichever Mermaid editor is active.
 *  - `viewer`: opened in the editor's own column; shows the diagram instead of the code, bound to one document,
 *    with a "Return to code" button.
 *  - `presentation`: its own panel (titled "Mermaid Presentation"), bound to one document, steps through the diagram.
 */
export type PanelMode = 'preview' | 'viewer' | 'presentation';

const TITLES: Record<PanelMode, string> = { preview: 'Mermaid Preview', viewer: 'Mermaid Viewer', presentation: 'Mermaid Presentation' };

export class PreviewPanel extends BaseWebviewPanel {
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastSourceForNav: string | undefined;
  private lastDocumentForNav: vscode.TextDocument | undefined;
  private readonly panelExtensionUri: vscode.Uri;
  /** Viewer / presentation: the document (and Markdown block line) this panel shows. */
  private bound: { uri: vscode.Uri; line: number; column: vscode.ViewColumn } | undefined;
  private startPresentationOnRender = false;

  constructor(
    extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly commentStore: CommentBackend,
    readonly mode: PanelMode = 'preview',
  ) {
    super(`mermaidForge.${mode}`, TITLES[mode], extensionUri);
    this.panelExtensionUri = extensionUri;
  }

  protected getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.panelExtensionUri, 'dist', 'webview', 'previewMain.js'));
    return buildPreviewHtml(webview, scriptUri, this.mode);
  }

  protected onDispose(): void {
    this.bound = undefined;
    this.startPresentationOnRender = false;
  }

  /** Opens a viewer/presentation panel for `doc` in `column`. */
  openFor(doc: vscode.TextDocument, line: number, column: vscode.ViewColumn): void {
    this.bound = { uri: doc.uri, line, column };
    const name = vscode.workspace.asRelativePath(doc.uri, false);
    this.setTitle(`${TITLES[this.mode]} – ${name}`);
    this.reveal(column);
    this.updateNow();
  }

  private boundDocument(): vscode.TextDocument | undefined {
    if (!this.bound) return undefined;
    const key = this.bound.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  /** Source the panel should show: its bound document, or (preview) whatever Mermaid editor is current. */
  private currentSource(): { source: string; doc: vscode.TextDocument; range: vscode.Range | undefined } | undefined {
    if (this.mode !== 'preview') {
      const doc = this.boundDocument();
      if (!doc) return undefined;
      const found = extractDiagramFromDocument(doc, this.bound!.line);
      return found ? { source: found.source, doc, range: found.rangeInDocument } : undefined;
    }
    const editor = currentDiagramEditor();
    if (!editor) return undefined;
    const found = extractDiagramFromDocument(editor.document, editor.selection.active.line);
    return found ? { source: found.source, doc: editor.document, range: found.rangeInDocument } : undefined;
  }

  protected onMessage(message: WebviewMessage): void {
    if (this.handleBaseMessage(message)) return;
    switch (message.type) {
      case 'ready':
        this.updateNow();
        break;
      case 'renderResult':
        if (!message.ok) {
          this.output.appendLine(`[preview] render error: ${message.message}`);
        } else if (this.startPresentationOnRender) {
          this.startPresentationOnRender = false;
          this.startPresentation();
        }
        break;
      case 'nodeClicked':
        void this.navigateToNode(String(message.nodeId));
        break;
      case 'presentationResult':
        if (!message.ok) {
          vscode.window.showWarningMessage(String(message.message ?? 'Presentation mode could not start.'));
        }
        break;
      case 'presentationExitRequested':
        // The webview already cleared its own dimming state. A dedicated presentation panel closes and returns to the code.
        if (this.mode === 'presentation') void this.returnToCode();
        break;
      case 'toolbar':
        void this.onToolbar(String(message.action), typeof message.format === 'string' ? message.format : undefined);
        break;
      case 'commentFocus':
        break;
      default:
        break;
    }
  }

  private async onToolbar(action: string, format?: string): Promise<void> {
    if (action === 'returnToCode') {
      await this.returnToCode();
      return;
    }
    await runToolbarAction(action, format, this.mode);
  }

  /** Closes a viewer/presentation panel and shows the document's code again in the same column. */
  async returnToCode(): Promise<void> {
    const doc = this.mode === 'preview' ? this.lastDocumentForNav : this.boundDocument();
    const column = this.bound?.column ?? vscode.ViewColumn.One;
    const line = this.bound?.line;
    if (this.mode !== 'preview') this.dispose();
    if (doc) await showCode(doc, this.mode === 'preview' ? vscode.ViewColumn.One : column, line);
    else vscode.window.showInformationMessage('No Mermaid document to return to.');
  }

  scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.updateNow(), DEBOUNCE_MS);
  }

  /** True when a change to `doc` should refresh this panel. */
  follows(doc: vscode.TextDocument): boolean {
    if (!this.isOpen) return false;
    if (this.mode === 'preview') return currentDiagramEditor()?.document === doc;
    return this.bound?.uri.toString() === doc.uri.toString();
  }

  updateNow(): void {
    if (!this.isOpen) return;
    rememberEditor(vscode.window.activeTextEditor);
    const cur = this.currentSource();
    if (!cur) return;
    this.lastSourceForNav = cur.source;
    this.lastDocumentForNav = cur.doc;

    const config = vscode.workspace.getConfiguration('mermaidForge');
    this.post({
      type: 'update',
      source: cur.source,
      theme: config.get<string>('preview.theme') ?? 'auto',
      background: config.get<string>('preview.background') ?? 'auto',
      kind: parseMermaid(cur.source).kind,
    });
    void this.pushComments(cur.doc, cur.range, cur.source);
  }

  /** Sends the diagram's comments so the webview can mark commented nodes and list them. */
  async pushComments(doc?: vscode.TextDocument, range?: vscode.Range | undefined, source?: string): Promise<void> {
    if (!this.isOpen) return;
    const cur = doc && source !== undefined ? { doc, range, source } : this.currentSource() && { doc: this.currentSource()!.doc, range: this.currentSource()!.range, source: this.currentSource()!.source };
    if (!cur) return;
    try {
      const comments = await this.commentStore.listComments(documentKeyFor(cur.doc, cur.range));
      this.post({
        type: 'comments',
        kind: parseMermaid(cur.source).kind,
        items: comments.map((c) => ({ id: c.id, targetType: c.targetType, targetId: c.targetId, author: c.author, text: c.text, resolved: c.resolved })),
      });
    } catch {
      // comments are a convenience overlay; a store error must not break rendering
    }
  }

  /**
   * Presentation: steps come from `%% step:` directives if the author wrote any, otherwise one step per node.
   * Works for flowchart, class, ER, state, requirement, C4, architecture, block and mindmap diagrams (plus sequence
   * and sankey); the reason is shown for the rest.
   */
  startPresentation(): void {
    if (!this.isOpen) return;
    const cur = this.currentSource();
    if (!cur) {
      vscode.window.showInformationMessage('Open a .mmd file, or place your cursor inside a ```mermaid block in Markdown.');
      return;
    }
    const plan = buildPresentationPlan(parseMermaid(cur.source));
    if (!plan.ok) {
      vscode.window.showInformationMessage(plan.reason);
      if (this.mode === 'presentation') void this.returnToCode();
      return;
    }
    this.post({ type: 'presentationStart', kind: plan.kind, steps: plan.steps.map((s) => ({ label: s.label, revealedNodeIds: s.revealedNodeIds })) });
  }

  /** Starts presenting as soon as the first render finished. */
  startPresentationAfterRender(): void {
    this.startPresentationOnRender = true;
  }

  exitPresentation(): void {
    this.post({ type: 'presentationExit' });
  }

  private async navigateToNode(nodeId: string): Promise<void> {
    if (!this.lastSourceForNav || !this.lastDocumentForNav) return;
    const diagram = parseMermaid(this.lastSourceForNav);
    if (!isFlowchart(diagram)) return;
    const node = diagram.nodes.get(nodeId);
    if (!node?.sourceRange) return;
    // Viewer/presentation hide the code, so clicking a node there would be surprising; only the side preview jumps to source.
    if (this.mode !== 'preview') return;
    const editor = await vscode.window.showTextDocument(this.lastDocumentForNav, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    const pos = new vscode.Position(node.sourceRange.startLine, 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(pos, pos);
  }
}
