import { describe, it, expect } from 'vitest';
import { parseGo, analyzeGoClasses, goImportGraphAnalyzer, goCallGraphAnalyzer, stripGoComments, isStdlibImport, defaultImportAlias } from '../src/analyzers/go/goAnalyzer';
import { goRouteAnalyzer } from '../src/analyzers/go/goRouteAnalyzer';
import { runAnalysis } from '../src/analyzers/registry';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });

describe('helpers', () => {
  it('stripGoComments keeps strings, blanks comments, preserves length', () => {
    const src = 'a := "x // not a comment" // real\n/* block\n */ b';
    const out = stripGoComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('"x // not a comment"');
    expect(out).not.toContain('real');
    expect(out).not.toContain('block');
  });
  it('recognises stdlib imports by first segment', () => {
    expect(isStdlibImport('net/http')).toBe(true);
    expect(isStdlibImport('fmt')).toBe(true);
    expect(isStdlibImport('github.com/x/y')).toBe(false);
    expect(isStdlibImport('myapp/internal/db')).toBe(false);
  });
  it('derives default import aliases', () => {
    expect(defaultImportAlias('github.com/a/b/util')).toBe('util');
    expect(defaultImportAlias('github.com/a/b/v2')).toBe('b');
    expect(defaultImportAlias('gopkg.in/yaml.v3')).toBe('yaml');
  });
});

describe('parseGo', () => {
  const src = `package shop

import (
	"fmt"
	// "commented/out"
	db "example.com/app/internal/db"
	_ "example.com/app/drivers"
)
import "example.com/app/util"

type Item struct {
	ID    int
	Name, Label string \`json:"name"\`
	Tags  []string
	Handler func(a int) error
	Base
	*sync.Mutex
}

type Store interface {
	Get(id int) (*Item, error)
	Put(i *Item) error
	io.Closer
}

type Stack[T any] struct { items []T }
type Color int
type Alias = Item
type (
	A struct{ X int }
	B interface{ M() }
)

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }
func New() *Item { return &Item{} }
func Generic[K comparable, V any](m map[K]V) int { return len(m) }
func Empty() interface{} { return nil }
func decl(a int) int
`;
  const go = parseGo(src);
  it('reads package and imports (ignoring commented ones)', () => {
    expect(go.pkg).toBe('shop');
    expect(go.imports.map((i) => `${i.alias}=${i.path}`)).toEqual([
      'fmt=fmt',
      'db=example.com/app/internal/db',
      '_=example.com/app/drivers',
      'util=example.com/app/util',
    ]);
  });
  it('parses struct fields, multi-name fields, embeds', () => {
    const item = go.types.find((t) => t.name === 'Item')!;
    expect(item.kind).toBe('struct');
    expect(item.fields.map((x) => x.name)).toEqual(['ID', 'Name', 'Label', 'Tags', 'Handler']);
    expect(item.embeds).toEqual(['Base', 'sync.Mutex']);
  });
  it('parses interface methods and embedded interfaces', () => {
    const st = go.types.find((t) => t.name === 'Store')!;
    expect(st.kind).toBe('interface');
    expect(st.methods.map((m) => m.name)).toEqual(['Get', 'Put']);
    expect(st.embeds).toEqual(['io.Closer']);
  });
  it('handles generic types, defined types, grouped types; skips aliases', () => {
    const names = go.types.map((t) => t.name);
    expect(names).toContain('Stack');
    expect(names).toContain('Color');
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).not.toContain('Alias');
    expect(go.types.find((t) => t.name === 'Stack')!.fields.map((x) => x.name)).toEqual(['items']);
  });
  it('parses funcs, receivers (incl. generic), and bodyless decls', () => {
    const push = go.funcs.find((x) => x.name === 'Push')!;
    expect(push.owner).toBe('Stack');
    expect(push.recv).toBe('s');
    expect(push.hasBody).toBe(true);
    expect(go.funcs.find((x) => x.name === 'Generic')!.ret).toBe('int');
    expect(go.funcs.find((x) => x.name === 'Empty')!.ret).toBe('interface{}');
    expect(go.funcs.find((x) => x.name === 'decl')!.hasBody).toBe(false);
  });
  it('never throws on garbage', () => {
    for (const bad of ['', 'package', 'type', 'type X struct {', 'func (', 'func f(', 'import (', '}}}{{{', 'func f() {', 'type T[', '\u0000\u0001', 'import "']) {
      expect(() => parseGo(bad)).not.toThrow();
    }
    expect(() => parseGo(undefined as unknown as string)).not.toThrow();
  });
});

