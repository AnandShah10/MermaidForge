import { describe, it, expect } from 'vitest';
import { typeScriptCallGraphAnalyzer } from '../src/analyzers/typescript/callGraphAnalyzer';

describe('typeScriptCallGraphAnalyzer', () => {
  it('detects a top-level function calling another', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([
      { path: 'a.ts', text: `function main() { helper(); }\nfunction helper() {}` },
    ]);
    expect(graph.nodes.map((n) => n.label).sort()).toEqual(['helper', 'main']);
    expect(graph.edges).toContainEqual({ from: 'a.ts::main', to: 'a.ts::helper', kind: 'calls' });
  });

  it('detects an arrow-function constant calling another', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([
      { path: 'a.ts', text: `const main = () => { helper(); };\nconst helper = () => {};` },
    ]);
    expect(graph.edges).toContainEqual({ from: 'a.ts::main', to: 'a.ts::helper', kind: 'calls' });
  });

  it('does not create a self-loop for direct recursion', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([{ path: 'a.ts', text: `function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }` }]);
    expect(graph.edges).toHaveLength(0);
  });

  it('resolves this.method() calls only within the same class', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([
      {
        path: 'a.ts',
        text: `class A {\n  run() { this.helper(); }\n  helper() {}\n}\nclass B {\n  helper() {}\n}`,
      },
    ]);
    expect(graph.edges).toEqual([{ from: 'a.ts::A.run', to: 'a.ts::A.helper', kind: 'calls' }]);
  });

  it('does not resolve calls on arbitrary objects', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([{ path: 'a.ts', text: `function main() { someLib.doThing(); }` }]);
    expect(graph.edges).toHaveLength(0);
  });

  it('finds calls across multiple files', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([
      { path: 'main.ts', text: `import { helper } from './helper';\nfunction run() { helper(); }` },
      { path: 'helper.ts', text: `export function helper() {}` },
    ]);
    expect(graph.edges).toContainEqual({ from: 'main.ts::run', to: 'helper.ts::helper', kind: 'calls' });
  });

  it('deduplicates repeated calls to the same function', () => {
    const graph = typeScriptCallGraphAnalyzer.analyze([{ path: 'a.ts', text: `function main() { helper(); helper(); }\nfunction helper() {}` }]);
    expect(graph.edges).toHaveLength(1);
  });

  it('does not throw on a syntactically broken file', () => {
    expect(() => typeScriptCallGraphAnalyzer.analyze([{ path: 'broken.ts', text: `function( {{{` }])).not.toThrow();
  });
});

describe('typeScriptCallGraphAnalyzer: import-aware resolution', () => {
  const analyze = (files: Array<[string, string]>) => typeScriptCallGraphAnalyzer.analyze(files.map(([path, text]) => ({ path, text })));
  const edge = (g: ReturnType<typeof analyze>) => g.edges.map((e) => `${e.from}->${e.to}${e.kind === 'ambiguous' ? '?' : ''}`).sort();

  it('a same-file function wins over a same-named function elsewhere', () => {
    const g = analyze([
      ['a.ts', 'function run() { helper(); }\nfunction helper() {}'],
      ['b.ts', 'export function helper() {}'],
    ]);
    expect(edge(g)).toEqual(['a.ts::run->a.ts::helper']);
  });

  it('follows named, aliased, default imports and require destructuring to the right file', () => {
    const g = analyze([
      ['x.ts', 'export function work() {}\nexport default function main() {}'],
      ['y.ts', 'export function work() {}'],
      ['use.ts', "import { work as w } from './x';\nimport entry from './x';\nexport function go() { w(); entry(); }"],
      ['use2.js', "const { work } = require('./y');\nfunction go2() { work(); }"],
    ]);
    expect(edge(g)).toEqual(['use.ts::go->x.ts::main', 'use.ts::go->x.ts::work', 'use2.js::go2->y.ts::work']);
  });

  it('resolves ns.foo() for namespace imports and whole-module requires, and a module.exports function', () => {
    const g = analyze([
      ['lib.js', 'function a() {}\nfunction b() {}\nmodule.exports = { a, b };'],
      ['one.js', 'function main() {}\nmodule.exports = main;'],
      ['app.ts', "import * as lib from './lib';\nconst one = require('./one');\nfunction go() { lib.a(); one(); }"],
    ]);
    expect(edge(g)).toEqual(['app.ts::go->lib.js::a', 'app.ts::go->one.js::main']);
  });

  it('follows re-exports through a barrel file', () => {
    const g = analyze([
      ['util/format.ts', 'export function fmt() {}'],
      ['util/index.ts', "export * from './format';"],
      ['main.ts', "import { fmt } from './util';\nfunction go() { fmt(); }"],
    ]);
    expect(edge(g)).toEqual(['main.ts::go->util/format.ts::fmt']);
  });

  it('an imported name that is not a scanned function makes no edge, even if another file has that name', () => {
    const g = analyze([
      ['a.ts', "import { helper } from './missing';\nfunction go() { helper(); }"],
      ['b.ts', 'export function helper() {}'],
    ]);
    expect(edge(g)).toEqual([]);
  });

  it('with no import to go on, every same-named function matches and the edges are marked ambiguous', () => {
    const g = analyze([
      ['a.ts', 'function go() { init(); }'],
      ['b.ts', 'function init() {}'],
      ['c.ts', 'function init() {}'],
      ['d.ts', 'function only() {}\nfunction go2() { only(); }'],
    ]);
    expect(edge(g)).toEqual(['a.ts::go->b.ts::init?', 'a.ts::go->c.ts::init?', 'd.ts::go2->d.ts::only']);
  });
});

