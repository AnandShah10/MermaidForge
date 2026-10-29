import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { matchBrace, scrub, splitTopLevel } from '../common/scrubber';
import { springFunctionalRoutes } from '../common/springFunctional';
import { assembleRouteGraph, joinPaths, RouteEntry, RouteHolder, RouteMount } from '../common/routeUtils';
import { KotlinAnnotation, KotlinFun, parseKotlin } from './kotlinAnalyzer';

/**
 * Web-route maps for Kotlin: Spring MVC / WebFlux annotations and the Ktor routing DSL. Syntax-only.
 *
 * Spring: `@RestController` / `@Controller` classes, class-level `@RequestMapping`, method-level `@GetMapping`,
 * `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping(method = [..])`; path
 * arguments positional or `value = ` / `path = `, as `"/a"`, `["/a", "/b"]` or `arrayOf("/a")`.
 *
 * Ktor: every `routing { .. }` block is an app holder; a function with a `Route` / `Routing` receiver
 * (`fun Route.userRoutes() { .. }`) is a router holder, mounted wherever it is called from inside a routing
 * block (with the enclosing `route("/x") { }` prefix). Inside a block: `get` / `post` / `put` / `delete` /
 * `patch` / `head` / `options` (`get("/x") { }`, `get { }`, typed `get<Resource> { }`), `route("/p") { }`
 * (prefix), `route("/p", HttpMethod.Post) { }`, `method(HttpMethod.X) { }`, `webSocket("/ws") { }`,
 * `staticResources` / `staticFiles` / `static`, and transparent blocks (`authenticate { }`, `rateLimit { }`,
 * `param`, `header`, `accept`, `contentType`, `host`, `port`).
 *
 * NOT handled: paths built from constants, concatenation or string templates (shown as "(dynamic)"),
 * user-defined route-scoping helpers other than the transparent ones above, `install(..)` plugins that add
 * routes, Ktor `Resources` paths declared on `@Resource` classes (the resource type is shown instead),
 * routes registered in loops or lambdas that are passed around, Spring functional endpoints beyond literal paths
 * (`router { }` / `coRouter { }` are read, see springFunctional.ts), Spring Cloud Gateway, meta-annotations, and class-level `@RequestMapping(method = ..)`
 * constraints. Handler names for Ktor are the first scanned function the handler body calls, else "(inline)".
 */

const SPRING_VERBS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const HTTP_WORDS = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b/gi;

// ---------- Spring ----------

interface Seg {
  name: string | null;
  orig: string;
  scrubbed: string;
}

