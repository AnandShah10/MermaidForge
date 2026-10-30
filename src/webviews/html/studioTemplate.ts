import * as vscode from 'vscode';
import { TOOLBAR_CSS } from './previewTemplate';

function nonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export function buildStudioHtml(webview: vscode.Webview, previewScriptUri: vscode.Uri): string {
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
<title>MermaidForge Studio</title>
<style>
${TOOLBAR_CSS}
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  #layout { display: grid; grid-template-columns: 1fr 340px; height: 100vh; }
  #canvas-pane { position: relative; overflow: hidden; border-right: 1px solid var(--vscode-panel-border); }
  #diagram-container { position: absolute; inset: 34px 0 0 0; overflow: hidden; cursor: grab; }
  #diagram-svg-host { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  #diagram-svg-host svg { max-width: none !important; }
  #error-panel { display: none; position: absolute; left: 0; right: 0; padding: 10px 14px; top: 34px; background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); font-size: 12px; white-space: pre-wrap; z-index: 10; }
  #sidebar { display: flex; flex-direction: column; height: 100vh; }
  #tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex: 1; padding: 8px 4px; text-align: center; cursor: pointer; font-size: 12px; opacity: 0.7; user-select: none; }
  .tab.active { opacity: 1; border-bottom: 2px solid var(--vscode-focusBorder); }
  .tab-content { display: none; flex: 1; overflow: auto; padding: 10px; font-size: 12px; }
  .tab-content.active { display: flex; flex-direction: column; }
  #chat-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .chat-msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; }
  .chat-msg.user { background: var(--vscode-input-background); align-self: flex-end; }
  .chat-msg.assistant { background: var(--vscode-editorWidget-background); }
  #chat-input-row { display: flex; gap: 4px; }
  #chat-input { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #complexity-body div, #problems-body div { margin-bottom: 4px; }
  .metric-label { opacity: 0.7; }
  .problem-item { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .problem-item.error { color: var(--vscode-errorForeground); }
  .problem-item.warning { color: var(--vscode-editorWarning-foreground); }
  #comment-add-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  #comment-target, #comment-input { padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: inherit; font-size: 12px; }
  #comments-list { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
  .comment-item { padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .comment-item.resolved { opacity: 0.55; }
  .comment-target { font-weight: 600; font-size: 11px; }
  .comment-meta { opacity: 0.65; font-size: 11px; margin: 2px 0 4px; }
  .comment-text { white-space: pre-wrap; margin-bottom: 6px; }
  .comment-actions { display: flex; gap: 6px; }
  .comment-actions button { padding: 2px 8px; font-size: 11px; }
  .comments-empty { opacity: 0.6; }
</style>
</head>
<body data-mode="studio">
  <div id="layout">
    <div id="canvas-pane">
      <div id="mf-toolbar"></div>
      <div id="error-panel"></div>
      <div id="diagram-container"><div id="diagram-svg-host"></div></div>
    </div>
    <div id="sidebar">
      <div id="tabs">
        <div class="tab active" data-tab="ai">AI</div>
        <div class="tab" data-tab="complexity">Complexity</div>
        <div class="tab" data-tab="problems">Problems</div>
        <div class="tab" data-tab="comments">Comments</div>
      </div>
      <div class="tab-content active" id="tab-ai">
        <div id="chat-log"></div>
        <div id="chat-input-row">
          <input id="chat-input" type="text" placeholder="Ask or instruct (e.g. 'Add Redis caching between API and database')" />
          <button id="chat-send">Send</button>
        </div>
      </div>
      <div class="tab-content" id="tab-complexity">
        <div id="complexity-body">No diagram analyzed yet.</div>
      </div>
      <div class="tab-content" id="tab-problems">
        <div id="problems-body">No issues.</div>
      </div>
      <div class="tab-content" id="tab-comments">
        <div id="comment-add-row">
          <select id="comment-target"><option value="">Diagram (general)</option></select>
          <input id="comment-input" type="text" placeholder="Write a comment…" />
          <button id="comment-add">Add Comment</button>
        </div>
        <div id="comments-list"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonceValue}" src="${previewScriptUri}"></script>
  <script nonce="${nonceValue}">
    (function () {
      const vscodeApi = window.__mermaidForgeVsCodeApi;

      const tabs = document.querySelectorAll('.tab');
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          tabs.forEach((t) => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
          tab.classList.add('active');
          document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        });
      });

      const chatLog = document.getElementById('chat-log');
      const chatInput = document.getElementById('chat-input');
      const chatSend = document.getElementById('chat-send');

      function appendMessage(role, text) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + role;
        div.textContent = text;
        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
      }

      function send() {
        const text = chatInput.value.trim();
        if (!text) return;
        appendMessage('user', text);
        vscodeApi.postMessage({ type: 'chatSend', text });
        chatInput.value = '';
      }
      chatSend.addEventListener('click', send);
      chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

      const commentTarget = document.getElementById('comment-target');
      const commentInput = document.getElementById('comment-input');
      const commentAdd = document.getElementById('comment-add');
      const commentsList = document.getElementById('comments-list');

      function addComment() {
        const text = commentInput.value.trim();
        if (!text) return;
        vscodeApi.postMessage({ type: 'commentAdd', target: commentTarget.value, text });
        commentInput.value = '';
      }
      commentAdd.addEventListener('click', addComment);
      commentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addComment(); });

      commentsList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-comment-action]');
        if (!btn) return;
        vscodeApi.postMessage({ type: btn.dataset.commentAction, id: btn.dataset.commentId });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'chatMessage') {
          appendMessage('assistant', msg.text);
        } else if (msg.type === 'complexityUpdate') {
          document.getElementById('complexity-body').innerHTML = msg.html;
        } else if (msg.type === 'problemsUpdate') {
          document.getElementById('problems-body').innerHTML = msg.html;
        } else if (msg.type === 'commentsUpdate') {
          commentsList.innerHTML = msg.html;
        } else if (msg.type === 'commentTargetsUpdate') {
          const previous = commentTarget.value;
          commentTarget.innerHTML = '';
          for (const t of msg.targets) {
            const opt = document.createElement('option');
            opt.value = t.value;
            opt.textContent = t.label;
            commentTarget.appendChild(opt);
          }
          if ([...commentTarget.options].some((o) => o.value === previous)) {
            commentTarget.value = previous;
          }
        }
      });
    })();
  </script>
</body>
</html>`;
}
