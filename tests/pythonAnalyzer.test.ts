import { describe, it, expect } from 'vitest';
import { analyzePythonClasses, pythonCallGraphAnalyzer, pythonImportGraphAnalyzer, parsePythonStructure } from '../src/analyzers/python/pythonAnalyzer';
import { scrub } from '../src/analyzers/common/scrubber';

const f = (path: string, text: string) => ({ path, text });

describe('python structure', () => {
  it('finds classes and methods with extents, ignoring defs nested in defs', () => {
    const src = 'class A:\n    def m(self):\n        def inner(): pass\n        return 1\n\ndef top(): pass\n';
    const { defs } = parsePythonStructure(scrub(src, 'python'));
    expect(defs.map((d) => `${d.kind}:${d.name}`)).toEqual(['class:A', 'def:m', 'def:top']);
  });
  it('ignores class/def keywords inside strings and comments', () => {
    const src = 'x = "class Fake:"\n# def nope():\ndef real(): pass\n';
    const { defs } = parsePythonStructure(scrub(src, 'python'));
    expect(defs.map((d) => d.name)).toEqual(['real']);
  });
  it('joins multi-line signatures', () => {
    const src = 'def f(\n    a,\n    b: int = 2,\n) -> int:\n    return a\n';
    const { defs } = parsePythonStructure(scrub(src, 'python'));
    expect(defs[0].header).toContain('-> int');
  });
});

describe('python classes', () => {
  const src = `
from abc import ABC, abstractmethod
from enum import Enum
from typing import Protocol

class Animal(ABC):
    legs: int = 4
    kingdom = "animalia"

    def __init__(self, name: str, age: int = 0):
        self.name = name
        self._age: int = age
        self.__secret = 1

    @abstractmethod
    def speak(self) -> str: ...

    @staticmethod
    def create(kind) -> "Animal":
        return None

    def _helper(self): pass
    def __private(self): pass

class Dog(Animal, Walker):
    def speak(self) -> str:
        return "woof"

class Color(Enum):
    RED = 1
    GREEN = 2

class Drawable(Protocol):
    def draw(self) -> None: ...
`;
  const { classes, relationships } = analyzePythonClasses([f('a.py', src)]);
  const byId = Object.fromEntries(classes.map((c) => [c.id, c]));

  it('extracts all classes', () => {
    expect(Object.keys(byId).sort()).toEqual(['Animal', 'Color', 'Dog', 'Drawable']);
  });
  it('captures class-level and __init__ attributes with visibility', () => {
    const m = byId.Animal.members;
    expect(m).toContain('+legs int');
    expect(m).toContain('+kingdom');
    expect(m).toContain('+name');
    expect(m).toContain('#_age int');
    expect(m).toContain('-__secret');
  });
  it('formats methods with params (no self), return type, visibility, static, abstract', () => {
    const m = byId.Animal.members;
    expect(m).toContain('+__init__(name, age)');
    expect(m).toContain('+speak() str*');
    // `-> "Animal"` is a string annotation, which the scrubber blanks, so no return type is shown.
    expect(m).toContain('+create(kind)$');
    expect(m).toContain('#_helper()');
    expect(m).toContain('-__private()');
  });
  it('marks stereotypes (ABC → abstract, Enum → enumeration, Protocol → interface)', () => {
    expect(byId.Animal.stereotype).toBe('abstract');
    expect(byId.Color.stereotype).toBe('enumeration');
    expect(byId.Drawable.stereotype).toBe('interface');
  });
  it('lists enum members as plain names', () => {
    expect(byId.Color.members).toEqual(['RED', 'GREEN']);
  });
  it('emits inheritance for real bases only', () => {
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Animal', type: 'inheritance' });
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Walker', type: 'inheritance' });
    expect(relationships.some((r) => r.to === 'ABC' || r.to === 'Enum' || r.to === 'Protocol')).toBe(false);
  });
  it('strips module qualifiers and subscripts from bases', () => {
    const r = analyzePythonClasses([f('b.py', 'class X(pkg.Base, Generic[T]): pass\n')]);
    expect(r.relationships.map((x) => x.to)).toEqual(['Base', 'Generic']);
  });
  it('ignores object and metaclass kwargs', () => {
    const r = analyzePythonClasses([f('b.py', 'class X(object, metaclass=Meta): pass\n')]);
    expect(r.relationships).toEqual([]);
  });
  it('de-duplicates classes with the same name across files', () => {
    const r = analyzePythonClasses([f('a.py', 'class X: pass\n'), f('b.py', 'class X: pass\n')]);
    expect(r.classes).toHaveLength(1);
  });
  it('tolerates empty files and syntax garbage', () => {
    expect(() => analyzePythonClasses([f('a.py', ''), f('b.py', 'class (((\n  def\n')])).not.toThrow();
  });
});

