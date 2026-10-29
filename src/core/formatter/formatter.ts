import { FlowchartDiagram, GraphEdge, GraphNode } from '../diagram/types';
import { isFlowchart } from '../diagram/types';
import { parseMermaid } from '../parser/mermaidParser';
import { detectDiagramType } from '../parser/detectDiagramType';

export interface FormatterOptions {
  indentSize: number;
}

export const DEFAULT_FORMATTER_OPTIONS: FormatterOptions = { indentSize: 2 };

/**
 * Formats Mermaid source. For flowcharts, this re-renders the parsed graph
 * model with normalized spacing/indentation (semantics-preserving — it never
 * reorders nodes/edges relative to each other, only normalizes whitespace and
 * shape delimiters). For diagram types without a structural parser yet, this
 * falls back to safe whitespace-only normalization (trim trailing whitespace,
 * normalize line endings, normalize indentation of already-indented blocks)
 * so it never risks changing diagram semantics it doesn't understand.
 *
 * For sequence, class, ER, state, requirement, C4, block, gantt, journey and
 * timeline diagrams the formatter re-indents by block nesting (`loop`/`alt`
 * ... `end`, `{ ... }` bodies, `section`s). It changes ONLY leading and
 * trailing whitespace — never a character of content, never the order of
 * lines — which the tests assert on a corpus. Indentation-sensitive kinds
 * (mindmap) and the rest are trimmed only.
 */
export function formatMermaid(source: string, options: FormatterOptions = DEFAULT_FORMATTER_OPTIONS): string {
  const diagram = parseMermaid(source);
  if (isFlowchart(diagram) && diagram.parseIssues.every((i) => i.severity !== 'error')) {
    return formatFlowchart(diagram, options);
  }
  const kind = detectDiagramType(source);
  if (INDENT_RULES[kind]) return formatIndentation(source, INDENT_RULES[kind]!, options);
  return normalizeWhitespaceOnly(source, options);
}

interface IndentRules {
  /** Line opens a nested block (children indent one more level). */
  open: (t: string) => boolean;
  /** Line closes the innermost block (it is printed at the outer level). */
  close: (t: string) => boolean;
  /** Line continues the block at its own level (`else`, `and`, `option`): printed one level out, children stay in. */
  middle?: (t: string) => boolean;
  /** Opening lines whose body holds plain member/attribute text, so nothing inside it opens a nested block. */
  leaf?: (t: string) => boolean;
  /** Flat kinds: `section` headers at depth 1, the lines under them at depth 2. */
  sections?: boolean;
}

