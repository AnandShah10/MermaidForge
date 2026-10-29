import { describe, it, expect } from 'vitest';
import { parseFlowchart } from '../src/core/parser/flowchartParser';
import { parseMermaid, extractMermaidBlocksFromMarkdown } from '../src/core/parser/mermaidParser';
import { detectDiagramType } from '../src/core/parser/detectDiagramType';
import { isFlowchart } from '../src/core/diagram/types';

describe('detectDiagramType', () => {
  it('detects flowchart', () => {
    expect(detectDiagramType('flowchart TD\nA-->B')).toBe('flowchart');
  });
  it('detects graph (legacy alias)', () => {
    expect(detectDiagramType('graph LR\nA-->B')).toBe('flowchart');
  });
  it('detects sequenceDiagram', () => {
    expect(detectDiagramType('sequenceDiagram\nAlice->>Bob: Hi')).toBe('sequenceDiagram');
  });
  it('returns unknown for unrecognized content', () => {
    expect(detectDiagramType('this is not mermaid')).toBe('unknown');
  });
  it('skips a frontmatter block', () => {
    const src = '---\ntitle: My Diagram\n---\nflowchart TD\nA-->B';
    expect(detectDiagramType(src)).toBe('flowchart');
  });
});

describe('parseFlowchart', () => {
  it('parses basic nodes and edges', () => {
    const diagram = parseFlowchart('flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[End]\n  B -->|No| A');
    expect(diagram.direction).toBe('TD');
    expect(diagram.nodes.size).toBe(3);
    expect(diagram.nodes.get('A')?.label).toBe('Start');
    expect(diagram.nodes.get('B')?.shape).toBe('rhombus');
    expect(diagram.edges).toHaveLength(3);
    expect(diagram.edges[1].label).toBe('Yes');
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('parses subgraphs and tracks membership', () => {
    const src = `flowchart TD
subgraph Backend [Backend Services]
  A[API] --> B[(Database)]
end
C[Client] --> A`;
    const diagram = parseFlowchart(src);
    expect(diagram.subgraphs.size).toBe(1);
    const sg = diagram.subgraphs.get('Backend')!;
    expect(sg.title).toBe('Backend Services');
    expect(sg.memberNodeIds.sort()).toEqual(['A', 'B']);
    expect(diagram.nodes.get('C')?.subgraphId).toBeNull();
  });

  it('flags an unclosed subgraph', () => {
    const diagram = parseFlowchart('flowchart TD\nsubgraph S\nA-->B');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('parses classDef and class assignment', () => {
    const diagram = parseFlowchart('flowchart TD\nA-->B\nclassDef important fill:#f00,stroke:#000\nclass A important');
    expect(diagram.classDefs.get('important')).toEqual({ fill: '#f00', stroke: '#000' });
    expect(diagram.nodes.get('A')?.classes).toContain('important');
  });

  it('captures comments without breaking parsing', () => {
    const diagram = parseFlowchart('flowchart TD\n%% this is a comment\nA-->B');
    expect(diagram.comments).toHaveLength(1);
    expect(diagram.nodes.size).toBe(2);
  });

  it('handles various node shapes', () => {
    const diagram = parseFlowchart(
      'flowchart TD\nA(Round)\nB([Stadium])\nC[[Subroutine]]\nD[(Cylinder)]\nE((Circle))\nF{{Hexagon}}\nG>Asym]\nH(((Double)))',
    );
    expect(diagram.nodes.get('A')?.shape).toBe('rounded');
    expect(diagram.nodes.get('B')?.shape).toBe('stadium');
    expect(diagram.nodes.get('C')?.shape).toBe('subroutine');
    expect(diagram.nodes.get('D')?.shape).toBe('cylinder');
    expect(diagram.nodes.get('E')?.shape).toBe('circle');
    expect(diagram.nodes.get('F')?.shape).toBe('hexagon');
    expect(diagram.nodes.get('G')?.shape).toBe('asymmetric');
    expect(diagram.nodes.get('H')?.shape).toBe('doubleCircle');
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseFlowchart('flowchart TD\n@@@ not valid @@@\nA-->B')).not.toThrow();
  });
});

describe('parseMermaid dispatcher', () => {
  it('routes flowchart source to the structural parser', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B');
    expect(isFlowchart(diagram)).toBe(true);
  });

  it('falls back to a light model for diagram types without a dedicated parser', () => {
    const diagram = parseMermaid('kanban\n  todo[Todo]\n    task1[Write tests]');
    expect(isFlowchart(diagram)).toBe(false);
    expect(diagram.kind).toBe('unknown');
    expect('bodyLines' in diagram).toBe(true);
  });
});

describe('extractMermaidBlocksFromMarkdown', () => {
  it('extracts a single fenced block', () => {
    const md = '# Title\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nMore text.';
    const blocks = extractMermaidBlocksFromMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\nA-->B');
  });

  it('extracts multiple blocks', () => {
    const md = '```mermaid\nflowchart TD\nA-->B\n```\n\ntext\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```';
    const blocks = extractMermaidBlocksFromMarkdown(md);
    expect(blocks).toHaveLength(2);
  });

  it('ignores non-mermaid fences', () => {
    const md = '```js\nconsole.log(1)\n```';
    expect(extractMermaidBlocksFromMarkdown(md)).toHaveLength(0);
  });
});
