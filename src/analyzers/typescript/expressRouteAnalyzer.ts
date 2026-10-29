import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { Env, asLoop, evalString, filesInDir, literalElements, propertyOf, readdirTarget, DIR_MARK } from './loopExpansion';

/**
 * Express route map: apps, routers, `use` mounts and the routes each one
 * defines. Syntax-only, name-based resolution:
 *
 *  - A variable is an *app* when initialised with `express()`; a *router*
 *    when initialised with `express.Router(...)` / `Router(...)` (also
 *    `require('express').Router()`).
 *  - `X.get|post|put|delete|patch|options|head|all(path, ...handlers)` on a
 *    known app/router adds a route; `X.route(path).get(h).post(h)` chains
 *    are supported. Handler names are shown (identifiers, `obj.method`,
 *    `middleware()` calls); inline functions show as `(inline)`.
 *  - `X.use('/prefix', router)` mounts a router. The router may be a local
 *    variable, an import (default or named, ES or `require`) resolved to
 *    another scanned file, or an inline `require('./routes')`.
 *    Full paths are shown on a route only when its router has exactly one
 *    mount chain; otherwise the router-relative path is shown and mounts
 *    appear as labelled edges.
 *
 *  - Import aliases for the express module and `Router` are resolved
 *    (`import e from 'express'`, `{ Router as R }`, `const { Router } = require(..)`).
 *    Holders are scoped to their function, so equal names in different
 *    functions no longer collide.
 *  - Routers passed to functions: a call whose callee resolves to a scanned
 *    top-level function (`register(app)`, `require('./routes')(app)`, an
 *    imported function, `module.exports = (app) => {..}`) mounts each router
 *    argument onto the matching parameter, which becomes a holder inside that
 *    function (nested hand-offs are followed). Untyped JS is fine: only the
 *    call sites matter.
 *  - Factories: `const r = makeRouter()`, `app.use('/x', makeRouter())` and
 *    `app.use('/x', require('./x')())` use the router the function returns
 *    (`return router;`).
 *
 *  - Routers kept in class members: `router = Router()`, `this.app = express()`
 *    (property initialisers or constructor assignments) make `this.router` a
 *    holder per class, so `this.router.get(..)`, `this.app.use('/x', this.router)`,
 *    `app.use('/u', new UserRoutes().router)` and `const u = new UserRoutes();
 *    app.use('/u', u.router)` all resolve. Fastify, Koa and NestJS are in
 *    nodeFrameworkRoutes.ts.
 *
 *  NOT supported: Hapi, factories that build the router
 *  through other calls (only `return <variable>` is read), dynamically built paths, `app.use(arrayOfRouters)`,
 *  routes registered in loops or by scanning a directory (`readdirSync(..).forEach(require)`), routers held in anything but a class member, regex/array paths (shown as source text),
 *  and `app.use(path, (req,res)=>...)` inline sub-handlers as routes.
 */

const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const EXT_KIND: Record<string, ts.ScriptKind> = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };
const SUFFIXES = ['', '.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

interface Holder {
  id: string;
  file: string;
  varName: string;
  kind: 'app' | 'router';
  /** Overrides the default "router x<br/>file" label (function-parameter holders). */
  label?: string;
}

interface Route {
  holder: Holder;
  method: string;
  path: string;
  handlers: string[];
}

interface Mount {
  parent: Holder;
  prefix: string;
  child: Holder;
}

function resolveRel(from: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const j = posixPath.normalize(posixPath.join(posixPath.dirname(from), spec));
  for (const s of SUFFIXES) if (known.has(j + s)) return j + s;
  return null;
}

function strValue(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1);
  return null;
}

