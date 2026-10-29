import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { scrub } from '../common/scrubber';
import { resolvePythonImport } from './pythonAnalyzer';

/**
 * Python web-route map: apps, routers/blueprints, mounts and the routes each
 * one defines, for Flask (and Quart), FastAPI (and Starlette's decorator /
 * add_route style) and Django (+ Django REST Framework routers). Like the
 * Express analyzer it is syntax-only and name-based: statements are read from
 * text whose strings/comments are blanked (common/scrubber.ts), and string
 * literals (paths, prefixes, methods) are then read from the ORIGINAL text at
 * the same offsets.
 *
 *  - Holders: `app = Flask(..)` / `Quart(..)` / `FastAPI(..)` / `Starlette(..)`
 *    are 'app'; `Blueprint(.., url_prefix=..)` and `APIRouter(prefix=..)`,
 *    DRF `DefaultRouter()` / `SimpleRouter()`, and each file's module-level
 *    `urlpatterns` (Django) are 'router'. Holders are found at any indent (so
 *    `app = Flask()` inside `create_app()` works), keyed by file + variable.
 *  - Routes: `@x.route(path, methods=[..])` / `@x.api_route` (default GET, one
 *    node per method), `@x.get|post|put|delete|patch|options|head|trace`,
 *    `@x.websocket` / `@x.websocket_route` (verb WS), `x.add_url_rule`,
 *    `x.add_api_route`, `x.add_route`. Stacked decorators, async defs and
 *    multi-line decorator calls are fine; keyword args may come in any order.
 *    The handler shown is the decorated function's name.
 *  - Django: each `path()/re_path()/url()` in `urlpatterns` (also `+=`,
 *    `[..] + [..]`, `format_suffix_patterns([..])`, `i18n_patterns(..)`) is a
 *    route "ANY /x/" labelled with the view's dotted name (`Cls.as_view()` ->
 *    `Cls`). re_path regexes lose a leading `^` / trailing `$` but are
 *    otherwise shown as source text. `include('dotted.module')`,
 *    `include(('dotted.module', 'ns'))` and `include(router.urls)` become
 *    mount edges when the target is a scanned file. DRF `router.register(
 *    r'users', UserViewSet)` becomes "ROUTER /users<br/>UserViewSet".
 *  - Mounts: `x.register_blueprint(bp, url_prefix=..)` (the argument overrides
 *    the blueprint's own url_prefix, as in Flask) and `x.include_router(r,
 *    prefix=..)` (effective prefix = include prefix + the router's own
 *    prefix, as in FastAPI). The child may be a local variable, a name
 *    imported with `from .items import router [as r]`, a module imported with
 *    `from app.routers import items` / `import app.routers.items [as items]`
 *    and referenced as `items.router`. Imports are resolved against scanned
 *    files with the same relative/absolute resolver as the Python import
 *    graph (absolute imports match by path suffix); a re-export through an
 *    `__init__.py` `from .x import router` is followed a few hops.
 *  - Paths/prefixes: string literals, adjacent-literal concatenation,
 *    `A + '/x'`, and module-level `NAME = '/api'` constants of the SAME file
 *    are resolved. Anything else (f-strings, `settings.PREFIX`, imported
 *    constants) is shown as its source text, e.g. `/settings.PREFIX/x`.
 *  - Full paths are shown on a route only when its holder has exactly one
 *    mount chain (same rule as the Express analyzer); otherwise the
 *    router-relative path is shown and the mount edges carry the prefixes
 *    (including the router's own prefix). A router that is never mounted
 *    shows its own prefix. Paths always get a leading '/'.
 *
 *  - Routers passed to functions: a call `register(app)` / `routes.register(app)`
 *    to a scanned top-level function (same file, or imported with `from x
 *    import f` / `import x`) mounts each argument that is a known holder onto
 *    the matching parameter (positional or keyword), which becomes a holder
 *    inside that function, so `@app.get(..)`, `app.register_blueprint(..)` and
 *    `app.include_router(..)` in its body work; hand-offs through several
 *    functions are followed. Factories: `app = create_app()` /
 *    `include_router(make_router())` use the holder the function `return`s
 *    (`return app`). Parameters are untyped in Python, so only call sites
 *    matter.
 *
 *  NOT supported: class-based Flask views (`MethodView` / `View` classes are
 *  skipped, though `add_url_rule(.., view_func=Cls.as_view(..))` shows the
 *  class name), Flask `@app.route` on classes, routes or mounts added in
 *  loops / comprehensions / methods or nested functions, conditional registration (an
 *  `if` around a route is still reported), apps built by factories other
 *  than a visible `Flask(..)`/`FastAPI(..)` call, Starlette `Route(..)` /
 *  `Mount(..)` lists, Sanic / Tornado / aiohttp / Bottle / Pyramid / Falcon,
 *  Django `include()` of an already-built list or of non-scanned apps,
 *  `urlpatterns` assembled through other variables, DRF `@action` extra
 *  routes and `basename`, Django URL namespaces, same-named holders in two
 *  functions of one file (they collide), and imported string constants.
 *  Input that does not parse never throws; the affected statement is skipped.
 */

