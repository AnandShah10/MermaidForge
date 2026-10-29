import { ParsedDiagram, isFlowchart } from '../diagram/types';
import { renameIdentifierInSource } from './renameIdentifier';
import { extractGroup, removeUnusedStructural } from './structuralRefactor';

export interface RefactorResult {
  ok: true;
  newSource: string;
  description: string;
}
export interface RefactorError {
  ok: false;
  reason: string;
}

/**
 * Renames an id everywhere it is declared or referenced, leaving label text
 * alone (see renameIdentifier.ts for exactly what is and isn't treated as a
 * label). Supports flowchart nodes, class names, ER entities, state ids and
 * sequence participants. Other kinds return an explicit error.
 */
export function renameNode(diagram: ParsedDiagram, oldId: string, newId: string): RefactorResult | RefactorError {
  const ids = renamableIds(diagram);
  if (!ids) {
    return { ok: false, reason: `Rename supports flowchart, class, ER, state and sequence diagrams (this diagram is "${diagram.kind}").` };
  }
  if (!ids.includes(oldId)) {
    return { ok: false, reason: `No ${noun(diagram)} with id "${oldId}" was found.` };
  }
  if (ids.includes(newId)) {
    return { ok: false, reason: `A ${noun(diagram)} with id "${newId}" already exists.` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(newId) || /^-|-$/.test(newId)) {
    return { ok: false, reason: `"${newId}" is not a valid Mermaid id (use letters, digits, "_" or inner "-").` };
  }
  if (diagram.kind === 'stateDiagram' && oldId.startsWith('[')) {
    return { ok: false, reason: '"[*]" is the start/end marker and cannot be renamed.' };
  }
  const kind = diagram.kind === 'flowchart' ? 'flowchart' : (diagram.kind as 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'sequenceDiagram');
  const { text, count } = renameIdentifierInSource(diagram.sourceText, kind, oldId, newId);
  if (count === 0) {
    return { ok: false, reason: `"${oldId}" was found in the model but not in the source text, so nothing was changed.` };
  }
  return { ok: true, newSource: text, description: `Renamed "${oldId}" to "${newId}" (${count} occurrence(s); label text was left unchanged).` };
}

/** Ids that renameNode can rename for this diagram, or null when the kind isn't supported. */
export function renamableIds(diagram: ParsedDiagram): string[] | null {
  switch (diagram.kind) {
    case 'flowchart':
      return [...diagram.nodes.keys()];
    case 'classDiagram':
      return [...diagram.classes.keys()];
    case 'erDiagram':
      return [...diagram.entities.keys()];
    case 'stateDiagram':
      return [...diagram.states.keys()].filter((id) => !id.startsWith('['));
    case 'sequenceDiagram':
      return [...diagram.participants.keys()];
    default:
      return null;
  }
}

function noun(d: ParsedDiagram): string {
  return d.kind === 'flowchart' ? 'node' : d.kind === 'classDiagram' ? 'class' : d.kind === 'erDiagram' ? 'entity' : d.kind === 'stateDiagram' ? 'state' : 'participant';
}

/** Removes nodes with no incoming or outgoing edges (the same set the linter flags as "unreachableNode"). */
export function removeUnusedNodes(diagram: ParsedDiagram): RefactorResult | RefactorError {
  if (!isFlowchart(diagram)) return removeUnusedStructural(diagram);
  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const e of diagram.edges) {
    hasOutgoing.add(e.source);
    hasIncoming.add(e.target);
  }
  const unused = [...diagram.nodes.keys()].filter((id) => !hasIncoming.has(id) && !hasOutgoing.has(id));
  if (unused.length === 0) {
    return { ok: false, reason: 'No isolated nodes were found.' };
  }

  const lines = diagram.sourceText.split(/\r?\n/);
  const linesToDrop = new Set<number>();
  for (const id of unused) {
    const node = diagram.nodes.get(id)!;
    if (node.sourceRange) linesToDrop.add(node.sourceRange.startLine);
  }
  const newSource = lines.filter((_line, idx) => !linesToDrop.has(idx)).join('\n');

  return { ok: true, newSource, description: `Removed ${unused.length} isolated node(s): ${unused.join(', ')}.` };
}

/**
 * Wraps a set of existing top-level node ids into a new subgraph, inserted
 * just before the first of their declaration lines. Nodes must currently be
 * at the top level (not already inside another subgraph) — nested extraction
 * is intentionally out of scope for this first pass to avoid ambiguous
 * indentation rewrites; the command surfaces a clear error in that case.
 */
export function extractSubgraph(diagram: ParsedDiagram, nodeIds: string[], subgraphId: string, title: string): RefactorResult | RefactorError {
  if (!isFlowchart(diagram)) return extractGroup(diagram, nodeIds, subgraphId, title);
  if (nodeIds.length === 0) {
    return { ok: false, reason: 'Select at least one node to extract.' };
  }
  if (diagram.subgraphs.has(subgraphId)) {
    return { ok: false, reason: `A subgraph with id "${subgraphId}" already exists.` };
  }
  for (const id of nodeIds) {
    const node = diagram.nodes.get(id);
    if (!node) return { ok: false, reason: `No node with id "${id}" was found.` };
    if (node.subgraphId !== null) {
      return { ok: false, reason: `Node "${id}" is already inside a subgraph; nested extraction is not supported yet.` };
    }
  }

  const lines = diagram.sourceText.split(/\r?\n/);
  const targetLines = nodeIds
    .map((id) => diagram.nodes.get(id)!.sourceRange?.startLine)
    .filter((l): l is number => l !== undefined)
    .sort((a, b) => a - b);

  if (targetLines.length === 0) {
    return { ok: false, reason: 'Could not locate source lines for the selected nodes.' };
  }

  const insertAt = targetLines[0];
  const lastLine = targetLines[targetLines.length - 1];
  const indent = '  ';

  const out: string[] = [...lines.slice(0, insertAt)];
  out.push(`subgraph ${subgraphId} [${title}]`);
  for (let i = insertAt; i <= lastLine; i++) {
    out.push(indent + lines[i]);
  }
  out.push('end');
  out.push(...lines.slice(lastLine + 1));

  return { ok: true, newSource: out.join('\n'), description: `Extracted ${nodeIds.length} node(s) into subgraph "${subgraphId}".` };
}

