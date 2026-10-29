import { describe, it, expect } from 'vitest';
import { parseRust, analyzeRustClasses, rustCallGraphAnalyzer, rustImportGraphAnalyzer, expandUseTree } from '../src/analyzers/rust/rustAnalyzer';

const f = (path: string, text: string) => ({ path, text });

const SAMPLE = `
use std::collections::HashMap;

/// A shape. fn fake() {}
pub trait Shape: Display + Clone {
    fn area(&self) -> f64;
    fn name(&self) -> String { String::from("shape") }
}

#[derive(Debug, Clone)]
pub struct Circle {
    pub radius: f64,
    id: u32,
    pub(crate) tags: Vec<String>,
    lookup: HashMap<String, Vec<u8>>,
}

pub struct Point(pub i32, i32);
struct Unit;

pub enum Kind {
    Round,
    Square { side: f64 },
    Tri(f64, f64),
}

impl Circle {
    pub fn new(radius: f64) -> Self { Circle { radius, id: 0, tags: vec![], lookup: HashMap::new() } }
    pub fn grow(&mut self, by: f64) { self.radius += by; self.log(); }
    fn log(&self) {}
    pub fn make() -> Circle { Circle::new(1.0) }
}

impl Shape for Circle {
    fn area(&self) -> f64 { std::f64::consts::PI * self.radius * self.radius }
}

mod inner {
    pub struct Nested { pub v: i32 }
    pub fn helper() -> i32 { 1 }
}

pub fn run() { let c = Circle::make(); helper(); main_loop(); }
fn main_loop() { run(); }
`;

describe('parseRust', () => {
  const items = parseRust(SAMPLE);
  it('finds structs including tuple/unit and those in inline modules', () => {
    expect(items.structs.map((s) => s.name).sort()).toEqual(['Circle', 'Nested', 'Point', 'Unit']);
  });
  it('captures fields with visibility and sanitised generic types', () => {
    const c = items.structs.find((s) => s.name === 'Circle')!;
    expect(c.fields).toContain('+radius f64');
    expect(c.fields).toContain('-id u32');
    expect(c.fields).toContain('~tags Vec~String~');
    expect(c.fields).toContain('-lookup HashMap~String, Vec~u8~~');
  });
  it('captures tuple struct fields', () => {
    expect(items.structs.find((s) => s.name === 'Point')!.fields).toEqual(['+0 i32', '-1 i32']);
  });
  it('finds enums with variant names only', () => {
    expect(items.enums[0]).toEqual({ name: 'Kind', variants: ['Round', 'Square', 'Tri'] });
  });
  it('finds traits with supertraits and methods', () => {
    const t = items.traits[0];
    expect(t.name).toBe('Shape');
    expect(t.supers).toEqual(['Display', 'Clone']);
    expect(t.methods.map((m) => m.name)).toEqual(['area', 'name']);
  });
  it('finds impl blocks and distinguishes trait impls', () => {
    expect(items.impls.map((i) => `${i.trait ?? '-'}:${i.type}`)).toEqual(['-:Circle', 'Shape:Circle']);
  });
  it('detects static (no self) methods', () => {
    const m = items.impls[0].methods;
    expect(m.find((x) => x.name === 'new')!.isStatic).toBe(true);
    expect(m.find((x) => x.name === 'grow')!.isStatic).toBe(false);
  });
  it('finds free functions (including inside modules)', () => {
    expect(items.fns.map((x) => x.name).sort()).toEqual(['helper', 'main_loop', 'run']);
  });
  it('ignores items in comments and strings', () => {
    expect(items.fns.some((x) => x.name === 'fake')).toBe(false);
  });
  it('records mod declarations', () => {
    expect(parseRust('mod a;\npub mod b;\nmod c { }').modDecls).toEqual(['a', 'b']);
  });
  it('handles generics, where clauses and lifetimes without losing the item', () => {
    const it2 = parseRust("pub struct W<'a, T: Clone> where T: Send { r: &'a T }\nimpl<'a, T: Clone> W<'a, T> { fn get(&self) -> &'a T { self.r } }");
    expect(it2.structs[0].name).toBe('W');
    expect(it2.impls[0].type).toBe('W');
    expect(it2.impls[0].methods[0].name).toBe('get');
  });
  it('does not throw on garbage', () => {
    expect(() => parseRust('struct { fn ( impl for {{{')).not.toThrow();
  });
});

