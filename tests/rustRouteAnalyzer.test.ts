import { describe, it, expect } from 'vitest';
import { rustRouteAnalyzer, stripRustComments } from '../src/analyzers/rust/rustRouteAnalyzer';
import { LANGUAGES } from '../src/analyzers/registry';

const run = (files: Record<string, string>) => rustRouteAnalyzer.analyze(Object.entries(files).map(([path, text]) => ({ path, text }))) as any;
const labels = (g: any) => g.nodes.filter((n: any) => n.kind === 'route').map((n: any) => n.label.replace('<br/>', ' | ')).sort();

describe('stripRustComments', () => {
  it('blanks comments, keeps strings, lifetimes and chars', () => {
    const src = `// c\nlet a = "x // not"; /* b /* nested */ */ let c = 'x'; fn f<'a>(s: &'a str) {} let r = r#"q"#;`;
    const out = stripRustComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('"x // not"');
    expect(out).toContain("<'a>");
    expect(out).not.toContain('nested');
    expect(out).toContain('r#"q"#');
  });
});

describe('axum', () => {
  const main = `
use axum::{routing::{get, post}, Router};

fn api_routes() -> Router {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/:id", get(get_user).delete(delete_user))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(root))
        // .route("/commented", get(nope))
        .nest("/api", api_routes())
        .route("/health", axum::routing::get(health));
    axum::serve(listener, app).await.unwrap();
}`;
  it('maps routes, methods, nest prefixes and skips comments', () => {
    const g = run({ 'src/main.rs': main });
    expect(labels(g)).toEqual([
      'DELETE /api/users/:id | delete_user',
      'GET / | root',
      'GET /api/users | list_users',
      'GET /api/users/:id | get_user',
      'GET /health | health',
      'POST /api/users | create_user',
    ]);
    expect(g.edges.some((e: any) => e.kind === 'mount' && e.label === '/api')).toBe(true);
    expect(labels(g).join()).not.toContain('commented');
  });
  it('resolves variable routers, inline nest and rebinding', () => {
    const g = run({
      'a.rs': `fn main() {
  let admin = Router::new().route("/stats", get(stats));
  let mut app = Router::new();
  app = app.route("/", get(home));
  app = app.nest("/admin", admin);
  app = app.nest("/v2", Router::new().route("/ping", get(ping)));
}`,
    });
    expect(labels(g)).toEqual(['GET / | home', 'GET /admin/stats | stats', 'GET /v2/ping | ping']);
  });
  it('merge keeps paths unprefixed; non-literal paths are shown as source', () => {
    const g = run({ 'a.rs': `fn r() -> Router { Router::new().route("/a", get(a)).merge(other()) }\nfn other() -> Router { Router::new().route(PATH, post(b)) }` });
    expect(labels(g)).toEqual(['GET /a | a', 'POST /PATH | b']);
  });
});

describe('actix-web', () => {
  const src = `
use actix_web::{get, post, web, App, HttpServer, HttpResponse};

#[get("/hello/{name}")]
async fn hello(name: web::Path<String>) -> String { format!("Hello {}", name) }

#[post("/echo")]
async fn echo(body: String) -> HttpResponse { HttpResponse::Ok().body(body) }

async fn manual() -> HttpResponse { HttpResponse::Ok().finish() }

fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/cfg").route(web::get().to(cfg_get)));
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(hello)
            .service(web::scope("/api").service(echo).route("/manual", web::get().to(manual)))
            .service(web::resource("/res").route(web::post().to(res_post)).route(web::get().to(res_get)))
            .configure(config)
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}`;
  it('maps attribute handlers, scopes, resources and configure()', () => {
    const g = run({ 'src/main.rs': src });
    expect(labels(g)).toEqual([
      'GET /api/manual | manual',
      'GET /cfg | cfg_get',
      'GET /hello/{name} | hello',
      'GET /res | res_get',
      'POST /api/echo | echo',
      'POST /res | res_post',
    ]);
  });
});