describe('typeScriptCallGraphAnalyzer: path aliases', () => {
  const edge = (files: Array<[string, string]>) => typeScriptCallGraphAnalyzer.analyze(files.map(([path, text]) => ({ path, text }))).edges.map((e) => `${e.from}->${e.to}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
  it('resolves @/ and src/ aliases by unique suffix, leaves packages and ambiguous aliases unresolved', () => {
    expect(
      edge([
        ['src/lib/format.ts', 'export function fmt() {}'],
        ['src/pages/home.ts', "import { fmt } from '@/lib/format';\nexport function go() { fmt(); }"],
      ]),
    ).toEqual(['src/pages/home.ts::go->src/lib/format.ts::fmt']);
    expect(
      edge([
        ['a/lib/format.ts', 'export function fmt() {}'],
        ['b/lib/format.ts', 'export function fmt() {}'],
        ['home.ts', "import { fmt } from '@/lib/format';\nfunction go() { fmt(); }"],
      ]),
    ).toEqual([]);
    expect(edge([['x.ts', 'export function debounce() {}'], ['y.ts', "import { debounce } from 'lodash';\nfunction go() { debounce(); }"]])).toEqual([]);
  });
});

describe('ts call graph: typed receivers and shadowing', () => {
  const calls = (files: Array<{ path: string; text: string }>) =>
    typeScriptCallGraphAnalyzer.analyze(files).edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`).sort();

  it('typed parameter, new-initialised local, and typed fields resolve to the right class', () => {
    expect(
      calls([
        {
          path: 'a.ts',
          text: `
class Repo { save() {} }
class Other { save() {} }
class Svc {
  private repo: Repo;
  cache = new Other();
  constructor(private readonly audit: Repo) {}
  go() { this.repo.save(); this.cache.save(); this.audit.save(); }
}
function useParam(r: Repo) { r.save(); }
function useLocal() { const o = new Other(); o.save(); }
`,
        },
      ]),
    ).toEqual(['Svc.go->Other.save', 'Svc.go->Repo.save', 'useLocal->Other.save', 'useParam->Repo.save']);
  });
  it('finds the class through an import and walks extends', () => {
    expect(
      calls([
        { path: 'base.ts', text: `export class Base { log() {} }` },
        { path: 'svc.ts', text: `import { Base } from './base';\nexport class Svc extends Base { run() {} }` },
        { path: 'main.ts', text: `import { Svc } from './svc';\nfunction main(s: Svc) { s.log(); s.run(); }` },
      ]),
    ).toEqual(['main->Base.log', 'main->Svc.run']);
  });
  it('untyped receivers and interfaces produce no edge', () => {
    expect(calls([{ path: 'a.ts', text: `class A { run() {} }\nfunction f(x: IThing, y) { x.run(); y.run(); }` }])).toEqual([]);
  });
  it('a parameter or local variable shadows an imported or declared function', () => {
    expect(
      calls([
        { path: 'util.ts', text: `export function helper() {}` },
        {
          path: 'a.ts',
          text: `import { helper } from './util';
function a(helper: () => void) { helper(); }
function b() { const helper = make(); helper(); }
function c() { helper(); }
function make() { return () => {}; }
`,
        },
      ]),
    ).toEqual(['b->make', 'c->helper']);
  });
  it('a nested function declared in the body is still a call target', () => {
    expect(calls([{ path: 'a.ts', text: `function outer() { const inner = () => {}; inner(); }` }])).toEqual(['outer->inner']);
  });
});