const BRACES: IndentRules = { open: (t) => /\{$/.test(t), close: (t) => /^\}/.test(t) && !/\{$/.test(t) };
const BODIES: IndentRules = { ...BRACES, leaf: (t) => !/^namespace\b/i.test(t) };

const INDENT_RULES: Partial<Record<ReturnType<typeof detectDiagramType>, IndentRules>> = {
  sequenceDiagram: {
    open: (t) => /^(loop|alt|opt|par|critical|break|rect|box)(\s|$)/i.test(t),
    close: (t) => /^end$/i.test(t),
    middle: (t) => /^(else|and|option)(\s|$)/i.test(t),
  },
  classDiagram: BODIES,
  erDiagram: BODIES,
  requirementDiagram: BODIES,
  c4: BRACES,
  stateDiagram: {
    open: (t) => /^state\b.*\{$/i.test(t) || /^note\s+(left|right)\s+of\s+\S+$/i.test(t),
    close: (t) => /^\}/.test(t) || /^end\s+note$/i.test(t),
  },
  block: { open: (t) => /^block:\S+/.test(t), close: (t) => /^end$/i.test(t) },
  gantt: { open: () => false, close: () => false, sections: true },
  journey: { open: () => false, close: () => false, sections: true },
  timeline: { open: () => false, close: () => false, sections: true },
};

/** Re-indents by block nesting, touching only leading/trailing whitespace; frontmatter and multi-line `%%{ }%%` directives are copied verbatim. */
function formatIndentation(source: string, rules: IndentRules, options: FormatterOptions): string {
  const pad = ' '.repeat(options.indentSize);
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') {
    out.push('');
    i++;
  }
  if (lines[i]?.trim() === '---') {
    let e = i + 1;
    while (e < lines.length && lines[e].trim() !== '---') e++;
    for (; i <= Math.min(e, lines.length - 1); i++) out.push(lines[i].replace(/[ \t]+$/, ''));
  }
  let headerDone = false;
  let depth = 0;
  let inSection = false;
  let inLeaf = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') {
      out.push('');
      continue;
    }
    if (t.startsWith('%%{') && !t.includes('}%%')) {
      // multi-line directive: copy verbatim up to its terminator
      for (; i < lines.length; i++) {
        out.push(lines[i].replace(/[ \t]+$/, ''));
        if (lines[i].includes('}%%')) break;
      }
      continue;
    }
    if (!headerDone) {
      if (t.startsWith('%%')) {
        out.push(t);
        continue;
      }
      headerDone = true;
      out.push(t); // the diagram-type line is never indented
      continue;
    }
    const code = t.replace(/\s*%%.*$/, '').trim() || t;
    if (rules.sections) {
      if (/^section\b/i.test(code)) {
        inSection = true;
        out.push(pad + t);
      } else out.push(pad.repeat(inSection ? 2 : 1) + t);
      continue;
    }
    if (inLeaf) {
      if (rules.close(code)) {
        inLeaf = false;
        depth = Math.max(0, depth - 1);
      }
      out.push(pad.repeat(depth + 1) + t);
      continue;
    }
    if (rules.close(code)) depth = Math.max(0, depth - 1);
    const isMiddle = rules.middle?.(code) ?? false;
    out.push(pad.repeat(Math.max(1, depth + 1 - (isMiddle ? 1 : 0))) + t);
    if (rules.open(code)) {
      depth++;
      if (rules.leaf?.(code)) inLeaf = true;
    }
  }
  // Same trailing-newline convention as the input.
  return out.join('\n').replace(/\s+$/, '') + (source.endsWith('\n') ? '\n' : '');
}

function normalizeWhitespaceOnly(source: string, _options: FormatterOptions): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return lines.map((l) => l.replace(/[ \t]+$/g, '')).join('\n');
}

function shapeDelimiters(shape: GraphNode['shape']): [string, string] {
  switch (shape) {
    case 'doubleCircle': return ['(((', ')))'];
    case 'stadium': return ['([', '])'];
    case 'subroutine': return ['[[', ']]'];
    case 'cylinder': return ['[(', ')]'];
    case 'circle': return ['((', '))'];
    case 'hexagon': return ['{{', '}}'];
    case 'trapezoid': return ['[/', '\\]'];
    case 'trapezoidAlt': return ['[\\', '/]'];
    case 'parallelogram': return ['[/', '/]'];
    case 'parallelogramAlt': return ['[\\', '\\]'];
    case 'rounded': return ['(', ')'];
    case 'rhombus': return ['{', '}'];
    case 'asymmetric': return ['>', ']'];
    case 'rectangle': return ['[', ']'];
    default: return ['', ''];
  }
}

