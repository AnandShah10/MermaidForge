import { ParsedDiagram } from '../core/diagram/types';
import { projectGraph } from '../core/diagram/graphProjection';
import { projectItems } from '../core/diff/semanticDiff';
import { edgeTargetId } from './documentKey';

export interface CommentTarget {
  type: 'node' | 'edge';
  id: string;
  label: string;
}

/**
 * What a comment can be attached to, for any diagram kind: the nodes and
 * edges of its graph projection (flowchart nodes, classes, entities, states,
 * participants, tasks, slices, points, commits, ...). Edges are keyed by their
 * endpoints, so repeated messages between the same two participants share one
 * target. Kinds with nothing to point at (none today) return an empty list and
 * only get diagram-level comments.
 */
export function commentTargetsFor(diagram: ParsedDiagram): CommentTarget[] {
  const g = projectGraph(diagram) ?? projectItems(diagram);
  if (!g) return [];
  const out: CommentTarget[] = [];
  for (const [id, n] of g.nodes) {
    if (id.startsWith('[')) continue; // state-diagram start/end markers
    out.push({ type: 'node', id, label: `${diagram.kind === 'flowchart' ? 'Node' : 'Item'}: ${n.label === id ? id : `${id} (${n.label})`}` });
  }
  const seen = new Set<string>();
  for (const e of g.edges) {
    const id = edgeTargetId(e.source, e.target);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ type: 'edge', id, label: `${diagram.kind === 'flowchart' ? 'Edge' : 'Link'}: ${e.source} → ${e.target}` });
  }
  return out;
}
