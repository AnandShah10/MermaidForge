import { ParsedDiagram } from './types';
import { computeGanttSchedule, fmt } from '../gantt/ganttSchedule';

/**
 * A kind-independent view of "things connected by relations" used by semantic
 * diff and complexity analysis for every diagram type that is naturally a
 * graph. It is a projection for analysis only, never for editing or rendering.
 *
 * Projected (nodes / edges / groups):
 *  - flowchart: nodes / edges / subgraphs
 *  - sequenceDiagram: participants / messages / blocks (diff only; see `analyzable`)
 *  - classDiagram: classes (detail = stereotype + members) / relationships
 *  - erDiagram: entities (detail = attributes) / relationships
 *  - stateDiagram: states / transitions / composite states
 *  - mindmap: nodes / parent->child links
 *  - sankey: nodes / links (label = value)
 *  - requirementDiagram: requirements + elements / relations
 *  - block: blocks / links / groups
 *  - architecture: services + junctions / edges / groups
 *  - C4: elements / relations / boundaries
 *  - gantt: tasks (detail = computed start/end, or the raw tokens when the
 *    dateFormat is not interpretable) / `after` dependencies / sections
 *
 * NOT projected (no graph structure): pie, journey, timeline, gitGraph,
 * quadrantChart, xychart, packet. `projectGraph` returns null for them.
 */
export interface ProjectedNode {
  id: string;
  label: string;
  /** Anything else that makes two same-id nodes "different" (shape, members, attributes…). */
  detail: string;
}
export interface ProjectedEdge {
  source: string;
  target: string;
  label: string | null;
}
export interface GraphProjection {
  nodes: Map<string, ProjectedNode>;
  edges: ProjectedEdge[];
  groups: Map<string, string>;
  /**
   * False when cycle/density metrics would be misleading (sequence diagrams:
   * request/reply pairs are "cycles" by construction). Diff still works.
   */
  analyzable: boolean;
}

export function projectGraph(d: ParsedDiagram): GraphProjection | null {
  const nodes = new Map<string, ProjectedNode>();
  const edges: ProjectedEdge[] = [];
  const groups = new Map<string, string>();
  const node = (id: string, label: string, detail = '') => {
    if (!nodes.has(id)) nodes.set(id, { id, label, detail });
  };
  const edge = (source: string, target: string, label: string | null) => edges.push({ source, target, label });
  let analyzable = true;

  switch (d.kind) {
    case 'flowchart':
      for (const n of d.nodes.values()) node(n.id, n.label, n.shape);
      for (const e of d.edges) edge(e.source, e.target, e.label);
      for (const s of d.subgraphs.values()) groups.set(s.id, s.title);
      break;
    case 'sequenceDiagram':
      analyzable = false;
      for (const p of d.participants.values()) node(p.id, p.label, p.kind);
      for (const m of d.messages) edge(m.from, m.to, m.text ? `${m.text} (${m.arrow})` : m.arrow);
      for (const b of d.blocks.values()) groups.set(b.id, b.kind);
      break;
    case 'classDiagram':
      for (const c of d.classes.values()) node(c.id, c.id, `${c.stereotype ?? ''}|${c.members.map((m) => m.raw.trim()).join(';')}`);
      for (const r of d.relationships) edge(r.from, r.to, `${r.type}${r.label ? ': ' + r.label : ''}`);
      break;
    case 'erDiagram':
      for (const e of d.entities.values()) node(e.id, e.id, e.attributes.map((a) => a.raw.trim()).join(';'));
      for (const r of d.relationships) edge(r.from, r.to, `${r.leftCardinality}${r.identifying ? '--' : '..'}${r.rightCardinality}${r.label ? ' ' + r.label : ''}`);
      break;
    case 'stateDiagram':
      for (const s of d.states.values()) {
        node(s.id, s.label, s.kind);
        if (s.kind === 'composite') groups.set(s.id, s.label);
      }
      for (const t of d.transitions) edge(t.from, t.to, t.label);
      break;
    case 'mindmap':
      for (const n of d.nodes) {
        node(n.id, n.label, `${n.shape}|${n.icon ?? ''}|${n.className ?? ''}`);
        if (n.parentId !== null) edge(n.parentId, n.id, null);
      }
      break;
    case 'sankey':
      for (const n of d.nodes) node(n, n);
      for (const l of d.links) edge(l.source, l.target, l.valueRaw);
      break;
    case 'requirementDiagram':
      for (const r of d.requirements) node(r.name, r.name, `${r.kind}|${r.id ?? ''}|${r.text ?? ''}|${r.risk ?? ''}|${r.verifyMethod ?? ''}`);
      for (const e of d.elements) node(e.name, e.name, `element|${e.type ?? ''}|${e.docref ?? ''}`);
      for (const r of d.relations) edge(r.source, r.target, r.type);
      break;
    case 'block':
      for (const b of d.blocks) {
        if (b.isSpace) continue;
        if (b.isGroup) groups.set(b.id, b.label ?? b.id);
        node(b.id, b.label ?? b.id, `${b.shapeRaw ?? ''}|${b.span}`);
      }
      for (const e of d.edges) edge(e.source, e.target, e.label);
      break;
    case 'architecture':
      for (const n of d.nodes) {
        if (n.type === 'group') groups.set(n.id, n.label ?? n.id);
        else node(n.id, n.label ?? n.id, `${n.type}|${n.icon ?? ''}|${n.parent ?? ''}`);
      }
      for (const e of d.edges) edge(e.source, e.target, null);
      break;
    case 'c4':
      for (const e of d.elements) node(e.alias, e.label, `${e.macro}|${e.techn ?? ''}|${e.description ?? ''}|${e.boundary ?? ''}`);
      for (const b of d.boundaries) groups.set(b.alias, b.label);
      for (const r of d.relations) edge(r.from, r.to, r.label);
      break;
    case 'gantt': {
      const sched = computeGanttSchedule(d);
      const key = (i: number) => d.tasks[i].id ?? `${d.tasks[i].section ?? ''}/${d.tasks[i].name}`;
      const idToKey = new Map<string, string>();
      d.tasks.forEach((t, i) => {
        if (t.id) idToKey.set(t.id, key(i));
      });
      d.tasks.forEach((t, i) => {
        const st = sched.available ? sched.tasks[i] : null;
        const when = st ? `${st.start === null ? '?' : fmt(st.start)}..${st.end === null ? '?' : fmt(st.end)}` : `${t.startRaw ?? ''}..${t.durationRaw ?? ''}`;
        node(key(i), t.name, `${when}|${t.statuses.join(',')}`);
        for (const a of t.afterIds) if (idToKey.has(a)) edge(idToKey.get(a)!, key(i), 'after');
      });
      for (const sec of d.sections) groups.set(sec.name, sec.name);
      break;
    }
    default:
      return null;
  }
  return { nodes, edges, groups, analyzable };
}
