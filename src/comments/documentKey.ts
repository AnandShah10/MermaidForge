/**
 * Comments are keyed by which diagram they're attached to, not just which
 * file — a Markdown file can hold several `mermaid` blocks. The key is
 * built from a workspace-relative path (not an absolute one) plus the
 * diagram's starting line, so the comments file stays portable across
 * machines and is safe to commit to source control if a team wants shared,
 * git-tracked comments (see vscodeFileStore.ts).
 */
export function computeDocumentKey(relativePath: string, startLine: number): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return `${normalized}#L${startLine}`;
}

/** Formats an edge as a stable, human-readable target id for comments, e.g. "A→B". */
export function edgeTargetId(source: string, target: string): string {
  return `${source}→${target}`;
}
