import { describe, it, expect } from 'vitest';
import { parsePhp, analyzePhpClasses, phpImportGraphAnalyzer, phpCallGraphAnalyzer } from '../src/analyzers/php/phpAnalyzer';
import { phpRouteAnalyzer } from '../src/analyzers/php/phpRouteAnalyzer';
import { classesToClassDiagram, codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
const routeLabels = (g: ReturnType<typeof phpRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const edgePairs = (g: { edges: Array<{ from: string; to: string; kind?: string }> }) => g.edges.map((e) => `${e.from}=>${e.to}${e.kind === 'ambiguous' ? '?' : ''}`).sort();
const short = (g: { edges: Array<{ from: string; to: string; kind?: string }> }) => g.edges.map((e) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}${e.kind === 'ambiguous' ? '?' : ''}`).sort();

describe('parsePhp', () => {
  it('reads namespace, uses (aliased and grouped) and ignores use function/const', () => {
    const p = parsePhp(`<?php
namespace App\\Http;
use App\\Models\\User;
use App\\Services\\Mailer as M;
use App\\{Repo, Cache as C};
use function App\\helper;
class A {}`);
    expect(p.namespace).toBe('App\\Http');
    expect(p.uses).toEqual([
      { fqcn: 'App\\Models\\User', alias: 'User' },
      { fqcn: 'App\\Services\\Mailer', alias: 'M' },
      { fqcn: 'App\\Repo', alias: 'Repo' },
      { fqcn: 'App\\Cache', alias: 'C' },
    ]);
  });
  it('reads class kinds, modifiers, extends, implements and traits', () => {
    const p = parsePhp(`<?php
abstract class Base {}
final class Child extends Base implements \\Countable, Jsonable { use Loggable, \\App\\Cache; }
interface I extends A, B {}
trait T {}
enum Status: string { case Active = 'a'; case Off = 'o'; public function label(): string { return 'x'; } }`);
    const by = (n: string) => p.types.find((t) => t.name === n)!;
    expect(by('Base').isAbstract).toBe(true);
    expect(by('Child').isFinal).toBe(true);
    expect(by('Child').extends).toEqual(['Base']);
    expect(by('Child').implements).toEqual(['Countable', 'Jsonable']);
    expect(by('Child').traits).toEqual(['Loggable', 'Cache']);
    expect(by('I').extends).toEqual(['A', 'B']);
    expect(by('T').kind).toBe('trait');
    expect(by('Status').kind).toBe('enum');
    expect(by('Status').cases).toEqual(['Active', 'Off']);
    expect(by('Status').methods.map((m) => m.name)).toEqual(['label']);
  });
  it('reads properties, promoted constructor params and method details', () => {
    const t = parsePhp(`<?php
class U {
  public string $name = 'x';
  private static ?int $count = null, $other;
  protected $plain;
  public function __construct(private readonly Repo $repo, public int $n = 0, $loose) {}
  public static function make(int|string $a, &$b, ...$rest): static { return new static; }
  abstract protected function hook(): void;
  private function p() {}
}`).types[0];
    expect(t.props.map((p) => `${p.visibility} ${p.name}:${p.type}${p.isStatic ? ' static' : ''}`)).toEqual([
      'public name:string',
      'private count:?int static',
      'private other:?int static',
      'protected plain:',
      'private repo:Repo',
      'public n:int',
    ]);
    const m = (n: string) => t.methods.find((x) => x.name === n)!;
    expect(m('make').isStatic).toBe(true);
    expect(m('make').returnType).toBe('static');
    expect(m('make').params.map((p) => p.name)).toEqual(['a', 'b', 'rest']);
    expect(m('hook').isAbstract).toBe(true);
    expect(m('hook').hasBody).toBe(false);
    expect(m('p').visibility).toBe('private');
  });
  it('is not fooled by ::class, anonymous classes, strings, comments and inline html', () => {
    const p = parsePhp(`<html><?php class Hidden {} ?></html>
<?php
// class Nope {}
$a = Foo::class;
$b = new class extends Base { };
$s = "class Fake {}";
class Real { public function f() { return new class { }; } }
`);
    expect(p.types.map((t) => t.name).sort()).toEqual(['Hidden', 'Real']);
  });
  it('reads free functions but not closures', () => {
    const p = parsePhp(`<?php
function helper(Repo $r): Repo { return $r; }
$f = function () { return 1; };
class C { function m() {} }`);
    expect(p.functions.map((x) => x.name)).toEqual(['helper']);
  });
  it('reads attributes on classes and methods with nested brackets', () => {
    const p = parsePhp(`<?php
#[Route('/api', name: 'x'), Final]
class C {
  #[Route('/a', methods: ['GET', 'POST'])]
  public function a() {}
}`);
    expect(p.types[0].attributes.map((a) => a.name)).toEqual(['Route', 'Final']);
    expect(p.types[0].attributes[0].args).toContain("'/api'");
    expect(p.types[0].methods[0].attributes[0].args).toContain("methods: ['GET', 'POST']");
  });
});

describe('analyzePhpClasses', () => {
  const g = analyzePhpClasses([
    f('a.php', `<?php
interface Shape { public function area(): float; }
abstract class Base implements Shape { protected string $name; abstract public function area(): float; public static function make(): static {} }
trait Loggable { public function log() {} }
final class Circle extends Base { use Loggable; private float $r; public function area(): float { return 1.0; } }
enum Suit: string { case H = 'h'; }`),
  ]);
  it('builds members, stereotypes and relationships', () => {
    const by = (n: string) => g.classes.find((c) => c.id === n)!;
    expect(by('Shape').stereotype).toBe('interface');
    expect(by('Base').stereotype).toBe('abstract');
    expect(by('Suit').stereotype).toBe('enumeration');
    expect(by('Circle').members).toContain('-r float');
    expect(by('Circle').members).toContain('+area() float');
    expect(by('Base').members).toContain('+make() static$');
    expect(g.relationships).toContainEqual({ from: 'Circle', to: 'Base', type: 'inheritance' });
    expect(g.relationships).toContainEqual({ from: 'Base', to: 'Shape', type: 'realization' });
    expect(g.relationships).toContainEqual({ from: 'Circle', to: 'Loggable', type: 'realization' });
  });
  it('produces a class diagram Mermaid accepts', () => {
    expect(parseMermaid(classesToClassDiagram(g.classes, g.relationships)).kind).toBe('classDiagram');
  });
});

describe('phpImportGraphAnalyzer', () => {
  it('links use imports, same-namespace and fully qualified supertypes, and literal requires', () => {
    const g = phpImportGraphAnalyzer.analyze([
      f('src/User.php', '<?php namespace App\\Models; class User extends Model {}'),
      f('src/Model.php', '<?php namespace App\\Models; class Model {}'),
      f('src/Mailer.php', '<?php namespace App\\Services; class Mailer {}'),
      f('src/Svc.php', '<?php namespace App\\Http; use App\\Models\\User; use App\\Services\\Mailer as M; class Svc extends \\App\\Models\\Model implements \\Countable {}'),
      f('lib/boot.php', "<?php require_once __DIR__ . '/helpers.php'; include 'conf.php';"),
      f('lib/helpers.php', '<?php function h() {}'),
      f('lib/conf.php', '<?php return [];'),
    ]);
    expect(edgePairs(g)).toEqual([
      'lib/boot.php=>lib/conf.php',
      'lib/boot.php=>lib/helpers.php',
      'src/Svc.php=>src/Mailer.php',
      'src/Svc.php=>src/Model.php',
      'src/Svc.php=>src/User.php',
      'src/User.php=>src/Model.php',
    ]);
  });
  it('ignores external packages and unresolved requires, and yields valid Mermaid', () => {
    const g = phpImportGraphAnalyzer.analyze([f('a.php', "<?php use Illuminate\\Support\\Str; require 'vendor/autoload.php';")]);
    expect(g.edges).toEqual([]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('phpCallGraphAnalyzer', () => {
  it('resolves $this, self::, static::, Class:: and free function calls', () => {
    const g = phpCallGraphAnalyzer.analyze([
      f('a.php', `<?php
function helper() {}
class A {
  public function a() { $this->b(); self::c(); static::c(); B::d(); helper(); }
  public function b() {}
  public static function c() {}
}
class B { public static function d() {} }`),
    ]);
    expect(short(g)).toEqual(['A.a->A.b', 'A.a->A.c', 'A.a->B.d', 'A.a->helper']);
  });
  it('resolves typed parameters, new locals and typed/promoted properties', () => {
    const g = phpCallGraphAnalyzer.analyze([
      f('a.php', `<?php
class Repo { public function save() {} public function find() {} }
class Cache { public function get() {} }
class Svc {
  private Cache $cache;
  public function __construct(private Repo $repo) {}
  public function viaParam(Repo $r) { $r->save(); }
  public function viaLocal() { $x = new Repo(); $x->find(); }
  public function viaPromoted() { $this->repo->save(); }
  public function viaProp() { $this->cache->get(); }
}`),
    ]);
    expect(short(g)).toEqual(['Svc.viaLocal->Repo.find', 'Svc.viaParam->Repo.save', 'Svc.viaPromoted->Repo.save', 'Svc.viaProp->Cache.get']);
  });
  it('resolves calls through return types, including chains', () => {
    const g = phpCallGraphAnalyzer.analyze([
      f('a.php', `<?php
class Repo { public function save() {} }
function open(): Repo { return new Repo(); }
function run() { $r = open(); $r->save(); }
function chain() { open()->save(); }`),
    ]);
    expect(short(g)).toEqual(expect.arrayContaining(['run->Repo.save', 'chain->Repo.save']));
  });
  it('draws interface calls as dotted edges to the implementers', () => {
    const g = phpCallGraphAnalyzer.analyze([
      f('a.php', `<?php
interface Store { public function put(); }
class Mem implements Store { public function put() {} }
class Disk implements Store { public function put() {} }
class Client { public function go(Store $s) { $s->put(); } }`),
    ]);
    expect(short(g)).toEqual(['Client.go->Disk.put?', 'Client.go->Mem.put?']);
  });
  it('a variable named like a function does not hide the function', () => {
    const g = phpCallGraphAnalyzer.analyze([f('a.php', `<?php\nfunction count_it() {}\nfunction run() { $count_it = 1; count_it(); }`)]);
    expect(short(g)).toEqual(['run->count_it']);
  });
  it('produces a flowchart Mermaid accepts', () => {
    const g = phpCallGraphAnalyzer.analyze([f('a.php', '<?php function a() { b(); } function b() {}')]);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('phpRouteAnalyzer: Laravel', () => {
  const web = (body: string) => phpRouteAnalyzer.analyze([f('routes/web.php', `<?php\nuse Illuminate\\Support\\Facades\\Route;\n${body}`)]);
  it('maps verbs with array, string and invokable handlers and closures', () => {
    expect(routeLabels(web(`
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', 'UserController@store');
Route::delete('/users/{id}', \\App\\Http\\Controllers\\DestroyUser::class);
Route::put('/x', function () { return 1; });
Route::get('/fn', fn () => 1);`))).toEqual([
      'DELETE /users/{id} | DestroyUser',
      'GET /fn | (closure)',
      'GET /users | UserController.index',
      'POST /users | UserController.store',
      'PUT /x | (closure)',
    ]);
  });
  it('reads any, match, redirect and view', () => {
    expect(routeLabels(web(`
Route::any('/a', [A::class, 'x']);
Route::match(['get', 'post'], '/b', [B::class, 'y']);
Route::redirect('/old', '/new');
Route::view('/welcome', 'welcome');`))).toEqual(['ANY /a | A.x', 'GET /welcome | view welcome', 'GET|POST /b | B.y', 'REDIRECT /old | to /new']);
  });
  it('applies prefix groups, nested groups and the controller default', () => {
    expect(routeLabels(web(`
Route::prefix('admin')->middleware(['auth'])->group(function () {
  Route::get('/dash', [Admin::class, 'dash']);
  Route::prefix('v1')->group(function () {
    Route::get('/stats', [Admin::class, 'stats']);
  });
});
Route::controller(OrderController::class)->prefix('orders')->group(function () {
  Route::get('/', 'index');
  Route::post('/', 'store');
});`))).toEqual(['GET /admin/dash | Admin.dash', 'GET /admin/v1/stats | Admin.stats', 'GET /orders/ | OrderController.index', 'POST /orders/ | OrderController.store']);
  });
  it('reads the array form Route::group([...], fn)', () => {
    expect(routeLabels(web(`Route::group(['prefix' => 'api', 'middleware' => 'auth'], function () { Route::get('/me', [Me::class, 'show']); });`))).toEqual(['GET /api/me | Me.show']);
  });
  it('a group with only middleware adds no node and keeps paths', () => {
    const g = web(`Route::middleware('auth')->group(function () { Route::get('/p', [P::class, 'i']); });`);
    expect(routeLabels(g)).toEqual(['GET /p | P.i']);
    expect(g.nodes.filter((n) => n.kind === 'router')).toEqual([]);
  });
  it('expands resource and apiResource, honouring only/except', () => {
    const r = routeLabels(web(`Route::resource('photos', PhotoController::class);`));
    expect(r).toHaveLength(7); // index create store show edit update(PUT|PATCH) destroy
    expect(r).toContain('GET /photos/{photo}/edit | PhotoController.edit');
    expect(r).toContain('PUT|PATCH /photos/{photo} | PhotoController.update');
    expect(routeLabels(web(`Route::apiResource('posts', PostController::class)->only(['index', 'show']);`))).toEqual(['GET /posts | PostController.index', 'GET /posts/{post} | PostController.show']);
    expect(routeLabels(web(`Route::apiResource('posts', PostController::class)->except(['destroy', 'update']);`))).toEqual(['GET /posts | PostController.index', 'GET /posts/{post} | PostController.show', 'POST /posts | PostController.store']);
  });
  it('nested resources get a parent parameter', () => {
    expect(routeLabels(web(`Route::apiResource('photos.comments', CommentController::class)->only(['index']);`))).toEqual(['GET /photos/{photo}/comments | CommentController.index']);
  });
  it('routes/api.php is served under /api', () => {
    const g = phpRouteAnalyzer.analyze([f('routes/api.php', `<?php Route::get('/ping', [P::class, 'x']);`)]);
    expect(routeLabels(g)).toEqual(['GET /api/ping | P.x']);
  });
  it('shows non-literal paths as (dynamic) and ignores files without routes', () => {
    expect(routeLabels(web(`Route::get($path, [A::class, 'x']);`))).toEqual(['GET /(dynamic) | A.x']);
    expect(phpRouteAnalyzer.analyze([f('a.php', '<?php class A {}')]).nodes).toEqual([]);
  });
  it('Route:: inside strings and comments is ignored', () => {
    expect(routeLabels(web(`// Route::get('/c', [A::class, 'x']);\n$s = "Route::get('/s', 'x')";`))).toEqual([]);
  });
  it('produces a flowchart Mermaid accepts', () => {
    const g = web(`Route::prefix('a')->group(function () { Route::get('/b', [C::class, 'd']); });`);
    expect(parseMermaid(codeGraphToFlowchart(g, 'LR')).kind).toBe('flowchart');
  });
});

