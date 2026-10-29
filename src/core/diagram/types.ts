/**
 * The intermediate graph model. Every subsystem (linter, formatter, complexity
 * analyzer, semantic diff, refactoring, AI context builder) operates on this
 * model rather than re-parsing raw Mermaid text, so behavior stays consistent
 * across features and we only have one parser to maintain per diagram type.
 *
 * NOTE ON SCOPE: full structural fidelity (every Mermaid directive, every edge
 * style keyword) is not modeled for every diagram type in this first pass.
 * Diagram types with a dedicated parser (currently: flowchart/graph,
 * sequenceDiagram, classDiagram, erDiagram, stateDiagram, pie, journey, gitGraph, timeline, mindmap, gantt,
 * sankey, quadrantChart, xychart, packet, requirementDiagram, block, architecture and C4) get a full structural model. Other
 * supported diagram types (classDiagram, stateDiagram, erDiagram, etc.) are
 * detected and stored with a lightweight line-based model (see
 * LightDiagramModel) that still enables preview, formatting-safe pass-through,
 * and basic linting (syntax presence, non-empty body) without pretending to
 * understand diagram-specific semantics we have not implemented yet. This
 * boundary is intentional — see ARCHITECTURE.md "Diagram type support matrix".
 */

export type DiagramKind =
  | 'flowchart'
  | 'sequenceDiagram'
  | 'classDiagram'
  | 'stateDiagram'
  | 'erDiagram'
  | 'journey'
  | 'gantt'
  | 'pie'
  | 'mindmap'
  | 'timeline'
  | 'gitGraph'
  | 'quadrantChart'
  | 'requirementDiagram'
  | 'c4'
  | 'architecture'
  | 'block'
  | 'packet'
  | 'sankey'
  | 'xychart'
  | 'unknown';

export type FlowchartDirection = 'TD' | 'TB' | 'BT' | 'LR' | 'RL';

export interface SourceRange {
  startLine: number; // 0-based, inclusive
  startCol: number;
  endLine: number; // 0-based, inclusive
  endCol: number;
}

export type NodeShape =
  | 'rectangle' // [text]
  | 'rounded' // (text)
  | 'stadium' // ([text])
  | 'subroutine' // [[text]]
  | 'cylinder' // [(text)]
  | 'circle' // ((text))
  | 'asymmetric' // >text]
  | 'rhombus' // {text}
  | 'hexagon' // {{text}}
  | 'parallelogram' // [/text/]
  | 'parallelogramAlt' // [\text\]
  | 'trapezoid' // [/text\]
  | 'trapezoidAlt' // [\text/]
  | 'doubleCircle' // (((text)))
  | 'default';

/**
 * Node/subgraph identifiers are restricted here to `[A-Za-z0-9_]+` (letters,
 * digits, underscore) — deliberately excluding hyphens. Mermaid itself is
 * lenient about hyphens in bare ids, but a hyphen is indistinguishable from
 * the start of an edge arrow (`-->`, `---`, `-.-`) when scanning token by
 * token, which makes hyphenated ids ambiguous to parse reliably. Diagrams
 * that need a hyphen in a label can still use one — only the id itself is
 * restricted.
 */
export interface GraphNode {
  id: string;
  label: string;
  shape: NodeShape;
  classes: string[];
  styles: Record<string, string>;
  subgraphId: string | null;
  sourceRange: SourceRange | null;
  /** Raw declaration text as first seen, used to preserve unusual formatting on conservative edits. */
  rawDeclaration: string | null;
}

export type EdgeArrow =
  | '-->' // arrow
  | '---' // open line
  | '-.->' // dotted arrow
  | '-.-' // dotted line
  | '==>' // thick arrow
  | '===' // thick line
  | '--x' // cross end
  | '--o'; // circle end

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  arrow: EdgeArrow;
  sourceRange: SourceRange | null;
  rawDeclaration: string | null;
}

export interface Subgraph {
  id: string;
  title: string;
  memberNodeIds: string[];
  memberSubgraphIds: string[];
  parentId: string | null;
  sourceRange: SourceRange | null;
}