describe('rocket', () => {
  const src = `
#[macro_use] extern crate rocket;

#[get("/")]
fn index() -> &'static str { "hi" }

#[get("/<id>")]
fn show(id: u32) -> String { id.to_string() }

#[post("/", data = "<form>")]
fn create(form: Form<Item>) {}

#[route(PATCH, path = "/touch")]
fn touch() {}

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![index])
        .mount("/items", routes![show, create, touch])
}`;
  it('maps attribute routes through mount()', () => {
    const g = run({ 'src/main.rs': src });
    expect(labels(g)).toEqual(['GET / | index', 'GET /items/<id> | show', 'PATCH /items/touch | touch', 'POST /items/ | create']);
  });
});

describe('robustness', () => {
  it('never throws on garbage and returns an empty graph for non-routing code', () => {
    for (const text of ['', 'Router::new().route(', '#[get(', 'App::new().service(', '}}}{{', 'let x = Router::new()\n.nest(', 'rocket::build().mount("/"']) {
      expect(() => run({ 'x.rs': text })).not.toThrow();
    }
    expect(run({ 'x.rs': 'fn main() { println!("hi"); }' }).nodes).toEqual([]);
    expect(run({ 'x.txt': 'Router::new().route("/a", get(a))' }).nodes).toEqual([]);
  });
});

describe('registry', () => {
  it('is registered under Rust', () => {
    expect(LANGUAGES.find((l: any) => l.id === 'rust')!.analyses.some((a: any) => a.kind === 'routes')).toBe(true);
  });
});

