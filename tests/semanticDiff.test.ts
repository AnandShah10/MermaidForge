import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { diffDiagrams, formatDiffReport } from '../src/core/diff/semanticDiff';

describe('diffDiagrams', () => {
  it('detects added and removed nodes', () => {
    const before = parseMermaid('flowchart TD\nA-->B');
    const after = parseMermaid('flowchart TD\nA-->C');
    const diff = diffDiagrams(before, after);
    expect(diff.supported).toBe(true);
    if (diff.supported) {
      expect(diff.addedNodes).toContain('C');
      expect(diff.removedNodes).toContain('B');
    }
  });

  it('detects changed node labels', () => {
    const before = parseMermaid('flowchart TD\nA[Old Label]-->B');
    const after = parseMermaid('flowchart TD\nA[New Label]-->B');
    const diff = diffDiagrams(before, after);
    expect(diff.supported).toBe(true);
    if (diff.supported) {
      expect(diff.changedNodes).toHaveLength(1);
      expect(diff.changedNodes[0].after.label).toBe('New Label');
    }
  });

  it('detects added edges', () => {
    const before = parseMermaid('flowchart TD\nA-->B');
    const after = parseMermaid('flowchart TD\nA-->B\nB-->C');
    const diff = diffDiagrams(before, after);
    expect(diff.supported).toBe(true);
    if (diff.supported) {
      expect(diff.addedEdges).toEqual([{ source: 'B', target: 'C', label: null }]);
    }
  });

  it('reports no differences for identical diagrams', () => {
    const src = 'flowchart TD\nA-->B';
    const diff = diffDiagrams(parseMermaid(src), parseMermaid(src));
    expect(diff.supported).toBe(true);
    if (diff.supported) {
      expect(diff.summary).toMatch(/no semantic differences/i);
    }
  });
});

describe('diffDiagrams: kinds without relationships are diffed as keyed items', () => {
  const d = (a: string, b: string) => {
    const r = diffDiagrams(parseMermaid(a), parseMermaid(b));
    if (!r.supported) throw new Error(r.reason);
    return r;
  };
  it('pie: added, removed and changed slices', () => {
    const r = d('pie title Pets\n"Dogs": 10\n"Cats": 5', 'pie title Pets\n"Dogs": 12\n"Birds": 3');
    expect(r.addedNodes).toEqual(['Birds']);
    expect(r.removedNodes).toEqual(['Cats']);
    expect(r.changedNodes.map((c) => [c.id, c.before.shape, c.after.shape])).toEqual([['Dogs', '10', '12']]);
  });
  it('journey: a changed score and a moved section are changes of the same task', () => {
    const r = d('journey\nsection A\nWake: 3: Me\nsection B\nWork: 4: Me', 'journey\nsection A\nWake: 5: Me\nWork: 4: Me');
    expect(r.changedNodes.map((c) => c.id).sort()).toEqual(['Wake', 'Work']);
  });
  it('timeline, quadrant, xychart and packet changes are detected', () => {
    expect(d('timeline\n2002 : A\n2004 : B', 'timeline\n2002 : A\n2004 : B : C').changedNodes.map((c) => c.id)).toEqual(['2004']);
    expect(d('quadrantChart\nx-axis L --> R\nA: [0.1, 0.2]', 'quadrantChart\nx-axis L --> R\nA: [0.3, 0.2]').changedNodes.map((c) => c.id)).toEqual(['A']);
    expect(d('xychart-beta\nx-axis [a, b]\nbar [1, 2]', 'xychart-beta\nx-axis [a, b]\nbar [1, 3]').changedNodes).toHaveLength(1);
    expect(d('packet-beta\n0-15: "Src"\n16-31: "Dst"', 'packet-beta\n0-15: "Source"\n16-31: "Dst"').changedNodes.map((c) => c.id)).toEqual(['0-15']);
  });
  it('gitGraph: new commits and parent links', () => {
    const r = d('gitGraph\ncommit id: "a"\ncommit id: "b"', 'gitGraph\ncommit id: "a"\ncommit id: "b"\nbranch dev\ncommit id: "c"');
    expect(r.addedNodes).toEqual(['c']);
    expect(r.addedEdges.map((e) => `${e.source}->${e.target}`)).toEqual(['b->c']);
    expect(r.addedSubgraphs).toEqual(['dev']);
  });
  it('identical diagrams report no differences; formatDiffReport lists each change', () => {
    expect(d('pie\n"a": 1', 'pie\n"a": 1').summary).toBe('No semantic differences detected.');
    const report = formatDiffReport(d('pie\n"a": 1\n"b": 2', 'pie\n"a": 9\n"c": 3'));
    expect(report).toContain('+ c');
    expect(report).toContain('- b');
    expect(report).toContain('~ a: 1 -> 9');
  });
});
