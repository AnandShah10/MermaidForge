import { computeGanttSchedule } from '../gantt/ganttSchedule';
import {
  ArchitectureDiagram,
  BlockDiagram,
  C4Diagram,
  PacketDiagram,
  QuadrantDiagram,
  RequirementDiagram,
  SankeyDiagram,
  XyChartDiagram,
  isArchitectureDiagram,
  isBlockDiagram,
  isC4Diagram,
  isPacketDiagram,
  isQuadrantDiagram,
  isRequirementDiagram,
  isSankeyDiagram,
  isXyChartDiagram,
  ClassDiagram,
  ErDiagram,
  FlowchartDiagram,
  GanttDiagram,
  GitGraphDiagram,
  JourneyDiagram,
  MindmapDiagram,
  ParsedDiagram,
  PieDiagram,
  SequenceDiagram,
  SourceRange,
  StyleDirectives,
  StateDiagram,
  TimelineDiagram,
  isClassDiagram,
  isErDiagram,
  isFlowchart,
  isGanttDiagram,
  isGitGraphDiagram,
  isJourneyDiagram,
  isMindmapDiagram,
  isPieDiagram,
  isSequenceDiagram,
  isStateDiagram,
  isTimelineDiagram,
} from '../diagram/types';

export type RuleSeverity = 'off' | 'warning' | 'error';

export interface LintRuleConfig {
  duplicateNode: RuleSeverity;
  duplicateEdge: RuleSeverity;
  unreachableNode: RuleSeverity;
  emptySubgraph: RuleSeverity;
  invalidReference: RuleSeverity;
  longLabel: RuleSeverity;
  longLabelThreshold: number;
}

export const DEFAULT_LINT_CONFIG: LintRuleConfig = {
  duplicateNode: 'warning',
  duplicateEdge: 'warning',
  unreachableNode: 'warning',
  emptySubgraph: 'warning',
  invalidReference: 'error',
  longLabel: 'off',
  longLabelThreshold: 60,
};

export interface LintDiagnostic {
  message: string;
  severity: 'error' | 'warning' | 'information';
  range: SourceRange;
  ruleId: string;
  quickFix?: { title: string; kind: 'removeNode' | 'removeEdge' | 'renameSuggestion' };
}

function sev(s: RuleSeverity): 'error' | 'warning' | null {
  if (s === 'off') return null;
  return s;
}

