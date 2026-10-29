import { describe, it, expect } from 'vitest';
import { parseStateDiagram } from '../src/core/parser/stateParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isStateDiagram } from '../src/core/diagram/types';
import { analyzeComplexity } from '../src/core/complexity/complexity';

describe('parseStateDiagram', () => {
  it('parses simple transitions including [*]', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\n[*] --> Still\nStill --> Moving\nMoving --> [*]');
    expect(diagram.transitions).toHaveLength(3);
    expect(diagram.states.has('[*start]')).toBe(true);
    expect(diagram.states.has('[*end]')).toBe(true);
    expect(diagram.states.has('[*]')).toBe(false);
    expect(diagram.states.has('Still')).toBe(true);
    expect(diagram.states.has('Moving')).toBe(true);
  });

  it('parses a transition label', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nStill --> Moving : Accelerate');
    expect(diagram.transitions[0].label).toBe('Accelerate');
  });

  it('accepts the legacy "stateDiagram" header (no -v2 suffix)', () => {
    const diagram = parseStateDiagram('stateDiagram\nA --> B');
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('parses an aliased state', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nstate "Loading Data" as s1\n[*] --> s1');
    expect(diagram.states.get('s1')?.label).toBe('Loading Data');
  });

  it('parses a composite state and tracks parentId on its children', () => {
    const diagram = parseStateDiagram(`stateDiagram-v2
state Active {
  [*] --> NumLockOff
  NumLockOff --> NumLockOn
}`);
    const active = diagram.states.get('Active')!;
    expect(active.kind).toBe('composite');
    expect(diagram.states.get('NumLockOff')?.parentId).toBe('Active');
    expect(diagram.states.get('NumLockOn')?.parentId).toBe('Active');
  });

  it('parses nested composite states', () => {
    const diagram = parseStateDiagram(`stateDiagram-v2
state Outer {
  state Inner {
    [*] --> A
  }
}`);
    expect(diagram.states.get('Inner')?.parentId).toBe('Outer');
    expect(diagram.states.get('A')?.parentId).toBe('Inner');
  });

  it('parses pseudostate declarations (choice/fork/join)', () => {
    const diagram = parseStateDiagram(`stateDiagram-v2
state choice1 <<choice>>
state fork1 <<fork>>
state join1 <<join>>`);
    expect(diagram.states.get('choice1')?.kind).toBe('choice');
    expect(diagram.states.get('fork1')?.kind).toBe('fork');
    expect(diagram.states.get('join1')?.kind).toBe('join');
  });

  it('parses a single-line note', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of A : This is a note');
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0]).toMatchObject({ target: 'A', text: 'This is a note' });
  });

  it('parses a multi-line note block', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nA --> B\nnote left of A\n  line one\n  line two\nend note');
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0].text).toBe('  line one\n  line two');
  });

  it('flags an unclosed composite state', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nstate Active {\n[*] --> A');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('flags an unclosed note block', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of A\nunterminated');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('ignores a bare "--" concurrency separator without misparsing it', () => {
    const diagram = parseStateDiagram('stateDiagram-v2\nstate Active {\n[*] --> A\n--\n[*] --> B\n}');
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(diagram.states.has('A')).toBe(true);
    expect(diagram.states.has('B')).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseStateDiagram('stateDiagram-v2\n@@@ garbage @@@\nA --> B')).not.toThrow();
  });
});

describe('parseMermaid routes stateDiagram to the structural parser', () => {
  it('produces a StateDiagram, not the light fallback', () => {
    const diagram = parseMermaid('stateDiagram-v2\n[*] --> Idle');
    expect(isStateDiagram(diagram)).toBe(true);
    if (isStateDiagram(diagram)) {
      expect(diagram.transitions).toHaveLength(1);
    }
  });
});


describe('[*] scoping', () => {
  const src = `stateDiagram-v2
[*] --> Idle
Idle --> Busy
Busy --> [*]
state Busy {
  [*] --> Working
  Working --> [*]
  --
  [*] --> Logging
}
state Other {
  [*] --> X
}`;
  it('gives start and end separate ids, per composite and per concurrent region', () => {
    const d = parseStateDiagram(src);
    const ids = [...d.states.keys()].filter((id) => id.startsWith('[')).sort();
    expect(ids).toEqual(['[*end]', '[*end]@Busy', '[*start]', '[*start]@Busy', '[*start]@Busy#2', '[*start]@Other']);
    expect(d.states.get('[*start]@Busy')?.parentId).toBe('Busy');
    expect(d.states.get('[*start]')?.label).toBe('[*]');
    expect(d.states.get('[*start]')?.kind).toBe('startOrEnd');
  });
  it('wires transitions to the right marker', () => {
    const d = parseStateDiagram(src);
    const t = (from: string, to: string) => d.transitions.some((x) => x.from === from && x.to === to);
    expect(t('[*start]', 'Idle')).toBe(true);
    expect(t('Busy', '[*end]')).toBe(true);
    expect(t('[*start]@Busy', 'Working')).toBe(true);
    expect(t('Working', '[*end]@Busy')).toBe(true);
    expect(t('[*start]@Busy#2', 'Logging')).toBe(true);
    expect(t('[*start]@Other', 'X')).toBe(true);
  });
  it('a plain start -> ... -> end flow is no longer reported as a cycle by complexity', () => {
    const r: any = analyzeComplexity(parseMermaid('stateDiagram-v2\n[*] --> A\nA --> B\nB --> [*]'));
    expect(r.cycles).toHaveLength(0);
    expect(r.longestPathLength).toBe(3);
  });
  it('a real loop is still a cycle', () => {
    const r: any = analyzeComplexity(parseMermaid('stateDiagram-v2\n[*] --> A\nA --> B\nB --> A'));
    expect(r.cycles.length).toBeGreaterThan(0);
  });
});
