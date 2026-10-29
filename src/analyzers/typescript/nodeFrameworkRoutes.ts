import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { RouteEntry, RouteHolder, RouteMount, assembleRouteGraph, joinPaths } from '../common/routeUtils';
import { resolveRelativeImport } from './importGraphAnalyzer';
import { asLoop, Env, evalString, literalElements, propertyOf } from './loopExpansion';

/**
 * Route maps for the Node frameworks the Express analyzer does not cover:
 * NestJS, Fastify and Koa (@koa/router / koa-router). Syntax-only, no type
 * information, name-based like the rest of the analyzers.
 *
 *  - NestJS: `@Controller('x')` classes and their `@Get/@Post/@Put/@Delete/
 *    @Patch/@Options/@Head/@All('path')` methods (string or array paths, or an
 *    `{ path }` object). `app.setGlobalPrefix('api')` becomes a mount from the
 *    app onto every controller. Modules, `RouterModule`, versioning, guards
 *    and `@Controller` paths that are not string literals are NOT followed.
 *  - Fastify: instances from `fastify()` / `Fastify()` (the `fastify` module,
 *    however it is imported or required). `x.get|post|put|delete|patch|options|
 *    head|all(path, [opts], handler)` and `x.route({ method, url, handler })`.
 *    `x.register(plugin, { prefix })` mounts a plugin: an inline function, a
 *    local function, or one imported from a scanned file (default, named or
 *    `require`); its first parameter becomes the router inside it, so nested
 *    registers are followed. Plugins built by wrapper calls (`fp(fn)`),
 *    autoload with a computed `dir`, and instances created inside factory functions are NOT
 *    followed. `@fastify/autoload` is followed for a literal `dir`: every plugin
 *    file under it is mounted with its folder path as the prefix (a folder with
 *    an `index` file loads only that file; `_id` folders become `:id`).
 *  - Koa: `new Router({ prefix })` / `.prefix(p)`, `router.get|post|put|
 *    delete|del|patch|options|head|all([name,] path, ...handlers)`,
 *    `app.use(router.routes())` and `router.use('/p', child.routes())`. A
 *    router exported from another scanned file (`export default`,
 *    `module.exports =`, `export const`) is resolved through the importing
 *    file. `koa-mount`, routers built in functions, and dynamic paths are NOT
 *    followed.
 *
 * A route shows its full path only when its router has exactly one mount
 * chain (same rule as every route analyzer).
 */

const VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', del: 'DELETE', patch: 'PATCH', options: 'OPTIONS', head: 'HEAD', all: 'ALL' };
const NEST_VERBS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', All: 'ALL' };
const EXT_KIND: Record<string, ts.ScriptKind> = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
type Framework = 'fastify' | 'koa' | 'koa-router' | 'hapi';

interface Holder extends RouteHolder {
  /** Fastify plugin function or Koa router with its own prefix (applies to every route of the holder). */
  ownPrefix: string;
}

interface FileInfo {
  path: string;
  sf: ts.SourceFile;
  /** local name -> where it comes from */
  imports: Map<string, { spec: string; name: string }>;
  /** local names bound to a framework module */
  frameworks: Map<string, Framework>;
  fns: Map<string, Fn>;
  exportedFns: Map<string, Fn>;
  /** local variable -> holder created from `fastify()` / `new Koa()` / `new Router()` */
  instances: Map<string, Holder>;
  /** exported name ('default' or named) -> local variable name of an instance */
  exportedInstances: Map<string, string>;
  /** top-level `const x = { ... }` and exported object literals (Hapi plugin objects) */
  objs: Map<string, ts.ObjectLiteralExpression>;
  exportedObjs: Map<string, ts.ObjectLiteralExpression>;
}

/** Bindings of the loop variable while the body of a loop over a literal array is read once per item (else null). */
let LOOP_ENV: Env | null = null;

function str(e: ts.Node | undefined): string | null {
  if (!e) return null;
  if (LOOP_ENV && ts.isExpression(e) && !ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) {
    const v = evalString(e, LOOP_ENV);
    if (v !== null) return v;
  }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1);
  return null;
}

function strings(e: ts.Node | undefined): string[] {
  if (!e) return [];
  const s = str(e);
  if (s !== null) return [s];
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => str(x)).filter((x): x is string => x !== null);
  return [];
}

function moduleFramework(spec: string): Framework | null {
  if (spec === 'fastify') return 'fastify';
  if (spec === 'koa') return 'koa';
  if (spec === '@hapi/hapi' || spec === 'hapi') return 'hapi';
  if (spec === '@koa/router' || spec === 'koa-router') return 'koa-router';
  return null;
}

function isFn(n: ts.Node | undefined): n is Fn {
  return !!n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n));
}

function fnName(fn: Fn): string | undefined {
  return ts.isArrowFunction(fn) ? undefined : fn.name && ts.isIdentifier(fn.name) ? fn.name.text : undefined;
}

