import { describe, it, expect } from 'vitest';
import { parseJourneyDiagram } from '../src/core/parser/journeyParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isJourneyDiagram } from '../src/core/diagram/types';

describe('parseJourneyDiagram', () => {
  it('parses a title, sections, and tasks with actors', () => {
    const diagram = parseJourneyDiagram(`journey
title My working day
section Go to work
  Make tea: 5: Me
  Go upstairs: 3: Me
  Do work: 1: Me, Cat
section Go home
  Go downstairs: 5: Me`);
    expect(diagram.title).toBe('My working day');
    expect(diagram.sections).toHaveLength(2);
    expect(diagram.tasks).toHaveLength(4);
    expect(diagram.tasks[2]).toMatchObject({ name: 'Do work', score: 1, actors: ['Me', 'Cat'], section: 'Go to work' });
  });

  it('assigns each task a unique synthetic id even with duplicate names', () => {
    const diagram = parseJourneyDiagram('journey\nsection A\nTask: 5: Me\nsection B\nTask: 3: Me');
    expect(diagram.tasks[0].id).not.toBe(diagram.tasks[1].id);
  });

  it('parses a task with a single actor', () => {
    const diagram = parseJourneyDiagram('journey\nMake tea: 5: Me');
    expect(diagram.tasks[0].actors).toEqual(['Me']);
  });

  it('leaves section null for tasks before any section header', () => {
    const diagram = parseJourneyDiagram('journey\nMake tea: 5: Me\nsection Work\nDo work: 3: Me');
    expect(diagram.tasks[0].section).toBeNull();
    expect(diagram.tasks[1].section).toBe('Work');
  });

  it('flags a missing header', () => {
    const diagram = parseJourneyDiagram('Make tea: 5: Me');
    expect(diagram.parseIssues.some((i) => /header/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseJourneyDiagram('journey\n@@@ garbage @@@\nMake tea: 5: Me')).not.toThrow();
  });
});

describe('parseMermaid routes journey to the structural parser', () => {
  it('produces a JourneyDiagram, not the light fallback', () => {
    const diagram = parseMermaid('journey\ntitle Day\nMake tea: 5: Me');
    expect(isJourneyDiagram(diagram)).toBe(true);
    if (isJourneyDiagram(diagram)) {
      expect(diagram.tasks).toHaveLength(1);
    }
  });
});