describe('call results and interfaces', () => {
  const an = typeScriptCallGraphAnalyzer;
  const edgeSet = (g: ReturnType<typeof an.analyze>) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
  it('types a local from a declared return type and from `return new X()`', () => {
    const g = an.analyze([
      { path: 'a.ts', text: `
class Repo { save() {} }
class Cache { get() {} }
function open(): Repo { return new Repo(); }
function makeCache() { return new Cache(); }
async function load(): Promise<Repo> { return new Repo(); }
export function run() { const r = open(); r.save(); const c = makeCache(); c.get(); }
export async function run2() { const r = await load(); r.save(); }
export function chain() { open().save(); }` },
    ]);
    const e = edgeSet(g);
    expect(e).toContain('run->Repo.save');
    expect(e).toContain('run->Cache.get');
    expect(e).toContain('run2->Repo.save');
    expect(e).toContain('chain->Repo.save');
  });
  it('resolves through method return types and this.field', () => {
    const g = an.analyze([
      { path: 'a.ts', text: `
class Repo { save() {} }
class Svc { repo: Repo = new Repo(); getRepo(): Repo { return this.repo; } go() { const r = this.getRepo(); r.save(); this.getRepo().save(); } }` },
    ]);
    expect(edgeSet(g)).toContain('Svc.go->Repo.save');
  });
  it('interface-typed receivers get dotted edges to each implementer', () => {
    const g = an.analyze([
      { path: 'a.ts', text: `
interface Store { put(): void }
class Mem implements Store { put() {} }
class Disk implements Store { put() {} }
class Other { put() {} }
export function use(s: Store) { s.put(); }` },
    ]);
    expect(edgeSet(g).filter((x) => x.startsWith('use->'))).toEqual(['use->Disk.put?', 'use->Mem.put?']);
  });
  it('an abstract base without a body falls back to subclasses', () => {
    const g = an.analyze([
      { path: 'a.ts', text: `
abstract class Shape { abstract area(): number }
class Sq extends Shape { area() { return 1; } }
export function f(s: Shape) { s.area(); }` },
    ]);
    expect(edgeSet(g)).toContain('f->Sq.area?');
  });
});

import { pythonCallGraphAnalyzer } from '../src/analyzers/python/pythonAnalyzer';
import { goCallGraphAnalyzer } from '../src/analyzers/go/goAnalyzer';
import { rustCallGraphAnalyzer } from '../src/analyzers/rust/rustAnalyzer';
import { csharpCallGraphAnalyzer } from '../src/analyzers/csharp/csharpAnalyzer';