function handlerName(a: ts.Expression): string {
  if (LOOP_ENV && ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression)) {
    // `r.handler` with `r` bound to an object literal of the loop's array: use the element's own handler expression.
    const b = LOOP_ENV.get(a.expression.text);
    if (b !== undefined && typeof b !== 'string' && ts.isObjectLiteralExpression(b)) {
      const v = propertyOf(b, a.name.text);
      if (v) return handlerName(v);
    }
  }
  if (ts.isIdentifier(a)) return a.text;
  if (ts.isPropertyAccessExpression(a)) return a.getText();
  if (ts.isCallExpression(a)) return `${a.expression.getText().slice(0, 40)}()`;
  if (ts.isAwaitExpression(a)) return handlerName(a.expression);
  return '(inline)';
}

function requireSpec(e: ts.Node | undefined): string | null {
  if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require') return str(e.arguments[0]);
  return null;
}

function analyze(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const infos = new Map<string, FileInfo>();
  const holders = new Map<string, Holder>();
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];

  const mkHolder = (rawId: string, label: string, kind: 'app' | 'router', ownPrefix = ''): Holder => {
    const id = `nf:${rawId}`; // keeps ids distinct from the Express analyzer's when both graphs are merged
    let h = holders.get(id);
    if (!h) {
      h = { id, label, kind, ownPrefix };
      holders.set(id, h);
    }
    return h;
  };

  // ---- Phase 1: per-file index -------------------------------------------------
  for (const f of files) {
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, EXT_KIND[posixPath.extname(f.path)] ?? ts.ScriptKind.TS);
    } catch {
      continue;
    }
    const info: FileInfo = { path: f.path, sf, imports: new Map(), frameworks: new Map(), fns: new Map(), exportedFns: new Map(), instances: new Map(), exportedInstances: new Map(), objs: new Map(), exportedObjs: new Map() };
    infos.set(f.path, info);
    const bind = (local: string, spec: string, name: string) => {
      info.imports.set(local, { spec, name });
      const fw = moduleFramework(spec);
      if (fw && (name === 'default' || name === '*' || name === 'fastify' || name === 'Router' || name === 'Koa' || name === 'server' || name === 'Server')) info.frameworks.set(local, fw);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const c = st.importClause;
        if (!c) continue;
        if (c.name) bind(c.name.text, spec, 'default');
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) bind(c.namedBindings.name.text, spec, '*');
          else for (const el of c.namedBindings.elements) bind(el.name.text, spec, el.propertyName?.text ?? el.name.text);
        }
      }
    }
    const visitDecl = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const spec = requireSpec(n.initializer) ?? (ts.isCallExpression(n.initializer) && requireSpec(n.initializer.expression) !== null ? requireSpec(n.initializer.expression) : null);
        if (spec !== null && ts.isIdentifier(n.name)) bind(n.name.text, spec, 'default');
        else if (spec !== null && ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) bind(el.name.text, spec, (el.propertyName as ts.Identifier | undefined)?.text ?? el.name.text);
        }
        // `const x = require('mod').Router` style
        if (ts.isPropertyAccessExpression(n.initializer) && requireSpec(n.initializer.expression) !== null && ts.isIdentifier(n.name)) bind(n.name.text, requireSpec(n.initializer.expression)!, n.initializer.name.text);
      }
      ts.forEachChild(n, visitDecl);
    };
    visitDecl(sf);
  }

  /** `fp(fn)` from fastify-plugin only changes encapsulation, so the routes are those of `fn`. */
  const unwrapFp = (info: FileInfo, e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.arguments.length > 0 && info.imports.get(e.expression.text)?.spec === 'fastify-plugin') return unwrapFp(info, e.arguments[0]);
    return e;
  };

  // Functions and exports (top-level only) + framework instances (any scope).
  for (const info of infos.values()) {
    const { sf } = info;
    for (const st of sf.statements) {
      const exported = (st as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      const isDefault = (st as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
      if (ts.isFunctionDeclaration(st)) {
        if (st.name) info.fns.set(st.name.text, st);
        if (exported && isDefault) info.exportedFns.set('default', st);
        else if (exported && st.name) info.exportedFns.set(st.name.text, st);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const init = d.initializer ? unwrapFp(info, d.initializer) : undefined;
          if (isFn(init)) {
            info.fns.set(d.name.text, init);
            if (exported) info.exportedFns.set(d.name.text, init);
          }
          if (exported) info.exportedInstances.set(d.name.text, d.name.text);
          if (init && ts.isObjectLiteralExpression(init)) {
            info.objs.set(d.name.text, init);
            if (exported) info.exportedObjs.set(d.name.text, init);
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const ex = unwrapFp(info, st.expression);
        if (ts.isObjectLiteralExpression(ex)) info.exportedObjs.set('default', ex);
        else if (ts.isIdentifier(ex) && info.objs.has(ex.text)) info.exportedObjs.set('default', info.objs.get(ex.text)!);
        if (isFn(ex)) info.exportedFns.set('default', ex);
        else if (ts.isIdentifier(st.expression)) {
          info.exportedInstances.set('default', st.expression.text);
          const fn = info.fns.get(st.expression.text);
          if (fn) info.exportedFns.set('default', fn);
        }
      } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = st.expression.left.getText();
        const r = unwrapFp(info, st.expression.right);
        const rObj = ts.isObjectLiteralExpression(r) ? r : ts.isIdentifier(r) ? info.objs.get(r.text) : undefined;
        if (rObj && (l === 'module.exports' || /^(module\.)?exports\.\w+$/.test(l))) info.exportedObjs.set(/^(module\.)?exports\.\w+$/.test(l) ? l.split('.').pop()! : 'default', rObj);
        if (l === 'module.exports') {
          if (isFn(r)) info.exportedFns.set('default', r);
          else if (ts.isIdentifier(r)) {
            info.exportedInstances.set('default', r.text);
            const fn = info.fns.get(r.text);
            if (fn) info.exportedFns.set('default', fn);
          }
        } else if (/^(module\.)?exports\.\w+$/.test(l)) {
          const name = l.split('.').pop()!;
          if (isFn(r)) info.exportedFns.set(name, r);
          else if (ts.isIdentifier(r)) info.exportedInstances.set(name, r.text);
        }
      }
    }
    const findInstances = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        let init: ts.Expression = n.initializer;
        while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        const callee = ts.isNewExpression(init) ? init.expression : ts.isCallExpression(init) ? init.expression : null;
        // Hapi: `Hapi.server({...})`, `new Hapi.Server()`, `const { server } = ...` style factories
        if (callee && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && info.frameworks.get(callee.expression.text) === 'hapi' && /^[sS]erver$/.test(callee.name.text)) {
          info.instances.set(n.name.text, mkHolder(`${info.path}::${n.name.text}`, `hapi server ${n.name.text}<br/>${info.path}`, 'app'));
        }
        if (callee && ts.isIdentifier(callee) && info.frameworks.get(callee.text) === 'hapi' && /^[sS]erver$/.test(info.imports.get(callee.text)?.name ?? '')) {
          info.instances.set(n.name.text, mkHolder(`${info.path}::${n.name.text}`, `hapi server ${n.name.text}<br/>${info.path}`, 'app'));
        }
        const inlineRequire = callee && ts.isCallExpression(callee) ? requireSpec(callee) : null; // require('fastify')({...})
        if (callee && (ts.isIdentifier(callee) || inlineRequire !== null)) {
          const fw = ts.isIdentifier(callee) ? info.frameworks.get(callee.text) : moduleFramework(inlineRequire!) ?? undefined;
          const name = n.name.text;
          const label = (kind: string) => `${kind} ${name}<br/>${info.path}`;
          if (fw === 'fastify' && !ts.isNewExpression(init)) info.instances.set(name, mkHolder(`${info.path}::${name}`, label('fastify'), 'app'));
          else if (fw === 'koa' && ts.isNewExpression(init)) info.instances.set(name, mkHolder(`${info.path}::${name}`, label('koa app'), 'app'));
          else if (fw === 'koa-router') {
            const opts = (ts.isNewExpression(init) || ts.isCallExpression(init) ? init.arguments?.[0] : undefined); // `new Router(opts)` and the module called directly, `require('@koa/router')(opts)`
            let prefix = '';
            if (opts && ts.isObjectLiteralExpression(opts)) {
              for (const p of opts.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === 'prefix') prefix = str(p.initializer) ?? '';
            }
            info.instances.set(name, mkHolder(`${info.path}::${name}`, label('koa router'), 'router', prefix));
          }
        }
      }
      ts.forEachChild(n, findInstances);
    };
    findInstances(sf);
  }

  // ---- Resolution helpers ------------------------------------------------------
  const importTarget = (info: FileInfo, spec: string): FileInfo | null => {
    const t = resolveRelativeImport(info.path, spec, known);
    return t ? infos.get(t) ?? null : null;
  };

  const resolveFn = (info: FileInfo, e: ts.Expression): { fn: Fn; owner: FileInfo; name: string } | null => {
    e = unwrapFp(info, e);
    if (isFn(e)) return { fn: e, owner: info, name: fnName(e) ?? `anonymous@${info.sf.getLineAndCharacterOfPosition(e.getStart()).line + 1}` };
    if (ts.isParenthesizedExpression(e)) return resolveFn(info, e.expression);
    const spec = requireSpec(e);
    if (spec !== null) {
      const t = importTarget(info, spec);
      const fn = t?.exportedFns.get('default');
      return t && fn ? { fn, owner: t, name: fnName(fn) ?? 'plugin' } : null;
    }
    if (ts.isIdentifier(e)) {
      const local = info.fns.get(e.text);
      if (local) return { fn: local, owner: info, name: e.text };
      const imp = info.imports.get(e.text);
      if (imp) {
        const t = importTarget(info, imp.spec);
        const fn = t?.exportedFns.get(imp.name === '*' ? 'default' : imp.name);
        if (t && fn) return { fn, owner: t, name: e.text };
      }
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const imp = info.imports.get(e.expression.text);
      if (imp) {
        const t = importTarget(info, imp.spec);
        const fn = t?.exportedFns.get(e.name.text);
        if (t && fn) return { fn, owner: t, name: e.name.text };
      }
    }
    return null;
  };

  /** Holder of an instance variable, local or imported from a scanned file. */
  const instanceHolder = (info: FileInfo, name: string, depth = 0): Holder | null => {
    const local = info.instances.get(name);
    if (local) return local;
    const imp = info.imports.get(name);
    if (!imp || depth > 3) return null;
    const t = importTarget(info, imp.spec);
    if (!t) return null;
    const exportedName = t.exportedInstances.get(imp.name === '*' ? 'default' : imp.name);
    return exportedName ? instanceHolder(t, exportedName, depth + 1) : null;
  };

  // Fastify plugin functions: first parameter is a router. Found as a fixpoint over `register` calls.
  const pluginFns = new Map<Fn, { owner: FileInfo; name: string; holder: Holder }>();
  const pluginHolder = (owner: FileInfo, fn: Fn, name: string): Holder => {
    let p = pluginFns.get(fn);
    if (!p) {
      p = { owner, name, holder: mkHolder(`${owner.path}::${name}#${owner.sf.getLineAndCharacterOfPosition(fn.getStart()).line + 1}`, `plugin ${name}<br/>${owner.path}`, 'router') };
      pluginFns.set(fn, p);
    }
    return p.holder;
  };
  const firstParam = (fn: Fn): string | null => {
    const p = fn.parameters[0];
    return p && ts.isIdentifier(p.name) ? p.name.text : null;
  };
  const typedAsFastify = (fn: Fn): boolean => {
    const p = fn.parameters[0];
    if (p?.type && /Fastify(Instance|Plugin)?/.test(p.type.getText())) return true;
    const parent = fn.parent;
    return !!parent && ts.isVariableDeclaration(parent) && !!parent.type && /FastifyPlugin/.test(parent.type.getText());
  };

  /** Holder for a receiver expression inside `info`, given the chain of enclosing functions (innermost last). */
  const receiverHolder = (info: FileInfo, e: ts.Expression, enclosing: Fn[]): Holder | null => {
    if (!ts.isIdentifier(e)) return null;
    for (let i = enclosing.length - 1; i >= 0; i--) {
      const fn = enclosing[i];
      if (firstParam(fn) === e.text) {
        const p = pluginFns.get(fn);
        if (p) return p.holder;
        if (typedAsFastify(fn)) return pluginHolder(info, fn, fnName(fn) ?? 'plugin');
        break;
      }
    }
    return instanceHolder(info, e.text);
  };

  const withEnclosing = (info: FileInfo, visit: (n: ts.Node, enclosing: Fn[]) => void) => {
    const walk = (n: ts.Node, enclosing: Fn[]) => {
      visit(n, enclosing);
      const next = isFn(n) ? [...enclosing, n] : enclosing;
      ts.forEachChild(n, (c) => walk(c, next));
    };
    walk(info.sf, []);
  };

  /**
   * `fastify.register(autoload, { dir })`: every plugin file under `dir` is registered, with the sub-directory path
   * as its prefix (`_id` -> `:id`). As in @fastify/autoload, a directory holding an `index` file loads only that
   * file; `autohooks`, tests and declaration files are skipped. `dirNameRoutePrefix: false` and `options.prefix` are honoured.
   */
  const AUTOLOAD = new Set(['@fastify/autoload', 'fastify-autoload']);
  const autoloadTargets = (info: FileInfo, call: ts.CallExpression): Array<{ fn: Fn; owner: FileInfo; name: string; prefix: string }> => {
    const a0 = call.arguments[0];
    const spec = ts.isIdentifier(a0) ? info.imports.get(a0.text)?.spec : requireSpec(a0);
    const opts = call.arguments[1];
    if (!spec || !AUTOLOAD.has(spec) || !opts || !ts.isObjectLiteralExpression(opts)) return [];
    let dirParts: string[] = [];
    let dirNamePrefix = true;
    let optPrefix = '';
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = p.name.getText();
      if (key === 'dir') {
        const lits: string[] = [];
        const collect = (e: ts.Node) => {
          const v = str(e);
          if (v !== null) lits.push(v);
          else ts.forEachChild(e, collect);
        };
        collect(p.initializer);
        dirParts = lits;
      } else if (key === 'dirNameRoutePrefix') dirNamePrefix = p.initializer.kind !== ts.SyntaxKind.FalseKeyword;
      else if (key === 'options' && ts.isObjectLiteralExpression(p.initializer)) {
        for (const q of p.initializer.properties) if (ts.isPropertyAssignment(q) && q.name.getText() === 'prefix') optPrefix = str(q.initializer) ?? '';
      }
    }
    if (dirParts.length === 0) return [];
    const root = posixPath.normalize(posixPath.join(posixPath.dirname(info.path), ...dirParts));
    const byDir = new Map<string, FileInfo[]>();
    for (const t of infos.values()) {
      if (!t.path.startsWith(root + '/') || /\.(test|spec)\.|\.d\.ts$|(^|\/)autohooks\./.test(t.path)) continue;
      const dir = posixPath.dirname(t.path);
      byDir.set(dir, [...(byDir.get(dir) ?? []), t]);
    }
    const out: Array<{ fn: Fn; owner: FileInfo; name: string; prefix: string }> = [];
    for (const [dir, list] of byDir) {
      const index = list.filter((t) => /^index\.[cm]?[jt]s$/.test(posixPath.basename(t.path)));
      const rel = posixPath.relative(root, dir);
      const dirPrefix = dirNamePrefix && rel ? '/' + rel.split('/').map((seg) => (seg.startsWith('_') ? ':' + seg.slice(1) : seg)).join('/') : '';
      for (const t of index.length ? index : list) {
        const fn = t.exportedFns.get('default');
        if (fn) out.push({ fn, owner: t, name: posixPath.basename(t.path).replace(/\.[cm]?[jt]s$/, ''), prefix: joinPaths(optPrefix, dirPrefix) === '/' ? '' : joinPaths(optPrefix, dirPrefix) });
      }
    }
    return out;
  };

  const registerCall = (n: ts.Node): ts.CallExpression | null =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'register' && n.arguments.length >= 1 ? n : null;

  const prefixOf = (opts: ts.Expression | undefined): string => {
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === 'prefix') return str(p.initializer) ?? '';
    }
    return '';
  };


  /**
   * What a `register(...)` call installs, as plugin functions with the prefix each gets. Fastify takes a function and
   * `{ prefix }` options; Hapi takes a plugin object (`{ register }`, or `{ plugin, routes: { prefix } }`, or a module
   * exporting `plugin`), possibly in an array.
   */
  const registerTargets = (info: FileInfo, call: ts.CallExpression): Array<{ fn: Fn; owner: FileInfo; name: string; prefix: string }> => {
    const out: Array<{ fn: Fn; owner: FileInfo; name: string; prefix: string }> = [];
    const first = call.arguments[0];
    const fast = resolveFn(info, first);
    if (fast) out.push({ ...fast, prefix: prefixOf(call.arguments[1]) });
    const optPrefix = (opts: ts.Expression | undefined): string => {
      if (!opts || !ts.isObjectLiteralExpression(opts)) return '';
      for (const p of opts.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === 'routes' && ts.isObjectLiteralExpression(p.initializer)) return prefixOf(p.initializer);
      }
      return '';
    };
    const fromObject = (owner: FileInfo, obj: ts.ObjectLiteralExpression, prefix: string, label: string, depth: number) => {
      let plugin: ts.Expression | undefined;
      let register: ts.Node | undefined;
      let name = label;
      for (const p of obj.properties) {
        const key = p.name?.getText();
        if (key === 'plugin' && ts.isPropertyAssignment(p)) plugin = p.initializer;
        else if (key === 'register' && ts.isPropertyAssignment(p)) register = p.initializer;
        else if (key === 'register' && ts.isMethodDeclaration(p)) register = p;
        else if (key === 'name' && ts.isPropertyAssignment(p)) name = str(p.initializer) ?? name;
      }
      if (register && isFn(register)) out.push({ fn: register, owner, name, prefix });
      else if (register && ts.isIdentifier(register)) {
        const fn = owner.fns.get(register.text);
        if (fn) out.push({ fn, owner, name, prefix });
      }
      if (plugin && depth < 4) fromExpr(owner, plugin, prefix, depth + 1);
    };
    /** Named export `name` of a module: `exports.name = {..}` / `export const name`, else a member of the default-exported object (`module.exports = { name }`). */
    const exportedObj = (t: FileInfo, name: string): ts.ObjectLiteralExpression | undefined => {
      const direct = t.exportedObjs.get(name);
      if (direct) return direct;
      const def = t.exportedObjs.get('default');
      if (!def) return undefined;
      for (const p of def.properties) {
        if (p.name?.getText() !== name) continue;
        if (ts.isShorthandPropertyAssignment(p)) return t.objs.get(p.name.text);
        if (ts.isPropertyAssignment(p)) return ts.isObjectLiteralExpression(p.initializer) ? p.initializer : ts.isIdentifier(p.initializer) ? t.objs.get(p.initializer.text) : undefined;
      }
      return undefined;
    };
    const fromExpr = (owner: FileInfo, e: ts.Expression, prefix: string, depth: number) => {
      if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) return fromExpr(owner, e.expression, prefix, depth);
      if (ts.isArrayLiteralExpression(e)) {
        for (const el of e.elements) fromExpr(owner, el, prefix, depth);
        return;
      }
      if (ts.isObjectLiteralExpression(e)) {
        // `{ plugin, routes: { prefix } }` wraps a plugin; the wrapper's prefix wins over the outer one.
        const own = optPrefix(e);
        fromObject(owner, e, own || prefix, 'plugin', depth);
        return;
      }
      const spec = requireSpec(e);
      if (spec !== null) {
        const t = importTarget(owner, spec);
        const o = t ? exportedObj(t, 'plugin') ?? t.exportedObjs.get('default') : undefined;
        if (t && o) fromObject(t, o, prefix, posixPath.basename(t.path).replace(/\.\w+$/, ''), depth);
        return;
      }
      if (ts.isIdentifier(e)) {
        const local = owner.objs.get(e.text);
        if (local) return fromObject(owner, local, prefix, e.text, depth);
        const imp = owner.imports.get(e.text);
        const t = imp ? importTarget(owner, imp.spec) : null;
        if (imp && t) {
          const o = t.exportedObjs.get(imp.name === 'default' || imp.name === '*' ? 'plugin' : imp.name) ?? (imp.name === 'default' || imp.name === '*' ? t.exportedObjs.get('default') : undefined);
          if (o) fromObject(t, o, prefix, e.text, depth);
        }
        return;
      }
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        // `import * as users from './users'; register(users.plugin)` or `require('./users').plugin`
        const imp = owner.imports.get(e.expression.text);
        const t = imp ? importTarget(owner, imp.spec) : null;
        const o = t ? exportedObj(t, e.name.text) : undefined;
        if (t && o) fromObject(t, o, prefix, e.name.text, depth);
      } else if (ts.isPropertyAccessExpression(e)) {
        const sp = requireSpec(e.expression);
        const t = sp !== null ? importTarget(owner, sp) : null;
        const o = t ? exportedObj(t, e.name.text) : undefined;
        if (t && o) fromObject(t, o, prefix, e.name.text, depth);
      }
    };
    if (!fast) fromExpr(info, first, '', 0);
    return out;
  };

  // Fixpoint: a register() on a known holder makes its plugin argument a holder, which can register further plugins.
  for (let round = 0; round < 6; round++) {
    const before = pluginFns.size;
    for (const info of infos.values()) {
      withEnclosing(info, (n, enclosing) => {
        const call = registerCall(n);
        if (!call) return;
        const recvExpr = (call.expression as ts.PropertyAccessExpression).expression;
        let recv = receiverHolder(info, recvExpr, enclosing);
        if (!recv && ts.isIdentifier(recvExpr) && autoloadTargets(info, call).length > 0) {
          // An untyped root plugin (`export default async function (fastify) { fastify.register(autoload, ...) }`).
          const owner = [...enclosing].reverse().find((fn) => firstParam(fn) === recvExpr.text);
          if (owner) recv = pluginHolder(info, owner, fnName(owner) ?? 'plugin');
        }
        if (!recv) return;
        for (const t of autoloadTargets(info, call)) pluginHolder(t.owner, t.fn, t.name);
        for (const t of registerTargets(info, call)) pluginHolder(t.owner, t.fn, t.name);
      });
    }
    if (pluginFns.size === before) break;
  }

  // ---- Phase 2: routes and mounts ----------------------------------------------
  const addRoute = (holder: Holder, method: string, path: string, handler: string) => routes.push({ holder, method, path: joinPaths(holder.ownPrefix, path), handler });

  const handledInLoop = new WeakSet<ts.Node>();
  for (const info of infos.values()) {
    const handleNode = (n: ts.Node, enclosing: Fn[]): void => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const method = n.expression.name.text;
      const recvExpr = n.expression.expression;

      // Koa: router.routes() / allowedMethods() as the argument of `use`.
      if (method === 'use') {
        const parent = ts.isIdentifier(recvExpr) ? receiverHolder(info, recvExpr, enclosing) : null;
        if (!parent) return;
        const prefix = str(n.arguments[0]);
        for (const a of prefix !== null ? n.arguments.slice(1) : n.arguments) {
          // koa-mount: use(mount('/api', router.routes())) or use(mount('/admin', adminApp))
          if (ts.isCallExpression(a) && ts.isIdentifier(a.expression) && info.imports.get(a.expression.text)?.spec === 'koa-mount' && a.arguments.length > 0) {
            const mp = a.arguments.length > 1 ? str(a.arguments[0]) : '/';
            const target = a.arguments[a.arguments.length - 1];
            const inner = ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'routes' ? target.expression.expression : target;
            const child = mp !== null && ts.isIdentifier(inner) ? receiverHolder(info, inner, enclosing) : null;
            if (child && child.id !== parent.id) mounts.push({ parent, child, prefix: mp! });
            continue;
          }
          if (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) && a.expression.name.text === 'routes' && ts.isIdentifier(a.expression.expression)) {
            const child = receiverHolder(info, a.expression.expression, enclosing);
            if (child && child.id !== parent.id) mounts.push({ parent, child, prefix: prefix ?? '' });
          }
        }
        return;
      }

      // Koa: router.prefix('/x')
      if (method === 'prefix' && ts.isIdentifier(recvExpr)) {
        const h = receiverHolder(info, recvExpr, enclosing);
        const p = str(n.arguments[0]);
        if (h && p !== null) h.ownPrefix = p;
        return;
      }

      if (method === 'register') {
        const parent = receiverHolder(info, recvExpr, enclosing);
        if (!parent) return;
        for (const t of autoloadTargets(info, n)) {
          const child = pluginHolder(t.owner, t.fn, t.name);
          if (child.id !== parent.id) mounts.push({ parent, child, prefix: t.prefix });
        }
        for (const t of registerTargets(info, n)) {
          const child = pluginHolder(t.owner, t.fn, t.name);
          if (child.id !== parent.id) mounts.push({ parent, child, prefix: t.prefix });
        }
        return;
      }

      const recv = receiverHolder(info, recvExpr, enclosing);
      if (!recv) return;

      // Fastify: x.route({ method, url, handler })
      const routeArg = n.arguments[0];
      const routeObjs = method === 'route' && n.arguments.length === 1 ? (routeArg && ts.isObjectLiteralExpression(routeArg) ? [routeArg] : routeArg && ts.isArrayLiteralExpression(routeArg) ? routeArg.elements.filter(ts.isObjectLiteralExpression) : []) : [];
      if (routeObjs.length) {
       for (const obj of routeObjs) {
        let methods: string[] = [];
        let url: string[] = [];
        let handler = '(inline)';
        for (const p of obj.properties) {
          const key = p.name?.getText();
          if (ts.isPropertyAssignment(p)) {
            if (key === 'method') methods = strings(p.initializer).map((m) => (m === '*' ? 'ALL' : m.toUpperCase()));
            else if (key === 'url' || key === 'path') url = strings(p.initializer);
            else if (key === 'handler') handler = handlerName(p.initializer);
          } else if (ts.isShorthandPropertyAssignment(p) && key === 'handler') handler = 'handler';
          else if (ts.isMethodDeclaration(p) && key === 'handler') handler = '(inline)';
        }
        for (const u of url) for (const m of methods.length ? methods : ['ALL']) addRoute(recv, m, u, handler);
       }
       return;
      }

      const verb = VERBS[method];
      if (!verb) return;
      const args = [...n.arguments];
      // Koa named routes: router.get('name', '/path', ...)
      if (args.length >= 3 && str(args[0]) !== null && str(args[1]) !== null && /^[/(*]/.test(str(args[1])!) && !/^[/(*]/.test(str(args[0])!)) args.shift();
      const paths = strings(args[0]);
      if (paths.length === 0) return;
      const rest = args.slice(1);
      let handlers = rest.filter((a) => !ts.isObjectLiteralExpression(a)).map(handlerName);
      if (handlers.length === 0) {
        // Fastify: x.get('/', { handler })
        const opts = rest.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
        const h = opts?.properties.find((p) => p.name?.getText() === 'handler');
        if (h && ts.isPropertyAssignment(h)) handlers = [handlerName(h.initializer)];
        else if (h) handlers = ['handler'];
      }
      if (rest.length === 0 && handlers.length === 0) return; // a route needs a handler
      for (const p of paths) addRoute(recv, verb, p, handlers.length > 1 ? handlers[handlers.length - 1] : handlers[0] ?? '');
    };
    // Loops over a literal array (`['a','b'].forEach(x => app.get('/' + x, h))`, `for (const r of routes) app.get(r.path, r.handler)`)
    // are read once per element; entries repeated across elements (calls that don't use the loop variable) collapse.
    const walkIn = (n: ts.Node, enclosing: Fn[]) => {
      handleNode(n, enclosing);
      const next = isFn(n) ? [...enclosing, n] : enclosing;
      ts.forEachChild(n, (c) => walkIn(c, next));
    };
    const expandLoop = (n: ts.Node, enclosing: Fn[]): boolean => {
      const loop = asLoop(n);
      const items = loop ? literalElements(info.sf, loop.iterable) : null;
      if (!loop || !items || items.length === 0 || items.length > 200) return false;
      const r0 = routes.length;
      const m0 = mounts.length;
      const cb = ts.isCallExpression(n) ? n.arguments[0] : undefined;
      const inner = cb && isFn(cb) ? [...enclosing, cb] : enclosing;
      const mark = (c: ts.Node) => {
        handledInLoop.add(c);
        ts.forEachChild(c, mark);
      };
      for (const item of items) {
        LOOP_ENV = new Map([[loop.param, item]]);
        try {
          walkIn(loop.body, inner);
        } finally {
          LOOP_ENV = null;
        }
      }
      mark(loop.body);
      const dedupe = <T>(arr: T[], from: number, key: (x: T) => string) => {
        const seen = new Set<string>();
        const kept = arr.splice(from).filter((x) => {
          const k = key(x);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        arr.push(...kept);
      };
      dedupe(routes, r0, (r) => `${r.holder.id}|${r.method}|${r.path}|${r.handler}`);
      dedupe(mounts, m0, (m) => `${m.parent.id}|${m.child.id}|${m.prefix}`);
      return true;
    };
    withEnclosing(info, (n, enclosing) => {
      if (handledInLoop.has(n)) return;
      if (expandLoop(n, enclosing)) return;
      handleNode(n, enclosing);
    });
  }

  // ---- NestJS ------------------------------------------------------------------
  const globalPrefixes: Array<{ dir: string; prefix: string }> = []; // scoped to the project directory of the file that sets it
  const nestModules = new Map<string, string[]>(); // @Module class -> controller class names
  const routerTree: Array<{ path: string; module: string | null; children: unknown[] }> = [];
  const nestControllers: Array<{ holder: Holder; routes: Array<{ method: string; path: string; handler: string }> }> = [];
  for (const info of infos.values()) {
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'setGlobalPrefix') {
        const p = str(n.arguments[0]);
        if (p !== null) globalPrefixes.push({ dir: posixPath.dirname(info.path).replace(/(^|\/)src$/, '').replace(/^\.$/, ''), prefix: p });
      }
      // RouterModule.register([{ path, module, children }]) assigns route prefixes to whole modules.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'register' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'RouterModule') {
        const arg = n.arguments[0];
        const readRoutes = (e: ts.Expression): Array<{ path: string; module: string | null; children: ts.Expression[] }> => {
          if (!ts.isArrayLiteralExpression(e)) return [];
          const out: Array<{ path: string; module: string | null; children: ts.Expression[] }> = [];
          for (const el of e.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            let path = ''; let module: string | null = null; let children: ts.Expression[] = [];
            for (const p of el.properties) {
              if (!ts.isPropertyAssignment(p)) continue;
              const key = p.name.getText();
              if (key === 'path') path = str(p.initializer) ?? '';
              else if (key === 'module' && ts.isIdentifier(p.initializer)) module = p.initializer.text;
              else if (key === 'children') children = [p.initializer];
            }
            out.push({ path, module, children });
          }
          return out;
        };
        const flatten = (e: ts.Expression, base: string) => {
          for (const r of readRoutes(e)) {
            const full = joinPaths(base, r.path);
            routerTree.push({ path: full, module: r.module, children: [] });
            for (const c of r.children) flatten(c, full);
          }
        };
        if (arg) flatten(arg, '');
      }
      if (ts.isClassDeclaration(n) && n.name) {
        const decorators = ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : [];
        const modDec = decorators.find((d) => ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === 'Module');
        if (modDec) {
          const cfg = (modDec.expression as ts.CallExpression).arguments[0];
          if (cfg && ts.isObjectLiteralExpression(cfg)) {
            const ctl = cfg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'controllers');
            if (ctl && ts.isPropertyAssignment(ctl) && ts.isArrayLiteralExpression(ctl.initializer)) {
              nestModules.set(n.name.text, ctl.initializer.elements.filter(ts.isIdentifier).map((e) => e.text));
            }
          }
        }
        const ctrl = decorators.find((d) => ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === 'Controller');
        if (ctrl) {
          const call = ctrl.expression as ts.CallExpression;
          const a = call.arguments[0];
          let prefix: string[] = [''];
          if (a) {
            const direct = strings(a);
            if (direct.length) prefix = direct;
            else if (ts.isObjectLiteralExpression(a)) {
              const pp = a.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'path');
              if (pp && ts.isPropertyAssignment(pp)) prefix = strings(pp.initializer);
              if (prefix.length === 0) prefix = [''];
            }
          }
          const holder = mkHolder(`${info.path}::${n.name.text}`, `controller ${n.name.text}<br/>${info.path}`, 'router', prefix[0]);
          const list: Array<{ method: string; path: string; handler: string }> = [];
          for (const m of n.members) {
            if (!ts.isMethodDeclaration(m) || !ts.canHaveDecorators(m)) continue;
            for (const d of ts.getDecorators(m) ?? []) {
              if (!ts.isCallExpression(d.expression) || !ts.isIdentifier(d.expression.expression)) continue;
              const verb = NEST_VERBS[d.expression.expression.text];
              if (!verb) continue;
              const a0 = d.expression.arguments[0];
              let paths = strings(a0);
              if (a0 && paths.length === 0 && ts.isObjectLiteralExpression(a0)) {
                const pp = a0.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'path');
                if (pp && ts.isPropertyAssignment(pp)) paths = strings(pp.initializer);
              }
              if (paths.length === 0) paths = [''];
              for (const p of paths) list.push({ method: verb, path: p, handler: `${n.name.text}.${m.name.getText()}` });
            }
          }
          if (list.length) nestControllers.push({ holder, routes: list });
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(info.sf);
  }
  // Each setGlobalPrefix applies to the controllers under its project directory (the folder above `src/`), the
  // longest match winning, so a monorepo of separate Nest apps does not leak one app's prefix onto the others.
  for (const c of nestControllers) {
    for (const r of c.routes) routes.push({ holder: c.holder, method: r.method, path: joinPaths(c.holder.ownPrefix, r.path), handler: r.handler });
    const file = c.holder.id.replace(/^nf:/, '').split('::')[0];
    const scope = globalPrefixes
      .filter((g) => g.dir === '' || file.startsWith(g.dir + '/'))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const ctrlName = c.holder.id.split('::')[1];
    const modPath = [...nestModules].filter(([, ctrls]) => ctrls.includes(ctrlName)).map(([m]) => routerTree.find((r) => r.module === m)?.path).find((p) => p !== undefined) ?? '';
    const dir = scope ? scope.dir : posixPath.dirname(file).replace(/(^|\/)src$/, '').replace(/^\.$/, '');
    const prefix = joinPaths(scope?.prefix ?? '', modPath);
    if (scope || modPath) mounts.push({ parent: mkHolder(`nest::app@${dir}`, `NestJS app${dir ? `<br/>${dir}` : ''}`, 'app'), child: c.holder, prefix });
  }

  return assembleRouteGraph(holders.values(), routes, mounts);
}

export const nodeFrameworkRouteAnalyzer: CodeAnalyzer = {
  id: 'node-framework-routes',
  displayName: 'NestJS / Fastify / Koa Routes',
  supportedExtensions: ['.ts', '.js', '.mjs', '.cjs'],
  analyze,
};
