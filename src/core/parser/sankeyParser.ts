import { ParseIssue, SankeyDiagram, SankeyLink } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, parseNumber, stripComment } from './parserUtils';

/**
 * Parses `sankey` / `sankey-beta`: one CSV record per line,
 * `source,target,value`. Fields may be double-quoted (a `""` inside quotes is
 * a literal quote, a comma inside quotes is data). Blank lines are skipped.
 * Not modelled: Mermaid's sankey config (link colouring, node alignment) —
 * that lives in frontmatter/directives and is preserved verbatim, not parsed.
 * A header row of exactly `source,target,value` is tolerated and ignored.
 */
export function splitCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  for (;;) {
    cur = '';
    // Skip leading spaces, then read either a quoted or a bare field.
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) return null; // unterminated quote
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cur += line[i++];
      }
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (i < n && line[i] !== ',') return null; // junk after closing quote
    } else {
      while (i < n && line[i] !== ',') cur += line[i++];
      cur = cur.trim();
    }
    fields.push(cur);
    if (i >= n) break;
    i++; // consume comma
    if (i >= n) {
      fields.push('');
      break;
    }
  }
  return fields;
}

export function parseSankeyDiagram(source: string): SankeyDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const links: SankeyLink[] = [];
  const nodes: string[] = [];
  const seenNodes = new Set<string>();
  const comments: SankeyDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;

    if (!headerFound) {
      if (/^sankey(-beta)?\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "sankey-beta" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    const range = makeRange(lineIdx, 0, rawLine.length);
    const fields = splitCsvLine(trimmed);
    if (!fields) {
      parseIssues.push({ message: `Malformed CSV line (unterminated or misplaced quote): "${trimmed}"`, severity: 'error', range });
      continue;
    }
    if (fields.length === 3 && fields[0].toLowerCase() === 'source' && fields[1].toLowerCase() === 'target' && fields[2].toLowerCase() === 'value') continue;
    if (fields.length !== 3) {
      parseIssues.push({ message: `Expected "source,target,value" (3 fields) but found ${fields.length}.`, severity: 'error', range });
      continue;
    }
    const [src, tgt, rawValue] = fields;
    if (!src || !tgt) {
      parseIssues.push({ message: 'Sankey source and target names must not be empty.', severity: 'error', range });
      continue;
    }
    const value = parseNumber(rawValue);
    if (value === null) parseIssues.push({ message: `Sankey value "${rawValue}" is not a number.`, severity: 'error', range });
    links.push({ source: src, target: tgt, value, valueRaw: rawValue, sourceRange: range });
    for (const name of [src, tgt]) {
      if (!seenNodes.has(name)) {
        seenNodes.add(name);
        nodes.push(name);
      }
    }
  }

  if (!headerFound) parseIssues.push({ message: 'No "sankey-beta" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'sankey', links, nodes, comments, frontmatter, parseIssues, sourceText: source };
}