describe('call results and interfaces in the name-based languages', () => {
  const pairs = (g: { edges: Array<{ from: string; to: string; kind?: string }> }) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
  it('python: return annotation types a local, and a base class links its overrides', () => {
    const g = pythonCallGraphAnalyzer.analyze([{ path: 'a.py', text: `
class Repo:
    def save(self): pass
class FastRepo(Repo):
    def save(self): pass
def open_repo() -> Repo:
    return Repo()
def run():
    r = open_repo()
    r.save()
    open_repo().save()
` }]);
    const e = pairs(g);
    expect(e).toContain('run->Repo.save');
    expect(e).toContain('run->FastRepo.save?');
  });
  it('go: interfaces are satisfied structurally', () => {
    const g = goCallGraphAnalyzer.analyze([{ path: 'a.go', text: `package p
type Store interface { Put() }
type Mem struct{}
func (m *Mem) Put() {}
type Disk struct{}
func (d *Disk) Put() {}
type Other struct{}
func (o *Other) Get() {}
func Use(s Store) { s.Put() }
func NewMem() *Mem { return &Mem{} }
func Run() { m := NewMem(); m.Put() }
` }]);
    const e = pairs(g);
    expect(e).toContain('Use->Mem.Put?');
    expect(e).toContain('Use->Disk.Put?');
    expect(e).not.toContain('Use->Other.Get?');
    expect(e).toContain('Run->Mem.Put');
  });
  it('rust: dyn Trait receivers reach the impls', () => {
    const g = rustCallGraphAnalyzer.analyze([{ path: 'a.rs', text: `
trait Store { fn put(&self); }
struct Mem;
impl Store for Mem { fn put(&self) {} }
struct Disk;
impl Store for Disk { fn put(&self) {} }
fn use_it(s: &dyn Store) { s.put(); }
` }]);
    const e = pairs(g);
    expect(e).toContain('use_it->Mem.put?');
    expect(e).toContain('use_it->Disk.put?');
  });
  it('c#: interface-typed parameters link implementers', () => {
    const g = csharpCallGraphAnalyzer.analyze([{ path: 'a.cs', text: `
interface IStore { void Put(); }
class Mem : IStore { public void Put() {} }
class Disk : IStore { public void Put() {} }
class Client { void Go(IStore s) { s.Put(); } }
` }]);
    const e = pairs(g);
    expect(e).toContain('Client.Go->Mem.Put?');
    expect(e).toContain('Client.Go->Disk.Put?');
  });
});

describe('unions, collections, destructuring and generics (TypeScript)', () => {
  const an = typeScriptCallGraphAnalyzer;
  const e = (files: string) => an.analyze([{ path: 'a.ts', text: files }]).edges.map((x) => `${x.from.split('::')[1]}->${x.to.split('::')[1]}${x.kind === 'ambiguous' ? '?' : ''}`).sort();
  const base = `class Repo { save() {} }\nclass Cache { get() {} }\n`;
  it('unions with null/undefined and optional parameters', () => {
    expect(e(base + `export function a(r: Repo | null) { r!.save(); }\nexport function b(r?: Repo) { r?.save(); }\nexport function c(r: Repo | undefined) { r.save(); }`)).toEqual(['a->Repo.save', 'b->Repo.save', 'c->Repo.save']);
  });
  it('a union of two classes is not guessed', () => {
    expect(e(base + `export function f(x: Repo | Cache) { x.save(); }`)).toEqual([]);
  });
  it('arrays, sets and maps: for-of, callbacks, index and get()', () => {
    const out = e(base + `
export function a(rs: Repo[]) { for (const r of rs) r.save(); }
export function b(rs: Array<Repo>) { rs.forEach((r) => r.save()); }
export function c(m: Map<string, Repo>) { m.get('k')!.save(); }
export function d(rs: Repo[]) { rs[0].save(); }
export function f(s: Set<Repo>) { for (const r of s) r.save(); }
export function g(m: Map<string, Repo>) { for (const [k, r] of m) r.save(); }
export function h(rs: Repo[]) { rs.filter(Boolean).map((r) => r.save()); }
export function i(m: Record<string, Repo>) { m['x'].save(); }`);
    for (const f of 'abcdfghi') expect(out).toContain(`${f}->Repo.save`);
  });
  it('typed fields and locals created with generics', () => {
    const out = e(base + `
class S { repos: Repo[] = []; byName = new Map<string, Repo>();
  all() { for (const r of this.repos) r.save(); }
  one() { this.byName.get('x')!.save(); } }
export function f() { const m = new Map<string, Repo>(); m.get('a')!.save(); const l = new Set<Repo>(); l.forEach((r) => r.save()); }`);
    expect(out).toEqual(['S.all->Repo.save', 'S.one->Repo.save', 'f->Repo.save']);
  });
  it('destructuring from this, from a typed object and from parameters', () => {
    const out = e(base + `
interface Deps { repo: Repo; cache: Cache }
class S { repo = new Repo(); run() { const { repo } = this; repo.save(); } }
export function a(deps: Deps) { const { repo, cache: c } = deps; repo.save(); c.get(); }
export function b({ repo }: Deps) { repo.save(); }
export function c(deps: Deps) { deps.repo.save(); }
export function d(pair: Repo[]) { const [x, y] = pair; x.save(); y.save(); }`);
    expect(out).toContain('S.run->Repo.save');
    expect(out).toContain('a->Repo.save');
    expect(out).toContain('a->Cache.get');
    expect(out).toContain('b->Repo.save');
    expect(out).toContain('c->Repo.save');
    expect(out).toContain('d->Repo.save');
  });
  it('return types that are collections feed later iteration', () => {
    const out = e(base + `
function all(): Repo[] { return []; }
async function load(): Promise<Repo[]> { return []; }
export async function f() { for (const r of all()) r.save(); for (const r of await load()) r.save(); }`);
    expect(out).toContain('f->Repo.save');
  });
});