describe('analyzeRustClasses', () => {
  const { classes, relationships } = analyzeRustClasses([f('lib.rs', SAMPLE)]);
  const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
  it('merges inherent impl methods into the struct, fields first', () => {
    const m = byId.Circle.members;
    expect(m).toContain('+new(radius) Self$');
    expect(m).toContain('+grow(by)');
    expect(m).toContain('-log()');
    expect(m.findIndex((x) => x.includes('('))).toBeGreaterThan(m.findIndex((x) => x.startsWith('+radius')));
  });
  it('marks traits as interfaces and enums as enumerations', () => {
    expect(byId.Shape.stereotype).toBe('interface');
    expect(byId.Kind.stereotype).toBe('enumeration');
  });
  it('emits realization for trait impls and inheritance for supertraits', () => {
    expect(relationships).toContainEqual({ from: 'Circle', to: 'Shape', type: 'realization' });
    expect(relationships).toContainEqual({ from: 'Shape', to: 'Display', type: 'inheritance' });
  });
  it('does not repeat trait-impl methods on the type', () => {
    expect(byId.Circle.members.some((m) => m.includes('area'))).toBe(false);
  });
});

describe('rust call graph', () => {
  const g = rustCallGraphAnalyzer.analyze([f('lib.rs', SAMPLE)]);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === `lib.rs::${a}` && e.to === `lib.rs::${b}`);
  it('links self calls in the same impl', () => expect(has('Circle.grow', 'Circle.log')).toBe(true));
  it('links Type::func() qualified calls', () => {
    expect(has('run', 'Circle.make')).toBe(true);
    expect(has('Circle.make', 'Circle.new')).toBe(true);
  });
  it('links bare free-function calls', () => {
    expect(has('run', 'helper')).toBe(true);
    expect(has('run', 'main_loop')).toBe(true);
    expect(has('main_loop', 'run')).toBe(true);
  });
});

describe('expandUseTree', () => {
  it('expands nested groups', () => {
    expect(expandUseTree('crate::a::{b, c::{d, e}, f}')).toEqual(['crate::a::b', 'crate::a::c::d', 'crate::a::c::e', 'crate::a::f']);
  });
  it('drops globs, aliases and self', () => {
    expect(expandUseTree('crate::a::*')).toEqual(['crate::a']);
    expect(expandUseTree('crate::a::B as C')).toEqual(['crate::a::B']);
    expect(expandUseTree('crate::a::{self, b}')).toEqual(['crate::a', 'crate::a::b']);
  });
});

describe('rust module graph', () => {
  const files = [
    f('src/main.rs', 'mod config;\nmod net;\nuse crate::config::Settings;\nuse std::io;\nuse serde::Serialize;\nfn main() {}'),
    f('src/config.rs', 'use crate::net::{client::Client, Server};\n'),
    f('src/net/mod.rs', 'pub mod client;\n'),
    f('src/net/client.rs', 'use super::Server;\nuse crate::config;\n'),
  ];
  const g = rustImportGraphAnalyzer.analyze(files);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === a && e.to === b);
  it('resolves mod declarations to files (foo.rs and foo/mod.rs)', () => {
    expect(has('src/main.rs', 'src/config.rs')).toBe(true);
    expect(has('src/main.rs', 'src/net/mod.rs')).toBe(true);
    expect(has('src/net/mod.rs', 'src/net/client.rs')).toBe(true);
  });
  it('resolves crate:: use paths to the deepest module file', () => {
    expect(has('src/config.rs', 'src/net/client.rs')).toBe(true);
    expect(has('src/net/client.rs', 'src/config.rs')).toBe(true);
  });
  it('resolves super:: paths', () => expect(has('src/net/client.rs', 'src/net/mod.rs')).toBe(true));
  it('ignores std and external crates', () => expect(g.edges.every((e) => e.to.startsWith('src/'))).toBe(true));
  it('has no duplicate edges', () => {
    const keys = g.edges.map((e) => `${e.from}>${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('real-world robustness', () => {
  it('ignores impls on non-nominal types and handles multi-line where clauses', () => {
    const r = analyzeRustClasses([
      { path: 'a.rs', text: "struct Foo<S>(S);\ntrait T {}\nimpl T for () {}\nimpl T for &'static [u8] {}\nimpl T for [u8; N] {}\nimpl<S> Foo<S>\nwhere\n    S: Clone + Send,\n{\n    fn go(&self) {}\n}\n" },
    ]);
    expect(r.classes.map((c) => c.id).sort()).toEqual(['Foo', 'T']);
    expect(r.classes.find((c) => c.id === 'Foo')?.members.join(' ')).toContain('go');
  });
});

describe('rust call graph: typed receivers', () => {
  const calls = (src: string) => rustCallGraphAnalyzer.analyze([{ path: 'a.rs', text: src }]).edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`).sort();
  it('let r = Repo::new(); r.save(), typed parameters and struct fields', () => {
    expect(
      calls(`
struct Repo {}
impl Repo { fn new() -> Repo { Repo {} } fn save(&self) {} }
struct Other {}
impl Other { fn save(&self) {} }
struct Svc { repo: std::sync::Arc<Repo> }
impl Svc { fn go(&self) { self.repo.save(); } }
fn main() { let r = Repo::new(); r.save(); }
fn f(o: &Other) { o.save(); }
`),
    ).toEqual(['Svc.go->Repo.save', 'f->Other.save', 'main->Repo.new', 'main->Repo.save']);
  });
});
