import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';

/**
 * Swift analyzers over scrubbed text with brace matching — no compiler front end, no module resolution, no type
 * checking. Handled: `import` (plain, `@testable`, `import struct M.T`), class / struct / enum / protocol / actor
 * declarations with their inheritance and conformance lists, `extension T { ... }` (members and `: Protocol`
 * conformances are merged into a scanned T), nested types (flattened by simple name), generics (skipped, `where`
 * clauses ignored), attributes (`@MainActor`, `@objc`, property wrappers), stored and computed properties
 * (`let` / `var`, visibility incl. `private(set)`, `static` / `class`), `func` (labels, defaults, `inout`,
 * `async` / `throws`, `-> Result`), `init`, enum cases. Return types and `x: Type` annotations feed the shared
 * name-based call graph (`buildCallGraph`) together with `let x = Foo()` locals, `self.field` types and
 * protocol/superclass conformances (dotted edges to implementers).
 *
 * NOT handled:
 *  - Import graph: Swift `import` names a MODULE, not a file, and types inside one module reference each other
 *    without any import. The graph is therefore module -> module (a module is a SwiftPM target folder
 *    `Sources/<M>/…` / `Tests/<M>/…`, else the top-level folder, else `(root)`), so type-level or file-level
 *    dependencies inside a module are not shown. Packages outside the scan (Foundation, Vapor, …) are skipped.
 *  - Class diagram: extensions of types that are not scanned (`extension String`) are dropped; `#if` branches are
 *    all read, so a type declared in both branches is merged; macros, result builders and property-wrapper
 *    projections are not interpreted. A class's first inherited name is taken as its superclass only when it is a
 *    scanned class, or an unscanned name that does not look like a protocol (`…able`, `…Delegate`, `…Protocol`);
 *    otherwise it is a conformance. Common standard-library conformances (`Codable`, `Equatable`, `Hashable`,
 *    `Sendable`, …) and raw types (`String`, `Int`, …) are left out of the diagram.
 *  - Call graph: closures, trailing-closure bodies and local functions belong to their enclosing function;
 *    `try`/`await`/`?.`/`!.` are ignored, so `try? repo?.save()` resolves like `repo.save()`. Overloads share one
 *    node per `Type.name`. Initialisers are nodes (`Type.init`) but `Type(...)` calls are not linked to them.
 *    Types that need inference (`let x = makeRepos()` returning arrays, closures' `$0`, generic substitution,
 *    property-wrapper types) are not resolved; arrays and dictionaries are not tracked as element types.
 */

// ---------- model ----------

export type SwiftVisibility = 'public' | 'internal' | 'fileprivate' | 'private';
export type SwiftTypeKind = 'class' | 'struct' | 'enum' | 'protocol' | 'actor' | 'extension';

export interface SwiftParam {
  /** External label (`from` in `func f(from user: User)`), `_` or null when absent. */
  label: string | null;
  /** Internal name used inside the body. */
  name: string;
  type: string;
}

export interface SwiftMethod {
  name: string;
  params: SwiftParam[];
  returnType: string;
  visibility: SwiftVisibility;
  isStatic: boolean;
  isInit: boolean;
  hasBody: boolean;
  /** Offsets of the body's `{` and `}` in the file's scrubbed text; -1 without a body. */
  bodyStart: number;
  bodyEnd: number;
  /** Scrubbed body text including the braces, or ''. */
  body: string;
  /** Simple name of the type (or extended type) that declares it, null for free functions. */
  owner: string | null;
}

export interface SwiftProperty {
  name: string;
  type: string;
  visibility: SwiftVisibility;
  isStatic: boolean;
}

export interface SwiftType {
  name: string;
  kind: SwiftTypeKind;
  visibility: SwiftVisibility;
  isFinal: boolean;
  /** Names after `:`, in source order (generics, `any`/`some` and module qualifiers removed). */
  inherits: string[];
  properties: SwiftProperty[];
  methods: SwiftMethod[];
  cases: string[];
  outer: string | null;
}