export function lintDiagram(diagram: ParsedDiagram, config: LintRuleConfig = DEFAULT_LINT_CONFIG): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  for (const issue of diagram.parseIssues) {
    diagnostics.push({ message: issue.message, severity: issue.severity, range: issue.range, ruleId: 'syntax' });
  }

  if (isSequenceDiagram(diagram)) {
    lintSequenceDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isClassDiagram(diagram)) {
    lintClassDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isErDiagram(diagram)) {
    lintErDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isStateDiagram(diagram)) {
    lintStateDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isPieDiagram(diagram)) {
    lintPieDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isJourneyDiagram(diagram)) {
    lintJourneyDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isGitGraphDiagram(diagram)) {
    lintGitGraph(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isTimelineDiagram(diagram)) {
    lintTimelineDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isMindmapDiagram(diagram)) {
    lintMindmapDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isGanttDiagram(diagram)) {
    lintGanttDiagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (isSankeyDiagram(diagram)) {
    lintSankeyDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isQuadrantDiagram(diagram)) {
    lintQuadrantDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isXyChartDiagram(diagram)) {
    lintXyChartDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isPacketDiagram(diagram)) {
    lintPacketDiagram(diagram, diagnostics);
    return diagnostics;
  }
  if (isRequirementDiagram(diagram)) {
    lintRequirementDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isBlockDiagram(diagram)) {
    lintBlockDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isArchitectureDiagram(diagram)) {
    lintArchitectureDiagram(diagram, config, diagnostics);
    return diagnostics;
  }
  if (isC4Diagram(diagram)) {
    lintC4Diagram(diagram, config, diagnostics);
    return diagnostics;
  }

  if (!isFlowchart(diagram)) {
    // Light model: only syntax-level diagnostics are available until a
    // dedicated parser exists for this diagram type.
    return diagnostics;
  }

  lintFlowchart(diagram, config, diagnostics);
  return diagnostics;
}

function lintSequenceDiagram(diagram: SequenceDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Isolated participants (declared or referenced, but never sent/received a
  // message) — the sequence-diagram analogue of a flowchart's unreachable node.
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.participants.size > 1) {
    const involved = new Set<string>();
    for (const m of diagram.messages) {
      involved.add(m.from);
      involved.add(m.to);
    }
    for (const [id, p] of diagram.participants) {
      if (!involved.has(id)) {
        out.push({
          message: `Participant "${p.label !== id ? `${p.label} (${id})` : id}" never sends or receives a message.`,
          severity: unreachableSev,
          range: p.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
        });
      }
    }
  }

  // Long labels (message text), reusing the same threshold setting as flowcharts.
  const longSev = sev(config.longLabel);
  if (longSev) {
    for (const m of diagram.messages) {
      if (m.text.length > config.longLabelThreshold) {
        out.push({
          message: `Message text from "${m.from}" to "${m.to}" is ${m.text.length} characters; consider shortening for readability.`,
          severity: longSev,
          range: m.sourceRange ?? zeroRange(),
          ruleId: 'longLabel',
        });
      }
    }
  }
}
function lintFlowchart(diagram: FlowchartDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Invalid references: edges pointing at nodes that were never declared with a shape/label
  // (parser auto-creates them, so this is really "referenced only, never given content" —
  // still surfaced since it often indicates a typo'd node id).
  const invalidSev = sev(config.invalidReference);
  if (invalidSev) {
    for (const edge of diagram.edges) {
      for (const id of [edge.source, edge.target]) {
        if (!diagram.nodes.has(id)) {
          out.push({
            message: `Edge references undeclared node "${id}".`,
            severity: invalidSev,
            range: edge.sourceRange ?? zeroRange(),
            ruleId: 'invalidReference',
          });
        }
      }
    }
  }

  // Duplicate edges (same source, target, direction).
  const dupSev = sev(config.duplicateEdge);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const edge of diagram.edges) {
      const key = `${edge.source}|${edge.target}|${edge.arrow}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        out.push({
          message: `Duplicate edge ${edge.source} ${edge.arrow} ${edge.target}.`,
          severity: dupSev,
          range: edge.sourceRange ?? zeroRange(),
          ruleId: 'duplicateEdge',
          quickFix: { title: 'Remove duplicate edge', kind: 'removeEdge' },
        });
      }
    }
  }

  // Unreachable nodes: no incoming edge and diagram has more than one node
  // (a diagram's true "roots" are expected to have no incoming edge, so we
  // only flag nodes that ALSO have no outgoing edge AND aren't the sole node —
  // i.e. genuinely isolated nodes, not legitimate entry points).
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.nodes.size > 1) {
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const edge of diagram.edges) {
      hasOutgoing.add(edge.source);
      hasIncoming.add(edge.target);
    }
    for (const [id, node] of diagram.nodes) {
      if (!hasIncoming.has(id) && !hasOutgoing.has(id)) {
        out.push({
          message: `Node "${id}" is isolated (no incoming or outgoing edges).`,
          severity: unreachableSev,
          range: node.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
          quickFix: { title: 'Remove isolated node', kind: 'removeNode' },
        });
      }
    }
  }

  // Empty subgraphs.
  const emptySev = sev(config.emptySubgraph);
  if (emptySev) {
    for (const [id, sg] of diagram.subgraphs) {
      if (sg.memberNodeIds.length === 0 && sg.memberSubgraphIds.length === 0) {
        out.push({
          message: `Subgraph "${sg.title || id}" is empty.`,
          severity: emptySev,
          range: sg.sourceRange ?? zeroRange(),
          ruleId: 'emptySubgraph',
        });
      }
    }
  }

  // Long labels.
  const longSev = sev(config.longLabel);
  if (longSev) {
    for (const [id, node] of diagram.nodes) {
      if (node.label.length > config.longLabelThreshold) {
        out.push({
          message: `Label for node "${id}" is ${node.label.length} characters; consider shortening for readability.`,
          severity: longSev,
          range: node.sourceRange ?? zeroRange(),
          ruleId: 'longLabel',
        });
      }
    }
  }

  // Duplicate node declarations sharing the same label text (likely accidental
  // near-duplicates, e.g. "Database" declared as both DB and Database).
  const dupNodeSev = sev(config.duplicateNode);
  if (dupNodeSev) {
    const byLabel = new Map<string, string[]>();
    for (const [id, node] of diagram.nodes) {
      const key = node.label.trim().toLowerCase();
      if (!key) continue;
      byLabel.set(key, [...(byLabel.get(key) ?? []), id]);
    }
    for (const [label, ids] of byLabel) {
      if (ids.length > 1) {
        for (const id of ids) {
          const node = diagram.nodes.get(id)!;
          out.push({
            message: `Nodes ${ids.join(', ')} share the label "${label}" — likely duplicates.`,
            severity: dupNodeSev,
            range: node.sourceRange ?? zeroRange(),
            ruleId: 'duplicateNode',
          });
        }
      }
    }
  }

  // Cycle detection is surfaced via the complexity analyzer (core/complexity)
  // rather than duplicated here; the linter intentionally stays focused on
  // actionable per-line issues.
}

function zeroRange(): SourceRange {
  return { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
}

function lintClassDiagram(diagram: ClassDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Isolated classes: declared but involved in no relationship — the
  // classDiagram analogue of a flowchart's unreachable node. A single-class
  // diagram is exempt, same reasoning as the flowchart/sequence rules.
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.classes.size > 1) {
    const involved = new Set<string>();
    for (const r of diagram.relationships) {
      involved.add(r.from);
      involved.add(r.to);
    }
    for (const [id, cls] of diagram.classes) {
      if (!involved.has(id)) {
        out.push({
          message: `Class "${id}" has no relationships to any other class.`,
          severity: unreachableSev,
          range: cls.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
        });
      }
    }
  }

  // Duplicate members within the same class (same raw declaration repeated).
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const [id, cls] of diagram.classes) {
      const seen = new Map<string, number>();
      for (const member of cls.members) {
        const count = (seen.get(member.raw) ?? 0) + 1;
        seen.set(member.raw, count);
        if (count > 1) {
          out.push({
            message: `Class "${id}" declares the member "${member.raw}" more than once.`,
            severity: dupSev,
            range: cls.sourceRange ?? zeroRange(),
            ruleId: 'duplicateNode',
          });
        }
      }
    }
  }
}

function lintErDiagram(diagram: ErDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Isolated entities: declared but involved in no relationship.
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.entities.size > 1) {
    const involved = new Set<string>();
    for (const r of diagram.relationships) {
      involved.add(r.from);
      involved.add(r.to);
    }
    for (const [id, entity] of diagram.entities) {
      if (!involved.has(id)) {
        out.push({
          message: `Entity "${id}" has no relationships to any other entity.`,
          severity: unreachableSev,
          range: entity.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
        });
      }
    }
  }

  // Duplicate attribute names within the same entity.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const [id, entity] of diagram.entities) {
      const seen = new Map<string, number>();
      for (const attr of entity.attributes) {
        const key = attr.name ?? attr.raw;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) {
          out.push({
            message: `Entity "${id}" declares the attribute "${key}" more than once.`,
            severity: dupSev,
            range: entity.sourceRange ?? zeroRange(),
            ruleId: 'duplicateNode',
          });
        }
      }
    }
  }
}

function lintStateDiagram(diagram: StateDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Isolated states: declared but involved in no transition. The `[*]`
  // start/end markers only exist because a transition mentions them, so
  // they are exempt by construction.
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.states.size > 1) {
    const involved = new Set<string>();
    for (const t of diagram.transitions) {
      involved.add(t.from);
      involved.add(t.to);
    }
    for (const [id, state] of diagram.states) {
      if (state.kind === 'startOrEnd') continue;
      if (!involved.has(id)) {
        out.push({
          message: `State "${id}" has no transitions to or from it.`,
          severity: unreachableSev,
          range: state.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
        });
      }
    }
  }

  // Duplicate transitions (same from/to/label).
  const dupSev = sev(config.duplicateEdge);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const t of diagram.transitions) {
      const key = `${t.from}|${t.to}|${t.label ?? ''}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        out.push({
          message: `Duplicate transition ${t.from} --> ${t.to}${t.label ? ` : ${t.label}` : ''}.`,
          severity: dupSev,
          range: t.sourceRange ?? zeroRange(),
          ruleId: 'duplicateEdge',
        });
      }
    }
  }

  // Empty composite states (no child states declared inside them).
  const emptySev = sev(config.emptySubgraph);
  if (emptySev) {
    const hasChildren = new Set<string>();
    for (const [, state] of diagram.states) {
      if (state.parentId) hasChildren.add(state.parentId);
    }
    for (const [id, state] of diagram.states) {
      if (state.kind === 'composite' && !hasChildren.has(id)) {
        out.push({
          message: `Composite state "${id}" has no states inside it.`,
          severity: emptySev,
          range: state.sourceRange ?? zeroRange(),
          ruleId: 'emptySubgraph',
        });
      }
    }
  }
}

