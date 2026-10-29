import {
  FlowchartDiagram,
  FlowchartDirection,
  GraphEdge,
  GraphNode,
  NodeShape,
  ParseIssue,
  SourceRange,
} from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

interface ShapeSpec {
  shape: NodeShape;
  open: string;
  close: string;
}

// Ordered longest-delimiter-first so e.g. `(((` is tried before `((` before `(`.
const SHAPE_SPECS: ShapeSpec[] = [
  { shape: 'doubleCircle', open: '(((', close: ')))' },
  { shape: 'stadium', open: '([', close: '])' },
  { shape: 'subroutine', open: '[[', close: ']]' },
  { shape: 'cylinder', open: '[(', close: ')]' },
  { shape: 'circle', open: '((', close: '))' },
  { shape: 'hexagon', open: '{{', close: '}}' },
  { shape: 'trapezoid', open: '[/', close: '\\]' },
  { shape: 'trapezoidAlt', open: '[\\', close: '/]' },
  { shape: 'parallelogram', open: '[/', close: '/]' },
  { shape: 'parallelogramAlt', open: '[\\', close: '\\]' },
  { shape: 'rectangle', open: '[', close: ']' },
  { shape: 'rounded', open: '(', close: ')' },
  { shape: 'rhombus', open: '{', close: '}' },
];