export interface SwiftImport {
  module: string;
  isTestable: boolean;
}

export interface SwiftFile {
  imports: SwiftImport[];
  types: SwiftType[];
  /** Free (top-level) functions. */
  functions: SwiftMethod[];
  scrubbed: string;
  original: string;
}

// ---------- lexical helpers ----------

const MODIFIERS =
  '(?:(?:public|private|fileprivate|internal|open|package|final|indirect|static|class|mutating|nonmutating|override|required|convenience|lazy|weak|unowned|optional|dynamic|nonisolated|isolated|distributed|prefix|postfix|infix|async|borrowing|consuming)(?:\\([^)]*\\))?\\s+)*';
const ATTRS = '(?:@[A-Za-z_][\\w.]*(?:\\s*\\([^)]*\\))?\\s+)*';
const PREFIX = `${ATTRS}(${MODIFIERS})`;
const NOT_NAME = '(?!(?:func|var|let|init|subscript|deinit|typealias|enum|struct|class|protocol|actor|extension|case)\\b)';
const TYPE_RE = new RegExp(`^${PREFIX}(class|struct|enum|protocol|actor|extension)\\s+${NOT_NAME}([A-Za-z_][\\w.]*)`);
const FUNC_RE = new RegExp(`^${PREFIX}func\\s+([A-Za-z_]\\w*|[-+*/%<>=!&|^~.?]+)`);
const INIT_RE = new RegExp(`^${PREFIX}init\\s*[?!]?`);
const VAR_RE = new RegExp(`^${PREFIX}(let|var)\\s+`);
const CASE_RE = new RegExp(`^${ATTRS}(?:indirect\\s+)?case\\s+`);

