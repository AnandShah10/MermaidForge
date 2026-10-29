import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { assembleRouteGraph, matchClose, RouteEntry, RouteHolder, RouteMount, splitArgs } from '../common/routeUtils';
import { parseSwift, SwiftFile, SwiftMethod } from './swiftAnalyzer';

/**
 * Web-route maps for Swift: the Vapor routing DSL. Syntax-only, read from scrubbed text with the original beside it
 * for string literals.
 *
 * Builders: a parameter of type `Application` is an app; one of type `RoutesBuilder` / `Routes` / `RouteCollection`
 * (or the `routes` of a `boot(routes:)`) is a router. Verbs on a builder register routes: `get`, `post`, `put`,
 * `patch`, `delete`, `head`, `options`, `on(.POST, ..)`, `webSocket(..)`, with path components as string literals
 * (`"users", ":id"`, a literal may itself hold `/`; `:param`, `*`, `**` kept as written; `.anything` / `.catchall`
 * become `*` / `**`) and a handler as `use: handler` (named `Type.handler` when the enclosing type has it) or a
 * trailing closure (`(inline)`). Grouping: `let api = app.grouped("api", "v1")`, `app.group("api") { api in .. }`,
 * chains such as `app.grouped("api").grouped(Auth()).get("x")`; non-literal arguments of `grouped` / `group` are
 * middleware and ignored. Mounting: `try app.register(collection: TodoController())` (also through a `let` bound to
 * `TodoController()`) mounts the controller's `boot(routes:)` builder under the receiver and its prefix, and a call
 * such as `try routes(app)` / `try registerRoutes(on: app)` hands the builder to the scanned function's matching
 * parameter. Blocks nested in `do` / `if` / `for` are read once (loops are not expanded).
 *
 * NOT handled: paths held in variables or built by interpolation (shown as `(dynamic)`), `PathComponent` values
 * other than `.anything` / `.catchall`, `RouteCollection` types registered through generic helpers, builders stored in
 * properties (`self.routes`), `Routes` extended by user helpers that add routes, `app.routes.all` introspection,
 * Hummingbird / Kitura / Perfect / SwiftNIO-only servers, routes added by Fluent/Leaf/OpenAPI generators,
 * `app.middleware` / `app.group` calls that do not use a literal, and multi-module resolution (type and function names
 * are matched by simple name across the scan).
 */

const VERBS = new Map<string, string>([
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['delete', 'DELETE'], ['head', 'HEAD'], ['options', 'OPTIONS'], ['webSocket', 'WS'],
]);
const BUILDER_TYPES = /^(?:Application|RoutesBuilder|Routes|RouteCollection|Vapor\.Application)$/;

interface Holder extends RouteHolder {
  /** Path accumulated by `grouped` / `group` relative to its parent, '' for roots. */
  prefix: string;
}

interface Op {
  name: string;
  /** Argument list range (exclusive of parens), or null when called without parens. */
  args: [number, number] | null;
  closure: [number, number] | null;
}

function skipWs(s: string, i: number, to: number): number {
  while (i < to && /\s/.test(s[i])) i++;
  return i;
}

/** Splits [from,to) into statements: newline at depth 0 unless the next line continues the chain (`.x`). */
function statements(s: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  const push = (end: number) => {
    if (s.slice(start, end).trim()) out.push([start, end]);
  };
  for (let i = from; i < to; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ';') {
      push(i);
      start = i + 1;
    } else if (depth === 0 && c === '\n') {
      const j = skipWs(s, i + 1, to);
      if (s[j] === '.' && s[j + 1] !== '.') continue; // leading-dot continuation
      push(i);
      start = i + 1;
    }
  }
  push(to);
  return out;
}

