import { matchClose, splitArgs } from '../common/routeUtils';
import { literal, readChain, shortText } from './rustSyntax';

/**
 * warp routes. warp has no router object: a route is a *filter* built by
 * composing smaller filters, so this module evaluates filter expressions
 * instead of matching a call shape.
 *
 *  - Primaries: `warp::path!("a" / "b" / u32)` (non-literal parts become
 *    `{u32}`), `warp::path("a")`, `warp::path::param::<T>()`, `path::end()`,
 *    `path::tail()` (`*`), the method filters `warp::get()/post()/put()/
 *    delete()/patch()/head()/options()`, `warp::ws()` (WS) and `warp::fs::dir`
 *    (static files). Filters that add neither a path nor a method
 *    (`warp::body::json()`, `warp::header(..)`, `with_db(db.clone())`,
 *    `warp::any()`) are transparent.
 *  - Composition: `a.and(b)` concatenates (path segments in order, last
 *    method wins), `a.or(b)` adds an alternative and later `.and(..)` applies
 *    to every alternative (warp's own semantics), so each `.or` branch becomes
 *    its own route. `.map(h)` / `.and_then(h)` / `.then(h)` name the handler
 *    (a closure shows as `(inline)`).
 *  - Names: filters bound with `let name = ...;` and functions returning
 *    `impl Filter` / `BoxedFilter` are followed (also across files, by name).
 *  - Roots: the argument of `warp::serve(..)`; with no `serve` in a file, the
 *    `let` filters and filter functions nothing else references.
 *
 * NOT supported: filters assembled in loops or macros, `warp::path` with a
 * runtime-built segment (shown as source text), custom filters that add path
 * segments internally (they are transparent), `warp::query` shapes, `or`
 * chains built with `.or_else`/`combine!`, and `filters::path::path` aliases
 * through `use`.
 */

interface Alt {
  segs: string[];
  method: string | null;
  handler: string | null;
}

export interface WarpRoute {
  file: string;
  method: string;
  path: string;
  handler: string;
}

interface Src {
  file: string;
  s: string;
  code: string;
}

const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);
const HANDLER_CALLS = new Set(['map', 'and_then', 'then']);

/** Body expressions: `let name = <expr>;` bindings and `fn name(..) -> impl Filter { <tail> }`. */
interface Def {
  src: Src;
  a: number;
  b: number;
}

function tailExpr(s: string, a: number, b: number): [number, number] {
  let depth = 0;
  let last = a;
  for (let i = a; i < b; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) last = i + 1;
  }
  let st = last;
  while (st < b && /\s/.test(s[st])) st++;
  if (/^return\b/.test(s.slice(st, st + 7))) st += 6;
  let en = b;
  while (en > st && /[\s;]/.test(s[en - 1])) en--;
  return [st, en];
}