function lintPieDiagram(diagram: PieDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Duplicate slice labels.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const slice of diagram.slices) {
      const count = (seen.get(slice.label) ?? 0) + 1;
      seen.set(slice.label, count);
      if (count > 1) {
        out.push({
          message: `Duplicate pie slice label "${slice.label}".`,
          severity: dupSev,
          range: slice.sourceRange ?? zeroRange(),
          ruleId: 'duplicateNode',
        });
      }
    }
  }

  // Non-positive values: Mermaid renders these as invisible/negative slices,
  // which is virtually always a mistake rather than intentional.
  for (const slice of diagram.slices) {
    if (slice.value <= 0) {
      out.push({
        message: `Pie slice "${slice.label}" has a non-positive value (${slice.value}); it will not render meaningfully.`,
        severity: 'warning',
        range: slice.sourceRange ?? zeroRange(),
        ruleId: 'pieNonPositiveValue',
      });
    }
  }
}

function lintJourneyDiagram(diagram: JourneyDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Duplicate (section, task name) pairs — see journeyParser.ts for why task
  // names aren't treated as ids on their own.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const task of diagram.tasks) {
      const key = `${task.section ?? ''}|${task.name}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        out.push({
          message: `Duplicate task "${task.name}"${task.section ? ` in section "${task.section}"` : ''}.`,
          severity: dupSev,
          range: task.sourceRange ?? zeroRange(),
          ruleId: 'duplicateNode',
        });
      }
    }
  }

  // A task with no actors assigned is usually a typo (missing the trailing
  // ": Actor" part) rather than intentional.
  for (const task of diagram.tasks) {
    if (task.actors.length === 0) {
      out.push({
        message: `Task "${task.name}" has no actors assigned.`,
        severity: 'warning',
        range: task.sourceRange ?? zeroRange(),
        ruleId: 'journeyMissingActors',
      });
    }
  }
}

function lintGitGraph(diagram: GitGraphDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Branches created but never committed to. Unknown-branch references,
  // duplicate branches, duplicate commit ids, and bad cherry-picks are all
  // structural errors and are already surfaced as parse issues (see
  // gitGraphParser.ts) — this rule covers the one thing that's a lint-level
  // concern rather than a hard error: a branch that exists but was never used.
  const unreachableSev = sev(config.unreachableNode);
  if (unreachableSev && diagram.branches.size > 1) {
    const branchesWithCommits = new Set(diagram.commits.map((c) => c.branch));
    for (const [name, branch] of diagram.branches) {
      if (!branchesWithCommits.has(name)) {
        out.push({
          message: `Branch "${name}" has no commits on it.`,
          severity: unreachableSev,
          range: branch.sourceRange ?? zeroRange(),
          ruleId: 'unreachableNode',
        });
      }
    }
  }
}

function lintTimelineDiagram(diagram: TimelineDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // Duplicate period labels (checked per-section, same reasoning as journey
  // task names — the same period appearing twice as separate entries is
  // usually a sign the author meant to add a continuation line, i.e.
  // "      : Another event", instead of repeating the period.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const p of diagram.periods) {
      const key = `${p.section ?? ''}|${p.period}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        out.push({
          message: `Period "${p.period}"${p.section ? ` in section "${p.section}"` : ''} is declared more than once — did you mean to add a continuation line (":") under the existing one instead?`,
          severity: dupSev,
          range: p.sourceRange ?? zeroRange(),
          ruleId: 'duplicateNode',
        });
      }
    }
  }
}

