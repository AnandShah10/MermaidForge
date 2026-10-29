import { GanttDiagram, GanttTask } from '../diagram/types';

/**
 * Calendar interpretation of a parsed gantt diagram: turns each task's raw
 * start/duration tokens into concrete start and end instants, the way
 * Mermaid does, so the linter can find invalid dates, reversed ranges and
 * dependency cycles, and diff/complexity can see rescheduling.
 *
 * Scope, stated plainly:
 *  - `dateFormat` tokens supported: YYYY YY MM M DD D HH H mm m ss s SSS X x
 *    plus literal separators. Anything else (`Do`, month/day names, `A`,
 *    time zones) makes the whole schedule "unavailable" — no dates are
 *    computed and no date-based diagnostics are produced, rather than
 *    guessing. The default format is Mermaid's `YYYY-MM-DD`.
 *  - All instants are treated as UTC; Mermaid renders in local time, which
 *    only matters for sub-day durations across a DST change.
 *  - Durations: ms s m h d w M y. `M`/`y` add calendar months/years.
 *  - `excludes`: `weekends`, day names, and `YYYY-MM-DD` dates. As in
 *    Mermaid, a task whose end was given as a duration is stretched over
 *    excluded days (each excluded day inside the span pushes the end out by
 *    one day); an explicit end date is left alone. `includes` and
 *    `weekend friday` are honoured for the weekend choice only.
 *  - A task with no start (`Task :3d`) starts when the previous task in
 *    the file ends; the very first such task has no known start and is left
 *    unscheduled (Mermaid would use "now").
 *  - `after a b` starts at the latest end of its references; `until id`
 *    ends at the start of that task.
 */
export interface ScheduledTask {
  task: GanttTask;
  index: number;
  start: number | null;
  end: number | null;
  /** True when the end came from an explicit date rather than a duration. */
  explicitEnd: boolean;
}

export interface GanttScheduleIssue {
  /**
   * invalidStart: Mermaid throws "Invalid date" and renders nothing.
   * invalidEnd: Mermaid draws a zero-length bar. endBeforeStart: negative-width bar.
   * rolledDate: accepted but shifted into the next month. cycle: bars get NaN positions.
   */
  kind: 'invalidStart' | 'invalidEnd' | 'rolledDate' | 'endBeforeStart' | 'cycle';
  taskIndex: number;
  message: string;
}

export interface GanttSchedule {
  /** False when dateFormat uses tokens this module does not interpret. */
  available: boolean;
  unavailableReason: string | null;
  format: string;
  tasks: ScheduledTask[];
  issues: GanttScheduleIssue[];
}

const DAY = 86_400_000;
const TOKEN_RE = /YYYY|YY|SSS|MM|DD|HH|mm|ss|M|D|H|m|s|X|x/g;
const SUPPORTED_LITERAL = /^[\s\-/.:,T_]*$/;
const UNSUPPORTED_TOKEN = /Do|MMM|ddd|dd|d|A|a|Z|ZZ|h|hh|k|kk|Q|W|w|E|e|G|g/;

interface FormatPlan {
  regex: RegExp;
  fields: string[];
}