/** Splits annotation arguments on top-level commas, keeping original and scrubbed slices in step. */
function splitSegs(orig: string, scrubbed: string, named: boolean): Seg[] {
  const out: Seg[] = [];
  let depth = 0;
  let from = 0;
  const push = (to: number) => {
    const s = scrubbed.slice(from, to);
    const o = orig.slice(from, to);
    if (!s.trim() && !o.trim()) return;
    const m = named ? /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(s) : null;
    out.push({ name: m ? m[1] : null, orig: m ? o.slice(m[0].length) : o, scrubbed: m ? s.slice(m[0].length) : s });
  };
  for (let i = 0; i < scrubbed.length; i++) {
    const c = scrubbed[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(scrubbed.length);
  return out;
}

/** Path strings of a mapping annotation (`value`/`path`, positional or named, single, `[..]` or `arrayOf(..)`). `''` when none given. */
function pathsOf(a: KotlinAnnotation | undefined): string[] {
  if (!a) return [''];
  const segs = splitSegs(a.args, a.argsScrubbed, true);
  const seg = segs.find((s) => s.name === 'value' || s.name === 'path') ?? segs.find((s) => s.name === null);
  if (!seg) return [''];
  let o = seg.orig;
  let s = seg.scrubbed;
  const lead = s.length - s.trimStart().length;
  const trail = s.trimEnd().length;
  const arr = /^(\[|arrayOf\s*\(|listOf\s*\()/.exec(s.slice(lead));
  if (arr) {
    const open = lead + arr[0].length;
    const closeCh = arr[1] === '[' ? ']' : ')';
    if (s[trail - 1] === closeCh) {
      o = o.slice(open, trail - 1);
      s = s.slice(open, trail - 1);
    }
  }
  const paths: string[] = [];
  for (const el of splitSegs(o, s, false)) {
    if (/[^\s+]/.test(el.scrubbed)) {
      paths.push('(dynamic)');
      continue;
    }
    const strs = [...el.orig.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (strs.some((x) => x.includes('$'))) paths.push('(dynamic)');
    else if (strs.length) paths.push(strs.join(''));
  }
  return paths.length ? paths : [''];
}

function methodsOf(a: KotlinAnnotation): string[] {
  const seg = splitSegs(a.args, a.argsScrubbed, true).find((s) => s.name === 'method');
  const found = seg ? [...new Set([...seg.scrubbed.matchAll(HTTP_WORDS)].map((m) => m[1].toUpperCase()))] : [];
  return found.length ? found : ['ANY'];
}

function joinPath(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).filter(Boolean);
  return '/' + segs.join('/');
}

function springRoutes(files: SourceFileInput[]): CodeGraph {
  const nodes: CodeGraph['nodes'] = [];
  const edges: CodeGraph['edges'] = [];
  const ids = new Set<string>();
  const uniq = (base: string) => {
    let id = base;
    let n = 2;
    while (ids.has(id)) id = `${base}#${n++}`;
    ids.add(id);
    return id;
  };
  for (const f of files) {
    for (const t of parseKotlin(f.text).types) {
      const has = (n: string) => t.annotations.find((a) => a.name === n);
      if (!has('RestController') && !has('Controller')) continue;
      const prefixes = pathsOf(has('RequestMapping'));
      const shown = prefixes.filter((p) => p !== '').map((p) => (p === '(dynamic)' ? p : joinPath(p)));
      const routerId = uniq(`${f.path}::${t.name}`);
      nodes.push({ id: routerId, label: shown.length ? `${t.name}<br/>${shown.join(', ')}` : t.name, kind: 'router' });
      const addRoute = (verb: string, sub: string, m: KotlinFun) => {
        for (const prefix of prefixes) {
          const full = prefix === '(dynamic)' || sub === '(dynamic)' ? `${prefix === '(dynamic)' ? '(dynamic)' : joinPath(prefix)}${sub ? '/' + sub.replace(/^\//, '') : ''}` : joinPath(prefix, sub);
          const id = uniq(`${f.path}::${t.name}.${m.name}::${verb} ${full}`);
          nodes.push({ id, label: `${verb} ${full}<br/>${t.name}.${m.name}`, kind: 'route' });
          edges.push({ from: routerId, to: id, kind: 'route' });
        }
      };
      for (const m of t.funs) {
        if (m.isConstructor) continue;
        for (const a of m.annotations) {
          const verb = SPRING_VERBS[a.name];
          if (verb) for (const p of pathsOf(a)) addRoute(verb, p, m);
          else if (a.name === 'RequestMapping') for (const v of methodsOf(a)) for (const p of pathsOf(a)) addRoute(v, p, m);
        }
      }
    }
  }
  return { nodes, edges };
}

// ---------- Ktor ----------

const KTOR_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const KTOR_TRANSPARENT = new Set(['authenticate', 'rateLimit', 'param', 'optionalParam', 'header', 'accept', 'contentType', 'host', 'port']);
const KTOR_STATIC = new Set(['static', 'staticResources', 'staticFiles', 'staticRootFolder']);
const KTOR_WS = new Set(['webSocket', 'webSocketRaw']);

interface KtorFile {
  path: string;
  text: string; // scrubbed
  orig: string;
}

function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** A single string-literal argument (no templates, no concatenation), else null. */
function literalArg(origArg: string): string | null {
  const m = /^\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(origArg);
  return m && !m[1].includes('$') ? m[1] : null;
}

function ktorRoutes(files: SourceFileInput[]): CodeGraph {
  const kfiles: KtorFile[] = files.map((f) => ({ path: f.path, orig: f.text, text: scrub(f.text, 'kotlin') }));
  const holders = new Map<string, RouteHolder>();
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];

  // Route-receiver extension functions are holders; the set of all scanned function names types the handler guess.
  interface RouteFun {
    name: string;
    file: KtorFile;
    holder: RouteHolder;
    bodyStart: number;
    bodyEnd: number;
  }
  const routeFuns: RouteFun[] = [];
  const knownFuns = new Set<string>();
  for (const k of kfiles) {
    const parsed = parseKotlin(k.orig);
    for (const fn of parsed.topFuns) knownFuns.add(fn.name);
    for (const t of parsed.types) for (const fn of t.funs) knownFuns.add(fn.name);
    for (const fn of parsed.topFuns) {
      if ((fn.receiver === 'Route' || fn.receiver === 'Routing') && fn.hasBody) {
        const holder: RouteHolder = { id: `${k.path}::Route.${fn.name}`, label: `Route.${fn.name}<br/>${k.path}`, kind: 'router' };
        holders.set(holder.id, holder);
        // Locate the body in the file text so offsets line up with the original.
        const m = new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:Route|Routing)\\.${fn.name}\\s*\\(`).exec(k.text);
        let bodyStart = -1;
        let bodyEnd = -1;
        if (m) {
          let depth = 0;
          let i = m.index + m[0].length - 1;
          for (; i < k.text.length; i++) {
            if (k.text[i] === '(') depth++;
            else if (k.text[i] === ')' && --depth === 0) break;
          }
          let j = i + 1;
          while (j < k.text.length && k.text[j] !== '{' && k.text[j] !== '=' ) j++;
          if (k.text[j] === '{') {
            bodyStart = j + 1;
            bodyEnd = matchBrace(k.text, j);
          } else if (k.text[j] === '=') {
            // expression body: `fun Route.r() = route("/x") { .. }` — scan to the end of the lambda
            const b = k.text.indexOf('{', j);
            if (b >= 0) {
              bodyStart = j + 1;
              bodyEnd = matchBrace(k.text, b) + 1;
            }
          }
        }
        if (bodyStart >= 0) routeFuns.push({ name: fn.name, file: k, holder, bodyStart, bodyEnd });
      }
    }
  }
  const routeFunsByName = new Map<string, RouteFun[]>();
  for (const r of routeFuns) routeFunsByName.set(r.name, [...(routeFunsByName.get(r.name) ?? []), r]);

  const pickRouteFun = (name: string, from: KtorFile): RouteFun | null => {
    const list = routeFunsByName.get(name);
    if (!list) return null;
    return list.find((r) => r.file === from) ?? (list.length === 1 ? list[0] : null);
  };

  const skipWsT = (t: string, i: number, end: number): number => {
    while (i < end && /\s/.test(t[i])) i++;
    return i;
  };
  const closeOf = (t: string, open: number, o: string, c: string): number => {
    let d = 0;
    for (let i = open; i < t.length; i++) {
      if (t[i] === o) d++;
      else if (t[i] === c && --d === 0) return i;
    }
    return t.length;
  };

  /** First scanned function the handler lambda calls, else '(inline)'. */
  const handlerName = (t: string, from: number, to: number, argsText: string): string => {
    const ref = /::\s*([A-Za-z_]\w*)/.exec(argsText);
    if (ref) return ref[1];
    const re = /(?<![\w.])([A-Za-z_]\w*)\s*\(/g;
    const seg = t.slice(from, to);
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) if (knownFuns.has(m[1])) return m[1];
    return '(inline)';
  };

  const scanBlock = (k: KtorFile, from: number, to: number, holder: RouteHolder, prefix: string): void => {
    const t = k.text;
    let i = from;
    while (i < to) {
      const c = t[i];
      if (!/[A-Za-z_]/.test(c) || /[\w$]/.test(t[i - 1] ?? ' ')) {
        // skip nested blocks / parens that are not part of a recognised call
        if (c === '{') i = Math.min(matchBrace(t, i) + 1, to);
        else if (c === '(') i = closeOf(t, i, '(', ')') + 1;
        else i++;
        continue;
      }
      let e = i;
      while (e < to && /\w/.test(t[e])) e++;
      const name = t.slice(i, e);
      // a member call (`call.respond(..)`, `x.get(..)`) is not a route, except `this.name(..)`
      let b = i - 1;
      while (b >= from && /[ \t]/.test(t[b])) b--;
      const memberCall = t[b] === '.' && !/\bthis\s*$/.test(t.slice(Math.max(from, b - 6), b));
      let j = skipWsT(t, e, to);
      let typeArg = '';
      if (t[j] === '<') {
        let d = 0;
        let q = j;
        for (; q < to; q++) {
          if (t[q] === '<') d++;
          else if (t[q] === '>' && t[q - 1] !== '-' && --d === 0) break;
        }
        typeArg = t.slice(j + 1, q).trim();
        j = skipWsT(t, q + 1, to);
      }
      let argsFrom = -1;
      let argsTo = -1;
      if (t[j] === '(') {
        argsFrom = j + 1;
        argsTo = closeOf(t, j, '(', ')');
        j = skipWsT(t, argsTo + 1, to);
      }
      let lamFrom = -1;
      let lamTo = -1;
      if (t[j] === '{') {
        lamFrom = j + 1;
        lamTo = matchBrace(t, j);
        j = lamTo + 1;
      }
      const next = Math.max(j, e);
      const argsOrig = argsFrom >= 0 ? k.orig.slice(argsFrom, argsTo) : '';
      const argsScr = argsFrom >= 0 ? t.slice(argsFrom, argsTo) : '';
      const firstArg = argsFrom >= 0 ? splitTopLevel(argsOrig, ',', false)[0] ?? '' : '';
      const pathOfArgs = (): string => {
        if (argsFrom < 0 || !argsOrig.trim()) return '';
        const lit = literalArg(firstArg);
        return lit !== null ? lit : /^\s*"/.test(firstArg) || /^\s*[A-Za-z_]/.test(firstArg) ? '(dynamic)' : '';
      };
      if (memberCall) {
        i = next;
        continue;
      }
      if (KTOR_VERBS.has(name) && (argsFrom >= 0 || lamFrom >= 0 || typeArg)) {
        const handler = lamFrom >= 0 ? handlerName(t, lamFrom, lamTo, argsScr) : handlerName(t, 0, 0, argsScr);
        const p = typeArg && !argsOrig.trim() ? '' : pathOfArgs();
        routes.push({ holder, method: name.toUpperCase(), path: joinPaths(prefix, p === '(dynamic)' ? '(dynamic)' : p), handler: typeArg ? `${typeArg}${handler === '(inline)' ? '' : ` ${handler}`}` : handler });
      } else if (name === 'route' && argsFrom >= 0 && lamFrom >= 0) {
        const p = pathOfArgs();
        const verb = /HttpMethod\.(\w+)/.exec(argsScr)?.[1];
        const full = joinPaths(prefix, p);
        if (verb) routes.push({ holder, method: verb.toUpperCase(), path: full, handler: handlerName(t, lamFrom, lamTo, argsScr) });
        else scanBlock(k, lamFrom, lamTo, holder, full);
      } else if (name === 'method' && argsFrom >= 0 && lamFrom >= 0) {
        const verb = /HttpMethod\.(\w+)/.exec(argsScr)?.[1];
        if (verb) routes.push({ holder, method: verb.toUpperCase(), path: joinPaths(prefix), handler: handlerName(t, lamFrom, lamTo, argsScr) });
      } else if (KTOR_WS.has(name) && argsFrom >= 0) {
        routes.push({ holder, method: 'WS', path: joinPaths(prefix, pathOfArgs()), handler: lamFrom >= 0 ? handlerName(t, lamFrom, lamTo, argsScr) : '(inline)' });
      } else if (KTOR_STATIC.has(name) && argsFrom >= 0 && name !== 'staticRootFolder') {
        routes.push({ holder, method: 'STATIC', path: joinPaths(prefix, pathOfArgs()), handler: '' });
      } else if (KTOR_TRANSPARENT.has(name) && lamFrom >= 0) {
        scanBlock(k, lamFrom, lamTo, holder, prefix);
      } else if (argsFrom >= 0 || argsFrom < 0) {
        const target = lamFrom < 0 ? pickRouteFun(name, k) : null;
        if (target && target.holder.id !== holder.id) mounts.push({ parent: holder, child: target.holder, prefix: prefix === '' ? '' : joinPaths(prefix) });
      }
      i = next;
    }
  };

  for (const k of kfiles) {
    const handled: Array<[number, number]> = [];
    const inHandled = (idx: number) => handled.some(([a, b]) => idx >= a && idx < b);
    // `routing { .. }` and `routing(..) { .. }` anywhere in the file
    const re = /(?<![\w$])routing\s*(\(|\{)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(k.text))) {
      if (inHandled(m.index)) continue;
      let open = m.index + m[0].length - 1;
      if (k.text[open] === '(') {
        const close = closeOf(k.text, open, '(', ')');
        open = skipWsT(k.text, close + 1, k.text.length);
        if (k.text[open] !== '{') continue;
      }
      const close = matchBrace(k.text, open);
      handled.push([open, close + 1]);
      const holder: RouteHolder = { id: `${k.path}::routing@${lineOf(k.text, m.index)}`, label: `routing<br/>${k.path}`, kind: 'app' };
      holders.set(holder.id, holder);
      scanBlock(k, open + 1, close, holder, '');
    }
  }
  for (const r of routeFuns) {
    scanBlock(r.file, r.bodyStart, r.bodyEnd, r.holder, '');
  }
  return assembleRouteGraph(holders.values(), routes, mounts);
}

// ---------- analyzer ----------

export function analyzeKotlinRoutes(files: SourceFileInput[]): CodeGraph {
  const spring = springRoutes(files);
  const ktor = ktorRoutes(files);
  const fn = springFunctionalRoutes(files, 'kotlin');
  return { nodes: [...spring.nodes, ...ktor.nodes, ...fn.nodes], edges: [...spring.edges, ...ktor.edges, ...fn.edges] };
}

export const kotlinRouteAnalyzer: CodeAnalyzer = {
  id: 'kotlin-routes',
  displayName: 'Routes (Spring / Ktor)',
  supportedExtensions: ['.kt', '.kts'],
  analyze: (files) => analyzeKotlinRoutes(unrollLoops(files, 'kotlin')),
};