function lintMindmapDiagram(diagram: MindmapDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  // A node whose label is empty after shape-delimiter stripping — e.g. a
  // stray "()" or "[]" — almost always means the author meant to put text
  // inside the delimiters and forgot, rather than intending a blank node.
  for (const node of diagram.nodes) {
    if (node.label.trim().length === 0) {
      out.push({
        message: 'This mindmap node has no label text.',
        severity: 'warning',
        range: node.sourceRange ?? zeroRange(),
        ruleId: 'mindmapEmptyLabel',
      });
    }
  }

  // Duplicate sibling labels under the same parent — two children of one
  // node with identical text are usually a copy-paste slip rather than
  // intentional, since a mindmap has no other way to distinguish them.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    const byParent = new Map<string, Map<string, number>>();
    for (const node of diagram.nodes) {
      const parentKey = node.parentId ?? '__root__';
      const seen = byParent.get(parentKey) ?? new Map<string, number>();
      const count = (seen.get(node.label) ?? 0) + 1;
      seen.set(node.label, count);
      byParent.set(parentKey, seen);
      if (count > 1) {
        out.push({
          message: `Sibling node "${node.label}" is declared more than once under the same parent.`,
          severity: dupSev,
          range: node.sourceRange ?? zeroRange(),
          ruleId: 'duplicateNode',
        });
      }
    }
  }
}

