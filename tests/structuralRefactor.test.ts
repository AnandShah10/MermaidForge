import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { removeUnusedNodes, extractSubgraph } from '../src/core/refactoring/refactoring';

const unused = (src: string) => removeUnusedNodes(parseMermaid(src)) as any;
const extract = (src: string, ids: string[], id = 'G', title = 'Group') => extractSubgraph(parseMermaid(src), ids, id, title) as any;

describe('remove unused: class', () => {
  const src = `classDiagram
class Animal {
  +name string
}
class Dog
class Lonely {
  +x int
}
class Loner2
Loner2 : +y int
note for Lonely "orphan"
cssClass "Animal,Lonely" hot
Animal <|-- Dog`;
  it('removes relationship-free classes with their bodies, members, notes and css entries', () => {
    const r = unused(src);
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toMatch(/Lonely|Loner2/);
    expect(r.newSource).toContain('cssClass "Animal" hot');
    expect(r.newSource).toContain('Animal <|-- Dog');
    expect(r.newSource).toContain('+name string');
    const re: any = parseMermaid(r.newSource);
    expect([...re.classes.keys()].sort()).toEqual(['Animal', 'Dog']);
  });
});

describe('remove unused: ER, state, requirement, C4, architecture', () => {
  it('ER', () => {
    const r = unused('erDiagram\nA ||--o{ B : has\nORPHAN {\n  int id PK\n}\nB {\n  int id\n}');
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toContain('ORPHAN');
    expect(r.newSource).toContain('B {');
  });
  it('state: keeps [*], composites and connected states', () => {
    const r = unused('stateDiagram-v2\n[*] --> A\nA --> B\nstate "Floating" as F\nstate Comp {\n  X --> Y\n}');
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toContain('Floating');
    expect(r.newSource).toContain('state Comp {');
    expect(r.newSource).toContain('[*] --> A');
  });
  it('requirement (block body removed)', () => {
    const r = unused('requirementDiagram\nrequirement r1 {\nid: 1\ntext: t\nrisk: low\nverifymethod: test\n}\nrequirement lonely {\nid: 2\ntext: t\nrisk: low\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1');
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toContain('lonely');
    expect(r.newSource).toContain('requirement r1 {');
    expect(r.newSource).toContain('e1 - satisfies -> r1');
  });
  it('C4 (and its style line)', () => {
    const r = unused('C4Context\nPerson(u,"U")\nSystem(s,"S")\nSystem(x,"X")\nRel(u,s,"uses")\nUpdateElementStyle(x, $bgColor="red")');
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toMatch(/\bx\b/);
    expect(r.newSource).toContain('Rel(u,s,"uses")');
  });
  it('architecture: services only, never groups', () => {
    const r = unused('architecture-beta\ngroup g(cloud)[G]\nservice a(server)[A] in g\nservice b(server)[B] in g\nservice c(server)[C]\na:R -- L:b');
    expect(r.ok).toBe(true);
    expect(r.newSource).not.toContain('service c');
    expect(r.newSource).toContain('group g(cloud)[G]');
  });
  it('reports nothing-to-do and unsupported kinds', () => {
    expect(unused('classDiagram\nA <|-- B').ok).toBe(false);
    expect(unused('pie\n"a":1').ok).toBe(false);
  });
  it('never removes the only node', () => {
    expect(unused('classDiagram\nclass Only').ok).toBe(false);
  });
});

