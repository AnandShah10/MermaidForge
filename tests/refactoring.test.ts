import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { renameNode, removeUnusedNodes, extractSubgraph } from '../src/core/refactoring/refactoring';

describe('renameNode', () => {
  it('renames a node everywhere it is referenced', () => {
    const diagram = parseMermaid('flowchart TD\nA[Start]-->B\nB-->A');
    const result = renameNode(diagram, 'A', 'Start1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newSource).toContain('Start1[Start]');
      expect(result.newSource).not.toMatch(/\bA\b/);
    }
  });

  it('rejects renaming to an id that already exists', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B');
    const result = renameNode(diagram, 'A', 'B');
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid new id', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B');
    const result = renameNode(diagram, 'A', 'not valid!');
    expect(result.ok).toBe(false);
  });
});

describe('removeUnusedNodes', () => {
  it('removes isolated nodes', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B\nC[Isolated]');
    const result = removeUnusedNodes(diagram);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newSource).not.toContain('Isolated');
      expect(result.newSource).toContain('A-->B');
    }
  });

  it('reports when there is nothing to remove', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B');
    const result = removeUnusedNodes(diagram);
    expect(result.ok).toBe(false);
  });
});

describe('extractSubgraph', () => {
  it('wraps selected top-level nodes into a new subgraph', () => {
    const diagram = parseMermaid('flowchart TD\nA[API]\nB[DB]\nC[Client]-->A');
    const result = extractSubgraph(diagram, ['A', 'B'], 'Backend', 'Backend Services');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newSource).toContain('subgraph Backend [Backend Services]');
      expect(result.newSource).toContain('end');
    }
  });

  it('rejects extracting nodes already inside a subgraph', () => {
    const diagram = parseMermaid('flowchart TD\nsubgraph S\nA[API]\nend');
    const result = extractSubgraph(diagram, ['A'], 'New', 'New');
    expect(result.ok).toBe(false);
  });
});
