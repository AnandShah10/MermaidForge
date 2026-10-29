import { describe, it, expect } from 'vitest';
import { parseTimelineDiagram } from '../src/core/parser/timelineParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isTimelineDiagram } from '../src/core/diagram/types';

describe('parseTimelineDiagram', () => {
  it('parses a title and periods with single events', () => {
    const diagram = parseTimelineDiagram('timeline\ntitle Project History\n2025 : Initial release\n2026 : Authentication');
    expect(diagram.title).toBe('Project History');
    expect(diagram.periods).toHaveLength(2);
    expect(diagram.periods[0]).toMatchObject({ period: '2025', events: ['Initial release'] });
  });

  it('attaches a continuation line to the previous period as another event', () => {
    const diagram = parseTimelineDiagram('timeline\n2026 : Authentication\n     : Dashboard');
    expect(diagram.periods).toHaveLength(1);
    expect(diagram.periods[0].events).toEqual(['Authentication', 'Dashboard']);
  });

  it('parses sections and tags periods with their section', () => {
    const diagram = parseTimelineDiagram('timeline\nsection Early Days\n2024 : Founded\nsection Growth\n2025 : Series A');
    expect(diagram.sections).toHaveLength(2);
    expect(diagram.periods[0].section).toBe('Early Days');
    expect(diagram.periods[1].section).toBe('Growth');
  });

  it('flags a continuation line with no preceding period', () => {
    const diagram = parseTimelineDiagram('timeline\n: Orphaned event');
    expect(diagram.parseIssues.some((i) => /no preceding period/.test(i.message))).toBe(true);
  });

  it('a new section resets the continuation context', () => {
    const diagram = parseTimelineDiagram('timeline\n2024 : Founded\nsection Growth\n: Should be an error, not attached to 2024');
    expect(diagram.parseIssues.some((i) => /no preceding period/.test(i.message))).toBe(true);
  });

  it('handles a period label containing spaces', () => {
    const diagram = parseTimelineDiagram('timeline\n2026 Q1 : Launch');
    expect(diagram.periods[0].period).toBe('2026 Q1');
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseTimelineDiagram('timeline\n@@@ garbage @@@ no colon here')).not.toThrow();
  });
});

describe('parseMermaid routes timeline to the structural parser', () => {
  it('produces a TimelineDiagram, not the light fallback', () => {
    const diagram = parseMermaid('timeline\ntitle X\n2025 : Event');
    expect(isTimelineDiagram(diagram)).toBe(true);
    if (isTimelineDiagram(diagram)) {
      expect(diagram.periods).toHaveLength(1);
    }
  });
});