export interface ParseIssue {
  message: string;
  severity: 'error' | 'warning';
  range: SourceRange;
}

export interface FlowchartDiagram {
  kind: 'flowchart';
  direction: FlowchartDirection;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  subgraphs: Map<string, Subgraph>;
  /** Node/edge/subgraph declaration order as they appeared, for stable formatting output. */
  declarationOrder: Array<{ kind: 'node' | 'edge' | 'subgraphStart' | 'subgraphEnd'; id: string }>;
  classDefs: Map<string, Record<string, string>>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

/** Fallback model for diagram types without a dedicated structural parser yet. */
export interface LightDiagramModel {
  kind: Exclude<DiagramKind, 'flowchart' | 'sequenceDiagram' | 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'pie' | 'journey' | 'gitGraph' | 'timeline' | 'mindmap' | 'gantt' | 'quadrantChart' | 'requirementDiagram' | 'c4' | 'architecture' | 'block' | 'packet' | 'sankey' | 'xychart' | 'unknown'> | 'unknown';
  bodyLines: string[];
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Sequence diagram model -------------------------------------------

export type SequenceParticipantKind = 'participant' | 'actor';

export interface SequenceParticipant {
  id: string;
  label: string; // alias set via "participant Id as Label", defaults to id
  kind: SequenceParticipantKind;
  sourceRange: SourceRange | null;
}

export type SequenceArrow = '->' | '-->' | '->>' | '-->>' | '-x' | '--x' | '-)' | '--)';

export interface SequenceMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  arrow: SequenceArrow;
  sourceRange: SourceRange | null;
}

export type SequenceNotePosition = 'left of' | 'right of' | 'over';

export interface SequenceNote {
  position: SequenceNotePosition;
  participants: string[];
  text: string;
  sourceRange: SourceRange | null;
}

export type SequenceBlockKind = 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'rect' | 'break';

export interface SequenceBlock {
  id: string;
  kind: SequenceBlockKind;
  label: string;
  sourceRange: SourceRange | null;
}

export interface SequenceDiagram {
  kind: 'sequenceDiagram';
  participants: Map<string, SequenceParticipant>;
  messages: SequenceMessage[];
  notes: SequenceNote[];
  blocks: Map<string, SequenceBlock>;
  /** Declaration order for stable round-tripping / future formatting. */
  declarationOrder: Array<{ kind: 'participant' | 'message' | 'note' | 'blockStart' | 'blockEnd'; id: string }>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Class diagram model -------------------------------------------

export interface ClassMember {
  raw: string; // the member line as written, e.g. "+getName() string"
  visibility: '+' | '-' | '#' | '~' | null;
  isMethod: boolean;
}

export interface ClassEntry {
  id: string;
  stereotype: string | null; // e.g. "interface", "abstract", "enumeration"
  members: ClassMember[];
  sourceRange: SourceRange | null;
}

export type ClassRelationType = 'inheritance' | 'realization' | 'composition' | 'aggregation' | 'association' | 'dependency' | 'link' | 'dashedLink';

export interface ClassRelationship {
  id: string;
  from: string;
  to: string;
  type: ClassRelationType;
  fromCardinality: string | null;
  toCardinality: string | null;
  label: string | null;
  sourceRange: SourceRange | null;
}

export interface ClassDiagramNote {
  target: string | null; // class id, or null for a diagram-level note
  text: string;
  sourceRange: SourceRange | null;
}

export interface ClassDiagram {
  kind: 'classDiagram';
  classes: Map<string, ClassEntry>;
  relationships: ClassRelationship[];
  notes: ClassDiagramNote[];
  declarationOrder: Array<{ kind: 'class' | 'relationship' | 'note'; id: string }>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- ER diagram model -------------------------------------------

export type ErAttributeKey = 'PK' | 'FK' | 'UK' | null;

export interface ErAttribute {
  raw: string;
  type: string | null;
  name: string | null;
  key: ErAttributeKey;
  comment: string | null;
}

export interface ErEntity {
  id: string;
  attributes: ErAttribute[];
  sourceRange: SourceRange | null;
}

export interface ErRelationship {
  id: string;
  from: string;
  to: string;
  /** Raw crow's-foot cardinality tokens as written, e.g. "||" or "o{" — not decoded into named cardinalities, since the token vocabulary is small and the raw form is unambiguous to a reader who knows ER notation. */
  leftCardinality: string;
  rightCardinality: string;
  /** true for a solid "--" (identifying) relationship, false for a dashed ".." (non-identifying) one. */
  identifying: boolean;
  label: string | null;
  sourceRange: SourceRange | null;
}

export interface ErDiagram {
  kind: 'erDiagram';
  entities: Map<string, ErEntity>;
  relationships: ErRelationship[];
  declarationOrder: Array<{ kind: 'entity' | 'relationship'; id: string }>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- State diagram model -------------------------------------------

/**
 * 'startOrEnd' entries are Mermaid's `[*]` pseudostate. Mermaid's syntax uses
 * the same token for both, but a `[*]` that is a transition *source* is that
 * scope's start and one that is a *target* is its end, and each composite
 * state (and concurrent region) has its own. The parser therefore gives them
 * scoped ids: `[*start]` / `[*end]` at the top level, `[*start]@Comp` /
 * `[*end]@Comp` (`@Comp#2` for a second region) inside composites. Their
 * label is always `[*]`, and every such id starts with `[`.
 */
export type StateKind = 'simple' | 'composite' | 'choice' | 'fork' | 'join' | 'startOrEnd';

export interface StateEntry {
  id: string;
  label: string;
  kind: StateKind;
  parentId: string | null;
  sourceRange: SourceRange | null;
}

export interface StateTransition {
  id: string;
  from: string;
  to: string;
  label: string | null;
  sourceRange: SourceRange | null;
}

export interface StateDiagramNote {
  target: string | null;
  text: string;
  sourceRange: SourceRange | null;
}

export interface StateDiagram {
  kind: 'stateDiagram';
  states: Map<string, StateEntry>;
  transitions: StateTransition[];
  notes: StateDiagramNote[];
  declarationOrder: Array<{ kind: 'state' | 'transition' | 'note' | 'compositeStart' | 'compositeEnd'; id: string }>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Pie chart model -------------------------------------------

export interface PieSlice {
  label: string;
  value: number;
  sourceRange: SourceRange | null;
}

export interface PieDiagram {
  kind: 'pie';
  title: string | null;
  showData: boolean;
  slices: PieSlice[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- User journey model -------------------------------------------

export interface JourneyTask {
  id: string; // synthetic, since task names aren't required to be unique — see journeyParser.ts
  name: string;
  score: number;
  actors: string[];
  section: string | null;
  sourceRange: SourceRange | null;
}

export interface JourneySection {
  name: string;
  sourceRange: SourceRange | null;
}

export interface JourneyDiagram {
  kind: 'journey';
  title: string | null;
  sections: JourneySection[];
  tasks: JourneyTask[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Git graph model -------------------------------------------

export type GitCommitType = 'NORMAL' | 'REVERSE' | 'HIGHLIGHT';

export interface GitCommit {
  /** Internal unique id: the explicit `id: "..."` value if given, otherwise a synthetic "c1", "c2", ... */
  id: string;
  displayId: string | null;
  branch: string;
  parentIds: string[];
  tag: string | null;
  type: GitCommitType;
  isMerge: boolean;
  /** Set when this commit came from a `cherry-pick id: "..."` statement, naming the source commit id. */
  cherryPickFrom: string | null;
  sourceRange: SourceRange | null;
}

export interface GitBranchEntry {
  name: string;
  parentBranch: string | null;
  sourceRange: SourceRange | null;
}

export interface GitGraphDiagram {
  kind: 'gitGraph';
  commits: GitCommit[];
  branches: Map<string, GitBranchEntry>;
  declarationOrder: Array<{ kind: 'commit' | 'branch' | 'checkout' | 'merge' | 'cherryPick'; id: string }>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Timeline model -------------------------------------------

export interface TimelinePeriod {
  period: string;
  events: string[];
  section: string | null;
  sourceRange: SourceRange | null;
}

export interface TimelineSection {
  name: string;
  sourceRange: SourceRange | null;
}

export interface TimelineDiagram {
  kind: 'timeline';
  title: string | null;
  sections: TimelineSection[];
  periods: TimelinePeriod[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Mindmap model -------------------------------------------

export type MindmapNodeShape = 'default' | 'rounded' | 'circle' | 'square' | 'hexagon' | 'cloud' | 'bang';

export interface MindmapNode {
  /** Synthetic id — mindmap nodes aren't required to have an explicit id in Mermaid's own syntax, so this parser doesn't parse one out separately from the label; see mindmapParser.ts. */
  id: string;
  label: string;
  shape: MindmapNodeShape;
  depth: number; // 0 = root
  parentId: string | null;
  icon: string | null;
  className: string | null;
  sourceRange: SourceRange | null;
}

export interface MindmapDiagram {
  kind: 'mindmap';
  /** Declaration order; nodes[0] is the root when the diagram is non-empty. */
  nodes: MindmapNode[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Gantt model -------------------------------------------

export type GanttStatus = 'done' | 'active' | 'crit' | 'milestone';

export interface GanttTask {
  name: string;
  /** Explicit id if the task declared one (needed for other tasks to reference it via "after"); null otherwise. */
  id: string | null;
  statuses: GanttStatus[];
  /** Raw start-date token as written (this parser does not interpret dateFormat or compute calendar dates — see module comment). Null when the task instead uses "after ...". */
  startRaw: string | null;
  /** Ids this task starts after, from an "after id1 id2 ..." start field. */
  afterIds: string[];
  /** Raw duration ("30d") or explicit end-date token, whichever the line used — not distinguished further; see module comment. */
  durationRaw: string | null;
  section: string | null;
  sourceRange: SourceRange | null;
}

export interface GanttSection {
  name: string;
  sourceRange: SourceRange | null;
}

export interface GanttDiagram {
  kind: 'gantt';
  title: string | null;
  dateFormat: string | null;
  /** Raw `excludes` directive values (e.g. "weekends", "2024-12-25"), one entry per directive. */
  excludes: string[];
  /** `weekend friday` makes Friday/Saturday the weekend; null otherwise. */
  weekend: 'friday' | null;
  sections: GanttSection[];
  tasks: GanttTask[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Sankey model ------------------------------------------

export interface SankeyLink {
  source: string;
  target: string;
  /** Null when the value field was not a number (a parse issue is also reported). */
  value: number | null;
  valueRaw: string;
  sourceRange: SourceRange | null;
}

export interface SankeyDiagram {
  kind: 'sankey';
  links: SankeyLink[];
  /** Distinct node names in first-appearance order. */
  nodes: string[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Quadrant chart model ----------------------------------

export interface QuadrantAxis {
  low: string | null;
  high: string | null;
}

export interface QuadrantPoint {
  name: string;
  /** Null when the coordinate was not a number (a parse issue is also reported). */
  x: number | null;
  y: number | null;
  className: string | null;
  /** Inline style text after the coordinates (e.g. "radius: 12, color: #f00"), not interpreted. */
  styleRaw: string | null;
  sourceRange: SourceRange | null;
}

export interface QuadrantDiagram {
  kind: 'quadrantChart';
  title: string | null;
  xAxis: QuadrantAxis | null;
  yAxis: QuadrantAxis | null;
  /** Index 0..3 = quadrant-1..quadrant-4; null when not declared. */
  quadrants: Array<string | null>;
  points: QuadrantPoint[];
  classDefs: Map<string, string>;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- XY chart model ----------------------------------------

export interface XyAxis {
  title: string | null;
  /** Category labels (x-axis only), or null for a numeric axis. */
  categories: string[] | null;
  range: { min: number; max: number } | null;
  sourceRange: SourceRange | null;
}

export interface XySeries {
  type: 'bar' | 'line';
  title: string | null;
  values: number[];
  sourceRange: SourceRange | null;
}

export interface XyChartDiagram {
  kind: 'xychart';
  horizontal: boolean;
  title: string | null;
  xAxis: XyAxis | null;
  yAxis: XyAxis | null;
  series: XySeries[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Packet model ------------------------------------------

export interface PacketField {
  /** Inclusive bit range. */
  start: number;
  end: number;
  label: string;
  sourceRange: SourceRange | null;
}

export interface PacketDiagram {
  kind: 'packet';
  title: string | null;
  fields: PacketField[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Requirement diagram model -----------------------------

export type RequirementKind = 'requirement' | 'functionalRequirement' | 'interfaceRequirement' | 'performanceRequirement' | 'physicalRequirement' | 'designConstraint';

export interface RequirementItem {
  kind: RequirementKind;
  name: string;
  id: string | null;
  text: string | null;
  risk: string | null;
  verifyMethod: string | null;
  /** Classes attached with the `name:::cls` shorthand on the header line. */
  classes: string[];
  sourceRange: SourceRange | null;
}

export interface RequirementElement {
  name: string;
  type: string | null;
  docref: string | null;
  classes: string[];
  sourceRange: SourceRange | null;
}

export interface RequirementRelation {
  /** Normalised so the arrow always runs source -> target, whichever form was written. */
  source: string;
  target: string;
  type: string;
  sourceRange: SourceRange | null;
}

/** classDef / class / style statements (requirement and block diagrams). CSS is raw text. */
export interface StyleDirectives {
  classDefs: Array<{ name: string; css: string; sourceRange: SourceRange }>;
  classAssignments: Array<{ targets: string[]; className: string; sourceRange: SourceRange }>;
  styles: Array<{ target: string; css: string; sourceRange: SourceRange }>;
}

/** C4 UpdateElementStyle / UpdateRelStyle / UpdateLayoutConfig calls. `targets` are the positional alias arguments; `params` the `$name="value"` pairs. */
export interface C4StyleUpdate {
  macro: 'UpdateElementStyle' | 'UpdateRelStyle' | 'UpdateLayoutConfig';
  targets: string[];
  params: Record<string, string>;
  sourceRange: SourceRange;
}

export interface RequirementDiagram {
  kind: 'requirementDiagram';
  requirements: RequirementItem[];
  elements: RequirementElement[];
  relations: RequirementRelation[];
  styling: StyleDirectives;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Block diagram model -----------------------------------

export interface BlockItem {
  id: string;
  label: string | null;
  /** Raw bracket text including delimiters, e.g. '(("x"))', or null for a plain block. */
  shapeRaw: string | null;
  span: number;
  /** Enclosing group id, or null at the top level. */
  parent: string | null;
  isGroup: boolean;
  isSpace: boolean;
  /** `columns N` declared inside this group (groups only). */
  columns: number | null;
  sourceRange: SourceRange | null;
}

export interface BlockEdge {
  source: string;
  target: string;
  label: string | null;
  sourceRange: SourceRange | null;
}

export interface BlockDiagram {
  kind: 'block';
  /** Top-level `columns N`, or null when not declared. */
  columns: number | null;
  blocks: BlockItem[];
  edges: BlockEdge[];
  styling: StyleDirectives;
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- Architecture diagram model ----------------------------

export type ArchitectureSide = 'L' | 'R' | 'T' | 'B';

export interface ArchitectureNode {
  type: 'group' | 'service' | 'junction';
  id: string;
  icon: string | null;
  label: string | null;
  parent: string | null;
  sourceRange: SourceRange | null;
}

export interface ArchitectureEdge {
  source: string;
  sourceSide: ArchitectureSide;
  /** `{group}` modifier on the source endpoint. */
  sourceGroup: boolean;
  target: string;
  targetSide: ArchitectureSide;
  targetGroup: boolean;
  arrowSource: boolean;
  /** Title from the `-[title]-` connector form, else null. */
  label: string | null;
  arrowTarget: boolean;
  sourceRange: SourceRange | null;
}

export interface ArchitectureDiagram {
  kind: 'architecture';
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

// ---- C4 model ----------------------------------------------

export type C4Variant = 'Context' | 'Container' | 'Component' | 'Dynamic' | 'Deployment';

export interface C4Element {
  /** The macro as written, e.g. "Person_Ext". */
  macro: string;
  alias: string;
  label: string;
  techn: string | null;
  description: string | null;
  external: boolean;
  /** Enclosing boundary alias, or null at the top level. */
  boundary: string | null;
  sourceRange: SourceRange | null;
}

export interface C4Boundary {
  macro: string;
  alias: string;
  label: string;
  type: string | null;
  parent: string | null;
  sourceRange: SourceRange | null;
}

export interface C4Relation {
  macro: string;
  from: string;
  to: string;
  label: string;
  techn: string | null;
  sourceRange: SourceRange | null;
}

export interface C4Diagram {
  kind: 'c4';
  variant: C4Variant | null;
  title: string | null;
  elements: C4Element[];
  boundaries: C4Boundary[];
  relations: C4Relation[];
  styleUpdates: C4StyleUpdate[];
  comments: Array<{ text: string; sourceRange: SourceRange }>;
  frontmatter: string | null;
  parseIssues: ParseIssue[];
  sourceText: string;
}

export type ParsedDiagram = FlowchartDiagram | SequenceDiagram | ClassDiagram | ErDiagram | StateDiagram | PieDiagram | JourneyDiagram | GitGraphDiagram | TimelineDiagram | MindmapDiagram | GanttDiagram | SankeyDiagram | QuadrantDiagram | XyChartDiagram | PacketDiagram | RequirementDiagram | BlockDiagram | ArchitectureDiagram | C4Diagram | LightDiagramModel;

export function isFlowchart(diagram: ParsedDiagram): diagram is FlowchartDiagram {
  return diagram.kind === 'flowchart';
}

export function isSequenceDiagram(diagram: ParsedDiagram): diagram is SequenceDiagram {
  return diagram.kind === 'sequenceDiagram';
}

export function isClassDiagram(diagram: ParsedDiagram): diagram is ClassDiagram {
  return diagram.kind === 'classDiagram';
}

export function isErDiagram(diagram: ParsedDiagram): diagram is ErDiagram {
  return diagram.kind === 'erDiagram';
}

export function isStateDiagram(diagram: ParsedDiagram): diagram is StateDiagram {
  return diagram.kind === 'stateDiagram';
}

export function isPieDiagram(diagram: ParsedDiagram): diagram is PieDiagram {
  return diagram.kind === 'pie';
}

export function isJourneyDiagram(diagram: ParsedDiagram): diagram is JourneyDiagram {
  return diagram.kind === 'journey';
}

export function isGitGraphDiagram(diagram: ParsedDiagram): diagram is GitGraphDiagram {
  return diagram.kind === 'gitGraph';
}

export function isTimelineDiagram(diagram: ParsedDiagram): diagram is TimelineDiagram {
  return diagram.kind === 'timeline';
}

export function isMindmapDiagram(diagram: ParsedDiagram): diagram is MindmapDiagram {
  return diagram.kind === 'mindmap';
}

export function isGanttDiagram(diagram: ParsedDiagram): diagram is GanttDiagram {
  return diagram.kind === 'gantt';
}

export function isSankeyDiagram(diagram: ParsedDiagram): diagram is SankeyDiagram {
  return diagram.kind === 'sankey';
}

export function isQuadrantDiagram(diagram: ParsedDiagram): diagram is QuadrantDiagram {
  return diagram.kind === 'quadrantChart';
}

export function isXyChartDiagram(diagram: ParsedDiagram): diagram is XyChartDiagram {
  return diagram.kind === 'xychart';
}

export function isPacketDiagram(diagram: ParsedDiagram): diagram is PacketDiagram {
  return diagram.kind === 'packet';
}

export function isRequirementDiagram(diagram: ParsedDiagram): diagram is RequirementDiagram {
  return diagram.kind === 'requirementDiagram';
}

export function isBlockDiagram(diagram: ParsedDiagram): diagram is BlockDiagram {
  return diagram.kind === 'block';
}

export function isArchitectureDiagram(diagram: ParsedDiagram): diagram is ArchitectureDiagram {
  return diagram.kind === 'architecture';
}

export function isC4Diagram(diagram: ParsedDiagram): diagram is C4Diagram {
  return diagram.kind === 'c4';
}