export interface PyRouteHolder {
  id: string;
  file: string;
  varName: string;
  kind: 'app' | 'router';
  /** The router's own prefix (Blueprint url_prefix / APIRouter prefix), or '' */
  ownPrefix: string;
  /** Overrides the default "router x<br/>file" label (function-parameter holders). */
  label?: string;
}

export interface PyRoute {
  holder: PyRouteHolder;
  method: string;
  path: string;
  handler: string;
}

export interface PyMount {
  parent: PyRouteHolder;
  child: PyRouteHolder;
  /** Prefix this mount contributes (already includes the child's own prefix where the framework adds it). */
  prefix: string;
}

interface Holder extends PyRouteHolder {
  drf: boolean;
}

interface Span {
  s: number;
  e: number;
}
interface Arg {
  name: string | null;
  v: Span;
}
interface Call {
  callee: string;
  args: Arg[];
}
type Binding = { kind: 'from'; level: number; module: string; name: string } | { kind: 'module'; module: string };

interface FuncScope {
  name: string;
  /** Column of the `def` keyword; the body is every following statement indented deeper. */
  indent: number;
  /** Offsets of the `def` statement start and the end of its body. */
  s: number;
  e: number;
  params: string[];
  /** Holders that belong to this function: parameters bound at a call site. */
  vars: Map<string, Holder>;
  ctx: Ctx;
}

interface Ctx {
  path: string;
  text: string;
  scr: string;
  stmts: Span[];
  bindings: Map<string, Binding>;
  consts: Map<string, string>;
  funcs: FuncScope[];
  /** Top-level functions by name. */
  funcByName: Map<string, FuncScope>;
  /** `class X:` bodies, for routers kept in `self.x` and reached as `instance.x`. */
  classes: Array<{ name: string; s: number; e: number }>;
  /** Module-level `x = SomeClass(...)`: variable -> class name as written. */
  instances: Map<string, string>;
  /** Offset of the statement being processed; decides which function's parameters are in scope. */
  curPos: number;
}

const VERB_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace']);
const MULTI_DECORATORS = new Set(['route', 'api_route']);
const WS_DECORATORS = new Set(['websocket', 'websocket_route']);
const APP_CTORS = new Set(['Flask', 'Quart', 'FastAPI', 'Starlette']);
const ROUTER_CTORS: Record<string, string> = { Blueprint: 'url_prefix', APIRouter: 'prefix' };
const DRF_CTORS = new Set(['DefaultRouter', 'SimpleRouter']);
const URL_FUNCS = new Set(['path', 're_path', 'url']);
const URL_WRAPPERS = new Set(['format_suffix_patterns', 'i18n_patterns']);

// ---------- low-level text helpers (all operate on scrubbed text + offsets) ----------

function splitStatements(scr: string): Span[] {
  const out: Span[] = [];
  const n = scr.length;
  let pos = 0;
  while (pos < n) {
    let lineEnd = scr.indexOf('\n', pos);
    if (lineEnd < 0) lineEnd = n;
    if (!scr.slice(pos, lineEnd).trim()) {
      pos = lineEnd + 1;
      continue;
    }
    let depth = 0;
    let i = pos;
    for (; i < n; i++) {
      const c = scr[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (c === '\n' && depth === 0) {
        let k = i - 1;
        while (k > pos && (scr[k] === ' ' || scr[k] === '\t' || scr[k] === '\r')) k--;
        if (scr[k] === '\\') continue;
        break;
      }
    }
    out.push({ s: pos, e: i });
    pos = i + 1;
  }
  return out;
}

function trimSpan(scr: string, s: number, e: number): Span {
  while (s < e && /\s/.test(scr[s])) s++;
  while (e > s && /\s/.test(scr[e - 1])) e--;
  return { s, e };
}

/** Index of the bracket closing the one at `open`, or -1. Strings/comments are already blanked. */
function matchClose(scr: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = scr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTop(scr: string, s: number, e: number, sep: string): Span[] {
  const out: Span[] = [];
  let depth = 0;
  let start = s;
  for (let i = s; i < e; i++) {
    const c = scr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(trimSpan(scr, start, i));
      start = i + 1;
    }
  }
  out.push(trimSpan(scr, start, e));
  return out.filter((x) => x.e > x.s);
}

function parseCall(scr: string, span: Span): Call | null {
  const sp = trimSpan(scr, span.s, span.e);
  const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(scr.slice(sp.s, sp.e));
  if (!m) return null;
  const open = sp.s + m[0].length - 1;
  const close = matchClose(scr, open, sp.e);
  if (close < 0 || scr.slice(close + 1, sp.e).trim() !== '') return null;
  const args: Arg[] = [];
  for (const a of splitTop(scr, open + 1, close, ',')) {
    const km = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(scr.slice(a.s, a.e));
    if (km) args.push({ name: km[1], v: trimSpan(scr, a.s + km[0].length, a.e) });
    else args.push({ name: null, v: a });
  }
  return { callee: m[1], args };
}

/** Keyword arg `name` (or any of several names), else the positional arg at `pos` (positional args only count before the first keyword). */
function getArg(call: Call, pos: number, ...names: string[]): Span | null {
  for (const a of call.args) if (a.name && names.includes(a.name)) return a.v;
  let idx = 0;
  for (const a of call.args) {
    if (a.name) break;
    if (idx === pos) return a.v;
    idx++;
  }
  return null;
}

function lastSeg(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf('.') + 1);
}

