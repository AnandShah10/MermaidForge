/**
 * Data model for diagram comments. Deliberately generic about who's
 * commenting: this first implementation is local-first (see
 * commentStore.ts / vscodeFileStore.ts) — there is no real-time
 * multi-user sync — but the shape here doesn't assume that. A future
 * GitHub/GitLab/Azure DevOps-backed CommentBackend can store richer
 * `author` info (an actual account) without changing this type or any code
 * that consumes it.
 */

export type CommentTargetType = 'node' | 'edge' | 'diagram';

export interface DiagramComment {
  id: string;
  targetType: CommentTargetType;
  /** Node id, or "source→target" for an edge; null for a diagram-level comment. */
  targetId: string | null;
  author: string;
  text: string;
  createdAt: string; // ISO 8601
  resolved: boolean;
}

export interface NewCommentInput {
  targetType: CommentTargetType;
  targetId: string | null;
  author: string;
  text: string;
}

export interface CommentUpdate {
  text?: string;
  resolved?: boolean;
}

/**
 * Extension point every comment persistence/sync layer implements.
 * `documentKey` identifies which diagram a comment set belongs to — see
 * documentKey.ts for how that's computed. Nothing outside comments/ should
 * depend on a specific backend; commands and the Studio panel talk only to
 * this interface (see CommandContext.commentStore).
 */
export interface CommentBackend {
  listComments(documentKey: string): Promise<DiagramComment[]>;
  addComment(documentKey: string, input: NewCommentInput): Promise<DiagramComment>;
  updateComment(documentKey: string, commentId: string, patch: CommentUpdate): Promise<DiagramComment | null>;
  deleteComment(documentKey: string, commentId: string): Promise<boolean>;
}
