import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { renameNode, renamableIds } from '../src/core/refactoring/refactoring';

function rn(src: string, a: string, b: string): string {
  const r = renameNode(parseMermaid(src), a, b);
  if (!r.ok) throw new Error(r.reason);
  return r.newSource;
}

describe('rename: flowchart (label-aware)', () => {
  it('does not touch label text', () => {
    expect(rn('flowchart TD\nA[A thing]-->B\nB-->|A to B| A', 'A', 'X')).toBe('flowchart TD\nX[A thing]-->B\nB-->|A to B| X');
  });
  it('handles arrows glued to ids and quoted labels', () => {
    expect(rn('flowchart LR\nA---B\nA==>B\nA-.->B\nB-->A["A"]', 'A', 'N1')).toBe('flowchart LR\nN1---B\nN1==>B\nN1-.->B\nB-->N1["A"]');
  });
  it('renames class/style/click lines and subgraph members, leaves comments', () => {
    const out = rn('flowchart TD\nsubgraph S[A group]\nA-->B\nend\nclass A hot\nstyle A fill:#f00\n%% A is the start\nclassDef hot fill:#f00', 'A', 'Z');
    expect(out).toContain('subgraph S[A group]');
    expect(out).toContain('Z-->B');
    expect(out).toContain('class Z hot');
    expect(out).toContain('style Z fill:#f00');
    expect(out).toContain('%% A is the start');
  });
  it('does not rename inside longer ids', () => {
    expect(rn('flowchart TD\nA-->AB\nAB-->A1\nA_1-->A', 'A', 'Q')).toBe('flowchart TD\nQ-->AB\nAB-->A1\nA_1-->Q');
  });
  it('leaves frontmatter and header alone', () => {
    expect(rn('---\ntitle: A\n---\nflowchart TD\nA-->B', 'A', 'Q')).toBe('---\ntitle: A\n---\nflowchart TD\nQ-->B');
  });
});

describe('rename: class diagrams', () => {
  const src = `classDiagram
class Animal {
  +name string
  +Animal clone()
}
class Dog
Animal <|-- Dog : Animal is the parent
Animal : +eat()
Dog "1" --> "*" Animal : owns
cssClass "Animal,Dog" hot
note for Animal "Animal note"`;
  it('renames declarations, relationships and member owners but not member bodies, labels or quotes', () => {
    const out = rn(src, 'Animal', 'Beast');
    expect(out).toContain('class Beast {');
    expect(out).toContain('  +Animal clone()');
    expect(out).toContain('Beast <|-- Dog : Animal is the parent');
    expect(out).toContain('Beast : +eat()');
    expect(out).toContain('Dog "1" --> "*" Beast : owns');
    expect(out).toContain('cssClass "Beast,Dog" hot');
    expect(out).toContain('note for Beast "Animal note"');
  });
  it('result still parses to the same shape', () => {
    const a: any = parseMermaid(src);
    const b: any = parseMermaid(rn(src, 'Animal', 'Beast'));
    expect([...b.classes.keys()].sort()).toEqual(['Beast', 'Dog']);
    expect(b.relationships.length).toBe(a.relationships.length);
    expect(b.parseIssues.length).toBe(a.parseIssues.length);
  });
  it('rejects clashes and unknown ids', () => {
    expect(renameNode(parseMermaid(src), 'Animal', 'Dog').ok).toBe(false);
    expect(renameNode(parseMermaid(src), 'Cat', 'Lion').ok).toBe(false);
  });
});

describe('rename: ER diagrams', () => {
  const src = `erDiagram
CUSTOMER ||--o{ ORDER : places
CUSTOMER {
  string name
  int CUSTOMER_ID PK
}
ORDER ||--|{ LINE-ITEM : contains`;
  it('renames entities, not attributes or labels', () => {
    const out = rn(src, 'CUSTOMER', 'CLIENT');
    expect(out).toContain('CLIENT ||--o{ ORDER : places');
    expect(out).toContain('CLIENT {');
    expect(out).toContain('int CUSTOMER_ID PK');
  });
  it('handles hyphenated entity names next to arrows', () => {
    const out = rn(src, 'LINE-ITEM', 'LINE');
    expect(out).toContain('ORDER ||--|{ LINE : contains');
  });
});

describe('rename: state diagrams', () => {
  const src = `stateDiagram-v2
[*] --> Idle
Idle --> Busy : Idle done
state Busy {
  [*] --> Working
  Working --> [*]
}
state "Long Idle" as Idle2
Idle : sleeping`;
  it('renames across transitions, composite bodies, descriptions', () => {
    const out = rn(src, 'Idle', 'Waiting');
    expect(out).toContain('[*] --> Waiting');
    expect(out).toContain('Waiting --> Busy : Idle done');
    expect(out).toContain('Waiting : sleeping');
    expect(out).toContain('state "Long Idle" as Idle2');
  });
  it('renames inside composite state', () => {
    const out = rn(src, 'Working', 'Active');
    expect(out).toContain('[*] --> Active');
    expect(out).toContain('Active --> [*]');
  });
  it('[*] is not renamable', () => {
    expect(renamableIds(parseMermaid(src))).not.toContain('[*]');
  });
});

describe('rename: sequence diagrams', () => {
  const src = `sequenceDiagram
participant A as Alice
participant B as Bob
A->>B: Hello A
B-->>A: hi
Note over A,B: A and B talk
activate A
deactivate A`;
  it('renames participants but not message text, notes text or aliases', () => {
    const out = rn(src, 'A', 'Alice1');
    expect(out).toContain('participant Alice1 as Alice');
    expect(out).toContain('Alice1->>B: Hello A');
    expect(out).toContain('B-->>Alice1: hi');
    expect(out).toContain('Note over Alice1,B: A and B talk');
    expect(out).toContain('activate Alice1');
  });
});

describe('rename: unsupported kinds', () => {
  it('reports a clear error', () => {
    const r = renameNode(parseMermaid('pie\n"a":1'), 'a', 'b');
    expect(r.ok).toBe(false);
  });
});

describe('rename: flowchart inline edge text and asymmetric shapes', () => {
  it('leaves `-- text -->` edge text alone', () => {
    expect(rn('flowchart LR\nA -- A to B --> B\nB -- go --> A', 'A', 'X')).toBe('flowchart LR\nX -- A to B --> B\nB -- go --> X');
  });
  it('handles == text ==> and -. text .-> and open links', () => {
    expect(rn('flowchart LR\nA == A big ==> B\nA -. A dotted .-> B\nA -- A open --- B', 'A', 'X')).toBe(
      'flowchart LR\nX == A big ==> B\nX -. A dotted .-> B\nX -- A open --- B',
    );
  });
  it('leaves `id>asymmetric]` shape text alone but renames the id', () => {
    expect(rn('flowchart LR\nA>A flag]-->B\nB-->A', 'A', 'X')).toBe('flowchart LR\nX>A flag]-->B\nB-->X');
  });
  it('still renames ids around plain arrows', () => {
    expect(rn('flowchart LR\nA --> B\nA --- B\nA -.-> B\nA ==> B', 'A', 'X')).toBe('flowchart LR\nX --> B\nX --- B\nX -.-> B\nX ==> B');
  });
});
