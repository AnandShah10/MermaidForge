import { BlockDiagram, BlockEdge, BlockItem, ParseIssue } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, stripComment } from './parserUtils';
import { emptyStyling, parseStylingLine } from './styling';

/**
 * Parses `block-beta` / `block`:
 *   columns 3                      (top level, or inside a group)
 *   a b["Label"]:2 c(("round")) space d:3
 *   block:group1:2 ... end         (nested group, optional span)
 *   a --> b      a -- "text" --> b      a -->|text| b
 * Block ids are `[A-Za-z0-9_]+`. A block may carry a shape in brackets
 * (`[]`, `()`, `(())`, `([])`, `[[]]`, `[()]`, `{}`, `{{}}`, `[//]`, `[\\]`,
 * `>]` — kept as raw text, with the label extracted) and a `:N` column span.
 * Arrow blocks (`id<["x"]>(right)`) are read as ordinary blocks with the raw
 * shape text. `classDef` / `class` / `style` lines are modelled in
 * `styling` (CSS kept raw; real Mermaid rejects the `id:::cls` shorthand in
 * block diagrams, so it is not parsed). Not modelled: link styling and edge
 * endpoints that carry a shape. Edge endpoints are NOT resolved here (the linter does that).
 */
const EDGE_LABELLED = /^(\w+)\s*(?:--|==)\s*"([^"]*)"\s*(?:-->|---|==>|===)\s*(\w+)$/;
const EDGE_PLAIN = /^(\w+)\s*(?:-->|---|==>|===|<-->|-\.->)\s*(?:\|"?([^|"]*)"?\|\s*)?(\w+)$/;

/** End index (exclusive) of the balanced bracket group starting at s[i], or -1. */
function readGroup(s: string, i: number): number {
  let depth = 0;
  let inQuote = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inQuote) {
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if ('[({'.includes(c)) depth++;
    else if ('])}'.includes(c) && --depth === 0) return j + 1;
  }
  return -1;
}

function labelOf(shape: string): string | null {
  const q = /"([^"]*)"/.exec(shape);
  if (q) return q[1];
  const inner = shape.replace(/^[[({/\\>]+/, '').replace(/[\])}/\\]+$/, '').trim();
  return inner || null;
}

export function parseBlockDiagram(source: string): BlockDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: BlockDiagram['comments'] = [];
  const blocks: BlockItem[] = [];
  const edges: BlockEdge[] = [];
  const styling = emptyStyling();
  const stack: Array<{ item: BlockItem; line: number }> = [];
  let columns: number | null = null;
  let anon = 0;
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      if (/^block(-beta)?\s*$/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "block-beta" header before diagram content.', severity: 'error', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^columns\s+(\d+)\s*$/i.exec(trimmed))) {
      const n = Number(m[1]);
      if (n < 1) parseIssues.push({ message: '"columns" must be at least 1.', severity: 'error', range });
      else if (stack.length) stack[stack.length - 1].item.columns = n;
      else columns = n;
      continue;
    }
    if (/^columns\b/i.test(trimmed)) {
      parseIssues.push({ message: `"columns" needs a number: "${trimmed}"`, severity: 'error', range });
      continue;
    }
    if (/^end\s*$/i.test(trimmed)) {
      if (stack.length === 0) parseIssues.push({ message: '"end" without a matching "block:" group.', severity: 'error', range });
      else stack.pop();
      continue;
    }
    if ((m = /^block(?::([A-Za-z0-9_]+))?(?::(\d+))?\s*$/i.exec(trimmed))) {
      const item: BlockItem = {
        id: m[1] ?? `__group${++anon}`,
        label: null,
        shapeRaw: null,
        span: m[2] ? Number(m[2]) : 1,
        parent: stack.length ? stack[stack.length - 1].item.id : null,
        isGroup: true,
        isSpace: false,
        columns: null,
        sourceRange: range,
      };
      blocks.push(item);
      stack.push({ item, line: lineIdx });
      continue;
    }
    if (parseStylingLine(trimmed, range, styling)) continue;

    if ((m = EDGE_LABELLED.exec(trimmed))) {
      edges.push({ source: m[1], target: m[3], label: m[2], sourceRange: range });
      continue;
    }
    if ((m = EDGE_PLAIN.exec(trimmed))) {
      edges.push({ source: m[1], target: m[3], label: m[2]?.trim() || null, sourceRange: range });
      continue;
    }

    // A row of blocks.
    const parent = stack.length ? stack[stack.length - 1].item.id : null;
    let i = 0;
    const s = trimmed;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const idm = /^[A-Za-z0-9_]+/.exec(s.slice(i));
      if (!idm) {
        parseIssues.push({ message: `Unexpected text "${s.slice(i)}" in block row.`, severity: 'warning', range });
        break;
      }
      const id = idm[0];
      i += id.length;
      let shapeRaw: string | null = null;
      if (s.startsWith('<[', i)) {
        const end = s.indexOf(']>', i);
        if (end === -1) {
          parseIssues.push({ message: `Unterminated arrow block after "${id}".`, severity: 'error', range });
          break;
        }
        let stop = end + 2;
        if (s[stop] === '(') {
          const close = s.indexOf(')', stop);
          stop = close === -1 ? s.length : close + 1;
        }
        shapeRaw = s.slice(i, stop);
        i = stop;
      } else if (i < s.length && '[({'.includes(s[i])) {
        const end = readGroup(s, i);
        if (end === -1) {
          parseIssues.push({ message: `Unterminated shape brackets after "${id}".`, severity: 'error', range });
          break;
        }
        shapeRaw = s.slice(i, end);
        i = end;
        if (!shapeRaw.includes('"')) {
          parseIssues.push({ message: `Text in the shape of block "${id}" must be in double quotes, e.g. ${id}["label"] (Mermaid rejects unquoted block text).`, severity: 'error', range });
        }
      } else if (s[i] === '>') {
        const end = s.indexOf(']', i);
        if (end === -1) {
          parseIssues.push({ message: `Unterminated asymmetric shape after "${id}".`, severity: 'error', range });
          break;
        }
        shapeRaw = s.slice(i, end + 1);
        i = end + 1;
      }
      let span = 1;
      const sp = /^:(\d+)/.exec(s.slice(i));
      if (sp) {
        span = Number(sp[1]);
        i += sp[0].length;
        if (span < 1) {
          parseIssues.push({ message: `Column span of "${id}" must be at least 1.`, severity: 'error', range });
          span = 1;
        }
      }
      const isSpace = id === 'space' && shapeRaw === null;
      blocks.push({ id, label: shapeRaw ? labelOf(shapeRaw) : null, shapeRaw, span, parent, isGroup: false, isSpace, columns: null, sourceRange: range });
      if (i < s.length && !/\s/.test(s[i])) {
        parseIssues.push({ message: `Unexpected text "${s.slice(i).split(/\s/)[0]}" after block "${id}".`, severity: 'warning', range });
        break;
      }
    }
  }

  for (const open of stack) parseIssues.push({ message: `Group "${open.item.id}" is never closed with "end".`, severity: 'error', range: makeRange(open.line, 0, lines[open.line]?.length ?? 0) });
  if (!headerFound) parseIssues.push({ message: 'No "block-beta" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'block', columns, blocks, edges, styling, comments, frontmatter, parseIssues, sourceText: source };
}
