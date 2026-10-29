import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { scrub } from '../common/scrubber';
import { RouteEntry, RouteHolder, RouteMount, assembleRouteGraph, joinPaths, matchClose, splitArgs } from '../common/routeUtils';
import { literal, shortText, lastSegment, readChain } from './rustSyntax';
import { warpRoutes } from './rustWarpRoutes';

/**
 * Rust web-route map for actix-web, axum, Rocket, poem, tide and warp. Syntax-only and
 * name-based, like the other route analyzers: statements are read from text
 * whose strings/comments are blanked, string literals from the comment-stripped
 * original at the same offsets.
 *
 *  - axum: `Router::new()` method chains: `.route("/p", get(h).post(h2))`,
 *    `.nest("/p", sub)`, `.merge(sub)`. `sub` may be an inline chain, a
 *    variable, or a call to a function that returns a router
 *    (`fn api() -> Router`), resolved by name. `app = app.route(..)` rebinding
 *    statements are followed.
 *  - actix-web: `App::new()`, `web::scope("/p")`, `web::resource("/p")` chains
 *    with `.route(..)`/`.service(..)`/`.configure(f)`, `#[get("/p")]`-style
 *    attribute handlers referenced by `.service(handler)`, and functions taking
 *    a `&mut web::ServiceConfig` parameter.
 *  - Rocket: `#[get("/p")]`/`#[route(GET, path = "/p")]` handlers and
 *    `rocket::build().mount("/base", routes![a, b])`.
 *  - poem: `Route::new().at("/p", get(h).post(h2))` and `.nest("/p", sub)` /
 *    `.nest_no_strip`, resolved like axum (inline chain, variable or function).
 *  - tide: `let mut app = tide::new();` then `app.at("/p").get(h).post(h2)`,
 *    chained `.at("/sub")`, `.all(h)`, `.serve_dir(..)` and `app.at("/api").nest(api)`
 *    where `api` is another `tide::new()` variable.
 *  - warp: filter composition is evaluated (`warp::path!`, `.and`, `.or`,
 *    named filters, `-> impl Filter` functions); see rustWarpRoutes.ts.
 *
 *  NOT supported: tower-service style, `.on(MethodFilter, ..)`,
 *  routes added in loops or macros, router builders passed through trait objects
 *  (routers kept in struct fields are followed by field NAME: `Self { router: Router::new().. }`,
 *  `self.router = ..`, `.nest("/p", self.router)`; two structs in one file with the same field name are merged), paths built at runtime (shown as source text),
 *  attribute handlers referenced through a `use` alias, and `mod` namespacing
 *  of equal-named functions (resolution is by the last path segment, same-file
 *  first). A route whose attribute handler cannot be found is omitted. Input
 *  that does not parse never throws; the affected statement is skipped.
 */

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
const METHOD_RE = METHODS.join('|');

/** Comments blanked, string/char literals kept verbatim (offsets preserved). */
export function stripRustComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === 'r' && /^r#*"/.test(text.slice(i, i + 12)) && !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ')) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 12))![1].length;
      const close = '"' + '#'.repeat(hashes);
      const end = text.indexOf(close, i + 2 + hashes);
      i = end === -1 ? n : end + close.length;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === "'") {
      // char literal ('x', '\n', '\u{..}') vs lifetime ('a)
      const m = /^'(?:\\.[^']*|[^\\'])'/.exec(text.slice(i, i + 12));
      i += m ? m[0].length : 1;
    } else i++;
  }
  return out.join('');
}

interface ChainStart {
  /** Offset used to match the chain against an enclosing call's argument. */
  at: number;
  /** Offset where `.method()` calls begin. */
  callsFrom: number;
  holder: RouteHolder;
  prefix: string; // scope/resource path, mounted on the parent
  family: 'axum' | 'actix' | 'rocket' | 'poem';
  resourcePath: string | null;
}

interface PendingMount {
  parent: RouteHolder;
  prefix: string;
  /** Chain start offset in `file`, or a name to resolve later. */
  file: string;
  at?: number;
  name?: string;
}
interface PendingAttr {
  holder: RouteHolder;
  fn: string;
  file: string;
}