describe('collections and loops in the name-based languages', () => {
  const pairs2 = (g: { edges: Array<{ from: string; to: string }> }) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`).sort();
  it('python: for r in repos', () => {
    expect(pairs2(pythonCallGraphAnalyzer.analyze([{ path: 'a.py', text: `
class Repo:
    def save(self): pass
def run(repos: list[Repo], more: List[Repo]):
    for r in repos:
        r.save()
` }]))).toContain('run->Repo.save');
  });
  it('go: for _, r := range repos', () => {
    expect(pairs2(goCallGraphAnalyzer.analyze([{ path: 'a.go', text: `package p
type Repo struct{}
func (r *Repo) Save() {}
func Run(repos []*Repo) { for _, r := range repos { r.Save() } }
` }]))).toContain('Run->Repo.Save');
  });
  it('rust: for r in &repos', () => {
    expect(pairs2(rustCallGraphAnalyzer.analyze([{ path: 'a.rs', text: `
struct Repo;
impl Repo { fn save(&self) {} }
fn run(repos: &Vec<Repo>) { for r in repos.iter() { r.save(); } }
` }]))).toContain('run->Repo.save');
  });
  it('c#: foreach over a List<Repo>', () => {
    expect(pairs2(csharpCallGraphAnalyzer.analyze([{ path: 'a.cs', text: `
class Repo { public void Save() {} }
class Svc { void Run(List<Repo> repos) { foreach (var r in repos) { r.Save(); } } }
` }]))).toContain('Svc.Run->Repo.Save');
  });
});

import { javaCallGraphAnalyzer } from '../src/analyzers/java/javaAnalyzer';
describe('java loops over collections', () => {
  it('for (Repo r : repos) with List<Repo> and Repo[]', () => {
    const g = javaCallGraphAnalyzer.analyze([
      { path: 'Repo.java', text: 'class Repo { void save() {} }' },
      { path: 'A.java', text: 'class A { void a(List<Repo> repos) { for (Repo r : repos) { r.save(); } } void b(Repo[] rs) { for (var r : rs) { r.save(); } } }' },
    ]);
    const e = g.edges.map((x) => x.from.split('::')[1] + '->' + x.to.split('::')[1]);
    expect(e).toContain('A.a->Repo.save');
    expect(e).toContain('A.b->Repo.save');
  });
});

describe('ts call graph: generic substitution', () => {
  const an = typeScriptCallGraphAnalyzer;
  const edgeSet = (g: ReturnType<typeof an.analyze>) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
  it('substitutes type arguments into fields, method returns and generic interfaces', () => {
    const g = an.analyze([
      { path: 'a.ts', text: `
class Repo { save() {} }
class Other { save() {} }
class Box<T> { item: T; items: T[]; get(): T { return this.item; } }
interface Holder<T> { value: T }
function a(b: Box<Repo>) { b.item.save(); }
function c(b: Box<Repo>) { b.get().save(); }
function d(b: Box<Repo>) { for (const x of b.items) x.save(); }
function e(h: Holder<Other>) { h.value.save(); }
function f() { const b = new Box<Repo>(); b.get().save(); }` },
    ]);
    const e = edgeSet(g);
    expect(e).toContain('a->Repo.save');
    expect(e).toContain('c->Repo.save');
    expect(e).toContain('d->Repo.save');
    expect(e).toContain('e->Other.save');
    expect(e).toContain('f->Repo.save');
    expect(e).not.toContain('a->Other.save');
  });
});
