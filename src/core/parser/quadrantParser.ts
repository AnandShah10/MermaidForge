import { ParseIssue, QuadrantAxis, QuadrantDiagram, QuadrantPoint } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, parseNumber, stripComment, unquote } from './parserUtils';

/**
 * Parses `quadrantChart`: `title`, `x-axis low --> high` (the `--> high` part
 * is optional), `y-axis`, `quadrant-1..4 text`, `classDef name styles`, and
 * points `Name: [x, y]` — optionally `Name:::className: [x, y]` and/or
 * trailing inline style (`radius: 12, color: #f00`), kept as raw text.
 * Coordinates are parsed strictly as numbers but NOT range-checked here;
 * the 0..1 requirement is a lint rule so the diagram still parses.
 * Not modelled: themeVariables / quadrant config (frontmatter, preserved).
 */
const POINT = /^(.+?)(?::::([\w-]+))?\s*:\s*\[\s*([^,\]]*?)\s*,\s*([^\]]*?)\s*\]\s*(.*)$/;

function parseAxis(rest: string): QuadrantAxis {
  const idx = rest.indexOf('-->');
  if (idx === -1) return { low: unquote(rest) || null, high: null };
  return { low: unquote(rest.slice(0, idx)) || null, high: unquote(rest.slice(idx + 3)) || null };
}

export function parseQuadrantDiagram(source: string): QuadrantDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: QuadrantDiagram['comments'] = [];
  const points: QuadrantPoint[] = [];
  const classDefs = new Map<string, string>();
  const quadrants: Array<string | null> = [null, null, null, null];
  let title: string | null = null;
  let xAxis: QuadrantAxis | null = null;
  let yAxis: QuadrantAxis | null = null;
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      if (/^quadrantChart\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "quadrantChart" header before diagram content.', severity: 'error', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/i.exec(trimmed))) {
      title = unquote(m[1]);
    } else if ((m = /^x-axis\s+(.*)$/i.exec(trimmed))) {
      xAxis = parseAxis(m[1]);
    } else if ((m = /^y-axis\s+(.*)$/i.exec(trimmed))) {
      yAxis = parseAxis(m[1]);
    } else if ((m = /^quadrant-([1-4])\s+(.*)$/i.exec(trimmed))) {
      quadrants[Number(m[1]) - 1] = unquote(m[2]);
    } else if ((m = /^classDef\s+([\w-]+)\s+(.*)$/i.exec(trimmed))) {
      classDefs.set(m[1], m[2].trim());
    } else if ((m = POINT.exec(trimmed))) {
      const x = parseNumber(m[3]);
      const y = parseNumber(m[4]);
      const name = unquote(m[1]);
      if (x === null || y === null) {
        parseIssues.push({ message: `Point "${name}" has non-numeric coordinates [${m[3]}, ${m[4]}].`, severity: 'error', range });
      }
      points.push({ name, x, y, className: m[2] ?? null, styleRaw: m[5].trim() || null, sourceRange: range });
    } else {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
    }
  }

  if (!headerFound) parseIssues.push({ message: 'No "quadrantChart" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'quadrantChart', title, xAxis, yAxis, quadrants, points, classDefs, comments, frontmatter, parseIssues, sourceText: source };
}
