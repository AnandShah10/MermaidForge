import { FlowchartDiagram, ParsedDiagram } from '../core/diagram/types';
import { projectGraph } from '../core/diagram/graphProjection';

export interface PresentationStep {
  index: number;
  label: string;
  /** Node ids that should be visible (fully revealed) at this step — cumulative, i.e. includes every prior step's nodes too. */
  revealedNodeIds: string[];
}

const STEP_DIRECTIVE = /^%%\s*step\s*:\s*([^|]+?)(?:\|\s*(.+))?$/i;

/**
 * Looks for author-authored step directives among the diagram's Mermaid
 * comments — plain `%%` comments already parsed by the flowchart parser, so
 * this needs no new syntax. A directive looks like:
 *
 *   %% step: A, B
 *   %% step: C | Add the cache layer
 *
 * Each directive names the node ids to add at that step (cumulative — you
 * don't repeat earlier ids) and an optional `| label` after a pipe. Returns
 * null (not an empty array) when no directives are present, so callers can
 * distinguish "author didn't define steps" from "author defined zero steps".
 */
export function parseStepDirectives(diagram: { comments: Array<{ text: string }> }, mapId: (id: string) => string = (id) => id): PresentationStep[] | null {
  const matches = diagram.comments
    .map((c) => STEP_DIRECTIVE.exec(c.text))
    .filter((m): m is RegExpExecArray => m !== null);

  if (matches.length === 0) return null;

  const steps: PresentationStep[] = [];
  const cumulative = new Set<string>();
  matches.forEach((m, i) => {
    const ids = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) cumulative.add(mapId(id));
    steps.push({ index: i, label: m[2]?.trim() || `Step ${i + 1}`, revealedNodeIds: [...cumulative] });
  });
  return steps;
}

/** One step per node, in declaration order, each step cumulatively revealing one more node than the last. Used when the diagram has no explicit `%% step:` directives. */
export function buildAutoSteps(diagram: FlowchartDiagram): PresentationStep[] {
  const nodeIdsInOrder = diagram.declarationOrder.filter((d) => d.kind === 'node').map((d) => d.id);
  const cumulative: string[] = [];
  return nodeIdsInOrder.map((id, i) => {
    cumulative.push(id);
    return { index: i, label: `Step ${i + 1}: ${id}`, revealedNodeIds: [...cumulative] };
  });
}

/**
 * Builds the ordered presentation sequence for a flowchart: explicit
 * `%% step:` directives if the author wrote any, otherwise one step per node
 * in declaration order. Never returns an empty array for a diagram with at
 * least one node — an empty diagram yields an empty array, which callers
 * should treat as "nothing to present" rather than starting a presentation.
 */
export function buildPresentationSteps(diagram: FlowchartDiagram): PresentationStep[] {
  const explicit = parseStepDirectives(diagram);
  if (explicit && explicit.length > 0) return explicit;
  return buildAutoSteps(diagram);
}

/** Diagram kinds whose rendered SVG exposes per-node element ids that presentation mode can dim. */
export type PresentationKind = 'flowchart' | 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'requirementDiagram' | 'c4' | 'architecture' | 'block' | 'mindmap' | 'sequenceDiagram' | 'sankey';

const PRESENTABLE: ReadonlySet<string> = new Set<PresentationKind>(['flowchart', 'classDiagram', 'erDiagram', 'stateDiagram', 'requirementDiagram', 'c4', 'architecture', 'block', 'mindmap']);

export interface PresentationPlan {
  ok: true;
  kind: PresentationKind;
  steps: PresentationStep[];
}
export interface PresentationUnavailable {
  ok: false;
  reason: string;
}

/**
 * Presentation steps for any presentable diagram kind. Flowcharts behave as
 * before. Other kinds reveal one node per step in declaration order (or per
 * `%% step: a, b | label` directive, with ids as written in the diagram).
 *
 * sequenceDiagram reveals one message per step (`msg:<index>` ids) and sankey
 * one link per step (`link:<index>` plus `node:<name>` for its endpoints):
 * their SVGs carry no element ids, so the webview matches them by document
 * order and refuses (rather than guessing) when the counts disagree. Sequence
 * notes, loop frames and activation bars are not stepped; they stay visible.
 *
 * Not presentable: the kinds with no node/edge structure (pie, journey, gantt,
 * timeline, gitGraph, quadrantChart, xychart, packet).
 */
export function buildPresentationPlan(diagram: ParsedDiagram): PresentationPlan | PresentationUnavailable {
  if (diagram.kind === 'flowchart') {
    const steps = buildPresentationSteps(diagram);
    return steps.length ? { ok: true, kind: 'flowchart', steps } : { ok: false, reason: 'This diagram has no nodes to present.' };
  }
  if (diagram.kind === 'sequenceDiagram') {
    if (diagram.messages.length === 0) return { ok: false, reason: 'This diagram has no messages to present.' };
    const shown: string[] = [];
    const steps = diagram.messages.map((m, i) => {
      shown.push(`msg:${i}`);
      const label = `${m.from} → ${m.to}${m.text ? ': ' + m.text : ''}`;
      return { index: i, label: `Step ${i + 1}: ${label.length > 60 ? label.slice(0, 57) + '…' : label}`, revealedNodeIds: [...shown] };
    });
    return { ok: true, kind: 'sequenceDiagram', steps };
  }
  if (diagram.kind === 'sankey') {
    if (diagram.links.length === 0) return { ok: false, reason: 'This diagram has no links to present.' };
    const shown: string[] = [];
    const steps = diagram.links.map((l, i) => {
      for (const id of [`node:${l.source}`, `node:${l.target}`]) if (!shown.includes(id)) shown.push(id);
      shown.push(`link:${i}`);
      return { index: i, label: `Step ${i + 1}: ${l.source} → ${l.target} (${l.valueRaw})`, revealedNodeIds: [...shown] };
    });
    return { ok: true, kind: 'sankey', steps };
  }
  if (!PRESENTABLE.has(diagram.kind)) {
    return { ok: false, reason: `Presentation mode isn't available for "${diagram.kind}" diagrams: Mermaid doesn't give their elements ids that can be revealed step by step.` };
  }
  const kind = diagram.kind as PresentationKind;
  const graph = projectGraph(diagram);
  if (!graph) return { ok: false, reason: `Presentation mode isn't available for "${diagram.kind}" diagrams.` };

  // Mermaid names mindmap nodes node_<index> in document order; every other kind uses the model ids.
  const order = [...graph.nodes.keys()].filter((id) => !(kind === 'stateDiagram' && id.startsWith('[')));
  const domId = (id: string): string => (kind === 'mindmap' ? `node_${order.indexOf(id)}` : id);
  const explicit = parseStepDirectives(diagram as unknown as { comments: Array<{ text: string }> }, domId);
  if (explicit && explicit.length > 0) return { ok: true, kind, steps: explicit };
  if (order.length === 0) return { ok: false, reason: 'This diagram has no nodes to present.' };
  const cumulative: string[] = [];
  const steps = order.map((id, i) => {
    cumulative.push(domId(id));
    return { index: i, label: `Step ${i + 1}: ${graph.nodes.get(id)?.label ?? id}`, revealedNodeIds: [...cumulative] };
  });
  return { ok: true, kind, steps };
}
