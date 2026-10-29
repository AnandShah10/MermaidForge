import { ParseIssue, SourceRange, TimelineDiagram, TimelinePeriod, TimelineSection } from '../diagram/types';
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
 * Parses `timeline` Mermaid source: an optional `title`, `section` headers,
 * and `<period> : <event>` lines. A line that starts with just `:` (no
 * period text before it) continues the *previous* period with an additional
 * event, exactly like Mermaid itself interprets it:
 *
 *   2026 : Authentication
 *        : Dashboard
 *
 * Both lines belong to period "2026" — "Dashboard" is a second event under
 * the same period, not a new period named "". A continuation line with
 * nothing preceding it is only valid after at least one period has been
 * opened; one appearing first is recorded as a parse issue rather than
 * silently dropped or guessed at.
 */
export function parseTimelineDiagram(source: string): TimelineDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const sections: TimelineSection[] = [];
  const periods: TimelinePeriod[] = [];
  const comments: TimelineDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let title: string | null = null;
  let currentSection: string | null = null;
  let lastPeriod: TimelinePeriod | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^timeline\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "timeline" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    const titleMatch = /^title\s+(.*)$/i.exec(trimmed);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const sectionMatch = /^section\s+(.*)$/i.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections.push({ name: currentSection, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      lastPeriod = null; // a new section starts a fresh period context
      continue;
    }

    // Continuation line: starts with ':' — adds another event to the last period.
    const continuationMatch = /^:\s*(.*)$/.exec(trimmed);
    if (continuationMatch) {
      if (!lastPeriod) {
        parseIssues.push({ message: 'A continuation line (starting with ":") appeared with no preceding period to attach it to.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      lastPeriod.events.push(continuationMatch[1].trim());
      continue;
    }

    // Period line: "<period text> : <event>" — the period may itself contain
    // spaces (e.g. "2026 Q1"), so split on the LAST colon-with-surrounding-text
    // pattern isn't safe either; Mermaid's own grammar takes everything before
    // the first top-level ":" as the period. We do the same.
    const periodMatch = /^([^:]+?)\s*:\s*(.*)$/.exec(trimmed);
    if (periodMatch) {
      const period: TimelinePeriod = {
        period: periodMatch[1].trim(),
        events: [periodMatch[2].trim()],
        section: currentSection,
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      };
      periods.push(period);
      lastPeriod = period;
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "timeline" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'timeline', title, sections, periods, comments, frontmatter, parseIssues, sourceText: source };
}
