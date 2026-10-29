import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { scrub } from '../common/scrubber';
import { stripGoComments } from './goAnalyzer';
import { RouteHolder as Holder, RouteEntry as Route, RouteMount as Mount, assembleRouteGraph, matchClose, splitArgs } from '../common/routeUtils';

/**
 * Go web-route map: apps/routers, groups/mounts and the routes each defines,
 * for net/http (`http.HandleFunc`, `http.NewServeMux`, including Go 1.22
 * "GET /path" patterns), gin, echo, fiber, chi and gorilla/mux. Syntax-only
 * and name-based, like the Express and Python route analyzers: statements are
 * read from text whose strings/comments are blanked, and string literals are
 * then read from the comment-stripped original at the same offsets.
 *
 *  - Holders: `x := gin.Default()|gin.New()|echo.New()|fiber.New()|
 *    chi.NewRouter()|chi.NewMux()|mux.NewRouter()|http.NewServeMux()|
 *    httprouter.New()` (app) and `g := x.Group("/p")` (router, mounted on x).
 *    Bare `http.HandleFunc/Handle` register on an implicit default mux.
 *  - Routes: `x.GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|CONNECT|TRACE("/p", ..,
 *    handler)`, `x.Any(..)`, chi's `x.Get|Post|...`, and `x.Handle|HandleFunc(
 *    "/p", h)` (a leading "METHOD " in the pattern is honoured; gorilla's
 *    trailing `.Methods("GET","POST")` creates one route per method).
 *    The handler shown is the last argument.
 *  - Mounts: `x.Group("/p")` and chi/gorilla `x.Mount("/p", sub)` when `sub`
 *    is a known holder. Full paths are shown on a route only when its holder
 *    has exactly one mount chain; otherwise the router-relative path is shown.
 *
 *  - Import aliases (`g "github.com/gin-gonic/gin"`, versioned paths) are
 *    resolved per file.
 *  - Function parameters of a router type (`router *gin.RouterGroup`,
 *    `r chi.Router`, `e *echo.Echo`, `app *fiber.App`, ...) are router holders
 *    scoped to that function (and to func literals, so chi's
 *    `r.Route("/p", func(r chi.Router){ .. })` and `r.Group(func(r chi.Router){..})`
 *    work). A call `pkg.Register(v1.Group("/users"))` / `register(router)`
 *    mounts the argument onto the callee's parameter, with the callee chosen by
 *    package-directory name, same directory, or a name that is unique. Several
 *    call sites mount the same function more than once, so its routes show
 *    router-relative paths. Variables of the same name in different functions
 *    no longer collide.
 *
 *  - Functions that return a router (`func NewRouter() *gin.Engine { r :=
 *    gin.New(); ..; return r }`): `x := NewRouter()`, `x := routes.New()` and
 *    `r.Mount("/admin", adminRouter())` use that router. The callee is chosen
 *    like for parameters; the first `return <variable>` of a known router wins.
 *
 *  - Struct fields: `type Server struct { router *gin.Engine }` makes
 *    `s.router` (inside methods of Server, by receiver name) a router, shared by
 *    all methods, including `g := s.router.Group("/api")` and `register(s.router)`;
 *    an embedded router (`*chi.Mux`) makes the receiver itself the router.
 *    The field is found by its declared type, so how it is assigned (a
 *    constructor, another package) does not matter.
 *
 *  NOT supported: routers reached through other expressions (`app.Server.Router`, map/slice elements), routes registered in loops, middleware chains, gorilla
 *  `.PathPrefix` subrouters, and non-literal paths (shown as source text).
 *  Calls through interfaces or function values are not followed. Input that
 *  does not parse never throws; the affected statement is skipped.
 */

const CTORS = new Set([
  'gin.Default',
  'gin.New',
  'echo.New',
  'fiber.New',
  'chi.NewRouter',
  'chi.NewMux',
  'mux.NewRouter',
  'http.NewServeMux',
  'httprouter.New',
]);
const VERBS = new Map<string, string>();
for (const v of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'CONNECT', 'TRACE']) {
  VERBS.set(v, v);
  VERBS.set(v[0] + v.slice(1).toLowerCase(), v);
}
VERBS.set('Any', 'ANY');
const HANDLE = new Set(['Handle', 'HandleFunc']);

