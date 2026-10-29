import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { computeGanttSchedule, compileDateFormat, parseDateWith, fmt } from '../src/core/gantt/ganttSchedule';
import { lintDiagram } from '../src/core/linter/linter';
import { diffDiagrams } from '../src/core/diff/semanticDiff';
import { analyzeComplexity } from '../src/core/complexity/complexity';

const sched = (src: string) => computeGanttSchedule(parseMermaid(src) as any);
const when = (s: ReturnType<typeof sched>, i: number) => `${s.tasks[i].start === null ? '?' : fmt(s.tasks[i].start!)}..${s.tasks[i].end === null ? '?' : fmt(s.tasks[i].end!)}`;
const rules = (src: string) => lintDiagram(parseMermaid(src)).map((d) => d.ruleId);

describe('date formats', () => {
  it('parses supported tokens and rejects impossible dates', () => {
    const f = compileDateFormat('YYYY-MM-DD')!;
    expect(fmt(parseDateWith(f, '2024-02-29')!)).toBe('2024-02-29');
    expect(parseDateWith(f, '2024-13-01')).toBeNull();
    expect(parseDateWith(f, '2024-01-32')).toBeNull();
    expect(parseDateWith(f, '2024-00-10')).toBeNull();
    // Mermaid (non-strict dayjs) accepts days the month lacks and rolls them over
    expect(fmt(parseDateWith(f, '2024-02-31')!)).toBe('2024-03-02');
    expect(parseDateWith(f, '24-01-01')).toBeNull();
    expect(fmt(parseDateWith(compileDateFormat('DD/MM/YYYY HH:mm')!, '05/03/2024 14:30')!)).toBe('2024-03-05 14:30');
    expect(parseDateWith(compileDateFormat('X')!, '86400')).toBe(86_400_000);
  });
  it('declines formats it cannot interpret', () => {
    expect(compileDateFormat('Do MMM YYYY')).toBeNull();
    expect(sched('gantt\ndateFormat Do MMM YYYY\nt :a, 1st Jan 2024, 3d').available).toBe(false);
  });
});

describe('schedule', () => {
  const src = `gantt
dateFormat YYYY-MM-DD
section A
Design :d, 2024-01-01, 5d
Build :b, after d, 2w
Ship :s, after b, 2024-02-01
Review :3d
Parallel :p, 2024-01-02, until b`;
  it('computes starts and ends from dates, durations, after, previous-task and until', () => {
    const s = sched(src);
    expect(s.available).toBe(true);
    expect(when(s, 0)).toBe('2024-01-01..2024-01-06');
    expect(when(s, 1)).toBe('2024-01-06..2024-01-20');
    expect(when(s, 2)).toBe('2024-01-20..2024-02-01');
    expect(when(s, 3)).toBe('2024-02-01..2024-02-04');
    expect(when(s, 4)).toBe('2024-01-02..2024-01-06');
    expect(s.issues).toEqual([]);
  });
  it('the first task with only a duration has no known start (Mermaid would use "now")', () => {
    const s = sched('gantt\nt :3d');
    expect(s.tasks[0].start).toBeNull();
    expect(s.issues).toEqual([]);
  });
  it('after multiple ids uses the latest end', () => {
    const s = sched('gantt\na :a, 2024-01-01, 2d\nb :b, 2024-01-01, 10d\nc :c, after a b, 1d');
    expect(when(s, 2)).toBe('2024-01-11..2024-01-12');
  });
  it('month and year durations are calendar based', () => {
    const s = sched('gantt\nt :a, 2024-01-31, 1M\nu :b, 2024-01-01, 1y');
    expect(fmt(s.tasks[1].end!)).toBe('2025-01-01');
    expect(fmt(s.tasks[0].end!)).toBe('2024-02-29'); // Jan 31 + 1M clamps to the end of February
  });
});

describe('excludes', () => {
  it('weekends stretch a duration over Saturday and Sunday (Mermaid rule)', () => {
    // 2024-01-05 is a Friday; 3d would end Monday 2024-01-08 without excludes.
    const plain = sched('gantt\nt :a, 2024-01-05, 3d');
    expect(fmt(plain.tasks[0].end!)).toBe('2024-01-08');
    const ex = sched('gantt\nexcludes weekends\nt :a, 2024-01-05, 3d');
    expect(fmt(ex.tasks[0].end!)).toBe('2024-01-10');
  });
  it('explicit end dates are not stretched; specific dates and weekend friday are honoured', () => {
    expect(fmt(sched('gantt\nexcludes weekends\nt :a, 2024-01-05, 2024-01-08').tasks[0].end!)).toBe('2024-01-08');
    expect(fmt(sched('gantt\nexcludes 2024-01-02\nt :a, 2024-01-01, 3d').tasks[0].end!)).toBe('2024-01-05');
    // weekend friday: Fri/Sat excluded, so starting Thu 2024-01-04 with 3d runs over both
    expect(fmt(sched('gantt\nweekend friday\nexcludes weekends\nt :a, 2024-01-04, 3d').tasks[0].end!)).toBe('2024-01-09');
  });
});

describe('lint rules', () => {
  it('invalid start is an error; invalid end/duration and rolled dates are warnings', () => {
    const find = (src: string, id: string) => lintDiagram(parseMermaid(src)).find((d) => d.ruleId === id);
    expect(find('gantt\nt :a, 2024-13-01, 3d', 'ganttInvalidDate')?.severity).toBe('error');
    expect(find('gantt\nt :r, 3d', 'ganttInvalidDate')?.severity).toBe('error'); // two fields: first is the START
    expect(find('gantt\nt :a, 2024-01-01, soon', 'ganttInvalidDuration')?.severity).toBe('warning');
    expect(find('gantt\nt :a, 2024-02-31, 3d', 'ganttRolledDate')?.severity).toBe('warning');
    expect(rules('gantt\nt :a, 2024-01-01, 3d')).toEqual([]);
  });
  it('end before start', () => {
    expect(rules('gantt\nt :a, 2024-02-01, 2024-01-01')).toContain('ganttEndBeforeStart');
  });
  it('dependency cycles', () => {
    expect(rules('gantt\na :a, after b, 1d\nb :b, after a, 1d')).toContain('ganttDependencyCycle');
    expect(rules('gantt\na :a, 2024-01-01, 1d\nb :b, after a, 1d')).not.toContain('ganttDependencyCycle');
  });
  it('is silent about dates when the format is not interpretable', () => {
    const r = rules('gantt\ndateFormat Do MMM YYYY\nt :a, 1st Jan 2024, 3d');
    expect(r.filter((x) => x.startsWith('gantt'))).toEqual([]);
  });
});

describe('diff and complexity on gantt', () => {
  const a = 'gantt\nsection S\nDesign :d, 2024-01-01, 5d\nBuild :b, after d, 2w';
  it('diff sees a task being rescheduled and a new dependency', () => {
    const r: any = diffDiagrams(parseMermaid(a), parseMermaid('gantt\nsection S\nDesign :d, 2024-01-01, 10d\nBuild :b, after d, 2w\nTest :t, after b, 3d'));
    expect(r.supported).toBe(true);
    expect(r.changedNodes.map((c: any) => c.id).sort()).toEqual(['b', 'd']);
    expect(r.addedNodes).toEqual(['t']);
    expect(r.addedEdges).toHaveLength(1);
  });
  it('complexity reports the dependency structure', () => {
    const r: any = analyzeComplexity(parseMermaid(a));
    expect(r.supported).toBe(true);
    expect(r.nodeCount).toBe(2);
    expect(r.edgeCount).toBe(1);
  });
});