describe('package graph', () => {
  const files = [
    f('cmd/app/main.go', 'package main\nimport (\n"fmt"\n"example.com/app/internal/db"\n"example.com/app/internal/util"\n)\nfunc main(){}'),
    f('internal/db/db.go', 'package db\nimport "example.com/app/internal/util"\n'),
    f('internal/db/other.go', 'package db\nimport "net/http"\n'),
    f('internal/util/u.go', 'package util\n'),
    f('internal/util/u_test.go', 'package util\nimport "example.com/app/cmd/app"\n'),
  ];
  const g = goImportGraphAnalyzer.analyze(files);
  it('makes one node per package directory (test files excluded)', () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['cmd/app', 'internal/db', 'internal/util']);
  });
  it('resolves imports by path suffix and ignores stdlib', () => {
    const e = g.edges.map((x) => `${x.from}->${x.to}`).sort();
    expect(e).toEqual(['cmd/app->internal/db', 'cmd/app->internal/util', 'internal/db->internal/util']);
  });
  it('does not confuse a local "http" dir with net/http', () => {
    const g2 = goImportGraphAnalyzer.analyze([f('a/a.go', 'package a\nimport "net/http"'), f('http/h.go', 'package http')]);
    expect(g2.edges).toEqual([]);
  });
  it('prefers the longest matching directory suffix', () => {
    const g3 = goImportGraphAnalyzer.analyze([
      f('a/a.go', 'package a\nimport "ex.com/m/x/util"'),
      f('util/u.go', 'package util'),
      f('x/util/u.go', 'package util'),
    ]);
    expect(g3.edges.map((e) => e.to)).toEqual(['x/util']);
  });
});

describe('type diagram', () => {
  const files = [
    f('a/model.go', `package a
type Animal interface { Speak() string }
type Base struct { Name string }
type Dog struct {
	Base
	age int
	sync.Mutex
}
func (d *Dog) Speak() string { return "woof" }
func (d Dog) Age() int { return d.age }
type Rock struct{}
`),
  ];
  const { classes, relationships } = analyzeGoClasses(files);
  it('lists structs and interfaces with exported/unexported markers', () => {
    const dog = classes.find((c) => c.id === 'Dog')!;
    expect(dog.members).toContain('-age int');
    expect(dog.members).toContain('+Mutex'.replace('+Mutex', '+sync.Mutex'));
    expect(dog.members).toContain('+Speak() string');
    expect(dog.members).toContain('+Age() int');
    expect(classes.find((c) => c.id === 'Animal')!.stereotype).toBe('interface');
  });
  it('puts fields before methods', () => {
    const dog = classes.find((c) => c.id === 'Dog')!;
    expect(dog.members.findIndex((m) => m.includes('('))).toBeGreaterThan(dog.members.findIndex((m) => m === '-age int'));
  });
  it('turns scanned embeddings into inheritance edges and skips them as fields', () => {
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Base', type: 'inheritance' });
    expect(classes.find((c) => c.id === 'Dog')!.members).not.toContain('+Base');
  });
  it('infers implements from method names, including promoted methods', () => {
    expect(relationships).toContainEqual({ from: 'Dog', to: 'Animal', type: 'realization' });
    expect(relationships.some((r) => r.from === 'Rock')).toBe(false);
  });
  it('does not make empty interfaces implemented by everything', () => {
    const r = analyzeGoClasses([f('x.go', 'package x\ntype Any interface{}\ntype T struct{}')]);
    expect(r.relationships).toEqual([]);
  });
  it('prefixes ids when the same type name exists in two packages', () => {
    const r = analyzeGoClasses([f('a/t.go', 'package a\ntype T struct{ X int }'), f('b/t.go', 'package b\ntype T struct{ Y int }')]);
    expect(r.classes.map((c) => c.id).sort()).toEqual(['a_T', 'b_T']);
  });
  it('collapses func-typed fields and any/struct types so Mermaid stays valid', () => {
    const r = analyzeGoClasses([f('x.go', 'package x\ntype T struct {\n F func(a int) error\n M map[string]interface{}\n S struct{ A int }\n C <-chan int\n}')]);
    const members = r.classes[0].members;
    expect(members).toContain('+F func');
    expect(members).toContain('+M map[string]any');
    expect(members).toContain('+S struct');
    expect(members.some((m) => m.includes('<-') || m.includes('{'))).toBe(false);
  });
  it('merges methods declared in other files of the package', () => {
    const r = analyzeGoClasses([f('p/a.go', 'package p\ntype T struct{}'), f('p/b.go', 'package p\nfunc (t *T) Run() {}')]);
    expect(r.classes[0].members).toContain('+Run()');
  });
});

