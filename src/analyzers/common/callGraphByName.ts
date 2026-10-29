import { CodeGraph } from '../analyzer';

export interface DeclaredFn {
  /** Globally unique node id, e.g. "src/a.py::Class.method". */
  nodeId: string;
  label: string;
  shortName: string;
  className: string | null;
  /** Scrubbed (comment/string-free) body text to search for calls. */
  body: string;
  kind: 'function' | 'method';
  /** Raw parameter list text (`a: Foo, b: &Bar`, `Foo a, Bar b`, `a, b int`), used for local type inference and shadowing. */
  params?: string;
  /** Raw declared return type (`*Repo`, `Option<Repo>`, `Task<Repo>`, `-> Repo`); the first scanned type name in it is what a call result is treated as. */
  returns?: string;
}

export interface CallGraphOptions {
  /** Regex source whose group 1 is the method name for an explicit self call, e.g. `\bself\.(\w+)\s*\(`. */
  selfCall: string;
  /** Separator used in qualified calls: '::' (Rust/C++) or '.' (Python). */
  qualifier: '::' | '.';
  /** C++ lets a method call a sibling method (or any function) by bare name; Rust/Python do not. */
  bareCallsReachSiblings: boolean;
  /**
   * Optional: declared field types per class (`className -> fieldName -> typeName`).
   * Lets `this.repo.save()` / `repo.save()` resolve to `Repo.save` when `repo`
   * is a field whose declared type is a scanned class. Without type
   * inference, only fields (not locals or parameters) are resolved this way.
   */
  fieldTypes?: Map<string, Map<string, string>>;
  /**
   * Optional: supertypes per class (`implements`, `extends`, base classes, `impl Trait for T`). A receiver typed as
   * one of them (an interface, trait or abstract class that has no method body of its own) is linked, dotted, to
   * every scanned class that lists it and defines the method.
   */
  supers?: Map<string, string[]>;
  /** Optional: every type declared in the scan (interfaces and traits included). Supertypes outside it (`Default`, `Exception`, `Object`) are ignored. Defaults to the classes that have scanned methods. */
  declaredTypes?: Set<string>;
  /**
   * Optional: files each file imports/includes (resolved to scanned file paths, i.e. the prefix of a
   * node id before `::`). A bare `foo()` then prefers a `foo` in the caller's own file, then one in an
   * imported file, before falling back to every `foo` in the scan (those edges are marked `ambiguous`
   * when more than one function matches).
   */
  importedFiles?: Map<string, Set<string>>;
}

/** Most implementers a single `x.method()` call may fan out to before the dotted edges are dropped as noise. */
const MAX_DISPATCH_TARGETS = 12;

const KEYWORDS = new Set(['return', 'new', 'else', 'if', 'while', 'for', 'in', 'is', 'as', 'not', 'and', 'or', 'await', 'yield', 'throw', 'delete', 'typeof', 'case', 'do', 'let', 'const', 'var', 'mut', 'ref', 'self', 'this', 'super', 'static', 'final', 'public', 'private', 'protected', 'internal', 'void', 'int', 'long', 'bool', 'char', 'float', 'double', 'string', 'auto', 'def', 'fn', 'func', 'lambda']);

