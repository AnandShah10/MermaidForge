import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { scrub } from '../common/scrubber';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';
import { matchClose } from '../common/routeUtils';

/**
 * Ruby analyzers over scrubbed text (comments, strings, `=begin` blocks and heredoc bodies blanked, offsets kept)
 * with `end`-matching — no parser, no Bundler/Gemfile, no autoload configuration, no metaprogramming.
 *
 * Handled: `class` / `module` (nesting, `class Foo::Bar`, `class << self`, reopened classes merged by name),
 * `< Super`, `Name = Struct.new(:a, :b)` / `Class.new(Super)` / `Data.define(:a)` (optionally with a `do` body),
 * `include` / `extend` / `prepend`, `attr_reader` / `attr_writer` / `attr_accessor` (symbol arguments only),
 * methods (`def name`, `def self.name`, `def Const.name`, setter/predicate/bang/operator names, paren-less
 * parameters, endless `def x = expr`), visibility from bare `private` / `protected` / `public` sections,
 * `private :a, :b`, `private def x`, `private_class_method`, `module_function`, `class_methods do … end`, and
 * `require` / `require_relative` / `load` with literal paths, `File.expand_path('x', __FILE__ | __dir__)`,
 * `File.join(__dir__, 'x')` and `"#{__dir__}/x"`.
 *
 * Block structure is read from keywords: `class module def begin case for do` open a block, `if unless while
 * until` open one only at the start of a statement or after `=`, `(`, `,`, `else`, `then`… (a trailing
 * `x if y` is a modifier), `end` closes. Keywords used as method names (`x.class`), symbols (`:if`) and
 * hash labels (`if:`) are not keywords. The brace form of blocks needs no tracking.
 *
 * Imports: `require_relative` and literal `require` / `load` paths that resolve to a scanned file (relative to
 * the file, then to a unique suffix match such as `lib/foo.rb`), plus Zeitwerk-style constant references:
 * `Foo::BarBaz` links to the scanned file that declares it (or whose path is `foo/bar_baz.rb`) when exactly one
 * file fits. Gems and the standard library are not edges.
 *
 * Call graph: name-based like the other languages. Ruby calls need no parentheses, so each method body is
 * normalised first: a bare identifier or `.name` that matches a method of the enclosing class (bare) or any
 * scanned method (after a dot) becomes `name()` unless it is a parameter, an assigned local or a block
 * parameter; `Foo.new(..)` becomes a call to `Foo`, which resolves to `Foo#initialize`; `self.class.new` and a
 * bare `new` inside a class mean the class itself; `@repo = Repo.new` (or a parameter defaulting to
 * `Repo.new`) types `@repo` for `@repo.save` and for `repo.save` after `attr_reader :repo`; a method whose
 * last expression is `Foo.new` is typed as returning Foo; `Foo.new.bar` and `make.bar` chains resolve.
 * `?` / `!` / `=` in method names are mapped to `_q` / `_b` / `_eq` for matching only. Superclasses and
 * included modules count as supertypes, so a receiver typed as a base class or mixin also reaches overriding
 * implementers as dotted edges.
 *
 * NOT handled: `method_missing`, `define_method`, `send` / `public_send` / `instance_eval`, `Module#===`,
 * refinements, `Forwardable` delegation, ActiveSupport concerns' `included do` effects beyond reading the block
 * as part of the class, `before_action`-style implicit calls, callbacks and `alias_method` (the alias is not a
 * method), `Struct`/`Data` with block-less members beyond their symbols, local classes defined inside methods,
 * string-based `require` paths built at runtime, `autoload` configuration (`config.autoload_paths`), engines and
 * gems, multiple assignment (`a, b = x, y`) for local typing, type inference through anything but `Foo.new`,
 * `private` inside `class << self` for outer-class methods, and visibility changed by `private` calls that
 * take a variable. Constant references are matched by simple name across the whole scan, so two classes with
 * the same name in different namespaces are treated as one in the class and call analyses (the import graph
 * requires the namespace to fit).
 */

// ---------- model ----------

export type RubyVisibility = 'public' | 'protected' | 'private';

export interface RubyMethod {
  name: string;
  visibility: RubyVisibility;
  isStatic: boolean;
  /** Raw parameter text as written (`a, b = 1, *rest, key:, &blk`). */
  params: string;
  paramNames: string[];
  /** Scrubbed body text. */
  body: string;
  line: number;
}

export interface RubyAttr {
  name: string;
  access: 'reader' | 'writer' | 'accessor';
  visibility: RubyVisibility;
  isStatic: boolean;
}

export interface RubyType {
  /** Last segment of the constant path (`Admin::UsersController` -> `UsersController`). */
  name: string;
  /** Qualified name including lexical namespaces. */
  fullName: string;
  kind: 'class' | 'module';
  /** Superclass constant path as written, or null. */
  superName: string | null;
  mixins: Array<{ kind: 'include' | 'extend' | 'prepend'; name: string }>;
  attrs: RubyAttr[];
  methods: RubyMethod[];
  /** Simple name of the enclosing type, or null. */
  outer: string | null;
  line: number;
}

export interface RubyRequire {
  kind: 'require' | 'require_relative' | 'load' | 'autoload';
  /** Literal path, when the argument is a plain string. */
  path: string | null;
  /** The rest of the line as written, for `File.expand_path(..)`-style arguments. */
  expr: string;
}

export interface RubyFile {
  types: RubyType[];
  /** Methods defined outside any class or module. */
  topMethods: RubyMethod[];
  requires: RubyRequire[];
  /** Constant paths referenced in code (`Foo`, `Foo::Bar`), excluding the names being declared. */
  constants: string[];
}

