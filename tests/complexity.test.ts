import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { analyzeComplexity } from '../src/core/complexity/complexity';

describe('analyzeComplexity', () => {
  it('computes basic metrics for a simple DAG', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B-->C\nA-->C');
    const report = analyzeComplexity(diagram);
    expect(report.supported).toBe(true);
    if (report.supported) {
      expect(report.nodeCount).toBe(3);
      expect(report.edgeCount).toBe(3);
      expect(report.cycles).toHaveLength(0);
      expect(report.longestPathLength).toBe(2);
    }
  });

  it('detects a simple cycle', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B-->C-->A');
    const report = analyzeComplexity(diagram);
    expect(report.supported).toBe(true);
    if (report.supported) {
      expect(report.cycles.length).toBeGreaterThan(0);
      expect(report.longestPathLength).toBe(0); // undefined for cyclic graphs, represented as 0
    }
  });

  it('is unsupported for non-flowchart diagrams', () => {
    const diagram = parseMermaid('sequenceDiagram\nAlice->>Bob: Hi');
    const report = analyzeComplexity(diagram);
    expect(report.supported).toBe(false);
  });

  it('recommends splitting above threshold', () => {
    const nodes = Array.from({ length: 80 }, (_, i) => `N${i}-->N${i + 1}`).join('\n');
    const diagram = parseMermaid(`flowchart TD\n${nodes}`);
    const report = analyzeComplexity(diagram, 1);
    expect(report.supported).toBe(true);
    if (report.supported) {
      expect(report.complexityScore).toBeGreaterThan(1);
      expect(report.recommendation).toMatch(/split/i);
    }
  });
});