describe('call graph', () => {
  const files = [
    f('svc/svc.go', `package svc
import "example.com/app/util"
func Run() { helper(); util.Do() }
func helper() {}
type S struct{}
func (s *S) A() { s.B() }
func (s *S) B() { helper() }
`),
    f('util/util.go', 'package util\nfunc Do() {}\nfunc helper() {}'),
  ];
  const g = goCallGraphAnalyzer.analyze(files);
  const edge = (a: string, b: string) => g.edges.some((e) => e.from.endsWith(a) && e.to.endsWith(b));
  it('resolves same-package bare calls only within the package', () => {
    expect(edge('svc.go::Run', 'svc.go::helper')).toBe(true);
    expect(edge('svc.go::Run', 'util.go::helper')).toBe(false);
  });
  it('resolves receiver calls using the receiver variable name', () => {
    expect(edge('S.A', 'S.B')).toBe(true);
    expect(edge('S.B', 'svc.go::helper')).toBe(true);
  });
  it('resolves pkg.Func() through imports to the scanned package', () => {
    expect(edge('svc.go::Run', 'util.go::Do')).toBe(true);
  });
  it('ignores stdlib qualified calls', () => {
    const g2 = goCallGraphAnalyzer.analyze([f('a/a.go', 'package a\nimport "fmt"\nfunc F(){ fmt.Println() }\nfunc Println(){}')]);
    expect(g2.edges).toEqual([]);
  });
});