// ---------- tokenizer ----------

interface Tok {
  t: string;
  s: number;
  e: number;
  line: number;
  /** w = identifier/keyword, c = constant, v = @ivar/$global, p = punctuation */
  k: 'w' | 'c' | 'v' | 'p';
}

const TOKEN_RE = /(@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*)|([A-Za-z_]\w*(?:[?!](?!=))?)|(::|\.\.\.?|&\.|\|\|=?|&&=?|<=>|\*\*|<<|[=!<>]=?=?|[^\sA-Za-z_0-9])/g;

function tokenize(sc: string): Tok[] {
  const toks: Tok[] = [];
  let line = 0;
  let last = 0;
  for (const m of sc.matchAll(TOKEN_RE)) {
    const s = m.index ?? 0;
    for (let k = last; k < s; k++) if (sc[k] === '\n') line++;
    last = s;
    const t = m[0];
    toks.push({ t, s, e: s + t.length, line, k: m[1] ? 'v' : m[2] ? (/^[A-Z]/.test(t) ? 'c' : 'w') : 'p' });
  }
  return toks;
}

const KEYWORDS = new Set(['class', 'module', 'def', 'begin', 'case', 'for', 'do', 'if', 'unless', 'while', 'until', 'end']);
/** Tokens after which `if`/`unless`/`while`/`until` start a nested construct instead of being a trailing modifier. */
const OPENS_AFTER = new Set(['=', '(', '[', '{', ',', ';', '&&', '||', '!', '?', ':', '+', '-', '*', '/', '|', '==', '!=', '<', '>', '<=', '>=', '+=', '-=', '||=', '&&=', 'else', 'then', 'do', 'begin', 'and', 'or', 'not', 'when', 'in', 'elsif', 'ensure', 'rescue']);


function sanitizeMethodName(name: string): string {
  if (/^[A-Za-z_]\w*$/.test(name)) return name;
  if (/^[A-Za-z_]\w*\?$/.test(name)) return name.slice(0, -1) + '_q';
  if (/^[A-Za-z_]\w*!$/.test(name)) return name.slice(0, -1) + '_b';
  if (/^[A-Za-z_]\w*=$/.test(name)) return name.slice(0, -1) + '_eq';
  return 'op_' + [...name].map((c) => c.charCodeAt(0).toString(16)).join('');
}

function paramNamesOf(params: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let cur = '';
  const segs: string[] = [];
  for (const c of params) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) segs.push(cur);
  for (const seg of segs) {
    const m = /^\s*[*&]{0,2}([A-Za-z_]\w*)/.exec(seg);
    if (m) names.push(m[1]);
  }
  return names;
}

// ---------- parsing ----------

type FrameKind = 'class' | 'module' | 'sclass' | 'def' | 'block';
interface Frame {
  kind: FrameKind;
  type?: RubyType;
  method?: { name: string; params: string; bodyStart: number; line: number; isStatic: boolean; visibility: RubyVisibility; owner: Frame | null };
  vis: RubyVisibility;
  moduleFunction: boolean;
  /** Visibility to give the next `def` / `attr_*` (from `private def x`). */
  pendingVis: RubyVisibility | null;
  /** Names whose visibility is set after the fact (`private :a, :b`). */
  visNames: Array<{ names: string[]; vis: RubyVisibility; staticOnly: boolean }>;
  staticNames: string[];
  /** A block whose defs are class methods (`class_methods do`). */
  staticBlock: boolean;
}

const mkFrame = (kind: FrameKind, extra: Partial<Frame> = {}): Frame => ({ kind, vis: 'public', moduleFunction: false, pendingVis: null, visNames: [], staticNames: [], staticBlock: false, ...extra });

