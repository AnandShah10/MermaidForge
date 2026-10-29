import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { commentTargetsFor } from '../src/comments/targets';

const t = (src: string) => commentTargetsFor(parseMermaid(src));

describe('commentTargetsFor', () => {
  it('flowchart keeps node and edge targets', () => {
    expect(t('flowchart TD\nA-->B')).toEqual([
      { type: 'node', id: 'A', label: 'Node: A' },
      { type: 'node', id: 'B', label: 'Node: B' },
      { type: 'edge', id: 'A→B', label: 'Edge: A → B' },
    ]);
  });
  it('class, ER, state, sequence, mindmap diagrams get node targets and relationship targets', () => {
    expect(t('classDiagram\nA <|-- B').map((x) => x.id)).toEqual(['A', 'B', 'A→B']);
    expect(t('erDiagram\nA ||--o{ B : has').some((x) => x.type === 'edge' && x.id === 'A→B')).toBe(true);
    expect(t('stateDiagram-v2\n[*] --> S\nS --> T').map((x) => x.id)).not.toContain('[*]');
    const seq = t('sequenceDiagram\nA->>B: one\nB-->>A: two\nA->>B: three');
    expect(seq.filter((x) => x.type === 'edge').map((x) => x.id)).toEqual(['A→B', 'B→A']);
  });
  it('kinds with no relationships get item targets (slices, tasks, points, fields)', () => {
    expect(t('pie\n"Dogs": 3\n"Cats": 2').map((x) => x.id)).toEqual(['Dogs', 'Cats']);
    expect(t('journey\nsection S\nWake: 3: Me').map((x) => x.id)).toEqual(['Wake']);
    expect(t('quadrantChart\nA: [0.1, 0.2]').map((x) => x.id)).toEqual(['A']);
    expect(t('packet-beta\n0-15: "Src"').map((x) => x.id)).toEqual(['0-15']);
    expect(t('pie\n"Dogs": 3')[0].label).toBe('Item: Dogs');
  });
});
