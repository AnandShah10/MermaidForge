import * as vscode from 'vscode';

function nonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Toolbar, export menu, comment popover and comment-badge styles, shared by the Preview/Viewer/Presentation and Studio pages. */
export const TOOLBAR_CSS = `
    #mf-toolbar {
      position: absolute; top: 0; left: 0; right: 0; height: 34px; z-index: 30; display: flex; align-items: center; gap: 4px;
      padding: 0 8px; box-sizing: border-box; font-family: var(--vscode-font-family); font-size: 12px;
      background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    }
    #mf-toolbar .mf-spacer { flex: 1; }
    #mf-toolbar button, #mf-comments-popover button {
      background: transparent; color: inherit; border: 1px solid transparent; border-radius: 3px; padding: 3px 8px; cursor: pointer; font: inherit;
    }
    #mf-toolbar button:hover, #mf-comments-popover button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
    #mf-toolbar button.mf-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    #mf-toolbar button.mf-primary:hover { background: var(--vscode-button-hoverBackground); }
    #mf-toolbar .mf-sep { width: 1px; height: 18px; background: var(--vscode-panel-border, rgba(128,128,128,.35)); margin: 0 4px; }
    .mf-menu { position: relative; display: inline-block; }
    .mf-menu-list {
      display: none; position: absolute; top: 28px; left: 0; min-width: 120px; z-index: 40; padding: 4px;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,.4))); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.35);
    }
    .mf-menu.open .mf-menu-list { display: block; }
    .mf-menu-list button { display: block; width: 100%; text-align: left; }
    #mf-comments-popover {
      display: none; position: absolute; top: 40px; right: 8px; width: 300px; max-height: 60%; overflow: auto; z-index: 35; padding: 8px;
      font-family: var(--vscode-font-family); font-size: 12px; box-sizing: border-box;
      background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    #mf-comments-popover.open { display: block; }
    .mf-comment { padding: 6px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); cursor: pointer; }
    .mf-comment:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
    .mf-comment.resolved { opacity: .55; }
    .mf-comment b { font-size: 11px; }
    .mf-comment small { display: block; opacity: .65; }
    .mf-badge circle { fill: #d97706; stroke: #fff; stroke-width: 1.5; }
    .mf-badge.mf-resolved circle { fill: #6b7280; }
    .mf-badge text { fill: #fff; font: 700 11px sans-serif; text-anchor: middle; dominant-baseline: central; pointer-events: none; }
    .mf-badge { cursor: pointer; }
    .mf-comment-focus { filter: drop-shadow(0 0 6px #f59e0b) drop-shadow(0 0 3px #f59e0b); }
`;

export function buildPreviewHtml(webview: vscode.Webview, scriptUri: vscode.Uri, mode: 'preview' | 'viewer' | 'presentation' = 'preview'): string {
  const nonceValue = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonceValue}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MermaidForge Preview</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
    #diagram-container { position: absolute; inset: 34px 0 0 0; overflow: hidden; cursor: grab; }
${TOOLBAR_CSS}
    body[data-mode="presentation"] #presentation-bar { bottom: 20px; }
    #diagram-container:active { cursor: grabbing; }
    #diagram-svg-host { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
    #diagram-svg-host svg { max-width: none !important; }
    #error-panel {
      display: none; position: absolute; top: 34px; left: 0; right: 0; padding: 12px 16px;
      background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground);
      border-bottom: 1px solid var(--vscode-inputValidation-errorBorder); font-family: var(--vscode-editor-font-family);
      font-size: 12px; white-space: pre-wrap; z-index: 10;
    }
    .mf-presentation-dimmed { opacity: 0.15; transition: opacity 0.25s ease; }
    #presentation-bar button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    #presentation-bar button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body data-mode="${mode}">
  <div id="mf-toolbar"></div>
  <div id="error-panel"></div>
  <div id="diagram-container">
    <div id="diagram-svg-host"></div>
  </div>
  <script nonce="${nonceValue}" src="${scriptUri}"></script>
</body>
</html>`;
}
