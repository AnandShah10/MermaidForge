import { describe, it, expect } from 'vitest';
import { goRouteAnalyzer } from '../src/analyzers/go/goRouteAnalyzer';
import { rustRouteAnalyzer } from '../src/analyzers/rust/rustRouteAnalyzer';
import { csharpRouteAnalyzer } from '../src/analyzers/csharp/csharpAnalyzer';
import { javaRouteAnalyzer } from '../src/analyzers/java/javaAnalyzer';
import { kotlinRouteAnalyzer } from '../src/analyzers/kotlin/kotlinRouteAnalyzer';
import { phpRouteAnalyzer } from '../src/analyzers/php/phpRouteAnalyzer';
import { unrollLoopsInText } from '../src/analyzers/common/loopUnroll';

const labels = (g: { nodes: Array<{ kind?: string; label: string }> }) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();

describe('loop unrolling for brace languages', () => {
  it('Go range over []string', () => {
    const g = goRouteAnalyzer.analyze([{ path: 'main.go', text: `package main
import "net/http"
func main() {
  mux := http.NewServeMux()
  for _, name := range []string{"users", "posts"} {
    mux.HandleFunc("/"+name, handler)
  }
  http.ListenAndServe(":80", mux)
}` }]);
    expect(labels(g).join(';')).toContain('/users');
    expect(labels(g).join(';')).toContain('/posts');
  });
  it('C# foreach over new[] with minimal APIs', () => {
    const g = csharpRouteAnalyzer.analyze([{ path: 'Program.cs', text: `var app = WebApplication.Create();
foreach (var n in new[] { "a", "b" }) { app.MapGet("/" + n, () => "x"); }
app.Run();` }]);
    expect(labels(g).map((l) => l.split(' | ')[0])).toEqual(['GET /a', 'GET /b']);
  });
  it('Rust tuple loop', () => {
    const g = rustRouteAnalyzer.analyze([{ path: 'main.rs', text: `use axum::{routing::get, Router};
fn app() -> Router {
  let mut app = Router::new();
  for (p, h) in [("/a", ha), ("/b", hb)] { app = app.route(p, get(h)); }
  app
}` }]);
    expect(labels(g).map((l) => l.split(' | ')[0]).sort()).toEqual(['GET /a', 'GET /b']);
  });
  it('leaves loops that do not use the variable or register nothing alone', () => {
    const t = `func f() { for _, n := range []string{"a","b"} { mux.HandleFunc("/x", h) } for _, n := range []string{"a"} { fmt.Println(n) } }`;
    expect(unrollLoopsInText(t, 'go')).toBe(t);
  });
  it('PHP foreach, Kotlin for and Java for', () => {
    expect(unrollLoopsInText(`<?php foreach (['a', 'b'] as $v) { Route::get("/$v", 'C@x'); }`, 'php')).toContain('Route::get("/b"');
    expect(unrollLoopsInText(`fun f() { for (v in listOf("a", "b")) { get("/" + v) { } } }`, 'kotlin')).toContain('get("/b")');
    expect(unrollLoopsInText(`class A { void f() { for (String v : List.of("a", "b")) { app.get("/" + v, h); } } }`, 'java')).toContain('app.get("/a", h)');
    void kotlinRouteAnalyzer; void javaRouteAnalyzer; void phpRouteAnalyzer;
  });
});

describe('rust routers kept in struct fields', () => {
  it('follows field initialisers, field rebinding and field mounts', () => {
    const g = rustRouteAnalyzer.analyze([{ path: 'main.rs', text: `use axum::{routing::get, Router};
struct Api { users: Router, admin: Router }
impl Api {
  fn new() -> Self {
    Self { users: Router::new().route("/list", get(list)), admin: Router::new() }
  }
  fn build(mut self) -> Router {
    self.admin = self.admin.route("/stats", get(stats));
    Router::new().nest("/users", self.users).nest("/admin", self.admin.clone())
  }
}` }]);
    expect(g.edges.filter((e) => e.kind === 'mount').map((e) => e.label).sort()).toEqual(['/admin', '/users']);
    expect(g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.split('<br/>')[0]).sort()).toEqual(['GET /admin/stats', 'GET /users/list']);
  });
});
