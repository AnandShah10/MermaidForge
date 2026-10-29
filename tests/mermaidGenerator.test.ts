import { describe, it, expect } from 'vitest';
import { codeGraphToFlowchart, classesToClassDiagram } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isFlowchart, isClassDiagram } from '../src/core/diagram/types';

describe('codeGraphToFlowchart', () => {
  it('produces valid, parseable Mermaid for a simple graph', () => {
    const mermaid = codeGraphToFlowchart({
      nodes: [
        { id: 'src/index.ts', label: 'src/index.ts', kind: 'file' },
        { id: 'src/helper.ts', label: 'src/helper.ts', kind: 'file' },
      ],
      edges: [{ from: 'src/index.ts', to: 'src/helper.ts', kind: 'import' }],
    });
    const diagram = parseMermaid(mermaid);
    expect(isFlowchart(diagram)).toBe(true);
    if (isFlowchart(diagram)) {
      expect(diagram.nodes.size).toBe(2);
      expect(diagram.edges).toHaveLength(1);
      expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    }
  });

  it('sanitizes file-path ids into valid Mermaid node ids', () => {
    const mermaid = codeGraphToFlowchart({
      nodes: [{ id: 'src/components/Button.tsx', label: 'src/components/Button.tsx', kind: 'file' }],
      edges: [],
    });
    const diagram = parseMermaid(mermaid);
    expect(isFlowchart(diagram)).toBe(true);
  });

  it('gives distinct ids to nodes whose sanitized form collides', () => {
    const mermaid = codeGraphToFlowchart({
      nodes: [
        { id: 'src/a.b.ts', label: 'src/a.b.ts', kind: 'file' },
        { id: 'src/a-b.ts', label: 'src/a-b.ts', kind: 'file' },
      ],
      edges: [],
    });
    const diagram = parseMermaid(mermaid);
    expect(isFlowchart(diagram)).toBe(true);
    if (isFlowchart(diagram)) {
      expect(diagram.nodes.size).toBe(2);
    }
  });

  it('skips an edge referencing a node not in the graph rather than emitting a dangling reference', () => {
    const mermaid = codeGraphToFlowchart({
      nodes: [{ id: 'a.ts', label: 'a.ts', kind: 'file' }],
      edges: [{ from: 'a.ts', to: 'missing.ts', kind: 'import' }],
    });
    const diagram = parseMermaid(mermaid);
    expect(isFlowchart(diagram)).toBe(true);
    if (isFlowchart(diagram)) {
      expect(diagram.edges).toHaveLength(0);
    }
  });
});

describe('classesToClassDiagram', () => {
  it('produces valid, parseable Mermaid for classes with members and an inheritance relationship', () => {
    const mermaid = classesToClassDiagram(
      [
        { id: 'Animal', stereotype: null, members: ['+name string'] },
        { id: 'Dog', stereotype: null, members: [] },
      ],
      [{ from: 'Dog', to: 'Animal', type: 'inheritance' }],
    );
    const diagram = parseMermaid(mermaid);
    expect(isClassDiagram(diagram)).toBe(true);
    if (isClassDiagram(diagram)) {
      expect(diagram.classes.size).toBe(2);
      expect(diagram.relationships).toHaveLength(1);
      expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    }
  });

  it('emits the <<interface>> stereotype', () => {
    const mermaid = classesToClassDiagram([{ id: 'Shape', stereotype: 'interface', members: ['+area() number'] }], []);
    const diagram = parseMermaid(mermaid);
    expect(isClassDiagram(diagram)).toBe(true);
    if (isClassDiagram(diagram)) {
      expect(diagram.classes.get('Shape')?.stereotype).toBe('interface');
    }
  });

  it('emits a realization relationship with the dotted arrow', () => {
    const mermaid = classesToClassDiagram(
      [
        { id: 'Shape', stereotype: 'interface', members: [] },
        { id: 'Circle', stereotype: null, members: [] },
      ],
      [{ from: 'Circle', to: 'Shape', type: 'realization' }],
    );
    const diagram = parseMermaid(mermaid);
    expect(isClassDiagram(diagram)).toBe(true);
    if (isClassDiagram(diagram)) {
      expect(diagram.relationships[0].type).toBe('realization');
    }
  });
});

describe('generator hardening', () => {
  it('escapes double quotes in labels with an entity, not a backslash', () => {
    const out = codeGraphToFlowchart({ nodes: [{ id: 'a', label: 'say "hi"\nnow', kind: 'x' }], edges: [] });
    expect(out).toContain('say #quot;hi#quot; now');
    expect(out).not.toContain('\\"');
  });
  it('gives unsafe class ids a safe id and keeps the original as a label; sanitizes members', () => {
    const out = classesToClassDiagram(
      [
        { id: "&'static [u8]", stereotype: null, members: [] },
        { id: 'Cfg', stereotype: 'interface', members: ["+'/a' { id: '/a' path: \"x\" }", '+' + 'y'.repeat(300)] },
      ],
      [{ from: 'Cfg', to: "&'static [u8]", type: 'realization' }],
    );
    expect(out).toMatch(/class static__u8\["&'static \[u8\]"\]/);
    const body = out.split('\n').filter((l) => l.startsWith('    +'));
    expect(body[0]).not.toMatch(/[{}"]/);
    expect(body[1].length).toBeLessThanOrEqual(4 + 120);
    expect(out).toContain('static__u8 <|.. Cfg');
  });
  it('rewrites angle brackets in members to Mermaid generics so `f<R(A)` cannot crash its parser', () => {
    const out = classesToClassDiagram([{ id: 'A', stereotype: null, members: ['+operatorAction<R(Args...) template<R> R', '+map(x: Vec<T>) -> Option<T>'] }], []);
    expect(out).not.toMatch(/    [^\n]*[<]/);
    expect(out).toContain('Vec~T~');
    expect(out).toContain('-> Option~T~');
  });
});

describe('ambiguous edges', () => {
  it('are drawn dotted so a guessed call does not look like a fact', () => {
    const out = codeGraphToFlowchart({
      nodes: [
        { id: 'a', label: 'a', kind: 'function' },
        { id: 'b', label: 'b', kind: 'function' },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'calls' },
        { from: 'b', to: 'a', kind: 'ambiguous' },
      ],
    });
    expect(out).toContain('a --> b');
    expect(out).toContain('b -.-> a');
    expect(isFlowchart(parseMermaid(out))).toBe(true);
  });
});
