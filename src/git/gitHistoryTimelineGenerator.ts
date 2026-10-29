/**
 * Turns a flat commit list into Mermaid `timeline` source, grouped by year
 * or by year-month. This is deliberately a pure function taking plain data
 * — no `vscode`, no Git API — so it's unit-testable directly; the one
 * vscode-touching piece (`gitHistoryCommand.ts`) is just "fetch commits,
 * call this, open the result".
 */

export interface GitCommitInput {
  message: string;
  date: Date;
}

export type TimelineGrouping = 'year' | 'month';

export interface TimelineGenerationOptions {
  title: string;
  grouping: TimelineGrouping;
  /** Hard cap on how many events are listed under any single period; extras are summarized rather than silently dropped. */
  maxEventsPerPeriod: number;
}

export const DEFAULT_TIMELINE_OPTIONS: TimelineGenerationOptions = {
  title: 'Project History',
  grouping: 'year',
  maxEventsPerPeriod: 12,
};

function periodKey(date: Date, grouping: TimelineGrouping): string {
  const year = date.getFullYear();
  if (grouping === 'year') return String(year);
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month} ${year}`;
}

/** First line only, trimmed, with any literal "%%" broken up so it can't be misread as a Mermaid comment marker when the generated text is parsed. */
function firstLine(message: string): string {
  return message.split(/\r?\n/)[0].trim().replace(/%%/g, '% %');
}

function sortPeriodKeysChronologically(keys: string[], grouping: TimelineGrouping): string[] {
  if (grouping === 'year') {
    return [...keys].sort((a, b) => Number(a) - Number(b));
  }
  // "Mon YYYY" — parse back into a comparable value rather than sorting the strings lexically (which would misorder months).
  return [...keys].sort((a, b) => Date.parse(`1 ${a}`) - Date.parse(`1 ${b}`));
}

/**
 * Groups commits by period and renders them as Mermaid `timeline` source,
 * with events ordered oldest-first within each period — sorted by the
 * commit's actual date, not by whatever order the caller passed them in
 * (git log conventionally returns newest-first, but this function doesn't
 * assume that or any other input order). Commits with no message text
 * after trimming are skipped rather than emitted as an empty, meaningless
 * event line.
 */
export function generateTimelineFromCommits(commits: GitCommitInput[], options: Partial<TimelineGenerationOptions> = {}): string {
  const opts = { ...DEFAULT_TIMELINE_OPTIONS, ...options };
  const grouped = new Map<string, Array<{ text: string; date: Date }>>();

  for (const commit of commits) {
    const text = firstLine(commit.message);
    if (!text) continue;
    const key = periodKey(commit.date, opts.grouping);
    const list = grouped.get(key) ?? [];
    list.push({ text, date: commit.date });
    grouped.set(key, list);
  }

  const orderedKeys = sortPeriodKeysChronologically([...grouped.keys()], opts.grouping);

  const lines: string[] = ['timeline'];
  if (opts.title) lines.push(`    title ${opts.title}`);

  for (const key of orderedKeys) {
    const chronological = [...grouped.get(key)!].sort((a, b) => a.date.getTime() - b.date.getTime());
    const shown = chronological.slice(0, opts.maxEventsPerPeriod);
    const overflow = chronological.length - shown.length;

    shown.forEach((event, i) => {
      lines.push(i === 0 ? `    ${key} : ${event.text}` : `        : ${event.text}`);
    });
    if (overflow > 0) {
      lines.push(`        : (+${overflow} more)`);
    }
  }

  return lines.join('\n') + '\n';
}