describe('python imports', () => {
  const files = [
    f('app/main.py', 'import app.utils\nfrom app.models import User\nfrom . import helpers\nimport os, sys\n'),
    f('app/utils.py', 'from .helpers import h\n'),
    f('app/helpers.py', ''),
    f('app/models/__init__.py', 'from .user import User\n'),
    f('app/models/user.py', 'from .. import helpers\n'),
  ];
  const g = pythonImportGraphAnalyzer.analyze(files);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === a && e.to === b);

  it('creates a node per file', () => expect(g.nodes).toHaveLength(5));
  it('resolves absolute module imports', () => expect(has('app/main.py', 'app/utils.py')).toBe(true));
  it('resolves package imports to __init__.py', () => expect(has('app/main.py', 'app/models/__init__.py')).toBe(true));
  it('resolves "from . import x" to the sibling module', () => expect(has('app/main.py', 'app/helpers.py')).toBe(true));
  it('resolves relative imports', () => {
    expect(has('app/utils.py', 'app/helpers.py')).toBe(true);
    expect(has('app/models/__init__.py', 'app/models/user.py')).toBe(true);
  });
  it('resolves parent-relative imports', () => expect(has('app/models/user.py', 'app/helpers.py')).toBe(true));
  it('ignores stdlib/external modules', () => expect(g.edges.every((e) => e.to.startsWith('app/'))).toBe(true));
  it('does not create duplicate edges or self edges', () => {
    const keys = g.edges.map((e) => `${e.from}>${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(g.edges.some((e) => e.from === e.to)).toBe(false);
  });
  it('handles parenthesised multi-line from-imports', () => {
    const gg = pythonImportGraphAnalyzer.analyze([f('a.py', 'from b import (\n    x,\n    y,\n)\n'), f('b.py', '')]);
    expect(gg.edges).toHaveLength(1);
  });
  it('ignores imports inside strings/comments', () => {
    const gg = pythonImportGraphAnalyzer.analyze([f('a.py', '# import b\ns = "import b"\n'), f('b.py', '')]);
    expect(gg.edges).toHaveLength(0);
  });
});

describe('python call graph', () => {
  const src = `
def helper():
    return 1

def main():
    helper()
    Service.build()

class Service:
    def run(self):
        self.step()
        helper()

    def step(self):
        pass

    @staticmethod
    def build():
        pass

def unrelated():
    other.step()
`;
  const g = pythonCallGraphAnalyzer.analyze([f('m.py', src)]);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === `m.py::${a}` && e.to === `m.py::${b}`);
  it('links bare calls to free functions', () => {
    expect(has('main', 'helper')).toBe(true);
    expect(has('Service.run', 'helper')).toBe(true);
  });
  it('links self calls within the same class', () => expect(has('Service.run', 'Service.step')).toBe(true));
  it('links Class.method() qualified calls', () => expect(has('main', 'Service.build')).toBe(true));
  it('does not resolve calls on arbitrary objects', () => expect(g.edges.some((e) => e.from === 'm.py::unrelated')).toBe(false));
  it('does not link a method from a bare call', () => expect(has('main', 'Service.step')).toBe(false));
  it('ignores calls in strings/comments', () => {
    const gg = pythonCallGraphAnalyzer.analyze([f('x.py', 'def a(): pass\ndef b():\n    # a()\n    s = "a()"\n')]);
    expect(gg.edges).toHaveLength(0);
  });
});

describe('python call graph: scope-aware bare calls', () => {
  const edges = (files: Array<[string, string]>) => pythonCallGraphAnalyzer.analyze(files.map(([p, t]) => f(p, t))).edges.map((e) => `${e.from}->${e.to}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
  it('same file first, then imported modules, then ambiguous fallback', () => {
    expect(edges([['a.py', 'def helper():\n    pass\n\ndef run():\n    helper()\n'], ['b.py', 'def helper():\n    pass\n']])).toEqual(['a.py::run->a.py::helper']);
    expect(
      edges([
        ['pkg/a.py', 'from .b import helper\n\ndef run():\n    helper()\n'],
        ['pkg/b.py', 'def helper():\n    pass\n'],
        ['pkg/c.py', 'def helper():\n    pass\n'],
      ]),
    ).toEqual(['pkg/a.py::run->pkg/b.py::helper']);
    expect(edges([['a.py', 'def run():\n    helper()\n'], ['b.py', 'def helper():\n    pass\n'], ['c.py', 'def helper():\n    pass\n']])).toEqual(['a.py::run->b.py::helper?', 'a.py::run->c.py::helper?']);
  });
});

describe('python call graph: typed receivers and shadowing', () => {
  const calls = (src: string) => {
    const g = pythonCallGraphAnalyzer.analyze([{ path: 'a.py', text: src }]);
    return g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`).sort();
  };
  it('x = Foo() then x.run() resolves to Foo.run, not to every run', () => {
    expect(calls(`class Foo:\n    def run(self):\n        pass\nclass Bar:\n    def run(self):\n        pass\ndef main():\n    x = Foo()\n    x.run()\n`)).toEqual(['main->Foo.run']);
  });
  it('annotated parameters and self.field = Foo() resolve', () => {
    expect(calls(`class Repo:\n    def save(self):\n        pass\nclass Svc:\n    def __init__(self):\n        self.repo = Repo()\n    def go(self):\n        self.repo.save()\ndef use(r: Repo):\n    r.save()\n`)).toEqual(['Svc.go->Repo.save', 'use->Repo.save']);
  });
  it('a parameter or local that shadows a function name suppresses the bare-call edge', () => {
    expect(calls(`def helper():\n    pass\ndef a(helper):\n    helper()\ndef b():\n    helper = make()\n    helper()\ndef c():\n    helper()\n`)).toEqual(['c->helper']);
  });
});

describe('python call graph: fields assigned from annotated parameters', () => {
  it('types self.repo from `def __init__(self, repo: Repo)`', () => {
    const g = pythonCallGraphAnalyzer.analyze([{ path: 'm.py', text: 'class Repo:\n    def update(self, n): ...\nclass User:\n    def __init__(self, repo: Repo):\n        self.repo = repo\n    def rename(self, n):\n        self.repo.update(n)\n' }]);
    expect(g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`)).toContain('User.rename->Repo.update');
  });
});

describe('python call graph: one-line defs', () => {
  it('reads the body written after the colon', () => {
    const g = pythonCallGraphAnalyzer.analyze([{ path: 'm.py', text: 'def g(x):\n    return x\ndef f(x): return g(x)\n' }]);
    expect(g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`)).toContain('f->g');
  });
});
