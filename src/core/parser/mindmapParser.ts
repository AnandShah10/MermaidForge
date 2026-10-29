import { MindmapDiagram, MindmapNode, MindmapNodeShape, ParseIssue, SourceRange } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

interface ShapeSpec {
  shape: MindmapNodeShape;
  open: string;
  close: string;
}

// Longest/most-specific delimiter pairs first, so e.g. "))" (bang) is tried
// before ")" would ever be considered part of something else.
const SHAPE_SPECS: ShapeSpec[] = [
  { shape: 'bang', open: '))', close: '((' },
  { shape: 'circle', open: '((', close: '))' },
  { shape: 'hexagon', open: '{{', close: '}}' },
  { shape: 'cloud', open: ')', close: '(' },
  { shape: 'square', open: '[', close: ']' },
  { shape: 'rounded', open: '(', close: ')' },
];

/**
 * Extracts a shape + label from a mindmap node line. Mermaid mindmap nodes
 * are usually written as bare text (`Origins`), text wrapped in a shape
 * delimiter (`((circle))`, `[square]`), or — very commonly, especially for
 * the root — an identifier immediately followed by a shape delimiter
 * (`root((mindmap))`, the standard example straight from Mermaid's own
 * docs). That leading identifier is recognized and stripped so it doesn't
 * end up embedded in the visible label, but it is NOT retained anywhere as
 * a separate id field: this parser's `MindmapNode.id` is always a
 * synthetic "n1", "n2", ... regardless, since nothing else in a mindmap
 * ever references a node by id — there are no edges to wire up, unlike
 * flowchart.
 */
function parseShapeAndLabel(text: string): { shape: MindmapNodeShape; label: string } {
  const idPrefixMatch = /^[A-Za-z0-9_]+/.exec(text);
  const rest = idPrefixMatch ? text.slice(idPrefixMatch[0].length) : text;

  for (const spec of SHAPE_SPECS) {
    if (rest.startsWith(spec.open) && rest.endsWith(spec.close) && rest.length >= spec.open.length + spec.close.length) {
      return { shape: spec.shape, label: rest.slice(spec.open.length, rest.length - spec.close.length).trim() };
    }
  }
  // No shape delimiters found at all (with or without a leading identifier)
  // — treat the whole original text as plain bare-text label, since a bare
  // word like "Origins" or "A1" would otherwise have its "id prefix" eat
  // the entire string and leave nothing behind.
  return { shape: 'default', label: text };
}

/**
 * Parses `mindmap` Mermaid source into a structural model: one root plus
 * nested child nodes, depth determined purely by each line's leading
 * whitespace (this is the one diagram type in the project where nesting is
 * indentation-driven rather than delimiter-driven, e.g. `{`/`}` or
 * `subgraph`/`end`). Leading whitespace is measured in raw characters, so
 * consistent indentation (all spaces, or all tabs) parses correctly;
 * mixing tabs and spaces inconsistently within one mindmap can produce
 * misleading depths, the same way it would confuse a human reader.
 *
 * `::icon(...)` and `:::className` lines attach to the immediately
 * preceding node rather than creating a new one — they don't have their
 * own indentation-depth meaning. A leading identifier before a shape
 * delimiter (`root((mindmap))`) is recognized and stripped from the label
 * — see parseShapeAndLabel's own comment for why it isn't kept anywhere.
 */
export function parseMindmapDiagram(source: string): MindmapDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const nodes: MindmapNode[] = [];
  const comments: MindmapDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  const stack: Array<{ indent: number; node: MindmapNode }> = [];
  let lastNode: MindmapNode | null = null;
  let nodeCounter = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    if (code.trim().length === 0) continue;

    if (!headerFound) {
      if (/^\s*mindmap\b/i.test(code)) {
        headerFound = true;
        continue;
      }
      if (!code.trim().startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "mindmap" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, code.trim().length) });
      }
      continue;
    }

    const indent = /^[ \t]*/.exec(code)![0].length;
    const trimmed = code.trim();

    const iconMatch = /^::icon\(([^)]*)\)$/.exec(trimmed);
    if (iconMatch) {
      if (lastNode) lastNode.icon = iconMatch[1].trim();
      else parseIssues.push({ message: 'An "::icon(...)" line appeared with no preceding node to attach it to.', severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    const classMatch = /^:::(.+)$/.exec(trimmed);
    if (classMatch) {
      if (lastNode) lastNode.className = classMatch[1].trim();
      else parseIssues.push({ message: 'A ":::className" line appeared with no preceding node to attach it to.', severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    let parent = stack.length > 0 ? stack[stack.length - 1].node : null;

    if (parent === null && nodes.length > 0) {
      // A second "root-level" line in a mindmap is invalid — Mermaid only
      // supports one root — but treating it as a hard stop (or erroring on
      // every line beneath it too) would be far more disruptive than the
      // author's likely mistake warrants. Attach it under the real root
      // instead, with one warning, so the rest of the mindmap still parses.
      parseIssues.push({
        message: 'A mindmap can only have one root node; this line is indented at or before the root. It has been attached under the root instead of starting a second tree.',
        severity: 'warning',
        range: makeRange(lineIdx, 0, trimmed.length),
      });
      parent = nodes[0];
      stack.push({ indent: -1, node: nodes[0] }); // sentinel: anything more indented than the root nests under it
    }

    const { shape, label } = parseShapeAndLabel(trimmed);
    const node: MindmapNode = {
      id: `n${++nodeCounter}`,
      label,
      shape,
      depth: stack.length,
      parentId: parent?.id ?? null,
      icon: null,
      className: null,
      sourceRange: makeRange(lineIdx, 0, trimmed.length),
    };
    nodes.push(node);
    lastNode = node;
    stack.push({ indent, node });
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "mindmap" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'mindmap', nodes, comments, frontmatter, parseIssues, sourceText: source };
}
