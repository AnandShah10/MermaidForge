import { JourneyDiagram, ParseIssue, SourceRange } from '../diagram/types';
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
 * Parses `journey` (user journey) Mermaid source: an optional `title` line,
 * `section <name>` headers, and task lines of the form
 * `<Task name>: <score>: <Actor1>, <Actor2>`. Task names are not required to
 * be unique (the same task label can legitimately appear in two different
 * sections, or even twice in one — Mermaid doesn't treat them as ids), so
 * each parsed task gets a synthetic `id` rather than being keyed by name;
 * linting for duplicates works off (section, name) pairs instead — see
 * lintJourneyDiagram in linter.ts.
 */
export function parseJourneyDiagram(source: string): JourneyDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const sections: JourneyDiagram['sections'] = [];
  const tasks: JourneyDiagram['tasks'] = [];
  const comments: JourneyDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let title: string | null = null;
  let currentSection: string | null = null;
  let taskCounter = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^journey\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "journey" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
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
      continue;
    }

    const taskMatch = /^(.+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*:\s*(.+)$/.exec(trimmed);
    if (taskMatch) {
      const [, name, scoreRaw, actorsRaw] = taskMatch;
      const actors = actorsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      tasks.push({
        id: `task_${++taskCounter}`,
        name: name.trim(),
        score: parseFloat(scoreRaw),
        actors,
        section: currentSection,
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      });
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "journey" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'journey', title, sections, tasks, comments, frontmatter, parseIssues, sourceText: source };
}
