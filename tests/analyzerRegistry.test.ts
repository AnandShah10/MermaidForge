import { describe, it, expect } from 'vitest';
import { LANGUAGES, runAnalysis, globForLanguage } from '../src/analyzers/registry';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });

describe('registry', () => {
  it('offers imports/classes/calls for every language, plus react/express for TS/JS', () => {
    for (const l of LANGUAGES) {
      const kinds = l.analyses.map((a) => a.kind);
      expect(kinds).toEqual(expect.arrayContaining(['imports', 'classes', 'calls']));
    }
    expect(LANGUAGES.find((l) => l.id === 'typescript')!.analyses.map((a) => a.kind)).toEqual(expect.arrayContaining(['react', 'express']));
    expect(LANGUAGES.map((l) => l.id)).toEqual(['typescript', 'python', 'rust', 'cpp', 'java', 'csharp', 'go', 'kotlin', 'swift', 'php', 'ruby']);
    for (const id of ['python', 'java', 'csharp', 'go', 'kotlin', 'swift', 'php', 'ruby']) {
      expect(LANGUAGES.find((l) => l.id === id)!.analyses.map((a) => a.kind)).toContain('routes');
    }
  });
  it('builds brace globs from extensions', () => {
    expect(globForLanguage(LANGUAGES.find((l) => l.id === 'python')!)).toBe('**/*.{py}');
    expect(globForLanguage(LANGUAGES.find((l) => l.id === 'cpp')!)).toContain('hpp');
  });
  it('rejects unknown language/kind combos without throwing', () => {
    expect(runAnalysis('cobol', 'imports', []).mermaid).toBeNull();
    expect(runAnalysis('python', 'react', []).mermaid).toBeNull();
  });
  it('returns an explanatory note (not an empty diagram) when nothing is found', () => {
    for (const l of LANGUAGES) for (const a of l.analyses) {
      const out = runAnalysis(l.id, a.kind, [f('empty.txt', '')]);
      if (a.kind === 'imports') continue; // file nodes still exist; edges just empty
      expect(out.mermaid).toBeNull();
      expect(out.note).toBeTruthy();
    }
  });
  it('flags graphs with nodes but no resolvable relationships', () => {
    const out = runAnalysis('python', 'imports', [f('a.py', 'import os\n')]);
    expect(out.mermaid).toContain('flowchart');
    expect(out.note).toMatch(/no relationships/i);
  });
  it('class outputs parse as class diagrams with our own parser', () => {
    const out = runAnalysis('python', 'classes', [f('a.py', 'class A:\n    x: int = 1\n    def m(self, a): pass\nclass B(A): pass\n')]);
    const parsed = parseMermaid(out.mermaid!);
    expect(parsed.kind).toBe('classDiagram');
  });
  it('React and Express outputs use top-down/shaped nodes', () => {
    const react = runAnalysis('typescript', 'react', [f('a.tsx', 'const A = () => <B/>;\nconst B = () => <i/>;')]);
    expect(react.mermaid!.startsWith('flowchart TD')).toBe(true);
    const ex = runAnalysis('typescript', 'express', [f('a.js', `const express = require('express');\nconst app = express();\napp.get('/x', h);`)]);
    expect(ex.mermaid).toContain('(["app app');
    expect(ex.mermaid).toContain('GET /x');
  });

  it('routes analyses are reachable through the registry for Python, Java, C# and render parseable Mermaid', () => {
    const cases: Array<[string, Array<{ path: string; text: string }>, RegExp]> = [
      ['python', [f('app.py', 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/hi")\ndef hi():\n    pass\n')], /GET \/hi/],
      ['java', [f('A.java', 'import org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/api")\npublic class A {\n  @GetMapping("/x")\n  public String x() { return ""; }\n}\n')], /\/api\/x/],
      ['csharp', [f('P.cs', 'var app = WebApplication.Create();\napp.MapGet("/ping", () => "ok");\n')], /\/ping/],
    ];
    for (const [lang, files, re] of cases) {
      const out = runAnalysis(lang, 'routes', files);
      expect(out.mermaid, lang).not.toBeNull();
      expect(out.mermaid!, lang).toMatch(re);
      expect(parseMermaid(out.mermaid!).kind, lang).toBe('flowchart');
    }
  });

  it('warns (without refusing) when a generated graph is very large', () => {
    const files = [];
    for (let i = 0; i < 30; i++) {
      files.push(f(`m${i}.py`, Array.from({ length: 30 }, (_, j) => `import m${(i + j + 1) % 30}`).join('\n')));
    }
    const out = runAnalysis('python', 'imports', files);
    expect(out.mermaid).not.toBeNull();
    expect(out.note).toMatch(/edges.*smaller folder/);
  });
});

describe('ambiguous call edges are explained', () => {
  it('runAnalysis draws them dotted and says why', () => {
    const out = runAnalysis('typescript', 'calls', [
      { path: 'a.ts', text: 'function go() { init(); }' },
      { path: 'b.ts', text: 'function init() {}' },
      { path: 'c.ts', text: 'function init() {}' },
    ]);
    expect(out.mermaid).toContain('-.->');
    expect(out.note).toMatch(/2 dotted edges/);
    const clean = runAnalysis('typescript', 'calls', [{ path: 'a.ts', text: 'function go() { init(); }\nfunction init() {}' }]);
    expect(clean.mermaid).not.toContain('-.->');
    expect(clean.note).toBeUndefined();
  });
});
