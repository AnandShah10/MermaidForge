import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { lintDiagram } from '../src/core/linter/linter';

const rules = (src: string) => lintDiagram(parseMermaid(src)).map((d) => d.ruleId);
const dx = (src: string): any => parseMermaid(src);

describe('sankey', () => {
  const src = 'sankey-beta\n\nA,B,10\nA,"C, Inc",5\nB,C,3';
  it('parses quoted CSV and nodes', () => {
    const d = dx(src);
    expect(d.kind).toBe('sankey');
    expect(d.links).toHaveLength(3);
    expect(d.links[1].target).toBe('C, Inc');
  });
  it('reports bad rows', () => {
    expect(dx('sankey-beta\nA,B\nA,B,x').parseIssues.length).toBeGreaterThanOrEqual(2);
  });
  it('lints cycles, self loops, non-positive, duplicates', () => {
    expect(rules('sankey-beta\nA,B,1\nB,A,1')).toContain('sankeyCycle');
    expect(rules('sankey-beta\nA,A,1')).toContain('sankeyCycle');
    expect(rules('sankey-beta\nA,B,0')).toContain('sankeyNonPositiveValue');
    expect(rules('sankey-beta\nA,B,1\nA,B,2')).toContain('duplicateEdge');
    expect(rules(src)).not.toContain('sankeyCycle');
  });
});

describe('quadrantChart', () => {
  const src = 'quadrantChart\n title T\n x-axis Low --> High\n y-axis Lo --> Hi\n quadrant-1 A\n quadrant-2 B\n quadrant-3 C\n quadrant-4 D\n P1: [0.3, 0.6]\n P2:::c1: [1.4, 0.2]';
  it('parses points and classes', () => {
    const d = dx(src);
    expect(d.kind).toBe('quadrantChart');
    expect(d.points).toHaveLength(2);
    expect(d.points[1].className).toBe('c1');
  });
  it('lints range, undefined class, missing points', () => {
    const r = rules(src);
    expect(r).toContain('quadrantOutOfRange');
    expect(r).toContain('styleUnknownClass');
    expect(rules('quadrantChart\n x-axis a --> b\n y-axis c --> d')).toContain('quadrantNoPoints');
  });
});

describe('xychart', () => {
  it('parses axes and series', () => {
    const d = dx('xychart-beta horizontal\n title "S"\n x-axis [a, b, c]\n y-axis "Y" 0 --> 10\n bar [1,2,3]\n line [3,2,1]');
    expect(d.kind).toBe('xychart');
    expect(d.horizontal).toBe(true);
    expect(d.series).toHaveLength(2);
    expect(d.xAxis.categories).toEqual(['a', 'b', 'c']);
    expect(d.yAxis.range).toEqual({ min: 0, max: 10 });
  });
  it('lints mismatch and bad range', () => {
    expect(rules('xychart-beta\n x-axis [a,b]\n bar [1,2,3]')).toContain('xychartLengthMismatch');
    expect(rules('xychart-beta\n y-axis 10 --> 0\n bar [1]')).toContain('xychartInvalidRange');
    expect(rules('xychart-beta\n x-axis [a]')).toContain('xychartNoSeries');
  });
});

describe('packet', () => {
  it('parses ranges and relative fields', () => {
    const d = dx('packet-beta\n 0-15: "Src"\n 16-31: "Dst"\n +32: "Seq"');
    expect(d.kind).toBe('packet');
    expect(d.fields.map((f: any) => [f.start, f.end])).toEqual([[0, 15], [16, 31], [32, 63]]);
  });
  it('lints overlap, gap, reversed', () => {
    expect(rules('packet-beta\n 0-15: "a"\n 8-31: "b"')).toContain('packetOverlap');
    expect(rules('packet-beta\n 0-7: "a"\n 16-31: "b"')).toContain('packetGap');
    expect(dx('packet-beta\n 9-3: "a"').parseIssues.length).toBeGreaterThan(0);
  });
});

describe('requirementDiagram', () => {
  const src = `requirementDiagram
  requirement r1 {
    id: 1
    text: hello
    risk: high
    verifymethod: test
  }
  element e1 {
    type: sim
  }
  e1 - satisfies -> r1
  r1 <- copies - e1`;
  it('parses and normalizes direction', () => {
    const d = dx(src);
    expect(d.kind).toBe('requirementDiagram');
    expect(d.requirements).toHaveLength(1);
    expect(d.relations).toHaveLength(2);
    expect(d.relations[1].source).toBe('e1');
    expect(d.relations[1].target).toBe('r1');
  });
  it('lints values, references, missing fields', () => {
    expect(rules(src)).toEqual([]);
    const bad = 'requirementDiagram\n requirement r {\n id: 1\n risk: extreme\n verifymethod: magic\n }\n r - satisfies -> ghost';
    const r = rules(bad);
    expect(r).toContain('requirementInvalidValue');
    expect(r).toContain('requirementMissingField');
    expect(r).toContain('invalidReference');
  });
});

