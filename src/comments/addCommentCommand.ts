import * as vscode from 'vscode';
import * as os from 'os';
import { CommentBackend, CommentTargetType } from './types';
import { commentTargetsFor } from './targets';
import { extractDiagramSourceForActiveEditor, documentKeyForActiveDiagram } from '../workspace/activeDiagram';
import { parseMermaid } from '../core/parser/mermaidParser';

export function resolveAuthorName(): string {
  const configured = vscode.workspace.getConfiguration('mermaidForge').get<string>('comments.authorName');
  if (configured && configured.trim()) return configured.trim();
  try {
    return os.userInfo().username || 'You';
  } catch {
    return 'You';
  }
}

interface TargetOption extends vscode.QuickPickItem {
  targetType: CommentTargetType;
  targetId: string | null;
}

export async function runAddCommentCommand(commentStore: CommentBackend): Promise<void> {
  const active = extractDiagramSourceForActiveEditor();
  if (!active) {
    vscode.window.showInformationMessage('Open a .mmd file, or place your cursor inside a ```mermaid block in Markdown.');
    return;
  }

  const diagram = parseMermaid(active.source);
  const options: TargetOption[] = [{ label: 'Diagram (general)', targetType: 'diagram', targetId: null }];
  for (const t of commentTargetsFor(diagram)) options.push({ label: t.label, targetType: t.type, targetId: t.id });

  const picked = await vscode.window.showQuickPick(options, { placeHolder: 'What is this comment about?' });
  if (!picked) return;

  const text = await vscode.window.showInputBox({ prompt: 'Comment text', ignoreFocusOut: true });
  if (!text || !text.trim()) return;

  const documentKey = documentKeyForActiveDiagram(active);
  await commentStore.addComment(documentKey, {
    targetType: picked.targetType,
    targetId: picked.targetId,
    author: resolveAuthorName(),
    text: text.trim(),
  });
  vscode.window.showInformationMessage('Comment added. View it in MermaidForge Studio\'s Comments tab.');
}