/** Names a function's own parameters and local declarations introduce (they shadow any function of the same name). */
function localNames(params: string, body: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let cur = '';
  const segs: string[] = [];
  for (const c of params) {
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) segs.push(cur);
  for (const seg of segs) {
    const noDefault = seg.split('=')[0];
    const named = noDefault.includes(':') ? noDefault.split(':')[0] : noDefault;
    const ids = named.match(/[A-Za-z_]\w*/g);
    const last = ids?.[ids.length - 1];
    if (last && !KEYWORDS.has(last)) out.add(last);
    // Go writes `name Type` (`s Store`, `r *Repo`, `xs ...int`): the name comes first and is lowercase, the type last.
    const goStyle = /^\s*([a-z_]\w*)\s+(?:\.\.\.|\*|\[\d*\])*[\w.]+\s*$/.exec(noDefault);
    if (goStyle && !KEYWORDS.has(goStyle[1])) out.add(goStyle[1]);
  }
  for (const m of body.matchAll(/\b(?:let|const|var|val|auto|def)\s+(?:mut\s+)?([A-Za-z_]\w*)/g)) out.add(m[1]);
  for (const m of body.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*:=/g)) out.add(m[1]);
  for (const m of body.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=(?!=)/gm)) out.add(m[1]);
  for (const m of body.matchAll(/\b([A-Za-z_]\w*)(?:<[^<>;()]*>)?(?:\[\])?[*&]*\s+([A-Za-z_]\w*)\s*(?==[^=]|;|,|\)|:)/g)) if (!KEYWORDS.has(m[1])) out.add(m[2]); // `Foo x = ..`, `Foo x;`
  for (const m of body.matchAll(/\bfor\s*\(?\s*(?:let\s+|const\s+|var\s+)?([A-Za-z_]\w*)\s+in\b/g)) out.add(m[1]);
  for (const m of body.matchAll(/(?:^|[;{}])\s*(?:const\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*[({]/gm)) if (!KEYWORDS.has(m[1])) out.add(m[2]); // C++ `Circle c(2);`
  return out;
}

/**
 * Variable -> class for locals and parameters, from what is written: `x = Foo(`,
 * `x := Foo{`, `let x = Foo::new(`, `new Foo(` on the right of an assignment,
 * `Foo x` (C-family declarations and parameters), `x: Foo` / `x: &mut Foo`,
 * `var x Foo`. Only classes that were actually scanned count, so function calls
 * and primitive types never produce an entry. Without flow analysis a variable
 * reassigned to another type keeps its first type.
 */
function inferTypes(params: string, body: string, classNames: Set<string>, resultType: (callee: string) => string | null = () => null): Map<string, string> {
  const out = new Map<string, string>();
  const put = (name: string, type: string) => {
    if (!out.has(name) && !KEYWORDS.has(name) && classNames.has(type)) out.set(name, type);
  };
  const text = `${params})\n${body}`; // the `)` ends the last parameter the way it did in the source
  for (const m of text.matchAll(/([A-Za-z_]\w*)\s*(?::=|=)\s*(?:new\s+|&\s*(?:mut\s+)?)?([A-Za-z_]\w*)(?:::<[^>]*>)?(?:::(?:new|default|create|from|with_\w+))?\s*[({<]/g)) put(m[1], m[2]);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)(?:<[^<>;()]*>)?\s*[*&]*\s+([A-Za-z_]\w*)\s*(?=[=;,)])/g)) put(m[2], m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*:\s*(?:&\s*(?:'\w+\s+)?(?:mut\s+)?|\*\s*(?:const\s+|mut\s+)?|Box<|Rc<|Arc<)?(?:dyn\s+|impl\s+)?([A-Za-z_]\w*)\b/g)) put(m[1], m[2]);
  for (const m of text.matchAll(/\bvar\s+([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)/g)) put(m[1], m[2]);
  for (const m of text.matchAll(/(?:^|[;{}])\s*(?:const\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*[({]/gm)) put(m[2], m[1]); // C++ direct-initialisation: `Circle c(2);` / `Circle c{2};`
  // Collections of a scanned type, and loops over them: `List<Repo> repos`, `repos: list[Repo]`, `repos: &Vec<Repo>`, `repos []*Repo`,
  // `Repo[] repos` followed by `for r in repos`, `for _, r := range repos`, `for (Repo r : repos)`, `foreach (var r in repos)`.
  const elems = new Map<string, string>();
  const putElem = (v: string, t: string) => {
    if (!elems.has(v) && classNames.has(t)) elems.set(v, t);
  };
  const COLL = '(?:List|ArrayList|LinkedList|Set|HashSet|TreeSet|SortedSet|Collection|Iterable|IEnumerable|IList|ICollection|IReadOnlyList|IReadOnlyCollection|Vec|VecDeque|BTreeSet|list|set|frozenset|Sequence|Iterator|tuple|Tuple)';
  for (const m of text.matchAll(new RegExp(`\\b${COLL}\\s*[<\\[]\\s*[&*]?\\s*(?:mut\\s+)?([A-Za-z_]\\w*)\\s*[>\\]]\\s*[*&]*\\s+([A-Za-z_]\\w*)`, 'g'))) putElem(m[2], m[1]);
  for (const m of text.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*:\\s*&?\\s*(?:mut\\s+)?${COLL}\\s*[<\\[]\\s*[&*]?\\s*(?:mut\\s+)?([A-Za-z_]\\w*)\\s*[>\\]]`, 'g'))) putElem(m[1], m[2]);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s+\[\]\s*\*?([A-Za-z_]\w*)/g)) putElem(m[1], m[2]); // Go `repos []*Repo`
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\[\]\s+([A-Za-z_]\w*)/g)) putElem(m[2], m[1]); // Java/C# `Repo[] repos`
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*:\s*&\s*(?:mut\s+)?\[\s*([A-Za-z_]\w*)\s*\]/g)) putElem(m[1], m[2]); // Rust `repos: &[Repo]`
  const loopVar = (v: string, coll: string) => {
    const t = elems.get(coll);
    if (t) put(v, t);
  };
  for (const m of text.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+&?\s*(?:mut\s+)?([A-Za-z_]\w*)(?:\.(?:iter|iter_mut|into_iter|values|copy|clone)\(\))?\s*[:{]/g)) loopVar(m[1], m[2]); // Python / Rust
  for (const m of text.matchAll(/\bfor\s+[A-Za-z_]\w*\s*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+([A-Za-z_]\w*)/g)) loopVar(m[1], m[2]); // Go
  for (const m of text.matchAll(/\bfor\s*\(\s*(?:final\s+|const\s+)?(?:var|auto|[A-Za-z_]\w*)\s*[&*]*\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\)/g)) loopVar(m[1], m[2]); // Java / C++
  for (const m of text.matchAll(/\bforeach\s*\(\s*(?:var|[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_]\w*)\s*\)/g)) loopVar(m[1], m[2]); // C#
  // `x = make_repo()`, `x := NewRepo()`, `let x = self.open()?`, `var x = await GetAsync()`: the callee's declared return type.
  for (const m of text.matchAll(/(?:^|[;{}\s])(?:(?:let|var|val|auto|const)\s+(?:mut\s+)?)?([A-Za-z_]\w*)\s*(?::=|=)\s*(?:await\s+)?(?:(?:self|this)\s*(?:\.|->)\s*|(?:[A-Za-z_]\w*)(?:::|\.))?([A-Za-z_]\w*)\s*\(/g)) {
    if (out.has(m[1]) || KEYWORDS.has(m[1])) continue;
    const t = resultType(m[2]);
    if (t) put(m[1], t);
  }
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)\s*(?=[,)]|$)/gm)) put(m[1], m[2]); // Go parameters: `repo *Repo`
  return out;
}

/** Edges from graphs whose nodes are files (import/include graphs): `from -> {to...}`. */
export function importedFilesFromGraph(graph: CodeGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const set = out.get(e.from) ?? new Set<string>();
    set.add(e.to);
    out.set(e.from, set);
  }
  return out;
}

const fileOf = (nodeId: string): string => {
  const i = nodeId.indexOf('::');
  return i < 0 ? nodeId : nodeId.slice(0, i);
};

/**
 * Name-based call resolution shared by the regex-based analyzers (Python,
 * Rust, C/C++). It has no type information, so:
 *  - a bare `foo()` links to every free function named `foo` (and, for C++,
 *    to same-class methods named `foo`);
 *  - `self.foo()` / `this->foo()` links only to `foo` in the same class;
 *  - `Type::foo()` / `Type.foo()` links to `foo` only when `Type` is a
 *    declared class/struct/impl target;
 *  - `x.foo()` resolves when `x` is a typed local or parameter (`x = Foo()`,
 *    `Foo x`, `x: Foo`, `let x = Foo::new()`) or a field with a known type, and
 *    `Foo` is a scanned class that declares `foo`; inheritance is not walked;
 *  - a bare `foo()` is skipped when `foo` is a parameter or local of the
 *    calling function (a callback or closure shadows any function named `foo`);
 *  - everything else (calls on untyped objects, function pointers,
 *    macros, dynamic dispatch) is NOT resolved.
 * A bare call prefers a free function of that name in the caller's own file,
 * then one in a file the caller imports (when `importedFiles` is supplied),
 * and only then every function of that name; edges from that last fallback
 * are `ambiguous` when several functions match, so a renderer can draw them
 * differently. Overloads are still conflated.
 */
export function buildCallGraph(fns: DeclaredFn[], opts: CallGraphOptions): CodeGraph {
  const byName = new Map<string, DeclaredFn[]>();
  const classNames = new Set<string>();
  const nodes = new Map<string, CodeGraph['nodes'][number]>();
  for (const fn of fns) {
    nodes.set(fn.nodeId, { id: fn.nodeId, label: fn.label, kind: fn.kind });
    const list = byName.get(fn.shortName) ?? [];
    list.push(fn);
    byName.set(fn.shortName, list);
    if (fn.className) classNames.add(fn.className);
  }

  const implementers = new Map<string, string[]>(); // supertype -> classes that list it
  const declared = opts.declaredTypes ?? classNames;
  for (const [cls, sup] of opts.supers ?? []) for (const sp of sup) if (declared.has(sp) || classNames.has(sp)) implementers.set(sp, [...(implementers.get(sp) ?? []), cls]);
  const knownTypes = new Set([...classNames, ...implementers.keys()]);
  /** Class a call to the function named `name` evaluates to; only when every function of that name agrees. */
  const returnOfName = new Map<string, string | null>();
  const returnOf = (name: string): string | null => {
    if (returnOfName.has(name)) return returnOfName.get(name)!;
    const kinds = new Set<string | null>();
    for (const f of byName.get(name) ?? []) {
      const tok = f.returns ? (f.returns.match(/[A-Za-z_]\w*/g) ?? []).find((t) => knownTypes.has(t)) ?? null : null;
      kinds.add(tok);
    }
    const r = kinds.size === 1 ? [...kinds][0] : null;
    returnOfName.set(name, r);
    return r;
  };

  const edges: CodeGraph['edges'] = [];
  const seen = new Map<string, CodeGraph['edges'][number]>();
  const add = (from: string, to: string, ambiguous = false) => {
    if (from === to) return;
    const k = `${from}=>${to}`;
    const prior = seen.get(k);
    if (prior) {
      if (prior.kind === 'ambiguous' && !ambiguous) prior.kind = 'calls'; // a precise resolution wins over a guess
      return;
    }
    const edge = { from, to, kind: ambiguous ? 'ambiguous' : 'calls' };
    seen.set(k, edge);
    edges.push(edge);
  };

  const q = opts.qualifier === '::' ? '::' : '\\.';
  const qualifiedRe = new RegExp(`\\b([A-Za-z_]\\w*)${q}([A-Za-z_]\\w*)\\s*\\(`, 'g');
  const bareRe = new RegExp(`(?<![\\w.>:])([A-Za-z_]\\w*)\\s*\\(`, 'g');
  const selfRe = new RegExp(opts.selfCall, 'g');

  /** `x.name()` where x has type `type`: an exact method when the class defines it, else dotted edges to each implementer's. */
  const callOn = (from: string, type: string, name: string) => {
    const direct = (byName.get(name) ?? []).filter((c) => c.className === type);
    for (const c of direct) add(from, c.nodeId);
    // A subclass or implementer may override the method: possible targets of dynamic dispatch, drawn dotted.
    const seenImpl = new Set<string>();
    const targets: DeclaredFn[] = [];
    const walk = (t: string, depth: number) => {
      for (const impl of implementers.get(t) ?? []) {
        if (seenImpl.has(impl) || depth > 4) continue;
        seenImpl.add(impl);
        targets.push(...(byName.get(name) ?? []).filter((c) => c.className === impl));
        walk(impl, depth + 1);
      }
    };
    walk(type, 0);
    // A call that could reach dozens of implementers says nothing useful; leave it out rather than draw them all.
    if (targets.length <= MAX_DISPATCH_TARGETS) for (const c of targets) add(from, c.nodeId, true);
  };

  for (const fn of fns) {
    let m: RegExpExecArray | null;
    const locals = localNames(fn.params ?? '', fn.body);
    const localTypes = inferTypes(fn.params ?? '', fn.body, knownTypes, returnOf);
    selfRe.lastIndex = 0;
    while ((m = selfRe.exec(fn.body))) {
      if (!fn.className) continue;
      for (const c of byName.get(m[1]) ?? []) if (c.className === fn.className) add(fn.nodeId, c.nodeId);
    }
    qualifiedRe.lastIndex = 0;
    while ((m = qualifiedRe.exec(fn.body))) {
      const [, owner, name] = m;
      let resolvedOwner = owner === 'Self' && fn.className ? fn.className : owner;
      const local = localTypes.get(owner);
      if (local && locals.has(owner)) resolvedOwner = local; // a typed local or parameter wins over a same-named class
      else if (!classNames.has(resolvedOwner) && fn.className) {
        const ft = opts.fieldTypes?.get(fn.className)?.get(owner);
        if (ft) resolvedOwner = ft;
      }
      // `Type::f()` / `Type.f()` written with a trait or interface name is a static path, not a value of that type: only concrete scanned classes count.
      if (!(local && locals.has(owner)) && !classNames.has(resolvedOwner) && !(fn.className && opts.fieldTypes?.get(fn.className)?.get(owner))) continue;
      if (!knownTypes.has(resolvedOwner)) continue;
      callOn(fn.nodeId, resolvedOwner, name);
    }
    // `make_repo().save()`: a call whose declared return type is a scanned class
    for (const cm of fn.body.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\([^()]*\)\s*\??\s*(?:\.|->)\s*([A-Za-z_]\w*)\s*\(/g)) {
      if (locals.has(cm[1])) continue;
      const rt = returnOf(cm[1]);
      if (rt) callOn(fn.nodeId, rt, cm[2]);
    }
    if (opts.qualifier === '::') {
      // Rust/C++ write paths with `::` but method calls with `.` or `->`: `x.save()` resolves through a typed local, parameter or field.
      const memberRe = /\b([A-Za-z_]\w*)\s*(?:\.|->)\s*([A-Za-z_]\w*)\s*\(/g;
      while ((m = memberRe.exec(fn.body))) {
        const [, owner, name] = m;
        const type = (locals.has(owner) ? localTypes.get(owner) : undefined) ?? (fn.className ? opts.fieldTypes?.get(fn.className)?.get(owner) : undefined);
        if (!type || !knownTypes.has(type)) continue;
        callOn(fn.nodeId, type, name);
      }
    }
    bareRe.lastIndex = 0;
    const callerFile = fileOf(fn.nodeId);
    while ((m = bareRe.exec(fn.body))) {
      if (locals.has(m[1]) && m[1] !== fn.shortName) continue; // a parameter or local of that name shadows any function
      const all = byName.get(m[1]) ?? [];
      for (const c of all) if (c.className !== null && opts.bareCallsReachSiblings && c.className === fn.className) add(fn.nodeId, c.nodeId);
      const free = all.filter((c) => c.className === null);
      if (free.length === 0) continue;
      const own = free.filter((c) => fileOf(c.nodeId) === callerFile);
      if (own.length) {
        for (const c of own) add(fn.nodeId, c.nodeId);
        continue;
      }
      const imported = opts.importedFiles?.get(callerFile);
      const viaImport = imported ? free.filter((c) => imported.has(fileOf(c.nodeId))) : [];
      if (viaImport.length) {
        for (const c of viaImport) add(fn.nodeId, c.nodeId);
        continue;
      }
      for (const c of free) add(fn.nodeId, c.nodeId, free.length > 1);
    }
  }
  return { nodes: [...nodes.values()], edges };
}