describe('extract into group', () => {
  it('class -> namespace, moving bodies and keeping relationships', () => {
    const src = 'classDiagram\nclass A {\n  +x int\n}\nclass B\nclass C\nA <|-- B\nB --> C';
    const r = extract(src, ['A', 'B'], 'core');
    expect(r.ok).toBe(true);
    expect(r.newSource).toContain('namespace core {');
    expect(r.newSource).toMatch(/namespace core \{\n  class A \{\n  \+x int\n  \}\n  class B\n\}/);
    expect(r.newSource).toContain('A <|-- B');
    const re: any = parseMermaid(r.newSource);
    expect(re.relationships).toHaveLength(2);
  });
  it('class: refuses when member lines live elsewhere', () => {
    const r = extract('classDiagram\nclass A\nA : +x int\nclass B\nA <|-- B', ['A'], 'ns');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('member');
  });
  it('C4 -> Boundary', () => {
    const r = extract('C4Container\nPerson(u,"U")\nContainer(w,"Web","JS")\nContainer(a,"Api","Go")\nRel(u,w,"x")\nRel(w,a,"y")', ['w', 'a'], 'sys', 'My System');
    expect(r.ok).toBe(true);
    expect(r.newSource).toContain('Boundary(sys, "My System") {');
    const re: any = parseMermaid(r.newSource);
    expect(re.elements.filter((e: any) => e.boundary === 'sys').map((e: any) => e.alias)).toEqual(['w', 'a']);
    expect(re.parseIssues).toEqual([]);
  });
  it('architecture -> group + `in`', () => {
    const r = extract('architecture-beta\nservice a(server)[A]\nservice b(server)[B]\nservice c(server)[C]\na:R -- L:b\nb:R -- L:c', ['a', 'b'], 'grp', 'Backend');
    expect(r.ok).toBe(true);
    expect(r.newSource).toContain('group grp(cloud)[Backend]');
    const re: any = parseMermaid(r.newSource);
    expect(re.nodes.filter((n: any) => n.parent === 'grp').map((n: any) => n.id)).toEqual(['a', 'b']);
  });
  it('rejects already-grouped items, clashes and unsupported kinds', () => {
    expect(extract('architecture-beta\ngroup g(cloud)[G]\nservice a(server)[A] in g\nservice b(server)[B]', ['a'], 'x').ok).toBe(false);
    expect(extract('architecture-beta\nservice a(server)[A]', ['a'], 'a').ok).toBe(false);
    expect(extract('erDiagram\nA ||--o{ B : x', ['A'], 'g').ok).toBe(false);
  });
});

describe('extract into group: state and block', () => {
  const ex = (src: string, ids: string[], g = 'grp') => extractSubgraph(parseMermaid(src), ids, g, 'T');

  it('state: moves internal transitions into a composite placed at the first mention', () => {
    const r = ex('stateDiagram-v2\n[*] --> A\nA --> B\nB --> C\nC --> D\nD --> [*]', ['B', 'C'], 'mid');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newSource).toBe('stateDiagram-v2\n[*] --> A\n  state mid {\n    B --> C\n  }\nA --> B\nC --> D\nD --> [*]');
    const d = parseMermaid(r.newSource);
    if (d.kind !== 'stateDiagram') throw new Error('kind');
    expect(d.states.get('B')?.parentId).toBe('mid');
    expect(d.states.get('C')?.parentId).toBe('mid');
  });
  it('state: declares a selected state inside when it only appears in crossing transitions', () => {
    const r = ex('stateDiagram-v2\n[*] --> A\nA --> B\nB --> C', ['B']);
    expect(r.ok && r.newSource).toContain('state grp {\n    B\n  }');
  });
  it('state: refuses when a note targets a selected state, and rejects composite/[*]', () => {
    const r = ex('stateDiagram-v2\nA --> B\nnote right of B : hi', ['B']);
    expect(r.ok).toBe(false);
    expect(ex('stateDiagram-v2\nstate P {\n A --> B\n}\n[*] --> P', ['P']).ok).toBe(false);
    expect(ex('stateDiagram-v2\n[*] --> A', ['[*]']).ok).toBe(false);
  });
  it('state: refuses an existing id as the group name', () => {
    expect(ex('stateDiagram-v2\nA --> B', ['A'], 'B').ok).toBe(false);
  });
  it('block: moves whole rows into block:Id … end', () => {
    const r = ex('block-beta\ncolumns 3\nA B C\nD:2 E\nA --> D', ['D', 'E'], 'low');
    expect(r.ok && r.newSource).toBe('block-beta\ncolumns 3\nA B C\nblock:low\n  D:2 E\nend\nA --> D');
  });
  it('block: refuses when a row contains an unselected block', () => {
    const r = ex('block-beta\ncolumns 3\nA B C', ['A']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('shares line');
  });
  it('ER, requirement and mindmap say there is no grouping syntax', () => {
    const r = ex('erDiagram\nA ||--o{ B : x', ['A']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no grouping syntax');
  });
});