/** Parses `base.op(args){closure}.op2(..)` from `s[from,to)`. Returns null when it is not a plain chain. */
function parseChain(s: string, from: number, to: number): { base: string; ops: Op[] } | null {
  let i = skipWs(s, from, to);
  for (;;) {
    const m = /^(?:try[?!]?|await)\s+/.exec(s.slice(i, to));
    if (!m) break;
    i += m[0].length;
  }
  const b = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, to));
  if (!b) return null;
  const base = b[0];
  i += base.length;
  const ops: Op[] = [];
  // Allow a call on the base itself: `routes(app)` / `Foo()` are handled by the caller; here only member chains.
  for (;;) {
    i = skipWs(s, i, to);
    if (i >= to) break;
    if (s[i] === '?' || s[i] === '!') i++;
    i = skipWs(s, i, to);
    if (s[i] !== '.') return ops.length || i >= to ? { base, ops } : null;
    i = skipWs(s, i + 1, to);
    const n = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, to));
    if (!n) return null;
    i += n[0].length;
    let args: [number, number] | null = null;
    if (s[i] === '(') {
      const close = matchClose(s, i);
      if (close < 0 || close >= to) return null;
      args = [i + 1, close];
      i = close + 1;
    }
    let closure: [number, number] | null = null;
    const k = skipWs(s, i, to);
    if (s[k] === '{') {
      const close = matchClose(s, k);
      if (close < 0 || close >= to) return null;
      closure = [k + 1, close];
      i = close + 1;
    }
    ops.push({ name: n[0], args, closure });
  }
  return { base, ops };
}

/** Literal string value of an argument, or null when it is not a plain literal. */
function literal(orig: string, a: number, b: number): { value: string; dynamic: boolean } | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(orig.slice(a, b).trim());
  return m ? { value: m[1], dynamic: /\\\(/.test(m[1]) } : null;
}

interface Arg {
  label: string | null;
  a: number;
  b: number;
}

function argList(orig: string, scr: string, range: [number, number] | null): Arg[] {
  if (!range) return [];
  return splitArgs(scr, orig, range[0], range[1]).map(([a, b]) => {
    const m = /^\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(scr.slice(a, b));
    return m ? { label: m[1], a: a + m[0].length, b } : { label: null, a, b };
  });
}

/** Path segments contributed by the arguments of a verb / `grouped` / `group` call. Middleware-like arguments are skipped. */
function pathParts(orig: string, args: Arg[], inVerb: boolean): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.label !== null && arg.label !== 'path') continue;
    const o = orig.slice(arg.a, arg.b).trim();
    const lit = literal(orig, arg.a, arg.b);
    if (lit) {
      if (lit.dynamic) out.push('(dynamic)');
      else out.push(...lit.value.split('/').filter(Boolean));
      continue;
    }
    if (/^\.anything$/.test(o)) out.push('*');
    else if (/^\.catchall$/.test(o)) out.push('**');
    else if (/^\.(?:get|post|put|patch|delete|head|options|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(o) && inVerb) continue; // method of `on(.POST, ..)`
    else if (inVerb && /^[A-Za-z_][\w.]*$/.test(o) && arg.label === null) out.push('(dynamic)');
    // anything else (a call like `Auth()`, a closure) is middleware
  }
  return out;
}

interface FnInfo {
  file: SwiftFile;
  path: string;
  m: SwiftMethod;
  /** Parameter name -> holder for builder-typed parameters. */
  holders: Map<string, Holder>;
  /** Builder parameters in declaration order (for positional hand-off). */
  order: Array<Holder | null>;
}