const ARROW_TOKENS = ['-.->', '==>', '-->', '-.-','===', '---', '--x', '--o'] as const;

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  // Avoid stripping inside a quoted label (best-effort: only strip if not inside quotes before idx).
  const before = line.slice(0, idx);
  const quoteCount = (before.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function parseNodeToken(
  token: string,
  _lineIdx: number,
  _colOffset: number,
): { id: string; label: string | null; shape: NodeShape | null; consumed: number } | null {
  const idMatch = /^[A-Za-z0-9_]+/.exec(token);
  if (!idMatch) return null;
  const id = idMatch[0];
  let rest = token.slice(id.length);

  for (const spec of SHAPE_SPECS) {
    if (rest.startsWith(spec.open)) {
      const closeIdx = rest.indexOf(spec.close, spec.open.length);
      if (closeIdx !== -1) {
        const label = rest.slice(spec.open.length, closeIdx);
        return {
          id,
          label: unquote(label),
          shape: spec.shape,
          consumed: id.length + closeIdx + spec.close.length,
        };
      }
    }
  }
  // Asymmetric shape: id>label]
  if (rest.startsWith('>')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx !== -1) {
      return { id, label: unquote(rest.slice(1, closeIdx)), shape: 'asymmetric', consumed: id.length + closeIdx + 1 };
    }
  }
  // Bare node reference, no shape/label on this token.
  return { id, label: null, shape: null, consumed: id.length };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/**
 * Parses `flowchart`/`graph` Mermaid source into the intermediate graph model.
 * This is a pragmatic line-oriented parser, not a full PEG/AST grammar — it
 * covers the syntax surface used by the vast majority of real-world Mermaid
 * flowcharts (node shapes, chained edges, edge labels, subgraphs, classDef/
 * class, comments, styles) and records a ParseIssue for anything it cannot
 * confidently interpret rather than guessing.
 */
export function parseFlowchart(source: string): FlowchartDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const subgraphs = new Map<string, Subgraph>();
  const declarationOrder: FlowchartDiagram['declarationOrder'] = [];
  const classDefs = new Map<string, Record<string, string>>();
  const comments: FlowchartDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let direction: FlowchartDirection = 'TD';
  let headerFound = false;
  const subgraphStack: string[] = [];
  let anonSubgraphCounter = 0;
  let edgeCounter = 0;

  function currentParent(): string | null {
    return subgraphStack.length > 0 ? subgraphStack[subgraphStack.length - 1] : null;
  }

  function ensureNode(id: string, lineIdx: number): GraphNode {
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        label: id,
        shape: 'default',
        classes: [],
        styles: {},
        subgraphId: currentParent(),
        sourceRange: makeRange(lineIdx, 0, 0),
        rawDeclaration: null,
      };
      nodes.set(id, node);
      declarationOrder.push({ kind: 'node', id });
      const parent = currentParent();
      if (parent) {
        subgraphs.get(parent)?.memberNodeIds.push(id);
      }
    }
    return node;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      const headerMatch = /^(graph|flowchart)\s*(TD|TB|BT|LR|RL)?\b/i.exec(trimmed);
      if (headerMatch) {
        headerFound = true;
        if (headerMatch[2]) {
          direction = headerMatch[2].toUpperCase() as FlowchartDirection;
        }
        continue;
      }
      // Non-header content before a header: tolerate (e.g. init directive already
      // stripped as frontmatter) but flag if it's clearly not a directive.
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({
          message: `Expected a "graph" or "flowchart" header before diagram content.`,
          severity: 'error',
          range: makeRange(lineIdx, 0, trimmed.length),
        });
      }
      continue;
    }

    // subgraph start
    const subgraphMatch = /^subgraph\s+(.*)$/i.exec(trimmed);
    if (subgraphMatch) {
      const remainder = subgraphMatch[1].trim();
      let id: string;
      let title: string;
      const idTitleMatch = /^([A-Za-z0-9_]+)\s*\[(.*)\]$/.exec(remainder);
      if (idTitleMatch) {
        id = idTitleMatch[1];
        title = unquote(idTitleMatch[2]);
      } else if (remainder.length > 0) {
        id = remainder.replace(/\s+/g, '_');
        title = remainder;
      } else {
        id = `subgraph_${++anonSubgraphCounter}`;
        title = '';
      }
      const sg: Subgraph = {
        id,
        title,
        memberNodeIds: [],
        memberSubgraphIds: [],
        parentId: currentParent(),
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      };
      subgraphs.set(id, sg);
      declarationOrder.push({ kind: 'subgraphStart', id });
      const parent = currentParent();
      if (parent) {
        subgraphs.get(parent)?.memberSubgraphIds.push(id);
      }
      subgraphStack.push(id);
      continue;
    }

    if (/^end$/i.test(trimmed)) {
      const closed = subgraphStack.pop();
      if (closed) {
        declarationOrder.push({ kind: 'subgraphEnd', id: closed });
      } else {
        parseIssues.push({
          message: `"end" with no matching "subgraph".`,
          severity: 'error',
          range: makeRange(lineIdx, 0, trimmed.length),
        });
      }
      continue;
    }

    // classDef name fill:#f9f,stroke:#333
    const classDefMatch = /^classDef\s+([A-Za-z0-9_]+)\s+(.+)$/i.exec(trimmed);
    if (classDefMatch) {
      classDefs.set(classDefMatch[1], parseStyleString(classDefMatch[2]));
      continue;
    }

    // class A,B className
    const classAssignMatch = /^class\s+([A-Za-z0-9_,\s]+)\s+([A-Za-z0-9_]+)$/i.exec(trimmed);
    if (classAssignMatch) {
      const ids = classAssignMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of ids) {
        const node = ensureNode(id, lineIdx);
        if (!node.classes.includes(classAssignMatch[2])) node.classes.push(classAssignMatch[2]);
      }
      continue;
    }

    // style A fill:#f9f
    const styleMatch = /^style\s+([A-Za-z0-9_]+)\s+(.+)$/i.exec(trimmed);
    if (styleMatch) {
      const node = ensureNode(styleMatch[1], lineIdx);
      Object.assign(node.styles, parseStyleString(styleMatch[2]));
      continue;
    }

    // click A callback / click A "url"  — passthrough, not modeled structurally yet.
    if (/^click\s+/i.test(trimmed)) {
      continue;
    }

    // Edge chain: TokenA --arrow-->|label| TokenB --arrow--> TokenC ...
    if (containsArrow(trimmed)) {
      parseEdgeChain(trimmed, lineIdx);
      continue;
    }

    // Bare node declaration: A[Label]
    const parsed = parseNodeToken(trimmed, lineIdx, 0);
    if (parsed && parsed.consumed === trimmed.length) {
      const node = ensureNode(parsed.id, lineIdx);
      if (parsed.label !== null) node.label = parsed.label;
      if (parsed.shape !== null) node.shape = parsed.shape;
      node.rawDeclaration = trimmed;
      node.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      continue;
    }

    parseIssues.push({
      message: `Unrecognized statement: "${trimmed}"`,
      severity: 'warning',
      range: makeRange(lineIdx, 0, trimmed.length),
    });
  }

  if (subgraphStack.length > 0) {
    for (const openId of subgraphStack) {
      parseIssues.push({
        message: `Subgraph "${openId}" was never closed with "end".`,
        severity: 'error',
        range: subgraphs.get(openId)?.sourceRange ?? makeRange(lines.length - 1, 0, 0),
      });
    }
  }
  if (!headerFound) {
    parseIssues.push({
      message: `No "graph" or "flowchart" header found.`,
      severity: 'error',
      range: makeRange(0, 0, 0),
    });
  }

  function parseEdgeChain(text: string, lineIdx: number) {
    // Split into alternating node-tokens and arrow-segments.
    // We scan left to right, matching the longest arrow token at each position.
    let i = 0;
    let prevNodeId: string | null = null;

    function readNodeToken(startAt: number): { id: string; label: string | null; shape: NodeShape | null; end: number } | null {
      const slice = text.slice(startAt);
      const trimmedLeadingSpaces = slice.match(/^\s*/)?.[0].length ?? 0;
      const from = startAt + trimmedLeadingSpaces;
      const parsed2 = parseNodeToken(text.slice(from), lineIdx, from);
      if (!parsed2) return null;
      return { id: parsed2.id, label: parsed2.label, shape: parsed2.shape, end: from + parsed2.consumed };
    }

    const first = readNodeToken(0);
    if (!first) {
      parseIssues.push({ message: `Could not parse edge start in: "${text}"`, severity: 'warning', range: makeRange(lineIdx, 0, text.length) });
      return;
    }
    let node = ensureNode(first.id, lineIdx);
    if (first.label !== null) node.label = first.label;
    if (first.shape !== null) node.shape = first.shape;
    prevNodeId = first.id;
    i = first.end;

    while (i < text.length) {
      const rest = text.slice(i);
      const leading = rest.match(/^\s*/)?.[0].length ?? 0;
      i += leading;
      const remainder = text.slice(i);
      const arrowToken = ARROW_TOKENS.find((tok) => remainder.startsWith(tok));
      if (!arrowToken) {
        // Might be a long-form edge like `-- text -->`; try generic pattern.
        const longForm = /^(--|==|-\.)\s*([^-=.>][^\n]*?)\s*(-->|---|==>|===|-\.->|-\.-)/.exec(remainder);
        if (longForm) {
          const arrowNormalized = normalizeArrow(longForm[3]);
          const label = longForm[2].trim();
          i += longForm[0].length;
          const next = readNodeToken(i);
          if (!next) break;
          const nextNode = ensureNode(next.id, lineIdx);
          if (next.label !== null) nextNode.label = next.label;
          if (next.shape !== null) nextNode.shape = next.shape;
          edges.push(makeEdge(prevNodeId!, next.id, label, arrowNormalized, lineIdx, text));
          prevNodeId = next.id;
          i = next.end;
          continue;
        }
        break;
      }
      i += arrowToken.length;
      // Optional |label|
      let label: string | null = null;
      const labelMatch = /^\|([^|]*)\|/.exec(text.slice(i));
      if (labelMatch) {
        label = unquote(labelMatch[1]);
        i += labelMatch[0].length;
      }
      const next = readNodeToken(i);
      if (!next) {
        parseIssues.push({ message: `Edge missing target node in: "${text}"`, severity: 'warning', range: makeRange(lineIdx, 0, text.length) });
        break;
      }
      const nextNode = ensureNode(next.id, lineIdx);
      if (next.label !== null) nextNode.label = next.label;
      if (next.shape !== null) nextNode.shape = next.shape;
      edges.push(makeEdge(prevNodeId!, next.id, label, normalizeArrow(arrowToken), lineIdx, text));
      prevNodeId = next.id;
      i = next.end;
    }
  }

  function makeEdge(src: string, tgt: string, label: string | null, arrow: GraphEdge['arrow'], lineIdx: number, raw: string): GraphEdge {
    const edge: GraphEdge = {
      id: `e${++edgeCounter}`,
      source: src,
      target: tgt,
      label,
      arrow,
      sourceRange: makeRange(lineIdx, 0, raw.length),
      rawDeclaration: raw,
    };
    declarationOrder.push({ kind: 'edge', id: edge.id });
    return edge;
  }

  return {
    kind: 'flowchart',
    direction,
    nodes,
    edges,
    subgraphs,
    declarationOrder,
    classDefs,
    comments,
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}

function containsArrow(text: string): boolean {
  return ARROW_TOKENS.some((t) => text.includes(t)) || /--[^->=.]*-->/.test(text) || /==[^=>]*==>/.test(text) || /-\.[^->]*-\.->/.test(text);
}

function normalizeArrow(token: string): GraphEdge['arrow'] {
  const t = token.trim();
  if (t.startsWith('-.') && t.endsWith('->')) return '-.->';
  if (t.startsWith('-.')) return '-.-';
  if (t.startsWith('==') && t.endsWith('>')) return '==>';
  if (t.startsWith('==')) return '===';
  if (t.endsWith('x')) return '--x';
  if (t.endsWith('o')) return '--o';
  if (t.endsWith('>')) return '-->';
  return '---';
}

function parseStyleString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',')) {
    const [k, ...v] = part.split(':');
    if (k && v.length) out[k.trim()] = v.join(':').trim();
  }
  return out;
}

// Re-exported here to avoid a circular import at the top of the file.
import { Subgraph } from '../diagram/types';
