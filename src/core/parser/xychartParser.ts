import { ParseIssue, XyAxis, XyChartDiagram, XySeries } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, parseNumber, splitTopLevel, stripComment, unquote } from './parserUtils';

/**
 * Parses `xychart` / `xychart-beta [horizontal]`:
 *   title "text"
 *   x-axis ["title"] [a, b, c]          (categories)
 *   x-axis ["title"] 0 --> 100           (numeric range)
 *   y-axis ["title"] [0 --> 100]         (range optional)
 *   bar [1, 2, 3]   line ["name"] [1, 2, 3]
 * Series values must be numbers; non-numeric entries are reported and
 * skipped. Not modelled: per-series colours/themeVariables (frontmatter).
 */
function parseAxisRest(rest: string, lineIdx: number, allowCategories: boolean, issues: ParseIssue[]): XyAxis {
  const range = makeRange(lineIdx, 0, rest.length);
  const axis: XyAxis = { title: null, categories: null, range: null, sourceRange: range };
  const bracket = rest.indexOf('[');
  if (bracket !== -1) {
    const close = rest.lastIndexOf(']');
    const head = rest.slice(0, bracket).trim();
    if (head) axis.title = unquote(head);
    if (close <= bracket) {
      issues.push({ message: 'Unterminated "[" in axis definition.', severity: 'error', range });
      return axis;
    }
    if (!allowCategories) {
      issues.push({ message: 'The y-axis takes a numeric range ("min --> max"), not a category list.', severity: 'warning', range });
      return axis;
    }
    axis.categories = splitTopLevel(rest.slice(bracket + 1, close)).map((c) => unquote(c)).filter((c) => c.length > 0);
    return axis;
  }
  const m = /^(?:(.*?)\s+)?([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*-->\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*$/.exec(rest.trim());
  if (m) {
    const min = parseNumber(m[2]);
    const max = parseNumber(m[3]);
    if (m[1]) axis.title = unquote(m[1]);
    if (min !== null && max !== null) axis.range = { min, max };
    else issues.push({ message: `Axis range "${m[2]} --> ${m[3]}" is not numeric.`, severity: 'error', range });
    return axis;
  }
  if (rest.trim()) axis.title = unquote(rest);
  return axis;
}

export function parseXyChartDiagram(source: string): XyChartDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: XyChartDiagram['comments'] = [];
  const series: XySeries[] = [];
  let title: string | null = null;
  let xAxis: XyAxis | null = null;
  let yAxis: XyAxis | null = null;
  let horizontal = false;
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      const h = /^xychart(-beta)?\b\s*(.*)$/i.exec(trimmed);
      if (h) {
        headerFound = true;
        if (/^horizontal\b/i.test(h[2])) horizontal = true;
        else if (h[2].trim()) parseIssues.push({ message: `Unexpected text after the xychart header: "${h[2].trim()}"`, severity: 'warning', range });
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected an "xychart-beta" header before diagram content.', severity: 'error', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/i.exec(trimmed))) {
      title = unquote(m[1]);
    } else if ((m = /^x-axis\s+(.*)$/i.exec(trimmed))) {
      xAxis = parseAxisRest(m[1], lineIdx, true, parseIssues);
    } else if ((m = /^y-axis\s+(.*)$/i.exec(trimmed))) {
      yAxis = parseAxisRest(m[1], lineIdx, false, parseIssues);
    } else if ((m = /^(bar|line)\s*(?:("[^"]*"|[^\[\s][^\[]*?)\s*)?\[(.*)\]\s*$/i.exec(trimmed))) {
      const values: number[] = [];
      for (const part of splitTopLevel(m[3])) {
        if (!part.trim()) continue;
        const v = parseNumber(part);
        if (v === null) parseIssues.push({ message: `${m[1]} series value "${part.trim()}" is not a number.`, severity: 'error', range });
        else values.push(v);
      }
      series.push({ type: m[1].toLowerCase() as 'bar' | 'line', title: m[2] ? unquote(m[2]) : null, values, sourceRange: range });
    } else {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
    }
  }

  if (!headerFound) parseIssues.push({ message: 'No "xychart-beta" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'xychart', horizontal, title, xAxis, yAxis, series, comments, frontmatter, parseIssues, sourceText: source };
}
