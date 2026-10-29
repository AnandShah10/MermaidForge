import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { matchBrace } from '../common/scrubber';
import { assembleRouteGraph, joinPaths, matchClose, RouteEntry, RouteHolder, RouteMount, splitArgs } from '../common/routeUtils';
import { parsePhp, PhpAttribute } from './phpAnalyzer';

/**
 * PHP web routes: Laravel route files (`Route::...` DSL) and attribute routes (Symfony `#[Route]`, verb attributes
 * such as `#[Get('/x')]`). Read from scrubbed text with string values taken from the original at the same offsets.
 * The full list of supported and unsupported forms is in the module header of `phpAnalyzer.ts`.
 *
 * Shape of the result: each route file is an `app` node; a group with a prefix is a `router` node mounted under its
 * parent with that prefix, so full paths are shown whenever a route is reachable by one chain; groups with only
 * middleware / names add nothing. Each attribute-routed class is a `router` node and its routes show full paths.
 */

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options']);
/** Chain segments that only modify what follows; the first segment NOT in this set is the one that defines routes. */
const MODIFIERS = new Set(['prefix', 'middleware', 'name', 'as', 'controller', 'where', 'domain', 'namespace', 'withoutMiddleware', 'scopeBindings', 'can', 'whereNumber', 'whereAlpha', 'whereUuid', 'whereIn', 'missing']);
const RESOURCE_ACTIONS: Array<{ action: string; method: string; suffix: string; api: boolean }> = [
  { action: 'index', method: 'GET', suffix: '', api: true },
  { action: 'create', method: 'GET', suffix: '/create', api: false },
  { action: 'store', method: 'POST', suffix: '', api: true },
  { action: 'show', method: 'GET', suffix: '/{p}', api: true },
  { action: 'edit', method: 'GET', suffix: '/{p}/edit', api: false },
  { action: 'update', method: 'PUT|PATCH', suffix: '/{p}', api: true },
  { action: 'destroy', method: 'DELETE', suffix: '/{p}', api: true },
];

interface Seg {
  name: string;
  /** Argument range (inside the parentheses). */
  a: number;
  b: number;
}

interface Ctx {
  holder: RouteHolder;
  controller: string | null;
}

const lastSegment = (name: string): string => name.replace(/^\\+/, '').split('\\').pop() ?? name;

function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Unquotes a PHP string literal, or a `'a' . 'b'` concatenation of them; null for anything else. */
function stringValue(text: string): string | null {
  const t = text.trim();
  const parts: string[] = [];
  let rest = t;
  for (;;) {
    const m = /^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\$])*)")\s*/.exec(rest);
    if (!m) return null;
    parts.push((m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1'));
    rest = rest.slice(m[0].length);
    if (rest === '') break;
    if (!rest.startsWith('.')) return null;
    rest = rest.slice(1).trimStart();
  }
  return parts.join('');
}