function joinPaths(...ps: string[]): string {
  const raw = ps.filter((p) => p !== '');
  const segs = raw.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const last = raw[raw.length - 1] ?? '';
  const trailing = segs.length > 0 && /\/$/.test(last);
  return '/' + segs.join('/') + (trailing ? '/' : '');
}

/** Joins two prefix pieces without inventing a '/' when both are empty. */
function joinRaw(a: string, b: string): string {
  return a === '' && b === '' ? '' : joinPaths(a, b);
}

/** Value of a (possibly implicitly concatenated) plain string literal in original text, or null. */
function strLit(src: string): string | null {
  let i = 0;
  let out = '';
  let count = 0;
  const n = src.length;
  for (;;) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    let raw = false;
    const pm = /^[rRuUbBfF]{1,2}(?=["'])/.exec(src.slice(i, i + 3));
    if (pm) {
      if (/[bBfF]/.test(pm[0])) return null;
      raw = /[rR]/.test(pm[0]);
      i += pm[0].length;
    }
    const q = src[i];
    if (q !== '"' && q !== "'") return null;
    const triple = src.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    let j = i;
    for (; j < n; j++) {
      if (src[j] === '\\' && !raw) {
        j++;
        continue;
      }
      if (triple ? src.startsWith(q.repeat(3), j) : src[j] === q) break;
    }
    if (j >= n) return null;
    out += src.slice(i, j);
    i = j + (triple ? 3 : 1);
    count++;
  }
  return count > 0 ? out : null;
}

function evalStr(ctx: Ctx, span: Span): string | null {
  const sp = trimSpan(ctx.scr, span.s, span.e);
  if (sp.e <= sp.s) return null;
  const terms = splitTop(ctx.scr, sp.s, sp.e, '+');
  if (terms.length > 1) {
    let acc = '';
    for (const t of terms) {
      const v = evalStr(ctx, t);
      if (v === null) return null;
      acc += v;
    }
    return acc;
  }
  const t = ctx.scr.slice(sp.s, sp.e);
  if (t[0] === '(' && matchClose(ctx.scr, sp.s, sp.e) === sp.e - 1) return evalStr(ctx, { s: sp.s + 1, e: sp.e - 1 });
  // A string literal (or adjacent literals) appears in the scrubbed text as "   " with blank interior.
  if (/^(?:"[ \r\n]*"\s*)+$/.test(t)) return strLit(ctx.text.slice(sp.s, sp.e));
  if (/^[A-Za-z_]\w*$/.test(t)) return ctx.consts.get(t) ?? null;
  // A literal followed by nothing else is blank in the scrubbed text; anything with code left is not a constant.
  return null;
}

function srcText(ctx: Ctx, span: Span): string {
  const t = ctx.text.slice(span.s, span.e).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 37) + '...' : t;
}

function pathOf(ctx: Ctx, span: Span | null): string {
  if (!span) return '';
  return evalStr(ctx, span) ?? srcText(ctx, span);
}

/** Display name of a handler/view expression. */
function handlerText(ctx: Ctx, span: Span | null): string {
  if (!span) return '';
  const t = ctx.scr.slice(span.s, span.e).trim();
  if (/^[A-Za-z_][\w.]*$/.test(t)) return t;
  if (/^lambda\b/.test(t)) return '(inline)';
  const call = parseCall(ctx.scr, span);
  if (call && /\.as_view$/.test(call.callee)) return call.callee.slice(0, -'.as_view'.length);
  if (call) return `${call.callee}()`;
  return srcText(ctx, span);
}