export function parseRuby(source: string): RubyFile {
  const orig = source;
  const sc = scrub(source, 'ruby');
  const toks = tokenize(sc);
  const types: RubyType[] = [];
  const topMethods: RubyMethod[] = [];
  const requires: RubyRequire[] = [];
  const constants: string[] = [];
  const byFull = new Map<string, RubyType>();
  const stack: Frame[] = [];

  const typeFrames = () => stack.filter((f) => f.kind === 'class' || f.kind === 'module');
  const currentOuter = (): RubyType | null => {
    const tf = typeFrames();
    return tf.length ? tf[tf.length - 1].type ?? null : null;
  };
  const declareType = (path: string, kind: 'class' | 'module', line: number): RubyType => {
    const absolute = path.startsWith('::');
    const clean = path.replace(/^::/, '');
    const outer = absolute ? null : currentOuter();
    const full = outer ? `${outer.fullName}::${clean}` : clean;
    const existing = byFull.get(full);
    if (existing) return existing;
    const t: RubyType = { name: clean.split('::').pop()!, fullName: full, kind, superName: null, mixins: [], attrs: [], methods: [], outer: outer ? outer.name : null, line: line + 1 };
    byFull.set(full, t);
    types.push(t);
    return t;
  };
  /** Frame that owns defs/attrs at this point: the nearest class/module/sclass, looking through plain blocks. */
  const ownerFrame = (): Frame | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f.kind === 'class' || f.kind === 'module' || f.kind === 'sclass') return f;
      if (f.kind === 'def') return null;
    }
    return null;
  };
  /** The type a frame stands for (a `class << self` frame stands for the enclosing type). */
  const typeOfFrame = (f: Frame | null): RubyType | null => {
    if (!f) return null;
    if (f.kind === 'sclass') {
      const i = stack.indexOf(f);
      for (let k = i - 1; k >= 0; k--) if (stack[k].kind === 'class' || stack[k].kind === 'module') return stack[k].type ?? null;
      return null;
    }
    return f.type ?? null;
  };
  const inStaticBlock = () => stack.some((f) => f.staticBlock);

  const finishMethod = (f: Frame, endPos: number) => {
    const m = f.method!;
    const owner = m.owner;
    const body = sc.slice(m.bodyStart, endPos);
    const isSclass = owner?.kind === 'sclass';
    let isStatic = m.isStatic || isSclass || (owner?.moduleFunction ?? false) || inStaticBlock();
    const type = typeOfFrame(owner);
    let visibility = m.visibility;
    if (owner) {
      for (const v of owner.visNames) if (v.names.includes(m.name) && (!v.staticOnly || isStatic)) visibility = v.vis;
      if (owner.staticNames.includes(m.name)) isStatic = true;
    }
    if (m.name === 'initialize' && !isStatic) visibility = 'private';
    const method: RubyMethod = { name: m.name, visibility, isStatic, params: m.params, paramNames: paramNamesOf(m.params), body, line: m.line + 1 };
    if (type) type.methods.push(method);
    else topMethods.push(method);
  };

  /** Reads `A::B, C` constant paths starting at token i; returns paths and the next index. */
  const readConstPaths = (i: number): { names: string[]; next: number } => {
    const names: string[] = [];
    let k = i;
    while (k < toks.length) {
      let name = '';
      if (toks[k].t === '::' && toks[k + 1]?.k === 'c') {
        name = '::';
        k++;
      }
      if (toks[k]?.k !== 'c') break;
      name += toks[k].t;
      k++;
      while (toks[k]?.t === '::' && toks[k + 1]?.k === 'c' && toks[k].s === toks[k - 1].e) {
        name += '::' + toks[k + 1].t;
        k += 2;
      }
      names.push(name);
      if (toks[k]?.t === ',' && toks[k].line === toks[k - 1].line) k++;
      else break;
    }
    return { names, next: k };
  };
  const symbolsFrom = (i: number, line: number): { names: string[]; next: number } => {
    const names: string[] = [];
    let k = i;
    while (k < toks.length && toks[k].line === line) {
      if (toks[k].t === ':' && toks[k + 1]?.k !== 'p' && toks[k + 1] && toks[k + 1].s === toks[k].e && (toks[k + 1].k === 'w' || toks[k + 1].k === 'c')) {
        names.push(toks[k + 1].t);
        k += 2;
      } else if (toks[k].t === ',' || toks[k].t === '(' || toks[k].t === ')' || toks[k].t === '[' || toks[k].t === ']') k++;
      else break;
    }
    return { names, next: k };
  };
  const lineEndIndex = (i: number): number => {
    let k = i;
    while (k + 1 < toks.length && toks[k + 1].line === toks[i].line) k++;
    return k;
  };

  let prev: Tok | null = null;
  let loopPending = false;
  let stmtHead: Tok | null = null;
  let pendingTypeForDo: RubyType | null = null;
  let pendingStaticDo = false;

  const noteRequire = (kind: RubyRequire['kind'], t: Tok) => {
    const lineEnd = orig.indexOf('\n', t.e);
    const rest = orig.slice(t.e, lineEnd < 0 ? orig.length : lineEnd);
    const lit = /^\s*\(?\s*(?::\w+\s*,\s*)?(['"])([^'"\n]+)\1/.exec(rest);
    requires.push({ kind, path: lit ? lit[2] : null, expr: rest.trim() });
  };

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (prev && tk.line !== prev.line) {
      const gap = sc.slice(prev.e, tk.s);
      if (!/\\\s*\n/.test(gap)) {
        prev = null;
        loopPending = false;
        stmtHead = null;
      }
    }
    const before = prev;
    const adjPrev = i > 0 ? toks[i - 1] : null;
    const isMember = adjPrev !== null && adjPrev.e === tk.s && (adjPrev.t === '.' || adjPrev.t === '&.' || adjPrev.t === '::' || adjPrev.t === ':');
    const next = toks[i + 1];
    const isLabel = next !== undefined && next.t === ':' && next.s === tk.e && toks[i + 2]?.t !== ':' && !(toks[i + 2] && toks[i + 2].s === next.e && toks[i + 2].t === ':');
    const statementStart = before === null;
    if (statementStart) stmtHead = tk;

    const isKeyword = tk.k === 'w' && KEYWORDS.has(tk.t) && !isMember && !isLabel;

    if (isKeyword) {
      switch (tk.t) {
        case 'class': {
          if (next?.t === '<<') {
            stack.push(mkFrame('sclass'));
            i += 2; // `<< self`
            break;
          }
          const { names, next: after } = readConstPaths(i + 1);
          if (names.length === 0) {
            stack.push(mkFrame('block'));
            break;
          }
          const t = declareType(names[0], 'class', tk.line);
          let k = after;
          if (toks[k]?.t === '<' && toks[k].s !== undefined) {
            const sup = readConstPaths(k + 1);
            if (sup.names[0]) {
              t.superName = sup.names[0];
              constants.push(sup.names[0].replace(/^::/, ''));
            }
            k = sup.next;
            // `class Point < Struct.new(:x, :y)`
            if (toks[k]?.t === '.' && toks[k + 1]?.t === 'new' && (sup.names[0] === 'Struct')) {
              const syms = symbolsFrom(k + 3, tk.line);
              for (const n of syms.names) t.attrs.push({ name: n, access: 'accessor', visibility: 'public', isStatic: false });
              t.superName = null;
            }
          }
          stack.push(mkFrame('class', { type: t }));
          i = k - 1;
          break;
        }
        case 'module': {
          const { names, next: after } = readConstPaths(i + 1);
          if (names.length === 0) {
            stack.push(mkFrame('block'));
            break;
          }
          const t = declareType(names[0], 'module', tk.line);
          stack.push(mkFrame('module', { type: t }));
          i = after - 1;
          break;
        }
        case 'def': {
          let k = i + 1;
          let isStatic = false;
          // `def self.x` / `def Const.x`
          if (toks[k] && (toks[k].t === 'self' || toks[k].k === 'c') && toks[k + 1]?.t === '.' && toks[k + 1].s === toks[k].e) {
            isStatic = true;
            k += 2;
          }
          let name = '';
          const nt = toks[k];
          if (nt && (nt.k === 'w' || nt.k === 'c')) {
            name = nt.t;
            k++;
            // setter: `def name=(v)` — the `=` touches the name
            if (toks[k]?.t === '=' && toks[k].s === toks[k - 1].e && (sc[toks[k].e] === '(' || /\s/.test(sc[toks[k].e] ?? ''))) {
              const afterEq = sc.slice(toks[k].e).match(/^\s*(\(|[A-Za-z_])/);
              if (sc[toks[k].e] === '(' || (afterEq && sc[toks[k].e] !== ' ')) {
                name += '=';
                k++;
              } else if (sc[toks[k].e] === '(') {
                name += '=';
                k++;
              }
            }
          } else if (nt) {
            // operator method: join adjacent punctuation
            let op = nt.t;
            let j = k + 1;
            while (toks[j] && toks[j].k === 'p' && toks[j].s === toks[j - 1].e && !'( '.includes(toks[j].t)) {
              op += toks[j].t;
              j++;
            }
            name = op;
            k = j;
          }
          const lineIdx = toks[i].line;
          const sigStartPos = toks[k - 1]?.e ?? tk.e;
          let params = '';
          let sigEnd = sigStartPos;
          const afterName = sc.slice(sigStartPos);
          const parenM = /^\s*\(/.exec(afterName);
          if (parenM) {
            const open = sigStartPos + parenM[0].length - 1;
            const close = matchClose(sc, open);
            if (close > 0) {
              params = sc.slice(open + 1, close);
              sigEnd = close + 1;
            }
          } else {
            const lineEndPos = (() => {
              const nl = sc.indexOf('\n', sigStartPos);
              return nl < 0 ? sc.length : nl;
            })();
            let rest = sc.slice(sigStartPos, lineEndPos);
            const semi = rest.indexOf(';');
            if (semi >= 0) rest = rest.slice(0, semi);
            const eq = /^\s*=(?![=~>])/.exec(rest);
            if (!eq) {
              params = rest.trim();
              sigEnd = sigStartPos + rest.length;
            }
          }
          // endless method: `def x(a) = expr`
          const tail = sc.slice(sigEnd, sc.indexOf('\n', sigEnd) < 0 ? sc.length : sc.indexOf('\n', sigEnd));
          const endless = /^\s*=(?![=~>])/.exec(tail);
          const owner = ownerFrame();
          const ownerType = typeOfFrame(owner);
          void ownerType;
          let visibility: RubyVisibility = owner && owner.kind !== 'sclass' ? owner.pendingVis ?? owner.vis : owner ? owner.vis : 'public';
          if (owner) owner.pendingVis = null;
          if (name === 'initialize') visibility = 'private';
          const frame = mkFrame('def', {
            method: { name, params, bodyStart: sigEnd, line: lineIdx, isStatic, visibility, owner },
          });
          if (endless) {
            const bodyStart = sigEnd + endless[0].length;
            const lineEndPos = sc.indexOf('\n', bodyStart) < 0 ? sc.length : sc.indexOf('\n', bodyStart);
            frame.method!.bodyStart = bodyStart;
            finishMethod(frame, lineEndPos);
            i = lineEndIndex(i);
            break;
          }
          stack.push(frame);
          // skip tokens that belong to the signature
          while (i + 1 < toks.length && toks[i + 1].s < sigEnd) i++;
          break;
        }
        case 'begin':
        case 'case':
          stack.push(mkFrame('block'));
          break;
        case 'for':
          stack.push(mkFrame('block'));
          loopPending = true;
          break;
        case 'if':
        case 'unless':
        case 'while':
        case 'until': {
          const opens = before === null || OPENS_AFTER.has(before.t) || (before.k === 'w' && OPENS_AFTER.has(before.t));
          if (opens) {
            stack.push(mkFrame('block'));
            if (tk.t === 'while' || tk.t === 'until') loopPending = true;
          }
          break;
        }
        case 'do': {
          if (loopPending) {
            loopPending = false;
            break;
          }
          if (pendingTypeForDo) {
            stack.push(mkFrame('class', { type: pendingTypeForDo }));
            pendingTypeForDo = null;
          } else {
            const f = mkFrame('block');
            if (pendingStaticDo || (stmtHead && stmtHead.t === 'class_methods')) f.staticBlock = true;
            pendingStaticDo = false;
            stack.push(f);
          }
          break;
        }
        case 'end': {
          const f = stack.pop();
          if (f && f.kind === 'def') finishMethod(f, tk.s);
          break;
        }
      }
      prev = tk;
      continue;
    }

    // ---- statement-level words ----
    if (statementStart && tk.k === 'w' && !isMember) {
      const owner = ownerFrame();
      const type = typeOfFrame(owner);
      const w = tk.t;
      const line = tk.line;
      if ((w === 'private' || w === 'protected' || w === 'public') && owner && (stack[stack.length - 1] === owner || stack[stack.length - 1].kind === 'block')) {
        const nx = toks[i + 1];
        if (!nx || nx.line !== line || nx.t === ';') owner.vis = w;
        else if (nx.t === 'def') owner.pendingVis = w;
        else if (nx.t === 'attr_reader' || nx.t === 'attr_writer' || nx.t === 'attr_accessor' || nx.t === 'attr') owner.pendingVis = w;
        else {
          const syms = symbolsFrom(i + 1, line);
          if (syms.names.length) {
            owner.visNames.push({ names: syms.names, vis: w, staticOnly: false });
            i = syms.next - 1;
          }
        }
      } else if ((w === 'private_class_method' || w === 'public_class_method') && owner) {
        const syms = symbolsFrom(i + 1, line);
        owner.visNames.push({ names: syms.names, vis: w === 'private_class_method' ? 'private' : 'public', staticOnly: true });
        i = syms.next - 1;
      } else if (w === 'module_function' && owner) {
        const syms = symbolsFrom(i + 1, line);
        if (syms.names.length) {
          owner.staticNames.push(...syms.names);
          i = syms.next - 1;
        } else owner.moduleFunction = true;
      } else if ((w === 'attr_reader' || w === 'attr_writer' || w === 'attr_accessor' || w === 'attr') && type) {
        const syms = symbolsFrom(i + 1, line);
        const access = w === 'attr_reader' || w === 'attr' ? 'reader' : w === 'attr_writer' ? 'writer' : 'accessor';
        const vis: RubyVisibility = owner!.pendingVis ?? owner!.vis;
        owner!.pendingVis = null;
        for (const n of syms.names) type.attrs.push({ name: n, access, visibility: vis, isStatic: owner!.kind === 'sclass' });
        i = syms.next - 1;
      } else if ((w === 'include' || w === 'extend' || w === 'prepend') && type && owner!.kind !== 'sclass') {
        const { names, next: after } = readConstPaths(i + 1);
        for (const n of names) {
          type.mixins.push({ kind: w, name: n });
          constants.push(n.replace(/^::/, ''));
        }
        i = after - 1;
      } else if (w === 'require' || w === 'require_relative' || w === 'load' || w === 'autoload') {
        noteRequire(w, tk);
        i = lineEndIndex(i);
      }
      prev = tk;
      continue;
    }

    // `Name = Struct.new(:a, :b)` / `Class.new(Super)` / `Data.define(:a)`
    if (statementStart && tk.k === 'c' && toks[i + 1]?.t === '=' && toks[i + 2] && (toks[i + 2].t === 'Struct' || toks[i + 2].t === 'Class' || toks[i + 2].t === 'Data') && toks[i + 3]?.t === '.' && (toks[i + 4]?.t === 'new' || toks[i + 4]?.t === 'define')) {
      const t = declareType(tk.t, 'class', tk.line);
      const kindWord = toks[i + 2].t;
      if (kindWord === 'Class') {
        const sup = readConstPaths(i + 6);
        if (sup.names[0]) {
          t.superName = sup.names[0];
          constants.push(sup.names[0]);
        }
      } else {
        const syms = symbolsFrom(i + 5, tk.line);
        for (const n of syms.names) t.attrs.push({ name: n, access: kindWord === 'Data' ? 'reader' : 'accessor', visibility: 'public', isStatic: false });
      }
      const endIdx = lineEndIndex(i);
      if (toks.slice(i, endIdx + 1).some((x) => x.t === 'do')) pendingTypeForDo = t;
      i = endIdx - (toks[endIdx].t === 'do' ? 1 : 0);
      prev = toks[i];
      continue;
    }

    // constant references (everything that is not being declared)
    if (tk.k === 'c' && !isMember) {
      let path = tk.t;
      let k = i;
      while (toks[k + 1]?.t === '::' && toks[k + 2]?.k === 'c' && toks[k + 1].s === toks[k].e) {
        path += '::' + toks[k + 2].t;
        k += 2;
      }
      constants.push(path);
      i = k;
      prev = toks[i];
      continue;
    }
    // `class_methods do`, `included do` style heads
    if (tk.t === 'class_methods') pendingStaticDo = true;
    prev = tk;
  }
  // unclosed defs (truncated file): keep what was read
  while (stack.length) {
    const f = stack.pop()!;
    if (f.kind === 'def') finishMethod(f, sc.length);
  }
  return { types, topMethods, requires, constants };
}

// ---------- classes ----------

const vis = (v: RubyVisibility): string => (v === 'public' ? '+' : v === 'private' ? '-' : '#');
const mermaidId = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_');

function methodMember(m: RubyMethod): string {
  const params = paramNamesOf(m.params).join(', ');
  const name = m.name.replace(/[^A-Za-z0-9_?!=<>+\-*/%[\]]/g, '');
  return `${vis(m.visibility)}${mermaidSafeMethod(name)}(${params})${m.isStatic ? '$' : ''}`;
}
function mermaidSafeMethod(name: string): string {
  // Mermaid reads `[]` and `<` in member text as markup; keep the readable part.
  return name.replace(/\[\]/g, 'at').replace(/[<>]/g, '_').replace(/=+$/, '_set');
}

export function analyzeRubyClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const parsed = files.map((f) => parseRuby(f.text));
  // Merge reopened classes (same simple name) across files.
  const merged = new Map<string, RubyType>();
  for (const rf of parsed) {
    for (const t of rf.types) {
      const m = merged.get(t.name);
      if (!m) merged.set(t.name, { ...t, attrs: [...t.attrs], methods: [...t.methods], mixins: [...t.mixins] });
      else {
        m.attrs.push(...t.attrs);
        m.methods.push(...t.methods);
        m.mixins.push(...t.mixins);
        if (!m.superName && t.superName) m.superName = t.superName;
        if (t.kind === 'class') m.kind = 'class';
      }
    }
  }
  const scanned = new Set(merged.keys());
  const nameFor = (path: string): string => {
    const last = path.replace(/^::/, '').split('::').pop()!;
    return scanned.has(last) ? last : path.replace(/^::/, '').replace(/::/g, '_');
  };

  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seenRel = new Set<string>();
  const hasNested = new Set<string>();
  for (const t of merged.values()) if (t.outer) hasNested.add(t.outer);
  for (const t of merged.values()) {
    const members: string[] = [];
    const seenAttr = new Set<string>();
    for (const a of t.attrs) {
      const key = a.name + a.access;
      if (seenAttr.has(key)) continue;
      seenAttr.add(key);
      members.push(`${vis(a.visibility)}${a.name}${a.access === 'reader' ? ' reader' : a.access === 'writer' ? ' writer' : ''}${a.isStatic ? '$' : ''}`);
    }
    const seenM = new Set<string>();
    for (const m of t.methods) {
      const key = `${m.isStatic ? 's' : 'i'}:${m.name}`;
      if (seenM.has(key)) continue;
      seenM.add(key);
      members.push(methodMember(m));
    }
    // A module that only wraps other types is a namespace, not a diagram element.
    if (t.kind === 'module' && members.length === 0 && hasNested.has(t.name)) continue;
    const stereotype: ExtractedClass['stereotype'] = t.kind === 'module' ? 'interface' : null;
    classes.push({ id: mermaidId(t.name), stereotype, members });
    const rel = (to: string, type: ExtractedRelationship['type']) => {
      const target = mermaidId(nameFor(to));
      const key = `${t.name}>${target}>${type}`;
      if (seenRel.has(key) || target === mermaidId(t.name)) return;
      seenRel.add(key);
      relationships.push({ from: mermaidId(t.name), to: target, type });
    };
    if (t.superName) rel(t.superName, 'inheritance');
    for (const mx of t.mixins) rel(mx.name, 'realization');
  }
  return { classes, relationships };
}

// ---------- imports ----------

/** `app/models/user_account.rb` -> `UserAccount`, `lib/foo/bar_baz.rb` -> `Foo::BarBaz`, `app/models/concerns/x.rb` -> `X`. */
export function constantFromPath(path: string): string {
  let p = path.replace(/\.rb$/, '');
  const m = /(?:^|\/)(?:app\/(?:[a-z_]+\/)?(?:concerns\/)?|lib\/|spec\/support\/|test\/support\/)(.+)$/.exec(p);
  if (m) p = m[1];
  else p = p.split('/').slice(-1).join('/');
  return p.split('/').map((seg) => seg.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('::');
}

function resolveRequire(from: string, r: RubyRequire, known: Set<string>, files: string[]): string | null {
  const dir = posixPath.dirname(from);
  let target: string | null = null;
  const tryFile = (p: string): string | null => {
    const n = posixPath.normalize(p);
    if (known.has(n)) return n;
    if (known.has(n + '.rb')) return n + '.rb';
    return null;
  };
  if (r.kind === 'require_relative') return r.path ? tryFile(posixPath.join(dir, r.path)) : expressionTarget(from, r, tryFile);
  if (r.path) {
    if (r.path.startsWith('.')) target = tryFile(posixPath.join(dir, r.path));
    if (target) return target;
    // load-path style: `require 'foo/bar'` -> a unique scanned file ending in foo/bar.rb (e.g. lib/foo/bar.rb)
    const want = r.path.replace(/\.rb$/, '') + '.rb';
    const hits = files.filter((f) => f === want || f.endsWith('/' + want));
    return hits.length === 1 ? hits[0] : null;
  }
  return expressionTarget(from, r, tryFile);
}

/** `File.expand_path('../x', __FILE__)`, `File.expand_path('x', __dir__)`, `File.join(__dir__, 'x')`, `"#{__dir__}/x"`. */
function expressionTarget(from: string, r: RubyRequire, tryFile: (p: string) => string | null): string | null {
  const dir = posixPath.dirname(from);
  let m = /File\.expand_path\(\s*['"]([^'"]+)['"]\s*,\s*__FILE__\s*\)/.exec(r.expr);
  if (m) return tryFile(posixPath.join(from, m[1]));
  m = /File\.expand_path\(\s*['"]([^'"]+)['"]\s*,\s*__dir__\s*\)/.exec(r.expr);
  if (m) return tryFile(posixPath.join(dir, m[1]));
  m = /File\.join\(\s*__dir__\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/.exec(r.expr);
  if (m) return tryFile(posixPath.join(dir, ...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])));
  m = /["']#\{__dir__\}\/([^"']+)["']/.exec(r.expr);
  if (m) return tryFile(posixPath.join(dir, m[1]));
  m = /["']#\{File\.dirname\(__FILE__\)\}\/([^"']+)["']/.exec(r.expr);
  if (m) return tryFile(posixPath.join(dir, m[1]));
  return null;
}

export function analyzeRubyImports(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, rb: parseRuby(f.text) }));
  const known = new Set(files.map((f) => f.path));
  const list = files.map((f) => f.path);
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    if (from === to) return;
    const k = `${from}=>${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind: 'import' });
  };

  // constant path -> files declaring it (by qualified name, and by path convention as a fallback)
  const declared = new Map<string, Set<string>>();
  const put = (full: string, file: string) => {
    const set = declared.get(full) ?? new Set<string>();
    set.add(file);
    declared.set(full, set);
  };
  for (const { path, rb } of parsed) {
    for (const t of rb.types) put(t.fullName, path);
  }
  const byTail = new Map<string, Set<string>>();
  for (const [full, files2] of declared) {
    const tail = full.split('::').pop()!;
    const set = byTail.get(tail) ?? new Set<string>();
    for (const f of files2) set.add(f);
    byTail.set(tail, set);
  }
  const byConvention = new Map<string, string[]>();
  for (const f of list) {
    const c = constantFromPath(f);
    byConvention.set(c, [...(byConvention.get(c) ?? []), f]);
  }

  for (const { path, rb } of parsed) {
    for (const r of rb.requires) {
      const t = resolveRequire(path, r, known, list);
      if (t) add(path, t);
    }
    const own = new Set(rb.types.map((t) => t.name));
    for (const ref of new Set(rb.constants)) {
      const segs = ref.split('::');
      if (segs.length === 1 && own.has(segs[0])) continue;
      const tail = segs[segs.length - 1];
      // 1. a declaration whose qualified name ends with the reference
      let cands = [...(byTail.get(tail) ?? [])].filter((f) => f !== path);
      if (segs.length > 1) cands = cands.filter((f) => [...declared].some(([full, fs]) => fs.has(f) && (full === ref || full.endsWith('::' + ref))));
      if (cands.length === 1) {
        add(path, cands[0]);
        continue;
      }
      if (cands.length > 1) continue; // ambiguous by name
      // 2. Zeitwerk path convention: foo/bar_baz.rb <-> Foo::BarBaz
      const conv = (byConvention.get(ref) ?? []).filter((f) => f !== path);
      if (conv.length === 1) add(path, conv[0]);
    }
  }
  return { nodes, edges };
}

// ---------- calls ----------

const LOCAL_WORDS = new Set(['self', 'nil', 'true', 'false', 'super', 'yield', 'puts', 'p', 'print', 'require', 'raise', 'return', 'block_given?']);

/**
 * Rewrites a Ruby method body into the `name(..)` / `Foo.method(..)` shape `buildCallGraph` understands. See the
 * module header for the rules.
 */
function normaliseBody(body: string, params: string[], ownerName: string | null, callable: Set<string>, ownNames: Set<string>, inherited: Map<string, string> = new Map()): string {
  let b = body.replace(/&\./g, '.');
  // constructors
  b = b.replace(/\bself\.class\.new\b/g, ownerName ? `${ownerName}` : 'new');
  b = b.replace(/\b(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b(?!\s*\()/g, '$1()');
  b = b.replace(/\b(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b/g, '$1');
  if (ownerName) b = b.replace(/(?<![\w.@$:])new\b(?!\s*:)/g, (m, off: number) => (/^\s*\(/.test(b.slice(off + m.length)) ? ownerName : `${ownerName}()`));
  // locals: parameters, assigned names, block parameters
  const locals = new Set<string>(params);
  for (const m of b.matchAll(/(?<![\w.@$:])([a-z_]\w*)\s*(?:\|\||&&|\+|-|\*|\/)?=(?![=~>])/g)) locals.add(m[1]);
  for (const m of b.matchAll(/\|([^|\n]*)\|/g)) for (const n of paramNamesOf(m[1])) locals.add(n);
  for (const m of b.matchAll(/(?<![\w.@$:])([a-z_]\w*)\s*,\s*[a-z_]\w*\s*=/g)) locals.add(m[1]);
  const rewrite = (re: RegExp, bare: boolean) => {
    b = b.replace(re, (m: string, pre: string, name: string, off: number) => {
      const after = b.slice(off + m.length);
      if (/^\s*:(?!:)/.test(after) && !/^\s*::/.test(after)) return m; // hash label `name:`
      const clean = name;
      const safe = sanitizeMethodName(clean);
      if (bare && (locals.has(clean) || LOCAL_WORDS.has(clean))) return m;
      if (!bare && !callable.has(clean)) return m;
      if (bare && !ownNames.has(clean)) return m;
      if (/^\s*=(?![=~>])/.test(after)) return m; // assignment, not a call
      return /^\s*\(/.test(after) ? `${pre}${safe}` : `${pre}${safe}()`;
    });
  };
  // `.name` receiver calls (any scanned method), then bare calls to methods of the enclosing class / file
  rewrite(/(\.\s*)([A-Za-z_]\w*[?!]?)(?![\w])/g, false);
  rewrite(/(?<![\w.@$:&])()([a-z_]\w*[?!]?)(?![\w])/g, true);
  // a bare call to a method defined by a scanned superclass or mixin becomes `Ancestor.name(..)`
  for (const [n, anc] of inherited) {
    const safe = sanitizeMethodName(n);
    b = b.replace(new RegExp(`(?<![\\w.@$:&])${safe.replace(/[$]/g, '\\$')}\\(`, 'g'), `${anc}.${safe}(`);
  }
  return b;
}

function returnsOf(body: string): string | undefined {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const m = /^(?:return\s+)?(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b/.exec(last);
  return m ? m[1] : undefined;
}

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, rb: parseRuby(f.text) }));
  const classNames = new Set<string>();
  for (const { rb } of parsed) for (const t of rb.types) classNames.add(t.name);
  const callable = new Set<string>();
  for (const { rb } of parsed) {
    for (const t of rb.types) for (const m of t.methods) callable.add(m.name);
    for (const m of rb.topMethods) callable.add(m.name);
  }

  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const fieldTypes = new Map<string, Map<string, string>>();
  const declaredTypes = new Set<string>(classNames);
  const last = (p: string) => p.replace(/^::/, '').split('::').pop()!;
  const seenIds = new Set<string>();
  const uniqueId = (id: string): string => {
    let n = id;
    let k = 2;
    while (seenIds.has(n)) n = `${id}#${k++}`;
    seenIds.add(n);
    return n;
  };

  const typeByName = new Map<string, RubyType>();
  for (const { rb } of parsed) for (const t of rb.types) if (!typeByName.has(t.name)) typeByName.set(t.name, t);
  /** Methods a class gets from scanned superclasses / mixins (nearest ancestor wins), name -> ancestor. */
  const inheritedOf = (t: RubyType): Map<string, string> => {
    const out = new Map<string, string>();
    const own = new Set(t.methods.map((m) => m.name));
    const seen = new Set<string>([t.name]);
    const queue: string[] = [...t.mixins.map((m) => m.name), ...(t.superName ? [t.superName] : [])].map((n) => n.replace(/^::/, '').split('::').pop()!);
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const a = typeByName.get(n);
      if (!a) continue;
      for (const m of a.methods) if (!own.has(m.name) && !out.has(m.name) && !m.isStatic) out.set(m.name, a.name);
      queue.push(...a.mixins.map((x) => x.name), ...(a.superName ? [a.superName] : []));
    }
    return out;
  };

  for (const { path, rb } of parsed) {
    const topNames = new Set(rb.topMethods.map((m) => m.name));
    for (const t of rb.types) {
      const inherited = inheritedOf(t);
      const ownNames = new Set<string>([...t.methods.map((m) => m.name), ...topNames, ...inherited.keys()]);
      const fieldMap = fieldTypes.get(t.name) ?? new Map<string, string>();
      const sup = [...(supers.get(t.name) ?? [])];
      if (t.superName) sup.push(last(t.superName));
      for (const mx of t.mixins) sup.push(last(mx.name));
      supers.set(t.name, sup);
      for (const m of t.methods) {
        // `@repo = Repo.new` / `def initialize(repo = Repo.new); @repo = repo`
        for (const f of m.body.matchAll(/@(\w+)\s*(?:\|\|)?=\s*(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b/g)) if (classNames.has(f[2]) && !fieldMap.has(f[1])) fieldMap.set(f[1], f[2]);
        const defaults = new Map<string, string>();
        for (const d of m.params.matchAll(/([a-z_]\w*)\s*[:=]\s*(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b/g)) defaults.set(d[1], d[2]);
        for (const a of m.body.matchAll(/@(\w+)\s*(?:\|\|)?=\s*([a-z_]\w*)\b/g)) {
          const ty = defaults.get(a[2]);
          if (ty && classNames.has(ty) && !fieldMap.has(a[1])) fieldMap.set(a[1], ty);
        }
      }
      fieldTypes.set(t.name, fieldMap);
      for (const m of t.methods) {
        const safe = sanitizeMethodName(m.name);
        const body = normaliseBody(m.body, m.paramNames, t.name, callable, ownNames, inherited);
        fns.push({
          nodeId: uniqueId(`${path}::${t.name}.${m.isStatic ? 'self.' : ''}${m.name}`),
          label: `${t.name}.${m.isStatic ? 'self.' : ''}${m.name}`,
          shortName: safe,
          className: t.name,
          body,
          kind: 'method',
          params: m.params,
          returns: returnsOf(m.body),
        });
      }
    }
    for (const m of rb.topMethods) {
      const ownNames = new Set<string>(rb.topMethods.map((x) => x.name));
      fns.push({
        nodeId: uniqueId(`${path}::${m.name}`),
        label: m.name,
        shortName: sanitizeMethodName(m.name),
        className: null,
        body: normaliseBody(m.body, m.paramNames, null, callable, ownNames),
        kind: 'function',
        params: m.params,
        returns: returnsOf(m.body),
      });
    }
  }
  // `Foo.new(..)` is rewritten to `Foo(..)`: a synthetic function per class that returns Foo, mapped to `Foo#initialize` afterwards.
  const ctor = (name: string) => `__ctor::${name}`;
  for (const name of classNames) fns.push({ nodeId: ctor(name), label: name, shortName: name, className: null, body: '', kind: 'function', returns: name });

  const g = buildCallGraph(fns, { selfCall: '\\bself\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: true, fieldTypes, supers, declaredTypes });
  const initOf = new Map<string, string>();
  for (const f of fns) if (f.shortName === 'initialize' && f.className && !initOf.has(f.className)) initOf.set(f.className, f.nodeId);
  const nodes = g.nodes.filter((n) => !n.id.startsWith('__ctor::'));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const e of g.edges) {
    let to = e.to;
    if (to.startsWith('__ctor::')) {
      const target = initOf.get(to.slice('__ctor::'.length));
      if (!target) continue;
      to = target;
    }
    if (e.from === to) continue;
    const key = `${e.from}=>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, to });
  }
  return { nodes, edges };
}

// ---------- analyzers ----------

export const rubyImportGraphAnalyzer: CodeAnalyzer = {
  id: 'ruby-import-graph',
  displayName: 'Import Graph (Ruby)',
  supportedExtensions: ['.rb'],
  analyze: analyzeRubyImports,
};

export const rubyCallGraphAnalyzer: CodeAnalyzer = {
  id: 'ruby-call-graph',
  displayName: 'Call Graph (Ruby)',
  supportedExtensions: ['.rb'],
  analyze: analyzeCalls,
};

export { analyzeCalls as analyzeRubyCalls };
