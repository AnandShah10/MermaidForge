import * as vscode from 'vscode';
import { extractMermaidBlocksFromMarkdown } from '../core/parser/mermaidParser';
import { detectDiagramType } from '../core/parser/detectDiagramType';
import { DiagramKind } from '../core/diagram/types';

export interface IndexedDiagram {
  uri: vscode.Uri;
  kind: DiagramKind;
  /** Line where the diagram content starts (0-based), for .mmd files always 0. */
  startLine: number;
  title: string; // display label, e.g. the diagram kind, or heading above it in Markdown
}

export interface IndexedFile {
  uri: vscode.Uri;
  diagrams: IndexedDiagram[];
}

/**
 * Maintains an index of Mermaid diagrams across the workspace, updated
 * incrementally via file watchers rather than a full rescan per keystroke.
 * Only `.mmd`/`.mermaid` files and `.md`/`.markdown` files are watched —
 * scanning is deliberately narrow rather than walking the entire workspace.
 */
export class DiagramIndexer implements vscode.Disposable {
  private readonly index = new Map<string, IndexedFile>(); // key: uri.toString()
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  async start(): Promise<void> {
    await this.fullScan();

    const pattern = '**/*.{mmd,mermaid,md,markdown}';
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => this.reindexFile(uri));
    watcher.onDidCreate((uri) => this.reindexFile(uri));
    watcher.onDidDelete((uri) => {
      this.index.delete(uri.toString());
      this.emitter.fire();
    });
    this.watchers.push(watcher);
    this.disposables.push(watcher);
  }

  async fullScan(): Promise<void> {
    this.index.clear();
    const files = await vscode.workspace.findFiles('**/*.{mmd,mermaid,md,markdown}', '**/node_modules/**', 2000);
    for (const uri of files) {
      await this.reindexFile(uri, /*silent*/ true);
    }
    this.emitter.fire();
  }

  private async reindexFile(uri: vscode.Uri, silent = false): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const diagrams: IndexedDiagram[] = [];

      if (uri.path.endsWith('.mmd') || uri.path.endsWith('.mermaid')) {
        diagrams.push({ uri, kind: detectDiagramType(text), startLine: 0, title: detectDiagramType(text) });
      } else {
        const blocks = extractMermaidBlocksFromMarkdown(text);
        const lines = text.split(/\r?\n/);
        for (const block of blocks) {
          const kind = detectDiagramType(block.source);
          const heading = findPrecedingHeading(lines, block.startLine);
          diagrams.push({ uri, kind, startLine: block.startLine, title: heading ?? kind });
        }
      }

      if (diagrams.length === 0) {
        this.index.delete(uri.toString());
      } else {
        this.index.set(uri.toString(), { uri, diagrams });
      }
      if (!silent) this.emitter.fire();
    } catch {
      // File may have been deleted between the watcher event and the read; ignore.
    }
  }

  getAllFiles(): IndexedFile[] {
    return [...this.index.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}

function findPrecedingHeading(lines: string[], beforeLine: number): string | undefined {
  for (let i = beforeLine - 1; i >= 0 && i >= beforeLine - 20; i--) {
    const match = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return undefined;
}
