import { ParsedDiagram } from '../diagram/types';
import { GraphProjection, projectGraph } from '../diagram/graphProjection';

/** Disambiguates repeated keys (`Task`, `Task#2`) so same-named items still diff positionally. */
function uniqueKey(seen: Map<string, number>, key: string): string {
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return n === 1 ? key : `${key}#${n}`;
}

/**
 * The kinds with no relationships (pie, journey, timeline, gitGraph,
 * quadrantChart, xychart, packet) are diffed as keyed ITEMS: each slice, task,
 * period, point, series or field is a node whose `detail` holds its values, so
 * "added", "removed" and "changed" mean what they say. gitGraph also has its
 * parent links as edges. This is for diffing only; complexity and the other
 * graph analyses still treat these kinds as having no structure.
 */
export function projectItems(d: ParsedDiagram): GraphProjection | null {
  const nodes = new Map<string, { id: string; label: string; detail: string }>();
  const edges: GraphProjection['edges'] = [];
  const groups = new Map<string, string>();
  const seen = new Map<string, number>();
  const add = (key: string, label: string, detail: string) => {
    const id = uniqueKey(seen, key);
    nodes.set(id, { id, label, detail });
    return id;
  };
  switch (d.kind) {
    case 'pie':
      if (d.title) add('(title)', d.title, '');
      for (const sl of d.slices) add(sl.label, sl.label, String(sl.value));
      break;
    case 'journey':
      if (d.title) add('(title)', d.title, '');
      for (const sec of d.sections) groups.set(sec.name, 'section');
      for (const t of d.tasks) add(t.name, t.name, `score ${t.score}; actors ${t.actors.join(', ')}; section ${t.section ?? '-'}`);
      break;
    case 'timeline':
      if (d.title) add('(title)', d.title, '');
      for (const sec of d.sections) groups.set(sec.name, 'section');
      for (const p of d.periods) add(p.period, p.period, `${p.events.join(' | ')}; section ${p.section ?? '-'}`);
      break;
    case 'gitGraph':
      for (const b of d.branches.values()) groups.set(b.name, b.parentBranch ? `from ${b.parentBranch}` : 'branch');
      for (const c of d.commits) {
        add(c.id, c.displayId ?? c.id, `branch ${c.branch}; ${c.type}${c.tag ? `; tag ${c.tag}` : ''}${c.isMerge ? '; merge' : ''}${c.cherryPickFrom ? `; cherry-pick ${c.cherryPickFrom}` : ''}`);
        for (const parent of c.parentIds) edges.push({ source: parent, target: c.id, label: null });
      }
      break;
    case 'quadrantChart':
      if (d.title) add('(title)', d.title, '');
      if (d.xAxis) add('(x-axis)', 'x-axis', `${d.xAxis.low ?? ''} -> ${d.xAxis.high ?? ''}`);
      if (d.yAxis) add('(y-axis)', 'y-axis', `${d.yAxis.low ?? ''} -> ${d.yAxis.high ?? ''}`);
      d.quadrants.forEach((q, i) => {
        if (q !== null) add(`(quadrant-${i + 1})`, `quadrant-${i + 1}`, q);
      });
      for (const pt of d.points) add(pt.name, pt.name, `x ${pt.x ?? '?'}; y ${pt.y ?? '?'}${pt.className ? `; class ${pt.className}` : ''}${pt.styleRaw ? `; ${pt.styleRaw}` : ''}`);
      break;
    case 'xychart':
      if (d.title) add('(title)', d.title, '');
      if (d.xAxis) add('(x-axis)', 'x-axis', `${d.xAxis.title ?? ''}; ${d.xAxis.categories?.join(', ') ?? (d.xAxis.range ? `${d.xAxis.range.min}..${d.xAxis.range.max}` : '')}`);
      if (d.yAxis) add('(y-axis)', 'y-axis', `${d.yAxis.title ?? ''}; ${d.yAxis.range ? `${d.yAxis.range.min}..${d.yAxis.range.max}` : ''}`);
      d.series.forEach((sr, i) => add(`${sr.type} ${sr.title ?? `#${i + 1}`}`, sr.title ?? `${sr.type} series ${i + 1}`, `${sr.type}: ${sr.values.join(', ')}`));
      break;
    case 'packet':
      if (d.title) add('(title)', d.title, '');
      for (const f of d.fields) add(`${f.start}-${f.end}`, f.label, `bits ${f.start}-${f.end}`);
      break;
    default:
      return null;
  }
  return { nodes, edges, groups, analyzable: false };
}

export interface SemanticDiff {
  supported: true;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: Array<{ id: string; before: { label: string; shape: string }; after: { label: string; shape: string } }>;
  addedEdges: Array<{ source: string; target: string; label: string | null }>;
  removedEdges: Array<{ source: string; target: string; label: string | null }>;
  changedEdgeLabels: Array<{ source: string; target: string; before: string | null; after: string | null }>;
  addedSubgraphs: string[];
  removedSubgraphs: string[];
  summary: string;
}

export interface UnsupportedDiff {
  supported: false;
  reason: string;
}

/**
 * Diffs any two diagrams of the same graph-like kind (see graphProjection.ts).
 * `shape` in changedNodes holds the kind-specific detail (flowchart shape,
 * class members, ER attributes, ...). Edges are matched by source/target; when
 * several edges share a pair (e.g. sequence messages) they are matched in
 * order of appearance, so an edited message shows as a changed label.
 * Diagrams of different kinds, or kinds with no graph structure, are
 * reported as unsupported rather than diffed.
 */
export function diffDiagrams(before: ParsedDiagram, after: ParsedDiagram): SemanticDiff | UnsupportedDiff {
  if (before.kind !== after.kind) {
    return { supported: false, reason: `Cannot compare a "${before.kind}" diagram with a "${after.kind}" diagram.` };
  }
  const b = projectGraph(before) ?? projectItems(before);
  const a = projectGraph(after) ?? projectItems(after);
  if (!b || !a) {
    return { supported: false, reason: `Semantic diff does not support "${before.kind}" diagrams.` };
  }
  return diffProjections(b, a);
}

function keyedEdges(p: GraphProjection): Map<string, { label: string | null }> {
  const seen = new Map<string, number>();
  const out = new Map<string, { label: string | null }>();
  for (const e of p.edges) {
    const base = `${e.source}=>${e.target}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, { label: e.label });
  }
  return out;
}

function splitKey(key: string): [string, string] {
  const [pair] = key.split('#');
  const idx = pair.indexOf('=>');
  return [pair.slice(0, idx), pair.slice(idx + 2)];
}

function diffProjections(before: GraphProjection, after: GraphProjection): SemanticDiff {
  const addedNodes = [...after.nodes.keys()].filter((id) => !before.nodes.has(id));
  const removedNodes = [...before.nodes.keys()].filter((id) => !after.nodes.has(id));
  const changedNodes: SemanticDiff['changedNodes'] = [];
  for (const [id, b] of before.nodes) {
    const a = after.nodes.get(id);
    if (a && (b.label !== a.label || b.detail !== a.detail)) {
      changedNodes.push({ id, before: { label: b.label, shape: b.detail }, after: { label: a.label, shape: a.detail } });
    }
  }

  const beforeEdgeMap = keyedEdges(before);
  const afterEdgeMap = keyedEdges(after);
  const addedEdges: SemanticDiff['addedEdges'] = [];
  const removedEdges: SemanticDiff['removedEdges'] = [];
  const changedEdgeLabels: SemanticDiff['changedEdgeLabels'] = [];
  for (const [key, val] of afterEdgeMap) {
    const [source, target] = splitKey(key);
    const prev = beforeEdgeMap.get(key);
    if (!prev) addedEdges.push({ source, target, label: val.label });
    else if (prev.label !== val.label) changedEdgeLabels.push({ source, target, before: prev.label, after: val.label });
  }
  for (const [key, val] of beforeEdgeMap) {
    if (!afterEdgeMap.has(key)) {
      const [source, target] = splitKey(key);
      removedEdges.push({ source, target, label: val.label });
    }
  }

  const addedSubgraphs = [...after.groups.keys()].filter((id) => !before.groups.has(id));
  const removedSubgraphs = [...before.groups.keys()].filter((id) => !after.groups.has(id));

  const parts: string[] = [];
  if (addedNodes.length) parts.push(`+${addedNodes.length} node(s)`);
  if (removedNodes.length) parts.push(`-${removedNodes.length} node(s)`);
  if (changedNodes.length) parts.push(`~${changedNodes.length} node(s) changed`);
  if (addedEdges.length) parts.push(`+${addedEdges.length} edge(s)`);
  if (removedEdges.length) parts.push(`-${removedEdges.length} edge(s)`);
  if (changedEdgeLabels.length) parts.push(`~${changedEdgeLabels.length} edge label(s)`);
  if (addedSubgraphs.length) parts.push(`+${addedSubgraphs.length} subgraph(s)`);
  if (removedSubgraphs.length) parts.push(`-${removedSubgraphs.length} subgraph(s)`);

  return {
    supported: true,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdgeLabels,
    addedSubgraphs,
    removedSubgraphs,
    summary: parts.length ? parts.join(', ') : 'No semantic differences detected.',
  };
}

/** A readable, line-per-change report of a diff (for an output channel or document). */
export function formatDiffReport(diff: SemanticDiff): string {
  const out: string[] = [diff.summary, ''];
  const edge = (e: { source: string; target: string; label: string | null }) => `${e.source} -> ${e.target}${e.label ? ` [${e.label}]` : ''}`;
  for (const id of diff.addedNodes) out.push(`+ ${id}`);
  for (const id of diff.removedNodes) out.push(`- ${id}`);
  for (const c of diff.changedNodes) {
    const parts: string[] = [];
    if (c.before.label !== c.after.label) parts.push(`label "${c.before.label}" -> "${c.after.label}"`);
    if (c.before.shape !== c.after.shape) parts.push(`${c.before.shape || '(none)'} -> ${c.after.shape || '(none)'}`);
    out.push(`~ ${c.id}: ${parts.join('; ')}`);
  }
  for (const e of diff.addedEdges) out.push(`+ edge ${edge(e)}`);
  for (const e of diff.removedEdges) out.push(`- edge ${edge(e)}`);
  for (const e of diff.changedEdgeLabels) out.push(`~ edge ${e.source} -> ${e.target}: "${e.before ?? ''}" -> "${e.after ?? ''}"`);
  for (const g of diff.addedSubgraphs) out.push(`+ group ${g}`);
  for (const g of diff.removedSubgraphs) out.push(`- group ${g}`);
  return out.join('\n');
}