export function compileDateFormat(format: string): FormatPlan | null {
  // Reject unsupported tokens: strip supported ones and see what letters remain.
  const leftover = format.replace(TOKEN_RE, '');
  if (!SUPPORTED_LITERAL.test(leftover) && /[A-Za-z]/.test(leftover.replace(/T/g, ''))) return null;
  if (UNSUPPORTED_TOKEN.test(leftover)) return null;
  const fields: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of format.matchAll(TOKEN_RE)) {
    pattern += escapeLiteral(format.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    fields.push(m[0]);
    pattern += m[0] === 'YYYY' ? '(\\d{4})' : m[0] === 'X' ? '(\\d{1,10})' : m[0] === 'x' ? '(\\d{1,13})' : m[0] === 'SSS' ? '(\\d{3})' : m[0].length === 2 ? '(\\d{2})' : '(\\d{1,2})';
  }
  pattern += escapeLiteral(format.slice(last));
  return fields.length ? { regex: new RegExp(`^${pattern}$`), fields } : null;
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

export function parseDateWith(plan: FormatPlan, text: string): number | null {
  return parseDateDetailed(plan, text)?.t ?? null;
}

/**
 * Like Mermaid (dayjs, non-strict): month must be 1-12 and day 1-31, but a day
 * the month doesn't have (2024-02-31) is accepted and rolls into the next
 * month. `rolled` reports that case.
 */
export function parseDateDetailed(plan: FormatPlan, text: string): { t: number; rolled: boolean } | null {
  const m = plan.regex.exec(text.trim());
  if (!m) return null;
  let y = 1970, mo = 1, d = 1, h = 0, mi = 0, s = 0, ms = 0;
  for (let i = 0; i < plan.fields.length; i++) {
    const v = Number(m[i + 1]);
    switch (plan.fields[i]) {
      case 'YYYY': y = v; break;
      case 'YY': y = v + (v >= 70 ? 1900 : 2000); break;
      case 'MM': case 'M': mo = v; break;
      case 'DD': case 'D': d = v; break;
      case 'HH': case 'H': h = v; break;
      case 'mm': case 'm': mi = v; break;
      case 'ss': case 's': s = v; break;
      case 'SSS': ms = v; break;
      case 'X': return { t: v * 1000, rolled: false };
      case 'x': return { t: v, rolled: false };
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  return { t, rolled: back.getUTCMonth() !== mo - 1 };
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|M|y)$/;

export function isDuration(token: string): boolean {
  return DURATION_RE.test(token.trim());
}

function addDuration(start: number, token: string): number | null {
  const m = DURATION_RE.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return start + n;
    case 's': return start + n * 1000;
    case 'm': return start + n * 60_000;
    case 'h': return start + n * 3_600_000;
    case 'd': return start + n * DAY;
    case 'w': return start + n * 7 * DAY;
    case 'M': case 'y': {
      // Calendar arithmetic like dayjs: the day-of-month is clamped (Jan 31 + 1M = Feb 29, not Mar 2).
      const months = m[2] === 'y' ? n * 12 : n;
      const whole = Math.trunc(months);
      const d = new Date(start);
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + whole);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return d.getTime() + (months - whole) * 30 * DAY;
    }
  }
  return null;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function excludedChecker(diagram: GanttDiagram, plan: FormatPlan): (t: number) => boolean {
  const days = new Set<number>();
  const dates = new Set<number>();
  const weekend = diagram.weekend === 'friday' ? [5, 6] : [6, 0];
  for (const raw of diagram.excludes) {
    for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
      const lower = part.toLowerCase();
      if (lower === 'weekends' || lower === 'weekend') weekend.forEach((d) => days.add(d));
      else if (DAY_NAMES.includes(lower)) days.add(DAY_NAMES.indexOf(lower));
      else {
        const t = parseDateWith(plan, part) ?? parseDateWith(compileDateFormat('YYYY-MM-DD')!, part);
        if (t !== null) dates.add(Math.floor(t / DAY));
      }
    }
  }
  return (t) => days.has(new Date(t).getUTCDay()) || dates.has(Math.floor(t / DAY));
}

export function computeGanttSchedule(diagram: GanttDiagram): GanttSchedule {
  const format = diagram.dateFormat ?? 'YYYY-MM-DD';
  const plan = compileDateFormat(format);
  const empty: GanttSchedule = { available: false, unavailableReason: null, format, tasks: [], issues: [] };
  if (!plan) {
    return { ...empty, unavailableReason: `dateFormat "${format}" uses tokens that are not interpreted (supported: YYYY YY MM M DD D HH H mm m ss s SSS X x).` };
  }
  const isExcluded = excludedChecker(diagram, plan);
  const tasks: ScheduledTask[] = diagram.tasks.map((task, index) => ({ task, index, start: null, end: null, explicitEnd: false }));
  const issues: GanttScheduleIssue[] = [];
  const byId = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (t.task.id && !byId.has(t.task.id)) byId.set(t.task.id, i);
  });

  const state = new Map<number, 'busy' | 'done'>();
  const cycleReported = new Set<number>();

  const resolve = (i: number): void => {
    if (state.get(i) === 'done') return;
    if (state.get(i) === 'busy') return;
    state.set(i, 'busy');
    const st = tasks[i];
    const t = st.task;

    // ---- start
    let start: number | null = null;
    let startKnown = true;
    if (t.afterIds.length) {
      for (const ref of t.afterIds) {
        const j = byId.get(ref);
        if (j === undefined) { startKnown = false; continue; }
        if (state.get(j) === 'busy') {
          startKnown = false;
          if (!cycleReported.has(i)) {
            cycleReported.add(i);
            issues.push({ kind: 'cycle', taskIndex: i, message: `Task "${t.name}" is part of an "after" dependency cycle (via "${ref}"); Mermaid cannot place these bars (NaN positions).` });
          }
          continue;
        }
        resolve(j);
        const e = tasks[j].end;
        if (e === null) startKnown = false;
        else start = start === null ? e : Math.max(start, e);
      }
      if (!startKnown) start = null;
    } else if (t.startRaw !== null) {
      const parsed = parseDateDetailed(plan, t.startRaw);
      start = parsed?.t ?? null;
      if (!parsed) {
        issues.push({ kind: 'invalidStart', taskIndex: i, message: `Task "${t.name}" has start "${t.startRaw}", which is not a valid date for dateFormat ${format}; Mermaid fails to render the whole chart ("Invalid date").` });
      } else if (parsed.rolled) {
        issues.push({ kind: 'rolledDate', taskIndex: i, message: `Task "${t.name}" starts on "${t.startRaw}", which is not a real calendar day; Mermaid silently moves it to ${fmt(parsed.t)}.` });
      }
    } else if (i > 0) {
      resolve(i - 1);
      start = tasks[i - 1].end;
    }

    // ---- end
    let end: number | null = null;
    let explicitEnd = false;
    const raw = t.durationRaw?.trim() ?? null;
    if (raw !== null) {
      const until = /^until\s+(\S+)$/i.exec(raw);
      if (until) {
        const j = byId.get(until[1]);
        if (j !== undefined && state.get(j) !== 'busy') {
          resolve(j);
          end = tasks[j].start;
          explicitEnd = true;
        }
      } else if (isDuration(raw)) {
        if (start !== null) {
          end = addDuration(start, raw);
          if (end !== null && /^(?:\d+(?:\.\d+)?)(d|w|M|y)$/.test(raw)) end = stretchOverExcluded(start, end, isExcluded);
        }
      } else {
        const parsed = parseDateDetailed(plan, raw);
        end = parsed?.t ?? null;
        explicitEnd = true;
        if (!parsed) issues.push({ kind: 'invalidEnd', taskIndex: i, message: `Task "${t.name}" has end/duration "${raw}", which is neither a duration (e.g. 5d) nor a date matching ${format}; Mermaid draws it as a zero-length bar.` });
        else if (parsed.rolled) issues.push({ kind: 'rolledDate', taskIndex: i, message: `Task "${t.name}" ends on "${raw}", which is not a real calendar day; Mermaid silently moves it to ${fmt(parsed.t)}.` });
      }
    }
    if (start !== null && end !== null && explicitEnd && end < start) {
      issues.push({ kind: 'endBeforeStart', taskIndex: i, message: `Task "${t.name}" ends (${fmt(end)}) before it starts (${fmt(start)}).` });
    }
    st.start = start;
    st.end = end;
    st.explicitEnd = explicitEnd;
    state.set(i, 'done');
  };

  for (let i = 0; i < tasks.length; i++) resolve(i);
  return { available: true, unavailableReason: null, format, tasks, issues };
}

/** Mermaid's rule: every excluded day inside [start, end] pushes the end out by one day. */
function stretchOverExcluded(start: number, end: number, isExcluded: (t: number) => boolean): number {
  let cursor = start;
  let stretchedEnd = end;
  let guard = 0;
  while (cursor <= stretchedEnd && guard++ < 20_000) {
    if (isExcluded(cursor)) stretchedEnd += DAY;
    cursor += DAY;
  }
  return stretchedEnd;
}

export function fmt(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
