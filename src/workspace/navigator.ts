import * as vscode from 'vscode';
import { DiagramIndexer, IndexedDiagram, IndexedFile } from './indexer';

type TreeItemData = { kind: 'file'; file: IndexedFile } | { kind: 'diagram'; file: IndexedFile; diagram: IndexedDiagram };

export class DiagramNavigatorProvider implements vscode.TreeDataProvider<TreeItemData> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly indexer: DiagramIndexer) {
    indexer.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(workspaceRelativePath(element.file.uri), vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = element.file.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = 'mermaidForge.diagramFile';
      return item;
    }
    const item = new vscode.TreeItem(element.diagram.title, vscode.TreeItemCollapsibleState.None);
    item.description = element.diagram.kind;
    item.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
    item.command = {
      command: 'mermaidForge.navigator.openDiagram',
      title: 'Open Diagram',
      arguments: [element.file.uri, element.diagram.startLine],
    };
    item.contextValue = 'mermaidForge.diagramEntry';
    return item;
  }

  getChildren(element?: TreeItemData): TreeItemData[] {
    if (!element) {
      return this.indexer.getAllFiles().map((file) => ({ kind: 'file', file }));
    }
    if (element.kind === 'file') {
      return element.file.diagrams.map((diagram) => ({ kind: 'diagram', file: element.file, diagram }));
    }
    return [];
  }
}

function workspaceRelativePath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, true);
  return rel;
}

export async function openDiagramAtLine(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}
