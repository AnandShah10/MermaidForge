import { describe, it, expect } from 'vitest';
import { expressRouteAnalyzer } from '../src/analyzers/typescript/expressRouteAnalyzer';

const f = (path: string, text: string) => ({ path, text });
const routeLabels = (g: ReturnType<typeof expressRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();

describe('express routes', () => {
  it('finds routes on an app with handlers', () => {
    const g = expressRouteAnalyzer.analyze([
      f('server.js', `
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.post('/login', validate, authController.login);
app.delete(\`/items/:id\`, requireAuth(), removeItem);
app.listen(3000);
`),
    ]);
    expect(g.nodes.find((n) => n.kind === 'app')).toBeTruthy();
    expect(routeLabels(g)).toEqual(['DELETE /items/:id | requireAuth() → removeItem', 'GET /health | (inline)', 'POST /login | validate → authController.login']);
    expect(g.edges.filter((e) => e.kind === 'route')).toHaveLength(3);
  });

  it('resolves mounts across files (ES import, require, named export) into full paths', () => {
    const g = expressRouteAnalyzer.analyze([
      f('src/app.ts', `
import express from 'express';
import users from './routes/users';
import { adminRouter } from './routes/admin';
const posts = require('./routes/posts');
const app = express();
app.use('/api/users', users);
app.use('/admin', adminRouter);
app.use('/posts', require('./routes/posts'));
app.use(express.json());
`),
      f('src/routes/users.ts', `
import { Router } from 'express';
const router = Router();
router.get('/', list);
router.get('/:id', getOne);
export default router;
`),
      f('src/routes/admin.ts', `
import express from 'express';
export const adminRouter = express.Router();
adminRouter.put('/settings', save);
`),
      f('src/routes/posts.js', `
const router = require('express').Router();
router.get('/recent', recent);
module.exports = router;
`),
    ]);
    expect(routeLabels(g)).toEqual([
      'PUT /admin/settings | save',
      'GET /api/users | list',
      'GET /api/users/:id | getOne',
      'GET /posts/recent | recent',
    ].sort());
    const mounts = g.edges.filter((e) => e.kind === 'mount').map((e) => e.label).sort();
    expect(mounts).toEqual(['/admin', '/api/users', '/posts']);
  });

  it('supports route() chains', () => {
    const g = expressRouteAnalyzer.analyze([
      f('r.js', `const router = require('express').Router();\nrouter.route('/book').get(list).post(create);\nmodule.exports = router;`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /book | list', 'POST /book | create']);
  });

  it('shows router-relative paths when a router is mounted more than once', () => {
    const g = expressRouteAnalyzer.analyze([
      f('a.js', `const express = require('express');\nconst app = express();\nconst r = express.Router();\nr.get('/x', h);\napp.use('/v1', r);\napp.use('/v2', r);`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /x | h']);
    expect(g.edges.filter((e) => e.kind === 'mount')).toHaveLength(2);
  });

  it('handles nested router mounts', () => {
    const g = expressRouteAnalyzer.analyze([
      f('a.js', `const express = require('express');\nconst app = express();\nconst api = express.Router();\nconst users = express.Router();\nusers.get('/me', me);\napi.use('/users', users);\napp.use('/api', api);`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /api/users/me | me']);
  });

  it('is cycle-safe', () => {
    expect(() =>
      expressRouteAnalyzer.analyze([f('a.js', `const express = require('express');\nconst a = express.Router();\nconst b = express.Router();\na.use('/b', b);\nb.use('/a', a);\na.get('/x', h);`)]),
    ).not.toThrow();
  });

  it('ignores .get() on non-express objects', () => {
    const g = expressRouteAnalyzer.analyze([f('a.js', `const map = new Map();\nmap.get('/x');\nconst cache = {};\ncache.get('/y');`)]);
    expect(g.nodes).toHaveLength(0);
  });

  it('shows non-literal paths as source text', () => {
    const g = expressRouteAnalyzer.analyze([f('a.js', `const express = require('express');\nconst app = express();\napp.get(/^\\/re/, h);\napp.get(BASE, h2);`)]);
    expect(routeLabels(g).length).toBe(2);
  });

  it('returns an empty graph when no express usage exists', () => {
    expect(expressRouteAnalyzer.analyze([f('a.ts', 'export const x = 1;')])).toEqual({ nodes: [], edges: [] });
  });
});

describe('express routes: aliases, parameters and factories', () => {
  const g = (files: Array<[string, string]>) => expressRouteAnalyzer.analyze(files.map(([p, t]) => f(p, t)));
  const mounts = (gr: ReturnType<typeof g>) => gr.edges.filter((e) => e.kind === 'mount');

  it('passes the app to a required routes function: require("./routes")(app)', () => {
    const gr = g([
      ['app.js', "const express = require('express');\nconst app = express();\nrequire('./routes')(app);\n"],
      ['routes.js', "module.exports = function (app) {\n  app.get('/users', list);\n  app.post('/users', create);\n};\n"],
    ]);
    expect(routeLabels(gr)).toEqual(['GET /users | list', 'POST /users | create']);
    expect(mounts(gr)).toHaveLength(1);
  });

  it('follows nested hand-offs and imported functions, any router name', () => {
    const gr = g([
      ['server.ts', "import express from 'express';\nimport registerAll from './routes/index';\nconst app = express();\nregisterAll(app);\n"],
      ['routes/index.ts', "import users from './users';\nexport default function registerAll(a: any) {\n  users(a);\n}\n"],
      ['routes/users.ts', "export default (router: any) => {\n  router.get('/u', getUser);\n};\n"],
    ]);
    expect(routeLabels(gr)).toEqual(['GET /u | getUser']);
    expect(mounts(gr)).toHaveLength(2);
  });

  it('a router passed to a function and mounted with a prefix elsewhere gets full paths', () => {
    const gr = g([
      ['a.js', "const express = require('express');\nconst app = express();\nconst api = express.Router();\nsetup(api);\napp.use('/api', api);\nfunction setup(r) { r.get('/ping', ping); }\n"],
    ]);
    expect(routeLabels(gr)).toEqual(['GET /api/ping | ping']);
  });

  it('factories: const r = makeRouter(), app.use(prefix, makeRouter())', () => {
    const gr = g([
      ['a.js', "const express = require('express');\nconst app = express();\nfunction makeRouter() {\n  const r = express.Router();\n  r.get('/x', x);\n  return r;\n}\nconst users = makeRouter();\napp.use('/users', users);\n"],
      ['b.js', "const express = require('express');\nconst app = express();\nfunction build() { const router = express.Router(); router.get('/y', y); return router; }\napp.use('/v1', build());\n"],
    ]);
    expect(routeLabels(gr)).toEqual(['GET /users/x | x', 'GET /v1/y | y']);
  });

  it('aliased express imports and Router', () => {
    const gr = g([
      ['a.ts', "import e, { Router as R } from 'express';\nconst app = e();\nconst r = R();\nr.get('/z', z);\napp.use('/q', r);\n"],
      ['b.js', "const ex = require('express');\nconst { Router: Rt } = ex;\nconst app2 = ex();\nconst rr = ex.Router();\nrr.get('/w', w);\napp2.use(rr);\n"],
    ]);
    expect(routeLabels(gr)).toEqual(['GET /q/z | z', 'GET /w | w']);
  });

  it('equal variable names in different functions are different holders', () => {
    const gr = g([['a.js', "const express = require('express');\nfunction one() { const router = express.Router(); router.get('/1', h); return router; }\nfunction two() { const router = express.Router(); router.get('/2', h); return router; }\n"]]);
    expect(routeLabels(gr)).toEqual(['GET /1 | h', 'GET /2 | h']);
    expect(new Set(gr.nodes.filter((n) => n.kind === 'router').map((n) => n.id)).size).toBe(2);
  });

  it('ignores calls whose arguments are not routers, and unknown callees', () => {
    const gr = g([['a.js', "const express = require('express');\nconst app = express();\nfunction f(x) { x.get('/no', h); }\nf(somethingElse);\nunknown(app);\napp.get('/yes', h);\n"]]);
    expect(routeLabels(gr)).toEqual(['GET /yes | h']);
  });
});

describe('express routes: routers kept in class members', () => {
  it('this.app / this.router in a server class, including a controller class mounted via new X().router', () => {
    const g = expressRouteAnalyzer.analyze([
      f('app.ts', `
import express, { Router } from 'express';
import { UserRoutes } from './users';
class App {
  public app = express();
  private api: Router;
  constructor() {
    this.api = Router();
    this.routes();
  }
  private routes() {
    this.app.get('/health', health);
    this.api.get('/ping', ping);
    this.app.use('/api', this.api);
    this.app.use('/users', new UserRoutes().router);
  }
}
`),
      f('users.ts', `
import { Router } from 'express';
export class UserRoutes {
  public router: Router = Router();
  constructor() { this.init(); }
  init() { this.router.get('/', list); this.router.post('/', create); }
}
`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /api/ping | ping', 'GET /health | health', 'GET /users | list', 'POST /users | create']);
  });
  it('an instance held in a variable: const u = new UserRoutes(); app.use("/u", u.router)', () => {
    const g = expressRouteAnalyzer.analyze([
      f('a.js', `const express = require('express'); const app = express(); const u = new UserRoutes(); app.use('/u', u.router);
class UserRoutes { constructor() { this.router = express.Router(); this.router.get('/me', me); } }`),
    ]);
    expect(routeLabels(g)).toEqual(['GET /u/me | me']);
  });
  it('does not treat unrelated this.x.get() calls as routes', () => {
    const g = expressRouteAnalyzer.analyze([f('c.ts', `class C { cache = new Map(); f() { return this.cache.get('k'); } }`)]);
    expect(routeLabels(g)).toEqual([]);
  });
});

describe('loops over literal arrays and directories', () => {
  const lab = (g: ReturnType<typeof expressRouteAnalyzer.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  const users = { path: 'routes/users.js', text: `const r = require('express').Router(); r.get('/', list); module.exports = r;` };
  const posts = { path: 'routes/posts.js', text: `const r = require('express').Router(); r.get('/:id', one); module.exports = r;` };
  it('forEach over an array of names with a computed prefix and require', () => {
    const g = expressRouteAnalyzer.analyze([users, posts, { path: 'app.js', text: `
const app = require('express')();
['users', 'posts'].forEach((name) => { app.use('/' + name, require('./routes/' + name)); });` }]);
    expect(lab(g)).toEqual(['GET /posts/:id | one', 'GET /users | list']);
  });
  it('for-of over an array of { path, router } objects', () => {
    const g = expressRouteAnalyzer.analyze([users, posts, { path: 'app.js', text: `
const express = require('express'); const app = express();
const users = require('./routes/users'); const posts = require('./routes/posts');
const mounts = [{ path: '/u', router: users }, { path: '/p', router: posts }];
for (const m of mounts) app.use(m.path, m.router);` }]);
    expect(lab(g)).toEqual(['GET /p/:id | one', 'GET /u | list']);
  });
  it('readdirSync(dir).forEach mounts every scanned file in that folder under its file name', () => {
    const g = expressRouteAnalyzer.analyze([users, posts, { path: 'routes/index.js', text: `module.exports = 1;` }, { path: 'app.js', text: `
const fs = require('fs'); const path = require('path');
const app = require('express')();
fs.readdirSync(path.join(__dirname, 'routes')).forEach((file) => {
  app.use('/' + file.replace('.js', ''), require('./routes/' + file));
});` }]);
    expect(lab(g)).toEqual(['GET /posts/:id | one', 'GET /users | list']);
  });
  it('verbs inside a loop get one route per item', () => {
    const g = expressRouteAnalyzer.analyze([{ path: 'a.js', text: `
const app = require('express')();
['a', 'b'].forEach((n) => app.get('/' + n, h));` }]);
    expect(lab(g)).toEqual(['GET /a | h', 'GET /b | h']);
  });
  it('a loop it cannot evaluate is left alone', () => {
    const g = expressRouteAnalyzer.analyze([{ path: 'a.js', text: `
const app = require('express')();
getNames().forEach((n) => app.get('/' + n, h));` }]);
    expect(lab(g).length).toBeLessThanOrEqual(1);
  });
});