describe('routes', () => {
  const routes = (src: string) => {
    const g = goRouteAnalyzer.analyze([f('main.go', src)]);
    return g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace('<br/>', ' | '));
  };
  it('gin: verbs, groups and full paths', () => {
    const r = routes(`package main
func main() {
	r := gin.Default()
	r.GET("/ping", ping)
	api := r.Group("/api")
	v1 := api.Group("/v1")
	v1.POST("/users", mw, createUser)
}`);
    expect(r).toEqual(['GET /ping | ping', 'POST /api/v1/users | createUser']);
  });
  it('echo and fiber verbs, Any', () => {
    expect(routes('package m\nfunc f(){ e := echo.New()\n e.PUT("/x", h)\n e.Any("/y", h2) }')).toEqual(['PUT /x | h', 'ANY /y | h2']);
  });
  it('chi: mixed-case verbs and Mount of a known subrouter', () => {
    const g = goRouteAnalyzer.analyze([f('m.go', `package m
func f() {
	r := chi.NewRouter()
	sub := chi.NewRouter()
	sub.Get("/items", list)
	r.Mount("/shop", sub)
}`)]);
    const labels = g.nodes.filter((n) => n.kind === 'route').map((n) => n.label);
    expect(labels[0]).toContain('GET /shop/items');
    expect(g.edges.some((e) => e.kind === 'mount' && e.label === '/shop')).toBe(true);
  });
  it('net/http default mux and ServeMux with Go 1.22 method patterns', () => {
    const r = routes(`package m
func f() {
	http.HandleFunc("/health", health)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", getUser)
	mux.Handle("/static/", fs)
}`);
    expect(r).toEqual(['ANY /health | health', 'GET /users/{id} | getUser', 'ANY /static/ | fs']);
  });
  it('gorilla: .Methods() creates one route per method', () => {
    expect(routes('package m\nfunc f(){ r := mux.NewRouter()\n r.HandleFunc("/a", h).Methods("GET", "POST") }')).toEqual(['GET /a | h', 'POST /a | h']);
  });
  it('shows inline handlers and non-literal paths as text', () => {
    const r = routes('package m\nfunc f(){ r := gin.New()\n r.GET(base+"/x", func(c *gin.Context){}) }');
    expect(r[0]).toContain('(inline)');
    expect(r[0]).toContain('base+"/x"');
  });
  it('ignores comments and strings that look like routes', () => {
    expect(routes('package m\nfunc f(){ r := gin.New()\n // r.GET("/no", h)\n s := "r.GET(\\"/no\\", h)"\n _ = s }')).toEqual([]);
  });
  it('ignores calls on unknown receivers', () => {
    expect(routes('package m\nfunc f(){ x.GET("/a", h) }')).toEqual([]);
  });
  it('skips _test.go files and never throws on garbage', () => {
    expect(goRouteAnalyzer.analyze([f('a_test.go', 'r := gin.New()\nr.GET("/a", h)')]).nodes).toEqual([]);
    for (const bad of ['', 'r := gin.New()\nr.GET(', 'r := gin.New()\nr.Group(', '((((']) {
      expect(() => goRouteAnalyzer.analyze([f('m.go', bad)])).not.toThrow();
    }
  });
});

describe('registry integration', () => {
  it('every Go analysis renders Mermaid that our parser accepts', () => {
    const files = [
      f('cmd/main.go', 'package main\nimport "ex.com/m/internal/svc"\nfunc main(){ svc.Run() }\nfunc setup(){ r := gin.Default()\n r.GET("/a", h) }'),
      f('internal/svc/svc.go', 'package svc\ntype S struct{ X int }\nfunc (s *S) Do() {}\nfunc Run() {}'),
    ];
    for (const kind of ['imports', 'classes', 'calls', 'routes'] as const) {
      const out = runAnalysis('go', kind, files);
      expect(out.mermaid, kind).not.toBeNull();
      expect(parseMermaid(out.mermaid!).kind, kind).not.toBe('unknown');
    }
  });
});