function lintGanttDiagram(diagram: GanttDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  lintGanttSchedule(diagram, out);
  // Duplicate explicit task ids — ambiguous for any other task's "after id"
  // to resolve, so worth flagging even though it isn't fatal to parsing.
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    const seen = new Map<string, number>();
    for (const task of diagram.tasks) {
      if (!task.id) continue;
      const count = (seen.get(task.id) ?? 0) + 1;
      seen.set(task.id, count);
      if (count > 1) {
        out.push({
          message: `Task id "${task.id}" is used by more than one task — "after ${task.id}" would be ambiguous.`,
          severity: dupSev,
          range: task.sourceRange ?? zeroRange(),
          ruleId: 'duplicateNode',
        });
      }
    }
  }

  // A task that starts "after" itself (afterIds containing its own id) is
  // always a mistake — a task can't depend on its own completion.
  for (const task of diagram.tasks) {
    if (task.id && task.afterIds.includes(task.id)) {
      out.push({
        message: `Task "${task.name}" is listed as starting after itself.`,
        severity: 'error',
        range: task.sourceRange ?? zeroRange(),
        ruleId: 'invalidReference',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rules for sankey, quadrantChart, xychart, packet, requirementDiagram, block,
// architecture and C4. Rule ids that reuse an existing flowchart-era id
// (duplicateNode, duplicateEdge, unreachableNode, invalidReference) honour the
// matching severity setting; the diagram-specific ids below have fixed
// severities, like pieNonPositiveValue.
// ---------------------------------------------------------------------------

function findDuplicates<T>(items: T[], key: (item: T) => string | null): T[] {
  const seen = new Set<string>();
  const dups: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    if (seen.has(k)) dups.push(item);
    else seen.add(k);
  }
  return dups;
}

/** Edges that close a directed cycle, found by depth-first search (one per back edge). */
function backEdges<E>(edges: E[], from: (e: E) => string, to: (e: E) => string): E[] {
  const adj = new Map<string, E[]>();
  for (const e of edges) adj.set(from(e), [...(adj.get(from(e)) ?? []), e]);
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const found: E[] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    for (const e of adj.get(n) ?? []) {
      const t = to(e);
      if (state.get(t) === 1) found.push(e);
      else if (!state.has(t)) visit(t);
    }
    state.set(n, 2);
  };
  for (const n of adj.keys()) if (!state.has(n)) visit(n);
  return found;
}

function lintSankeyDiagram(diagram: SankeyDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  if (diagram.links.length === 0) {
    out.push({ message: 'Sankey diagram has no links.', severity: 'warning', range: zeroRange(), ruleId: 'sankeyNoLinks' });
    return;
  }
  for (const l of diagram.links) {
    if (l.value !== null && l.value <= 0) {
      out.push({ message: `Link ${l.source} → ${l.target} has a non-positive value (${l.value}); it will not render as a visible flow.`, severity: 'warning', range: l.sourceRange ?? zeroRange(), ruleId: 'sankeyNonPositiveValue' });
    }
    if (l.source === l.target) {
      out.push({ message: `"${l.source}" links to itself; sankey layouts cannot draw self-loops.`, severity: 'error', range: l.sourceRange ?? zeroRange(), ruleId: 'sankeyCycle' });
    }
  }
  for (const l of backEdges(diagram.links.filter((x) => x.source !== x.target), (x) => x.source, (x) => x.target)) {
    out.push({ message: `Link ${l.source} → ${l.target} closes a cycle; sankey layouts require flows without cycles and Mermaid will fail to render this diagram.`, severity: 'error', range: l.sourceRange ?? zeroRange(), ruleId: 'sankeyCycle' });
  }
  const dupSev = sev(config.duplicateEdge);
  if (dupSev) {
    for (const l of findDuplicates(diagram.links, (x) => `${x.source}\u0000${x.target}`)) {
      out.push({ message: `Duplicate sankey link ${l.source} → ${l.target}; the flows are drawn separately rather than summed.`, severity: dupSev, range: l.sourceRange ?? zeroRange(), ruleId: 'duplicateEdge' });
    }
  }
}

function lintQuadrantDiagram(diagram: QuadrantDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  if (!diagram.xAxis || !diagram.yAxis) {
    out.push({ message: `Quadrant chart has no ${!diagram.xAxis && !diagram.yAxis ? 'x-axis or y-axis' : !diagram.xAxis ? 'x-axis' : 'y-axis'} label.`, severity: 'warning', range: zeroRange(), ruleId: 'quadrantMissingAxis' });
  }
  if (diagram.points.length === 0) {
    out.push({ message: 'Quadrant chart has no data points.', severity: 'warning', range: zeroRange(), ruleId: 'quadrantNoPoints' });
  }
  for (const p of diagram.points) {
    for (const [axis, v] of [['x', p.x], ['y', p.y]] as const) {
      if (v !== null && (v < 0 || v > 1)) {
        out.push({ message: `Point "${p.name}" has ${axis} = ${v}; quadrant coordinates must be between 0 and 1.`, severity: 'error', range: p.sourceRange ?? zeroRange(), ruleId: 'quadrantOutOfRange' });
      }
    }
    if (p.className && !diagram.classDefs.has(p.className)) {
      out.push({ message: `Point "${p.name}" uses class "${p.className}", but no classDef with that name exists; Mermaid ignores it.`, severity: 'warning', range: p.sourceRange ?? zeroRange(), ruleId: 'styleUnknownClass' });
    }
  }
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const p of findDuplicates(diagram.points, (x) => x.name)) {
      out.push({ message: `Duplicate quadrant point name "${p.name}".`, severity: dupSev, range: p.sourceRange ?? zeroRange(), ruleId: 'duplicateNode' });
    }
  }
}

function lintXyChartDiagram(diagram: XyChartDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  if (diagram.series.length === 0) {
    out.push({ message: 'XY chart has no bar or line series.', severity: 'warning', range: zeroRange(), ruleId: 'xychartNoSeries' });
  }
  for (const [name, axis] of [['x-axis', diagram.xAxis], ['y-axis', diagram.yAxis]] as const) {
    if (axis?.range && axis.range.min >= axis.range.max) {
      out.push({ message: `The ${name} range ${axis.range.min} --> ${axis.range.max} must have min below max.`, severity: 'error', range: axis.sourceRange ?? zeroRange(), ruleId: 'xychartInvalidRange' });
    }
  }
  const cats = diagram.xAxis?.categories;
  if (cats) {
    for (const s of diagram.series) {
      if (s.values.length !== cats.length) {
        out.push({ message: `${s.type} series has ${s.values.length} value(s) but the x-axis has ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'}; extra or missing points will be dropped or misaligned.`, severity: 'warning', range: s.sourceRange ?? zeroRange(), ruleId: 'xychartLengthMismatch' });
      }
    }
    const dupSev = sev(config.duplicateNode);
    if (dupSev) {
      const seen = new Set<string>();
      for (const c of cats) {
        if (seen.has(c)) out.push({ message: `Duplicate x-axis category "${c}".`, severity: dupSev, range: diagram.xAxis?.sourceRange ?? zeroRange(), ruleId: 'duplicateNode' });
        seen.add(c);
      }
    }
  }
}