const STD_CONFORMANCES = new Set([
  'Codable', 'Decodable', 'Encodable', 'Equatable', 'Hashable', 'Comparable', 'Identifiable', 'Sendable', 'CustomStringConvertible',
  'CustomDebugStringConvertible', 'Error', 'LocalizedError', 'CaseIterable', 'RawRepresentable', 'AnyObject', 'Any', 'NSObject',
  'ObservableObject', 'View', 'App', 'Scene', 'Observable',
]);
const RAW_TYPES = new Set(['String', 'Int', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Double', 'Float', 'Character', 'Bool']);

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipWs(s: string, i: number, to: number): number {
  while (i < to && (isWs(s[i]) || s[i] === ';')) i++;
  return i;
}

/** End of the bracketed group opening at `open` ( `(`, `[` or `<` ), or -1. Angle brackets ignore `->`. */
function matchGroup(s: string, open: number, to = s.length): number {
  const o = s[open];
  const c = o === '(' ? ')' : o === '[' ? ']' : o === '<' ? '>' : '}';
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (o === '<' && s[i] === '-' && s[i + 1] === '>') {
      i++;
      continue;
    }
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

/**
 * End (exclusive) of the statement starting at `i`: the first newline or `;` outside any bracket. A newline does not
 * end it when the next line continues the expression (`.member`, `else`, `catch`, or an operator start).
 */
function statementEnd(s: string, i: number, to: number): number {
  let depth = 0;
  for (let j = i; j < to; j++) {
    const c = s[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '\n')) {
      if (c === '\n') {
        let k = j + 1;
        while (k < to && isWs(s[k])) k++;
        if (/^(\.[A-Za-z_]|\?\.|else\b|catch\b|where\b|&&|\|\||[?:] )/.test(s.slice(k, k + 8))) continue;
      }
      return j;
    }
  }
  return to;
}

function visibilityOf(mods: string, inProtocol: boolean): SwiftVisibility {
  if (/\bprivate\b(?!\s*\(set\))/.test(mods) && !/\bprivate\(set\)/.test(mods)) return 'private';
  if (/\bfileprivate\b/.test(mods)) return 'fileprivate';
  if (/\b(public|open)\b/.test(mods) && !/\b(public|open)\(set\)/.test(mods)) return 'public';
  // `private(set) var x` is publicly readable; show the read visibility (internal unless a public/open keyword stands alone).
  return inProtocol ? 'public' : 'internal';
}

/** Names inside an inheritance clause: `A, B<T>, any C, Module.D & E` -> [A, B, C, D, E]. */
function inheritanceNames(text: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(text, ',', false)) {
    for (const piece of part.split('&')) {
      const cleaned = piece
        .replace(/@\w+\s*/g, '')
        .replace(/\b(?:any|some|unchecked)\b\s*/g, '')
        .replace(/<[\s\S]*$/, '')
        .replace(/[?!]/g, '')
        .trim();
      const name = cleaned.split('.').pop() ?? '';
      if (/^[A-Za-z_]\w*$/.test(name)) out.push(name);
    }
  }
  return out;
}

/** `(_ a: Int, from b: User, c: String = "x", d: inout [Int], e: Int...)` -> params. */
function parseParams(s: string, original: string, open: number, close: number): SwiftParam[] {
  const out: SwiftParam[] = [];
  for (const piece of splitTopLevel(s.slice(open + 1, close), ',', false)) {
    // Strip a default value: first top-level `=` (the scrubbed text blanks string defaults).
    let depth = 0;
    let eq = -1;
    for (let k = 0; k < piece.length; k++) {
      const c = piece[k];
      if ('([{<'.includes(c)) depth++;
      else if (')]}'.includes(c) || (c === '>' && piece[k - 1] !== '-')) depth = Math.max(0, depth - 1);
      else if (c === '=' && depth === 0) {
        eq = k;
        break;
      }
    }
    const decl = (eq >= 0 ? piece.slice(0, eq) : piece).trim();
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const names = decl.slice(0, colon).trim().split(/\s+/).filter(Boolean);
    const type = decl
      .slice(colon + 1)
      .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
      .replace(/\binout\b\s*/, '')
      .replace(/\.\.\.\s*$/, '')
      .trim();
    if (names.length === 0) continue;
    const name = names[names.length - 1];
    const label = names.length > 1 ? names[0] : name;
    out.push({ label: label === '_' ? null : label, name, type });
  }
  void original;
  return out;
}

// ---------- parser ----------

export function parseSwift(source: string): SwiftFile {
  const s = scrub(source, 'swift');
  const file: SwiftFile = { imports: [], types: [], functions: [], scrubbed: s, original: source };

  // Imports can appear anywhere at top level; a line scan is enough.
  for (const m of s.matchAll(/^[ \t]*(?:@testable\s+|@_exported\s+|@preconcurrency\s+)*import\s+(?:(?:struct|class|enum|protocol|typealias|func|var|let)\s+)?([A-Za-z_][\w]*)/gm)) {
    file.imports.push({ module: m[1], isTestable: /@testable/.test(m[0]) });
  }

  const parseBody = (from: number, to: number, owner: SwiftType | null, outer: string | null): void => {
    let i = from;
    while (i < to) {
      i = skipWs(s, i, to);
      if (i >= to) break;
      if (s[i] === '}') {
        i++;
        continue;
      }
      if (s[i] === '#') {
        // `#if`, `#else`, `#endif`, `#warning`: skip the directive line, read all branches.
        while (i < to && s[i] !== '\n') i++;
        continue;
      }
      const rest = s.slice(i, Math.min(to, i + 400));

      const tm = TYPE_RE.exec(rest);
      if (tm) {
        const kind = tm[2] as SwiftTypeKind;
        const name = tm[3].split('.').pop()!;
        let j = i + tm[0].length;
        if (s[j] === '<') {
          const g = matchGroup(s, j, to);
          j = g < 0 ? j : g + 1;
        }
        // Header runs to the opening brace of the body.
        let depth = 0;
        let brace = -1;
        for (let k = j; k < to; k++) {
          const c = s[k];
          if ('([<'.includes(c) && !(c === '<' && false)) depth++;
          else if (')]'.includes(c) || (c === '>' && s[k - 1] !== '-')) depth = Math.max(0, depth - 1);
          else if (c === '{' && depth === 0) {
            brace = k;
            break;
          } else if (c === '\n' && depth === 0 && kind !== 'extension' && /^\s*(?:@|func|var|let|case|init|class|struct|enum|protocol|actor|extension|import|\}|$)/.test(s.slice(k + 1, k + 20)) && !/[,:&]\s*$/.test(s.slice(j, k))) {
            break; // a declaration without a body (malformed or truncated)
          }
        }
        if (brace < 0) {
          i = j;
          continue;
        }
        let header = s.slice(j, brace);
        const where = header.search(/\bwhere\b/);
        if (where >= 0) header = header.slice(0, where);
        const colon = header.indexOf(':');
        const inherits = colon >= 0 ? inheritanceNames(header.slice(colon + 1)) : [];
        const mods = tm[1] ?? '';
        const type: SwiftType = {
          name,
          kind,
          visibility: visibilityOf(mods, false),
          isFinal: /\bfinal\b/.test(mods),
          inherits,
          properties: [],
          methods: [],
          cases: [],
          outer,
        };
        file.types.push(type);
        const close = matchBrace(s, brace);
        parseBody(brace + 1, close, type, name);
        i = close + 1;
        continue;
      }

      const fm = FUNC_RE.exec(rest);
      const im = fm ? null : INIT_RE.exec(rest);
      if (fm || im) {
        const m = (fm ?? im)!;
        const mods = m[1] ?? '';
        let j = i + m[0].length;
        if (s[j] === '<') {
          const g = matchGroup(s, j, to);
          j = g < 0 ? j : g + 1;
        }
        while (j < to && isWs(s[j]) && s[j] !== '\n') j++;
        if (s[j] !== '(') {
          i = statementEnd(s, i, to);
          continue;
        }
        const close = matchGroup(s, j, to);
        if (close < 0) {
          i = to;
          continue;
        }
        const params = parseParams(s, source, j, close);
        // After the parameters: effects, `-> Ret`, `where`, then `{` (body) or the end of the declaration.
        let k = close + 1;
        let depth = 0;
        let bodyStart = -1;
        for (; k < to; k++) {
          const c = s[k];
          if ('([<'.includes(c)) depth++;
          else if (')]'.includes(c) || (c === '>' && s[k - 1] !== '-')) depth = Math.max(0, depth - 1);
          else if (c === '{' && depth === 0) {
            bodyStart = k;
            break;
          } else if ((c === '\n' || c === ';' || c === '}') && depth === 0) {
            let q = k + 1;
            while (q < to && isWs(s[q])) q++;
            if (c === '\n' && s[q] === '{') {
              bodyStart = q;
              k = q;
            }
            break;
          }
        }
        const sigEnd = k;
        const sig = s.slice(close + 1, sigEnd);
        const ret = /->\s*([\s\S]*?)\s*(?:\bwhere\b[\s\S]*)?$/.exec(sig)?.[1]?.trim() ?? '';
        const bodyEnd = bodyStart >= 0 ? matchBrace(s, bodyStart) : -1;
        const method: SwiftMethod = {
          name: fm ? fm[2] : 'init',
          params,
          returnType: ret,
          visibility: visibilityOf(mods, owner?.kind === 'protocol'),
          isStatic: /\b(static|class)\b/.test(mods),
          isInit: !fm,
          hasBody: bodyStart >= 0,
          bodyStart,
          bodyEnd,
          body: bodyStart >= 0 ? s.slice(bodyStart, bodyEnd + 1) : '',
          owner: owner ? owner.name : null,
        };
        if (owner) owner.methods.push(method);
        else if (fm) file.functions.push(method);
        i = bodyStart >= 0 ? bodyEnd + 1 : sigEnd;
        continue;
      }

      if (owner) {
        const cm = CASE_RE.exec(rest);
        if (cm && owner.kind === 'enum') {
          const end = statementEnd(s, i, to);
          for (const part of splitTopLevel(s.slice(i + cm[0].length, end), ',', false)) {
            const n = /^([A-Za-z_]\w*)/.exec(part.trim());
            if (n) owner.cases.push(n[1]);
          }
          i = end;
          continue;
        }
        const vm = VAR_RE.exec(rest);
        if (vm) {
          const mods = vm[1] ?? '';
          const end = statementEnd(s, i, to);
          const decl = s.slice(i + vm[0].length, end);
          const origDecl = source.slice(i + vm[0].length, end);
          // Declarators: `a, b: Int` or `a: Int = 1`. Stop each at a top-level `=` or `{`.
          let cut = decl.length;
          let depth = 0;
          for (let k = 0; k < decl.length; k++) {
            const c = decl[k];
            if ('([<'.includes(c)) depth++;
            else if (')]>'.includes(c) && !(c === '>' && decl[k - 1] === '-')) depth = Math.max(0, depth - 1);
            else if ((c === '=' || c === '{') && depth === 0 && decl[k + 1] !== '=' && decl[k - 1] !== '=' && decl[k - 1] !== '!' && decl[k - 1] !== '<' && decl[k - 1] !== '>') {
              cut = k;
              break;
            }
          }
          const head = decl.slice(0, cut);
          const colon = head.indexOf(':');
          const namesText = colon >= 0 ? head.slice(0, colon) : head;
          let type = colon >= 0 ? head.slice(colon + 1).trim() : '';
          if (!type) {
            // `let repo = Repo(...)`: the initialiser's type name, when it is a constructor call.
            const init = /^\s*=\s*(?:try[?!]?\s+)?(?:await\s+)?([A-Z][\w.]*)\s*\(/.exec(decl.slice(cut));
            if (init) type = init[1].split('.').pop()!;
          }
          for (const raw of namesText.split(',')) {
            const n = /^\s*([A-Za-z_]\w*)\s*$/.exec(raw);
            if (n) owner.properties.push({ name: n[1], type, visibility: visibilityOf(mods, owner.kind === 'protocol'), isStatic: /\b(static|class)\b/.test(mods) });
          }
          void origDecl;
          // Skip a computed-property / observer body that follows the declaration on the same statement.
          i = end;
          // statementEnd stops at the first unbracketed newline, but `{` counted as a bracket, so the body is already included.
          continue;
        }
      }

      // Anything else: skip one statement (braces and parens are jumped as a unit).
      const end = statementEnd(s, i, to);
      i = Math.max(end, i + 1);
    }
  };

  parseBody(0, s.length, null, null);
  return file;
}

// ---------- type text helpers ----------

/** Display form of a Swift type for a Mermaid class member. */
function typeLabel(raw: string): string {
  let t = raw
    .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
    .replace(/\b(?:any|some|inout)\b\s*/g, '')
    .replace(/\[\s*([^\]:]+?)\s*:\s*([^\]]+?)\s*\]/g, 'Dictionary<$1,$2>')
    .replace(/\[\s*([^\]:]+?)\s*\]/g, 'Array<$1>')
    .replace(/[?!]+(?=\W|$)/g, '');
  t = t.replace(/->/g, ' to ');
  return sanitizeType(t).replace(/\s*,\s*/g, ', ');
}

