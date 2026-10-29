import { describe, it, expect } from 'vitest';
import { analyzeClasses } from '../src/analyzers/typescript/classDiagramAnalyzer';

describe('analyzeClasses', () => {
  it('extracts a class with public/private members', () => {
    const { classes } = analyzeClasses([
      { path: 'a.ts', text: `class Animal {\n  private name: string;\n  public makeSound(): void {}\n}` },
    ]);
    expect(classes).toHaveLength(1);
    expect(classes[0].id).toBe('Animal');
    expect(classes[0].members).toContain('-name string');
    expect(classes[0].members).toContain('+makeSound() void');
  });

  it('defaults unmarked members to public visibility', () => {
    const { classes } = analyzeClasses([{ path: 'a.ts', text: `class Animal {\n  bark() {}\n}` }]);
    expect(classes[0].members).toContain('+bark()');
  });

  it('marks protected members', () => {
    const { classes } = analyzeClasses([{ path: 'a.ts', text: `class Animal {\n  protected age: number;\n}` }]);
    expect(classes[0].members).toContain('#age number');
  });

  it('marks static members', () => {
    const { classes } = analyzeClasses([{ path: 'a.ts', text: `class Counter {\n  static count: number;\n}` }]);
    expect(classes[0].members).toContain('+count number$');
  });

  it('extracts an inheritance relationship', () => {
    const { classes, relationships } = analyzeClasses([
      { path: 'a.ts', text: `class Animal {}\nclass Dog extends Animal {}` },
    ]);
    expect(classes.map((c) => c.id).sort()).toEqual(['Animal', 'Dog']);
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Animal', type: 'inheritance' });
  });

  it('extracts a realization (implements) relationship', () => {
    const { relationships } = analyzeClasses([
      { path: 'a.ts', text: `interface Shape {}\nclass Circle implements Shape {}` },
    ]);
    expect(relationships).toContainEqual({ from: 'Circle', to: 'Shape', type: 'realization' });
  });

  it('marks interfaces with the <<interface>> stereotype', () => {
    const { classes } = analyzeClasses([{ path: 'a.ts', text: `interface Shape {\n  area(): number;\n}` }]);
    expect(classes[0].stereotype).toBe('interface');
    expect(classes[0].members).toContain('+area() number');
  });

  it('extracts interface-to-interface extension', () => {
    const { relationships } = analyzeClasses([{ path: 'a.ts', text: `interface Shape {}\ninterface Circle extends Shape {}` }]);
    expect(relationships).toContainEqual({ from: 'Circle', to: 'Shape', type: 'inheritance' });
  });

  it('extracts declarations across multiple files', () => {
    const { classes, relationships } = analyzeClasses([
      { path: 'animal.ts', text: `export class Animal {}` },
      { path: 'dog.ts', text: `import { Animal } from './animal';\nexport class Dog extends Animal {}` },
    ]);
    expect(classes.map((c) => c.id).sort()).toEqual(['Animal', 'Dog']);
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Animal', type: 'inheritance' });
  });

  it('does not duplicate a class re-declared across files (keeps the first)', () => {
    const { classes } = analyzeClasses([
      { path: 'a.ts', text: `export class Shared {\n  x: number;\n}` },
      { path: 'b.ts', text: `export class Shared {\n  y: number;\n}` },
    ]);
    expect(classes).toHaveLength(1);
  });

  it('does not throw on a syntactically broken file', () => {
    expect(() => analyzeClasses([{ path: 'broken.ts', text: `class {{{` }])).not.toThrow();
  });
});