function needsQuotes(label: string): boolean {
  return /[|"{}[\]()#;,]/.test(label);
}

function renderLabel(label: string): string {
  return needsQuotes(label) ? `"${label.replace(/"/g, '#quot;')}"` : label;
}

function renderNodeDeclaration(node: GraphNode, indent: string): string {
  if (node.shape === 'default' && node.label === node.id) {
    // Referenced-only node; nothing meaningful to declare on its own line.
    return '';
  }
  const [open, close] = shapeDelimiters(node.shape);
  const labelPart = open ? `${open}${renderLabel(node.label)}${close}` : '';
  return `${indent}${node.id}${labelPart}`;
}

function renderEdge(edge: GraphEdge, _nodesRenderedInline: Set<string>, indent: string): string {
  const parts = [edge.source, edge.arrow];
  if (edge.label) {
    parts.push(`|${renderLabel(edge.label)}|`);
  }
  parts.push(edge.target);
  // arrow and label glue directly to the arrow token, others space-separated.
  const arrowWithLabel = edge.label ? `${edge.arrow}|${renderLabel(edge.label)}|` : edge.arrow;
  return `${indent}${edge.source} ${arrowWithLabel} ${edge.target}`;
}

function formatFlowchart(diagram: FlowchartDiagram, options: FormatterOptions): string {
  const pad = ' '.repeat(options.indentSize);
  const out: string[] = [];

  if (diagram.frontmatter) {
    out.push(diagram.frontmatter);
  }
  out.push(`flowchart ${diagram.direction}`);

  // Render nodes/subgraphs/edges that live at the top level, then nested
  // subgraphs, following the original declaration order for stability.
  const emittedNodes = new Set<string>();
  const emittedEdgesForNodeDecls = new Set<string>();

  function depthOf(subgraphId: string | null): number {
    let depth = 0;
    let cur = subgraphId;
    while (cur) {
      depth++;
      cur = diagram.subgraphs.get(cur)?.parentId ?? null;
    }
    return depth;
  }

  const subgraphOpenStack: string[] = [];

  for (const decl of diagram.declarationOrder) {
    if (decl.kind === 'subgraphStart') {
      const sg = diagram.subgraphs.get(decl.id)!;
      const indent = pad.repeat(depthOf(sg.parentId) + 1);
      const titlePart = sg.title ? ` [${renderLabel(sg.title)}]` : '';
      out.push(`${indent}subgraph ${sg.id}${titlePart}`);
      subgraphOpenStack.push(decl.id);
      continue;
    }
    if (decl.kind === 'subgraphEnd') {
      subgraphOpenStack.pop();
      const closedDepth = subgraphOpenStack.length;
      out.push(`${pad.repeat(closedDepth + 1)}end`);
      continue;
    }
    if (decl.kind === 'node') {
      if (emittedNodes.has(decl.id)) continue;
      const node = diagram.nodes.get(decl.id);
      if (!node) continue;
      const indent = pad.repeat(depthOf(node.subgraphId) + 1);
      const line = renderNodeDeclaration(node, indent);
      if (line) out.push(line);
      emittedNodes.add(decl.id);
      continue;
    }
    if (decl.kind === 'edge') {
      const edge = diagram.edges.find((e) => e.id === decl.id);
      if (!edge) continue;
      const srcNode = diagram.nodes.get(edge.source);
      const depth = depthOf(srcNode?.subgraphId ?? null);
      out.push(renderEdge(edge, emittedEdgesForNodeDecls, pad.repeat(depth + 1)));
      continue;
    }
  }

  // classDef / class assignments, sorted for stable output.
  const classDefNames = [...diagram.classDefs.keys()].sort();
  for (const name of classDefNames) {
    const styleStr = Object.entries(diagram.classDefs.get(name)!)
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    out.push(`${pad}classDef ${name} ${styleStr}`);
  }
  const nodesByClass = new Map<string, string[]>();
  for (const [id, node] of diagram.nodes) {
    for (const cls of node.classes) {
      nodesByClass.set(cls, [...(nodesByClass.get(cls) ?? []), id]);
    }
  }
  for (const cls of [...nodesByClass.keys()].sort()) {
    out.push(`${pad}class ${nodesByClass.get(cls)!.sort().join(',')} ${cls}`);
  }

  // Styles.
  for (const [id, node] of [...diagram.nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (Object.keys(node.styles).length === 0) continue;
    const styleStr = Object.entries(node.styles).map(([k, v]) => `${k}:${v}`).join(',');
    out.push(`${pad}style ${id} ${styleStr}`);
  }

  // Trailing comments preserved verbatim at end of file (conservative choice —
  // inline comment repositioning is not attempted since it can be ambiguous).
  for (const c of diagram.comments) {
    out.push(`${pad}${c.text}`);
  }

  return out.join('\n') + '\n';
}
