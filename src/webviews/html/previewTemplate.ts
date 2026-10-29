import * as vscode from 'vscode';

function nonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export function buildPreviewHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonceValue = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
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
    #diagram-container { position: absolute; inset: 0; overflow: hidden; cursor: grab; }
    #diagram-container:active { cursor: grabbing; }
    #diagram-svg-host { position: absolute; top: 50%; left: 50%; transform-origin: center center; transform: translate(-50%, -50%); }
    #diagram-svg-host svg { max-width: none !important; }
    #error-panel {
      display: none; position: absolute; top: 0; left: 0; right: 0; padding: 12px 16px;
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
<body>
  <div id="error-panel"></div>
  <div id="diagram-container">
    <div id="diagram-svg-host"></div>
  </div>
  <script nonce="${nonceValue}" src="${scriptUri}"></script>
</body>
</html>`;
}
