import { describe, it, expect } from 'vitest';
import { nodeFrameworkRouteAnalyzer as an } from '../src/analyzers/typescript/nodeFrameworkRoutes';

const f = (path: string, text: string) => ({ path, text });
const routes = (g: ReturnType<typeof an.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();

describe('NestJS', () => {
  const src = `
import { Controller, Get, Post, Param, Delete } from '@nestjs/common';
@Controller('cats')
export class CatsController {
  @Get() findAll() {}
  @Get(':id') findOne(@Param('id') id: string) {}
  @Post() create() {}
  @Delete({ path: ':id' }) remove() {}
  helper() {}
}
@Controller()
export class RootController { @Get(['ping', 'health']) ping() {} }
`;
  it('reads controller prefixes and method decorators', () => {
    expect(routes(an.analyze([f('cats.controller.ts', src)]))).toEqual([
      'DELETE /cats/:id | CatsController.remove',
      'GET /cats | CatsController.findAll',
      'GET /cats/:id | CatsController.findOne',
      'GET /health | RootController.ping',
      'GET /ping | RootController.ping',
      'POST /cats | CatsController.create',
    ]);
  });
  it('turns setGlobalPrefix into a mount, so full paths include it', () => {
    const g = an.analyze([f('cats.controller.ts', src), f('main.ts', `async function bootstrap(){ const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api/v1'); }`)]);
    expect(routes(g)).toContain('GET /api/v1/cats | CatsController.findAll');
    expect(g.nodes.some((n) => n.kind === 'app')).toBe(true);
  });
  it('ignores classes that are not controllers', () => {
    expect(routes(an.analyze([f('a.ts', `class S { @Get('x') f() {} }`)]))).toEqual([]);
  });
});

describe('Fastify', () => {
  it('finds routes on an instance, including route() and handler-in-options', () => {
    const g = an.analyze([
      f('app.js', `
const fastify = require('fastify')({ logger: true });
fastify.get('/', async () => ({ ok: 1 }));
fastify.post('/items', { schema: {} }, createItem);
fastify.get('/opts', { handler: listOpts });
fastify.route({ method: ['PUT', 'PATCH'], url: '/items/:id', handler: updateItem });
`),
    ]);
    expect(routes(g)).toEqual(['GET / | (inline)', 'GET /opts | listOpts', 'PATCH /items/:id | updateItem', 'POST /items | createItem', 'PUT /items/:id | updateItem']);
  });
  it('follows register() with prefix into inline, local and imported plugins (nested)', () => {
    const g = an.analyze([
      f('server.ts', `
import Fastify from 'fastify';
import usersPlugin from './users';
const app = Fastify();
app.register(usersPlugin, { prefix: '/users' });
app.register(async (instance) => { instance.get('/ping', pingHandler); }, { prefix: '/sys' });
`),
      f('users.ts', `
import { FastifyInstance } from 'fastify';
export default async function (fastify: FastifyInstance) {
  fastify.get('/', list);
  fastify.register(adminRoutes, { prefix: '/admin' });
}
async function adminRoutes(f) { f.delete('/:id', removeUser); }
`),
    ]);
    expect(routes(g)).toEqual(['DELETE /users/admin/:id | removeUser', 'GET /sys/ping | pingHandler', 'GET /users/ | list']);
  });
  it('does not treat Express-style (app) functions or Map.get calls as Fastify', () => {
    const g = an.analyze([f('x.js', `const fastify = require('fastify')(); const m = new Map(); m.get('k'); function register(app){ app.get('/x', h); }`)]);
    expect(routes(g)).toEqual([]);
  });
});

describe('Koa', () => {
  it('reads router routes, prefixes, named routes and app.use(router.routes())', () => {
    const g = an.analyze([
      f('app.js', `
const Koa = require('koa');
const Router = require('@koa/router');
const app = new Koa();
const router = new Router({ prefix: '/api' });
router.get('/users', list);
router.get('user', '/users/:id', show, audit);
router.del('/users/:id', remove);
app.use(router.routes()).use(router.allowedMethods());
`),
    ]);
    expect(routes(g)).toEqual(['DELETE /api/users/:id | remove', 'GET /api/users | list', 'GET /api/users/:id | audit']);
  });
  it('mounts child routers with router.use(prefix, child.routes()) across files', () => {
    const g = an.analyze([
      f('index.ts', `
import Koa from 'koa';
import Router from 'koa-router';
import posts from './posts';
const app = new Koa();
const api = new Router();
api.use('/posts', posts.routes(), posts.allowedMethods());
app.use(api.routes());
`),
      f('posts.ts', `
import Router from 'koa-router';
const router = new Router();
router.get('/', listPosts);
router.post('/', createPost);
export default router;
`),
    ]);
    expect(routes(g)).toEqual(['GET /posts/ | listPosts', 'POST /posts/ | createPost']);
    expect(g.edges.some((e) => e.kind === 'mount' && e.label === '/posts')).toBe(true);
  });
  it('does not claim Express apps', () => {
    expect(routes(an.analyze([f('e.js', `const express = require('express'); const app = express(); app.get('/x', h);`)]))).toEqual([]);
  });
});

describe('review fixes from real repositories', () => {
  it('Koa router created by calling the module directly: require("@koa/router")()', () => {
    const g = an.analyze([f('a.js', `const Koa = require('koa'); const app = new Koa(); const router = require('@koa/router')(); router.get('/', list); app.use(router.routes());`)]);
    expect(routes(g)).toEqual(['GET / | list']);
  });
  it('a setGlobalPrefix applies only to controllers of its own project (monorepo of Nest apps)', () => {
    const ctrl = (n: string) => `@Controller('${n}') export class C${n} { @Get() f() {} }`;
    const g = an.analyze([
      f('a/src/x.controller.ts', ctrl('x')),
      f('a/src/main.ts', `app.setGlobalPrefix('api');`),
      f('b/src/y.controller.ts', ctrl('y')),
    ]);
    expect(routes(g)).toEqual(['GET /api/x | Cx.f', 'GET /y | Cy.f']);
  });
});

describe('Fastify autoload', () => {
  const app = `
import path from 'node:path';
import autoload from '@fastify/autoload';
export default async function app(fastify) {
  fastify.register(autoload, { dir: path.join(import.meta.dirname, 'routes'), options: { prefix: '/v1' } });
}`;
  const plugin = (route: string) => `export default async function (fastify) { fastify.get('${route}', h); }`;
  it('mounts plugin files by folder, index files alone, _param folders as :param', () => {
    const g = an.analyze([
      f('src/app.ts', app),
      f('src/routes/home.ts', plugin('/')),
      f('src/routes/users/index.ts', plugin('/')),
      f('src/routes/users/helper.ts', plugin('/ignored')),
      f('src/routes/users/_id/index.ts', plugin('/profile')),
      f('src/routes/api/autohooks.ts', plugin('/hook')),
      f('src/routes/api/a.test.ts', plugin('/t')),
    ]);
    expect(routes(g)).toEqual(['GET /v1/ | h', 'GET /v1/users/ | h', 'GET /v1/users/:id/profile | h']);
  });
  it('dirNameRoutePrefix:false drops folder prefixes', () => {
    const g = an.analyze([f('src/app.ts', app.replace("options:", "dirNameRoutePrefix: false, options:")), f('src/routes/users/index.ts', plugin('/me'))]);
    expect(routes(g)).toEqual(['GET /v1/me | h']);
  });
});

describe('RouterModule, koa-mount, fastify-plugin', () => {
  it('Nest RouterModule prefixes the controllers of a module, with nested children', () => {
    const g = an.analyze([
      f('cats.controller.ts', `@Controller('cats') export class CatsController { @Get() all() {} }`),
      f('dogs.controller.ts', `@Controller('dogs') export class DogsController { @Get() all() {} }`),
      f('mods.ts', `
@Module({ controllers: [CatsController] }) export class CatsModule {}
@Module({ controllers: [DogsController] }) export class DogsModule {}
@Module({ imports: [RouterModule.register([{ path: 'admin', module: CatsModule, children: [{ path: 'pets', module: DogsModule }] }])] }) export class AppModule {}`),
    ]);
    expect(routes(g)).toEqual(['GET /admin/cats | CatsController.all', 'GET /admin/pets/dogs | DogsController.all']);
  });
  it('koa-mount mounts a router or a sub-app under a prefix', () => {
    const g = an.analyze([f('app.ts', `
import Koa from 'koa'; import Router from '@koa/router'; import mount from 'koa-mount';
const app = new Koa(); const r = new Router();
r.get('/users', list);
app.use(mount('/api', r.routes()));`)]);
    expect(routes(g)).toEqual(['GET /api/users | list']);
  });
  it('fastify-plugin wrappers are transparent: fp(fn) registers like fn', () => {
    const g = an.analyze([
      f('plugin.ts', `import fp from 'fastify-plugin'; export default fp(async function (fastify) { fastify.get('/ping', ping); });`),
      f('server.ts', `import Fastify from 'fastify'; import plugin from './plugin'; const app = Fastify(); app.register(plugin, { prefix: '/v1' });`),
    ]);
    expect(routes(g)).toEqual(['GET /v1/ping | ping']);
  });
});

describe('Hapi', () => {
  it('server.route with an object or an array of route objects', () => {
    const g = an.analyze([f('server.ts', `
import Hapi from '@hapi/hapi';
const server = Hapi.server({ port: 3000 });
server.route({ method: 'GET', path: '/a', handler: getA });
server.route([{ method: ['POST', 'PUT'], path: '/b/{id}', handler: saveB }, { method: '*', path: '/c', handler: any }]);`)]);
    expect(routes(g)).toEqual(['ALL /c | any', 'GET /a | getA', 'POST /b/{id} | saveB', 'PUT /b/{id} | saveB']);
  });
});

describe('Hapi plugins', () => {
  it('applies routes.prefix from register({ plugin, routes }) and follows imported plugin modules', () => {
    const g = an.analyze([
      f('users.js', `exports.plugin = { name: 'users', register(server) { server.route({ method: 'GET', path: '/list', handler: list }); } };`),
      f('admin.js', `const plugin = { name: 'admin', register: async (server, options) => { server.route({ method: 'GET', path: '/stats', handler: stats }); } };\nmodule.exports = { plugin };`),
      f('server.js', `
const Hapi = require('@hapi/hapi');
const users = require('./users');
const admin = require('./admin');
const init = async () => {
  const server = Hapi.server({ port: 1 });
  await server.register({ plugin: users, routes: { prefix: '/users' } });
  await server.register([{ plugin: admin.plugin, routes: { prefix: '/admin' } }]);
  server.route({ method: 'GET', path: '/', handler: home });
};`),
    ]);
    expect(routes(g)).toEqual(['GET / | home', 'GET /admin/stats | stats', 'GET /users/list | list']);
  });
  it('a plugin registered without a prefix keeps its own paths', () => {
    const g = an.analyze([f('s.js', `
const Hapi = require('@hapi/hapi');
const server = Hapi.server();
const health = { name: 'health', register: (srv) => { srv.route({ method: 'GET', path: '/health', handler: h }); } };
server.register(health);`)]);
    expect(routes(g)).toEqual(['GET /health | h']);
  });
});

describe('loops over literal arrays', () => {
  it('Fastify forEach and for-of with the loop variable in paths and handlers', () => {
    const g = an.analyze([
      f('app.ts', `
import Fastify from 'fastify';
const app = Fastify();
['users', 'posts'].forEach((name) => { app.get('/' + name, listHandler); app.get('/health', ping); });
const defs = [{ path: '/a', handler: ha }, { path: '/b', handler: hb }];
for (const d of defs) app.post(d.path, d.handler);
`),
    ]);
    expect(routes(g)).toEqual(['GET /health | ping', 'GET /posts | listHandler', 'GET /users | listHandler', 'POST /a | ha', 'POST /b | hb']);
  });
});
