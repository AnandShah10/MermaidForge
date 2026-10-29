import { ParseIssue, PieDiagram, SourceRange } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/**
 * Parses `pie` Mermaid source: an optional `showData` flag and `title`
 * (either on the header line or its own `title` line), followed by
 * `"label" : value` slices. This is Mermaid's simplest diagram grammar, so
 * unlike the other structural parsers there's very little scope to bound —
 * the one thing worth noting is that slice values are parsed as-is (no
 * percentage normalization; Mermaid itself computes proportions from
 * whatever numbers you give it, and so does the complexity/lint layer here).
 */
export function parsePieDiagram(source: string): PieDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const slices: PieDiagram['slices'] = [];
  const comments: PieDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let title: string | null = null;
  let showData = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      const headerMatch = /^pie\b(.*)$/i.exec(trimmed);
      if (headerMatch) {
        headerFound = true;
        const rest = headerMatch[1].trim();
        if (/^showData\b/i.test(rest)) {
          showData = true;
          const afterShowData = rest.replace(/^showData\b/i, '').trim();
          const titleMatch = /^title\s+(.*)$/i.exec(afterShowData);
          if (titleMatch) title = titleMatch[1].trim();
        } else {
          const titleMatch = /^title\s+(.*)$/i.exec(rest);
          if (titleMatch) title = titleMatch[1].trim();
        }
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "pie" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    if (/^showData\b/i.test(trimmed)) {
      showData = true;
      continue;
    }

    const titleLineMatch = /^title\s+(.*)$/i.exec(trimmed);
    if (titleLineMatch) {
      title = titleLineMatch[1].trim();
      continue;
    }

    const sliceMatch = /^"([^"]*)"\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(trimmed);
    if (sliceMatch) {
      const value = parseFloat(sliceMatch[2]);
      slices.push({ label: sliceMatch[1], value, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "pie" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'pie', title, showData, slices, comments, frontmatter, parseIssues, sourceText: source };
}