/** HTTP methods named by a `methods=` argument; GET when absent, ANY when it is not a literal collection. */
function methodsOf(ctx: Ctx, call: Call): string[] {
  const arg = getArg(call, -1, 'methods');
  if (!arg) return ['GET'];
  const scrText = ctx.scr.slice(arg.s, arg.e);
  if (!/^[\s[\](){},"]*$/.test(scrText)) return ['ANY'];
  const found = new Set<string>();
  const re = /(['"])([A-Za-z]+)\1/g;
  const src = ctx.text.slice(arg.s, arg.e);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) found.add(m[2].toUpperCase());
  return found.size ? [...found] : ['ANY'];
}

// ---------- per-file context: imports, constants ----------


const LOOP_ROUTING = /\b(?:register_blueprint|include_router|add_url_rule|add_api_route|add_route|path|re_path|url|route|get|post|put|delete|patch)\s*\(/;

/**
 * Unrolls `for x in [<literals>]:` loops whose body registers routes and uses the loop variable: the body is repeated once
 * per element with the variable replaced by that element's source text (`for name, bp in [('a', a_bp), ('b', b_bp)]:`
 * unpacks tuples). Nothing is executed; only literal lists/tuples of up to 50 elements on one `for` line are handled.
 */
function unrollLoops(text: string): string {
  let cur = text;
  for (let round = 0; round < 3; round++) {
    const scr = scrub(cur, 'python', { keepStringDelimiters: true });
    const lines = scr.split('\n');
    const orig = cur.split('\n');
    const out: string[] = [];
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]*)for\s+([A-Za-z_][\w ,()]*?)\s+in\s+([\[(].*[\])])\s*:\s*$/.exec(lines[i]);
      if (!m) {
        out.push(orig[i]);
        continue;
      }
      const indent = m[1].length;
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^[ \t]*/.exec(lines[j])![0].length > indent)) j++;
      while (j > i + 1 && lines[j - 1].trim() === '') j--;
      const bodyScr = lines.slice(i + 1, j);
      const bodyOrig = orig.slice(i + 1, j);
      const names = m[2].replace(/[()\s]/g, '').split(',').filter(Boolean);
      const itStart = lines[i].indexOf(m[3]);
      const iterScr = m[3];
      const iterOrig = orig[i].slice(itStart, itStart + iterScr.length);
      const elements = splitTop(iterScr, 1, iterScr.length - 1, ',').map((sp) => trimSpan(iterScr, sp.s, sp.e)).filter((sp) => sp.e > sp.s);
      const usesVar = names.some((nm) => new RegExp(`(?<![\\w.])${nm}(?!\\w)`).test(bodyScr.join('\n')));
      if (bodyScr.length === 0 || elements.length === 0 || elements.length > 50 || !usesVar || !LOOP_ROUTING.test(bodyScr.join('\n'))) {
        out.push(orig[i]);
        continue;
      }
      const bodyIndent = Math.min(...bodyScr.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      const pieces: string[][] = [];
      for (const el of elements) {
        const elScr = iterScr.slice(el.s, el.e);
        const elOrig = iterOrig.slice(el.s, el.e);
        let values: string[];
        if (names.length === 1) values = [elOrig];
        else if (/^[\[(]/.test(elScr) && matchClose(elScr, 0, elScr.length) === elScr.length - 1) {
          values = splitTop(elScr, 1, elScr.length - 1, ',').map((sp) => { const t = trimSpan(elScr, sp.s, sp.e); return elOrig.slice(t.s, t.e); });
        } else values = [];
        if (values.length !== names.length) {
          pieces.length = 0;
          break;
        }
        const map = new Map(names.map((nm, k) => [nm, values[k]] as const));
        pieces.push(
          bodyScr.map((ls, k) => {
            let line = bodyOrig[k];
            const re = /(?<![\w.])([A-Za-z_]\w*)(?!\w)(?!\s*=(?!=))/g;
            const edits: Array<[number, number, string]> = [];
            for (let mm = re.exec(ls); mm; mm = re.exec(ls)) if (map.has(mm[1])) edits.push([mm.index, mm.index + mm[1].length, map.get(mm[1])!]);
            for (const [a, b, v] of edits.reverse()) line = line.slice(0, a) + v + line.slice(b);
            return m[1] + line.slice(Math.min(bodyIndent, line.length - line.trimStart().length));
          }),
        );
      }
      if (pieces.length === 0) {
        out.push(orig[i]);
        continue;
      }
      for (const piece of pieces) out.push(...piece);
      changed = true;
      i = j - 1;
    }
    cur = out.join('\n');
    if (!changed) break;
  }
  return cur;
}

function buildCtx(file: SourceFileInput): Ctx {
  const text = typeof file.text === 'string' ? unrollLoops(file.text) : '';
  const scr = scrub(text, 'python', { keepStringDelimiters: true });
  const ctx: Ctx = { path: file.path, text, scr, stmts: splitStatements(scr), bindings: new Map(), consts: new Map(), funcs: [], funcByName: new Map(), classes: [], instances: new Map(), curPos: 0 };
  for (const st of ctx.stmts) {
    const raw = scr.slice(st.s, st.e);
    if (/^\s*(from|import)\s/.test(raw)) {
      const norm = raw.replace(/\\\r?\n/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
      let m = /^from (\.*)([\w.]*) import (.+)$/.exec(norm);
      if (m) {
        for (const part of m[3].split(',')) {
          const [name, alias] = part.trim().split(/\s+as\s+/);
          if (name && /^\w+$/.test(name)) ctx.bindings.set(alias || name, { kind: 'from', level: m[1].length, module: m[2], name });
        }
        continue;
      }
      m = /^import (.+)$/.exec(norm);
      if (m) {
        for (const part of m[1].split(',')) {
          const [mod, alias] = part.trim().split(/\s+as\s+/);
          if (mod && /^[\w.]+$/.test(mod)) ctx.bindings.set(alias || mod, { kind: 'module', module: mod });
        }
      }
      continue;
    }
    // Module-level string constant: NAME = '/x' (also annotated, also concatenations of earlier constants).
    if (/^[A-Za-z_]/.test(raw)) {
      const m = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(raw);
      if (m) {
        const v = evalStr(ctx, trimSpan(scr, st.s + m[0].length, st.e));
        if (v !== null) ctx.consts.set(m[1], v);
      }
    }
  }

  // Function scopes (`def` statements and their indented bodies) for parameter binding.
  const indentOf = (pos: number) => pos - (scr.lastIndexOf('\n', pos - 1) + 1);
  const trimmedStarts = ctx.stmts.map((st) => trimSpan(scr, st.s, st.e));
  trimmedStarts.forEach((t, i) => {
    const m = /^class\s+([A-Za-z_]\w*)/.exec(scr.slice(t.s, t.e));
    if (!m) return;
    const indent = indentOf(t.s);
    let end = scr.length;
    for (let j = i + 1; j < trimmedStarts.length; j++) {
      if (indentOf(trimmedStarts[j].s) <= indent) {
        end = trimmedStarts[j].s;
        break;
      }
    }
    ctx.classes.push({ name: m[1], s: t.s, e: end });
  });
  for (const st of ctx.stmts) {
    if (indentOf(st.s) !== 0) continue;
    const im = /^([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)\s*([A-Za-z_][\w.]*)\s*\(/.exec(scr.slice(st.s, st.e));
    if (im) ctx.instances.set(im[1], im[2]);
  }
  trimmedStarts.forEach((t, i) => {
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(scr.slice(t.s, t.e));
    if (!m) return;
    const open = t.s + m[0].length - 1;
    const close = matchClose(scr, open, t.e);
    if (close < 0) return;
    const params = splitTop(scr, open + 1, close, ',')
      .map((a) => /^\*{0,2}([A-Za-z_]\w*)/.exec(scr.slice(a.s, a.e))?.[1])
      .filter((x): x is string => !!x);
    const indent = indentOf(t.s);
    let end = scr.length;
    for (let j = i + 1; j < trimmedStarts.length; j++) {
      if (indentOf(trimmedStarts[j].s) <= indent) {
        end = trimmedStarts[j].s;
        break;
      }
    }
    const fs: FuncScope = { name: m[1], indent, s: t.s, e: end, params, vars: new Map(), ctx };
    ctx.funcs.push(fs);
    if (indent === 0 && !ctx.funcByName.has(fs.name)) ctx.funcByName.set(fs.name, fs);
  });
  return ctx;
}

// ---------- analysis ----------

export function parsePythonRoutes(files: SourceFileInput[]): { holders: PyRouteHolder[]; routes: PyRoute[]; mounts: PyMount[] } {
  const known = new Set(files.map((f) => f.path));
  const knownList = [...known];
  const ctxs: Ctx[] = [];
  for (const f of files) {
    try {
      ctxs.push(buildCtx(f));
    } catch {
      continue;
    }
  }
  const ctxByPath = new Map(ctxs.map((c) => [c.path, c]));
  const holders = new Map<string, Holder>();

  // Pass 1: holders.
  for (const ctx of ctxs) {
    try {
      for (const st of ctx.stmts) {
        const raw = ctx.scr.slice(st.s, st.e);
        const m = /^\s*([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)/.exec(raw);
        if (m) {
          const rhs = parseCall(ctx.scr, { s: st.s + m[0].length, e: st.e });
          if (rhs) {
            const ctor = lastSeg(rhs.callee);
            const id = `${ctx.path}::${m[1]}`;
            if (APP_CTORS.has(ctor)) holders.set(id, { id, file: ctx.path, varName: m[1], kind: 'app', ownPrefix: '', drf: false });
            else if (ctor in ROUTER_CTORS) {
              const own = getArg(rhs, -1, ROUTER_CTORS[ctor]);
              holders.set(id, { id, file: ctx.path, varName: m[1], kind: 'router', ownPrefix: own ? pathOf(ctx, own) : '', drf: false });
            } else if (DRF_CTORS.has(ctor)) holders.set(id, { id, file: ctx.path, varName: m[1], kind: 'router', ownPrefix: '', drf: true });
          }
        }
        // A router kept on the instance: `self.router = APIRouter(prefix='/x')` inside a class body.
        const sm = /^\s*self\.([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)/.exec(raw);
        const owner = sm ? [...ctx.classes].filter((c) => c.s <= st.s && st.s < c.e).sort((a, b) => b.s - a.s)[0] : undefined;
        if (sm && owner) {
          const rhs = parseCall(ctx.scr, { s: st.s + sm[0].length, e: st.e });
          if (rhs) {
            const ctor = lastSeg(rhs.callee);
            const id = `${ctx.path}::${owner.name}.${sm[1]}`;
            const varName = `${owner.name}.${sm[1]}`;
            if (APP_CTORS.has(ctor)) holders.set(id, { id, file: ctx.path, varName, kind: 'app', ownPrefix: '', drf: false });
            else if (ctor in ROUTER_CTORS) {
              const own = getArg(rhs, -1, ROUTER_CTORS[ctor]);
              holders.set(id, { id, file: ctx.path, varName, kind: 'router', ownPrefix: own ? pathOf(ctx, own) : '', drf: false });
            }
          }
        }
        if (/^urlpatterns\s*(?::[^=]+?)?\+?=(?!=)/.test(raw)) {
          const id = `${ctx.path}::urlpatterns`;
          if (!holders.has(id)) holders.set(id, { id, file: ctx.path, varName: 'urlpatterns', kind: 'router', ownPrefix: '', drf: false });
        }
      }
    } catch {
      continue;
    }
  }

  // ---- name / import resolution ----
  const resolveModule = (from: string, level: number, module: string): string | null => {
    try {
      return resolvePythonImport(from, { level, module, names: [] }, known, knownList)[0] ?? null;
    } catch {
      return null;
    }
  };
  const lookupHolder = (file: string, name: string, depth = 0): Holder | null => {
    const direct = holders.get(`${file}::${name}`);
    if (direct) return direct;
    if (depth >= 5) return null;
    const b = ctxByPath.get(file)?.bindings.get(name);
    if (b && b.kind === 'from') {
      const t = resolveModule(file, b.level, b.module);
      if (t && t !== file) return lookupHolder(t, b.name, depth + 1);
    }
    return null;
  };
  const holderFor = (ctx: Ctx, expr: string): Holder | null => {
    const text = expr.trim();
    const factory = /^([A-Za-z_][\w.]*)\s*\([\s\S]*\)$/.exec(text);
    if (factory) {
      const fs = lookupFunc(ctx, factory[1]);
      return fs ? funcReturns(fs) : null;
    }
    const parts = text.split('.');
    if (!parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) return null;
    if (parts.length === 1) {
      const scoped = ctx.funcs
        .filter((fs) => fs.s <= ctx.curPos && ctx.curPos < fs.e)
        .sort((x, y) => y.s - x.s)
        .map((fs) => fs.vars.get(parts[0]))
        .find(Boolean);
      if (scoped) return scoped;
      const local = holders.get(`${ctx.path}::${parts[0]}`);
      if (local) return local;
      const b = ctx.bindings.get(parts[0]);
      if (b && b.kind === 'from') {
        const t = resolveModule(ctx.path, b.level, b.module);
        return t ? lookupHolder(t, b.name) : null;
      }
      return null;
    }
    if (parts.length === 2) {
      // `self.router` inside a class, or `api.router` where `api = Api()` at module level (Api here or imported).
      let clsFile: string | null = null;
      let clsName: string | null = null;
      if (parts[0] === 'self') {
        const here = [...ctx.classes].filter((c) => c.s <= ctx.curPos && ctx.curPos < c.e).sort((a, b) => b.s - a.s)[0];
        if (here) [clsFile, clsName] = [ctx.path, here.name];
      } else {
        const ctor = ctx.instances.get(parts[0]);
        if (ctor && !ctor.includes('.')) {
          if (ctx.classes.some((c) => c.name === ctor)) [clsFile, clsName] = [ctx.path, ctor];
          else {
            const b = ctx.bindings.get(ctor);
            const t = b && b.kind === 'from' ? resolveModule(ctx.path, b.level, b.module) : null;
            if (t && b && b.kind === 'from') [clsFile, clsName] = [t, b.name];
          }
        }
      }
      if (clsFile && clsName) {
        const h = holders.get(`${clsFile}::${clsName}.${parts[1]}`);
        if (h) return h;
      }
    }
    const leaf = parts[parts.length - 1];
    for (let k = parts.length - 1; k >= 1; k--) {
      const b = ctx.bindings.get(parts.slice(0, k).join('.'));
      if (!b) continue;
      const extra = parts.slice(k, -1);
      const level = b.kind === 'from' ? b.level : 0;
      const base = b.kind === 'from' ? (b.module ? `${b.module}.${b.name}` : b.name) : b.module;
      const t = resolveModule(ctx.path, level, [base, ...extra].join('.'));
      const h = t ? lookupHolder(t, leaf) : null;
      if (h) return h;
    }
    return null;
  };

  // ---- functions: resolution, returned holders and parameter binding ----
  const funcIn = (file: string, name: string, depth = 0): FuncScope | null => {
    const c = ctxByPath.get(file);
    if (!c) return null;
    const direct = c.funcByName.get(name);
    if (direct) return direct;
    if (depth >= 3) return null;
    const b = c.bindings.get(name);
    if (b && b.kind === 'from') {
      const t = resolveModule(file, b.level, b.module);
      if (t && t !== file) return funcIn(t, b.name, depth + 1);
    }
    return null;
  };
  function lookupFunc(ctx: Ctx, callee: string): FuncScope | null {
    const parts = callee.split('.');
    if (parts.length === 1) {
      const local = ctx.funcByName.get(parts[0]);
      if (local) return local;
      const b = ctx.bindings.get(parts[0]);
      if (b && b.kind === 'from') {
        const t = resolveModule(ctx.path, b.level, b.module);
        return t ? funcIn(t, b.name) : null;
      }
      return null;
    }
    const leaf = parts[parts.length - 1];
    for (let k = parts.length - 1; k >= 1; k--) {
      const b = ctx.bindings.get(parts.slice(0, k).join('.'));
      if (!b) continue;
      const level = b.kind === 'from' ? b.level : 0;
      const base = b.kind === 'from' ? (b.module ? `${b.module}.${b.name}` : b.name) : b.module;
      const t = resolveModule(ctx.path, level, [base, ...parts.slice(k, -1)].join('.'));
      const hit = t ? funcIn(t, leaf) : null;
      if (hit) return hit;
    }
    return null;
  }
  /** The holder a function returns (`return app` / `return router`), read in that function's own scope. */
  function funcReturns(fs: FuncScope): Holder | null {
    const c = fs.ctx;
    const saved = c.curPos;
    try {
      for (const st of c.stmts) {
        const t = trimSpan(c.scr, st.s, st.e);
        if (t.s <= fs.s || t.s >= fs.e) continue;
        const m = /^return\s+([A-Za-z_]\w*)\s*$/.exec(c.scr.slice(t.s, t.e));
        if (!m) continue;
        c.curPos = t.s;
        const h = holderFor(c, m[1]);
        if (h) return h;
      }
    } finally {
      c.curPos = saved;
    }
    return null;
  }

  const routes: PyRoute[] = [];
  const mounts: PyMount[] = [];
  const addMount = (parent: Holder, child: Holder, prefix: string) => {
    if (parent.id !== child.id) mounts.push({ parent, child, prefix });
  };

  // Repeated so hand-offs through several functions resolve: `register(app)` -> `inner(app)` -> `@app.get(..)`.
  const bound = new Set<string>();
  for (let round = 0; round < 4; round++) {
    for (const ctx of ctxs) {
      try {
        for (const st of ctx.stmts) {
          const t = trimSpan(ctx.scr, st.s, st.e);
          ctx.curPos = t.s;
          const raw = ctx.scr.slice(t.s, t.e);
          if (raw.startsWith('@') || /^(?:async\s+)?def\s/.test(raw) || /^(?:class|from|import|return)\b/.test(raw)) continue;
          const asg = /^([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)/.exec(raw);
          const call = parseCall(ctx.scr, asg ? { s: t.s + asg[0].length, e: t.e } : t);
          if (!call) continue;
          const fs = lookupFunc(ctx, call.callee);
          if (!fs) continue;
          fs.params.forEach((pname, i) => {
            const a = getArg(call, i, pname);
            if (!a) return;
            const key = `${ctx.path}@${t.s}#${i}`;
            if (bound.has(key)) return;
            const parent = holderFor(ctx, ctx.scr.slice(a.s, a.e));
            if (!parent) return;
            bound.add(key);
            let child = fs.vars.get(pname);
            if (!child) {
              const id = `${fs.ctx.path}::${fs.name}(${pname})`;
              child = { id, file: fs.ctx.path, varName: pname, kind: 'router', ownPrefix: '', drf: false, label: `router ${pname}<br/>${fs.name}() · ${fs.ctx.path}` };
              holders.set(id, child);
              fs.vars.set(pname, child);
            }
            addMount(parent, child, '');
          });
          if (asg && !holders.has(`${ctx.path}::${asg[1]}`)) {
            const r = funcReturns(fs);
            if (r) holders.set(`${ctx.path}::${asg[1]}`, r);
          }
        }
      } catch {
        continue;
      }
    }
  }

  const addRoute = (holder: Holder, method: string, path: string, handler: string) => routes.push({ holder, method, path, handler });
  const urlEntry = (ctx: Ctx, holder: Holder, entry: Span) => {
    const et = ctx.scr.slice(entry.s, entry.e).trim();
    // `*router.urls` or a bare `router.urls`
    const urlsRef = /^\*?\s*([A-Za-z_][\w.]*)\.urls$/.exec(et);
    if (urlsRef) {
      const child = holderFor(ctx, urlsRef[1]);
      if (child && child.drf) addMount(holder, child, '');
      return;
    }
    const call = parseCall(ctx.scr, entry);
    if (!call || !URL_FUNCS.has(lastSeg(call.callee))) return;
    const fn = lastSeg(call.callee);
    const routeSpan = getArg(call, 0, 'route', 'regex');
    const viewSpan = getArg(call, 1, 'view');
    if (!routeSpan) return;
    let route = pathOf(ctx, routeSpan);
    if (fn !== 'path') route = route.replace(/^\^/, '').replace(/\$$/, '');
    const inc = viewSpan ? parseCall(ctx.scr, viewSpan) : null;
    if (inc && lastSeg(inc.callee) === 'include') {
      const target = getArg(inc, 0, 'arg');
      if (!target) return;
      const tt = ctx.scr.slice(target.s, target.e).trim();
      const urlsOf = /^([A-Za-z_][\w.]*)\.urls$/.exec(tt);
      let child: Holder | null = null;
      if (urlsOf) child = holderFor(ctx, urlsOf[1]);
      else {
        let mod: string | null = null;
        if (tt.startsWith('(')) {
          const first = splitTop(ctx.scr, target.s + 1, target.e - 1, ',')[0];
          mod = first ? evalStr(ctx, first) : null;
        } else mod = evalStr(ctx, target);
        const t = mod ? resolveModule(ctx.path, 0, mod) : null;
        child = t ? holders.get(`${t}::urlpatterns`) ?? null : null;
      }
      if (child) addMount(holder, child, route);
      return;
    }
    addRoute(holder, 'ANY', route, handlerText(ctx, viewSpan));
  };

  const collectEntries = (ctx: Ctx, span: Span, depth = 0): Span[] => {
    const sp = trimSpan(ctx.scr, span.s, span.e);
    if (depth > 4 || sp.e <= sp.s) return [];
    if (ctx.scr[sp.s] === '[' && matchClose(ctx.scr, sp.s, sp.e) === sp.e - 1) return splitTop(ctx.scr, sp.s + 1, sp.e - 1, ',');
    const call = parseCall(ctx.scr, sp);
    if (call && URL_WRAPPERS.has(lastSeg(call.callee))) {
      const out: Span[] = [];
      for (const a of call.args) if (!a.name) out.push(...collectEntries(ctx, a.v, depth + 1));
      return out;
    }
    return [sp];
  };

  // Pass 2: routes and mounts, in source order per file.
  for (const ctx of ctxs) {
    try {
      let pending: Array<{ obj: string; method: string; call: Call }> = [];
      for (const st of ctx.stmts) {
        const trimmed = trimSpan(ctx.scr, st.s, st.e);
        ctx.curPos = trimmed.s;
        const body = ctx.scr.slice(trimmed.s, trimmed.e);

        if (body.startsWith('@')) {
          const call = parseCall(ctx.scr, { s: trimmed.s + 1, e: trimmed.e });
          if (call && call.callee.includes('.')) pending.push({ obj: call.callee.slice(0, call.callee.lastIndexOf('.')), method: lastSeg(call.callee), call });
          continue;
        }
        const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(body);
        if (def) {
          for (const d of pending) {
            const holder = holderFor(ctx, d.obj);
            if (!holder) continue;
            const pathArg = getArg(d.call, 0, 'path', 'rule');
            const p = pathOf(ctx, pathArg);
            if (VERB_DECORATORS.has(d.method)) addRoute(holder, d.method.toUpperCase(), p, def[1]);
            else if (MULTI_DECORATORS.has(d.method)) for (const meth of methodsOf(ctx, d.call)) addRoute(holder, meth, p, def[1]);
            else if (WS_DECORATORS.has(d.method)) addRoute(holder, 'WS', p, def[1]);
          }
          pending = [];
          continue;
        }
        pending = [];

        // urlpatterns = [...] / += / [..] + [..] / router.urls
        const up = /^urlpatterns\s*(?::[^=]+?)?\+?=(?!=)\s*/.exec(body);
        if (up) {
          const holder = holders.get(`${ctx.path}::urlpatterns`);
          if (holder) {
            for (const part of splitTop(ctx.scr, trimmed.s + up[0].length, trimmed.e, '+'))
              for (const entry of collectEntries(ctx, part)) urlEntry(ctx, holder, entry);
          }
          continue;
        }

        const call = parseCall(ctx.scr, trimmed);
        if (!call || !call.callee.includes('.')) continue;
        const obj = call.callee.slice(0, call.callee.lastIndexOf('.'));
        const method = lastSeg(call.callee);
        if (!['register_blueprint', 'include_router', 'add_url_rule', 'add_api_route', 'add_route', 'register'].includes(method)) continue;
        const holder = holderFor(ctx, obj);
        if (!holder) continue;

        if (method === 'register_blueprint' || method === 'include_router') {
          const childArg = getArg(call, 0, 'blueprint', 'router');
          const child = childArg ? holderFor(ctx, ctx.scr.slice(childArg.s, childArg.e)) : null;
          if (!child) continue;
          const given = getArg(call, -1, method === 'register_blueprint' ? 'url_prefix' : 'prefix');
          const prefix = method === 'register_blueprint' ? (given ? pathOf(ctx, given) : child.ownPrefix) : joinRaw(given ? pathOf(ctx, given) : '', child.ownPrefix);
          addMount(holder, child, prefix);
        } else if (method === 'register') {
          if (!holder.drf) continue;
          const prefixArg = getArg(call, 0, 'prefix');
          const viewset = getArg(call, 1, 'viewset');
          if (prefixArg) addRoute(holder, 'ROUTER', pathOf(ctx, prefixArg), handlerText(ctx, viewset));
        } else {
          const pathArg = getArg(call, 0, 'rule', 'path');
          const p = pathOf(ctx, pathArg);
          const h =
            method === 'add_url_rule'
              ? handlerText(ctx, getArg(call, 2, 'view_func'))
              : handlerText(ctx, getArg(call, 1, 'endpoint', 'route'));
          for (const meth of methodsOf(ctx, call)) addRoute(holder, meth, p, h);
        }
      }
    } catch {
      continue;
    }
  }
  return { holders: [...new Set(holders.values())], routes, mounts };
}

function analyze(files: SourceFileInput[]): CodeGraph {
  let parsed: ReturnType<typeof parsePythonRoutes>;
  try {
    parsed = parsePythonRoutes(Array.isArray(files) ? files : []);
  } catch {
    return { nodes: [], edges: [] };
  }
  const { holders, routes, mounts } = parsed;

  const incoming = new Map<string, PyMount[]>();
  for (const m of mounts) incoming.set(m.child.id, [...(incoming.get(m.child.id) ?? []), m]);
  const prefixesOf = (h: PyRouteHolder, stack: Set<string>): string[] => {
    const ins = incoming.get(h.id);
    if (!ins || ins.length === 0) return [h.ownPrefix];
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
  for (const h of holders) {
    if (!used.has(h.id)) continue;
    nodes.push({ id: h.id, label: h.label ?? `${h.kind === 'app' ? 'app' : 'router'} ${h.varName}<br/>${h.file}`, kind: h.kind });
  }
  for (const m of mounts) edges.push({ from: m.parent.id, to: m.child.id, label: m.prefix ? joinPaths(m.prefix) : '/', kind: 'mount' });

  let rn = 0;
  for (const r of routes) {
    const prefixes = prefixesOf(r.holder, new Set());
    const shown = prefixes.length === 1 ? joinPaths(prefixes[0], r.path) : joinPaths(r.path);
    const id = `${r.holder.id}::route${rn++}`;
    nodes.push({ id, label: `${r.method} ${shown}${r.handler ? `<br/>${r.handler}` : ''}`, kind: 'route' });
    edges.push({ from: r.holder.id, to: id, kind: 'route' });
  }
  return { nodes, edges };
}

export const pythonRouteAnalyzer: CodeAnalyzer = {
  id: 'py-routes',
  displayName: 'Web Routes (Python)',
  supportedExtensions: ['.py'],
  analyze,
};