describe('poem, tide and warp', () => {
  const run = (...files: Array<[string, string]>) => rustRouteAnalyzer.analyze(files.map(([p, t]) => ({ path: p, text: t })));
  const labels = (g: ReturnType<typeof run>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();

  it('poem: at() with method chains, nest and nested inline routes', () => {
    const g = run([
      'main.rs',
      `use poem::{get, post, Route};
fn api() -> Route { Route::new().at("/users", get(list).post(create)).at("/users/:id", get(show)) }
#[tokio::main]
async fn main() {
    let app = Route::new()
        .at("/hello/:name", get(hello))
        .nest("/api", api())
        .nest("/inline", Route::new().at("/x", poem::delete(del)));
}`,
    ]);
    expect(labels(g)).toEqual(['DELETE /inline/x | del', 'GET /api/users | list', 'GET /api/users/:id | show', 'GET /hello/:name | hello', 'POST /api/users | create']);
  });

  it("poem's Route::new() does not collide with Rocket's Route::new(method, path, handler)", () => {
    const g = run(['r.rs', 'fn f() { let r = Route::new(Method::Get, "/a", handler); }']);
    expect(labels(g)).toEqual([]);
  });

  it('tide: at().verb() chains, chained at(), all(), serve_dir and nested servers', () => {
    const g = run([
      'main.rs',
      `fn main() {
    let mut app = tide::new();
    let mut api = tide::new();
    api.at("/users").get(list).post(create);
    api.at("/users").at("/:id").get(show).delete(|_| async { Ok("x") });
    app.at("/api").nest(api);
    app.at("/").get(index);
    app.at("/any").all(everything);
    app.at("/static").serve_dir("public/").unwrap();
}`,
    ]);
    expect(labels(g)).toEqual(['ANY /any | everything', 'DELETE /api/users/:id | (inline)', 'GET / | index', 'GET /api/users | list', 'GET /api/users/:id | show', 'GET /static | static dir', 'POST /api/users | create']);
  });

  it('warp: path!, method filters, .and/.or composition and handlers', () => {
    const g = run([
      'main.rs',
      `use warp::Filter;
#[tokio::main]
async fn main() {
    let hello = warp::path!("hello" / String).and(warp::get()).map(|name| format!("Hello, {}!", name));
    let list = warp::path("todos").and(warp::get()).and_then(list_todos);
    let create = warp::path("todos").and(warp::post()).and(warp::body::json()).and_then(create_todo);
    let routes = hello.or(list).or(create);
    warp::serve(routes).run(([127, 0, 0, 1], 3030)).await;
}`,
    ]);
    expect(labels(g)).toEqual(['GET /hello/{String} | (inline)', 'GET /todos | list_todos', 'POST /todos | create_todo']);
  });

  it('warp: .and distributes over .or (shared prefix), nested names, functions returning impl Filter, other files', () => {
    const g = run(
      [
        'main.rs',
        `mod filters;
#[tokio::main]
async fn main() { warp::serve(filters::api()).run(([0,0,0,0], 80)).await; }`,
      ],
      [
        'filters.rs',
        `use warp::Filter;
pub fn api() -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    let todos = warp::path("todos");
    let by_id = warp::path::param::<u32>().and(warp::path::end());
    todos.and(by_id.and(warp::get()).map(show).or(warp::get().and(warp::path::end()).map(list)))
        .or(warp::path("health").and(warp::get()).map(|| "ok"))
}`,
      ],
    );
    expect(labels(g)).toEqual(['GET /health | (inline)', 'GET /todos | list', 'GET /todos/{u32} | show']);
  });

  it('warp: transparent custom filters, ws and static files; files without serve use unreferenced definitions', () => {
    const g = run([
      'lib.rs',
      `fn routes(db: Db) -> impl Filter<Extract = impl Reply> + Clone {
    let chat = warp::path("chat").and(warp::ws()).and(with_db(db.clone())).map(handle);
    let files = warp::path("static").and(warp::fs::dir("www"));
    chat.or(files)
}`,
    ]);
    expect(labels(g)).toEqual(['ANY /static | static dir', 'WS /chat | handle']);
  });

  it('warp: input with no routes or unreadable filters never throws', () => {
    expect(() => run(['a.rs', 'fn main() { warp::serve(unknown_thing()).run(a).await; let x = warp::; }'])).not.toThrow();
    expect(labels(run(['a.rs', 'fn main() { let v = vec![1]; }']))).toEqual([]);
  });
});

describe('warp: extractors and closures', () => {
  const run = (src: string) => rustRouteAnalyzer.analyze([{ path: 'm.rs', text: src }]).nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('an extractor filter built from a closure does not replace the real handler; a let bound to a filter function is followed', () => {
    expect(
      run(`mod filters {
  pub fn all(db: Db) -> impl Filter<Extract = impl Reply> + Clone { list(db.clone()).or(add(db)) }
  fn list(db: Db) -> impl Filter<Extract = impl Reply> + Clone { warp::path!("todos").and(warp::get()).and(with_db(db)).and_then(handlers::list) }
  fn add(db: Db) -> impl Filter<Extract = impl Reply> + Clone { warp::path!("todos").and(warp::post()).and(with_db(db)).and_then(handlers::add) }
  fn with_db(db: Db) -> impl Filter<Extract = (Db,), Error = std::convert::Infallible> + Clone { warp::any().map(move || db.clone()) }
}
async fn main() { let api = filters::all(db); let routes = api.with(warp::log("x")); warp::serve(routes).run(a).await; }`),
    ).toEqual(['GET /todos | handlers::list', 'POST /todos | handlers::add']);
  });
  it('closure handlers with parameters show as (inline), not as a fragment of their parameter list', () => {
    expect(run('async fn main() { let r = warp::path!("sum" / u32 / u32).map(|a, b| a + b); warp::serve(r).run(x).await; }')).toEqual(['ANY /sum/{u32}/{u32} | (inline)']);
  });
});

describe('tide: block-expression nest', () => {
  it('nest({ let mut api = tide::new(); ..; api }) mounts the sub-app', () => {
    const g = rustRouteAnalyzer.analyze([
      { path: 'main.rs', text: 'fn main() {\n let mut app = tide::new();\n app.at("/api").nest({\n  let mut api = tide::new();\n  api.at("/hello").get(h);\n  api\n });\n}' },
    ]);
    expect(g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace('<br/>', ' | '))).toEqual(['GET /api/hello | h']);
    expect(g.edges.filter((e) => e.kind === 'mount')).toHaveLength(1);
  });
});
