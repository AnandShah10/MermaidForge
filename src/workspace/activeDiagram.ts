import * as vscode from 'vscode';
import { extractMermaidBlocksFromMarkdown } from '../core/parser/mermaidParser';
import { computeDocumentKey } from '../comments/documentKey';

export interface ActiveDiagram {
  editor: vscode.TextEditor;
  source: string;
  /** Range of the diagram's source within the document (for Markdown-embedded diagrams; undefined for standalone .mmd files where it's the whole document). */
  rangeInDocument: vscode.Range | undefined;
}

/**
 * Finds the Mermaid diagram relevant to the active editor: the whole
 * document for `.mmd`/`.mermaid` files, or the fenced ```mermaid block
 * containing the cursor for Markdown files. Returns undefined if there is no
 * active editor or no diagram to act on — callers should show a clear
 * message rather than silently no-op.
 */
export function extractDiagramSourceForActiveEditor(): ActiveDiagram | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const doc = editor.document;

  if (doc.languageId === 'mermaid') {
    return { editor, source: doc.getText(), rangeInDocument: undefined };
  }

  if (doc.languageId === 'markdown') {
    const blocks = extractMermaidBlocksFromMarkdown(doc.getText());
    const cursorLine = editor.selection.active.line;
    const block = blocks.find((b) => cursorLine >= b.startLine - 1 && cursorLine <= b.endLine + 1) ?? blocks[0];
    if (!block) return undefined;
    const range = new vscode.Range(new vscode.Position(block.startLine, 0), new vscode.Position(block.endLine, doc.lineAt(Math.min(block.endLine, doc.lineCount - 1)).text.length));
    return { editor, source: block.source, rangeInDocument: range };
  }

  return undefined;
}

/** Computes the comment-store document key for the diagram currently relevant to the active editor. See comments/documentKey.ts for the format. */
export function documentKeyForActiveDiagram(active: ActiveDiagram): string {
  const relativePath = vscode.workspace.asRelativePath(active.editor.document.uri, false);
  const startLine = active.rangeInDocument ? active.rangeInDocument.start.line : 0;
  return computeDocumentKey(relativePath, startLine);
}