function literal(code: string, a: number, b: number): string | null {
  const m = /^\s*(?:"((?:[^"\\\n]|\\.)*)"|`([^`]*)`)\s*$/.exec(code.slice(a, b));
  return m ? (m[1] ?? m[2] ?? '') : null;
}

function shortText(code: string, a: number, b: number): string {
  const t = code.slice(a, b).replace(/\s+/g, ' ').trim();
  if (/^func\b/.test(t)) return '(inline)';
  return t.length > 40 ? t.slice(0, 37) + '...' : t;
}

/** Canonical package identifiers by import path (last non-version segment otherwise). */
const PACKAGES: Array<[RegExp, string]> = [
  [/(^|\/)gin-gonic\/gin$/, 'gin'],
  [/(^|\/)labstack\/echo(\/v\d+)?$/, 'echo'],
  [/(^|\/)gofiber\/fiber(\/v\d+)?$/, 'fiber'],
  [/(^|\/)go-chi\/chi(\/v\d+)?$/, 'chi'],
  [/(^|\/)gorilla\/mux$/, 'mux'],
  [/(^|\/)julienschmidt\/httprouter$/, 'httprouter'],
  [/^net\/http$/, 'http'],
];
/** Types that carry routes. A function parameter of one of these types is a router the caller supplies. */
const ROUTER_TYPES = new Map<string, 'app' | 'router'>([
  ['gin.Engine', 'app'], ['gin.RouterGroup', 'router'], ['gin.IRouter', 'router'], ['gin.IRoutes', 'router'],
  ['echo.Echo', 'app'], ['echo.Group', 'router'],
  ['fiber.App', 'app'], ['fiber.Router', 'router'],
  ['chi.Mux', 'app'], ['chi.Router', 'router'],
  ['mux.Router', 'router'],
  ['http.ServeMux', 'app'],
  ['httprouter.Router', 'app'],
]);

interface Scope {
  key: string;
  start: number;
  end: number;
  vars: Map<string, Holder>;
  /** Method receiver (`s` and `Server` in `func (s *Server) routes()`), for struct-field routers. */
  recv?: { name: string | null; type: string };
}
interface FuncDef {
  dir: string;
  /** One entry per declared parameter, in order; a Holder where the parameter is a router. */
  params: Array<Holder | null>;
}
interface FileCtx {
  path: string;
  dir: string;
  s: string;
  code: string;
  scopes: Scope[];
  pkgVars: Map<string, Holder>;
  canon: (ident: string) => string;
  declNames: Set<number>;
}

function importAliases(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const specs: string[] = [];
  for (const m of code.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) specs.push(...m[1].split('\n'));
  for (const m of code.matchAll(/^[ \t]*import\s+([^\n(]+)/gm)) specs.push(m[1]);
  for (const line of specs) {
    const m = /^\s*(?:([A-Za-z_]\w*|\.|_)\s+)?"([^"]+)"/.exec(line);
    if (!m) continue;
    const canonical = PACKAGES.find(([re]) => re.test(m[2]))?.[1];
    if (!canonical) continue;
    const local = m[1] ?? canonical;
    if (local === '_' || local === '.') continue;
    out.set(local, canonical);
  }
  return out;
}

