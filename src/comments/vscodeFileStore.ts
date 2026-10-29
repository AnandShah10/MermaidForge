import * as vscode from 'vscode';
import { CommentDataStore } from './commentStore';
import { DiagramComment } from './types';

/**
 * Persists comments as a single JSON file, `.mermaidforge/comments.json`,
 * at the root of the first workspace folder. Deliberately a plain
 * committable file rather than VS Code's internal state storage: a team can
 * check it into version control if they want shared, durable diagram
 * comments today, well before any real sync backend exists — and when one
 * does (see CommentBackend in types.ts), this file's shape doesn't need to
 * change for that.
 *
 * When no workspace folder is open, there's nowhere durable to write, so
 * this falls back to an in-memory map for the lifetime of the window —
 * comments still work, they just don't outlive the VS Code session. Callers
 * that care can check `persists` to tell the user.
 */
export class VsCodeCommentFileStore implements CommentDataStore {
  readonly persists: boolean;
  private readonly fileUri: vscode.Uri | null;
  private memoryFallback: Record<string, DiagramComment[]> = {};

  constructor(workspaceFolder: vscode.WorkspaceFolder | undefined) {
    this.fileUri = workspaceFolder ? vscode.Uri.joinPath(workspaceFolder.uri, '.mermaidforge', 'comments.json') : null;
    this.persists = this.fileUri !== null;
  }

  async read(): Promise<Record<string, DiagramComment[]>> {
    if (!this.fileUri) return { ...this.memoryFallback };
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {}; // file doesn't exist yet, or is unreadable — start fresh rather than failing the whole feature
    }
  }

  async write(data: Record<string, DiagramComment[]>): Promise<void> {
    if (!this.fileUri) {
      this.memoryFallback = { ...data };
      return;
    }
    const dirUri = vscode.Uri.joinPath(this.fileUri, '..');
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // already exists — fine
    }
    await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
  }
}