function joinPaths(a: string, b: string): string {
  const parts = [a, b].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

function handlerName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.getText();
  if (ts.isCallExpression(e)) return `${e.expression.getText()}()`;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return '(inline)';
  return e.getText().slice(0, 30);
}

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function analyze(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const holders = new Map<string, Holder>(); // unique id -> holder
  const scopeVars = new Map<ts.Node | string, Map<string, Holder>>(); // function node (or `top:<file>`) -> variable -> holder
  const exportsByFile = new Map<string, Map<string, string>>(); // file -> exportName ('default' | name) -> local var
  const importsByFile = new Map<string, Map<string, { target: string; imported: string }>>();
  const expressNames = new Map<string, Set<string>>(); // file -> local names bound to the express module
  const routerCtors = new Map<string, Set<string>>(); // file -> local names bound to express.Router
  const fnDefs = new Map<string, ts.FunctionLikeDeclaration>(); // `${file}::${name}` for top-level functions
  const anonDefault = new Map<string, ts.FunctionLikeDeclaration>(); // file -> function exported as default without a name
  const parsed: Array<{ path: string; sf: ts.SourceFile }> = [];
  /** Routers kept in class members (`router = Router()`, `this.app = express()`): class -> member -> holder. */
  const classFields = new Map<ts.Node, Map<string, Holder>>();
  const classesByName = new Map<string, ts.ClassLikeDeclaration[]>();
  const varClass = new Map<string, string>(); // `${file}::${variable}` -> class name, for `const u = new UserRoutes()`

  for (const f of files) {
    try {
      parsed.push({ path: f.path, sf: ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, EXT_KIND[posixPath.extname(f.path)] ?? ts.ScriptKind.TS) });
    } catch {
      continue;
    }
  }

  const topKey = (path: string) => `top:${path}`;
  const scopeOf = (path: string, node: ts.Node): ts.Node | string => {
    for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
    return topKey(path);
  };
  const declare = (path: string, name: string, at: ts.Node, kind: 'app' | 'router', scope: ts.Node | string, label?: string): Holder => {
    let id = `${path}::${name}`;
    if (holders.has(id)) id = `${id}@${at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1}`;
    for (let n = 2; holders.has(id); n++) id = `${path}::${name}@${n}`;
    const h: Holder = { id, file: path, varName: name, kind, label };
    holders.set(id, h);
    const vars = scopeVars.get(scope) ?? new Map<string, Holder>();
    scopeVars.set(scope, vars);
    vars.set(name, h);
    return h;
  };

  const requireSpec = (e: ts.Expression): string | null => {
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require') return strValue(e.arguments[0]);
    return null;
  };

  const initKind = (path: string, init: ts.Expression): 'app' | 'router' | null => {
    if (!ts.isCallExpression(init)) return null;
    const t = init.expression.getText();
    const names = expressNames.get(path);
    const ctors = routerCtors.get(path);
    if (t === 'express' || names?.has(t) || /^require\(\s*['"]express['"]\s*\)$/.test(t)) return 'app';
    if (/^(express\.Router|Router)$/.test(t) || ctors?.has(t) || /^require\(\s*['"]express['"]\s*\)\.Router$/.test(t)) return 'router';
    const dot = /^(\w+)\.Router$/.exec(t);
    if (dot && names?.has(dot[1])) return 'router';
    return null;
  };

  // Pass 0: which local names are the express module / express.Router in each file.
  for (const { path, sf } of parsed) {
    const names = new Set<string>();
    const ctors = new Set<string>();
    expressNames.set(path, names);
    routerCtors.set(path, ctors);
    const visit0 = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'express' && n.importClause) {
        if (n.importClause.name) names.add(n.importClause.name.text);
        const nb = n.importClause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 'Router') ctors.add(el.name.text);
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression) && n.moduleReference.expression.text === 'express') names.add(n.name.text);
      if (ts.isVariableDeclaration(n) && n.initializer && requireSpec(n.initializer) === 'express') {
        if (ts.isIdentifier(n.name)) names.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name) && (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text === 'Router') ctors.add(el.name.text);
        }
      }
      ts.forEachChild(n, visit0);
    };
    visit0(sf);
  }

  // Pass 1: holders, exports, imports, top-level functions.
  for (const { path, sf } of parsed) {
    const exp = new Map<string, string>();
    const imp = new Map<string, { target: string; imported: string }>();
    exportsByFile.set(path, exp);
    importsByFile.set(path, imp);

    const declareField = (cls: ts.ClassLikeDeclaration, field: string, at: ts.Node, kind: 'app' | 'router') => {
      const fields = classFields.get(cls) ?? new Map<string, Holder>();
      classFields.set(cls, fields);
      if (fields.has(field)) return;
      fields.set(field, declare(path, `${cls.name?.text ?? 'class'}.${field}`, at, kind, `class:${path}:${cls.name?.text ?? at.pos}`));
    };
    const visitTop = (n: ts.Node) => {
      if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name) classesByName.set(n.name.text, [...(classesByName.get(n.name.text) ?? []), n]);
      if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const cls = enclosingClass(n);
        const kind = cls ? initKind(path, n.initializer) : null;
        if (cls && kind) declareField(cls, n.name.text, n, kind);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const cls = enclosingClass(n);
        const kind = cls ? initKind(path, n.right) : null;
        if (cls && kind) declareField(cls, n.left.name.text, n, kind);
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isNewExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) varClass.set(`${path}::${n.name.text}`, n.initializer.expression.text);
      if (ts.isFunctionDeclaration(n) && n.name && n.body && n.parent === sf) fnDefs.set(`${path}::${n.name.text}`, n);
      if (ts.isFunctionDeclaration(n) && !n.name && n.body && n.parent === sf && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) anonDefault.set(path, n);
      if (ts.isExportAssignment(n) && !n.isExportEquals && (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))) anonDefault.set(path, n.expression);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (n.parent.parent.parent === sf && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) fnDefs.set(`${path}::${n.name.text}`, n.initializer);
        const kind = initKind(path, n.initializer);
        if (kind) declare(path, n.name.text, n, kind, scopeOf(path, n));
        const spec = requireSpec(n.initializer);
        const target = spec ? resolveRel(path, spec, known) : null;
        if (target) imp.set(n.name.text, { target, imported: 'default' });
      }
      if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
        const spec = requireSpec(n.initializer);
        const target = spec ? resolveRel(path, spec, known) : null;
        if (target) for (const el of n.name.elements) if (ts.isIdentifier(el.name)) imp.set(el.name.text, { target, imported: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text });
      }
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
        const target = resolveRel(path, n.moduleSpecifier.text, known);
        if (target) {
          if (n.importClause.name) imp.set(n.importClause.name.text, { target, imported: 'default' });
          const nb = n.importClause.namedBindings;
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imp.set(el.name.text, { target, imported: (el.propertyName ?? el.name).text });
        }
      }
      if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) exp.set('default', n.expression.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = n.left.getText();
        if (left === 'module.exports' && ts.isIdentifier(n.right)) exp.set('default', n.right.text);
        else if (left === 'module.exports' && (ts.isArrowFunction(n.right) || ts.isFunctionExpression(n.right))) anonDefault.set(path, n.right);
        else if (/^(module\.)?exports\.\w+$/.test(left) && ts.isIdentifier(n.right)) exp.set(left.split('.').pop()!, n.right.text);
        else if (/^(module\.)?exports\.\w+$/.test(left) && (ts.isArrowFunction(n.right) || ts.isFunctionExpression(n.right))) fnDefs.set(`${path}::exports.${left.split('.').pop()}`, n.right), exp.set(left.split('.').pop()!, `exports.${left.split('.').pop()}`);
      }
      if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) {
        for (const el of n.exportClause.elements) exp.set(el.name.text, (el.propertyName ?? el.name).text);
      }
      if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) exp.set(d.name.text, d.name.text);
      }
      if (ts.isFunctionDeclaration(n) && n.name && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exp.set(n.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : n.name.text, n.name.text);
      }
      ts.forEachChild(n, visitTop);
    };
    visitTop(sf);
  }

  const topVar = (path: string, name: string): Holder | undefined => scopeVars.get(topKey(path))?.get(name);

  function enclosingClass(n: ts.Node): ts.ClassLikeDeclaration | null {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p;
    return null;
  }
  /** Class an expression is an instance of: `this`, `new C()`, or a variable initialised with `new C()`. */
  const classOf = (path: string, e: ts.Expression): ts.ClassLikeDeclaration | null => {
    if (e.kind === ts.SyntaxKind.ThisKeyword) return enclosingClass(e);
    let name: string | undefined;
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) name = e.expression.text;
    else if (ts.isIdentifier(e)) name = varClass.get(`${path}::${e.text}`);
    if (!name) return null;
    const all = classesByName.get(name) ?? [];
    return all.find((c) => c.getSourceFile().fileName === path) ?? (all.length === 1 ? all[0] : null);
  };

  const moduleHolder = (path: string, spec: string): Holder | null => {
    const target = resolveRel(path, spec, known);
    const varName = target ? exportsByFile.get(target)?.get('default') : undefined;
    return target && varName ? topVar(target, varName) ?? null : null;
  };

  const holderFor = (path: string, expr: ts.Expression): Holder | null => {
    if (ts.isPropertyAccessExpression(expr)) {
      const cls = classOf(path, expr.expression);
      return cls ? classFields.get(cls)?.get(expr.name.text) ?? null : null;
    }
    if (ts.isIdentifier(expr)) {
      for (let p: ts.Node | undefined = expr.parent; p; p = p.parent) {
        const h = scopeVars.get(p)?.get(expr.text);
        if (h) return h;
      }
      const local = topVar(path, expr.text);
      if (local) return local;
      const imp = importsByFile.get(path)?.get(expr.text);
      if (imp) {
        const varName = exportsByFile.get(imp.target)?.get(imp.imported);
        return varName ? topVar(imp.target, varName) ?? null : null;
      }
      return null;
    }
    const spec = requireSpec(expr);
    if (spec) return moduleHolder(path, spec);
    if (ts.isCallExpression(expr)) {
      // factory call: `makeRouter()` / `require('./api')()` returns the router the function builds
      for (const fn of calleeFns(path, expr.expression)) {
        const h = fnReturns(fn);
        if (h) return h;
      }
    }
    return null;
  };

  /** Functions a call's callee may refer to: a local/imported top-level function, or `require('./x')` of a module whose default export is a function. */
  function calleeFns(path: string, callee: ts.Expression): ts.FunctionLikeDeclaration[] {
    const byExport = (target: string, name: string): ts.FunctionLikeDeclaration | undefined => {
      const local = exportsByFile.get(target)?.get(name);
      return (local ? fnDefs.get(`${target}::${local}`) : undefined) ?? (name === 'default' ? anonDefault.get(target) : undefined);
    };
    if (ts.isIdentifier(callee)) {
      const own = fnDefs.get(`${path}::${callee.text}`);
      if (own) return [own];
      const imp = importsByFile.get(path)?.get(callee.text);
      const hit = imp ? byExport(imp.target, imp.imported) : undefined;
      return hit ? [hit] : [];
    }
    const spec = requireSpec(callee);
    if (spec) {
      const target = resolveRel(path, spec, known);
      const hit = target ? byExport(target, 'default') : undefined;
      return hit ? [hit] : [];
    }
    return [];
  }

  /** The router a function returns (`return router;` or an expression-bodied arrow returning an identifier). */
  function fnReturns(fn: ts.FunctionLikeDeclaration): Holder | undefined {
    const path = fn.getSourceFile().fileName;
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return holderFor(path, fn.body) ?? undefined;
    let found: Holder | undefined;
    const visitRet = (n: ts.Node) => {
      if (found || (n !== fn && isFunctionLike(n))) return;
      if (ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression)) found = holderFor(path, n.expression) ?? undefined;
      ts.forEachChild(n, visitRet);
    };
    if (fn.body) visitRet(fn.body);
    return found;
  }

  const routes: Route[] = [];
  const mounts: Mount[] = [];

  // Pass 1b (repeated so chains of calls resolve): `const r = makeRouter()` aliases, and arguments bound to the
  // parameters of the function they are passed to (`require('./routes')(app)`, `register(app)`).
  const boundCalls = new Set<string>();
  const fnLabel = (fn: ts.FunctionLikeDeclaration): string => {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    return 'function';
  };
  for (let round = 0; round < 4; round++) {
    for (const { path, sf } of parsed) {
      const visit1 = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
          const scope = scopeOf(path, n);
          if (!scopeVars.get(scope)?.has(n.name.text)) {
            const h = holderFor(path, n.initializer);
            if (h) {
              const vars = scopeVars.get(scope) ?? new Map<string, Holder>();
              scopeVars.set(scope, vars);
              vars.set(n.name.text, h);
            }
          }
        }
        if (ts.isCallExpression(n)) {
          const fns = calleeFns(path, n.expression);
          for (const fn of fns) {
            fn.parameters.forEach((param, i) => {
              const arg = n.arguments[i];
              if (!arg || !ts.isIdentifier(param.name)) return;
              const key = `${path}@${n.getStart()}#${i}`;
              if (boundCalls.has(key)) return;
              const parent = holderFor(path, arg);
              if (!parent) return;
              boundCalls.add(key);
              const fnPath = fn.getSourceFile().fileName;
              const existing = scopeVars.get(fn)?.get(param.name.text);
              const child =
                existing ?? declare(fnPath, param.name.text, param, 'router', fn, `router ${param.name.text}<br/>${fnLabel(fn)} · ${fnPath}`);
              if (child.id !== parent.id) mounts.push({ parent, prefix: '', child });
            });
          }
        }
        ts.forEachChild(n, visit1);
      };
      visit1(sf);
    }
  }


  // Resolves `X.route(p).get(h).post(h)` chains to the base holder and path.
  const chainBase = (path: string, expr: ts.Expression): { holder: Holder; path: string } | null => {
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const pa = expr.expression;
      if (pa.name.text === 'route' && (ts.isIdentifier(pa.expression) || ts.isPropertyAccessExpression(pa.expression))) {
        const h = holderFor(path, pa.expression);
        const p = strValue(expr.arguments[0]);
        return h && p !== null ? { holder: h, path: p } : null;
      }
      if (VERBS.has(pa.name.text)) return chainBase(path, pa.expression);
    }
    return null;
  };

  /** `require(expr)` evaluated under a loop's bindings, or `r.router` / `r` bound to an expression of the loop's array. */
  const holderIn = (path: string, expr: ts.Expression, env: Env): Holder | null => {
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require' && expr.arguments.length === 1) {
      const spec = evalString(expr.arguments[0], env);
      return spec !== null ? moduleHolder(path, spec) : null;
    }
    if (ts.isIdentifier(expr) && env.has(expr.text)) {
      const b = env.get(expr.text)!;
      return typeof b === 'string' ? null : holderFor(path, b);
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && env.has(expr.expression.text)) {
      const b = env.get(expr.expression.text)!;
      if (typeof b === 'string' || !ts.isObjectLiteralExpression(b)) return null;
      const v = propertyOf(b, expr.name.text);
      return v ? holderFor(path, v) : null;
    }
    return holderFor(path, expr);
  };

  const handledInLoop = new WeakSet<ts.Node>();
  /**
   * Routes registered in a loop over a literal array, or over the files of a directory that is read with
   * `readdirSync` (every scanned file in that folder is assumed to be loaded). Returns true when anything was expanded.
   */
  const expandLoop = (path: string, sf: ts.SourceFile, n: ts.Node): void => {
    const loop = asLoop(n);
    if (!loop) return;
    let items: Array<string | ts.Expression> | null = literalElements(sf, loop.iterable);
    if (!items) {
      const dirExpr = readdirTarget(loop.iterable);
      const dir = dirExpr ? evalString(dirExpr, new Map()) : null;
      if (dir !== null && (dir.startsWith(DIR_MARK) || dir.startsWith('.'))) items = filesInDir(known, posixPath.join(posixPath.dirname(path), dir));
    }
    if (!items || items.length === 0 || items.length > 200) return;
    const calls: ts.CallExpression[] = [];
    const find = (c: ts.Node) => {
      if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && (c.expression.name.text === 'use' || VERBS.has(c.expression.name.text))) calls.push(c);
      ts.forEachChild(c, find);
    };
    find(loop.body);
    for (const c of calls) {
      const pa = c.expression as ts.PropertyAccessExpression;
      const target = pa.expression;
      if (!(ts.isIdentifier(target) || ts.isPropertyAccessExpression(target))) continue;
      const parent = holderFor(path, target);
      if (!parent) continue;
      let expanded = false;
      for (const item of items) {
        const env: Env = new Map([[loop.param, item]]);
        if (pa.name.text === 'use') {
          const prefix = evalString(c.arguments[0], env);
          const rest = prefix !== null ? c.arguments.slice(1) : c.arguments;
          for (const a of rest) {
            const child = holderIn(path, a, env);
            if (child && child.id !== parent.id) {
              mounts.push({ parent, prefix: prefix ?? '', child });
              expanded = true;
            }
          }
        } else {
          const p = evalString(c.arguments[0], env);
          if (p === null) continue;
          routes.push({ holder: parent, method: pa.name.text.toUpperCase(), path: p, handlers: c.arguments.slice(1).map(handlerName) });
          expanded = true;
        }
      }
      if (expanded) handledInLoop.add(c);
    }
  };

  // Pass 2: routes and mounts.
  for (const { path, sf } of parsed) {
    const visit = (n: ts.Node) => {
      expandLoop(path, sf, n);
      if (handledInLoop.has(n)) {
        ts.forEachChild(n, visit);
        return;
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const target = n.expression.expression;
        if (VERBS.has(method)) {
          const base = ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) ? holderFor(path, target) : null;
          if (base) {
            const first = n.arguments[0];
            const p = strValue(first) ?? (first ? first.getText().slice(0, 40) : '');
            routes.push({ holder: base, method: method.toUpperCase(), path: p, handlers: n.arguments.slice(1).map(handlerName) });
          } else {
            const chain = chainBase(path, target);
            if (chain) routes.push({ holder: chain.holder, method: method.toUpperCase(), path: chain.path, handlers: n.arguments.map(handlerName) });
          }
        } else if (method === 'use' && (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target))) {
          const parent = holderFor(path, target);
          if (parent) {
            const prefix = strValue(n.arguments[0]);
            const rest = prefix !== null ? n.arguments.slice(1) : n.arguments;
            for (const a of rest) {
              const child = holderFor(path, a);
              if (child && child.id !== parent.id) mounts.push({ parent, prefix: prefix ?? '', child });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Full-path prefixes per holder via DFS from unmounted roots (cycle-safe).
  const incoming = new Map<string, Mount[]>();
  for (const m of mounts) incoming.set(m.child.id, [...(incoming.get(m.child.id) ?? []), m]);
  const prefixesOf = (h: Holder, stack: Set<string>): string[] => {
    const ins = incoming.get(h.id);
    if (!ins || ins.length === 0) return [''];
    if (stack.has(h.id)) return [''];
    stack.add(h.id);
    const out: string[] = [];
    for (const m of ins) for (const pp of prefixesOf(m.parent, stack)) out.push(m.prefix ? joinPaths(pp, m.prefix) : pp);
    stack.delete(h.id);
    return [...new Set(out)];
  };

  const used = new Set<string>();
  for (const r of routes) used.add(r.holder.id);
  for (const m of mounts) {
    used.add(m.parent.id);
    used.add(m.child.id);
  }

  const nodes: CodeGraph['nodes'] = [];
  const edges: CodeGraph['edges'] = [];
  for (const h of holders.values()) {
    if (!used.has(h.id)) continue;
    nodes.push({ id: h.id, label: h.label ?? `${h.kind === 'app' ? 'app' : 'router'} ${h.varName}<br/>${h.file}`, kind: h.kind });
  }
  for (const m of mounts) edges.push({ from: m.parent.id, to: m.child.id, label: m.prefix || '/', kind: 'mount' });

  let rn = 0;
  for (const r of routes) {
    const prefixes = prefixesOf(r.holder, new Set());
    const shown = prefixes.length === 1 && prefixes[0] ? joinPaths(prefixes[0], r.path || '/') : r.path || '/';
    const id = `${r.holder.id}::route${rn++}`;
    const handlers = r.handlers.length ? `<br/>${r.handlers.join(' → ')}` : '';
    nodes.push({ id, label: `${r.method} ${shown}${handlers}`, kind: 'route' });
    edges.push({ from: r.holder.id, to: id, kind: 'route' });
  }
  return { nodes, edges };
}

export const expressRouteAnalyzer: CodeAnalyzer = {
  id: 'express-routes',
  displayName: 'Express Routes',
  supportedExtensions: ['.ts', '.js', '.mjs', '.cjs'],
  analyze,
};
