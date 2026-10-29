import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { diffDiagrams } from '../src/core/diff/semanticDiff';
import { analyzeComplexity } from '../src/core/complexity/complexity';

const d = (a: string, b: string): any => diffDiagrams(parseMermaid(a), parseMermaid(b));

describe('semantic diff across diagram types', () => {
  it('class diagrams: member and relationship changes', () => {
    const r = d('classDiagram\nclass A {\n+x int\n}\nA <|-- B', 'classDiagram\nclass A {\n+x int\n+y int\n}\nA <|-- B\nA --> C');
    expect(r.supported).toBe(true);
    expect(r.changedNodes.map((c: any) => c.id)).toEqual(['A']);
    expect(r.addedNodes).toContain('C');
    expect(r.addedEdges).toHaveLength(1);
  });
  it('er diagrams', () => {
    const r = d('erDiagram\nA ||--o{ B : has', 'erDiagram\nA ||--o{ B : owns');
    expect(r.changedEdgeLabels).toHaveLength(1);
  });
  it('state diagrams with composites', () => {
    const r = d('stateDiagram-v2\n[*] --> A\nA --> B', 'stateDiagram-v2\n[*] --> A\nA --> B\nstate B {\n  [*] --> C\n}');
    expect(r.addedSubgraphs).toContain('B');
  });
  it('sequence messages between the same pair match in order', () => {
    const r = d('sequenceDiagram\nA->>B: one\nA->>B: two', 'sequenceDiagram\nA->>B: one\nA->>B: TWO\nB-->>A: ok');
    expect(r.changedEdgeLabels).toHaveLength(1);
    expect(r.addedEdges).toHaveLength(1);
  });
  it('c4, sankey, mindmap, requirement, architecture, block', () => {
    expect(d('C4Context\nPerson(u,"U")\nSystem(s,"S")\nRel(u,s,"x")', 'C4Context\nPerson(u,"U")\nSystem(s,"S")\nRel(u,s,"y")').changedEdgeLabels).toHaveLength(1);
    expect(d('sankey-beta\nA,B,1', 'sankey-beta\nA,B,2\nB,C,1').addedNodes).toEqual(['C']);
    expect(d('mindmap\n  root\n    a', 'mindmap\n  root\n    a\n    b').addedNodes.length).toBe(1);
    expect(d('requirementDiagram\nrequirement r {\nid: 1\ntext: a\nrisk: low\nverifymethod: test\n}', 'requirementDiagram\nrequirement r {\nid: 1\ntext: b\nrisk: low\nverifymethod: test\n}').changedNodes).toHaveLength(1);
    expect(d('architecture-beta\nservice a(server)[A]', 'architecture-beta\nservice a(server)[A]\nservice b(server)[B]\na:R -- L:b').addedEdges).toHaveLength(1);
    expect(d('block-beta\na b', 'block-beta\na b c').addedNodes).toEqual(['c']);
  });
  it('rejects mixed kinds; relationship-free kinds are diffed as items (see semanticDiff tests)', () => {
    expect(d('pie\n"a":1', 'pie\n"a":2').supported).toBe(true);
    expect(d('pie\n"a":1', 'journey\nsection S\nT: 3: Me').supported).toBe(false);
    expect(d('classDiagram\nA<|--B', 'erDiagram\nA ||--o{ B : x').supported).toBe(false);
  });
  it('flowchart behaviour unchanged', () => {
    const r = d('flowchart TD\nA-->B', 'flowchart TD\nA-->B\nB-->C');
    expect(r.summary).toBe('+1 node(s), +1 edge(s)');
  });
});

describe('complexity across diagram types', () => {
  it('works for class, er, state, c4', () => {
    for (const src of ['classDiagram\nA<|--B\nB<|--C', 'erDiagram\nA ||--o{ B : x\nB ||--o{ C : y', 'stateDiagram-v2\n[*] --> A\nA --> B', 'C4Context\nPerson(u,"U")\nSystem(s,"S")\nRel(u,s,"x")']) {
      const r: any = analyzeComplexity(parseMermaid(src));
      expect(r.supported).toBe(true);
      expect(r.nodeCount).toBeGreaterThan(1);
    }
  });
  it('detects a cycle in a state diagram', () => {
    const r: any = analyzeComplexity(parseMermaid('stateDiagram-v2\nA --> B\nB --> A'));
    expect(r.cycles.length).toBeGreaterThan(0);
  });
  it('declines sequence and non-graph diagrams with a reason', () => {
    for (const src of ['sequenceDiagram\nA->>B: x', 'pie\n"a":1', 'timeline\n2024 : a']) {
      const r: any = analyzeComplexity(parseMermaid(src));
      expect(r.supported).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });
});
