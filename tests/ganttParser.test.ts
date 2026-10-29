import { describe, it, expect } from 'vitest';
import { parseGanttDiagram } from '../src/core/parser/ganttParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isGanttDiagram } from '../src/core/diagram/types';

describe('parseGanttDiagram', () => {
  it('parses title and dateFormat', () => {
    const diagram = parseGanttDiagram('gantt\ntitle A Gantt Diagram\ndateFormat YYYY-MM-DD\nA task :a1, 2024-01-01, 30d');
    expect(diagram.title).toBe('A Gantt Diagram');
    expect(diagram.dateFormat).toBe('YYYY-MM-DD');
  });

  it('parses a full task with id, start, and duration', () => {
    const diagram = parseGanttDiagram('gantt\nA task :a1, 2024-01-01, 30d');
    expect(diagram.tasks[0]).toMatchObject({ name: 'A task', id: 'a1', startRaw: '2024-01-01', durationRaw: '30d', afterIds: [] });
  });

  it('parses a task with only start and duration (no id)', () => {
    const diagram = parseGanttDiagram('gantt\nA task :2024-01-01, 30d');
    expect(diagram.tasks[0]).toMatchObject({ id: null, startRaw: '2024-01-01', durationRaw: '30d' });
  });

  it('parses a task with only a duration (starts after the previous task)', () => {
    const diagram = parseGanttDiagram('gantt\nFirst :f1, 2024-01-01, 10d\nSecond :10d');
    expect(diagram.tasks[1]).toMatchObject({ id: null, startRaw: null, durationRaw: '10d' });
  });

  it('parses an "after" start dependency', () => {
    const diagram = parseGanttDiagram('gantt\nFirst :f1, 2024-01-01, 10d\nSecond :after f1, 10d');
    expect(diagram.tasks[1].afterIds).toEqual(['f1']);
    expect(diagram.tasks[1].startRaw).toBeNull();
  });

  it('parses multiple after-dependencies', () => {
    const diagram = parseGanttDiagram('gantt\nA :a1, 2024-01-01, 5d\nB :b1, 2024-01-01, 5d\nC :after a1 b1, 5d');
    expect(diagram.tasks[2].afterIds).toEqual(['a1', 'b1']);
  });

  it('parses status keywords', () => {
    const diagram = parseGanttDiagram('gantt\nDone task :done, d1, 2024-01-01, 5d\nCrit active task :crit, active, c1, 2024-01-01, 5d');
    expect(diagram.tasks[0].statuses).toEqual(['done']);
    expect(diagram.tasks[1].statuses).toEqual(['crit', 'active']);
  });

  it('tags tasks with their section', () => {
    const diagram = parseGanttDiagram('gantt\nsection Design\nTask A :a1, 2024-01-01, 5d\nsection Build\nTask B :b1, 2024-01-06, 5d');
    expect(diagram.sections).toHaveLength(2);
    expect(diagram.tasks[0].section).toBe('Design');
    expect(diagram.tasks[1].section).toBe('Build');
  });

  it('flags an "after" reference to an unknown task id', () => {
    const diagram = parseGanttDiagram('gantt\nA :after ghost, 5d');
    expect(diagram.parseIssues.some((i) => /no task with id "ghost"/.test(i.message))).toBe(true);
  });

  it('acknowledges axisFormat/excludes without flagging them as unrecognized', () => {
    const diagram = parseGanttDiagram('gantt\naxisFormat %Y-%m-%d\nexcludes weekends\nA :a1, 2024-01-01, 5d');
    expect(diagram.parseIssues.filter((i) => /Unrecognized/.test(i.message))).toHaveLength(0);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseGanttDiagram('gantt\n@@@ garbage @@@ no colon\nA :a1, 2024-01-01, 5d')).not.toThrow();
  });
});

describe('parseMermaid routes gantt to the structural parser', () => {
  it('produces a GanttDiagram, not the light fallback', () => {
    const diagram = parseMermaid('gantt\ntitle X\nA :a1, 2024-01-01, 5d');
    expect(isGanttDiagram(diagram)).toBe(true);
    if (isGanttDiagram(diagram)) {
      expect(diagram.tasks).toHaveLength(1);
    }
  });
});
