import { CodeGraph, SourceFileInput } from '../analyzer';
import { matchBrace, scrub } from './scrubber';
import { assembleRouteGraph, joinPaths, matchClose, RouteEntry, RouteHolder, splitArgs } from './routeUtils';

/**
 * Spring functional endpoints (WebMvc.fn / WebFlux) for Java and Kotlin, read lexically:
 *
 *   route().GET("/a", h::list).path("/api", b -> b.POST("/x", h::save)).build()     (Java builder)
 *   route(GET("/a"), h::list).andRoute(POST("/b"), h::save)                         (Java classic)
 *   RouterFunctions.route().nest(path("/api"), b -> b.GET(..))                       (Java nest)
 *   router { "/api".nest { GET("/a", h::list); POST("/b") { .. } } }                 (Kotlin DSL, also coRouter)
 *
 * Verbs are the upper-case `GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS` calls whose first argument is a string literal;
 * `nest(path("/x"), ..)`, builder `.path("/x", ..)` and Kotlin `"/x".nest { }` / `path("/x").nest { }` /
 * `("/x" and accept(..)).nest { }` contribute prefixes to the verbs inside their bodies. One router node is shown per
 * file. NOT handled: predicates other than the path string (headers, content types), `RequestPredicates.path` built
 * from constants, routes composed from several RouterFunction beans (`.and(other)` is not followed), `resources(..)`.
 */
const VERB = /(?<![\w$.])(?:(?:RequestPredicates|RouterFunctions)\s*\.\s*)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(|\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g;
const GATE = /\bRouterFunctions?\b|\brouter\s*\{|\bcoRouter\s*\{|\bRequestPredicates\b/;

/** First string literal (original text) inside [from, to), or null. */
function firstString(o: string, s: string, from: number, to: number): string | null {
  for (let i = from; i < to; i++) {
    if (o[i] === '"' && s[i] === ' ') {
      let j = i + 1;
      let out = '';
      while (j < to && o[j] !== '"') {
        if (o[j] === '\\') j++;
        out += o[j] ?? '';
        j++;
      }
      return out;
    }
  }
  return null;
}

function handlerName(o: string, s: string, a: number, b: number): string {
  const text = o.slice(a, b).trim();
  const m = /^(?:this|[A-Za-z_$][\w$.]*)::\s*([A-Za-z_$][\w$]*)/.exec(text);
  if (m) {
    const owner = /^([A-Za-z_$][\w$]*)::/.exec(text);
    return owner && owner[1] !== 'this' ? `${owner[1]}.${m[1]}` : m[1];
  }
  if (/^::\s*([A-Za-z_$][\w$]*)/.test(text)) return text.replace(/^::\s*/, '');
  void s;
  return '(inline)';
}

interface Nest {
  prefix: string;
  from: number;
  to: number;
}

function findNests(o: string, s: string, lang: 'java' | 'kotlin'): Nest[] {
  const out: Nest[] = [];
  // nest(<predicate>, body) and builder .path("/x", body)
  for (const m of s.matchAll(/\b(nest|path)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchClose(s, open);
    if (close < 0) continue;
    const args = splitArgs(s, o, open + 1, close);
    if (args.length === 0) continue;
    if (m[1] === 'path') {
      // Builder form only: a path with a string first argument AND a body argument; the predicate form has one argument.
      if (args.length < 2 || s[m.index! - 1] !== '.') continue;
      const str = firstString(o, s, args[0][0], args[0][1]);
      if (str !== null) out.push({ prefix: str, from: args[1][0], to: close });
    } else {
      if (args.length < 2) continue;
      const str = firstString(o, s, args[0][0], args[0][1]);
      if (str !== null) out.push({ prefix: str, from: args[1][0], to: close });
    }
  }
  if (lang === 'kotlin') {
    // "/x".nest { }, "/x" nest { }, path("/x").nest { }, ("/x" and accept(..)).nest { }
    for (const m of s.matchAll(/\bnest\s*\{/g)) {
      const brace = m.index! + m[0].length - 1;
      const close = matchBrace(s, brace);
      if (close < 0) continue;
      let k = m.index! - 1;
      while (k >= 0 && /[\s.]/.test(o[k])) k--;
      let prefix: string | null = null;
      if (k >= 0 && o[k] === '"' && s[k] === ' ') {
        let st = k - 1;
        while (st >= 0 && !(o[st] === '"' && s[st] === ' ' && o[st - 1] !== '\\')) st--;
        prefix = o.slice(st + 1, k);
      } else if (k >= 0 && s[k] === ')') {
        let depth = 0;
        let st = k;
        for (; st >= 0; st--) {
          if (s[st] === ')') depth++;
          else if (s[st] === '(' && --depth === 0) break;
        }
        if (st >= 0) prefix = firstString(o, s, st, k);
      }
      if (prefix !== null) out.push({ prefix, from: brace, to: close });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

export function springFunctionalRoutes(files: SourceFileInput[], lang: 'java' | 'kotlin'): CodeGraph {
  const holders: RouteHolder[] = [];
  const routes: RouteEntry[] = [];
  for (const f of files) {
    const s = scrub(f.text, lang);
    if (!GATE.test(s)) continue;
    const o = f.text;
    const nests = findNests(o, s, lang);
    const base = f.path.split('/').pop()!.replace(/\.[^.]+$/, '');
    const holder: RouteHolder = { id: `${f.path}::functional`, label: `${base}<br/>functional routes`, kind: 'router' };
    let any = false;
    VERB.lastIndex = 0;
    for (const m of s.matchAll(VERB)) {
      const verb = (m[1] ?? m[2])!;
      const open = m.index! + m[0].length - 1;
      const close = matchClose(s, open);
      if (close < 0) continue;
      const args = splitArgs(s, o, open + 1, close);
      if (args.length === 0) continue;
      const path = firstString(o, s, args[0][0], args[0][1]);
      // Handler: last argument after the path; Kotlin's trailing lambda `GET("/x") { .. }` is inline.
      let handler = args.length > 1 ? handlerName(o, s, args[args.length - 1][0], args[args.length - 1][1]) : '(inline)';
      // Classic form: the verb is the first argument of an enclosing route(..) / andRoute(..) call.
      let depth = 0;
      let enclosing = -1;
      for (let i = m.index! - 1; i >= 0; i--) {
        if (')]}'.includes(s[i])) depth++;
        else if ('([{'.includes(s[i])) {
          if (depth === 0) {
            enclosing = i;
            break;
          }
          depth--;
        }
      }
      if (enclosing >= 0 && s[enclosing] === '(' && /\b(?:andRoute|route)\s*$/.test(s.slice(Math.max(0, enclosing - 12), enclosing))) {
        const ec = matchClose(s, enclosing);
        const eargs = ec > 0 ? splitArgs(s, o, enclosing + 1, ec) : [];
        if (eargs.length > 1 && eargs[0][0] <= m.index! && m.index! < eargs[0][1]) handler = handlerName(o, s, eargs[eargs.length - 1][0], eargs[eargs.length - 1][1]);
      }
      const prefix = joinPaths(...nests.filter((n) => n.from <= m.index! && m.index! < n.to).map((n) => n.prefix));
      const full = path === null ? '(dynamic)' : joinPaths(prefix === '/' ? '' : prefix, path);
      routes.push({ holder, method: verb, path: full, handler });
      any = true;
    }
    if (any) holders.push(holder);
  }
  return assembleRouteGraph(holders, routes, []);
}
