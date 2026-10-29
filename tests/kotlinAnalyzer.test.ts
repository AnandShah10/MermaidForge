import { describe, it, expect } from 'vitest';
import { parseKotlin, analyzeKotlinClasses, kotlinImportGraphAnalyzer, kotlinCallGraphAnalyzer } from '../src/analyzers/kotlin/kotlinAnalyzer';
import { kotlinRouteAnalyzer } from '../src/analyzers/kotlin/kotlinRouteAnalyzer';
import { classesToClassDiagram, codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
const type = (src: string, name: string) => parseKotlin(src).types.find((t) => t.name === name)!;
const routeLabels = (g: ReturnType<typeof kotlinRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const calls = (g: { edges: Array<{ from: string; to: string; kind?: string }> }) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();

describe('parseKotlin: file level and declarations', () => {
  it('reads package and imports including wildcard and alias', () => {
    const k = parseKotlin(`package com.acme.app\nimport com.acme.util.Helper\nimport com.acme.model.*\nimport com.acme.Thing as T\nclass A`);
    expect(k.packageName).toBe('com.acme.app');
    expect(k.imports).toEqual([
      { name: 'com.acme.util.Helper', alias: null, isWildcard: false },
      { name: 'com.acme.model.*', alias: null, isWildcard: true },
      { name: 'com.acme.Thing', alias: 'T', isWildcard: false },
    ]);
  });

  it('ignores declarations inside comments and strings', () => {
    const k = parseKotlin(`// class Ghost\n/* interface Nope */\nclass Real { val s = "class Fake {"; val t = """\n class InRaw\n""" }`);
    expect(k.types.map((t) => t.name)).toEqual(['Real']);
    expect(k.types[0].props.map((p) => p.name)).toEqual(['s', 't']);
  });

  it('classifies class, interface, fun interface, object, enum, data, sealed, annotation', () => {
    const k = parseKotlin(`
interface Repo { fun find(id: Int): User? }
fun interface Handler { fun handle(x: Int) }
object Registry { fun add() {} }
enum class Color { RED, GREEN }
data class User(val id: Int, var name: String)
sealed class Shape
abstract class Base
annotation class Marker
open class Plain
`);
    const kinds = Object.fromEntries(k.types.map((t) => [t.name, t.kind]));
    expect(kinds).toEqual({ Repo: 'interface', Handler: 'interface', Registry: 'object', Color: 'enum', User: 'class', Shape: 'class', Base: 'class', Marker: 'annotation', Plain: 'class' });
    expect(type(`sealed class Shape`, 'Shape').isSealed).toBe(true);
    expect(type(`data class U(val a: Int)`, 'U').isData).toBe(true);
    expect(type(`abstract class Base`, 'Base').isAbstract).toBe(true);
  });

  it('turns primary-constructor val/var parameters into properties with visibility', () => {
    const t = type(`class User(val id: Int, private var name: String? = null, plain: Int, protected val x: List<Map<String, Int>>)`, 'User');
    expect(t.props.map((p) => `${p.visibility}:${p.isVar ? 'var' : 'val'}:${p.name}:${p.type}`)).toEqual([
      'public:val:id:Int',
      'private:var:name:String?',
      'protected:val:x:List<Map<String, Int>>',
    ]);
  });

  it('reads supertypes: Base(args) is a class, plain names are interfaces, `by` delegation is stripped', () => {
    const t = type(`class A(x: Int) : Base(x), Runnable, Comparable<A>, Foo by delegate`, 'A');
    expect(t.supers).toEqual([
      { name: 'Base', isCall: true },
      { name: 'Runnable', isCall: false },
      { name: 'Comparable', isCall: false },
      { name: 'Foo', isCall: false },
    ]);
  });

  it('reads members: properties with getters, delegates, functions, expression bodies, extension receivers', () => {
    const k = parseKotlin(`
class Svc(private val repo: Repo) {
    val a: Int get() = 1
    var b = Repo()
    val c by lazy { Repo() }
    private fun one(x: Int, y: String = "d"): Boolean = x > 0
    fun <T> two(items: List<T>): T { return items.first() }
    abstract fun three()
    override fun toString() = "Svc"
}
fun Repo.save(entity: Any) { println(entity) }
fun top() {}
`);
    const t = k.types[0];
    expect(t.props.map((p) => p.name)).toEqual(['repo', 'a', 'b', 'c']);
    expect(t.props.find((p) => p.name === 'b')!.type).toBe('Repo'); // inferred from the initialiser
    expect(t.funs.map((m) => m.name)).toEqual(['one', 'two', 'three', 'toString']);
    const one = t.funs.find((m) => m.name === 'one')!;
    expect(one.visibility).toBe('private');
    expect(one.params).toEqual(['x', 'y']);
    expect(one.returnType).toBe('Boolean');
    expect(one.paramDecls).toBe('x: Int, y: String');
    expect(t.funs.find((m) => m.name === 'three')!.hasBody).toBe(false);
    expect(t.funs.find((m) => m.name === 'toString')!.isOverride).toBe(true);
    expect(k.topFuns.map((m) => `${m.receiver ?? ''}.${m.name}`)).toEqual(['Repo.save', '.top']);
  });

  it('marks companion members static and flattens nested types', () => {
    const k = parseKotlin(`class Outer { companion object { const val K = 1; fun make() = Outer() }\n class Inner { fun f() {} } }`);
    const outer = k.types.find((t) => t.name === 'Outer')!;
    expect(outer.funs.find((m) => m.name === 'make')!.isStatic).toBe(true);
    expect(outer.props.find((p) => p.name === 'K')!.isStatic).toBe(true);
    const inner = k.types.find((t) => t.name === 'Inner')!;
    expect(inner.outer).toBe('Outer');
    expect(inner.funs.map((m) => m.name)).toEqual(['f']);
  });

  it('reads enum constants with arguments and bodies, then members after `;`', () => {
    const t = type(`enum class Op(val sym: String) { ADD("+") { override fun apply() = 1 }, SUB("-"), MUL("*"); fun describe() = sym }`, 'Op');
    expect(t.enumConstants).toEqual(['ADD', 'SUB', 'MUL']);
    expect(t.funs.map((m) => m.name)).toEqual(['describe']);
  });

  it('keeps annotation arguments from the original source', () => {
    const t = type(`@RestController @RequestMapping("/api/v1") class C`, 'C');
    expect(t.annotations.map((a) => `${a.name}(${a.args})`)).toEqual(['RestController()', 'RequestMapping("/api/v1")']);
  });
});

describe('analyzeKotlinClasses', () => {
  const src = `
interface Store { fun put(k: String) }
abstract class Base
open class Mem(val cap: Int) : Base(), Store { override fun put(k: String) {} ; private val data: Map<String, Int> = emptyMap() }
enum class Level { LOW, HIGH }
sealed class Shape
fun Mem.clear() {}
`;
  const r = analyzeKotlinClasses([f('a.kt', src)]);
  it('assigns stereotypes and members', () => {
    const by = Object.fromEntries(r.classes.map((c) => [c.id, c]));
    expect(by.Store.stereotype).toBe('interface');
    expect(by.Base.stereotype).toBe('abstract');
    expect(by.Level.stereotype).toBe('enumeration');
    expect(by.Level.members).toEqual(['LOW', 'HIGH']);
    expect(by.Shape.stereotype).toBe('abstract');
    expect(by.Mem.members).toContain('+cap Int');
    expect(by.Mem.members).toContain('+put(k)');
    expect(by.Mem.members.some((m) => m.startsWith('-data'))).toBe(true);
    expect(by.Mem.members).toContain('+clear()'); // extension shown on the extended class
  });
  it('maps Base() to inheritance and an interface to realization', () => {
    expect(r.relationships).toContainEqual({ from: 'Mem', to: 'Base', type: 'inheritance' });
    expect(r.relationships).toContainEqual({ from: 'Mem', to: 'Store', type: 'realization' });
  });
  it('produces a class diagram that parseMermaid accepts', () => {
    const parsed = parseMermaid(classesToClassDiagram(r.classes, r.relationships));
    expect(parsed.kind).toBe('classDiagram');
  });
  it('treats a plain supertype that is a scanned class as inheritance and an interface extending interfaces likewise', () => {
    const r2 = analyzeKotlinClasses([f('a.kt', `open class P\nclass C : P\ninterface I\ninterface J : I`)]);
    expect(r2.relationships).toContainEqual({ from: 'C', to: 'P', type: 'inheritance' });
    expect(r2.relationships).toContainEqual({ from: 'J', to: 'I', type: 'inheritance' });
  });
});

describe('kotlinImportGraphAnalyzer', () => {
  const files = [
    f('a/Main.kt', `package com.acme.app\nimport com.acme.util.Helper\nimport com.acme.model.*\nimport com.acme.util.topFun\nimport kotlin.collections.List\nclass Main`),
    f('u/Helper.kt', `package com.acme.util\nclass Helper\nfun topFun() {}`),
    f('m/User.kt', `package com.acme.model\ndata class User(val id: Int)`),
    f('m/Role.kt', `package com.acme.model\nenum class Role { A }`),
  ];
  it('links explicit imports, wildcard packages and top-level functions; ignores stdlib', () => {
    const g = kotlinImportGraphAnalyzer.analyze(files);
    const e = g.edges.map((x) => `${x.from}=>${x.to}`).sort();
    expect(e).toEqual(['a/Main.kt=>m/Role.kt', 'a/Main.kt=>m/User.kt', 'a/Main.kt=>u/Helper.kt']);
  });
  it('resolves nested type and companion-member imports to the declaring file', () => {
    const g = kotlinImportGraphAnalyzer.analyze([f('x.kt', `import p.Outer.Inner\nimport p.Obj.member`), f('o.kt', `package p\nclass Outer { class Inner }`), f('b.kt', `package p\nobject Obj { fun member() {} }`)]);
    expect(g.edges.map((x) => x.to).sort()).toEqual(['b.kt', 'o.kt']);
  });
  it('produces a flowchart parseMermaid accepts', () => {
    expect(parseMermaid(codeGraphToFlowchart(kotlinImportGraphAnalyzer.analyze(files), 'LR')).kind).toBe('flowchart');
  });
});

describe('kotlinCallGraphAnalyzer', () => {
  it('links top-level functions and methods, sibling calls and this.calls', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `
fun helper() {}
fun main() { helper(); val s = Svc(); s.run() }
class Svc { fun run() { step(); this.step() } fun step() { helper() } }
`)]);
    const e = calls(g);
    expect(e).toContain('main->helper');
    expect(e).toContain('main->Svc.run');
    expect(e).toContain('Svc.run->Svc.step');
    expect(e).toContain('Svc.step->helper');
  });
  it('resolves typed constructor properties and safe calls', () => {
    const g = kotlinCallGraphAnalyzer.analyze([
      f('r.kt', `class Repo { fun save() {} }`),
      f('s.kt', `class Svc(private val repo: Repo, val maybe: Repo?) { fun a() { repo.save() } fun b() { maybe?.save() } fun c() { this.repo.save() } }`),
    ]);
    const e = calls(g);
    expect(e).toContain('Svc.a->Repo.save');
    expect(e).toContain('Svc.b->Repo.save');
    expect(e).toContain('Svc.c->Repo.save');
  });
  it('resolves typed parameters, `val x = Foo()` locals and return-typed calls', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `
class Repo { fun save() {} }
fun open(): Repo = Repo()
fun a(r: Repo) { r.save() }
fun b() { val r = Repo(); r.save() }
fun c() { val r = open(); r.save() }
`)]);
    const e = calls(g);
    expect(e).toContain('a->Repo.save');
    expect(e).toContain('b->Repo.save');
    expect(e).toContain('c->Repo.save');
  });
  it('treats extension functions as methods of the receiver and resolves `for (r in repos)`', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `
class Repo { fun save() {} }
fun Repo.audit() { save() }
fun run(repos: List<Repo>, one: Repo) { for (r in repos) { r.save() }; one.audit() }
`)]);
    const e = calls(g);
    expect(e).toContain('run->Repo.save');
    expect(e).toContain('run->Repo.audit');
  });
  it('links interface calls to implementers with dotted edges and uses companion functions', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `
interface Store { fun put() }
class Mem : Store { override fun put() {} }
class Disk : Store { override fun put() {} }
class F { companion object { fun make() = F() } }
fun use(s: Store) { s.put(); F.make() }
`)]);
    const e = calls(g);
    expect(e).toContain('use->Mem.put?');
    expect(e).toContain('use->Disk.put?');
    expect(e).toContain('use->F.make');
  });
  it('does not link calls that appear only in comments or strings, and shadowing params block the edge', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `fun a() { // b()\n val s = "b()" }\nfun b() {}\nfun c(b: () -> Unit) { b() }`)]);
    expect(g.edges).toEqual([]);
  });
  it('produces a flowchart parseMermaid accepts', () => {
    const g = kotlinCallGraphAnalyzer.analyze([f('a.kt', `fun a() { b() }\nfun b() {}`)]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('kotlinRouteAnalyzer: Spring', () => {
  const src = `
@RestController
@RequestMapping("/api/users")
class UserController(private val svc: UserService) {
    @GetMapping fun all() = svc.all()
    @GetMapping("/{id}") fun one(@PathVariable id: Long) = svc.one(id)
    @PostMapping(value = ["/new", "/create"]) fun create() {}
    @DeleteMapping(path = ["/{id}"]) fun remove() {}
    @RequestMapping(value = ["/search"], method = [RequestMethod.GET, RequestMethod.POST]) fun search() {}
    @GetMapping(BASE + "/x") fun dyn() {}
    fun helper() {}
}
@Controller class Plain { @GetMapping("/p") fun p() {} }
class NotAController { @GetMapping("/no") fun n() {} }
`;
  it('reads class prefixes, verbs, array paths and RequestMapping methods', () => {
    expect(routeLabels(kotlinRouteAnalyzer.analyze([f('C.kt', src)]))).toEqual([
      'DELETE /api/users/{id} | UserController.remove',
      'GET /api/users | UserController.all',
      'GET /api/users/(dynamic) | UserController.dyn',
      'GET /api/users/search | UserController.search',
      'GET /api/users/{id} | UserController.one',
      'GET /p | Plain.p',
      'POST /api/users/create | UserController.create',
      'POST /api/users/new | UserController.create',
      'POST /api/users/search | UserController.search',
    ]);
  });
  it('produces a flowchart parseMermaid accepts', () => {
    expect(parseMermaid(codeGraphToFlowchart(kotlinRouteAnalyzer.analyze([f('C.kt', src)]), 'LR')).kind).toBe('flowchart');
  });
});

describe('kotlinRouteAnalyzer: Ktor', () => {
  it('maps routing { } with verbs, route prefixes and transparent authenticate blocks', () => {
    const g = kotlinRouteAnalyzer.analyze([f('App.kt', `
fun Application.module() {
    routing {
        get("/") { call.respondText("hi") }
        route("/api") {
            get("/users") { listUsers(call) }
            authenticate("auth") {
                post("/users") { call.respond(1) }
                route("/admin") { delete("/{id}") { } }
            }
        }
        put { }
    }
}
fun listUsers(c: Any) {}
`)]);
    expect(routeLabels(g)).toEqual([
      'DELETE /api/admin/{id} | (inline)',
      'GET / | (inline)',
      'GET /api/users | listUsers',
      'POST /api/users | (inline)',
      'PUT / | (inline)',
    ]);
  });
  it('mounts Route.xxxRoutes() extension functions under the calling prefix', () => {
    const g = kotlinRouteAnalyzer.analyze([
      f('Users.kt', `fun Route.userRoutes() { get("/users") { }; get("/users/{id}") { } }`),
      f('App.kt', `fun Application.module() { routing { route("/v1") { userRoutes() }; adminRoutes() } }\nfun Route.adminRoutes() { post("/admin") { } }`),
    ]);
    const labels = routeLabels(g);
    expect(labels).toContain('GET /v1/users | (inline)');
    expect(labels).toContain('GET /v1/users/{id} | (inline)');
    expect(labels).toContain('POST /admin | (inline)');
    expect(g.edges.filter((e) => e.kind === 'mount').map((e) => e.label).sort()).toEqual(['/', '/v1']);
  });
  it('handles typed resource routes, websockets, static content and HttpMethod routes', () => {
    const g = kotlinRouteAnalyzer.analyze([f('A.kt', `
fun Application.module() = routing {
    get<Articles.Id> { }
    webSocket("/ws") { }
    staticResources("/assets", "static")
    route("/legacy", HttpMethod.Post) { handle { } }
    get(Paths.USERS) { }
}
`)]);
    expect(routeLabels(g)).toEqual([
      'GET / | Articles.Id',
      'GET /(dynamic) | (inline)',
      'POST /legacy | (inline)',
      'STATIC /assets',
      'WS /ws | (inline)',
    ]);
  });
  it('ignores member calls such as map.get(..) and code outside routing blocks', () => {
    const g = kotlinRouteAnalyzer.analyze([f('A.kt', `fun f(m: Map<String,Int>) { m.get("k"); get("/x") { } }\nfun Application.module() { routing { val v = cache.get("k") } }`)]);
    expect(routeLabels(g)).toEqual([]);
  });
  it('combines Spring and Ktor in one graph that parseMermaid accepts', () => {
    const g = kotlinRouteAnalyzer.analyze([
      f('C.kt', `@RestController class C { @GetMapping("/s") fun s() {} }`),
      f('A.kt', `fun Application.module() { routing { get("/k") { } } }`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /k | (inline)', 'GET /s | C.s']);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});
