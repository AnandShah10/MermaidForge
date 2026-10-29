import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { scrub } from '../common/scrubber';
import { assembleRouteGraph, joinPaths, matchClose, RouteEntry, RouteHolder, RouteMount, splitArgs } from '../common/routeUtils';

/**
 * Ruby web routes: the Rails routes DSL (`config/routes.rb`, `routes.draw do ... end`) and Sinatra (classic top-level
 * routes, `Sinatra::Base` / `Sinatra::Application` subclasses, `namespace` from sinatra-contrib).
 *
 * Read lexically: strings and comments are blanked (`scrub(text, 'ruby')`, offsets preserved) so structure is found
 * reliably, and literal values are read from the original text at the same offsets. The file is cut into logical
 * statements (a line continues while it ends in `,`, `=>` or `\`), `do ... end` blocks are paired, and the DSL is
 * interpreted by walking those blocks.
 *
 * Shape of the result: each routes file is an `app` node; `namespace` / `scope` with a path is a `router` node mounted
 * under its parent with that prefix, so full paths show whenever a route is reachable by one chain. Handlers are
 * labelled the way Rails prints them (`admin/users#show`); Sinatra handlers are blocks and are labelled `(block)`.
 *
 * Supported (Rails): `get/post/put/patch/delete/options/head/match` (path as string, symbol or `"/p" => "c#a"`, with
 * `to:`, `controller:`, `action:`, `via:`), `root`, `resources` / `resource` (the 7 / 6 standard routes, `only:`,
 * `except:`, `path:`, `controller:`, `module:`, `param:`, several names per call), nesting, `member` / `collection`,
 * `namespace`, `scope` (path / module / controller), `controller :x do`, `concern` + `concerns` (also `concerns:` on
 * resources), `mount X => '/p'` / `mount X, at: '/p'`, `redirect(...)`, `constraints`/`defaults`/`authenticate` and
 * `if`/`unless` blocks (their bodies are read as if unconditional, so both branches of an `if/else` appear).
 *
 * `shallow` (block and option) and `draw :file` (config/routes/file.rb is inlined when scanned) and `devise_for` (modules read from the model's `devise` call when the model is scanned, else the Devise defaults; `only`/`skip`/`path`/`controllers` honoured) are handled. NOT handled:
 * `resources ... as:`, `only:` / `except:` on `concerns`, `direct`/`resolve`, `scope` with `constraints` that change
 * paths, `(.:format)` expansion (paths are shown as written), irregular plurals (`resource :person` is served by
 * `people`: only a trailing `s` / `y -> ies` is applied), dynamically built paths (shown as `(dynamic)`), Sinatra
 * routes defined through `route(...)`, `Sinatra.register`, `map`/`run` in `config.ru`, regex or `%r{}` paths, and
 * Grape / Hanami / Roda routers.
 */

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const NON_DSL_OPENERS = /^(?:if|unless|case|while|until|begin|for|def|class|module)\b/;

interface Stmt {
  s: number;
  e: number;
  S: string;
  /** Block opener: where its argument text ends (before `do`), else -1. */
  opener: number;
  isEnd: boolean;
  /** Matching `end` statement index (openers only), else -1. */
  endIdx: number;
  /** A `{`-block opener or its closing `}` (brace blocks of the routes DSL), handled like `do` … `end`. */
  forced?: 'open' | 'close';
}

interface Arg {
  /** Range of the whole argument. */
  a: number;
  b: number;
  /** `key:` / `:key =>` / `'str' =>` option name, when the argument is one. */
  key: string | null;
  /** Value range (the whole argument when positional). */
  va: number;
  vb: number;
}

