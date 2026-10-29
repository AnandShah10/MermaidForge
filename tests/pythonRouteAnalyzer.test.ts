import { describe, it, expect } from 'vitest';
import { pythonRouteAnalyzer, parsePythonRoutes } from '../src/analyzers/python/pythonRouteAnalyzer';
import { codeGraphToFlowchart } from '../src/analyzers/mermaidGenerator';
import { parseMermaid } from '../src/core/parser/mermaidParser';

const f = (path: string, text: string) => ({ path, text });
type G = ReturnType<typeof pythonRouteAnalyzer.analyze>;
const run = (...files: Array<[string, string]>) => pythonRouteAnalyzer.analyze(files.map(([p, t]) => f(p, t)));
const routeLabels = (g: G) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
const mounts = (g: G) => g.edges.filter((e) => e.kind === 'mount').map((e) => e.label).sort();

describe('flask', () => {
  it('finds app, default-GET routes and handlers', () => {
    const g = run(['app.py', `from flask import Flask\napp = Flask(__name__)\n\n@app.route('/')\ndef index():\n    return 'x'\n`]);
    expect(g.nodes.find((n) => n.kind === 'app')).toBeTruthy();
    expect(routeLabels(g)).toEqual(['GET / | index']);
    expect(g.edges.filter((e) => e.kind === 'route')).toHaveLength(1);
  });
  it('creates one node per method', () => {
    const g = run(['a.py', `app = Flask(__name__)\n@app.route('/p', methods=['GET', "POST"])\ndef p(): pass\n`]);
    expect(routeLabels(g)).toEqual(['GET /p | p', 'POST /p | p']);
  });
  it('accepts tuple methods and lowercase', () => {
    const g = run(['a.py', `app = Flask(__name__)\n@app.route('/p', methods=('put', 'delete'))\ndef p(): pass\n`]);
    expect(routeLabels(g)).toEqual(['DELETE /p | p', 'PUT /p | p']);
  });
  it('supports Flask 2 shortcuts', () => {
    const g = run(['a.py', `app = Flask(__name__)\n@app.get('/a')\ndef a(): pass\n@app.post('/b')\ndef b(): pass\n@app.put('/c')\ndef c(): pass\n@app.delete('/d')\ndef d(): pass\n@app.patch('/e')\ndef e(): pass\n`]);
    expect(routeLabels(g)).toEqual(['DELETE /d | d', 'GET /a | a', 'PATCH /e | e', 'POST /b | b', 'PUT /c | c']);
  });
  it('treats non-literal methods as ANY', () => {
    const g = run(['a.py', `app = Flask(__name__)\nM = ['GET']\n@app.route('/p', methods=M)\ndef p(): pass\n`]);
    expect(routeLabels(g)).toEqual(['ANY /p | p']);
  });
  it('blueprint with url_prefix registered on app gets full paths', () => {
    const g = run(['a.py', `app = Flask(__name__)\nbp = Blueprint('users', __name__, url_prefix='/users')\n@bp.route('/<int:id>')\ndef get(id): pass\napp.register_blueprint(bp)\n`]);
    expect(routeLabels(g)).toEqual(['GET /users/<int:id> | get']);
    expect(mounts(g)).toEqual(['/users']);
    expect(g.nodes.filter((n) => n.kind === 'router')).toHaveLength(1);
  });
  it('register_blueprint url_prefix overrides the blueprint prefix', () => {
    const g = run(['a.py', `app = Flask(__name__)\nbp = Blueprint('u', __name__, url_prefix='/old')\n@bp.route('/x')\ndef x(): pass\napp.register_blueprint(bp, url_prefix='/api')\n`]);
    expect(routeLabels(g)).toEqual(['GET /api/x | x']);
    expect(mounts(g)).toEqual(['/api']);
  });
  it('resolves blueprints across files (from-import and module attribute)', () => {
    const g = run(
      ['myapp/__init__.py', `from flask import Flask\nfrom .views import bp\nfrom . import admin\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix='/api')\napp.register_blueprint(admin.admin_bp)\n`],
      ['myapp/views.py', `from flask import Blueprint\nbp = Blueprint('v', __name__)\n@bp.route('/ping')\ndef ping(): pass\n`],
      ['myapp/admin.py', `from flask import Blueprint\nadmin_bp = Blueprint('a', __name__, url_prefix='/admin')\n@admin_bp.get('/users')\ndef users(): pass\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /admin/users | users', 'GET /api/ping | ping']);
    expect(mounts(g)).toEqual(['/admin', '/api']);
  });
  it('resolves `import a.b as c` and absolute imports by suffix', () => {
    const g = run(
      ['src/main.py', `import shop.routes.cart as cart\napp = Flask(__name__)\napp.register_blueprint(cart.bp, url_prefix='/cart')\n`],
      ['src/shop/routes/cart.py', `bp = Blueprint('c', __name__)\n@bp.route('/')\ndef view(): pass\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /cart/ | view']);
  });
  it('resolves plain `import pkg.mod` with dotted attribute access', () => {
    const g = run(
      ['main.py', `import pkg.mod\napp = Flask(__name__)\napp.register_blueprint(pkg.mod.bp, url_prefix='/m')\n`],
      ['pkg/mod.py', `bp = Blueprint('m', __name__)\n@bp.route('/z')\ndef z(): pass\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /m/z | z']);
  });
  it('follows re-exports through __init__.py', () => {
    const g = run(
      ['main.py', `from pkg import bp\napp = Flask(__name__)\napp.register_blueprint(bp, url_prefix='/p')\n`],
      ['pkg/__init__.py', `from .routes import bp\n`],
      ['pkg/routes.py', `bp = Blueprint('r', __name__)\n@bp.route('/a')\ndef a(): pass\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /p/a | a']);
  });
  it('supports add_url_rule with methods and as_view classes', () => {
    const g = run(['a.py', `app = Flask(__name__)\napp.add_url_rule('/p', view_func=handler, methods=['GET', 'POST'])\napp.add_url_rule('/u', 'users', UserAPI.as_view('users'))\n`]);
    expect(routeLabels(g)).toEqual(['GET /p | handler', 'GET /u | UserAPI', 'POST /p | handler']);
  });
  it('supports nested blueprints', () => {
    const g = run(['a.py', `app = Flask(__name__)\nparent = Blueprint('p', __name__, url_prefix='/p')\nchild = Blueprint('c', __name__, url_prefix='/c')\n@child.route('/x')\ndef x(): pass\nparent.register_blueprint(child)\napp.register_blueprint(parent)\n`]);
    expect(routeLabels(g)).toEqual(['GET /p/c/x | x']);
  });
  it('shows router-relative paths when a blueprint is registered twice', () => {
    const g = run(['a.py', `app = Flask(__name__)\nbp = Blueprint('b', __name__)\n@bp.route('/x')\ndef x(): pass\napp.register_blueprint(bp, url_prefix='/v1')\napp.register_blueprint(bp, url_prefix='/v2')\n`]);
    expect(routeLabels(g)).toEqual(['GET /x | x']);
    expect(mounts(g)).toEqual(['/v1', '/v2']);
  });
  it('supports Quart', () => {
    const g = run(['a.py', `app = Quart(__name__)\n@app.route('/q')\nasync def q(): pass\n`]);
    expect(routeLabels(g)).toEqual(['GET /q | q']);
  });
});

describe('fastapi', () => {
  it('finds routes with all verbs, websocket and api_route', () => {
    const g = run(['main.py', `from fastapi import FastAPI\napp = FastAPI()\n@app.get('/a')\nasync def a(): ...\n@app.post('/b')\ndef b(): ...\n@app.put('/c')\ndef c(): ...\n@app.delete('/d')\ndef d(): ...\n@app.patch('/e')\ndef e(): ...\n@app.options('/f')\ndef f(): ...\n@app.head('/g')\ndef g(): ...\n@app.websocket('/ws')\nasync def ws(sock): ...\n@app.api_route('/h', methods=['GET','POST'])\ndef h(): ...\n`]);
    expect(routeLabels(g)).toEqual(['DELETE /d | d', 'GET /a | a', 'GET /h | h', 'HEAD /g | g', 'OPTIONS /f | f', 'PATCH /e | e', 'POST /b | b', 'POST /h | h', 'PUT /c | c', 'WS /ws | ws']);
  });
  it('applies APIRouter prefix on an unmounted router', () => {
    const g = run(['r.py', `router = APIRouter(prefix='/items', tags=['items'])\n@router.get('/{id}')\ndef one(id): ...\n`]);
    expect(routeLabels(g)).toEqual(['GET /items/{id} | one']);
  });
  it('composes include prefix and router prefix', () => {
    const g = run(['main.py', `app = FastAPI()\nrouter = APIRouter(prefix='/items')\n@router.get('/')\ndef lst(): ...\napp.include_router(router, prefix='/v1')\n`]);
    expect(routeLabels(g)).toEqual(['GET /v1/items/ | lst']);
    expect(mounts(g)).toEqual(['/v1/items']);
  });
  it('resolves include_router(items.router) via from-import of a module', () => {
    const g = run(
      ['app/main.py', `from fastapi import FastAPI\nfrom app.routers import items, users\napp = FastAPI()\napp.include_router(items.router)\napp.include_router(users.router, prefix='/api')\n`],
      ['app/routers/items.py', `router = APIRouter(prefix='/items')\n@router.get('/')\nasync def read_items(): ...\n`],
      ['app/routers/users.py', `router = APIRouter(prefix='/users')\n@router.post('/')\nasync def make(): ...\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /items/ | read_items', 'POST /api/users/ | make']);
  });
  it('resolves relative module and name imports', () => {
    const g = run(
      ['app/main.py', `from . import items\nfrom .other import router as other_router\napp = FastAPI()\napp.include_router(items.router, prefix='/i')\napp.include_router(other_router)\n`],
      ['app/items.py', `router = APIRouter()\n@router.get('/x')\ndef x(): ...\n`],
      ['app/other.py', `router = APIRouter(prefix='/o')\n@router.get('/y')\ndef y(): ...\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /i/x | x', 'GET /o/y | y']);
  });
  it('resolves `import a.b.c as items`', () => {
    const g = run(
      ['main.py', `import app.routers.items as items\napp = FastAPI()\napp.include_router(items.router, prefix='/z')\n`],
      ['app/routers/items.py', `router = APIRouter()\n@router.get('/q')\ndef q(): ...\n`],
    );
    expect(routeLabels(g)).toEqual(['GET /z/q | q']);
  });
  it('handles stacked decorators and multi-line decorator calls with any kwarg order', () => {
    const g = run(['main.py', `app = FastAPI()\n@app.get(\n    response_model=Item,\n    status_code=200,\n    path='/multi',\n)\n@cache(60)\n@login_required\nasync def multi(): ...\n`]);
    expect(routeLabels(g)).toEqual(['GET /multi | multi']);
  });
  it('registers the same function under stacked route decorators', () => {
    const g = run(['main.py', `app = FastAPI()\n@app.get('/a')\n@app.get('/b')\ndef both(): ...\n`]);
    expect(routeLabels(g)).toEqual(['GET /a | both', 'GET /b | both']);
  });
  it('resolves module-level string constants and concatenation', () => {
    const g = run(['main.py', `PREFIX = '/api'\nV = "/v1"\napp = FastAPI()\nrouter = APIRouter(prefix=PREFIX + V)\n@router.get('/x')\ndef x(): ...\napp.include_router(router, prefix=PREFIX)\n`]);
    expect(routeLabels(g)).toEqual(['GET /api/api/v1/x | x']);
  });
  it('shows unresolvable prefixes as source text', () => {
    const g = run(['main.py', `app = FastAPI()\nrouter = APIRouter()\n@router.get('/x')\ndef x(): ...\napp.include_router(router, prefix=settings.API_PREFIX)\n`]);
    expect(mounts(g)).toEqual(['/settings.API_PREFIX']);
    expect(routeLabels(g)).toEqual(['GET /settings.API_PREFIX/x | x']);
  });
  it('supports add_api_route and Starlette add_route', () => {
    const g = run(['main.py', `app = FastAPI()\napp.add_api_route('/a', handler_a, methods=['POST'])\napp.add_route('/b', handler_b)\n`]);
    expect(routeLabels(g)).toEqual(['GET /b | handler_b', 'POST /a | handler_a']);
  });
  it('supports include_router with keyword router arg', () => {
    const g = run(['main.py', `app = FastAPI()\nr = APIRouter()\n@r.get('/k')\ndef k(): ...\napp.include_router(router=r, prefix='/kw')\n`]);
    expect(routeLabels(g)).toEqual(['GET /kw/k | k']);
  });
  it('is cycle-safe', () => {
    expect(() => run(['a.py', `a = APIRouter()\nb = APIRouter()\na.include_router(b, prefix='/b')\nb.include_router(a, prefix='/a')\n@a.get('/x')\ndef x(): ...\n`])).not.toThrow();
  });
});

describe('django', () => {
  it('maps urlpatterns to routes with view names', () => {
    const g = run(['urls.py', `from django.urls import path, re_path\nfrom . import views\nurlpatterns = [\n    path('', views.index, name='index'),\n    path('about/', views.about),\n    path('posts/', PostList.as_view(), name='posts'),\n    path('x/', views.Thing.as_view()),\n    re_path(r'^articles/(?P<year>[0-9]{4})/$', views.year),\n]\n`]);
    expect(g.nodes.find((n) => n.kind === 'router')).toBeTruthy();
    expect(routeLabels(g)).toEqual(['ANY / | views.index', 'ANY /about/ | views.about', 'ANY /articles/(?P<year>[0-9]{4})/ | views.year', 'ANY /posts/ | PostList', 'ANY /x/ | views.Thing']);
  });
  it('resolves include() by dotted path across files', () => {
    const g = run(
      ['proj/urls.py', `from django.urls import path, include\nurlpatterns = [\n    path('api/', include('app.urls')),\n    path('shop/', include(('shop.urls', 'shop'))),\n    path('admin/', admin.site.urls),\n]\n`],
      ['app/urls.py', `urlpatterns = [path('users/', views.users)]\n`],
      ['shop/urls.py', `urlpatterns = [path('cart/', views.cart)]\n`],
    );
    expect(routeLabels(g)).toEqual(['ANY /admin/ | admin.site.urls', 'ANY /api/users/ | views.users', 'ANY /shop/cart/ | views.cart']);
    expect(mounts(g)).toEqual(['/api/', '/shop/']);
    expect(g.nodes.filter((n) => n.kind === 'router')).toHaveLength(3);
  });
  it('supports urlpatterns += and list concatenation', () => {
    const g = run(['urls.py', `urlpatterns = [path('a/', va)] + [path('b/', vb)]\nurlpatterns += [path('c/', vc)]\n`]);
    expect(routeLabels(g)).toEqual(['ANY /a/ | va', 'ANY /b/ | vb', 'ANY /c/ | vc']);
  });
  it('unwraps format_suffix_patterns', () => {
    const g = run(['urls.py', `urlpatterns = format_suffix_patterns([path('s/', vs)])\n`]);
    expect(routeLabels(g)).toEqual(['ANY /s/ | vs']);
  });
  it('maps DRF router.register to ROUTER routes and mounts router.urls', () => {
    const g = run(['urls.py', `from rest_framework.routers import DefaultRouter\nrouter = DefaultRouter()\nrouter.register(r'users', UserViewSet)\nrouter.register('groups', GroupViewSet, basename='g')\nurlpatterns = [path('api/', include(router.urls))]\n`]);
    expect(routeLabels(g)).toEqual(['ROUTER /api/groups | GroupViewSet', 'ROUTER /api/users | UserViewSet']);
    expect(mounts(g)).toEqual(['/api/']);
    expect(g.edges.filter((e) => e.kind === 'route')).toHaveLength(2);
  });
  it('mounts a bare `urlpatterns += router.urls`', () => {
    const g = run(['urls.py', `router = SimpleRouter()\nrouter.register('a', AViewSet)\nurlpatterns = [path('z/', vz)]\nurlpatterns += router.urls\n`]);
    expect(routeLabels(g)).toEqual(['ANY /z/ | vz', 'ROUTER /a | AViewSet']);
  });
  it('shows router-relative paths when a urls module is included twice', () => {
    const g = run(
      ['root/urls.py', `urlpatterns = [path('a/', include('app.urls')), path('b/', include('app.urls'))]\n`],
      ['app/urls.py', `urlpatterns = [path('x/', vx)]\n`],
    );
    expect(routeLabels(g)).toEqual(['ANY /x/ | vx']);
    expect(mounts(g)).toEqual(['/a/', '/b/']);
  });
  it('ignores include() of unscanned apps', () => {
    const g = run(['urls.py', `urlpatterns = [path('a/', include('third.party.urls')), path('k/', vk)]\n`]);
    expect(mounts(g)).toEqual([]);
    expect(routeLabels(g)).toEqual(['ANY /k/ | vk']);
  });
});

describe('robustness', () => {
  it('returns an empty graph for empty or unrelated files', () => {
    expect(run(['a.py', ''])).toEqual({ nodes: [], edges: [] });
    expect(run(['a.py', 'x = 1\ndef f(): pass\n'])).toEqual({ nodes: [], edges: [] });
    expect(pythonRouteAnalyzer.analyze([])).toEqual({ nodes: [], edges: [] });
  });
  it('ignores decorators on non-holders', () => {
    const g = run(['a.py', `@pytest.get('/x')\ndef t(): pass\n@something.route('/y')\ndef u(): pass\n`]);
    expect(g.nodes).toHaveLength(0);
  });
  it('ignores routes in comments and strings', () => {
    const g = run(['a.py', `app = Flask(__name__)\n# @app.route('/no')\n"""\n@app.route('/doc')\ndef d(): pass\n"""\nx = "@app.get('/s')"\n`]);
    expect(g.nodes).toHaveLength(0);
  });
  it('never throws on malformed input', () => {
    const bad = [
      `app = Flask(\n@app.route(\ndef`,
      `@app.route('/x'\ndef f(): pass`,
      `app = FastAPI()\n@app.get(\n`,
      `urlpatterns = [path(`,
      `urlpatterns = `,
      `app = Flask(__name__)\napp.register_blueprint()\napp.add_url_rule()\napp.include_router(`,
      `from import\nimport\nfrom . import\n@\n@@\n`,
      `x = '''unterminated\n@app.route('/x')`,
      '\u0000￿\r\n\r\n\\\n\\',
      `router = DefaultRouter()\nrouter.register()\nrouter.register(r'a')`,
    ];
    for (const b of bad) expect(() => run(['a.py', b])).not.toThrow();
    expect(() => pythonRouteAnalyzer.analyze([{ path: 'a.py', text: undefined as unknown as string }])).not.toThrow();
  });
  it('uses unique node ids per file and variable', () => {
    const g = run(
      ['a.py', `app = Flask(__name__)\n@app.route('/a')\ndef a(): pass\n`],
      ['b.py', `app = Flask(__name__)\n@app.route('/b')\ndef b(): pass\n`],
    );
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.nodes.filter((n) => n.kind === 'app')).toHaveLength(2);
  });
  it('detects holders defined inside factory functions', () => {
    const g = run(['a.py', `def create_app():\n    app = Flask(__name__)\n    bp = Blueprint('b', __name__)\n    app.register_blueprint(bp, url_prefix='/f')\n    return app\n`]);
    expect(mounts(g)).toEqual(['/f']);
  });
  it('exposes parsePythonRoutes data', () => {
    const r = parsePythonRoutes([f('a.py', `app = FastAPI()\n@app.get('/x')\ndef x(): ...\n`)]);
    expect(r.holders).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ method: 'GET', path: '/x', handler: 'x' });
  });
  it('has analyzer metadata', () => {
    expect(pythonRouteAnalyzer.supportedExtensions).toEqual(['.py']);
    expect(pythonRouteAnalyzer.id).toBeTruthy();
  });
});

describe('mermaid output', () => {
  const sources: Array<[string, Array<[string, string]>]> = [
    ['flask', [['app.py', `app = Flask(__name__)\nbp = Blueprint('b', __name__, url_prefix='/b')\n@bp.route('/x', methods=['GET','POST'])\ndef x(): pass\napp.register_blueprint(bp)\n`]]],
    ['fastapi', [['main.py', `app = FastAPI()\nr = APIRouter(prefix='/items')\n@r.get('/{id}')\ndef one(id): ...\n@r.websocket('/ws')\nasync def ws(s): ...\napp.include_router(r, prefix='/v1')\n`]]],
    ['django', [['urls.py', `urlpatterns = [path('a/', include('app.urls')), re_path(r'^x/(?P<y>\\d+)/$', views.v)]\n`], ['app/urls.py', `urlpatterns = [path('u/', views.u)]\nrouter = DefaultRouter()\nrouter.register(r'users', UserViewSet)\nurlpatterns += router.urls\n`]]],
  ];
  for (const [name, files] of sources) {
    it(`${name} graph renders to a flowchart that parses`, () => {
      const g = run(...files);
      expect(g.nodes.length).toBeGreaterThan(0);
      const src = codeGraphToFlowchart(g, 'LR');
      const parsed = parseMermaid(src);
      expect(parsed.kind).toBe('flowchart');
    });
  }
});

describe('routers passed to functions and returned from factories', () => {
  it('register_routes(app): decorators and blueprints inside the function', () => {
    const g = run(
      ['main.py', 'from flask import Flask\nfrom routes import register_routes\napp = Flask(__name__)\nregister_routes(app)\n'],
      ['routes.py', 'from flask import Blueprint\nbp = Blueprint("x", __name__, url_prefix="/x")\n\n@bp.get("/a")\ndef a():\n    pass\n\ndef register_routes(app):\n    @app.get("/health")\n    def health():\n        return "ok"\n    app.register_blueprint(bp)\n'],
    );
    expect(routeLabels(g)).toEqual(['GET /health | health', 'GET /x/a | a']);
  });

  it('keyword arguments and module-qualified calls', () => {
    const g = run(
      ['main.py', 'from fastapi import FastAPI\nimport api\napp = FastAPI()\napi.setup(application=app)\n'],
      ['api.py', 'def setup(application):\n    @application.post("/items")\n    def create():\n        pass\n'],
    );
    expect(routeLabels(g)).toEqual(['POST /items | create']);
  });

  it('follows hand-offs through several functions and shows full paths with a prefix', () => {
    const g = run([
      'app.py',
      'from fastapi import FastAPI, APIRouter\napp = FastAPI()\napi = APIRouter(prefix="/api")\nouter(api)\napp.include_router(api)\n\ndef outer(r):\n    inner(r)\n\ndef inner(router):\n    @router.get("/ping")\n    def ping():\n        pass\n',
    ]);
    expect(routeLabels(g)).toEqual(['GET /api/ping | ping']);
  });

  it('factories: app = create_app() in another module, include_router(make_router())', () => {
    const g = run(
      ['factory.py', 'from flask import Flask\ndef create_app():\n    app = Flask(__name__)\n    return app\n'],
      ['wsgi.py', 'from factory import create_app\napp = create_app()\n\n@app.route("/")\ndef index():\n    pass\n'],
      ['r.py', 'from fastapi import FastAPI, APIRouter\nmain = FastAPI()\ndef make_router():\n    r = APIRouter()\n    @r.get("/z")\n    def z():\n        pass\n    return r\nmain.include_router(make_router(), prefix="/v2")\n'],
    );
    expect(routeLabels(g)).toEqual(['GET / | index', 'GET /v2/z | z']);
  });

  it('ignores arguments that are not routers, unknown callees and statements inside other functions', () => {
    const g = run(['a.py', 'from flask import Flask\napp = Flask(__name__)\ndef f(x):\n    @x.get("/no")\n    def h():\n        pass\nf(settings)\nunknown(app)\n@app.get("/yes")\ndef y():\n    pass\n']);
    expect(routeLabels(g)).toEqual(['GET /yes | y']);
  });
});

describe('routers kept on class instances', () => {
  const labels = (g: ReturnType<typeof pythonRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('self.router = APIRouter(prefix=..) with add_api_route in a method, mounted via the instance', () => {
    const g = pythonRouteAnalyzer.analyze([
      { path: 'users.py', text: `
from fastapi import APIRouter
class UserApi:
    def __init__(self):
        self.router = APIRouter(prefix="/users")
        self.router.add_api_route("/", self.list, methods=["GET"])
        self.router.add_api_route("/{id}", self.get, methods=["GET", "DELETE"])
    def list(self): ...
    def get(self, id): ...
` },
      { path: 'main.py', text: `
from fastapi import FastAPI
from users import UserApi
app = FastAPI()
api = UserApi()
app.include_router(api.router, prefix="/v1")
` },
    ]);
    const r = labels(g);
    expect(r.some((x) => x.startsWith('GET /v1/users/ '))).toBe(true);
    expect(r.some((x) => x.startsWith('DELETE /v1/users/{id}'))).toBe(true);
    expect(r.length).toBe(3);
  });
  it('self.app = Flask(..) with add_url_rule inside the class', () => {
    const g = pythonRouteAnalyzer.analyze([{ path: 's.py', text: `
from flask import Flask
class Server:
    def __init__(self):
        self.app = Flask(__name__)
        self.app.add_url_rule("/ping", view_func=self.ping)
    def ping(self): return "ok"
` }]);
    expect(labels(g).some((x) => x.startsWith('GET /ping'))).toBe(true);
  });
});

describe('loops over literal lists', () => {
  it('unrolls blueprint registration and tuple unpacking', () => {
    const g = run(['app.py', `from flask import Flask, Blueprint
app = Flask(__name__)
users = Blueprint('users', __name__)
posts = Blueprint('posts', __name__)
@users.route('/')
def u(): pass
@posts.route('/')
def p(): pass
for name, bp in [('users', users), ('posts', posts)]:
    app.register_blueprint(bp, url_prefix='/' + name)
for ver in ['v1', 'v2']:
    app.add_url_rule('/' + ver + '/ping', 'ping' + ver, ping)
app.add_url_rule('/same', 'same', ping)
`]);
    expect(mounts(g)).toEqual(['/posts', '/users']);
    expect(routeLabels(g)).toEqual(expect.arrayContaining(['GET /v1/ping | ping', 'GET /v2/ping | ping', 'GET /same | ping']));
  });
});
