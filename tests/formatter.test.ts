import { describe, it, expect } from 'vitest';
import { formatMermaid } from '../src/core/formatter/formatter';

describe('formatMermaid', () => {
  it('normalizes spacing for a simple flowchart', () => {
    const input = 'flowchart   TD\nA[Start]-->B[End]';
    const output = formatMermaid(input);
    expect(output).toContain('flowchart TD');
    expect(output).toContain('A[Start]');
    expect(output).toContain('B[End]');
    expect(output).toContain('A --> B');
  });

  it('is idempotent', () => {
    const input = 'flowchart TD\n  A[Start] --> B{Check}\n  B -->|Yes| C[Done]\n  B -->|No| A';
    const once = formatMermaid(input);
    const twice = formatMermaid(once);
    expect(twice).toBe(once);
  });

  it('preserves subgraph structure', () => {
    const input = `flowchart TD
subgraph Backend [Backend]
  A[API] --> B[(DB)]
end`;
    const output = formatMermaid(input);
    expect(output).toContain('subgraph Backend [Backend]');
    expect(output).toContain('end');
  });

  it('falls back to whitespace normalization for unsupported diagram types', () => {
    const input = 'sequenceDiagram   \nAlice->>Bob: Hi   ';
    const output = formatMermaid(input);
    expect(output).not.toMatch(/ +\n/);
  });

  it('does not reformat a flowchart that fails to parse (keeps it conservative)', () => {
    const input = 'flowchart TD\nsubgraph Unclosed\nA-->B';
    const output = formatMermaid(input);
    // Falls back to whitespace-only normalization rather than guessing structure.
    expect(output.replace(/\s+/g, ' ').trim()).toBe(input.replace(/\s+/g, ' ').trim());
  });
});

describe('formatMermaid: block-aware indentation for non-flowchart kinds', () => {
  const corpus: Record<string, string> = {
    sequence: 'sequenceDiagram\nparticipant A\nloop every day\nA->>B: hi\nalt ok\nB-->>A: yes\nelse no\nB-->>A: no\nend\nend\nNote over A,B: done',
    seqPar: 'sequenceDiagram\n  par one\n      A->>B: x\n  and two\nA->>C: y\n  end\nrect rgb(1,2,3)\nA->>B: z\nend',
    class: 'classDiagram\nclass Animal {\n+name string\n    +eat() void\n}\nnamespace Zoo {\nclass Cat {\n+purr()\n}\nclass Dog\n}\nAnimal <|-- Cat',
    er: 'erDiagram\nCUSTOMER ||--o{ ORDER : places\n    CUSTOMER {\nstring name PK\n}',
    state: 'stateDiagram-v2\n[*] --> A\nstate A {\n[*] --> B\nB --> C\n--\nD --> E\n}\nnote right of A\ntext\nend note\nA --> F : go {',
    requirement: 'requirementDiagram\nrequirement r1 {\nid: 1\ntext: hello\nrisk: low\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1',
    c4: 'C4Container\nBoundary(b, "B") {\nContainer(w, "Web", "JS")\nBoundary(c, "C") {\nContainer(d, "Db", "SQL")\n}\n}\nRel(w, d, "x")',
    block: 'block-beta\ncolumns 3\nA B\nblock:grp\nC D\nend\nA --> C',
    gantt: 'gantt\ntitle T\ndateFormat YYYY-MM-DD\nsection One\nTask a :a1, 2024-01-01, 3d\nTask b :after a1, 2d\nsection Two\nTask c :2024-02-01, 1d',
    journey: 'journey\ntitle Day\nsection Morning\nWake: 3: Me\nCoffee: 5: Me',
    timeline: 'timeline\ntitle History\nsection Early\n2002 : LinkedIn\n2004 : Facebook : Google',
  };
  const strip = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');

  for (const [name, src] of Object.entries(corpus)) {
    it(`${name}: changes only leading/trailing whitespace, keeps line order, and is idempotent`, () => {
      const out = formatMermaid(src);
      expect(strip(out)).toBe(strip(src));
      expect(formatMermaid(out)).toBe(out);
    });
  }

  it('indents sequence blocks and dedents else/end', () => {
    expect(formatMermaid(corpus.sequence)).toBe(
      'sequenceDiagram\n  participant A\n  loop every day\n    A->>B: hi\n    alt ok\n      B-->>A: yes\n    else no\n      B-->>A: no\n    end\n  end\n  Note over A,B: done',
    );
  });
  it('indents class bodies and namespaces without nesting member lines', () => {
    expect(formatMermaid(corpus.class)).toBe(
      'classDiagram\n  class Animal {\n    +name string\n    +eat() void\n  }\n  namespace Zoo {\n    class Cat {\n      +purr()\n    }\n    class Dog\n  }\n  Animal <|-- Cat',
    );
  });
  it('indents state composites, regions and multi-line notes; a label ending in { is not a block', () => {
    const out = formatMermaid(corpus.state);
    expect(out).toContain('  state A {\n    [*] --> B\n    B --> C\n    --\n    D --> E\n  }\n  note right of A\n    text\n  end note\n  A --> F : go {');
  });
  it('respects indentSize and leaves frontmatter and multi-line init directives alone', () => {
    const src = '---\ntitle: T\n---\n%%{init: {\n"theme": "dark"\n}}%%\nsequenceDiagram\nloop x\nA->>B: y\nend';
    expect(formatMermaid(src, { indentSize: 4 })).toBe('---\ntitle: T\n---\n%%{init: {\n"theme": "dark"\n}}%%\nsequenceDiagram\n    loop x\n        A->>B: y\n    end');
  });
  it('message text beginning with a block keyword is not treated as a block', () => {
    expect(formatMermaid('sequenceDiagram\nloop->>end: x\nA->>B: y')).toBe('sequenceDiagram\n  loop->>end: x\n  A->>B: y');
  });
  it('mindmap (indentation-sensitive) is only trimmed', () => {
    expect(formatMermaid('mindmap\n  root   \n    a\n      b')).toBe('mindmap\n  root\n    a\n      b');
  });
  it('flowchart labels containing quotes use #quot; (Mermaid has no backslash escape)', () => {
    const out = formatMermaid('flowchart TD\nA["say #quot;hi#quot; (x)"]-->B');
    expect(out).not.toContain('\\"');
  });
});