describe('block', () => {
  it('parses columns, spans, edges', () => {
    const d = dx('block-beta\n columns 3\n a["A"]:2 b\n c space d\n a --> b');
    expect(d.kind).toBe('block');
    expect(d.columns).toBe(3);
    expect(d.blocks.find((b: any) => b.id === 'a').span).toBe(2);
    expect(d.edges).toHaveLength(1);
  });
  it('lints references and spans', () => {
    expect(rules('block-beta\n columns 2\n a:3 b\n a --> zz')).toEqual(expect.arrayContaining(['blockSpanExceedsColumns', 'invalidReference']));
  });
});

describe('architecture', () => {
  const src = 'architecture-beta\n group api(cloud)[API]\n service db(database)[DB] in api\n service s(server)[S] in api\n db:L -- R:s';
  it('parses groups, services, edges', () => {
    const d = dx(src);
    expect(d.kind).toBe('architecture');
    expect(d.nodes).toHaveLength(3);
    expect(d.edges[0]).toMatchObject({ source: 'db', target: 's' });
    expect(rules(src)).toEqual([]);
  });
  it('lints unknown parent and edge target', () => {
    const r = rules('architecture-beta\n service a(server)[A] in nope\n a:R -- L:zz');
    expect(r.filter((x) => x === 'invalidReference').length).toBeGreaterThanOrEqual(2);
  });
});

describe('c4', () => {
  const src = 'C4Context\n Person(u, "User")\n System_Boundary(b, "B") {\n System(s, "Sys")\n }\n Rel(u, s, "Uses")';
  it('parses elements, boundaries, relations', () => {
    const d = dx(src);
    expect(d.kind).toBe('c4');
    expect(d.elements).toHaveLength(2);
    expect(d.boundaries).toHaveLength(1);
    expect(d.relations[0]).toMatchObject({ from: 'u', to: 's' });
    expect(rules(src)).toEqual([]);
  });
  it('lints references, labels, unclosed boundary', () => {
    expect(rules('C4Context\n Person(u, "U")\n Rel(u, x, "")')).toEqual(expect.arrayContaining(['invalidReference', 'c4MissingLabel']));
    expect(dx('C4Context\n System_Boundary(b, "B") {\n Person(u,"U")').parseIssues.length).toBeGreaterThan(0);
  });
});

describe('regressions', () => {
  it('block rows keep a trailing bare id', () => {
    expect(dx('block-beta\n a b c').blocks.map((b: any) => b.id)).toEqual(['a', 'b', 'c']);
    expect(dx('block-beta\n a b c').parseIssues).toEqual([]);
  });
});

describe('robustness', () => {
  const headers = ['sankey-beta', 'quadrantChart', 'xychart-beta', 'packet-beta', 'requirementDiagram', 'block-beta', 'architecture-beta', 'C4Context'];
  const junk = ['', '}}}{{{', '"unterminated', 'a: [1,', '-->', '\u0000�', 'x'.repeat(5000), '(((', 'end\nend'];
  it('never throws on garbage', () => {
    for (const h of headers) for (const j of junk) {
      expect(() => lintDiagram(parseMermaid(`${h}\n${j}\n${j}`))).not.toThrow();
    }
  });
});

describe('conformance regressions (found by checking against real Mermaid)', () => {
  it('architecture edge titles', () => {
    const d = dx('architecture-beta\n service x(internet)[X]\n service y(disk)[Y]\n x:B <-[lbl]-> T:y');
    expect(d.parseIssues).toEqual([]);
    expect(d.edges[0]).toMatchObject({ label: 'lbl', arrowSource: true, arrowTarget: true });
  });
  it('architecture {group} within one group is an error', () => {
    const src = 'architecture-beta\n group a(cloud)[A]\n service s1(server)[S1] in a\n service s2(server)[S2] in a\n s1{group}:R -- L:s2';
    expect(lintDiagram(parseMermaid(src)).some((x) => x.ruleId === 'architectureGroupModifier' && x.severity === 'error')).toBe(true);
  });
  it('block shape text must be quoted', () => {
    expect(dx('block-beta\n a[x]').parseIssues.some((i: any) => i.severity === 'error')).toBe(true);
    expect(dx('block-beta\n a["x"] b(("y"))').parseIssues).toEqual([]);
  });
});
