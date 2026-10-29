import { describe, expect, it } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { lintDiagram } from '../src/core/linter/linter';
import type { BlockDiagram, C4Diagram, RequirementDiagram } from '../src/core/diagram/types';

const REQ = (extra: string) => `requirementDiagram\nrequirement r1 {\nid: 1\ntext: t\nrisk: high\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1\n${extra}`;
const lint = (src: string) => lintDiagram(parseMermaid(src));
const ids = (src: string) => lint(src).map((d) => d.ruleId);

describe('requirement styling', () => {
  it('models classDef / class / style and the ::: shorthand', () => {
    const d = parseMermaid('requirementDiagram\nrequirement r1:::imp {\nid: 1\ntext: t\nrisk: high\nverifymethod: test\n}\nelement e1:::imp:::x {\ntype: sim\n}\nclassDef imp fill:#f00,stroke:#000\nclass e1,r1 imp\nstyle r1 fill:#0f0') as RequirementDiagram;
    expect(d.parseIssues).toEqual([]);
    expect(d.requirements[0].name).toBe('r1');
    expect(d.requirements[0].classes).toEqual(['imp']);
    expect(d.elements[0].classes).toEqual(['imp', 'x']);
    expect(d.styling.classDefs).toMatchObject([{ name: 'imp', css: 'fill:#f00,stroke:#000' }]);
    expect(d.styling.classAssignments).toMatchObject([{ targets: ['e1', 'r1'], className: 'imp' }]);
    expect(d.styling.styles).toMatchObject([{ target: 'r1', css: 'fill:#0f0' }]);
  });
  it('lints unknown class / target as warnings and unused classDef as information', () => {
    const r = lint(REQ('class r1 nope\nclass ghost nope2\nstyle ghost fill:#f00\nclassDef spare fill:#fff'));
    const by = (id: string) => r.filter((d) => d.ruleId === id);
    expect(by('styleUnknownClass').map((d) => d.severity)).toEqual(['warning', 'warning']);
    expect(by('styleUnknownTarget').map((d) => d.severity)).toEqual(['warning', 'warning']);
    expect(by('styleUnusedClass')[0]).toMatchObject({ severity: 'information' });
  });
  it('lints an unknown ::: class', () => {
    expect(ids('requirementDiagram\nrequirement r1:::zzz {\nid: 1\ntext: t\nrisk: low\nverifymethod: test\n}')).toContain('styleUnknownClass');
  });
  it('clean styling produces no style diagnostics', () => {
    expect(ids(REQ('classDef a fill:#f00\nclass r1,e1 a\nstyle e1 stroke:#000')).filter((x) => x?.startsWith('style'))).toEqual([]);
  });
});

describe('block styling', () => {
  it('models statements and lints references; unknown style target is an error', () => {
    const d = parseMermaid('block-beta\ncolumns 2\na b\nclassDef k fill:#f00\nclass a,b k\nstyle b fill:#0f0') as BlockDiagram;
    expect(d.styling.classDefs[0].name).toBe('k');
    expect(d.styling.classAssignments[0].targets).toEqual(['a', 'b']);
    expect(d.styling.styles[0].target).toBe('b');
    expect(ids('block-beta\na b\nclassDef k fill:#f00\nclass a,b k')).not.toContain('styleUnknownTarget');
    const r = lint('block-beta\na b\nclassDef k fill:#f00\nclass zzz nope\nstyle ghost fill:#0f0');
    expect(r.find((x) => x.ruleId === 'styleUnknownClass')?.severity).toBe('warning');
    expect(r.filter((x) => x.ruleId === 'styleUnknownTarget').map((x) => x.severity).sort()).toEqual(['error', 'warning']);
  });
});

describe('C4 style calls', () => {
  const C4 = (extra: string) => `C4Context\nPerson(a, "A")\nSystem(b, "B")\nSystem(c, "C")\nRel(a, b, "uses")\n${extra}`;
  it('models UpdateElementStyle / UpdateRelStyle / UpdateLayoutConfig', () => {
    const d = parseMermaid(C4('UpdateElementStyle(a, $bgColor="red", $fontColor="white")\nUpdateRelStyle(a, b, $textColor="blue")\nUpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")')) as C4Diagram;
    expect(d.parseIssues).toEqual([]);
    expect(d.styleUpdates.map((u) => u.macro)).toEqual(['UpdateElementStyle', 'UpdateRelStyle', 'UpdateLayoutConfig']);
    expect(d.styleUpdates[0]).toMatchObject({ targets: ['a'], params: { bgColor: 'red', fontColor: 'white' } });
    expect(d.styleUpdates[1].targets).toEqual(['a', 'b']);
    expect(d.styleUpdates[2].params).toEqual({ c4ShapeInRow: '2', c4BoundaryInRow: '1' });
    expect(ids(C4('UpdateElementStyle(a, $bgColor="red")\nUpdateRelStyle(a, b, $textColor="blue")'))).not.toContain('styleUnknownTarget');
  });
  it('warns for unknown aliases, missing relationships and reversed direction', () => {
    const w = (extra: string) => lint(C4(extra)).filter((d) => d.ruleId === 'styleUnknownTarget');
    expect(w('UpdateElementStyle(zzz, $bgColor="red")')).toHaveLength(1);
    expect(w('UpdateRelStyle(a, zzz, $textColor="red")')).toHaveLength(1);
    expect(w('UpdateRelStyle(a, c, $textColor="red")')).toHaveLength(1);
    expect(w('UpdateRelStyle(b, a, $textColor="red")')).toHaveLength(1);
    expect(w('UpdateRelStyle(a, b, $textColor="red")')).toHaveLength(0);
  });
});
