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
let remembered: vscode.TextEditor | undefined;

/** Remember the last Mermaid/Markdown editor, so commands still work while a webview (preview, viewer, Studio) has focus. */
export function rememberEditor(editor: vscode.TextEditor | undefined): void {
  if (editor && (editor.document.languageId === 'mermaid' || editor.document.languageId === 'markdown')) remembered = editor;
}

/** The editor a command should act on: the active one, else (when a webview has focus) the last Mermaid/Markdown editor still open. */
export function currentDiagramEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) return active;
  if (remembered && vscode.workspace.textDocuments.includes(remembered.document)) return remembered;
  return vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'mermaid');
}

/** Diagram source in `doc` (whole file, or the Markdown block at/after `cursorLine`), independent of which editor is active. */
export function extractDiagramFromDocument(doc: vscode.TextDocument, cursorLine = 0): { source: string; rangeInDocument: vscode.Range | undefined } | undefined {
  if (doc.languageId === 'mermaid') return { source: doc.getText(), rangeInDocument: undefined };
  if (doc.languageId === 'markdown') {
    const blocks = extractMermaidBlocksFromMarkdown(doc.getText());
    const block = blocks.find((b) => cursorLine >= b.startLine - 1 && cursorLine <= b.endLine + 1) ?? blocks[0];
    if (!block) return undefined;
    const range = new vscode.Range(new vscode.Position(block.startLine, 0), new vscode.Position(block.endLine, doc.lineAt(Math.min(block.endLine, doc.lineCount - 1)).text.length));
    return { source: block.source, rangeInDocument: range };
  }
  return undefined;
}

/** Comment-store key for a diagram in `doc` (see comments/documentKey.ts). */
export function documentKeyFor(doc: vscode.TextDocument, rangeInDocument: vscode.Range | undefined): string {
  return computeDocumentKey(vscode.workspace.asRelativePath(doc.uri, false), rangeInDocument ? rangeInDocument.start.line : 0);
}

/** Shows `doc` in a text editor (used by "Return to code"). */
export async function showCode(doc: vscode.TextDocument, column?: vscode.ViewColumn, line?: number): Promise<void> {
  const selection = line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined;
  await vscode.window.showTextDocument(doc, { viewColumn: column ?? vscode.ViewColumn.Active, selection, preserveFocus: false });
}

export function extractDiagramSourceForActiveEditor(): ActiveDiagram | undefined {
  const editor = currentDiagramEditor();
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
