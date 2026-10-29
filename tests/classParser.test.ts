import { describe, it, expect } from 'vitest';
import { parseClassDiagram } from '../src/core/parser/classParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isClassDiagram } from '../src/core/diagram/types';

describe('parseClassDiagram', () => {
  it('parses a class with a body of members', () => {
    const diagram = parseClassDiagram(`classDiagram
class Animal {
  +String name
  +makeSound()
}`);
    expect(diagram.classes.size).toBe(1);
    const animal = diagram.classes.get('Animal')!;
    expect(animal.members).toHaveLength(2);
    expect(animal.members[0]).toMatchObject({ visibility: '+', isMethod: false });
    expect(animal.members[1]).toMatchObject({ visibility: '+', isMethod: true });
  });

  it('parses a stereotype inside a class body', () => {
    const diagram = parseClassDiagram(`classDiagram
class Shape {
  <<interface>>
  +area()
}`);
    expect(diagram.classes.get('Shape')?.stereotype).toBe('interface');
  });

  it('parses the inline stereotype syntax', () => {
    const diagram = parseClassDiagram('classDiagram\n<<interface>> Shape');
    expect(diagram.classes.get('Shape')?.stereotype).toBe('interface');
  });

  it('parses inheritance relationships', () => {
    const diagram = parseClassDiagram('classDiagram\nAnimal <|-- Dog');
    expect(diagram.relationships).toHaveLength(1);
    expect(diagram.relationships[0]).toMatchObject({ from: 'Animal', to: 'Dog', type: 'inheritance' });
  });

  it('distinguishes relationship types', () => {
    const diagram = parseClassDiagram(`classDiagram
A <|-- B
A *-- C
A o-- D
A --> E
A ..> F
A ..|> G`);
    expect(diagram.relationships.map((r) => r.type)).toEqual([
      'inheritance',
      'composition',
      'aggregation',
      'association',
      'dependency',
      'realization',
    ]);
  });

  it('parses cardinalities and a trailing label', () => {
    const diagram = parseClassDiagram('classDiagram\nOrder "1" *-- "many" LineItem : contains');
    const r = diagram.relationships[0];
    expect(r.fromCardinality).toBe('1');
    expect(r.toCardinality).toBe('many');
    expect(r.label).toBe('contains');
  });

  it('implicitly declares classes referenced only in a relationship', () => {
    const diagram = parseClassDiagram('classDiagram\nA --> B');
    expect(diagram.classes.size).toBe(2);
  });

  it('parses member addition via colon syntax outside a body', () => {
    const diagram = parseClassDiagram('classDiagram\nclass Animal\nAnimal : +String name');
    expect(diagram.classes.get('Animal')?.members).toHaveLength(1);
  });

  it('parses a note for a class', () => {
    const diagram = parseClassDiagram('classDiagram\nclass Animal\nnote for Animal "A living thing"');
    expect(diagram.notes).toHaveLength(1);
    expect(diagram.notes[0]).toMatchObject({ target: 'Animal', text: 'A living thing' });
  });

  it('flags an unclosed class body', () => {
    const diagram = parseClassDiagram('classDiagram\nclass Animal {\n+makeSound()');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseClassDiagram('classDiagram\n@@@ garbage @@@\nA --> B')).not.toThrow();
  });
});

describe('parseMermaid routes classDiagram to the structural parser', () => {
  it('produces a ClassDiagram, not the light fallback', () => {
    const diagram = parseMermaid('classDiagram\nAnimal <|-- Dog');
    expect(isClassDiagram(diagram)).toBe(true);
    if (isClassDiagram(diagram)) {
      expect(diagram.relationships).toHaveLength(1);
    }
  });
});
