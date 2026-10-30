import * as vscode from 'vscode';

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

export interface ExportResult {
  ok: boolean;
  message?: string;
  svgText?: string;
  dataUrl?: string;
}

/**
 * Common lifecycle plumbing for MermaidForge's webview panels (preview,
 * Studio). Concrete panels supply the HTML and a message handler; this base
 * class owns panel creation, reveal-vs-recreate behavior, and disposal so
 * that behavior is consistent and we don't leak listeners across panels.
 */
export abstract class BaseWebviewPanel {
  protected panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingExport: ((result: ExportResult) => void) | undefined;

  constructor(
    private readonly viewType: string,
    private title: string,
    private readonly extensionUri: vscode.Uri,
  ) {}

  protected abstract getHtml(webview: vscode.Webview): string;
  protected abstract onMessage(message: WebviewMessage): void;
  protected onDispose(): void {
    // Override in subclasses if extra cleanup is needed.
  }

  reveal(column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    if (this.panel) {
      this.panel.reveal(column);
      return;
    }
    this.create(column);
  }

  private create(column: vscode.ViewColumn): void {
    this.panel = vscode.window.createWebviewPanel(this.viewType, this.title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.disposables.push(this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)));
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.onDispose();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
        this.panel = undefined;
      }),
    );
  }

  setTitle(title: string): void {
    this.title = title;
    if (this.panel) this.panel.title = title;
  }

  /** Column the panel is shown in (undefined when closed). */
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }

  /** Handles the messages every diagram webview shares (export results). Returns true when it consumed the message. */
  protected handleBaseMessage(message: WebviewMessage): boolean {
    if (message.type === 'exportData') {
      this.pendingExport?.(message as unknown as ExportResult);
      this.pendingExport = undefined;
      return true;
    }
    return false;
  }

  /** Asks the webview to export what it has rendered. `theme` is the Mermaid theme the export must use. */
  async exportDiagram(format: 'svg' | 'png' | 'svgFlat', scale: number, background: string, theme?: string): Promise<ExportResult> {
    if (!this.isOpen) return { ok: false, message: 'Open a diagram view first ("Mermaid: Open Preview").' };
    return new Promise((resolve) => {
      this.pendingExport = resolve;
      this.post({ type: 'exportRequest', format, scale, background, theme });
      setTimeout(() => {
        if (this.pendingExport === resolve) {
          this.pendingExport = undefined;
          resolve({ ok: false, message: 'Export timed out waiting for the diagram view to respond.' });
        }
      }, 15_000);
    });
  }

  post(message: WebviewMessage): void {
    this.panel?.webview.postMessage(message);
  }

  get isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