describe('routes through functions, closures and aliases', () => {
  const graph = (files: Array<[string, string]>) => goRouteAnalyzer.analyze(files.map(([p, t]) => f(p, t)));
  const labels = (g: ReturnType<typeof graph>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace('<br/>', ' | ')).sort();
  const edgeLabels = (g: ReturnType<typeof graph>) => g.edges.filter((e) => e.kind === 'mount').map((e) => e.label);

  it('binds a router group passed to another package\'s Register function', () => {
    const g = graph([
      ['hello.go', 'package main\nimport ("github.com/gin-gonic/gin"; "x/users")\nfunc main() {\n r := gin.Default()\n v1 := r.Group("/api")\n users.UsersRegister(v1.Group("/users"))\n}\n'],
      ['users/routers.go', 'package users\nimport "github.com/gin-gonic/gin"\nfunc UsersRegister(router *gin.RouterGroup) {\n router.POST("", Create)\n router.POST("/login", Login)\n}\n'],
    ]);
    expect(labels(g)).toEqual(['POST /api/users | Create', 'POST /api/users/login | Login']);
    expect(edgeLabels(g)).toEqual(expect.arrayContaining(['/api', '/users']));
    // the route nodes hang off the parameter holder, which is mounted under the group
    const param = g.nodes.find((n) => n.label.includes('router router'))!;
    expect(param.label).toContain('UsersRegister');
    expect(g.edges.some((e) => e.kind === 'mount' && e.to === param.id)).toBe(true);
  });

  it('binds a plain identifier argument and a same-directory call', () => {
    const g = graph([['a.go', 'package m\nfunc main() {\n e := echo.New()\n register(e)\n}\nfunc register(e *echo.Echo) {\n e.GET("/h", h)\n}\n']]);
    expect(labels(g)).toEqual(['GET /h | h']);
    expect(g.edges.filter((e) => e.kind === 'mount')).toHaveLength(1);
  });

  it('shows full paths when exactly one call site mounts the function, relative paths for several', () => {
    const one = graph([['a.go', 'package m\nfunc main() {\n r := gin.New()\n reg(r.Group("/a"))\n}\nfunc reg(g *gin.RouterGroup) { g.GET("/x", h) }\n']]);
    expect(labels(one)).toEqual(['GET /a/x | h']);
    const two = graph([['a.go', 'package m\nfunc main() {\n r := gin.New()\n reg(r.Group("/a"))\n reg(r.Group("/b"))\n}\nfunc reg(g *gin.RouterGroup) { g.GET("/x", h) }\n']]);
    expect(labels(two)).toEqual(['GET /x | h']);
    expect(edgeLabels(two)).toEqual(expect.arrayContaining(['/a', '/b']));
  });

  it('chi closure style: Route and Group with func literals, nested', () => {
    const g = graph([
      [
        'main.go',
        'package m\nfunc main() {\n r := chi.NewRouter()\n r.Route("/articles", func(r chi.Router) {\n  r.Get("/", list)\n  r.Route("/{id}", func(r chi.Router) {\n   r.Get("/", get)\n  })\n })\n r.Group(func(r chi.Router) {\n  r.Post("/login", login)\n })\n}\n',
      ],
    ]);
    expect(labels(g)).toEqual(['GET /articles/ | list', 'GET /articles/{id}/ | get', 'POST /login | login']);
  });

  it('resolves aliased imports for constructors and parameter types', () => {
    const g = graph([['a.go', 'package m\nimport g "github.com/gin-gonic/gin"\nfunc main() {\n r := g.New()\n reg(r)\n}\nfunc reg(x *g.Engine) { x.GET("/z", h) }\n']]);
    expect(labels(g)).toEqual(['GET /z | h']);
  });

  it('keeps same-named variables in different functions apart', () => {
    const g = graph([['a.go', 'package m\nfunc a() {\n r := gin.New()\n r.GET("/a", h)\n}\nfunc b() {\n r := gin.New()\n r.GET("/b", h)\n}\n']]);
    expect(labels(g)).toEqual(['GET /a | h', 'GET /b | h']);
    const apps = g.nodes.filter((n) => n.kind === 'app');
    expect(apps).toHaveLength(2);
    expect(new Set(apps.map((n) => n.id)).size).toBe(2);
    // each route hangs off its own function's holder
    for (const r of g.nodes.filter((n) => n.kind === 'route')) expect(g.edges.filter((e) => e.to === r.id)).toHaveLength(1);
  });

  it('does not treat function declarations as calls, and ignores unresolvable arguments', () => {
    const g = graph([['a.go', 'package m\nfunc reg(g *gin.RouterGroup) { g.GET("/x", h) }\nfunc main() { reg(somethingElse()) }\n']]);
    expect(labels(g)).toEqual(['GET /x | h']);
    expect(g.edges.filter((e) => e.kind === 'mount')).toHaveLength(0);
  });
});

