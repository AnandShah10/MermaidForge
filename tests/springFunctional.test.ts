import { describe, it, expect } from 'vitest';
import { javaRouteAnalyzer } from '../src/analyzers/java/javaAnalyzer';
import { kotlinRouteAnalyzer } from '../src/analyzers/kotlin/kotlinRouteAnalyzer';

const labels = (g: { nodes: Array<{ kind?: string; label: string }> }) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();

describe('Spring functional endpoints', () => {
  it('Java builder with path() and nest(path(..), ..)', () => {
    const g = javaRouteAnalyzer.analyze([
      { path: 'Routes.java', text: `
@Configuration class Routes {
  @Bean RouterFunction<ServerResponse> r(UserHandler h) {
    return RouterFunctions.route()
      .GET("/ping", h::ping)
      .path("/api", b -> b.GET("/users", h::list).POST("/users", req -> ServerResponse.ok().build()))
      .nest(RequestPredicates.path("/v2"), b -> b.DELETE("/users/{id}", h::remove))
      .build();
  }
}` },
    ]);
    expect(labels(g)).toEqual(['DELETE /v2/users/{id} | h.remove', 'GET /api/users | h.list', 'GET /ping | h.ping', 'POST /api/users | (inline)']);
  });
  it('Java classic route(GET(..), handler) / andRoute', () => {
    const g = javaRouteAnalyzer.analyze([
      { path: 'R.java', text: `class R { RouterFunction<ServerResponse> r() { return route(GET("/a"), Handlers::a).andRoute(POST("/b"), Handlers::b); } }` },
    ]);
    expect(labels(g)).toEqual(['GET /a | Handlers.a', 'POST /b | Handlers.b']);
  });
  it('Kotlin router { } with nest', () => {
    const g = kotlinRouteAnalyzer.analyze([
      { path: 'Routes.kt', text: `
fun routes(h: Handler) = router {
  "/api".nest {
    GET("/users", h::list)
    ("/admin" and accept(APPLICATION_JSON)).nest {
      POST("/x") { ok().build() }
    }
  }
  GET("/health") { ok().build() }
}` },
    ]);
    expect(labels(g)).toEqual(['GET /api/users | h.list', 'GET /health | (inline)', 'POST /api/admin/x | (inline)']);
  });
  it('files without RouterFunction / router are ignored', () => {
    expect(labels(javaRouteAnalyzer.analyze([{ path: 'A.java', text: 'class A { void f() { GET("/x"); } }' }]))).toEqual([]);
  });
});