function vis(v: SwiftVisibility): string {
  return v === 'public' ? '+' : v === 'private' || v === 'fileprivate' ? '-' : '~';
}

const mermaidId = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_');

function methodMember(m: SwiftMethod, inProtocol: boolean): string {
  const ret = m.returnType ? ' ' + typeLabel(m.returnType) : '';
  const params = m.params.map((p) => p.label ?? p.name).join(', ');
  return `${vis(m.visibility)}${m.name}(${params})${ret}${m.isStatic ? '$' : ''}${inProtocol && !m.hasBody ? '*' : ''}`;
}

const looksLikeProtocol = (name: string): boolean => /(?:able|ible|Delegate|DataSource|Protocol|Convertible|Representable|Provider|Handling)$/.test(name) || STD_CONFORMANCES.has(name);

// ---------- class diagram ----------

export function analyzeSwiftClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const parsed = files.map((f) => parseSwift(f.text));
  const all = parsed.flatMap((p) => p.types);
  const declKinds = new Map<string, SwiftTypeKind>();
  for (const t of all) if (t.kind !== 'extension' && !declKinds.has(t.name)) declKinds.set(t.name, t.kind);

  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seenRel = new Set<string>();
  const byName = new Map<string, ExtractedClass>();

  const rel = (from: string, to: string, type: ExtractedRelationship['type']) => {
    const key = `${from}>${to}>${type}`;
    if (seenRel.has(key) || from === to) return;
    seenRel.add(key);
    relationships.push({ from: mermaidId(from), to: mermaidId(to), type });
  };

  const addMembers = (c: ExtractedClass, t: SwiftType) => {
    const inProtocol = t.kind === 'protocol';
    for (const n of t.cases) c.members.push(n);
    for (const p of t.properties) c.members.push(`${vis(p.visibility)}${p.name}${p.type ? ' ' + typeLabel(p.type) : ''}${p.isStatic ? '$' : ''}`);
    for (const m of t.methods) c.members.push(methodMember(m, inProtocol));
  };

  const relate = (t: SwiftType) => {
    const first = t.inherits[0];
    for (const [idx, name] of t.inherits.entries()) {
      if (STD_CONFORMANCES.has(name) || (t.kind === 'enum' && idx === 0 && RAW_TYPES.has(name))) continue;
      const known = declKinds.get(name);
      let type: ExtractedRelationship['type'];
      if (t.kind === 'protocol') type = 'inheritance'; // protocol refinement
      else if (t.kind === 'class' && idx === 0 && name === first) type = known ? (known === 'class' ? 'inheritance' : 'realization') : looksLikeProtocol(name) ? 'realization' : 'inheritance';
      else type = 'realization';
      rel(t.name, name, type);
    }
  };

  for (const t of all) {
    if (t.kind === 'extension') continue;
    if (byName.has(t.name)) continue;
    const stereotype: ExtractedClass['stereotype'] = t.kind === 'protocol' ? 'interface' : t.kind === 'enum' ? 'enumeration' : null;
    const c: ExtractedClass = { id: mermaidId(t.name), stereotype, members: [] };
    addMembers(c, t);
    byName.set(t.name, c);
    classes.push(c);
    relate(t);
  }
  // Extensions merge into the scanned type they extend; extensions of unscanned types are dropped.
  for (const t of all) {
    if (t.kind !== 'extension') continue;
    const c = byName.get(t.name);
    if (!c) continue;
    addMembers(c, t);
    relate({ ...t, kind: 'struct' }); // conformances added by an extension are always realizations
  }
  return { classes, relationships };
}