describe('routers returned from functions', () => {
  const graph = (files: Array<[string, string]>) => goRouteAnalyzer.analyze(files.map(([p, t]) => f(p, t)));
  const labels = (g: ReturnType<typeof graph>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace('<br/>', ' | ')).sort();
  it('x := pkg.NewRouter() uses the router that function builds, groups included', () => {
    const g = graph([
      ['routes/r.go', 'package routes\nfunc NewRouter() *gin.Engine {\n r := gin.New()\n r.GET("/health", health)\n return r\n}\n'],
      ['main.go', 'package main\nfunc main() {\n app := routes.NewRouter()\n v1 := app.Group("/v1")\n v1.GET("/x", x)\n}\n'],
    ]);
    expect(labels(g)).toEqual(['GET /health | health', 'GET /v1/x | x']);
    expect(g.nodes.filter((n) => n.kind === 'app')).toHaveLength(1);
  });
  it('chi Mount of a function call', () => {
    const g = graph([['a.go', 'package m\nfunc main() {\n r := chi.NewRouter()\n r.Mount("/admin", adminRouter())\n}\nfunc adminRouter() chi.Router {\n r := chi.NewRouter()\n r.Get("/", dash)\n return r\n}\n']]);
    expect(labels(g)).toEqual(['GET /admin/ | dash']);
  });
  it('functions returning something unknown do not alias', () => {
    const g = graph([['a.go', 'package m\nfunc main() {\n r := gin.New()\n x := other()\n x.GET("/n", h)\n r.GET("/y", h)\n}\nfunc other() int { return 1 }\n']]);
    expect(labels(g)).toEqual(['GET /y | h']);
  });
});

describe('go routes: routers kept in struct fields', () => {
  const rl = (g: ReturnType<typeof goRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('s.router.GET inside methods, groups of the field, and the field passed to a function', () => {
    const g = goRouteAnalyzer.analyze([
      f('server.go', `package main
import "github.com/gin-gonic/gin"
type Server struct {
	router *gin.Engine
	db     *DB
}
func NewServer() *Server { return &Server{router: gin.Default()} }
func (s *Server) routes() {
	s.router.GET("/health", s.health)
	api := s.router.Group("/api")
	api.POST("/login", s.login)
	registerUsers(s.router)
}
func registerUsers(r *gin.Engine) {
	r.GET("/users", listUsers)
}
`),
    ]);
    expect(rl(g)).toEqual(['GET /health | s.health', 'GET /users | listUsers', 'POST /api/login | s.login']);
  });
  it('an embedded router makes the receiver the router; fields are found across files', () => {
    const g = goRouteAnalyzer.analyze([
      f('types.go', `package app
import "github.com/go-chi/chi/v5"
type App struct { *chi.Mux }
type Other struct { r chi.Router }
`),
      f('routes.go', `package app
func (a *App) Routes() { a.Get("/a", h1); a.Post("/b", h2) }
func (o *Other) Routes() { o.r.Delete("/c", h3) }
`),
    ]);
    expect(rl(g)).toEqual(['DELETE /c | h3', 'GET /a | h1', 'POST /b | h2']);
  });
  it('ignores selector chains that are not router fields', () => {
    const g = goRouteAnalyzer.analyze([f('a.go', `package a
type S struct { db *DB }
func (s *S) f() { s.db.Get("/x", h) }
`)]);
    expect(rl(g)).toEqual([]);
  });
});

describe('go call graph: struct fields and typed locals', () => {
  it('s.repo.Save() resolves through the field type; r := &Repo{} then r.Save() through the local', () => {
    const g = goCallGraphAnalyzer.analyze([
      f('a.go', `package a
type Repo struct{}
func (r *Repo) Save() {}
type Other struct{}
func (o *Other) Save() {}
type Svc struct { repo *Repo }
func (s *Svc) Go() { s.repo.Save() }
func Main() { r := &Repo{}; r.Save() }
`),
    ]);
    expect(g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`).sort()).toEqual(['Main->Repo.Save', 'Svc.Go->Repo.Save']);
  });
});