export function analyzePhpRoutes(files: SourceFileInput[]): CodeGraph {
  const holders = new Map<string, RouteHolder>();
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];
  let groupCounter = 0;

  for (const f of files) {
    let php: ReturnType<typeof parsePhp>;
    try {
      php = parsePhp(f.text);
    } catch {
      continue;
    }
    const s = php.scrubbed;
    const o = php.source;

    // ---- helpers over one file ----
    const argRanges = (a: number, b: number): Array<[number, number]> => splitArgs(s, o, a, b);
    const lit = (r: [number, number] | undefined): string | null => (r ? stringValue(o.slice(r[0], r[1])) : null);
    const classRef = (r: [number, number] | undefined): string | null => {
      if (!r) return null;
      const m = /^\s*\\?([A-Za-z_][\w\\]*)::class\s*$/.exec(o.slice(r[0], r[1]));
      return m ? lastSegment(m[1]) : null;
    };
    /** Elements of an array literal argument. */
    const arrayItems = (r: [number, number] | undefined): Array<[number, number]> | null => {
      if (!r) return null;
      const st = r[0] + (s.slice(r[0], r[1]).search(/\S/) < 0 ? 0 : s.slice(r[0], r[1]).search(/\S/));
      let open = st;
      if (s.startsWith('array', st)) open = s.indexOf('(', st);
      else if (s[st] !== '[') return null;
      if (open < 0) return null;
      const close = matchClose(s, open);
      return close < 0 ? null : splitArgs(s, o, open + 1, close);
    };
    /** `'key' => value` pairs of an array literal (values as ranges). */
    const arrayPairs = (r: [number, number] | undefined): Map<string, [number, number]> => {
      const out = new Map<string, [number, number]>();
      for (const item of arrayItems(r) ?? []) {
        const m = /^\s*(['"])([^'"]*)\1\s*=>/.exec(o.slice(item[0], item[1]));
        if (m) out.set(m[2], [item[0] + m[0].length, item[1]]);
      }
      return out;
    };
    const handlerOf = (r: [number, number] | undefined, ctx: Ctx): string => {
      if (!r) return '(none)';
      const text = s.slice(r[0], r[1]).trim();
      if (/^(?:static\s+)?(?:function|fn)\b/.test(text)) return '(closure)';
      const items = arrayItems(r);
      if (items && items.length === 2) {
        const cls = classRef(items[0]);
        const m = lit(items[1]);
        if (cls && m) return `${cls}.${m}`;
        if (cls) return cls;
      }
      const cls = classRef(r);
      if (cls) return cls;
      const str = lit(r);
      if (str !== null) {
        const at = /^\\?([\w\\]+)@(\w+)$/.exec(str);
        if (at) return `${lastSegment(at[1])}.${at[2]}`;
        if (ctx.controller && /^\w+$/.test(str)) return `${ctx.controller}.${str}`;
        return str;
      }
      return '(dynamic)';
    };

    /** Reads `Route::a(..)->b(..)...` starting at the `R` of `Route`. */
    const parseChain = (at: number): { segs: Seg[]; end: number } | null => {
      const segs: Seg[] = [];
      let i = at + 'Route::'.length;
      for (;;) {
        const m = /^\s*([A-Za-z_]\w*)\s*\(/.exec(s.slice(i, i + 80));
        if (!m) break;
        const open = i + m[0].length - 1;
        const close = matchClose(s, open);
        if (close < 0) return segs.length ? { segs, end: s.length } : null;
        segs.push({ name: m[1], a: open + 1, b: close });
        i = close + 1;
        const nx = /^\s*->/.exec(s.slice(i, i + 20));
        if (!nx) break;
        i += nx[0].length;
      }
      return segs.length ? { segs, end: i } : null;
    };

    const holderFor = (id: string, label: string, kind: RouteHolder['kind']): RouteHolder => {
      let h = holders.get(id);
      if (!h) {
        h = { id, label, kind };
        holders.set(id, h);
      }
      return h;
    };

    const addRoute = (ctx: Ctx, method: string, path: string, handler: string) => routes.push({ holder: ctx.holder, method, path, handler });

    const addResource = (ctx: Ctx, prefix: string, name: string | null, ctrl: string | null, api: boolean, trailing: Seg[]) => {
      if (name === null) {
        addRoute(ctx, 'RESOURCE', '(dynamic)', ctrl ?? '(dynamic)');
        return;
      }
      let only: string[] | null = null;
      let except: string[] | null = null;
      for (const seg of trailing) {
        if (seg.name !== 'only' && seg.name !== 'except') continue;
        const items = arrayItems(argRanges(seg.a, seg.b)[0]);
        const vals = items ? items.map((it) => lit(it)).filter((x): x is string => x !== null) : [];
        if (!items) continue;
        if (seg.name === 'only') only = vals;
        else except = vals;
      }
      // `photos.comments` -> /photos/{photo}/comments
      const pieces = name.split('.');
      const baseParts = pieces.map((p, idx) => (idx < pieces.length - 1 ? `${p}/{${singular(p.split('/').pop()!)}}` : p));
      const base = joinPaths(prefix, baseParts.join('/'));
      const param = singular(pieces[pieces.length - 1].split('/').pop()!);
      for (const a of RESOURCE_ACTIONS) {
        if (api && !a.api) continue;
        if (only && !only.includes(a.action)) continue;
        if (except && except.includes(a.action)) continue;
        addRoute(ctx, a.method, joinPaths(base, a.suffix.replace('{p}', `{${param}}`)), ctrl ? `${ctrl}.${a.action}` : a.action);
      }
    };

    const scanRegion = (from: number, to: number, ctx: Ctx) => {
      let i = from;
      for (;;) {
        const k = s.indexOf('Route::', i);
        if (k < 0 || k >= to) break;
        if (k > 0 && /\w/.test(s[k - 1])) {
          i = k + 7;
          continue;
        }
        const chain = parseChain(k);
        if (!chain) {
          i = k + 7;
          continue;
        }
        handleChain(chain.segs, ctx);
        i = Math.max(chain.end, k + 7);
      }
    };

    const handleChain = (segs: Seg[], ctx: Ctx) => {
      let mainIdx = segs.findIndex((x) => !MODIFIERS.has(x.name));
      // `Route::group(['prefix' => ...], fn)` is both a modifier-less main segment and carries options.
      if (mainIdx < 0) return;
      const main = segs[mainIdx];
      let prefix = '';
      let controller = ctx.controller;
      for (const m of segs.slice(0, mainIdx)) {
        const args = argRanges(m.a, m.b);
        if (m.name === 'prefix') prefix = joinPaths(prefix, lit(args[0]) ?? '(dynamic)');
        else if (m.name === 'controller') controller = classRef(args[0]) ?? controller;
      }
      const here: Ctx = { holder: ctx.holder, controller };
      const args = argRanges(main.a, main.b);
      const trailing = segs.slice(mainIdx + 1);
      mainIdx = -1;

      if (main.name === 'group') {
        let closure = args[0];
        if (args.length >= 2) {
          // Route::group(['prefix' => 'x', 'controller' => X::class], function () {...})
          const opts = arrayPairs(args[0]);
          const p = opts.get('prefix');
          if (p) prefix = joinPaths(prefix, lit(p) ?? '(dynamic)');
          const c = opts.get('controller');
          if (c) here.controller = classRef(c) ?? here.controller;
          closure = args[1];
        }
        if (!closure) return;
        let child = here.holder;
        if (prefix) {
          child = holderFor(`${f.path}::group${groupCounter++}`, `group ${prefix}`, 'router');
          mounts.push({ parent: here.holder, child, prefix });
        }
        const text = s.slice(closure[0], closure[1]);
        const fnMatch = /^\s*(?:static\s+)?function\b/.exec(text);
        if (fnMatch) {
          const bi = s.indexOf('{', closure[0] + fnMatch[0].length);
          if (bi >= 0 && bi < closure[1]) scanRegion(bi + 1, matchBrace(s, bi), { holder: child, controller: here.controller });
        } else if (/^\s*(?:static\s+)?fn\b/.test(text)) {
          scanRegion(closure[0], closure[1], { holder: child, controller: here.controller });
        }
        return;
      }

      const path0 = (): string => joinPaths(prefix, lit(args[0]) ?? '(dynamic)');
      if (VERBS.has(main.name)) {
        addRoute(here, main.name.toUpperCase(), path0(), handlerOf(args[1], here));
        return;
      }
      if (main.name === 'any') {
        addRoute(here, 'ANY', path0(), handlerOf(args[1], here));
        return;
      }
      if (main.name === 'match') {
        const items = arrayItems(args[0]);
        const methods = items ? items.map((it) => lit(it)?.toUpperCase()).filter((x): x is string => !!x) : [];
        const p = joinPaths(prefix, lit(args[1]) ?? '(dynamic)');
        addRoute(here, methods.length ? methods.join('|') : 'ANY', p, handlerOf(args[2], here));
        return;
      }
      if (main.name === 'redirect') {
        addRoute(here, 'REDIRECT', path0(), `to ${lit(args[1]) ?? '(dynamic)'}`);
        return;
      }
      if (main.name === 'view') {
        addRoute(here, 'GET', path0(), `view ${lit(args[1]) ?? '(dynamic)'}`);
        return;
      }
      if (main.name === 'resource' || main.name === 'apiResource') {
        addResource(here, prefix, lit(args[0]), classRef(args[1]), main.name === 'apiResource', trailing);
        return;
      }
      if (main.name === 'resources' || main.name === 'apiResources') {
        for (const [key, val] of arrayPairs(args[0])) addResource(here, prefix, key, classRef(val), main.name === 'apiResources', trailing);
      }
    };

    // ---- Laravel route DSL ----
    if (s.includes('Route::')) {
      const root = holderFor(`${f.path}::routes`, `routes<br/>${f.path}`, 'app');
      // Laravel serves routes/api.php under /api (RouteServiceProvider / bootstrap/app.php default).
      let ctx: Ctx = { holder: root, controller: null };
      if (/(?:^|\/)routes\/api\.php$/.test(f.path)) {
        const api = holderFor(`${f.path}::api`, 'api prefix', 'router');
        mounts.push({ parent: root, child: api, prefix: '/api' });
        ctx = { holder: api, controller: null };
      }
      scanRegion(0, s.length, ctx);
    }

    // ---- attribute routes ----
    for (const t of php.types) {
      const attrArgs = (a: PhpAttribute): { positional: Array<[number, number]>; named: Map<string, [number, number]> } => {
        const positional: Array<[number, number]> = [];
        const named = new Map<string, [number, number]>();
        for (const [x, y] of splitArgs(a.argsScrubbed, a.args, 0, a.argsScrubbed.length)) {
          const m = /^\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(a.argsScrubbed.slice(x, y));
          if (m) named.set(m[1], [x + m[0].length, y]);
          else positional.push([x, y]);
        }
        return { positional, named };
      };
      const valueOf = (a: PhpAttribute, r: [number, number] | undefined): string | null => (r ? stringValue(a.args.slice(r[0], r[1])) : null);
      const listOf = (a: PhpAttribute, r: [number, number] | undefined): string[] => {
        if (!r) return [];
        const text = a.argsScrubbed.slice(r[0], r[1]).trim();
        if (text.startsWith('[')) {
          const close = matchClose(a.argsScrubbed, r[0] + a.argsScrubbed.slice(r[0], r[1]).indexOf('['));
          if (close < 0) return [];
          const open = r[0] + a.argsScrubbed.slice(r[0], r[1]).indexOf('[');
          return splitArgs(a.argsScrubbed, a.args, open + 1, close)
            .map(([x, y]) => stringValue(a.args.slice(x, y)))
            .filter((v): v is string => v !== null);
        }
        const v = stringValue(a.args.slice(r[0], r[1]));
        return v === null ? [] : [v];
      };
      const routeAttr = (a: PhpAttribute): { path: string; methods: string[] } | null => {
        const { positional, named } = attrArgs(a);
        const lower = a.name;
        const verb = /^(Get|Post|Put|Patch|Delete|Options|Head|Any)$/.exec(lower);
        if (a.name !== 'Route' && !verb) return null;
        const pathRange = named.get('path') ?? positional[0];
        const p = pathRange ? valueOf(a, pathRange) ?? '(dynamic)' : '';
        const methods = verb ? [verb[1] === 'Any' ? 'ANY' : verb[1].toUpperCase()] : listOf(a, named.get('methods')).map((m) => m.toUpperCase());
        return { path: p, methods: methods.length ? methods : ['ANY'] };
      };
      const classRoute = t.attributes.map((a) => (a.name === 'Route' ? routeAttr(a) : null)).find(Boolean) ?? null;
      const spatiePrefix = t.attributes.find((a) => a.name === 'Prefix');
      const classPrefix = (classRoute?.path ?? '') || (spatiePrefix ? valueOf(spatiePrefix, attrArgs(spatiePrefix).positional[0]) ?? '' : '');
      const found: Array<{ method: string; path: string; handler: string }> = [];
      for (const m of t.methods) {
        for (const a of m.attributes) {
          const r = routeAttr(a);
          if (!r) continue;
          for (const meth of r.methods) found.push({ method: meth, path: joinPaths(classPrefix, r.path), handler: `${t.name}.${m.name}` });
        }
      }
      if (found.length === 0 && classRoute && t.methods.some((m) => m.name === '__invoke')) {
        for (const meth of classRoute.methods) found.push({ method: meth, path: joinPaths(classPrefix), handler: `${t.name}.__invoke` });
      }
      if (found.length === 0) continue;
      const holder = holderFor(`${f.path}::${t.name}`, classPrefix ? `${t.name}<br/>${joinPaths(classPrefix)}` : t.name, 'router');
      for (const r of found) routes.push({ holder, method: r.method, path: r.path, handler: r.handler });
    }
  }
  return assembleRouteGraph(holders.values(), routes, mounts);
}

export const phpRouteAnalyzer: CodeAnalyzer = {
  id: 'php-routes',
  displayName: 'Routes (Laravel / Symfony)',
  supportedExtensions: ['.php'],
  analyze: (files) => analyzePhpRoutes(unrollLoops(files, 'php')),
};