function lintPacketDiagram(diagram: PacketDiagram, out: LintDiagnostic[]): void {
  if (diagram.fields.length === 0) {
    out.push({ message: 'Packet diagram has no fields.', severity: 'warning', range: zeroRange(), ruleId: 'packetNoFields' });
    return;
  }
  const sorted = [...diagram.fields].sort((a, b) => a.start - b.start || a.end - b.end);
  let prev = sorted[0];
  if (prev.start > 0) {
    out.push({ message: `Bits 0-${prev.start - 1} are not covered by any field.`, severity: 'information', range: prev.sourceRange ?? zeroRange(), ruleId: 'packetGap' });
  }
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      out.push({ message: `Field "${cur.label}" (bits ${cur.start}-${cur.end}) overlaps "${prev.label}" (bits ${prev.start}-${prev.end}).`, severity: 'error', range: cur.sourceRange ?? zeroRange(), ruleId: 'packetOverlap' });
    } else if (cur.start > prev.end + 1) {
      out.push({ message: `Bits ${prev.end + 1}-${cur.start - 1} are not covered by any field.`, severity: 'information', range: cur.sourceRange ?? zeroRange(), ruleId: 'packetGap' });
    }
    if (cur.end > prev.end) prev = cur;
  }
}

const REQUIREMENT_RISKS = new Set(['low', 'medium', 'high']);
const REQUIREMENT_VERIFY = new Set(['analysis', 'inspection', 'test', 'demonstration']);
const REQUIREMENT_RELATIONS = new Set(['contains', 'copies', 'derives', 'satisfies', 'verifies', 'refines', 'traces']);

/**
 * Checks classDef/class/style references. Real Mermaid (11.17) treats an unknown class or an unknown
 * target as a silent no-op in requirement diagrams and for `class` in block diagrams, so those are
 * warnings; block `style <unknown id>` throws, so that one is an error (`styleThrowsOnUnknown`).
 */
function lintStyling(styling: StyleDirectives, targets: Set<string>, inlineClasses: Array<{ className: string; range: SourceRange | null }>, styleThrowsOnUnknown: boolean, out: LintDiagnostic[]): void {
  const defined = new Set(styling.classDefs.map((c) => c.name));
  const used = new Set<string>();
  for (const a of styling.classAssignments) {
    used.add(a.className);
    if (!defined.has(a.className)) out.push({ message: `class "${a.className}" is applied but never defined with classDef.`, severity: 'warning', range: a.sourceRange, ruleId: 'styleUnknownClass' });
    for (const t of a.targets) {
      if (!targets.has(t)) out.push({ message: `class statement targets "${t}", which is not declared in this diagram; Mermaid ignores it.`, severity: 'warning', range: a.sourceRange, ruleId: 'styleUnknownTarget' });
    }
  }
  for (const c of inlineClasses) {
    used.add(c.className);
    if (!defined.has(c.className)) out.push({ message: `class "${c.className}" is applied with ::: but never defined with classDef.`, severity: 'warning', range: c.range ?? zeroRange(), ruleId: 'styleUnknownClass' });
  }
  for (const st of styling.styles) {
    if (!targets.has(st.target)) {
      out.push({
        message: styleThrowsOnUnknown ? `style targets "${st.target}", which is not declared; Mermaid fails to render the diagram.` : `style targets "${st.target}", which is not declared; Mermaid ignores it.`,
        severity: styleThrowsOnUnknown ? 'error' : 'warning',
        range: st.sourceRange,
        ruleId: 'styleUnknownTarget',
      });
    }
  }
  for (const c of styling.classDefs) {
    if (!used.has(c.name)) out.push({ message: `classDef "${c.name}" is never applied.`, severity: 'information', range: c.sourceRange, ruleId: 'styleUnusedClass' });
  }
}

