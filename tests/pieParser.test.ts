import { describe, it, expect } from 'vitest';
import { parsePieDiagram } from '../src/core/parser/pieParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isPieDiagram } from '../src/core/diagram/types';

describe('parsePieDiagram', () => {
  it('parses slices', () => {
    const diagram = parsePieDiagram('pie\n"Dogs" : 386\n"Cats" : 85\n"Rats" : 15');
    expect(diagram.slices).toHaveLength(3);
    expect(diagram.slices[0]).toMatchObject({ label: 'Dogs', value: 386 });
  });

  it('parses a title on the header line', () => {
    const diagram = parsePieDiagram('pie title Pets adopted by volunteers\n"Dogs" : 386');
    expect(diagram.title).toBe('Pets adopted by volunteers');
  });

  it('parses a title on its own line', () => {
    const diagram = parsePieDiagram('pie\ntitle Pets adopted\n"Dogs" : 386');
    expect(diagram.title).toBe('Pets adopted');
  });

  it('parses the showData directive on the header line, with a title after it', () => {
    const diagram = parsePieDiagram('pie showData title Pets\n"Dogs" : 386');
    expect(diagram.showData).toBe(true);
    expect(diagram.title).toBe('Pets');
  });

  it('parses the showData directive on its own line', () => {
    const diagram = parsePieDiagram('pie\nshowData\n"Dogs" : 386');
    expect(diagram.showData).toBe(true);
  });

  it('parses decimal values', () => {
    const diagram = parsePieDiagram('pie\n"A" : 12.5');
    expect(diagram.slices[0].value).toBe(12.5);
  });

  it('flags a missing header', () => {
    const diagram = parsePieDiagram('"Dogs" : 386');
    expect(diagram.parseIssues.some((i) => /header/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parsePieDiagram('pie\n@@@ garbage @@@\n"Dogs" : 386')).not.toThrow();
  });
});

describe('parseMermaid routes pie to the structural parser', () => {
  it('produces a PieDiagram, not the light fallback', () => {
    const diagram = parseMermaid('pie\n"Dogs" : 386');
    expect(isPieDiagram(diagram)).toBe(true);
    if (isPieDiagram(diagram)) {
      expect(diagram.slices).toHaveLength(1);
    }
  });
});