const IRREGULAR: Array<[string, string]> = [['person', 'people'], ['man', 'men'], ['woman', 'women'], ['child', 'children'], ['foot', 'feet'], ['tooth', 'teeth'], ['goose', 'geese'], ['mouse', 'mice'], ['ox', 'oxen'], ['datum', 'data'], ['medium', 'media'], ['criterion', 'criteria'], ['analysis', 'analyses'], ['basis', 'bases'], ['crisis', 'crises'], ['diagnosis', 'diagnoses'], ['thesis', 'theses'], ['index', 'indices'], ['matrix', 'matrices'], ['vertex', 'vertices'], ['quiz', 'quizzes'], ['status', 'statuses'], ['alias', 'aliases'], ['bus', 'buses'], ['cactus', 'cacti'], ['leaf', 'leaves'], ['life', 'lives'], ['wife', 'wives'], ['knife', 'knives'], ['half', 'halves'], ['move', 'moves'], ['sex', 'sexes'], ['zombie', 'zombies']];
const UNCOUNTABLE = new Set(['equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep', 'jeans', 'police', 'news', 'metadata', 'feedback', 'settings', 'sms']);
/** Rails' ActiveSupport inflections for the common cases: irregular and uncountable words, then the regular suffix rules. */
const singular = (w: string): string => {
  if (UNCOUNTABLE.has(w)) return w;
  for (const [sing, plur] of IRREGULAR) {
    if (w === plur) return sing;
    if (w.endsWith('_' + plur)) return w.slice(0, -plur.length) + sing;
  }
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(analys|bas|crisis|diagnos|thes)es$/.test(w)) return w.replace(/es$/, 'is');
  if (/ies$/.test(w) && w.length > 4) return w.replace(/ies$/, 'y');
  if (/(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/ves$/.test(w)) return w.replace(/ves$/, 'f');
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
};
const plural = (w: string): string => {
  if (UNCOUNTABLE.has(w)) return w;
  for (const [sing, plur] of IRREGULAR) {
    if (w === sing) return plur;
    if (w.endsWith('_' + sing)) return w.slice(0, -sing.length) + plur;
  }
  if (/[^aeiou]y$/.test(w)) return w.replace(/y$/, 'ies');
  if (/(s|sh|ch|x|z)$/.test(w)) return `${w}es`;
  return `${w}s`;
};

/** Length of `line` once a trailing `# comment` (outside quotes) and trailing blanks are removed. */
function codeLength(line: string): number {
  let q = '';
  let end = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
    } else if (c === "'" || c === '"') q = c;
    else if (c === '#') {
      end = i;
      break;
    }
  }
  return line.slice(0, end).replace(/\s+$/, '').length;
}