function lintRequirementDiagram(diagram: RequirementDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  const named = [...diagram.requirements.map((r) => ({ name: r.name, range: r.sourceRange })), ...diagram.elements.map((e) => ({ name: e.name, range: e.sourceRange }))];
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const n of findDuplicates(named, (x) => x.name)) {
      out.push({ message: `Duplicate requirement/element name "${n.name}".`, severity: dupSev, range: n.range ?? zeroRange(), ruleId: 'duplicateNode' });
    }
  }
  for (const r of diagram.requirements) {
    const missing = (['id', 'text', 'risk', 'verifyMethod'] as const).filter((f) => r[f] === null).map((f) => (f === 'verifyMethod' ? 'verifymethod' : f));
    if (missing.length) {
      out.push({ message: `Requirement "${r.name}" is missing: ${missing.join(', ')}.`, severity: 'warning', range: r.sourceRange ?? zeroRange(), ruleId: 'requirementMissingField' });
    }
    if (r.risk !== null && !REQUIREMENT_RISKS.has(r.risk.toLowerCase())) {
      out.push({ message: `Requirement "${r.name}" has risk "${r.risk}"; expected low, medium or high.`, severity: 'error', range: r.sourceRange ?? zeroRange(), ruleId: 'requirementInvalidValue' });
    }
    if (r.verifyMethod !== null && !REQUIREMENT_VERIFY.has(r.verifyMethod.toLowerCase())) {
      out.push({ message: `Requirement "${r.name}" has verifymethod "${r.verifyMethod}"; expected analysis, inspection, test or demonstration.`, severity: 'error', range: r.sourceRange ?? zeroRange(), ruleId: 'requirementInvalidValue' });
    }
  }
  for (const r of findDuplicates(diagram.requirements, (x) => x.id)) {
    out.push({ message: `Requirement id "${r.id}" is used by more than one requirement.`, severity: 'warning', range: r.sourceRange ?? zeroRange(), ruleId: 'requirementDuplicateId' });
  }
  const names = new Set(named.map((n) => n.name));
  lintStyling(
    diagram.styling,
    names,
    [...diagram.requirements, ...diagram.elements].flatMap((n) => n.classes.map((className) => ({ className, range: n.sourceRange }))),
    false,
    out,
  );
  for (const rel of diagram.relations) {
    for (const end of [rel.source, rel.target]) {
      if (!names.has(end)) out.push({ message: `Relationship refers to "${end}", which is not a declared requirement or element.`, severity: 'error', range: rel.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
    }
    if (!REQUIREMENT_RELATIONS.has(rel.type.toLowerCase())) {
      out.push({ message: `Unknown relationship type "${rel.type}"; expected one of ${[...REQUIREMENT_RELATIONS].join(', ')}.`, severity: 'error', range: rel.sourceRange ?? zeroRange(), ruleId: 'requirementInvalidValue' });
    }
  }
  const unreachSev = sev(config.unreachableNode);
  if (unreachSev && named.length > 1) {
    const used = new Set<string>();
    for (const rel of diagram.relations) {
      used.add(rel.source);
      used.add(rel.target);
    }
    for (const n of named) {
      if (!used.has(n.name)) out.push({ message: `"${n.name}" has no relationships.`, severity: unreachSev, range: n.range ?? zeroRange(), ruleId: 'unreachableNode' });
    }
  }
}

function lintBlockDiagram(diagram: BlockDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  const real = diagram.blocks.filter((b) => !b.isSpace);
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const b of findDuplicates(real, (x) => x.id)) {
      out.push({ message: `Duplicate block id "${b.id}".`, severity: dupSev, range: b.sourceRange ?? zeroRange(), ruleId: 'duplicateNode' });
    }
  }
  const ids = new Set(real.map((b) => b.id));
  lintStyling(diagram.styling, ids, [], true, out);
  for (const e of diagram.edges) {
    for (const end of [e.source, e.target]) {
      if (!ids.has(end)) out.push({ message: `Link refers to block "${end}", which is not declared.`, severity: 'error', range: e.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
    }
  }
  const groupById = new Map(diagram.blocks.filter((b) => b.isGroup).map((g) => [g.id, g]));
  for (const b of diagram.blocks) {
    const cols = b.parent === null ? diagram.columns : groupById.get(b.parent)?.columns ?? null;
    if (cols !== null && b.span > cols) {
      out.push({ message: `Block "${b.id}" spans ${b.span} columns but its container has only ${cols}.`, severity: 'warning', range: b.sourceRange ?? zeroRange(), ruleId: 'blockSpanExceedsColumns' });
    }
  }
  for (const g of groupById.values()) {
    if (!diagram.blocks.some((b) => b.parent === g.id)) {
      out.push({ message: `Group "${g.id}" is empty.`, severity: 'warning', range: g.sourceRange ?? zeroRange(), ruleId: 'emptySubgraph' });
    }
  }
}

function lintArchitectureDiagram(diagram: ArchitectureDiagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const n of findDuplicates(diagram.nodes, (x) => x.id)) {
      out.push({ message: `Duplicate ${n.type} id "${n.id}".`, severity: dupSev, range: n.sourceRange ?? zeroRange(), ruleId: 'duplicateNode' });
    }
  }
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  for (const n of diagram.nodes) {
    if (n.parent === null) continue;
    const parent = byId.get(n.parent);
    if (!parent) out.push({ message: `${n.type} "${n.id}" is placed in "${n.parent}", which is not declared.`, severity: 'error', range: n.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
    else if (parent.type !== 'group') out.push({ message: `${n.type} "${n.id}" is placed in "${n.parent}", which is a ${parent.type}, not a group.`, severity: 'error', range: n.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
  }
  for (const g of diagram.nodes.filter((n) => n.type === 'group' && n.parent !== null)) {
    const seen = new Set<string>([g.id]);
    let cur = byId.get(g.parent as string);
    while (cur) {
      if (seen.has(cur.id)) {
        out.push({ message: `Group "${g.id}" is nested inside itself through "${cur.id}".`, severity: 'error', range: g.sourceRange ?? zeroRange(), ruleId: 'architectureParentCycle' });
        break;
      }
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  for (const e of diagram.edges) {
    for (const [id, grp] of [[e.source, e.sourceGroup], [e.target, e.targetGroup]] as const) {
      const node = byId.get(id);
      if (!node) out.push({ message: `Edge refers to "${id}", which is not declared.`, severity: 'error', range: e.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
      else if (grp && node.type !== 'group') out.push({ message: `Edge uses the {group} modifier on "${id}", which is a ${node.type}.`, severity: 'warning', range: e.sourceRange ?? zeroRange(), ruleId: 'architectureGroupModifier' });
    }
    const sp = byId.get(e.source)?.parent ?? null;
    const tp = byId.get(e.target)?.parent ?? null;
    if ((e.sourceGroup || e.targetGroup) && sp !== null && sp === tp) {
      out.push({ message: `Edge uses {group} but both ends are inside group "${sp}", so it does not cross a group boundary; Mermaid rejects this.`, severity: 'error', range: e.sourceRange ?? zeroRange(), ruleId: 'architectureGroupModifier' });
    }
    if (e.source === e.target) out.push({ message: `"${e.source}" is connected to itself.`, severity: 'warning', range: e.sourceRange ?? zeroRange(), ruleId: 'architectureSelfEdge' });
  }
  const unreachSev = sev(config.unreachableNode);
  const services = diagram.nodes.filter((n) => n.type === 'service');
  if (unreachSev && services.length > 1) {
    const used = new Set<string>();
    for (const e of diagram.edges) {
      used.add(e.source);
      used.add(e.target);
    }
    for (const s of services) if (!used.has(s.id)) out.push({ message: `Service "${s.id}" has no connections.`, severity: unreachSev, range: s.sourceRange ?? zeroRange(), ruleId: 'unreachableNode' });
  }
}

function lintC4Diagram(diagram: C4Diagram, config: LintRuleConfig, out: LintDiagnostic[]): void {
  const all = [...diagram.elements.map((e) => ({ alias: e.alias, range: e.sourceRange })), ...diagram.boundaries.map((b) => ({ alias: b.alias, range: b.sourceRange }))];
  const dupSev = sev(config.duplicateNode);
  if (dupSev) {
    for (const n of findDuplicates(all, (x) => x.alias)) {
      out.push({ message: `Duplicate C4 alias "${n.alias}".`, severity: dupSev, range: n.range ?? zeroRange(), ruleId: 'duplicateNode' });
    }
  }
  const elementAliases = new Set(diagram.elements.map((e) => e.alias));
  const aliases = new Set(all.map((n) => n.alias));
  for (const u of diagram.styleUpdates) {
    if (u.macro === 'UpdateElementStyle') {
      const t = u.targets[0];
      if (t !== undefined && !aliases.has(t)) out.push({ message: `UpdateElementStyle refers to "${t}", which is not a declared element or boundary; Mermaid ignores it.`, severity: 'warning', range: u.sourceRange, ruleId: 'styleUnknownTarget' });
    } else if (u.macro === 'UpdateRelStyle') {
      const [from, to] = u.targets;
      if (from === undefined || to === undefined) continue;
      const unknown = [from, to].filter((x) => !aliases.has(x));
      if (unknown.length) out.push({ message: `UpdateRelStyle refers to ${unknown.map((x) => `"${x}"`).join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not declared; Mermaid ignores it.`, severity: 'warning', range: u.sourceRange, ruleId: 'styleUnknownTarget' });
      else if (!diagram.relations.some((r) => r.from === from && r.to === to)) out.push({ message: `UpdateRelStyle(${from}, ${to}) matches no relationship from "${from}" to "${to}" (direction matters); Mermaid ignores it.`, severity: 'warning', range: u.sourceRange, ruleId: 'styleUnknownTarget' });
    }
  }
  for (const r of diagram.relations) {
    for (const end of [r.from, r.to]) {
      if (!aliases.has(end)) out.push({ message: `${r.macro} refers to "${end}", which is not a declared element or boundary.`, severity: 'error', range: r.sourceRange ?? zeroRange(), ruleId: 'invalidReference' });
    }
    if (r.from === r.to) out.push({ message: `${r.macro} connects "${r.from}" to itself.`, severity: 'warning', range: r.sourceRange ?? zeroRange(), ruleId: 'c4SelfRelation' });
    if (!r.label.trim()) out.push({ message: `${r.macro} from "${r.from}" to "${r.to}" has no label.`, severity: 'warning', range: r.sourceRange ?? zeroRange(), ruleId: 'c4MissingLabel' });
  }
  for (const b of diagram.boundaries) {
    const hasChild = diagram.elements.some((e) => e.boundary === b.alias) || diagram.boundaries.some((x) => x.parent === b.alias);
    if (!hasChild) out.push({ message: `Boundary "${b.alias}" contains nothing.`, severity: 'warning', range: b.sourceRange ?? zeroRange(), ruleId: 'emptySubgraph' });
  }
  const unreachSev = sev(config.unreachableNode);
  if (unreachSev && elementAliases.size > 1) {
    const used = new Set<string>();
    for (const r of diagram.relations) {
      used.add(r.from);
      used.add(r.to);
    }
    for (const e of diagram.elements) if (!used.has(e.alias)) out.push({ message: `Element "${e.alias}" has no relationships.`, severity: unreachSev, range: e.sourceRange ?? zeroRange(), ruleId: 'unreachableNode' });
  }
}


/** Date-aware gantt rules; skipped silently when dateFormat uses tokens ganttSchedule.ts does not interpret. */
function lintGanttSchedule(diagram: GanttDiagram, out: LintDiagnostic[]): void {
  const schedule = computeGanttSchedule(diagram);
  if (!schedule.available) return;
  const RULES = {
    invalidStart: ['ganttInvalidDate', 'error'],
    invalidEnd: ['ganttInvalidDuration', 'warning'],
    rolledDate: ['ganttRolledDate', 'warning'],
    endBeforeStart: ['ganttEndBeforeStart', 'warning'],
    cycle: ['ganttDependencyCycle', 'error'],
  } as const;
  for (const issue of schedule.issues) {
    const task = diagram.tasks[issue.taskIndex];
    const [ruleId, severity] = RULES[issue.kind];
    out.push({ message: issue.message, severity, range: task?.sourceRange ?? zeroRange(), ruleId });
  }
}