function analyze(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, text: f.text, swift: parseSwift(f.text) }));
  const holders = new Map<string, Holder>();
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];

  const mk = (id: string, label: string, kind: 'app' | 'router', prefix = ''): Holder => {
    let h = holders.get(id);
    if (!h) {
      h = { id, label, kind, prefix };
      holders.set(id, h);
    }
    return h;
  };
  const mount = (parent: Holder, child: Holder, prefix: string) => {
    if (parent.id !== child.id) mounts.push({ parent, child, prefix });
  };

  // Every function that takes a builder: its parameters become holders.
  const fnInfos: FnInfo[] = [];
  const fnsByName = new Map<string, FnInfo[]>();
  const collections = new Map<string, FnInfo>(); // type name -> its boot(routes:) function
  for (const { path, swift } of parsed) {
    const all: SwiftMethod[] = [...swift.functions, ...swift.types.flatMap((t) => t.methods)];
    for (const m of all) {
      if (!m.hasBody) continue;
      const map = new Map<string, Holder>();
      const order: Array<Holder | null> = [];
      for (const p of m.params) {
        const t = p.type.replace(/\b(?:any|some|inout)\b\s*/g, '').replace(/[?!]+$/g, '').trim();
        if (!BUILDER_TYPES.test(t)) {
          order.push(null);
          continue;
        }
        const id = `${path}::${m.owner ? m.owner + '.' : ''}${m.name}(${p.name})`;
        const isApp = /Application$/.test(t);
        const h = mk(id, isApp ? `app<br/>${m.owner ? m.owner + '.' : ''}${m.name}()` : m.name === 'boot' && m.owner ? `${m.owner}.boot` : `routes<br/>${m.owner ? m.owner + '.' : ''}${m.name}()`, isApp ? 'app' : 'router');
        map.set(p.name, h);
        order.push(h);
      }
      const info: FnInfo = { file: swift, path, m, holders: map, order };
      fnInfos.push(info);
      if (m.owner && m.name === 'boot' && map.size) collections.set(m.owner, info);
      fnsByName.set(m.name, [...(fnsByName.get(m.name) ?? []), info]);
    }
  }
  const handlerOf = (owner: string | null, text: string): string => {
    let t = text.trim().replace(/\s+/g, '');
    t = t.replace(/\(.*$/, '').replace(/^self\./, '');
    if (/^[A-Za-z_]\w*$/.test(t)) return owner && fnInfos.some((f) => f.m.owner === owner && f.m.name === t) ? `${owner}.${t}` : owner && /^(?:index|create|show|update|delete|read|list)$/.test(t) ? `${owner}.${t}` : t;
    return t.length > 40 ? t.slice(0, 40) : t || '(inline)';
  };

  for (const { path, text, swift } of parsed) {
    const scr = swift.scrubbed;
    const orig = text;
    const infos = fnInfos.filter((f) => f.file === swift);
    // `let app = Application(...)` / `try await Application.make(..)` in top-level code is an app root.
    const rootApps = new Map<string, Holder>();
    for (const m of scr.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\s*(?::\s*Application\s*)?=\s*(?:try\s+)?(?:await\s+)?Application\b/g)) {
      rootApps.set(m[1], mk(`${path}::${m[1]}`, `app ${m[1]}<br/>${path}`, 'app'));
    }

    const processBlock = (from: number, to: number, scope: Map<string, Holder>, owner: string | null, fnLabel: string, depth: number) => {
      if (depth > 12) return;
      const ctrlVars = new Map<string, string>(); // let todos = TodoController()
      for (const [a, b] of statements(scr, from, to)) {
        const stmtScr = scr.slice(a, b);
        // `let x = <chain>` / `var x = <chain>`
        const decl = /^\s*(?:try[?!]?\s+|await\s+)*(?:let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)\s*/.exec(stmtScr);
        const exprFrom = decl ? a + decl[0].length : a;
        const ctor = decl ? /^\s*(?:try[?!]?\s+)?([A-Z]\w*)\s*\(\s*\)\s*$/.exec(scr.slice(exprFrom, b)) : null;
        if (decl && ctor) {
          ctrlVars.set(decl[1], ctor[1]);
          continue;
        }
        const chain = parseChain(scr, exprFrom, b);
        if (chain && scope.has(chain.base) && chain.ops.length) {
          let current = scope.get(chain.base)!;
          let prefix: string[] = [];
          let consumed = true;
          for (const op of chain.ops) {
            const args = argList(orig, scr, op.args);
            const verb = VERBS.get(op.name);
            if (op.name === 'grouped' || op.name === 'group') {
              prefix = [...prefix, ...pathParts(orig, args, false)];
              if (op.name === 'group' && op.closure) {
                const params = /^\s*\(?\s*([A-Za-z_$][\w$]*)(?:\s*,[^)]*)?\)?\s*(?:->[^{]*)?\bin\b/.exec(scr.slice(op.closure[0], op.closure[1]));
                const name = params ? params[1] : '$0';
                const child = mk(`${path}::${fnLabel}::${name}@${op.closure[0]}`, `group ${prefix.length ? '/' + prefix.join('/') : name}<br/>${path}`, 'router');
                mount(current, child, prefix.length ? '/' + prefix.join('/') : '');
                const inner = new Map(scope);
                inner.set(name, child);
                processBlock(op.closure[0] + (params ? params[0].length : 0), op.closure[1], inner, owner, fnLabel, depth + 1);
                consumed = true;
                prefix = [];
                break;
              }
              continue;
            }
            if (verb || op.name === 'on') {
              let method = verb ?? 'ANY';
              let handler = '(inline)';
              if (op.name === 'on') {
                const first = args[0] ? orig.slice(args[0].a, args[0].b).trim() : '';
                const mm = /^\.([A-Za-z]+)$/.exec(first);
                if (mm) method = mm[1].toUpperCase();
              }
              for (const arg of args) if (arg.label === 'use') handler = handlerOf(owner, orig.slice(arg.a, arg.b));
              const own = pathParts(orig, op.name === 'on' ? args.slice(1) : args, true);
              const full = [...prefix, ...own];
              routes.push({ holder: current, method, path: full.length ? '/' + full.join('/') : '', handler });
              break;
            }
            if (op.name === 'register' && args[0]?.label === 'collection') {
              const expr = orig.slice(args[0].a, args[0].b).trim();
              const tm = /^(?:try\s+)?([A-Z]\w*)\s*\(/.exec(expr);
              const typeName = tm ? tm[1] : ctrlVars.get(expr.replace(/^try\s+/, '')) ?? null;
              const target = typeName ? collections.get(typeName) : undefined;
              const bootHolder = target ? [...target.holders.values()][0] : undefined;
              if (bootHolder) mount(current, bootHolder, prefix.length ? '/' + prefix.join('/') : '');
              break;
            }
            // unknown member (e.g. `app.logger.info(..)`, `req.parameters`): not a route statement
            consumed = false;
            break;
          }
          if (!consumed) continue;
          // `let api = app.grouped(..)`: a new builder bound to the variable.
          if (decl && chain.ops.length && chain.ops.every((o) => o.name === 'grouped')) {
            const pfx = prefix.length ? '/' + prefix.join('/') : '';
            const child = mk(`${path}::${fnLabel}::${decl[1]}@${a}`, `${decl[1]} ${pfx || ''}<br/>${path}`, 'router');
            mount(current, child, pfx);
            scope.set(decl[1], child);
          }
          continue;
        }
        // Hand-off: `try routes(app)`, `try registerRoutes(on: app)`, `try app.register(collection: X())` handled above.
        const call = /^\s*(?:try[?!]?\s+|await\s+)*([A-Za-z_]\w*)\s*\(/.exec(stmtScr);
        if (call && fnsByName.has(call[1])) {
          const open = a + call[0].length - 1;
          const close = matchClose(scr, open);
          if (close > 0 && close <= b) {
            const args = argList(orig, scr, [open + 1, close]);
            for (const target of fnsByName.get(call[1])!) {
              args.forEach((arg, i) => {
                const nm = orig.slice(arg.a, arg.b).trim();
                const parent = scope.get(nm);
                const child = target.order[i];
                if (parent && child) mount(parent, child, '');
              });
            }
          }
        }
        // Recurse into plain blocks (`do { .. }`, `if .. { .. }`, closures of other calls) with the same scope.
        const blocks: Array<[number, number]> = [];
        let depthB = 0;
        let bs = -1;
        for (let i = a; i < b; i++) {
          if (scr[i] === '{') {
            if (depthB === 0) bs = i;
            depthB++;
          } else if (scr[i] === '}') {
            depthB--;
            if (depthB === 0 && bs >= 0) blocks.push([bs + 1, i]);
          }
        }
        for (const [x, y] of blocks) processBlock(x, y, new Map(scope), owner, fnLabel, depth + 1);
      }
    };

    // Function bodies with builder parameters (and top-level code with root apps).
    const bodyOf = (m: SwiftMethod) => [m.bodyStart + 1, m.bodyEnd] as [number, number];
    for (const info of infos) {
      const scope = new Map(info.holders);
      for (const [k, v] of rootApps) scope.set(k, v);
      const [x, y] = bodyOf(info.m);
      processBlock(x, y, scope, info.m.owner, `${info.m.owner ? info.m.owner + '.' : ''}${info.m.name}`, 0);
    }
    // Other functions: builders created from a root app (`configure`, `main`) or top-level script code.
    if (rootApps.size) {
      for (const m of [...swift.functions, ...swift.types.flatMap((t) => t.methods)]) {
        if (!m.hasBody || infos.some((f) => f.m === m)) continue;
        const [x, y] = bodyOf(m);
        processBlock(x, y, new Map(rootApps), m.owner, `${m.owner ? m.owner + '.' : ''}${m.name}`, 0);
      }
    }
  }

  return assembleRouteGraph(holders.values(), routes, mounts);
}

export const swiftRouteAnalyzer: CodeAnalyzer = {
  id: 'swift-routes',
  displayName: 'Vapor Routes (Swift)',
  supportedExtensions: ['.swift'],
  analyze,
};

export { analyze as analyzeSwiftRoutes };
