import { describe, it, expect } from 'vitest';
import { parseJava, analyzeJavaClasses, javaImportGraphAnalyzer, javaCallGraphAnalyzer, javaRouteAnalyzer } from '../src/analyzers/java/javaAnalyzer';
import { classesToClassDiagram, codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
const type = (src: string, name: string) => parseJava(src).types.find((t) => t.name === name)!;
const routeLabels = (g: ReturnType<typeof javaRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const edgePairs = (g: { edges: Array<{ from: string; to: string }> }) => g.edges.map((e) => `${e.from}=>${e.to}`).sort();

describe('parseJava: file level', () => {
  it('reads package and imports including static and wildcard', () => {
    const j = parseJava(`
package com.acme.app;
import java.util.List;
import static java.lang.Math.max;
import com.acme.util.*;
import static com.acme.Util.*;
public class A {}
`);
    expect(j.packageName).toBe('com.acme.app');
    expect(j.imports).toEqual([
      { name: 'java.util.List', isStatic: false, isWildcard: false },
      { name: 'java.lang.Math.max', isStatic: true, isWildcard: false },
      { name: 'com.acme.util.*', isStatic: false, isWildcard: true },
      { name: 'com.acme.Util.*', isStatic: true, isWildcard: true },
    ]);
  });

  it('ignores package/import/class text in comments and strings', () => {
    const j = parseJava(`
// import fake.Thing;
/* class Ghost {} */
class Real { String s = "class Fake {"; char c = '{'; String t = """
  class InBlock { }
  """; }
`);
    expect(j.types.map((t) => t.name)).toEqual(['Real']);
    expect(j.imports).toEqual([]);
    expect(j.types[0].fields.map((x) => x.name)).toEqual(['s', 'c', 't']);
  });

  it('never throws on malformed input', () => {
    for (const src of ['', 'class', 'class A {', 'class A { void f( }', '@@@', 'enum E { A(', 'interface I<T extends { }', 'class A { int x = ', '}}}}', 'record R(', 'class A { @Foo( void f(); }', '@interface']) {
      expect(() => parseJava(src)).not.toThrow();
    }
    expect(() => analyzeJavaClasses([f('A.java', 'class A { void f( {')])).not.toThrow();
    expect(() => javaCallGraphAnalyzer.analyze([f('A.java', 'class A { void f( {')])).not.toThrow();
    expect(() => javaRouteAnalyzer.analyze([f('A.java', '@RestController class A { @GetMapping( void f( {')])).not.toThrow();
  });
});

describe('parseJava: types', () => {
  const SRC = `
package p;
public abstract class Shape<T extends Comparable<T> & java.io.Serializable> extends Base<T> implements Drawable, Comparable<Shape<T>> {
  public abstract double area();
}
interface Drawable extends Renderable, java.io.Closeable { void draw(); }
enum Color { RED, GREEN }
record Point(int x, int y) implements Drawable {}
@interface Marker { String value() default "x"; }
sealed interface Expr permits Num, Add {}
non-sealed class Num implements Expr {}
`;
  it('reads kinds, modifiers and supertypes without generics', () => {
    const j = parseJava(SRC);
    const by = Object.fromEntries(j.types.map((t) => [t.name, t]));
    expect(Object.keys(by)).toEqual(['Shape', 'Drawable', 'Color', 'Point', 'Marker', 'Expr', 'Num']);
    expect(by.Shape.kind).toBe('class');
    expect(by.Shape.isAbstract).toBe(true);
    expect(by.Shape.visibility).toBe('public');
    expect(by.Shape.extends).toEqual(['Base']);
    expect(by.Shape.implements).toEqual(['Drawable', 'Comparable']);
    expect(by.Drawable.kind).toBe('interface');
    expect(by.Drawable.extends).toEqual(['Renderable', 'Closeable']);
    expect(by.Color.kind).toBe('enum');
    expect(by.Point.kind).toBe('record');
    expect(by.Point.implements).toEqual(['Drawable']);
    expect(by.Marker.kind).toBe('annotation');
    expect(by.Expr.permits).toEqual(['Num', 'Add']);
    expect(by.Expr.modifiers).toContain('sealed');
    expect(by.Num.modifiers).toContain('non-sealed');
  });

  it('flattens nested types and records the outer type', () => {
    const j = parseJava(`class Outer { class Inner { void f() {} } static class Nested extends Outer {} interface CB { void go(); } enum E { A } }`);
    expect(j.types.map((t) => t.name)).toEqual(['Outer', 'Inner', 'Nested', 'CB', 'E']);
    expect(j.types.find((t) => t.name === 'Inner')!.outer).toBe('Outer');
    expect(j.types.find((t) => t.name === 'Nested')!.extends).toEqual(['Outer']);
    expect(j.types[0].methods).toEqual([]);
  });

  it('reads record components as private final fields', () => {
    const r = type('record Person(@NotNull String name, final int age, List<String> tags, String... rest) { Person { if (age < 0) throw new IllegalArgumentException(); } public String greet() { return name; } }', 'Person');
    expect(r.fields.map((x) => `${x.type} ${x.name}`)).toEqual(['String name', 'int age', 'List<String> tags', 'String[] rest']);
    expect(r.fields.every((x) => x.visibility === 'private' && x.isFinal)).toBe(true);
    expect(r.methods.map((m) => m.name)).toEqual(['greet']); // compact constructor is not a method
  });

  it('reads enum constants (with args and bodies) and members after the semicolon', () => {
    const e = type(
      `enum Op implements IntBinaryOperator {
  PLUS("+", 1) { @Override public int applyAsInt(int a, int b) { return a + b; } },
  MINUS("-", 2) { int applyAsInt(int a, int b) { return a - b; } },
  @Deprecated TIMES("*", 3);
  private final String sym; private final int prec;
  Op(String sym, int prec) { this.sym = sym; this.prec = prec; }
  public String sym() { return sym; }
}`,
      'Op'
    );
    expect(e.enumConstants).toEqual(['PLUS', 'MINUS', 'TIMES']);
    expect(e.fields.map((x) => x.name)).toEqual(['sym', 'prec']);
    expect(e.methods.map((m) => m.name)).toEqual(['Op', 'sym']);
    expect(e.methods[0].isConstructor).toBe(true);
    expect(e.implements).toEqual(['IntBinaryOperator']);
  });

  it('handles an enum with only constants and trailing comma, and an empty enum', () => {
    expect(type('enum A { X, Y, }', 'A').enumConstants).toEqual(['X', 'Y']);
    expect(type('enum B { ; static int n; }', 'B').enumConstants).toEqual([]);
  });
});

describe('parseJava: members', () => {
  const SRC = `
public class Svc<T extends Number> extends Base {
  private final UserRepository repo;
  protected static final int MAX = 10, MIN = 1;
  int[] arr[], plain;
  public Map<String, List<Map<Integer, String>>> cache = new HashMap<String, List<Map<Integer, String>>>();
  private final Runnable r = () -> { int a = 1; a++; };
  private Object anon = new Object() { int hidden; void inner() { } };
  static { init(); }
  { counter++; }
  @Autowired
  public Svc(final UserRepository repo, @Value("\${a,b}") String name) { this.repo = repo; }
  public <E extends Exception> List<T> find(@Param("x") final String x, int... ids) throws E, IOException {
    return null;
  }
  public
    static
    <K, V>
    Map<K, V>
    build(
      K k,
      V v
    ) { return null; }
  abstract void gone();
  native int nat();
  void after() {}
}
`;
  const s = type(SRC, 'Svc');
  it('reads fields with visibility, type, static and multi-declarators', () => {
    const by = Object.fromEntries(s.fields.map((x) => [x.name, x]));
    expect(by.repo.type).toBe('UserRepository');
    expect(by.repo.visibility).toBe('private');
    expect(by.MAX.isStatic && by.MAX.isFinal).toBe(true);
    expect(by.MAX.visibility).toBe('protected');
    expect(by.MIN.type).toBe('int');
    expect(by.arr.type).toBe('int[][]');
    expect(by.plain.type).toBe('int[]');
    expect(by.plain.visibility).toBe('package');
    expect(by.cache.type).toBe('Map<String, List<Map<Integer, String>>>');
    expect(by.r.type).toBe('Runnable');
  });

  it('skips braces in field initialisers (lambdas / anonymous classes) without leaking members', () => {
    expect(s.fields.map((x) => x.name)).toEqual(['repo', 'MAX', 'MIN', 'arr', 'plain', 'cache', 'r', 'anon']);
    expect(s.methods.map((m) => m.name)).not.toContain('inner');
    expect(s.methods.map((m) => m.name)).toEqual(['Svc', 'find', 'build', 'gone', 'nat', 'after']);
  });

  it('reads constructors, generics, varargs, final params, throws and multi-line signatures', () => {
    const by = Object.fromEntries(s.methods.map((m) => [m.name, m]));
    expect(by.Svc.isConstructor).toBe(true);
    expect(by.Svc.params).toEqual(['repo', 'name']);
    expect(by.Svc.annotations.map((a) => a.name)).toEqual(['Autowired']);
    expect(by.find.params).toEqual(['x', 'ids']);
    expect(by.find.returnType).toBe('List<T>');
    expect(by.find.isConstructor).toBe(false);
    expect(by.build.params).toEqual(['k', 'v']);
    expect(by.build.returnType).toBe('Map<K, V>');
    expect(by.build.isStatic).toBe(true);
    expect(by.build.visibility).toBe('public');
    expect(by.gone.isAbstract).toBe(true);
    expect(by.gone.hasBody).toBe(false);
    expect(by.nat.hasBody).toBe(false);
    expect(by.after.hasBody).toBe(true);
  });

  it('does not treat static / instance initialiser blocks as methods', () => {
    expect(s.methods.some((m) => m.name === 'init' || m.name === 'counter')).toBe(false);
  });

  it('reads interface default, static, private and abstract methods', () => {
    const i = type('public interface Svc { int LIMIT = 5; void run(); default void helper() { run(); } static Svc of() { return null; } private void secret() {} }', 'Svc');
    const by = Object.fromEntries(i.methods.map((m) => [m.name, m]));
    expect(by.run.isAbstract).toBe(true);
    expect(by.run.visibility).toBe('public');
    expect(by.helper.isDefault && by.helper.hasBody && !by.helper.isAbstract).toBe(true);
    expect(by.of.isStatic && !by.of.isAbstract).toBe(true);
    expect(by.secret.visibility).toBe('private');
    expect(i.fields[0]).toMatchObject({ name: 'LIMIT', isStatic: true, isFinal: true, visibility: 'public' });
  });

  it('reads annotation arguments from the original text, including nested parens and strings', () => {
    const c = type(
      `@RequestMapping(value = "/api/{id}", produces = {"a/b", "c/d"}) @Deprecated(since = "1(") class C {
  @Schema(description = "has ) paren", example = @Ex("x)")) private String f;
  @GetMapping("/p") @org.springframework.web.bind.annotation.ResponseBody void m() {}
}`,
      'C'
    );
    expect(c.annotations.map((a) => a.name)).toEqual(['RequestMapping', 'Deprecated']);
    expect(c.annotations[0].args).toBe('value = "/api/{id}", produces = {"a/b", "c/d"}');
    expect(c.annotations[0].argsScrubbed).toHaveLength(c.annotations[0].args.length);
    expect(c.annotations[0].argsScrubbed).not.toContain('api');
    expect(c.annotations[1].args).toBe('since = "1("');
    expect(c.fields[0].annotations[0].args).toBe('description = "has ) paren", example = @Ex("x)")');
    expect(c.methods[0].annotations.map((a) => a.name)).toEqual(['GetMapping', 'ResponseBody']);
    expect(c.methods[0].annotations[0].args).toBe('"/p"');
  });

  it('reads annotation-type members with default arrays', () => {
    const a = type('@interface Tags { String[] value() default {"a", "b"}; int n() default 3; }', 'Tags');
    expect(a.methods.map((m) => m.name)).toEqual(['value', 'n']);
  });

  it('keeps method bodies scrubbed (no comment/string content)', () => {
    const c = type('class C { void m() { /* helper(); */ log("helper()"); real(); } }', 'C');
    expect(c.methods[0].body).not.toContain('helper');
    expect(c.methods[0].body).toContain('real()');
  });
});

describe('analyzeJavaClasses', () => {
  const SRC = `
package shapes;
public abstract class Shape<T> extends Base implements Comparable<Shape<T>>, Drawable {
  private final String name;
  protected int id;
  static int count;
  List<String> tags;
  Map<String, List<Integer>> index;
  public abstract double area();
  public static Shape<?> unit() { return null; }
  protected void log(String... msgs) {}
  void pkg() {}
  private int secret(int a, final int b) { return a; }
  public Shape(String name) {}
}
interface Drawable extends Renderable { void draw(); }
enum Color { RED, GREEN; public String hex() { return ""; } }
record Point(int x, int y) {}
`;
  const { classes, relationships } = analyzeJavaClasses([f('Shape.java', SRC)]);
  const by = Object.fromEntries(classes.map((c) => [c.id, c]));

  it('formats members with Mermaid visibility, static and abstract markers', () => {
    expect(by.Shape.stereotype).toBe('abstract');
    expect(by.Shape.members).toContain('-name String');
    expect(by.Shape.members).toContain('#id int');
    expect(by.Shape.members).toContain('~count int$');
    expect(by.Shape.members).toContain('~tags List~String~');
    expect(by.Shape.members).toContain('~index Map~String, List~Integer~~');
    expect(by.Shape.members).toContain('+area() double*');
    expect(by.Shape.members).toContain('+unit() Shape~Object~$');
    expect(by.Shape.members).toContain('#log(msgs) void');
    expect(by.Shape.members).toContain('~pkg() void');
    expect(by.Shape.members).toContain('-secret(a, b) int');
    expect(by.Shape.members).toContain('+Shape(name)');
  });

  it('assigns stereotypes', () => {
    expect(by.Drawable.stereotype).toBe('interface');
    expect(by.Drawable.members).toContain('+draw() void*');
    expect(by.Color.stereotype).toBe('enumeration');
    expect(by.Color.members.slice(0, 2)).toEqual(['RED', 'GREEN']);
    expect(by.Color.members).toContain('+hex() String');
    expect(by.Point.stereotype).toBeNull();
    expect(by.Point.members).toContain('-x int');
  });

  it('maps extends to inheritance and implements to realization; interface extends is inheritance', () => {
    expect(relationships).toContainEqual({ from: 'Shape', to: 'Base', type: 'inheritance' });
    expect(relationships).toContainEqual({ from: 'Shape', to: 'Comparable', type: 'realization' });
    expect(relationships).toContainEqual({ from: 'Shape', to: 'Drawable', type: 'realization' });
    expect(relationships).toContainEqual({ from: 'Drawable', to: 'Renderable', type: 'inheritance' });
  });

  it('deduplicates types declared in several files', () => {
    const r = analyzeJavaClasses([f('A.java', 'class A extends B {}'), f('A2.java', 'class A extends B {}')]);
    expect(r.classes).toHaveLength(1);
    expect(r.relationships).toHaveLength(1);
  });

  it('produces a class diagram that parseMermaid accepts', () => {
    const src = classesToClassDiagram(classes, relationships);
    const parsed = parseMermaid(src);
    expect(parsed.kind).toBe('classDiagram');
  });

  it('produces valid Mermaid for arrays, nested generics, wildcards and qualified types', () => {
    const r = analyzeJavaClasses([
      f(
        'X.java',
        `class X<T> extends java.util.ArrayList<T> {
  private int[][] grid;
  java.util.Map<String, java.util.List<? extends Number>> m;
  public <E> E[] toArray(E[] in, java.util.function.Function<? super T, ?> fn) { return null; }
  Optional<String> opt() { return null; }
}`
      ),
    ]);
    const parsed = parseMermaid(classesToClassDiagram(r.classes, r.relationships));
    expect(parsed.kind).toBe('classDiagram');
    expect(r.relationships).toContainEqual({ from: 'X', to: 'ArrayList', type: 'inheritance' });
  });

  it('keeps external supertypes as declared (rendered as empty classes)', () => {
    const r = analyzeJavaClasses([f('A.java', 'class A implements Runnable {}')]);
    expect(r.classes.map((c) => c.id)).toEqual(['A']);
    expect(classesToClassDiagram(r.classes, r.relationships)).toContain('Runnable <|.. A');
  });
});

describe('javaImportGraphAnalyzer', () => {
  const files = [
    f('src/com/acme/web/Ctl.java', 'package com.acme.web;\nimport com.acme.svc.Service;\nimport com.acme.model.*;\nimport java.util.List;\nimport org.spring.Thing;\nclass Ctl {}'),
    f('src/com/acme/svc/Service.java', 'package com.acme.svc;\nimport com.acme.model.User;\nimport static com.acme.util.Strings.trim;\nclass Service {}'),
    f('src/com/acme/model/User.java', 'package com.acme.model;\npublic class User {}'),
    f('src/com/acme/model/Role.java', 'package com.acme.model;\nenum Role { A }'),
    f('src/com/acme/util/Strings.java', 'package com.acme.util;\nclass Strings { static String trim(String s) { return s; } }'),
    f('src/com/acme/svc/Helper.java', 'package com.acme.svc;\nclass Helper { Service s; }'),
  ];
  const g = javaImportGraphAnalyzer.analyze(files);

  it('has one file node per input', () => {
    expect(g.nodes.map((n) => n.kind)).toEqual(Array(6).fill('file'));
    expect(g.nodes[0].id).toBe('src/com/acme/web/Ctl.java');
  });

  it('links explicit, wildcard and static imports to scanned files; ignores JDK/third-party', () => {
    expect(edgePairs(g)).toEqual(
      [
        'src/com/acme/web/Ctl.java=>src/com/acme/svc/Service.java',
        'src/com/acme/web/Ctl.java=>src/com/acme/model/User.java',
        'src/com/acme/web/Ctl.java=>src/com/acme/model/Role.java',
        'src/com/acme/svc/Service.java=>src/com/acme/model/User.java',
        'src/com/acme/svc/Service.java=>src/com/acme/util/Strings.java',
      ].sort()
    );
  });

  it('does not draw same-package edges without an import', () => {
    expect(g.edges.some((e) => e.from.endsWith('Helper.java'))).toBe(false);
  });

  it('resolves imports of nested types to the outer type file', () => {
    const r = javaImportGraphAnalyzer.analyze([f('A.java', 'package a;\nimport b.Outer.Inner;\nclass A {}'), f('B.java', 'package b;\npublic class Outer { public static class Inner {} }')]);
    expect(edgePairs(r)).toEqual(['A.java=>B.java']);
  });

  it('handles files without a package and avoids self edges', () => {
    const r = javaImportGraphAnalyzer.analyze([f('A.java', 'import B;\nimport A;\nclass A {}'), f('B.java', 'class B {}')]);
    expect(edgePairs(r)).toEqual(['A.java=>B.java']);
  });

  it('flowchart parses with parseMermaid', () => {
    const parsed = parseMermaid(codeGraphToFlowchart(g));
    expect(parsed.kind).toBe('flowchart');
  });
});

const CONTROLLER = `
package com.acme.web;
@RestController
@RequestMapping("/api/users")
public class UserController {
  private final UserService service;
  private final List<Audit> audits = new ArrayList<>();
  public UserController(UserService service) { this.service = service; }
  @GetMapping("/{id}")
  public User get(@PathVariable Long id) { return service.find(id); }
  @PostMapping
  public User create(@RequestBody User u) { audit(); return service.create(u); }
  private void audit() { audits.forEach(a -> a.record()); this.helper(); }
  private void helper() {}
}`;
const SERVICE = `
package com.acme.svc;
public interface UserService { User find(Long id); User create(User u); }`;
const SERVICE_IMPL = `
package com.acme.svc;
@Service
public class UserServiceImpl implements UserService {
  private final UserRepository repo;
  private final Notifier notifier;
  @Autowired
  public UserServiceImpl(UserRepository repo, Notifier notifier) { this.repo = repo; this.notifier = notifier; }
  public User find(Long id) { return repo.findById(id); }
  public User create(User u) { validate(u); User saved = this.repo.save(u); notifier.send(saved); return saved; }
  private void validate(User u) {}
}`;
const REPO = `
package com.acme.repo;
public interface UserRepository extends JpaRepository<User, Long> { User findById(Long id); User save(User u); }`;
const REPO_IMPL = `
package com.acme.repo;
@Repository
public class UserRepositoryImpl implements UserRepository {
  public User findById(Long id) { return Db.query(id); }
  public User save(User u) { return Db.insert(u); }
}`;
const NOTIFIER = `
package com.acme.svc;
public class Notifier { public void send(Object o) { Mailer.deliver(o); } }`;
const MAILER = `
package com.acme.svc;
public class Mailer { public static void deliver(Object o) {} }`;
const DB = `package com.acme.repo;\nclass Db { static User query(Long id) { return null; } static User insert(User u) { return u; } }`;

const APP = [
  f('web/UserController.java', CONTROLLER),
  f('svc/UserService.java', SERVICE),
  f('svc/UserServiceImpl.java', SERVICE_IMPL),
  f('repo/UserRepository.java', REPO),
  f('repo/UserRepositoryImpl.java', REPO_IMPL),
  f('svc/Notifier.java', NOTIFIER),
  f('svc/Mailer.java', MAILER),
  f('repo/Db.java', DB),
];

describe('javaCallGraphAnalyzer: realistic Spring app', () => {
  const g = javaCallGraphAnalyzer.analyze(APP);
  const has = (a: string, b: string) => g.edges.some((e) => e.from.endsWith(`::${a}`) && e.to.endsWith(`::${b}`));

  it('follows controller -> service -> repository through constructor-injected fields', () => {
    // UserService has a single scanned implementation, so the field resolves to UserServiceImpl.
    expect(has('UserController.get', 'UserServiceImpl.find')).toBe(true);
    expect(has('UserController.create', 'UserServiceImpl.create')).toBe(true);
    expect(has('UserServiceImpl.find', 'UserRepositoryImpl.findById')).toBe(true);
    expect(has('UserServiceImpl.create', 'UserRepositoryImpl.save')).toBe(true); // this.repo.save()
    expect(has('UserRepositoryImpl.save', 'Db.insert')).toBe(true); // static call on a class
  });

  it('resolves bare sibling calls and this.method()', () => {
    expect(has('UserController.create', 'UserController.audit')).toBe(true);
    expect(has('UserController.audit', 'UserController.helper')).toBe(true);
    expect(has('UserServiceImpl.create', 'UserServiceImpl.validate')).toBe(true);
  });

  it('resolves a field of a concrete class type and a static call from a method', () => {
    expect(has('UserServiceImpl.create', 'Notifier.send')).toBe(true);
    expect(has('Notifier.send', 'Mailer.deliver')).toBe(true);
  });

  it('does not resolve fields typed with generics (List<Audit>) or locals', () => {
    expect(g.edges.some((e) => e.from.endsWith('UserController.audit') && /Audit/.test(e.to))).toBe(false);
  });

  it('labels nodes Class.method and kind method', () => {
    const n = g.nodes.find((x) => x.id.endsWith('::UserController.get'))!;
    expect(n.label).toBe('UserController.get');
    expect(n.kind).toBe('method');
  });

  it('uses the interface method node, plus dotted edges to each implementation, when a field type has several', () => {
    const g2 = javaCallGraphAnalyzer.analyze([
      f('A.java', 'class Client { private final Sender s; void go() { s.send(); } }'),
      f('S.java', 'interface Sender { void send(); }'),
      f('S1.java', 'class Smtp implements Sender { public void send() {} }'),
      f('S2.java', 'class Sms implements Sender { public void send() {} }'),
    ]);
    expect(edgePairs(g2).sort()).toEqual(['A.java::Client.go=>S.java::Sender.send', 'A.java::Client.go=>S1.java::Smtp.send', 'A.java::Client.go=>S2.java::Sms.send']);
    expect(g2.edges.filter((e) => e.kind === 'ambiguous').length).toBe(2);
  });

  it('resolves a local declared with its class and a typed parameter', () => {
    const g2 = javaCallGraphAnalyzer.analyze([
      f('A.java', 'class A { void go(B b) { b.run(); B c = new B(); c.run(); } void viaParam(B b) { b.run(); } }'),
      f('B.java', 'class B { void run() {} }'),
    ]);
    expect(g2.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['A.java::A.go->B.java::B.run', 'A.java::A.viaParam->B.java::B.run']);
  });

  it('does not link calls that appear only in comments or strings', () => {
    const g2 = javaCallGraphAnalyzer.analyze([f('A.java', 'class A { void a() { // b();\n log("b()"); } void b() {} }')]);
    expect(g2.edges).toEqual([]);
  });

  it('produces a flowchart that parseMermaid accepts', () => {
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('javaRouteAnalyzer: Spring', () => {
  it('builds a router node and routes with class prefix + method path', () => {
    const g = javaRouteAnalyzer.analyze([f('web/UserController.java', CONTROLLER)]);
    const router = g.nodes.find((n) => n.kind === 'router')!;
    expect(router.label).toBe('UserController<br/>/api/users');
    expect(routeLabels(g)).toEqual(['GET /api/users/{id} | UserController.get', 'POST /api/users | UserController.create']);
    expect(g.edges.filter((e) => e.from === router.id && e.kind === 'route')).toHaveLength(2);
  });

  it('supports all verb shortcuts and normalises slashes', () => {
    const g = javaRouteAnalyzer.analyze([
      f(
        'A.java',
        `@Controller @RequestMapping("items/")
class A {
  @GetMapping("/list") void l() {}
  @PostMapping("//new/") void n() {}
  @PutMapping(path = "{id}") void u() {}
  @DeleteMapping(value = "/{id}") void d() {}
  @PatchMapping("/{id}/x") void p() {}
}`
      ),
    ]);
    expect(routeLabels(g)).toEqual(['DELETE /items/{id} | A.d', 'GET /items/list | A.l', 'PATCH /items/{id}/x | A.p', 'POST /items/new | A.n', 'PUT /items/{id} | A.u']);
  });

  it('handles RequestMapping with method=, value/path, arrays and no method (ANY)', () => {
    const g = javaRouteAnalyzer.analyze([
      f(
        'A.java',
        `@RestController
class A {
  @RequestMapping(value = "/a", method = RequestMethod.GET) void a() {}
  @RequestMapping(path = {"/b", "/b2"}, method = {RequestMethod.POST, RequestMethod.PUT}) void b() {}
  @RequestMapping("/any") void any() {}
  @GetMapping({"/x", "/y"}) void xy() {}
  @RequestMapping(method = RequestMethod.DELETE) void root() {}
}`
      ),
    ]);
    expect(routeLabels(g)).toEqual([
      'ANY /any | A.any',
      'DELETE / | A.root',
      'GET /a | A.a',
      'GET /x | A.xy',
      'GET /y | A.xy',
      'POST /b | A.b',
      'POST /b2 | A.b',
      'PUT /b | A.b',
      'PUT /b2 | A.b',
    ]);
  });

  it('applies array class-level prefixes to every route', () => {
    const g = javaRouteAnalyzer.analyze([f('A.java', '@RestController @RequestMapping({"/v1", "/v2"}) class A { @GetMapping("/p") void p() {} }')]);
    expect(routeLabels(g)).toEqual(['GET /v1/p | A.p', 'GET /v2/p | A.p']);
    expect(g.nodes.find((n) => n.kind === 'router')!.label).toBe('A<br/>/v1, /v2');
  });

  it('works without any prefix and with an empty mapping', () => {
    const g = javaRouteAnalyzer.analyze([f('A.java', '@RestController class A { @GetMapping void root() {} @GetMapping("") void empty() {} }')]);
    expect(routeLabels(g)).toEqual(['GET / | A.empty', 'GET / | A.root']);
    expect(g.nodes.find((n) => n.kind === 'router')!.label).toBe('A');
  });

  it('reads paths from the original text (strings are blanked in the scrubbed copy) and ignores commented-out routes', () => {
    const g = javaRouteAnalyzer.analyze([
      f('A.java', `@RestController class A {\n // @GetMapping("/ghost")\n void ghost() {}\n /* @GetMapping("/ghost2") */\n @GetMapping("/real,with{braces}") void real() {} }`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /real,with{braces} | A.real']);
  });

  it('marks paths built from constants or concatenation as (dynamic); concatenated literals are joined', () => {
    const g = javaRouteAnalyzer.analyze([
      f('A.java', `@RestController class A { @GetMapping(Paths.USERS) void a() {} @GetMapping("/x" + SUFFIX) void b() {} @GetMapping("/p" + "/q") void c() {} }`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /(dynamic) | A.a', 'GET /(dynamic) | A.b', 'GET /p/q | A.c']);
  });

  it('ignores non-controller classes, advice classes and unannotated methods', () => {
    const g = javaRouteAnalyzer.analyze([
      f('A.java', '@Service class S { @GetMapping("/no") void n() {} }'),
      f('B.java', '@RestControllerAdvice class Adv { @ExceptionHandler void h() {} }'),
      f('C.java', '@RestController class C { void helper() {} @GetMapping("/ok") void ok() {} }'),
    ]);
    expect(g.nodes.filter((n) => n.kind === 'router').map((n) => n.label)).toEqual(['C']);
    expect(routeLabels(g)).toEqual(['GET /ok | C.ok']);
  });

  it('gives unique node ids for overloads, same class names in different files and duplicate paths', () => {
    const g = javaRouteAnalyzer.analyze([
      f('a/Ctl.java', '@RestController class Ctl { @GetMapping("/x") void m() {} @GetMapping("/x") void m(int a) {} }'),
      f('b/Ctl.java', '@RestController class Ctl { @GetMapping("/x") void m() {} }'),
    ]);
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.nodes.filter((n) => n.kind === 'route')).toHaveLength(3);
  });

  it('handles WebFlux return types and fully-qualified annotations', () => {
    const g = javaRouteAnalyzer.analyze([
      f('A.java', '@org.springframework.web.bind.annotation.RestController class A { @GetMapping("/s") public Flux<Item> stream() { return null; } @PostMapping("/m") Mono<Void> save(@RequestBody Mono<Item> i) { return null; } }'),
    ]);
    expect(routeLabels(g)).toEqual(['GET /s | A.stream', 'POST /m | A.save']);
  });

  it('flowchart of routes parses with parseMermaid', () => {
    const g = javaRouteAnalyzer.analyze([f('web/UserController.java', CONTROLLER)]);
    const out = codeGraphToFlowchart(g, 'LR');
    expect(out).toContain('GET /api/users/{id}<br/>UserController.get');
    expect(parseMermaid(out).kind).toBe('flowchart');
  });
});

describe('javaRouteAnalyzer: JAX-RS', () => {
  it('maps @Path + verb annotations', () => {
    const g = javaRouteAnalyzer.analyze([
      f(
        'R.java',
        `@Path("/orders")
public class OrderResource {
  @GET public List<Order> all() { return null; }
  @GET @Path("/{id}") public Order one(@PathParam("id") long id) { return null; }
  @POST @Consumes("application/json") public Response add(Order o) { return null; }
  @DELETE @Path("{id}") public void del() {}
  @Path("/sub") public SubResource locator() { return null; }
}`
      ),
    ]);
    expect(g.nodes.find((n) => n.kind === 'router')!.label).toBe('OrderResource<br/>/orders');
    expect(routeLabels(g)).toEqual(['DELETE /orders/{id} | OrderResource.del', 'GET /orders | OrderResource.all', 'GET /orders/{id} | OrderResource.one', 'POST /orders | OrderResource.add']);
  });
});

describe('analyzer metadata', () => {
  it('declares ids and the .java extension', () => {
    for (const a of [javaImportGraphAnalyzer, javaCallGraphAnalyzer, javaRouteAnalyzer]) {
      expect(a.supportedExtensions).toEqual(['.java']);
      expect(a.id).toMatch(/^java-/);
    }
    expect(new Set([javaImportGraphAnalyzer.id, javaCallGraphAnalyzer.id, javaRouteAnalyzer.id]).size).toBe(3);
  });

  it('all analyzers return empty graphs for empty input', () => {
    for (const a of [javaImportGraphAnalyzer, javaCallGraphAnalyzer, javaRouteAnalyzer]) expect(a.analyze([])).toEqual({ nodes: [], edges: [] });
  });
});

describe('java call graph: typed locals and shadowing', () => {
  it('Repo r = new Repo(); r.save() resolves to Repo.save only', () => {
    const g = javaCallGraphAnalyzer.analyze([
      { path: 'A.java', text: `class Repo { void save() {} }\nclass Other { void save() {} }\nclass Main { void go() { Repo r = new Repo(); r.save(); } }` },
    ]);
    expect(g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`)).toEqual(['Main.go->Repo.save']);
  });
});