function buildStatements(ls: string, lo: string): Stmt[] {
  const out: Stmt[] = [];
  const re = /[^\n]*(?:\n|$)/g;
  let pendingStart = -1;
  for (let m = re.exec(lo); m && m[0] !== ''; m = re.exec(lo)) {
    const lineStart = m.index;
    const trimmedEnd = lineStart + codeLength(m[0]);
    const lead = m[0].length - m[0].replace(/^\s+/, '').length;
    if (trimmedEnd <= lineStart + lead) continue;
    const start = pendingStart >= 0 ? pendingStart : lineStart + lead;
    if (/(?:,|=>|\\)$/.test(lo.slice(lineStart, trimmedEnd))) {
      if (pendingStart < 0) pendingStart = start;
      continue;
    }
    pendingStart = -1;
    const T = ls.slice(start, trimmedEnd).replace(/\s+$/, '');
    const BRACE_WORD = /^(?:member|collection|constraints|scope|namespace|concern|resources?|controller|defaults|authenticate|devise_scope)\b/;
    // `member { get :x; post :y }` on one line: an opener, one statement per `;` segment, a closer.
    const one = /^((?:member|collection|constraints|scope|namespace|concern|controller|defaults)\b[^{]*?)\s*\{([^{}]*)\}$/.exec(T);
    if (one && BRACE_WORD.test(T)) {
      const headEnd = start + one[1].length;
      out.push({ s: start, e: headEnd, S: one[1], opener: -1, isEnd: false, endIdx: -1, forced: 'open' });
      const innerStart = start + T.indexOf('{') + 1;
      let segStart = innerStart;
      for (const seg of one[2].split(';')) {
        const lead = seg.length - seg.replace(/^\s+/, '').length;
        const text = seg.trim();
        if (text) out.push({ s: segStart + lead, e: segStart + lead + text.length, S: ls.slice(segStart + lead, segStart + lead + text.length), opener: -1, isEnd: false, endIdx: -1 });
        segStart += seg.length + 1;
      }
      out.push({ s: trimmedEnd - 1, e: trimmedEnd, S: '}', opener: -1, isEnd: false, endIdx: -1, forced: 'close' });
      continue;
    }
    const open = /^(.*?)\s*\{(?:\s*\|[^|]*\|)?$/.exec(T);
    if (open && BRACE_WORD.test(T) && !/=\s*\{$/.test(T)) {
      out.push({ s: start, e: start + open[1].length, S: open[1], opener: -1, isEnd: false, endIdx: -1, forced: 'open' });
      continue;
    }
    if (T === '}') {
      out.push({ s: start, e: trimmedEnd, S: '}', opener: -1, isEnd: false, endIdx: -1, forced: 'close' });
      continue;
    }
    out.push({ s: start, e: trimmedEnd, S: T, opener: -1, isEnd: false, endIdx: -1 });
  }
  const stack: number[] = [];
  out.forEach((st, i) => {
    const t = st.S;
    if (st.forced === 'open') {
      st.opener = st.e;
      stack.push(i);
      return;
    }
    if (st.forced === 'close' && !(stack.length && out[stack[stack.length - 1]].forced === 'open')) return; // a `}` that closes something else
    if (st.forced === 'close' || /^end\b/.test(t)) {
      st.isEnd = true;
      const o = stack.pop();
      if (o !== undefined) out[o].endIdx = i;
      return;
    }
    const doM = /(?:^|[\s)])do(?:\s*\|[^|]*\|)?$/.exec(t);
    if (doM && !/\bend$/.test(t)) {
      st.opener = st.s + doM.index + (doM[0].startsWith('do') ? 0 : 1);
      stack.push(i);
      return;
    }
    if (NON_DSL_OPENERS.test(t) && !/\bend$/.test(t) && !(/^def\b/.test(t) && /^def\s+[^=(]*(?:\([^)]*\))?\s*=[^=~>]/.test(t))) {
      st.opener = st.e;
      stack.push(i);
    }
  });
  return out;
}

interface Lex {
  ls: string;
  lo: string;
}

/** Unquoted string literal or `:symbol` (also `:"x"`); null for anything else (interpolation included). */
function literal(text: string): string | null {
  const t = text.trim();
  let m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(t);
  if (m) return /#\{/.test(m[2]) && m[1] === '"' ? null : m[2];
  m = /^:(?:(['"])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_]\w*[?!]?))$/.exec(t);
  return m ? (m[2] ?? m[3]) : null;
}

/** Elements of `[:a, 'b']`, `%i[a b]`, `%w[a b]` or a single literal. */
function listValues(text: string): string[] {
  const t = text.trim();
  const pct = /^%[iwIW][\[({<](.*)[\])}>]$/s.exec(t);
  if (pct) return pct[1].split(/\s+/).filter(Boolean);
  const arr = /^\[(.*)\]$/s.exec(t);
  if (arr) return arr[1].split(',').map((x) => literal(x)).filter((x): x is string => x !== null);
  const one = literal(t);
  return one === null ? [] : [one];
}

function parseArgs(lx: Lex, a: number, b: number): Arg[] {
  const out: Arg[] = [];
  for (const [x, y] of splitArgs(lx.ls, lx.lo, a, b)) {
    const text = lx.lo.slice(x, y);
    let m = /^\s*([A-Za-z_]\w*):(?!:)\s*/.exec(text);
    if (m && /^\s*[A-Za-z_]\w*:/.test(lx.ls.slice(x, y))) {
      out.push({ a: x, b: y, key: m[1], va: x + m[0].length, vb: y });
      continue;
    }
    m = /^\s*(?::([A-Za-z_]\w*)|(['"])((?:\\.|(?!\2)[^\\])*)\2)\s*=>\s*/.exec(text);
    if (m && /=>/.test(lx.ls.slice(x, y))) {
      out.push({ a: x, b: y, key: m[1] ?? m[3], va: x + m[0].length, vb: y });
      continue;
    }
    out.push({ a: x, b: y, key: null, va: x, vb: y });
  }
  return out;
}

/** Argument range of a command statement `name args` / `name(args)`; `limit` is where the statement's args end. */
function argRange(lx: Lex, st: Stmt, nameEnd: number, limit: number): [number, number] {
  let i = nameEnd;
  while (i < limit && /[ \t]/.test(lx.lo[i])) i++;
  if (lx.ls[i] === '(' ) {
    const close = matchClose(lx.ls, i);
    if (close > 0 && close < limit) return [i + 1, close];
  }
  void st;
  return [i, limit];
}

interface RCtx {
  holder: RouteHolder;
  /** Holder-relative path prefix for routes defined here. */
  path: string;
  mod: string;
  ctrl: string | null;
  res: ResCtx | null;
  scope: 'member' | 'collection' | null;
  /** Inside `shallow do` or under `shallow: true`: nested resources keep their member routes un-nested. */
  shallow: boolean;
}
interface ResCtx {
  /** Base path before the outermost resource (where shallow member routes live). */
  root: string;
  /** Controller (already module-qualified). */
  ctrl: string;
  collection: string;
  member: string;
  nested: string;
}

/** Modules assumed when the model that calls `devise` is not in the scan. */
const DEVISE_DEFAULT = ['database_authenticatable', 'registerable', 'recoverable', 'rememberable', 'validatable'];
/** Routes Devise generates per controller, keyed by the module that enables them. */
const DEVISE_ROUTES: Array<[string, string, Array<[string, string, string]>]> = [
  ['sessions', 'database_authenticatable', [['GET', 'sign_in', 'new'], ['POST', 'sign_in', 'create'], ['DELETE', 'sign_out', 'destroy']]],
  ['passwords', 'recoverable', [['GET', 'password/new', 'new'], ['GET', 'password/edit', 'edit'], ['PATCH|PUT', 'password', 'update'], ['POST', 'password', 'create']]],
  ['registrations', 'registerable', [['GET', 'cancel', 'cancel'], ['GET', 'sign_up', 'new'], ['GET', 'edit', 'edit'], ['PATCH|PUT', '', 'update'], ['DELETE', '', 'destroy'], ['POST', '', 'create']]],
  ['confirmations', 'confirmable', [['GET', 'confirmation/new', 'new'], ['GET', 'confirmation', 'show'], ['POST', 'confirmation', 'create']]],
  ['unlocks', 'lockable', [['GET', 'unlock/new', 'new'], ['GET', 'unlock', 'show'], ['POST', 'unlock', 'create']]],
];

export function analyzeRubyRoutes(inputs: SourceFileInput[]): CodeGraph {
  // `draw :admin` inlines config/routes/admin.rb at the call (so it sees the surrounding namespace/scope); inlined files
  // are not analysed again on their own.
  const included = new Set<string>();
  const inline = (f: SourceFileInput, depth: number): string =>
    f.text.replace(/^[ \t]*draw\s*\(?\s*[:'"](\w+)['"]?\s*\)?[ \t]*$/gm, (m, nm: string) => {
      const target = inputs.find((x) => x.path.endsWith(`config/routes/${nm}.rb`));
      if (!target || depth > 3) return m;
      included.add(target.path);
      return inline(target, depth + 1);
    });
  const files: SourceFileInput[] = inputs.map((f) => ({ path: f.path, text: inline(f, 0) }));
  // Model -> modules named in its `devise :a, :b` call.
  const deviseModules = new Map<string, string[]>();
  for (const f of inputs) {
    let sc: string;
    try {
      sc = scrub(f.text, 'ruby');
    } catch {
      continue;
    }
    for (const m of sc.matchAll(/^[ \t]*devise[ \t]+((?:[^\n]*,[ \t]*\n)*[^\n]*)/gm)) {
      const cls = [...sc.slice(0, m.index!).matchAll(/\bclass\s+([A-Z]\w*)/g)].pop();
      if (cls) deviseModules.set(cls[1], [...m[1].matchAll(/:(\w+)/g)].map((x) => x[1]));
    }
  }
  const holders = new Map<string, RouteHolder>();
  const routes: RouteEntry[] = [];
  const mounts: RouteMount[] = [];
  let counter = 0;
  const holderFor = (id: string, label: string, kind: RouteHolder['kind']): RouteHolder => {
    let h = holders.get(id);
    if (!h) {
      h = { id, label, kind };
      holders.set(id, h);
    }
    return h;
  };

  for (const f of files) {
    if (included.has(f.path)) continue;
    let ls: string;
    try {
      ls = scrub(f.text, 'ruby');
    } catch {
      continue;
    }
    const lx: Lex = { ls, lo: f.text };
    const isRails = /\broutes\.(?:draw|append|prepend)\b/.test(ls) || /(?:^|\/)config\/routes(?:\/[^/]*)?\.rb$/.test(f.path);
    const isSinatra = !isRails && (/\bSinatra\b/.test(ls) || /\brequire\s*\(?\s*['"]sinatra/.test(f.text));
    if (!isRails && !isSinatra) continue;
    const stmts = buildStatements(ls, f.text);
    const concerns = new Map<string, [number, number]>();
    const valueOf = (x: Arg | undefined): string | null => (x ? literal(lx.lo.slice(x.va, x.vb)) : null);
    const opt = (args: Arg[], key: string): Arg | undefined => args.find((a) => a.key === key);

    const headOf = (st: Stmt): { name: string; args: Arg[] } | null => {
      const m = /^([A-Za-z_]\w*[?!]?)/.exec(st.S);
      if (!m) return null;
      const limit = st.opener >= 0 ? st.opener : st.e;
      const [a, b] = argRange(lx, st, st.s + m[0].length, limit);
      return { name: m[1], args: parseArgs(lx, a, b) };
    };

    // ================= Rails =================
    const addRoute = (ctx: RCtx, method: string, path: string, handler: string) => routes.push({ holder: ctx.holder, method, path, handler });
    const qualify = (ctx: RCtx, ctrl: string): string => (ctx.mod ? `${ctx.mod}/${ctrl}` : ctrl);
    const baseOf = (ctx: RCtx): string => (ctx.res ? (ctx.scope === 'member' ? ctx.res.member : ctx.scope === 'collection' ? ctx.res.collection : ctx.res.nested) : ctx.path);

    const handlerFrom = (ctx: RCtx, args: Arg[], pathName: string | null): string => {
      const to = opt(args, 'to');
      if (to) {
        const text = lx.lo.slice(to.va, to.vb).trim();
        const red = /^redirect\s*\(?\s*(.*?)\)?\s*$/s.exec(text);
        if (red && /^redirect\b/.test(text)) return `redirect ${literal(red[1]) ?? '(dynamic)'}`;
        const v = literal(text);
        if (v !== null) {
          const h = /^([^#]+)#(\w+)$/.exec(v);
          if (h) return `${qualify(ctx, h[1])}#${h[2]}`;
          return v;
        }
        if (/^(?:->|lambda\b|proc\b|Proc\.new)/.test(text)) return '(lambda)';
        if (/^[A-Z][\w:]*$/.test(text)) return `${text} (rack)`;
        return '(dynamic)';
      }
      const ctrlOpt = valueOf(opt(args, 'controller'));
      const actOpt = valueOf(opt(args, 'action'));
      const ctrl = ctrlOpt ? qualify(ctx, ctrlOpt) : ctx.res ? ctx.res.ctrl : ctx.ctrl ? qualify(ctx, ctx.ctrl) : null;
      const action = actOpt ?? (pathName && /^[A-Za-z_]\w*$/.test(pathName.split('/').pop()!) && (ctx.res || ctx.ctrl || ctrlOpt) ? pathName.split('/').pop()! : null);
      if (ctrl && action) return `${ctrl}#${action}`;
      if (!ctrl && pathName) {
        const m = /^\/?([A-Za-z_]\w*)\/([A-Za-z_]\w*)$/.exec(pathName);
        if (m) return `${qualify(ctx, m[1])}#${m[2]}`;
      }
      return '(unresolved)';
    };

    /** Path argument of a verb: positional literal, or the key of a `'/p' => 'c#a'` pair. */
    const pathArg = (args: Arg[]): { path: string | null; pair: Arg | null } => {
      const first = args[0];
      if (!first) return { path: null, pair: null };
      if (first.key !== null && /=>/.test(lx.ls.slice(first.a, first.b))) return { path: first.key, pair: first };
      if (first.key !== null) return { path: null, pair: null };
      return { path: literal(lx.lo.slice(first.va, first.vb)), pair: null };
    };

    const resourceRoutes = (ctx: RCtx, names: Arg[], opts: Arg[], singularRes: boolean, body: Stmt | null, bodyRange: [number, number] | null) => {
      const only = opt(opts, 'only') ? listValues(lx.lo.slice(opt(opts, 'only')!.va, opt(opts, 'only')!.vb)) : null;
      const except = opt(opts, 'except') ? listValues(lx.lo.slice(opt(opts, 'except')!.va, opt(opts, 'except')!.vb)) : [];
      const modOpt = valueOf(opt(opts, 'module'));
      const paramOpt = valueOf(opt(opts, 'param')) ?? 'id';
      const ctrlOpt = valueOf(opt(opts, 'controller'));
      const pathOpt = valueOf(opt(opts, 'path'));
      const concernOpt = opt(opts, 'concerns') ? listValues(lx.lo.slice(opt(opts, 'concerns')!.va, opt(opts, 'concerns')!.vb)) : [];
      for (const n of names) {
        if (n.key !== null) continue;
        const name = literal(lx.lo.slice(n.va, n.vb));
        if (name === null) {
          addRoute(ctx, 'RESOURCE', '(dynamic)', '(dynamic)');
          continue;
        }
        const seg = pathOpt ?? name;
        const inner: RCtx = { ...ctx, mod: modOpt ? qualify(ctx, modOpt) : ctx.mod };
        const ctrl = ctrlOpt ? qualify(inner, ctrlOpt) : qualify(inner, singularRes ? plural(name) : name);
        const collection = joinPaths(baseOf(ctx), seg);
        const paramSeg = paramOpt === 'id' ? `${singular(name)}_id` : `${singular(name)}_${paramOpt}`;
        const shallowNested = ctx.shallow && ctx.res !== null && !singularRes;
        const root = ctx.res ? ctx.res.root : baseOf(ctx);
        const member = singularRes ? collection : shallowNested ? joinPaths(root, seg, `:${paramOpt}`) : joinPaths(collection, `:${paramOpt}`);
        const nested = singularRes ? collection : shallowNested ? joinPaths(root, seg, `:${paramSeg}`) : joinPaths(collection, `:${paramSeg}`);
        const actions: Array<[string, string, string]> = singularRes
          ? [
              ['new', 'GET', joinPaths(collection, 'new')],
              ['create', 'POST', collection],
              ['show', 'GET', collection],
              ['edit', 'GET', joinPaths(collection, 'edit')],
              ['update', 'PATCH|PUT', collection],
              ['destroy', 'DELETE', collection],
            ]
          : [
              ['index', 'GET', collection],
              ['create', 'POST', collection],
              ['new', 'GET', joinPaths(collection, 'new')],
              ['edit', 'GET', joinPaths(member, 'edit')],
              ['show', 'GET', member],
              ['update', 'PATCH|PUT', member],
              ['destroy', 'DELETE', member],
            ];
        for (const [action, method, p] of actions) {
          if (only && !only.includes(action)) continue;
          if (except.includes(action)) continue;
          addRoute(ctx, method, p, `${ctrl}#${action}`);
        }
        const child: RCtx = { ...inner, res: { ctrl, collection, member, nested, root }, scope: null, shallow: ctx.shallow || lx.lo.slice(opt(opts, 'shallow')?.va ?? 0, opt(opts, 'shallow')?.vb ?? 0).trim() === 'true' };
        for (const c of concernOpt) replayConcern(c, child);
        if (body && bodyRange) walk(bodyRange[0], bodyRange[1], child);
      }
    };

    const replayConcern = (name: string, ctx: RCtx) => {
      const r = concerns.get(name);
      if (r) walk(r[0], r[1], ctx);
    };

    const handleRails = (i: number, ctx: RCtx): number => {
      const st = stmts[i];
      const end = st.opener >= 0 && st.endIdx >= 0 ? st.endIdx : i;
      const body: [number, number] = [i + 1, st.endIdx >= 0 ? st.endIdx : stmts.length];
      const hasBlock = st.opener >= 0 && !NON_DSL_OPENERS.test(st.S);
      const h = headOf(st);
      if (!h) return end;
      const { name, args } = h;

      if (st.opener >= 0 && NON_DSL_OPENERS.test(st.S)) {
        if (/^(?:if|unless|case|begin)\b/.test(st.S)) walk(body[0], body[1], ctx);
        return end;
      }

      if (VERBS.has(name) || name === 'match') {
        const { path, pair } = pathArg(args);
        const handlerArgs = pair ? [{ ...pair, key: 'to', va: pair.va, vb: pair.vb }, ...args.slice(1)] : args;
        const via = opt(args, 'via');
        const viaVals = via ? listValues(lx.lo.slice(via.va, via.vb)) : [];
        const method = name === 'match' ? (viaVals.length && !viaVals.includes('all') ? viaVals.map((v) => v.toUpperCase()).join('|') : 'ANY') : name.toUpperCase();
        const p = path === null ? '(dynamic)' : path;
        // `get :feed, on: :collection` / `on: :member` inside `resources` picks the collection or member base path.
        const onVal = valueOf(opt(args, 'on'));
        const vctx: RCtx = ctx.res && (onVal === 'collection' || onVal === 'member') ? { ...ctx, scope: onVal } : ctx;
        const full = path === null ? '(dynamic)' : joinPaths(baseOf(vctx), p);
        addRoute(vctx, method, full, handlerFrom(vctx, handlerArgs, path));
        return end;
      }
      if (name === 'root') {
        const to = args.find((a) => a.key === null || a.key === 'to');
        const v = to ? literal(lx.lo.slice(to.va, to.vb)) : null;
        const hd = v ? (/^([^#]+)#(\w+)$/.exec(v) ? `${qualify(ctx, v.split('#')[0])}#${v.split('#')[1]}` : v) : '(dynamic)';
        addRoute(ctx, 'GET', joinPaths(baseOf(ctx)), hd);
        return end;
      }
      if (name === 'resources' || name === 'resource') {
        const names = args.filter((a) => a.key === null);
        const opts = args.filter((a) => a.key !== null);
        resourceRoutes(ctx, names, opts, name === 'resource', hasBlock ? st : null, hasBlock ? body : null);
        return end;
      }
      if (name === 'shallow' && hasBlock) {
        walk(body[0], body[1], { ...ctx, shallow: true });
        return end;
      }
      if (name === 'devise_for') {
        const only = opt(args, 'only') ? listValues(lx.lo.slice(opt(args, 'only')!.va, opt(args, 'only')!.vb)) : null;
        const skip = opt(args, 'skip') ? listValues(lx.lo.slice(opt(args, 'skip')!.va, opt(args, 'skip')!.vb)) : [];
        const overrides = new Map<string, string>();
        const co = opt(args, 'controllers');
        if (co) for (const m of lx.lo.slice(co.va, co.vb).matchAll(/(\w+):\s*['"]([^'"]+)['"]|:(\w+)\s*=>\s*['"]([^'"]+)['"]/g)) overrides.set(m[1] ?? m[3], m[2] ?? m[4]);
        for (const a of args) {
          if (a.key !== null) continue;
          const nm = valueOf(a);
          if (!nm) continue;
          const model = singular(nm).replace(/(?:^|_)([a-z])/g, (_m, c: string) => c.toUpperCase());
          const mods = deviseModules.get(model) ?? DEVISE_DEFAULT;
          const base = joinPaths(baseOf(ctx), valueOf(opt(args, 'path')) ?? nm);
          for (const [kind, mod, list] of DEVISE_ROUTES) {
            if (!mods.includes(mod) || skip.includes(kind) || (only && !only.includes(kind))) continue;
            const ctrl = overrides.get(kind) ?? `devise/${kind}`;
            for (const [method, sub, action] of list) addRoute(ctx, method, joinPaths(base, sub), `${ctrl}#${action}`);
          }
        }
        return end;
      }
      if (name === 'concern' && hasBlock) {
        const n = valueOf(args[0]);
        if (n) concerns.set(n, body);
        return end;
      }
      if (name === 'concerns') {
        for (const a of args) {
          const v = valueOf(a);
          if (v && a.key === null) replayConcern(v, ctx);
        }
        return end;
      }
      if ((name === 'member' || name === 'collection') && hasBlock) {
        walk(body[0], body[1], { ...ctx, scope: name });
        return end;
      }
      if (name === 'mount') {
        const first = args[0];
        if (first) {
          const atOpt = valueOf(opt(args, 'at'));
          let target: string;
          let at: string | null = atOpt;
          const arrow = lx.ls.slice(first.a, first.b).indexOf('=>');
          if (arrow >= 0) {
            target = lx.lo.slice(first.a, first.a + arrow).trim();
            at = at ?? literal(lx.lo.slice(first.a + arrow + 2, first.b));
          } else {
            target = lx.lo.slice(first.a, first.b).trim();
          }
          addRoute(ctx, 'MOUNT', at === null ? '(dynamic)' : joinPaths(baseOf(ctx), at), target.replace(/^['"]|['"]$/g, ''));
        }
        return end;
      }
      if ((name === 'namespace' || name === 'scope') && hasBlock) {
        const first = args.find((a) => a.key === null);
        const firstVal = first ? valueOf(first) : null;
        const pathOpt = valueOf(opt(args, 'path'));
        const modOpt = valueOf(opt(args, 'module'));
        const ctrlOpt = valueOf(opt(args, 'controller'));
        let seg = '';
        let mod = ctx.mod;
        if (name === 'namespace') {
          const n = firstVal ?? '(dynamic)';
          seg = pathOpt ?? n;
          mod = qualify(ctx, modOpt ?? n);
        } else {
          seg = pathOpt ?? firstVal ?? '';
          if (modOpt) mod = qualify(ctx, modOpt);
        }
        const next: RCtx = { ...ctx, mod, ctrl: ctrlOpt ?? ctx.ctrl, path: ctx.path, res: ctx.res, scope: ctx.scope };
        if (seg) {
          const prefix = joinPaths(baseOf(ctx), seg);
          const child = holderFor(`${f.path}::${name}${counter++}`, `${name} ${prefix}`, 'router');
          mounts.push({ parent: ctx.holder, child, prefix });
          walk(body[0], body[1], { ...next, holder: child, path: '', res: null, scope: null });
        } else {
          walk(body[0], body[1], next);
        }
        return end;
      }
      if (name === 'controller' && hasBlock) {
        const c = valueOf(args[0]);
        walk(body[0], body[1], { ...ctx, ctrl: c ?? ctx.ctrl });
        return end;
      }
      if (name === 'draw' && !hasBlock) return end;
      if (hasBlock) {
        // draw, constraints, defaults, authenticate, devise_scope, ...: transparent
        walk(body[0], body[1], ctx);
        return end;
      }
      return end;
    };

    // ================= Sinatra =================
    const sinatraWalk = (from: number, to: number, holder: RouteHolder, base: string) => {
      for (let i = from; i < to; i++) {
        const st = stmts[i];
        if (st.isEnd) continue;
        const end = st.opener >= 0 && st.endIdx >= 0 ? st.endIdx : i;
        const body: [number, number] = [i + 1, st.endIdx >= 0 ? st.endIdx : to];
        const cls = /^class\s+([A-Z][\w:]*)\s*<\s*(?:::)?Sinatra::(?:Base|Application)\b/.exec(st.S);
        if (cls) {
          const name = cls[1].split('::').pop()!;
          const h = holderFor(`${f.path}::${name}`, name, 'router');
          sinatraWalk(body[0], body[1], h, '');
          i = end;
          continue;
        }
        const head = headOf(st);
        if (head && head.name === 'namespace' && st.opener >= 0) {
          const p = valueOf(head.args[0]);
          const prefix = p === null ? '(dynamic)' : joinPaths(base, p);
          const child = holderFor(`${f.path}::namespace${counter++}`, `namespace ${prefix}`, 'router');
          mounts.push({ parent: holder, child, prefix: p === null ? '(dynamic)' : joinPaths(p) });
          sinatraWalk(body[0], body[1], child, '');
          i = end;
          continue;
        }
        if (head && (VERBS.has(head.name) || head.name === 'get') ) {
          const first = head.args[0];
          const raw = first && first.key === null ? lx.lo.slice(first.va, first.vb).trim() : '';
          const path = first && first.key === null ? literal(raw) : null;
          routes.push({ holder, method: head.name.toUpperCase(), path: path === null ? '(dynamic)' : joinPaths(base, path), handler: st.opener >= 0 ? '(block)' : '(proc)' });
          i = end;
          continue;
        }
        if (st.opener >= 0 && /^(?:if|unless|case|begin|configure|before|after|helpers)\b/.test(st.S)) {
          if (/^(?:if|unless|case|begin|configure)\b/.test(st.S)) sinatraWalk(body[0], body[1], holder, base);
          i = end;
          continue;
        }
        if (st.opener >= 0) i = end;
      }
    };

    // ---- walkers ----
    function walk(from: number, to: number, ctx: RCtx): void {
      for (let i = from; i < to; i++) {
        if (stmts[i].isEnd) continue;
        i = handleRails(i, ctx);
      }
    }

    if (isRails) {
      const root = holderFor(`${f.path}::routes`, `routes<br/>${f.path}`, 'app');
      walk(0, stmts.length, { holder: root, path: '', mod: '', ctrl: null, res: null, scope: null, shallow: false });
    } else {
      const app = holderFor(`${f.path}::sinatra`, `sinatra<br/>${f.path}`, 'app');
      sinatraWalk(0, stmts.length, app, '');
    }
  }
  return assembleRouteGraph(holders.values(), routes, mounts);
}

export const rubyRouteAnalyzer: CodeAnalyzer = {
  id: 'ruby-routes',
  displayName: 'Routes (Rails / Sinatra)',
  supportedExtensions: ['.rb'],
  analyze: analyzeRubyRoutes,
};
