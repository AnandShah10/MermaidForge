import { describe, it, expect } from 'vitest';
import { parseSequenceDiagram } from '../src/core/parser/sequenceParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isSequenceDiagram } from '../src/core/diagram/types';

describe('parseSequenceDiagram', () => {
  it('parses participants declared explicitly', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hello');
    expect(diagram.participants.size).toBe(2);
    expect(diagram.messages).toHaveLength(1);
    expect(diagram.messages[0]).toMatchObject({ from: 'A', to: 'B', text: 'Hello', arrow: '->>' });
  });

  it('implicitly declares participants from message references', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nAlice->>Bob: Hi\nBob-->>Alice: Hi back');
    expect(diagram.participants.size).toBe(2);
    expect([...diagram.participants.keys()].sort()).toEqual(['Alice', 'Bob']);
  });

  it('parses an alias via "as"', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nparticipant A as Alice Smith\nA->>A: note to self');
    expect(diagram.participants.get('A')?.label).toBe('Alice Smith');
  });

  it('distinguishes arrow styles', () => {
    const diagram = parseSequenceDiagram(
      'sequenceDiagram\nA->>B: sync\nA-->>B: reply\nA-)B: async\nA-xB: fail',
    );
    expect(diagram.messages.map((m) => m.arrow)).toEqual(['->>', '-->>', '-)', '-x']);
  });

  it('parses notes', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nA->>B: hi\nNote right of B: thinking...');
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0]).toMatchObject({ position: 'right of', participants: ['B'], text: 'thinking...' });
  });

  it('tracks block open/close (loop/alt/opt/par/critical/rect/break)', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nA->>B: hi\nloop Every minute\nA->>B: ping\nend');
    expect(diagram.blocks.size).toBe(1);
    expect([...diagram.blocks.values()][0]).toMatchObject({ kind: 'loop', label: 'Every minute' });
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('tolerates else/and/option inside a block without new nesting', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nalt success\nA->>B: ok\nelse failure\nA->>B: retry\nend');
    expect(diagram.blocks.size).toBe(1);
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags an unclosed block', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nloop Forever\nA->>B: ping');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('flags a duplicate participant declaration', () => {
    const diagram = parseSequenceDiagram('sequenceDiagram\nparticipant A\nparticipant A\nA->>A: x');
    expect(diagram.parseIssues.some((i) => /declared more than once/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseSequenceDiagram('sequenceDiagram\n@@@ garbage @@@\nA->>B: hi')).not.toThrow();
  });
});

describe('parseMermaid routes sequenceDiagram to the structural parser', () => {
  it('produces a SequenceDiagram, not the light fallback', () => {
    const diagram = parseMermaid('sequenceDiagram\nAlice->>Bob: Hi');
    expect(isSequenceDiagram(diagram)).toBe(true);
    if (isSequenceDiagram(diagram)) {
      expect(diagram.messages).toHaveLength(1);
    }
  });
});