// ---------- import graph ----------

/** Module a scanned path belongs to: `Sources/<M>/…`, `Tests/<M>/…`, else the first folder, else `(root)`. */
export function swiftModuleOf(path: string): string {
  const m = /(?:^|\/)(?:Sources|Tests)\/([^/]+)\//.exec(path);
  if (m) return m[1];
  const parts = path.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

export function analyzeSwiftImports(files: SourceFileInput[]): CodeGraph {
  const counts = new Map<string, number>();
  const imports = new Map<string, Set<string>>();
  for (const f of files) {
    const mod = swiftModuleOf(f.path);
    counts.set(mod, (counts.get(mod) ?? 0) + 1);
    const set = imports.get(mod) ?? new Set<string>();
    for (const imp of parseSwift(f.text).imports) set.add(imp.module);
    imports.set(mod, set);
  }
  const edges: CodeGraph['edges'] = [];
  for (const [mod, wanted] of imports) {
    for (const target of wanted) {
      if (target === mod || !counts.has(target)) continue;
      edges.push({ from: mod, to: target, kind: 'import' });
    }
  }
  const nodes = [...counts].map(([id, n]) => ({ id, label: `${id}<br/>${n} file${n === 1 ? '' : 's'}`, kind: 'module' }));
  return { nodes: edges.length === 0 ? [] : nodes, edges };
}

// ---------- call graph ----------

/** Parameter text for the shared type inference: `name: Type`, collections as `Sequence<T>`, optionals stripped. */
function inferenceParams(params: SwiftParam[]): string {
  return params
    .map((p) => {
      const t = p.type.replace(/\b(?:any|some|inout)\b\s*/g, '').replace(/[?!]+(?=\W|$)/g, '').trim();
      const arr = /^\[\s*([A-Za-z_]\w*)\s*\]$/.exec(t);
      if (arr) return `${p.name}: Sequence<${arr[1]}>`;
      return /^[A-Za-z_][\w.]*$/.test(t) ? `${p.name}: ${t.split('.').pop()}` : `${p.name}: Unknown`;
    })
    .join(', ');
}

/** The type name of a plain (possibly optional) type, else null. */
function plainType(raw: string): string | null {
  const t = raw.replace(/\b(?:any|some)\b\s*/g, '').replace(/[?!]+$/g, '').trim();
  return /^[A-Za-z_][\w.]*$/.test(t) ? t.split('.').pop()! : null;
}

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const declaredTypes = new Set<string>();
  const fieldTypes = new Map<string, Map<string, string>>();

  const toFn = (path: string, m: SwiftMethod): DeclaredFn | null => {
    if (!m.hasBody) return null;
    // `try`, `await` and optional chaining do not change what is called; dropping them lets the shared resolver see `x.f(`.
    const body = m.body.replace(/\btry[?!]?\s+/g, ' ').replace(/\bawait\s+/g, ' ').replace(/[?!]\./g, '.');
    const ret = m.returnType.replace(/\s+/g, '');
    return {
      nodeId: `${path}::${m.owner ? m.owner + '.' : ''}${m.name}`,
      label: m.owner ? `${m.owner}.${m.name}` : m.name,
      shortName: m.name,
      className: m.owner,
      body,
      kind: m.owner ? 'method' : 'function',
      params: inferenceParams(m.params),
      returns: ret && !/^[\[(]|^(?:Array|Set|Dictionary)</.test(ret) ? ret : undefined,
    };
  };

  for (const f of files) {
    const swift = parseSwift(f.text);
    for (const t of swift.types) {
      declaredTypes.add(t.name);
      if (t.inherits.length) supers.set(t.name, [...(supers.get(t.name) ?? []), ...t.inherits]);
      const ft = fieldTypes.get(t.name) ?? new Map<string, string>();
      for (const p of t.properties) {
        const pt = plainType(p.type);
        if (pt && !ft.has(p.name)) ft.set(p.name, pt);
      }
      fieldTypes.set(t.name, ft);
      for (const m of t.methods) {
        const fn = toFn(f.path, m);
        if (fn) fns.push(fn);
      }
    }
    for (const m of swift.functions) {
      const fn = toFn(f.path, m);
      if (fn) fns.push(fn);
    }
  }
  return buildCallGraph(fns, { selfCall: '\\bself\\.([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: true, fieldTypes, supers, declaredTypes });
}

// ---------- analyzers ----------

export const swiftImportGraphAnalyzer: CodeAnalyzer = {
  id: 'swift-import-graph',
  displayName: 'Module Graph (Swift)',
  supportedExtensions: ['.swift'],
  analyze: analyzeSwiftImports,
};

export const swiftCallGraphAnalyzer: CodeAnalyzer = {
  id: 'swift-call-graph',
  displayName: 'Call Graph (Swift)',
  supportedExtensions: ['.swift'],
  analyze: analyzeCalls,
};

export { analyzeCalls as analyzeSwiftCalls };
