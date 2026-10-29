import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { lintDiagram, DEFAULT_LINT_CONFIG } from '../src/core/linter/linter';

describe('lintDiagram', () => {
  it('flags duplicate edges', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B\nA-->B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateEdge')).toBe(true);
  });

  it('flags isolated nodes', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B\nC[Isolated]');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('C'))).toBe(true);
  });

  it('does not flag legitimate entry/exit nodes with only one edge direction', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B-->C');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode')).toBe(false);
  });

  it('flags empty subgraphs', () => {
    const diagram = parseMermaid('flowchart TD\nsubgraph Empty\nend\nA-->B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'emptySubgraph')).toBe(true);
  });

  it('respects rule severity = off', () => {
    const diagram = parseMermaid('flowchart TD\nA-->B\nA-->B');
    const findings = lintDiagram(diagram, { ...DEFAULT_LINT_CONFIG, duplicateEdge: 'off' });
    expect(findings.some((f) => f.ruleId === 'duplicateEdge')).toBe(false);
  });

  it('surfaces parse errors as syntax diagnostics', () => {
    const diagram = parseMermaid('flowchart TD\nsubgraph Unclosed\nA-->B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });

  it('only reports syntax-level diagnostics for unsupported diagram types', () => {
    const diagram = parseMermaid('kanban\n  todo[Todo]\n    task1[Write tests]');
    const findings = lintDiagram(diagram);
    expect(findings.every((f) => f.ruleId === 'syntax')).toBe(true);
  });
});

describe('lintDiagram (sequenceDiagram)', () => {
  it('flags a participant that never sends or receives a message', () => {
    const diagram = parseMermaid('sequenceDiagram\nparticipant A\nparticipant B\nparticipant C\nA->>B: hi');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('C'))).toBe(true);
  });

  it('does not flag participants that are involved in messages', () => {
    const diagram = parseMermaid('sequenceDiagram\nA->>B: hi\nB-->>A: hi back');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode')).toBe(false);
  });

  it('surfaces an unclosed block as a syntax error', () => {
    const diagram = parseMermaid('sequenceDiagram\nloop Forever\nA->>B: ping');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});

describe('lintDiagram (classDiagram)', () => {
  it('flags a class with no relationships', () => {
    const diagram = parseMermaid('classDiagram\nA --> B\nclass C');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('"C"'))).toBe(true);
  });

  it('does not flag classes that participate in a relationship', () => {
    const diagram = parseMermaid('classDiagram\nA --> B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode')).toBe(false);
  });

  it('flags a duplicate member declaration within a class', () => {
    const diagram = parseMermaid('classDiagram\nclass A {\n+foo()\n+foo()\n}');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('surfaces an unclosed class body as a syntax error', () => {
    const diagram = parseMermaid('classDiagram\nclass A {\n+foo()');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});

describe('lintDiagram (erDiagram)', () => {
  it('flags an entity with no relationships', () => {
    const diagram = parseMermaid('erDiagram\nA ||--o{ B : has\nSTANDALONE');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('STANDALONE'))).toBe(true);
  });

  it('does not flag entities that participate in a relationship', () => {
    const diagram = parseMermaid('erDiagram\nA ||--o{ B : has');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode')).toBe(false);
  });

  it('flags a duplicate attribute name within an entity', () => {
    const diagram = parseMermaid('erDiagram\nA {\nstring name\nstring name\n}');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('surfaces an unclosed entity body as a syntax error', () => {
    const diagram = parseMermaid('erDiagram\nA {\nstring name');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});

describe('lintDiagram (stateDiagram)', () => {
  it('flags a state with no transitions', () => {
    const diagram = parseMermaid('stateDiagram-v2\n[*] --> A\nstate B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('"B"'))).toBe(true);
  });

  it('does not flag the shared [*] pseudostate as isolated', () => {
    const diagram = parseMermaid('stateDiagram-v2\n[*] --> A\nA --> [*]');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('[*]'))).toBe(false);
  });

  it('flags a duplicate transition', () => {
    const diagram = parseMermaid('stateDiagram-v2\nA --> B\nA --> B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateEdge')).toBe(true);
  });

  it('flags an empty composite state', () => {
    const diagram = parseMermaid('stateDiagram-v2\nstate Empty {\n}\nA --> B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'emptySubgraph')).toBe(true);
  });

  it('surfaces an unclosed composite state as a syntax error', () => {
    const diagram = parseMermaid('stateDiagram-v2\nstate Active {\nA --> B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});

describe('lintDiagram (pie)', () => {
  it('flags a duplicate slice label', () => {
    const diagram = parseMermaid('pie\n"Dogs" : 10\n"Dogs" : 20');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('flags a non-positive slice value', () => {
    const diagram = parseMermaid('pie\n"Dogs" : 0\n"Cats" : 10');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'pieNonPositiveValue')).toBe(true);
  });

  it('does not flag a normal diagram', () => {
    const diagram = parseMermaid('pie\n"Dogs" : 10\n"Cats" : 20');
    const findings = lintDiagram(diagram);
    expect(findings).toHaveLength(0);
  });
});

describe('lintDiagram (journey)', () => {
  it('flags a duplicate task within the same section', () => {
    const diagram = parseMermaid('journey\nsection A\nTask: 5: Me\nTask: 3: Me');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('does not flag the same task name in different sections', () => {
    const diagram = parseMermaid('journey\nsection A\nTask: 5: Me\nsection B\nTask: 3: Me');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(false);
  });

  it('flags a task with no actors', () => {
    const diagram = parseMermaid('journey\nTask: 5: ,');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'journeyMissingActors')).toBe(true);
  });
});

describe('lintDiagram (gitGraph)', () => {
  it('flags a branch with no commits', () => {
    const diagram = parseMermaid('gitGraph\ncommit\nbranch develop\ncheckout main\ncommit');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode' && f.message.includes('develop'))).toBe(true);
  });

  it('does not flag a branch that has a commit on it', () => {
    const diagram = parseMermaid('gitGraph\ncommit\nbranch develop\ncommit');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'unreachableNode')).toBe(false);
  });

  it('surfaces an unknown-branch checkout as a syntax error', () => {
    const diagram = parseMermaid('gitGraph\ncommit\ncheckout ghost');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});

describe('lintDiagram (timeline)', () => {
  it('flags a duplicate period label within the same section', () => {
    const diagram = parseMermaid('timeline\n2025 : Event A\n2025 : Event B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('does not flag a continuation line as a duplicate period', () => {
    const diagram = parseMermaid('timeline\n2025 : Event A\n    : Event B');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(false);
  });

  it('does not flag the same period label in different sections', () => {
    const diagram = parseMermaid('timeline\nsection A\n2025 : X\nsection B\n2025 : Y');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(false);
  });
});

describe('lintDiagram (mindmap)', () => {
  it('flags a node with no label text', () => {
    const diagram = parseMermaid('mindmap\n  root\n    ()');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'mindmapEmptyLabel')).toBe(true);
  });

  it('flags duplicate sibling labels under the same parent', () => {
    const diagram = parseMermaid('mindmap\n  root\n    Child\n    Child');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('does not flag the same label under different parents', () => {
    const diagram = parseMermaid('mindmap\n  root\n    A\n      Shared\n    B\n      Shared');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(false);
  });
});

describe('lintDiagram (gantt)', () => {
  it('flags a duplicate explicit task id', () => {
    const diagram = parseMermaid('gantt\nA :a1, 2024-01-01, 5d\nB :a1, 2024-01-06, 5d');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(true);
  });

  it('does not flag distinct task ids', () => {
    const diagram = parseMermaid('gantt\nA :a1, 2024-01-01, 5d\nB :b1, 2024-01-06, 5d');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'duplicateNode')).toBe(false);
  });

  it('flags a task that starts after itself', () => {
    const diagram = parseMermaid('gantt\nA :a1, after a1, 5d');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'invalidReference')).toBe(true);
  });

  it('surfaces an unknown "after" reference as a syntax error', () => {
    const diagram = parseMermaid('gantt\nA :after ghost, 5d');
    const findings = lintDiagram(diagram);
    expect(findings.some((f) => f.ruleId === 'syntax' && f.severity === 'error')).toBe(true);
  });
});
