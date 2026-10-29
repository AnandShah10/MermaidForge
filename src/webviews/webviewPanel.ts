import * as vscode from 'vscode';

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
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

  constructor(
    private readonly viewType: string,
    private readonly title: string,
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

  post(message: WebviewMessage): void {
    this.panel?.webview.postMessage(message);
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