function analyze(input: SourceFileInput[]): CodeGraph {
  const holders = new Map<string, Holder>();
  const routes: Route[] = [];
  const mounts: Mount[] = [];
  const ctxs: FileCtx[] = [];
  const funcDefs = new Map<string, FuncDef[]>();
  /** Router-typed struct fields (`Type.field`) and embedded routers (`Type.` + type name), shared by every method of the type. */
  const fields = new Map<string, Holder>();
  const embedded = new Map<string, Holder[]>();
  /** Named functions/methods with bodies, for resolving `x := NewRouter()` to the router that function returns. */
  const named = new Map<string, Array<{ ctx: FileCtx; sc: Scope }>>();

  const declare = (ctx: FileCtx, name: string, pos: number, kind: 'app' | 'router', what: string, owner?: Scope | null): Holder => {
    const sc = owner === undefined ? chain(ctx, pos)[0] ?? null : owner;
    let id = `${ctx.path}::${name}`;
    if (holders.has(id)) id = `${id}@${sc?.key ?? 'pkg'}`;
    for (let n = 2; holders.has(id); n++) id = `${ctx.path}::${name}@${sc?.key ?? 'pkg'}#${n}`;
    const h: Holder = { id, label: `${what} ${name}<br/>${ctx.path}`, kind };
    holders.set(id, h);
    (sc ? sc.vars : ctx.pkgVars).set(name, h);
    return h;
  };
  const chain = (ctx: FileCtx, pos: number): Scope[] => ctx.scopes.filter((sc) => sc.start <= pos && pos < sc.end).sort((x, y) => y.start - x.start);
  const resolve = (ctx: FileCtx, name: string, pos: number): Holder | undefined => {
    for (const sc of chain(ctx, pos)) {
      const h = sc.vars.get(name);
      if (h) return h;
    }
    return ctx.pkgVars.get(name);
  };
  /** `recv.field` where `recv` is the receiver of an enclosing method whose type has a router field. */
  const resolveField = (ctx: FileCtx, obj: string, field: string, pos: number): Holder | undefined => {
    for (const sc of chain(ctx, pos)) {
      if (sc.recv?.name === obj) return fields.get(`${sc.recv.type}.${field}`);
    }
    return undefined;
  };

  // ---- phase 0: struct types holding routers (`router *gin.Engine`, embedded `*chi.Mux`) ----
  for (const f of Array.isArray(input) ? input : []) {
    if (!f || typeof f.path !== 'string' || !/\.go$/.test(f.path) || /_test\.go$/.test(f.path)) continue;
    try {
      const text = typeof f.text === 'string' ? f.text : '';
      const s = scrub(text, 'go');
      const aliases = importAliases(stripGoComments(text));
      const canon = (id: string) => aliases.get(id) ?? id;
      for (const sm of s.matchAll(/\btype\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?struct\s*\{/g)) {
        const open = (sm.index ?? 0) + sm[0].length - 1;
        const close = matchClose(s, open);
        if (close < 0) continue;
        for (const rawLine of s.slice(open + 1, close).split(/[\n;]/)) {
          const line = rawLine.trim();
          const emb = /^[*]?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*$/.exec(line);
          const namedField = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+[*]?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*$/.exec(line);
          const mk = (field: string, pkg: string, typ: string) => {
            const kind = ROUTER_TYPES.get(`${canon(pkg)}.${typ}`);
            if (!kind) return null;
            const h: Holder = { id: `${f.path}::${sm[1]}.${field}`, label: `${kind === 'app' ? 'app' : 'router'} ${sm[1]}.${field}<br/>${f.path}`, kind };
            holders.set(h.id, h);
            return h;
          };
          if (emb) {
            const h = mk(emb[2], emb[1], emb[2]);
            if (h) embedded.set(sm[1], [...(embedded.get(sm[1]) ?? []), h]);
          } else if (namedField) {
            for (const fld of namedField[1].split(',').map((x) => x.trim())) {
              const h = mk(fld, namedField[2], namedField[3]);
              if (h) fields.set(`${sm[1]}.${fld}`, h);
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // ---- phase 1: per-file structure (imports, function scopes and router parameters, constructors, groups) ----
  for (const f of Array.isArray(input) ? input : []) {
    if (!f || typeof f.path !== 'string' || !/\.go$/.test(f.path) || /_test\.go$/.test(f.path)) continue;
    try {
      const text = typeof f.text === 'string' ? f.text : '';
      const s = scrub(text, 'go');
      const code = stripGoComments(text);
      const aliases = importAliases(code);
      const ctx: FileCtx = {
        path: f.path,
        dir: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
        s,
        code,
        scopes: [],
        pkgVars: new Map(),
        canon: (id) => aliases.get(id) ?? id,
        declNames: new Set(),
      };
      ctxs.push(ctx);

      // Function declarations, methods and literals with their parameters.
      const funcRe = /\bfunc\b\s*/g;
      let fm: RegExpExecArray | null;
      while ((fm = funcRe.exec(s))) {
        let i = fm.index + fm[0].length;
        let name: string | null = null;
        let recv: Scope['recv'];
        if (s[i] === '(') {
          // Either a method receiver `(r *T) Name(` or a literal's parameter list: look at what follows the group.
          const rc = matchClose(s, i);
          if (rc < 0) continue;
          const after = /^\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/.exec(s.slice(rc + 1, rc + 200));
          if (after) {
            const rm = /^\(\s*(?:([A-Za-z_]\w*)\s+)?\*?\s*([A-Za-z_]\w*)/.exec(s.slice(i, rc + 1));
            if (rm) recv = { name: rm[1] ?? null, type: rm[2] };
            name = after[1];
            ctx.declNames.add(rc + 1 + after[0].indexOf(after[1]));
            i = rc + 1 + after[0].length - 1;
          }
        } else {
          const nm = /^([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/.exec(s.slice(i, i + 200));
          if (!nm) continue;
          name = nm[1];
          ctx.declNames.add(i);
          i += nm[0].length - 1;
        }
        if (s[i] !== '(') continue;
        const pc = matchClose(s, i);
        if (pc < 0) continue;
        // Body: next `{` at depth 0 that does not open `interface{`/`struct{`.
        let j = pc + 1;
        let body = -1;
        for (let d = 0; j < s.length; j++) {
          const c = s[j];
          if (c === '(' || c === '[') d++;
          else if (c === ')' || c === ']') d--;
          else if (c === ';') break;
          else if (c === '{' && d <= 0) {
            if (/(?:interface|struct)\s*$/.test(s.slice(Math.max(pc + 1, j - 12), j))) {
              j = matchClose(s, j);
              if (j < 0) break;
              continue;
            }
            body = j;
            break;
          }
        }
        if (body < 0) continue;
        const end = matchClose(s, body);
        if (end < 0) continue;
        const sc: Scope = { key: name ?? `closure@${body}`, start: body, end, vars: new Map(), recv };
        ctx.scopes.push(sc);
        // `func (s *Server) routes()` where Server embeds a router: `s.GET(..)` registers on it.
        const embeddedRouter = recv?.name ? embedded.get(recv.type)?.[0] : undefined;
        if (recv?.name && embeddedRouter) sc.vars.set(recv.name, embeddedRouter);
        if (name) named.set(name, [...(named.get(name) ?? []), { ctx, sc }]);

        // Parameters: `a, b *gin.RouterGroup, n int` — a name without a type takes the next type.
        const params: Array<Holder | null> = [];
        const segs = splitArgs(s, s, i + 1, pc).map(([x, y]) => s.slice(x, y).trim());
        let pendingType: string | null = null;
        const entries: Array<{ name: string | null; type: string | null }> = [];
        for (let k = segs.length - 1; k >= 0; k--) {
          const m2 = /^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/.exec(segs[k]);
          if (m2) {
            pendingType = m2[2].replace(/^\.\.\./, '');
            entries.unshift({ name: m2[1], type: pendingType });
          } else if (/^[A-Za-z_]\w*$/.test(segs[k]) && pendingType) entries.unshift({ name: segs[k], type: pendingType });
          else {
            pendingType = null;
            entries.unshift({ name: null, type: segs[k] });
          }
        }
        for (const e of entries) {
          const type = e.type?.replace(/^[*&]+/, '').trim() ?? '';
          const tm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(type);
          const kind = tm ? ROUTER_TYPES.get(`${ctx.canon(tm[1])}.${tm[2]}`) : undefined;
          if (e.name && e.name !== '_' && kind) {
            const h = declare(ctx, e.name, body, kind, kind === 'app' ? 'app' : 'router', sc);
            h.label = `${kind === 'app' ? 'app' : 'router'} ${e.name}<br/>${name ?? 'func literal'} · ${f.path}`;
            params.push(h);
          } else params.push(null);
        }
        if (name && params.some(Boolean)) funcDefs.set(name, [...(funcDefs.get(name) ?? []), { dir: ctx.dir, params }]);
      }

      // Constructors.
      const ctorRe = /(?:^|[\n{;])[ \t]*([A-Za-z_]\w*)\s*(?::=|=)\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = ctorRe.exec(s))) {
        if (CTORS.has(`${ctx.canon(m[2])}.${m[3]}`)) declare(ctx, m[1], m.index + m[0].length, 'app', 'app');
      }

    } catch {
      continue;
    }
  }


  /** Router returned by `name(...)` called from `ctx` (`pkg.Name` resolved by directory name, bare names by same directory, otherwise only when unique). */
  const returnedHolder = (ctx: FileCtx, qualifier: string | undefined, name: string): Holder | undefined => {
    const all = named.get(name);
    if (!all) return undefined;
    const byPkg = qualifier ? all.filter((x) => x.ctx.dir.split('/').pop() === qualifier) : [];
    const sameDir = !qualifier ? all.filter((x) => x.ctx.dir === ctx.dir) : [];
    const picked = byPkg.length ? byPkg : sameDir.length ? sameDir : all.length === 1 ? all : [];
    for (const { ctx: c, sc } of picked) {
      for (const r of c.s.slice(sc.start, sc.end).matchAll(/\breturn\s+&?([A-Za-z_]\w*)\s*(?=[;\n}])/g)) {
        const h = resolve(c, r[1], sc.start + (r.index ?? 0));
        if (h) return h;
      }
    }
    return undefined;
  };

  // ---- phase 1b: `x := NewRouter()` aliases and groups (repeated so either can feed the other, across files) ----
  const doneGroups = new Set<string>();
  for (let round = 0; round < 3; round++) {
    for (const ctx of ctxs) {
      try {
        const { s, code } = ctx;
        for (const am of s.matchAll(/(?:^|[\n{;])[ \t]*([A-Za-z_]\w*)\s*(?::=|=)\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/g)) {
          const pos = (am.index ?? 0) + am[0].length - 1;
          const sc = chain(ctx, pos)[0] ?? null;
          if ((sc ? sc.vars : ctx.pkgVars).has(am[1])) continue;
          if (CTORS.has(`${ctx.canon(am[2] ?? '')}.${am[3]}`) || am[3] === 'Group') continue;
          const h = returnedHolder(ctx, am[2], am[3]);
          if (h) (sc ? sc.vars : ctx.pkgVars).set(am[1], h);
        }
        const groupRe = /(?:^|[\n{;])[ \t]*([A-Za-z_]\w*)\s*(?::=|=)\s*([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\.Group\s*\(/g;
        for (const g of s.matchAll(groupRe)) {
          const gkey = `${ctx.path}@${g.index}`;
          if (doneGroups.has(gkey)) continue;
          const pos = (g.index ?? 0) + g[0].length - 1;
          const parent = g[3] ? resolveField(ctx, g[2], g[3], pos) : resolve(ctx, g[2], pos);
          if (!parent) continue;
          const close = matchClose(s, pos);
          if (close < 0) continue;
          const arg0 = splitArgs(s, code, pos + 1, close)[0];
          const prefix = arg0 ? literal(code, arg0[0], arg0[1]) ?? shortText(code, arg0[0], arg0[1]) : '';
          const child = declare(ctx, g[1], pos, 'router', 'group');
          doneGroups.add(gkey);
          mounts.push({ parent, child, prefix });
        }
      } catch {
        continue;
      }
    }
  }

  // ---- phase 2: routes, mounts, closure-style sub-routers and router arguments passed to other functions ----
  for (const ctx of ctxs) {
    try {
      const { s, code, path } = ctx;
      const callRe = /(?<![\w.])(?:([A-Za-z_]\w*)\.(?:([A-Za-z_]\w*)\.)?)?([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(s))) {
        const [whole, obj, field, method] = m;
        const nameStart = m.index + whole.lastIndexOf(method);
        if (ctx.declNames.has(nameStart)) continue;
        const open = m.index + whole.length - 1;
        const close = matchClose(s, open);
        if (close < 0) continue;

        if (field && !resolveField(ctx, obj, field, m.index)) continue; // `a.b.c(` that is not a known router field
        let holder = field ? resolveField(ctx, obj, field, m.index) : obj ? resolve(ctx, obj, m.index) : undefined;
        if (!holder && obj && !field && ctx.canon(obj) === 'http' && HANDLE.has(method)) {
          holder = holders.get(`${path}::http`) ?? { id: `${path}::http`, label: `app http (default mux)<br/>${path}`, kind: 'app' };
          holders.set(holder.id, holder);
        }

        if (!holder) {
          // `pkg.Register(v1.Group("/x"))` / `register(router)`: bind the argument to the callee's router parameter.
          const defs = funcDefs.get(method);
          if (!defs) continue;
          const sameDir = defs.filter((d) => d.dir === ctx.dir);
          const byPkg = obj ? defs.filter((d) => d.dir.split('/').pop() === obj) : [];
          const targets = byPkg.length ? byPkg : !obj && sameDir.length ? sameDir : defs.length === 1 ? defs : [];
          if (targets.length === 0) continue;
          const args = splitArgs(s, code, open + 1, close);
          for (const def of targets) {
            def.params.forEach((param, idx) => {
              const a = args[idx];
              if (!param || !a) return;
              const argText = s.slice(a[0], a[1]).trim();
              const plain = /^&?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)$/.exec(argText);
              if (plain) {
                const dot = plain[1].split('.');
                const parent = dot.length === 2 ? resolveField(ctx, dot[0], dot[1], a[0]) : resolve(ctx, plain[1], a[0]);
                if (parent && parent.id !== param.id) mounts.push({ parent, child: param, prefix: '' });
                return;
              }
              const grp = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\.Group\s*\(/.exec(argText);
              if (grp) {
                const gd = grp[1].split('.');
                const parent = gd.length === 2 ? resolveField(ctx, gd[0], gd[1], a[0]) : resolve(ctx, grp[1], a[0]);
                const gOpen = a[0] + argText.indexOf('(', grp[1].length);
                const gClose = matchClose(s, gOpen);
                if (!parent || gClose < 0 || parent.id === param.id) return;
                const g0 = splitArgs(s, code, gOpen + 1, gClose)[0];
                mounts.push({ parent, child: param, prefix: g0 ? literal(code, g0[0], g0[1]) ?? shortText(code, g0[0], g0[1]) : '' });
              }
            });
          }
          continue;
        }

        const args = splitArgs(s, code, open + 1, close);
        if (args.length === 0) continue;

        if (method === 'Mount') {
          const prefix = literal(code, args[0][0], args[0][1]);
          const childName = args[1] ? s.slice(args[1][0], args[1][1]).trim() : '';
          const callArg = /^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/.exec(childName);
          const child = callArg ? returnedHolder(ctx, callArg[1], callArg[2]) : resolve(ctx, childName, args[1]?.[0] ?? m.index);
          if (prefix !== null && child && child.id !== holder.id) mounts.push({ parent: holder, child, prefix });
          continue;
        }

        // chi / fiber closure style: x.Route("/p", func(r chi.Router) {..}) and x.Group(func(r chi.Router) {..}).
        if (method === 'Route' || method === 'Group') {
          const fnArg = args.find(([x]) => /^\s*func\b/.test(s.slice(x, x + 40)));
          if (fnArg) {
            const body = s.indexOf('{', fnArg[0] + s.slice(fnArg[0]).indexOf(')'));
            const sc = ctx.scopes.find((c) => c.start === body);
            const child = sc ? [...sc.vars.values()][0] : undefined;
            if (child && child.id !== holder.id) {
              const first = args[0] !== fnArg ? literal(code, args[0][0], args[0][1]) ?? shortText(code, args[0][0], args[0][1]) : '';
              mounts.push({ parent: holder, child, prefix: first });
            }
            continue;
          }
        }

        const verb = VERBS.get(method);
        if (!verb && !HANDLE.has(method)) continue;

        let rpath = literal(code, args[0][0], args[0][1]);
        if (rpath === null) rpath = shortText(code, args[0][0], args[0][1]);
        const last = args.length > 1 ? args[args.length - 1] : null;
        const handler = last ? shortText(code, last[0], last[1]) : '';

        let methods: string[] = [verb ?? 'ANY'];
        if (!verb) {
          const pm = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|CONNECT|TRACE)\s+(\S.*)$/.exec(rpath);
          if (pm) {
            methods = [pm[1]];
            rpath = pm[2];
          }
          const tail = /^\s*\.Methods\(([^)]*)\)/.exec(code.slice(close + 1, close + 120));
          if (tail) {
            const found = [...tail[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1].toUpperCase());
            if (found.length) methods = found;
          }
        }
        for (const meth of methods) routes.push({ holder, method: meth, path: rpath, handler });
      }
    } catch {
      continue;
    }
  }

  return assembleRouteGraph(holders.values(), routes, mounts);
}

export const goRouteAnalyzer: CodeAnalyzer = {
  id: 'go-routes',
  displayName: 'Web Routes (Go)',
  supportedExtensions: ['.go'],
  analyze: (files) => analyze(unrollLoops(files, 'go')),
};
