import { describe, it, expect } from 'vitest';
import { parseSwift, analyzeSwiftClasses, analyzeSwiftImports, swiftCallGraphAnalyzer, swiftImportGraphAnalyzer } from '../src/analyzers/swift/swiftAnalyzer';
import { swiftRouteAnalyzer } from '../src/analyzers/swift/swiftRouteAnalyzer';
import { classesToClassDiagram, codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
const routes = (files: Array<{ path: string; text: string }>) =>
  swiftRouteAnalyzer.analyze(files).nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const edges = (files: Array<{ path: string; text: string }>) =>
  swiftCallGraphAnalyzer.analyze(files).edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();

describe('parseSwift', () => {
  const src = `
import Foundation
@testable import MyApp
public final class User: Base, Codable {
  public let id: Int
  private(set) var name: String
  static var count = 0
  public init(id: Int) { self.id = id }
  func greet(to other: User, _ times: Int = 1) async throws -> String { return "hi" }
}
protocol Store { func put(_ u: User) }
enum Kind: String { case a, b }
struct Box<T> where T: Equatable { var v: T }
`;
  it('reads imports incl. @testable', () => {
    expect(parseSwift(src).imports.map((i) => [i.module, i.isTestable])).toEqual([['Foundation', false], ['MyApp', true]]);
  });
  it('reads type kinds, inheritance and visibility', () => {
    const t = parseSwift(src).types;
    expect(t.map((x) => `${x.kind} ${x.name}`)).toEqual(['class User', 'protocol Store', 'enum Kind', 'struct Box']);
    expect(t[0].inherits).toEqual(['Base', 'Codable']);
    expect(t[0].isFinal).toBe(true);
  });
  it('reads properties and methods with labels and return types', () => {
    const u = parseSwift(src).types[0];
    expect(u.properties.map((p) => `${p.name}:${p.type}`)).toEqual(expect.arrayContaining(['id:Int', 'name:String']));
    const g = u.methods.find((m) => m.name === 'greet')!;
    expect(g.returnType).toBe('String');
    expect(g.params.map((p) => p.name)).toEqual(['other', 'times']);
  });
  it('ignores code in strings and comments', () => {
    const p = parseSwift(`// class Ghost {}\nlet s = "class Fake { func no() {} }"\n/* struct Hidden {} */\nclass Real { func yes() {} }`);
    expect(p.types.map((t) => t.name)).toEqual(['Real']);
  });
});

describe('analyzeSwiftClasses', () => {
  it('draws classes, protocols, enums and conformances', () => {
    const r = analyzeSwiftClasses([f('A.swift', `protocol Store { func put() }\nclass Base {}\nclass Mem: Base, Store { var x: Int = 0\n func put() {} }\nenum Kind { case a }`)]);
    expect(r.classes.map((c) => c.id).sort()).toEqual(['Base', 'Kind', 'Mem', 'Store']);
    expect(r.classes.find((c) => c.id === 'Store')!.stereotype).toBe('interface');
    expect(r.classes.find((c) => c.id === 'Kind')!.stereotype).toBe('enumeration');
    expect(r.relationships).toEqual(expect.arrayContaining([{ from: 'Mem', to: 'Base', type: 'inheritance' }, { from: 'Mem', to: 'Store', type: 'realization' }]));
  });
  it('merges extensions into the extended type and adds their conformances', () => {
    const r = analyzeSwiftClasses([f('A.swift', `struct P { var a: Int }\nprotocol Named {}\nextension P: Named { func label() -> String { "" } }\nextension String { func shout() {} }`)]);
    const p = r.classes.find((c) => c.id === 'P')!;
    expect(p.members.some((m) => m.includes('label'))).toBe(true);
    expect(r.classes.some((c) => c.id === 'String')).toBe(false);
    expect(r.relationships).toContainEqual({ from: 'P', to: 'Named', type: 'realization' });
  });
  it('leaves standard conformances and raw types out', () => {
    const r = analyzeSwiftClasses([f('A.swift', `enum E: String, Codable { case a }\nstruct S: Equatable, Hashable { }`)]);
    expect(r.relationships).toEqual([]);
  });
  it('renders a class diagram Mermaid accepts', () => {
    const r = analyzeSwiftClasses([f('A.swift', `class A: B { var x: [Int] = []\n func f(_ a: Int) -> Int? { nil } }\nclass B {}`)]);
    expect(parseMermaid(classesToClassDiagram(r.classes, r.relationships)).kind).toBe('classDiagram');
  });
});

describe('swift imports', () => {
  it('links SwiftPM targets through import of their module name', () => {
    const g = analyzeSwiftImports([
      f('Sources/App/main.swift', 'import Core\nimport Vapor'),
      f('Sources/Core/Thing.swift', 'import Foundation\nstruct Thing {}'),
    ]);
    expect(g.edges).toEqual([{ from: 'App', to: 'Core', kind: 'import' }]);
  });
  it('is empty without internal imports and via the analyzer object', () => {
    expect(swiftImportGraphAnalyzer.analyze([f('a.swift', 'import UIKit')]).nodes).toEqual([]);
  });
  it('produces a flowchart Mermaid accepts', () => {
    const g = analyzeSwiftImports([f('Sources/A/a.swift', 'import B'), f('Sources/B/b.swift', 'import Foundation')]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('swift call graph', () => {
  it('resolves self and typed locals / parameters / fields', () => {
    const e = edges([f('a.swift', `
class Repo { func save() {} }
class Svc {
  let repo: Repo
  func a() { self.b() }
  func b() { repo.save() }
  func c(r: Repo) { r.save() }
  func d() { let r = Repo(); r.save() }
}`)]);
    expect(e).toEqual(expect.arrayContaining(['Svc.a->Svc.b', 'Svc.b->Repo.save', 'Svc.c->Repo.save', 'Svc.d->Repo.save']));
  });
  it('ignores try, await and optional chaining', () => {
    const e = edges([f('a.swift', `class R { func s() {} }\nclass S { var r: R?\n func f() async throws { try await r?.s() } }`)]);
    expect(e).toContain('S.f->R.s');
  });
  it('links protocol-typed receivers to implementers with dotted edges', () => {
    const e = edges([f('a.swift', `protocol Store { func put() }\nclass Mem: Store { func put() {} }\nclass Disk: Store { func put() {} }\nfunc use(_ s: Store) { s.put() }`)]);
    expect(e).toEqual(expect.arrayContaining(['use->Mem.put?', 'use->Disk.put?']));
  });
  it('types a local from a declared return type', () => {
    const e = edges([f('a.swift', `class R { func s() {} }\nfunc make() -> R { R() }\nfunc go() { let r = make(); r.s() }`)]);
    expect(e).toContain('go->R.s');
  });
  it('adds extension methods to the extended type', () => {
    const e = edges([f('a.swift', `class R {}\nextension R { func t() { u() } func u() {} }`)]);
    expect(e).toContain('R.t->R.u');
  });
  it('does not link calls in comments or strings', () => {
    expect(edges([f('a.swift', `func a() { // b()\n let s = "b()" }\nfunc b() {}`)])).toEqual([]);
  });
  it('produces a flowchart Mermaid accepts', () => {
    const g = swiftCallGraphAnalyzer.analyze([f('a.swift', 'func a() { b() }\nfunc b() {}')]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('Vapor routes', () => {
  it('direct routes on the app with path components and closures', () => {
    const r = routes([f('routes.swift', `
func routes(_ app: Application) throws {
  app.get { req in "root" }
  app.get("hello", ":name") { req in "x" }
  app.post("users") { req in "y" }
}`)]);
    expect(r).toEqual(['GET / | (inline)', 'GET /hello/:name | (inline)', 'POST /users | (inline)']);
  });
  it('handlers via use: and a literal containing slashes', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) { app.get("a/b", use: list)\n app.delete("x", ":id", use: remove) }`)]);
    expect(r).toEqual(['DELETE /x/:id | remove', 'GET /a/b | list']);
  });
  it('on(.POST, ...) and webSocket and wildcards', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n app.on(.POST, "upload") { req in "" }\n app.webSocket("ws") { req, ws in }\n app.get("files", "**") { req in "" } }`)]);
    expect(r).toEqual(['GET /files/** | (inline)', 'POST /upload | (inline)', 'WS /ws | (inline)']);
  });
  it('grouped variables prefix their routes', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n let api = app.grouped("api", "v1")\n api.get("users") { req in "" }\n let admin = api.grouped("admin")\n admin.post("x") { req in "" } }`)]);
    expect(r).toEqual(['GET /api/v1/users | (inline)', 'POST /api/v1/admin/x | (inline)']);
  });
  it('group closures bind their parameter and nest', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n app.group("api") { api in\n api.get("ping") { req in "" }\n api.group("users") { users in\n users.get(":id") { req in "" } } } }`)]);
    expect(r).toEqual(['GET /api/ping | (inline)', 'GET /api/users/:id | (inline)']);
  });
  it('chains: app.grouped("api").grouped(Auth()).get("x")', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n app.grouped("api").grouped(AuthMiddleware()).get("me") { req in "" } }`)]);
    expect(r).toEqual(['GET /api/me | (inline)']);
  });
  it('leading-dot continuation lines', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n app.grouped("api")\n   .get("a") { req in "" }\n}`)]);
    expect(r).toEqual(['GET /api/a | (inline)']);
  });
  it('RouteCollection controllers registered with register(collection:)', () => {
    const files = [
      f('Controllers/TodoController.swift', `
struct TodoController: RouteCollection {
  func boot(routes: RoutesBuilder) throws {
    let todos = routes.grouped("todos")
    todos.get(use: index)
    todos.post(use: create)
    todos.group(":todoID") { todo in
      todo.delete(use: delete)
    }
  }
  func index(req: Request) async throws -> [Todo] { [] }
  func create(req: Request) async throws -> Todo { Todo() }
  func delete(req: Request) async throws -> HTTPStatus { .ok }
}`),
      f('routes.swift', `func routes(_ app: Application) throws {\n  try app.register(collection: TodoController())\n}`),
    ];
    expect(routes(files)).toEqual(['DELETE /todos/:todoID | TodoController.delete', 'GET /todos | TodoController.index', 'POST /todos | TodoController.create']);
  });
  it('a collection registered under a grouped prefix gets that prefix', () => {
    const files = [
      f('C.swift', `struct C: RouteCollection { func boot(routes: RoutesBuilder) throws { routes.get("ping") { req in "" } } }`),
      f('r.swift', `func routes(_ app: Application) throws { try app.grouped("api").register(collection: C()) }`),
    ];
    expect(routes(files)).toEqual(['GET /api/ping | (inline)']);
  });
  it('collections held in a let', () => {
    const files = [
      f('C.swift', `struct C: RouteCollection { func boot(routes: RoutesBuilder) throws { routes.get("x") { req in "" } } }`),
      f('r.swift', `func routes(_ app: Application) throws {\n let c = C()\n try app.register(collection: c) }`),
    ];
    expect(routes(files)).toEqual(['GET /x | (inline)']);
  });
  it('hand-off: configure calls routes(app)', () => {
    const files = [
      f('configure.swift', `public func configure(_ app: Application) async throws {\n try routes(app)\n}`),
      f('routes.swift', `func routes(_ app: Application) throws { app.get("ok") { req in "" } }`),
    ];
    const g = swiftRouteAnalyzer.analyze(files);
    expect(g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | '))).toEqual(['GET /ok | (inline)']);
    expect(g.edges.some((e) => e.kind === 'mount')).toBe(true);
  });
  it('non-literal path arguments are shown as (dynamic) and middleware calls are ignored', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n app.get(someParam) { req in "" }\n app.get("a\\(x)") { req in "" } }`)]);
    expect(r).toEqual(['GET /(dynamic) | (inline)', 'GET /(dynamic) | (inline)']);
  });
  it('ignores strings and comments that look like routes', () => {
    const r = routes([f('r.swift', `func routes(_ app: Application) {\n // app.get("no") { }\n let s = "app.get(\\"no2\\") { }"\n app.get("yes") { req in "" } }`)]);
    expect(r).toEqual(['GET /yes | (inline)']);
  });
  it('returns nothing for code without Vapor builders', () => {
    expect(routes([f('a.swift', `func get(_ x: Int) { client.get("x") }`)])).toEqual([]);
  });
  it('produces a flowchart Mermaid accepts', () => {
    const g = swiftRouteAnalyzer.analyze([f('r.swift', `func routes(_ app: Application) { let api = app.grouped("api")\n api.get("u") { req in "" } }`)]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});