describe('phpRouteAnalyzer: attributes', () => {
  it('Symfony #[Route] on class (prefix) and methods with methods lists', () => {
    const g = phpRouteAnalyzer.analyze([
      f('src/Controller/BlogController.php', `<?php
#[Route('/blog', name: 'blog_')]
class BlogController {
  #[Route('/', name: 'index', methods: ['GET'])]
  public function index() {}
  #[Route(path: '/{id}', methods: ['GET', 'POST'])]
  public function show() {}
  #[Route('/any')]
  public function any() {}
  public function helper() {}
}`),
    ]);
    expect(routeLabels(g)).toEqual(['ANY /blog/any | BlogController.any', 'GET /blog/ | BlogController.index', 'GET /blog/{id} | BlogController.show', 'POST /blog/{id} | BlogController.show']);
    expect(g.nodes.filter((n) => n.kind === 'router')).toHaveLength(1);
  });
  it('Doctrine-style @Route docblock annotations on class and methods', () => {
    const g = phpRouteAnalyzer.analyze([
      f('src/Controller/OldController.php', `<?php
/**
 * @Route("/old", name="old_")
 */
final class OldController {
  /**
   * Lists things.
   *
   * @Route("/", name="index", methods={"GET", "HEAD"})
   */
  public function index() {}
  /** @Route("/{id}", methods={"POST"}) */
  public function save() {}
  /** @param int $x */
  public function plain($x) {}
}`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /old/ | OldController.index', 'HEAD /old/ | OldController.index', 'POST /old/{id} | OldController.save']);
  });
  it('invokable controllers with a class-level #[Route]', () => {
    expect(routeLabels(phpRouteAnalyzer.analyze([f('a.php', `<?php\n#[Route('/ping', methods: ['GET'])]\nclass Ping { public function __invoke() {} }`)]))).toEqual(['GET /ping | Ping.__invoke']);
  });
  it('verb attributes such as #[Get] and a #[Prefix] class attribute', () => {
    expect(routeLabels(phpRouteAnalyzer.analyze([f('a.php', `<?php\n#[Prefix('users')]\nclass U {\n #[Get('/')] public function i() {}\n #[Post('/new')] public function n() {}\n}`)]))).toEqual(['GET /users/ | U.i', 'POST /users/new | U.n']);
  });
  it('classes without route attributes produce nothing', () => {
    expect(phpRouteAnalyzer.analyze([f('a.php', `<?php\n#[Entity]\nclass E { #[Column] private $x; public function f() {} }`)]).nodes).toEqual([]);
  });
});
