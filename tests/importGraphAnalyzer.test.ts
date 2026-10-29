import { describe, it, expect } from 'vitest';
import { typeScriptImportGraphAnalyzer } from '../src/analyzers/typescript/importGraphAnalyzer';

describe('typeScriptImportGraphAnalyzer', () => {
  it('resolves a relative import to another file in the set', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.ts', text: `import { helper } from './helper';\nhelper();` },
      { path: 'src/helper.ts', text: `export function helper() {}` },
    ]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: 'src/index.ts', to: 'src/helper.ts', kind: 'import' }]);
  });

  it('resolves an import to an index file in a directory', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.ts', text: `import { widget } from './widgets';` },
      { path: 'src/widgets/index.ts', text: `export const widget = 1;` },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/index.ts', to: 'src/widgets/index.ts', kind: 'import' }]);
  });

  it('ignores external package imports', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([{ path: 'src/index.ts', text: `import * as vscode from 'vscode';` }]);
    expect(graph.edges).toHaveLength(0);
  });

  it('ignores relative imports that do not resolve within the given file set', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([{ path: 'src/index.ts', text: `import { x } from './nonexistent';` }]);
    expect(graph.edges).toHaveLength(0);
  });

  it('follows CommonJS require() calls', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.js', text: `const helper = require('./helper');` },
      { path: 'src/helper.js', text: `module.exports = {};` },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/index.js', to: 'src/helper.js', kind: 'import' }]);
  });

  it('follows dynamic import() calls', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.ts', text: `async function load() { await import('./lazy'); }` },
      { path: 'src/lazy.ts', text: `export const x = 1;` },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/index.ts', to: 'src/lazy.ts', kind: 'import' }]);
  });

  it('follows re-exports (export ... from)', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.ts', text: `export { helper } from './helper';` },
      { path: 'src/helper.ts', text: `export function helper() {}` },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/index.ts', to: 'src/helper.ts', kind: 'import' }]);
  });

  it('deduplicates multiple imports of the same target', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/index.ts', text: `import { a } from './helper';\nimport { b } from './helper';` },
      { path: 'src/helper.ts', text: `export const a = 1; export const b = 2;` },
    ]);
    expect(graph.edges).toHaveLength(1);
  });

  it('resolves .tsx files', () => {
    const graph = typeScriptImportGraphAnalyzer.analyze([
      { path: 'src/App.tsx', text: `import { Button } from './Button';` },
      { path: 'src/Button.tsx', text: `export const Button = () => null;` },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/App.tsx', to: 'src/Button.tsx', kind: 'import' }]);
  });

  it('does not throw on a syntactically broken file', () => {
    expect(() =>
      typeScriptImportGraphAnalyzer.analyze([{ path: 'src/broken.ts', text: `import { from '` }]),
    ).not.toThrow();
  });
});