function analyze(input: SourceFileInput[]): CodeGraph {
  const holders: RouteHolder[] = [];
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];
  const holderByFileName = new Map<string, RouteHolder>();
  const holdersByName = new Map<string, RouteHolder[]>();
  const holderAt = new Map<string, RouteHolder>(); // `${file}@${offset}`
  const attrs = new Map<string, Array<{ file: string; method: string; path: string }>>();
  const pendingMounts: PendingMount[] = [];
  const pendingAttrs: PendingAttr[] = [];

  const newHolder = (file: string, name: string, label: string, kind: 'app' | 'router', byName: boolean): RouteHolder => {
    const key = `${file}::${name}`;
    const existing = byName ? holderByFileName.get(key) : undefined;
    if (existing) return existing;
    const h: RouteHolder = { id: key, label, kind };
    holders.push(h);
    if (byName) {
      holderByFileName.set(key, h);
      holdersByName.set(name, [...(holdersByName.get(name) ?? []), h]);
    }
    return h;
  };

  const files = (Array.isArray(input) ? input : []).filter((f) => f && typeof f.path === 'string' && /\.rs$/.test(f.path));

  // Pass 1: attribute handlers, so `.service(handler)` / `routes![..]` resolve regardless of file order.
  const parsed = files.map((f) => {
    const text = typeof f.text === 'string' ? f.text : '';
    return { f, s: scrub(text, 'rust'), code: stripRustComments(text) };
  });
  for (const { f, s, code } of parsed) {
    try {
      const attrRe = new RegExp(`#\\[\\s*(?:\\w+\\s*::\\s*)*(${METHOD_RE}|route)\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(s))) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(s, open);
        if (close < 0) continue;
        let method = m[1].toUpperCase();
        let path: string | null;
        const args = splitArgs(s, code, open + 1, close);
        if (m[1] === 'route') {
          const mm = /^\s*([A-Za-z]+)/.exec(code.slice(open + 1, close));
          const pm = /\bpath\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(code.slice(open + 1, close));
          if (!mm || !pm) continue;
          method = mm[1].toUpperCase();
          path = pm[1];
        } else {
          if (!args[0]) continue;
          path = literal(code, args[0][0], args[0][1]);
          if (path === null) path = shortText(code, args[0][0], args[0][1]);
        }
        const tail = s.slice(close + 1);
        const fm = /^\s*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"C"\s+)?fn\s+([A-Za-z_]\w*)/.exec(tail);
        if (!fm) continue;
        attrs.set(fm[1], [...(attrs.get(fm[1]) ?? []), { file: f.path, method, path }]);
      }
    } catch {
      continue;
    }
  }

  // Pass 2: chains.
  for (const { f, s, code } of parsed) {
    try {
      const fnStarts = [...s.matchAll(/\bfn\s+([A-Za-z_]\w*)/g)].map((x) => ({ at: x.index ?? 0, name: x[1] }));
      const enclosingFn = (at: number): string | null => {
        let name: string | null = null;
        for (const fn of fnStarts) {
          if (fn.at < at) name = fn.name;
          else break;
        }
        return name;
      };
      const starts: ChainStart[] = [];
      const declName = (at: number): string | null => {
        const before = s.slice(Math.max(0, at - 160), at);
        const m = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=\s*$/.exec(before);
        if (m) return m[1];
        // Routers kept in struct fields: `Self { router: Router::new()... }` and `self.router = Router::new()...`.
        const fieldInit = /[{,]\s*([A-Za-z_]\w*)\s*:\s*$/.exec(before);
        if (fieldInit) return fieldInit[1];
        const fieldAssign = /\b[A-Za-z_]\w*\s*\.\s*([A-Za-z_]\w*)\s*=\s*$/.exec(before);
        return fieldAssign ? fieldAssign[1] : null;
      };
      const mk = (at: number, callsFrom: number, family: ChainStart['family'], label: string, prefix = '', resourcePath: string | null = null) => {
        const v = declName(at);
        const fnName = enclosingFn(at);
        const name = v ?? fnName;
        // Chains that are call arguments are anonymous; only top-level ones get a lookup name.
        const anon = !v && !isTailOrStatement(s, at);
        const holder = anon || !name
          ? newHolder(f.path, `anon@${at}`, `${label}<br/>${f.path}`, 'router', false)
          : newHolder(f.path, name, `${label} ${name}<br/>${f.path}`, 'app', true);
        holderAt.set(`${f.path}@${at}`, holder);
        starts.push({ at, callsFrom, holder, prefix, family, resourcePath });
      };

      for (const m of s.matchAll(/\bRouter\s*::\s*new\s*\(\s*\)/g)) mk(m.index ?? 0, (m.index ?? 0) + m[0].length, 'axum', 'router');
      // poem's `Route::new()` takes no arguments (Rocket's `Route::new(method, path, handler)` does).
      for (const m of s.matchAll(/\bRoute\s*::\s*new\s*\(\s*\)/g)) mk(m.index ?? 0, (m.index ?? 0) + m[0].length, 'poem', 'router');
      for (const m of s.matchAll(/\bApp\s*::\s*new\s*\(\s*\)/g)) mk(m.index ?? 0, (m.index ?? 0) + m[0].length, 'actix', 'app');
      for (const m of s.matchAll(/\brocket\s*::\s*(?:build|ignite)\s*\(\s*\)/g)) mk(m.index ?? 0, (m.index ?? 0) + m[0].length, 'rocket', 'rocket');
      for (const m of s.matchAll(/\bweb\s*::\s*(scope|resource)\s*\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const close = matchClose(s, open);
        if (close < 0) continue;
        const a0 = splitArgs(s, code, open + 1, close)[0];
        const p = a0 ? literal(code, a0[0], a0[1]) ?? shortText(code, a0[0], a0[1]) : '';
        const label = `${m[1]} ${p}`;
        const h = newHolder(f.path, `anon@${m.index}`, `${label}<br/>${f.path}`, 'router', false);
        holderAt.set(`${f.path}@${m.index}`, h);
        starts.push({ at: m.index ?? 0, callsFrom: close + 1, holder: h, prefix: p, family: 'actix', resourcePath: m[1] === 'resource' ? p : null });
      }
      // Receivers that are re-used across statements: `cfg: &mut web::ServiceConfig` and `app = app.route(..)`.
      const receivers = new Set<string>();
      for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*:\s*&\s*mut\s+(?:web\s*::\s*)?ServiceConfig\b/g)) receivers.add(m[1]);
      for (const name of receivers) {
        for (const m of s.matchAll(new RegExp(`\\b${name}\\s*(?=\\.\\s*(?:service|route|configure)\\s*\\()`, 'g'))) {
          const at = m.index ?? 0;
          const fnName = enclosingFn(at) ?? name;
          const h = newHolder(f.path, fnName, `config ${fnName}<br/>${f.path}`, 'app', true);
          starts.push({ at, callsFrom: at + name.length, holder: h, prefix: '', family: 'actix', resourcePath: null });
        }
      }
      // `self.router = self.router.route(..)`: the same rebinding through a field.
      for (const m of s.matchAll(/\b[A-Za-z_]\w*\s*\.\s*([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*\s*\.\s*\1\s*(?=\.\s*(?:route|nest|merge|service)\s*\()/g)) {
        const at = m.index ?? 0;
        const h = holderByFileName.get(`${f.path}::${m[1]}`);
        if (!h) continue;
        const callsFrom = at + m[0].length;
        const family = /\.\s*(?:service)\s*\(/.test(s.slice(callsFrom, callsFrom + 12)) ? 'actix' : 'axum';
        starts.push({ at, callsFrom, holder: h, prefix: '', family, resourcePath: null });
      }
      for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*=\s*\1\s*(?=\.\s*(?:route|nest|merge|service)\s*\()/g)) {
        const at = m.index ?? 0;
        const h = holderByFileName.get(`${f.path}::${m[1]}`);
        if (!h) continue;
        const callsFrom = at + m[0].length;
        const family = /\.\s*(?:service)\s*\(/.test(s.slice(callsFrom, callsFrom + 12)) ? 'actix' : 'axum';
        starts.push({ at, callsFrom, holder: h, prefix: '', family, resourcePath: null });
      }

      for (const st of starts) {
        const calls = readChain(s, st.callsFrom);
        for (const call of calls) {
          const args = splitArgs(s, code, call.open + 1, call.close);
          const argText = (k: number) => (args[k] ? code.slice(args[k][0], args[k][1]).trim() : '');
          const argAt = (k: number) => {
            if (!args[k]) return -1;
            let a = args[k][0];
            while (a < args[k][1] && /\s/.test(s[a])) a++;
            return a;
          };
          const addMountFromArg = (k: number, prefix: string) => {
            const t = argText(k);
            const at = argAt(k);
            if (at >= 0 && holderAt.has(`${f.path}@${at}`)) {
              mounts.push({ parent: st.holder, child: holderAt.get(`${f.path}@${at}`)!, prefix });
              return;
            }
            const call0 = /^(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*(?:::<[^>]*>)?\s*\(\s*\)$/.exec(t);
            const var0 = /^(?:&\s*)?(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)$/.exec(t);
            // A router kept in a field: `self.router`, `state.router.clone()`.
            const field0 = /^&?\s*[A-Za-z_]\w*\s*\.\s*([A-Za-z_]\w*)(?:\s*\.\s*(?:clone|to_owned)\s*\(\s*\))?$/.exec(t);
            const name = call0?.[1] ?? var0?.[1] ?? field0?.[1];
            if (name) pendingMounts.push({ parent: st.holder, prefix, file: f.path, name });
          };
          const pathArg = (k: number): string => {
            if (!args[k]) return '';
            return literal(code, args[k][0], args[k][1]) ?? shortText(code, args[k][0], args[k][1]);
          };

          if (st.family === 'axum' || st.family === 'poem') {
            if ((call.name === 'route' || (st.family === 'poem' && call.name === 'at')) && args[1]) {
              const path = pathArg(0);
              const mr = code.slice(args[1][0], args[1][1]);
              const ms = s.slice(args[1][0], args[1][1]);
              const re = new RegExp(`(?<![\\w])(?:routing\\s*::\\s*)?(${METHOD_RE}|any)\\s*\\(`, 'g');
              let mm: RegExpExecArray | null;
              let found = false;
              while ((mm = re.exec(ms))) {
                const o = mm.index + mm[0].length - 1;
                const c = matchClose(ms, o);
                if (c < 0) continue;
                const hargs = splitArgs(ms, mr, o + 1, c);
                routes.push({ holder: st.holder, method: mm[1].toUpperCase(), path, handler: hargs[0] ? shortText(mr, hargs[0][0], hargs[0][1]) : '' });
                found = true;
                re.lastIndex = c + 1;
              }
              if (!found) routes.push({ holder: st.holder, method: 'ANY', path, handler: shortText(code, args[1][0], args[1][1]) });
            } else if ((call.name === 'nest' || (st.family === 'poem' && call.name === 'nest_no_strip')) && args[1]) addMountFromArg(1, pathArg(0));
            else if (call.name === 'merge' && args[0]) addMountFromArg(0, '');
          } else if (st.family === 'actix') {
            if (call.name === 'route') {
              // App/scope: .route("/p", web::get().to(h)); resource: .route(web::get().to(h))
              const exprIdx = args.length >= 2 ? 1 : 0;
              const path = args.length >= 2 ? pathArg(0) : '';
              const expr = args[exprIdx] ? code.slice(args[exprIdx][0], args[exprIdx][1]) : '';
              const mm = new RegExp(`\\bweb\\s*::\\s*(${METHOD_RE})\\s*\\(\\s*\\)\\s*(?:\\.\\s*to\\s*\\(([^)]*)\\))?`).exec(expr);
              if (mm) routes.push({ holder: st.holder, method: mm[1].toUpperCase(), path, handler: mm[2] ? shortText(mm[2], 0, mm[2].length) : '' });
            } else if (call.name === 'to' && st.resourcePath !== null && args[0]) {
              routes.push({ holder: st.holder, method: 'ANY', path: '', handler: shortText(code, args[0][0], args[0][1]) });
            } else if (call.name === 'service' && args[0]) {
              const t = argText(0);
              const at = argAt(0);
              const child = at >= 0 ? holderAt.get(`${f.path}@${at}`) : undefined;
              if (child) {
                const cs = starts.find((x) => x.holder === child);
                mounts.push({ parent: st.holder, child, prefix: cs?.prefix ?? '' });
              } else if (/^(?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*$/.test(t)) {
                pendingAttrs.push({ holder: st.holder, fn: lastSegment(t), file: f.path });
              }
            } else if (call.name === 'configure' && args[0]) addMountFromArg(0, '');
          } else if (st.family === 'rocket') {
            if (call.name === 'mount' && args[1]) {
              const prefix = pathArg(0);
              const h = newHolder(f.path, `anon@${call.open}`, `mount ${prefix}<br/>${f.path}`, 'router', false);
              mounts.push({ parent: st.holder, child: h, prefix });
              const list = /\broutes\s*!\s*\[([^\]]*)\]/.exec(code.slice(args[1][0], args[1][1]));
              if (list) {
                for (const name of list[1].split(',').map((x) => x.trim()).filter(Boolean)) {
                  pendingAttrs.push({ holder: h, fn: lastSegment(name), file: f.path });
                }
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // tide: `let mut app = tide::new(); app.at("/p").get(h).post(h2); app.at("/api").nest(api);`
  for (const { f, s, code } of parsed) {
    try {
      for (const m of s.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=\s*tide\s*::\s*(?:new|with_state|Server\s*::\s*(?:new|with_state))\s*(?:::<[^>]*>)?\s*\(/g)) {
        const name = m[1];
        const holder = newHolder(f.path, name, `app ${name}<br/>${f.path}`, 'app', true);
        for (const at of s.matchAll(new RegExp(`\\b${name}\\s*\\.\\s*at\\s*\\(`, 'g'))) {
          const open = (at.index ?? 0) + at[0].length - 1;
          const close = matchClose(s, open);
          if (close < 0) continue;
          const a0 = splitArgs(s, code, open + 1, close)[0];
          let path = a0 ? literal(code, a0[0], a0[1]) ?? shortText(code, a0[0], a0[1]) : '';
          for (const call of readChain(s, close + 1)) {
            const args = splitArgs(s, code, call.open + 1, call.close);
            if (call.name === 'at' && args[0]) path = joinPaths(path, literal(code, args[0][0], args[0][1]) ?? shortText(code, args[0][0], args[0][1]));
            else if (call.name === 'nest' && args[0]) {
              const t = code.slice(args[0][0], args[0][1]).trim();
              // a variable, or a block expression ending in one: `nest({ let mut api = tide::new(); ..; api })`
              const child = /^&?\s*(?:mut\s+)?([A-Za-z_]\w*)$/.exec(t)?.[1] ?? /^\{[\s\S]*?\b([A-Za-z_]\w*)\s*;?\s*\}$/.exec(t)?.[1];
              if (child) pendingMounts.push({ parent: holder, prefix: path, file: f.path, name: child });
            } else if (call.name === 'serve_dir' || call.name === 'serve_file') routes.push({ holder, method: 'GET', path, handler: call.name === 'serve_dir' ? 'static dir' : 'static file' });
            else if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'connect', 'trace', 'all'].includes(call.name) && args[0]) {
              const h = code.slice(args[0][0], args[0][1]);
              routes.push({ holder, method: call.name === 'all' ? 'ANY' : call.name.toUpperCase(), path, handler: /^\s*(?:move\s*)?\|/.test(h) ? '(inline)' : shortText(code, args[0][0], args[0][1]) });
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // warp: filters are evaluated rather than matched (see rustWarpRoutes.ts); one holder per file.
  try {
    for (const w of warpRoutes(parsed.map(({ f, s, code }) => ({ file: f.path, s, code })))) {
      const holder = newHolder(w.file, 'warp', `warp filters<br/>${w.file}`, 'app', true);
      routes.push({ holder, method: w.method, path: w.path, handler: w.handler });
    }
  } catch {
    // a filter expression this module cannot read is skipped
  }

  // Resolve name-based mounts and attribute handlers now that every file is read.
  for (const pm of pendingMounts) {
    const cands = holdersByName.get(pm.name ?? '') ?? [];
    const child = cands.find((h) => h.id.startsWith(pm.file + '::')) ?? cands[0];
    if (child && child !== pm.parent) mounts.push({ parent: pm.parent, child, prefix: pm.prefix });
  }
  for (const pa of pendingAttrs) {
    const cands = attrs.get(pa.fn) ?? [];
    const a = cands.find((x) => x.file === pa.file) ?? cands[0];
    if (a) routes.push({ holder: pa.holder, method: a.method, path: a.path, handler: pa.fn });
  }

  return assembleRouteGraph(holders, routes, mounts);
}

/** True when the expression at `at` is a statement start or a function's tail expression, not a call argument. */
function isTailOrStatement(s: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(s[i])) i--;
  const c = s[i];
  return i < 0 || c === '{' || c === ';' || c === '}' || c === '|' /* closure body */ || (s.slice(Math.max(0, i - 5), i + 1) === 'return');
}

export const rustRouteAnalyzer: CodeAnalyzer = {
  id: 'rust-routes',
  displayName: 'Web Routes (Rust)',
  supportedExtensions: ['.rs'],
  analyze: (files) => analyze(unrollLoops(files, 'rust')),
};
