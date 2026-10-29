import { GanttDiagram, GanttSection, GanttStatus, GanttTask, ParseIssue, SourceRange } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

const STATUS_KEYWORDS: GanttStatus[] = ['done', 'active', 'crit', 'milestone'];
const AFTER_PATTERN = /^after\s+(.+)$/i;

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/**
 * Parses `gantt` Mermaid source: `title`, `dateFormat`, `section` headers,
 * and task lines (`<name> : <fields>`). This is deliberately the most
 * scope-limited structural parser in the project, because gantt's field
 * grammar is genuinely the least regular one Mermaid has:
 *
 *  - This parser keeps task fields as the raw tokens the line contained
 *    (`startRaw`, `afterIds`, `durationRaw`) and records `dateFormat`,
 *    `excludes` and `weekend`. Turning them into calendar dates is done by
 *    core/gantt/ganttSchedule.ts, which the linter, diff and complexity
 *    features use.
 *  - Status keywords (`done`, `active`, `crit`, `milestone`) are
 *    recognized as a set at the front of the field list; anything else
 *    that isn't a recognized field shape falls back to being treated as
 *    part of the start/duration fields rather than a parse error, since
 *    Mermaid's own grammar here has more edge cases (vacation/exclude
 *    modifiers, `active` combined with other flags, etc.) than are worth
 *    chasing individually.
 *  - `axisFormat`, `todayMarker`, `tickInterval` and similar directives are
 *    recognized (so they don't show up as "unrecognized statement") but not
 *    modeled — they affect rendering only, not task structure.
 */
export function parseGanttDiagram(source: string): GanttDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const sections: GanttSection[] = [];
  const tasks: GanttTask[] = [];
  const comments: GanttDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let title: string | null = null;
  let dateFormat: string | null = null;
  const excludes: string[] = [];
  let weekend: 'friday' | null = null;
  let currentSection: string | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^gantt\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "gantt" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    const titleMatch = /^title\s+(.*)$/i.exec(trimmed);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const dateFormatMatch = /^dateFormat\s+(.*)$/i.exec(trimmed);
    if (dateFormatMatch) {
      dateFormat = dateFormatMatch[1].trim();
      continue;
    }

    const excludesMatch = /^excludes\s+(.*)$/i.exec(trimmed);
    if (excludesMatch) {
      excludes.push(excludesMatch[1].trim());
      continue;
    }
    const weekendMatch = /^weekend\s+(friday|saturday)\s*$/i.exec(trimmed);
    if (weekendMatch) {
      weekend = weekendMatch[1].toLowerCase() === 'friday' ? 'friday' : null;
      continue;
    }
    if (/^(axisFormat|todayMarker|tickInterval|weekday|inclusiveEndDates|topAxis|includes)\b/i.test(trimmed)) {
      continue; // rendering-only directives — acknowledged, not modeled
    }

    const sectionMatch = /^section\s+(.*)$/i.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections.push({ name: currentSection, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    const name = trimmed.slice(0, colonIdx).trim();
    const fieldsRaw = trimmed.slice(colonIdx + 1).trim();
    if (!name || !fieldsRaw) {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      continue;
    }

    const fields = fieldsRaw.split(',').map((f) => f.trim()).filter((f) => f.length > 0);
    const statuses: GanttStatus[] = [];
    while (fields.length > 0 && STATUS_KEYWORDS.includes(fields[0].toLowerCase() as GanttStatus)) {
      statuses.push(fields.shift()!.toLowerCase() as GanttStatus);
    }

    let id: string | null = null;
    let startRaw: string | null = null;
    let afterIds: string[] = [];
    let durationRaw: string | null = null;

    if (fields.length === 1) {
      durationRaw = fields[0];
    } else if (fields.length === 2) {
      const [f0, f1] = fields;
      const afterMatch = AFTER_PATTERN.exec(f0);
      if (afterMatch) afterIds = afterMatch[1].trim().split(/\s+/);
      else startRaw = f0;
      durationRaw = f1;
    } else if (fields.length >= 3) {
      if (fields.length > 3) {
        parseIssues.push({ message: `Task "${name}" has more fields than expected; extra fields after the third are ignored.`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      const [f0, f1, f2] = fields;
      id = f0;
      const afterMatch = AFTER_PATTERN.exec(f1);
      if (afterMatch) afterIds = afterMatch[1].trim().split(/\s+/);
      else startRaw = f1;
      durationRaw = f2;
    }

    tasks.push({
      name,
      id,
      statuses,
      startRaw,
      afterIds,
      durationRaw,
      section: currentSection,
      sourceRange: makeRange(lineIdx, 0, trimmed.length),
    });
  }

  // Unknown "after" references — checked once the whole task list is known,
  // since referencing a task defined later in the file is unusual but not
  // worth hard-blocking on ordering grounds alone.
  const knownIds = new Set(tasks.map((t) => t.id).filter((id): id is string => id !== null));
  for (const task of tasks) {
    for (const afterId of task.afterIds) {
      if (!knownIds.has(afterId)) {
        parseIssues.push({
          message: `Task "${task.name}" starts "after ${afterId}", but no task with id "${afterId}" was found.`,
          severity: 'error',
          range: task.sourceRange ?? makeRange(0, 0, 0),
        });
      }
    }
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "gantt" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'gantt', title, dateFormat, excludes, weekend, sections, tasks, comments, frontmatter, parseIssues, sourceText: source };
}