export function warpRoutes(sources: Src[]): WarpRoute[] {
  if (!sources.some((x) => /\bwarp\b/.test(x.s))) return [];
  const lets = new Map<string, Def[]>(); // by variable name
  const fns = new Map<string, Def>(); // filter-returning fns by name
  const refCount = new Map<string, number>();
  const serves: Array<{ src: Src; a: number; b: number }> = [];

  for (const src of sources) {
    try {
      const { s } = src;
      if (!/\bwarp\b/.test(s)) continue;
      for (const m of s.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=(?!=)/g)) {
        const a = (m.index ?? 0) + m[0].length;
        let depth = 0;
        let e = a;
        for (; e < s.length; e++) {
          const c = s[e];
          if ('([{'.includes(c)) depth++;
          else if (')]}'.includes(c)) {
            if (depth === 0) break;
            depth--;
          } else if (c === ';' && depth === 0) break;
        }
        // Every binding is kept: `let api = filters::todos(db);` has no warp text of its own, and unrelated
        // bindings simply evaluate to a transparent filter.
        if (e > a) lets.set(m[1], [...(lets.get(m[1]) ?? []), { src, a, b: e }]);
      }
      for (const m of s.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchClose(s, open);
        if (close < 0) continue;
        const head = /^\s*->\s*([^{]*)\{/.exec(s.slice(close + 1, close + 300));
        if (!head || !/\b(?:Filter|BoxedFilter)\b/.test(head[1])) continue;
        const body = close + 1 + head[0].length - 1;
        const end = matchClose(s, body);
        if (end < 0) continue;
        const [ta, tb] = tailExpr(s, body + 1, end);
        fns.set(m[1], { src, a: ta, b: tb });
      }
      for (const m of s.matchAll(/\bwarp\s*::\s*serve\s*\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchClose(s, open);
        if (close > open) serves.push({ src, a: open + 1, b: close });
      }
    } catch {
      continue;
    }
  }

  const trim = (s: string, a: number, b: number): [number, number] => {
    while (a < b && /\s/.test(s[a])) a++;
    while (b > a && /\s/.test(s[b - 1])) b--;
    return [a, b];
  };

  const evalExpr = (src: Src, a0: number, b0: number, depth: number, trail: Set<string>): Alt[] => {
    const { s, code } = src;
    let [a, b] = trim(s, a0, b0);
    if (a >= b || depth > 8) return [{ segs: [], method: null, handler: null }];
    while (s[a] === '&') [a, b] = trim(s, a + 1, b);
    if (s[a] === '(' && matchClose(s, a) === b - 1) return evalExpr(src, a + 1, b - 1, depth + 1, trail);

    let alts: Alt[] = [{ segs: [], method: null, handler: null }];
    let chainFrom = a;

    const prim = /^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*(!)?\s*(?:::<([^>]*)>\s*)?(\()?/.exec(s.slice(a, b));
    if (prim) {
      const raw = prim[1].replace(/\s+/g, '');
      const name = raw.replace(/^warp::/, '').replace(/^filters::/, '');
      const hasCall = !!prim[4];
      const open = a + prim[0].length - 1;
      const close = hasCall ? matchClose(s, open) : -1;
      chainFrom = hasCall && close >= 0 ? close + 1 : a + prim[0].length;
      const argSpans = hasCall && close >= 0 ? splitArgs(s, code, open + 1, close) : [];
      const only = (alt: Partial<Alt>): Alt[] => [{ segs: alt.segs ?? [], method: alt.method ?? null, handler: alt.handler ?? null }];

      if (prim[2] && name === 'path') {
        // path!("a" / "b" / u32) — split on top-level `/`
        const segs: string[] = [];
        let depthP = 0;
        let start = open + 1;
        const push = (x: number, y: number) => {
          const [ta, tb] = trim(code, x, y); // `s` has string literals blanked, so emptiness must be judged on `code`
          if (ta >= tb) return;
          const lit = literal(code, ta, tb);
          if (lit !== null) segs.push(lit);
          else if (code.slice(ta, tb).trim() === '..') segs.push('*');
          else segs.push(`{${code.slice(ta, tb).trim()}}`);
        };
        for (let i = open + 1; i < close; i++) {
          const c = s[i];
          if ('([{<'.includes(c)) depthP++;
          else if (')]}>'.includes(c)) depthP--;
          else if (c === '/' && depthP === 0) {
            push(start, i);
            start = i + 1;
          }
        }
        push(start, close);
        alts = only({ segs });
      } else if (name === 'path' && hasCall) {
        const a0s = argSpans[0];
        alts = only({ segs: a0s ? [literal(code, a0s[0], a0s[1]) ?? `{${shortText(code, a0s[0], a0s[1])}}`] : [] });
      } else if (name === 'path::param') {
        alts = only({ segs: [`{${prim[3]?.trim() || 'param'}}`] });
      } else if (name === 'path::tail') alts = only({ segs: ['*'] });
      else if (name === 'path::end' || name === 'path::full' || name === 'any') alts = only({});
      else if (METHODS.has(name) && hasCall) alts = only({ method: name.toUpperCase() });
      else if (name === 'ws' && hasCall) alts = only({ method: 'WS' });
      else if (/^fs::(dir|file)$/.test(name)) alts = only({ handler: `static ${name.slice(4)}` });
      else if (hasCall && fns.has(name.split('::').pop()!)) {
        const key = `fn:${name.split('::').pop()}`;
        const def = fns.get(name.split('::').pop()!)!;
        if (!trail.has(key)) {
          trail.add(key);
          alts = evalExpr(def.src, def.a, def.b, depth + 1, trail);
          trail.delete(key);
        }
      } else if (!hasCall && !prim[2] && lets.has(name)) {
        const key = `let:${name}`;
        const def = (lets.get(name) ?? []).find((d) => d.src === src) ?? lets.get(name)![0];
        if (!trail.has(key)) {
          trail.add(key);
          alts = evalExpr(def.src, def.a, def.b, depth + 1, trail);
          trail.delete(key);
        }
      }
      // anything else (body::json(), header(..), with_db(..), unknown) is transparent
    }

    // `.and(x)`, `.or(x)`, `.map(h)`, ... applied left to right.
    for (const call of readChain(s, chainFrom)) {
      if (call.open > b) break;
      const args = splitArgs(s, code, call.open + 1, call.close);
      if (call.name === 'and' && args[0]) {
        const rhs = evalExpr(src, args[0][0], args[0][1], depth + 1, trail);
        const next: Alt[] = [];
        // An operand that adds neither path nor method is an extractor (`with_db(db)` is `warp::any().map(move || db.clone())`):
        // its closure is not the route handler and must not replace one that is already known.
        for (const l of alts) for (const r of rhs) next.push({ segs: [...l.segs, ...r.segs], method: r.method ?? l.method, handler: r.segs.length || r.method || r.handler?.startsWith('static ') ? r.handler ?? l.handler : l.handler });
        alts = next;
      } else if (call.name === 'or' && args[0]) {
        alts = [...alts, ...evalExpr(src, args[0][0], args[0][1], depth + 1, trail)];
      } else if (HANDLER_CALLS.has(call.name) && args[0]) {
        // A closure's own parameter list contains commas, so judge it on the whole argument text.
        const whole = code.slice(call.open + 1, call.close);
        const h = /^\s*(?:async\s+)?(?:move\s*)?\|/.test(whole) ? '(inline)' : shortText(code, args[0][0], args[0][1]);
        alts = alts.map((x) => ({ ...x, handler: x.handler ?? h }));
      }
    }
    return alts;
  };

  const out: WarpRoute[] = [];
  const seen = new Set<string>();
  const emit = (src: Src, alts: Alt[]) => {
    for (const alt of alts) {
      const path = '/' + alt.segs.join('/');
      const r: WarpRoute = { file: src.file, method: alt.method ?? 'ANY', path, handler: alt.handler ?? '' };
      const key = `${r.file}|${r.method}|${r.path}|${r.handler}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  };

  if (serves.length) {
    for (const sv of serves) emit(sv.src, evalExpr(sv.src, sv.a, sv.b, 0, new Set()));
  } else {
    // Library-style files: evaluate every filter definition nothing else refers to.
    const all: Array<{ name: string; def: Def }> = [];
    for (const [name, defs] of lets) for (const def of defs) all.push({ name, def });
    for (const [name, def] of fns) all.push({ name, def });
    for (const { name } of all) refCount.set(name, 0);
    for (const src of sources) {
      for (const { name } of all) {
        const n = (src.s.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        refCount.set(name, (refCount.get(name) ?? 0) + n);
      }
    }
    for (const { name, def } of all) {
      // 1 reference = the definition itself
      if ((refCount.get(name) ?? 0) > 1) continue;
      const alts = evalExpr(def.src, def.a, def.b, 0, new Set()).filter((x) => x.segs.length || x.method || x.handler);
      emit(def.src, alts);
    }
  }
  return out;
}
