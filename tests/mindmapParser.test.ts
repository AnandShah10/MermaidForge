import { describe, it, expect } from 'vitest';
import { parseMindmapDiagram } from '../src/core/parser/mindmapParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isMindmapDiagram } from '../src/core/diagram/types';

describe('parseMindmapDiagram', () => {
  it('parses a root and its nesting depth from indentation', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root((mindmap))
    Origins
      Long history
    Research
      On effectiveness`);
    expect(diagram.nodes).toHaveLength(5);
    expect(diagram.nodes[0]).toMatchObject({ label: 'mindmap', depth: 0, parentId: null, shape: 'circle' });
    expect(diagram.nodes[1]).toMatchObject({ label: 'Origins', depth: 1 });
    expect(diagram.nodes[2]).toMatchObject({ label: 'Long history', depth: 2 });
  });

  it('sets parentId based on the nearest less-indented preceding node', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root
    A
      A1
      A2
    B`);
    const [root, a, a1, a2, b] = diagram.nodes;
    expect(a.parentId).toBe(root.id);
    expect(a1.parentId).toBe(a.id);
    expect(a2.parentId).toBe(a.id);
    expect(b.parentId).toBe(root.id);
  });

  it('strips a leading identifier before a shape delimiter (the canonical "root((mindmap))" form)', () => {
    const diagram = parseMindmapDiagram('mindmap\n  root((mindmap))');
    expect(diagram.nodes[0]).toMatchObject({ label: 'mindmap', shape: 'circle' });
  });

  it('does not treat a bare word as having an id prefix with an empty label', () => {
    const diagram = parseMindmapDiagram('mindmap\n  root\n    Origins');
    expect(diagram.nodes[1].label).toBe('Origins');
    expect(diagram.nodes[1].shape).toBe('default');
  });

  it('parses all shape delimiters', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root
    ((circle))
    [square]
    {{hexagon}}
    (rounded)
    )cloud(
    ))bang((`);
    const shapes = diagram.nodes.slice(1).map((n) => n.shape);
    expect(shapes).toEqual(['circle', 'square', 'hexagon', 'rounded', 'cloud', 'bang']);
  });

  it('attaches ::icon(...) to the immediately preceding node', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root
    Origins
    ::icon(fa fa-book)`);
    expect(diagram.nodes[1].icon).toBe('fa fa-book');
  });

  it('attaches :::className to the immediately preceding node', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root
    Origins
    :::urgent`);
    expect(diagram.nodes[1].className).toBe('urgent');
  });

  it('recovers gracefully from a mis-indented second root with a warning, not a cascade of errors', () => {
    const diagram = parseMindmapDiagram(`mindmap
  root
    Child
Orphan
  OrphanChild`);
    expect(diagram.nodes).toHaveLength(4);
    const warnings = diagram.parseIssues.filter((i) => /one root/.test(i.message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    // The recovered node and its child should still nest sensibly rather than erroring individually.
    const orphan = diagram.nodes.find((n) => n.label === 'Orphan')!;
    const orphanChild = diagram.nodes.find((n) => n.label === 'OrphanChild')!;
    expect(orphan.parentId).toBe(diagram.nodes[0].id);
    expect(orphanChild.parentId).toBe(orphan.id);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseMindmapDiagram('mindmap\n  root\n    ((unterminated')).not.toThrow();
  });
});

describe('parseMermaid routes mindmap to the structural parser', () => {
  it('produces a MindmapDiagram, not the light fallback', () => {
    const diagram = parseMermaid('mindmap\n  root\n    Child');
    expect(isMindmapDiagram(diagram)).toBe(true);
    if (isMindmapDiagram(diagram)) {
      expect(diagram.nodes).toHaveLength(2);
    }
  });
});
