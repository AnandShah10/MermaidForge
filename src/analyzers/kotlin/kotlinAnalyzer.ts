import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';

/**
 * Kotlin analyzers over scrubbed text with brace matching — no compiler front end, no Gradle/classpath, no
 * kapt/KSP. Handled: `package` / `import` (wildcard, `as` alias), class / interface / `fun interface` / object /
 * enum / annotation / data / sealed / value declarations (nested types are flattened by simple name), primary
 * constructors (`val`/`var` parameters become properties), supertype lists (`: Base(args), Iface by delegate`),
 * generics, `companion object` members (marked static), properties (initialiser, `by` delegates, getters and
 * setters, explicit or constructor-inferred type), functions (generics, extension receivers `fun Foo.bar()`,
 * expression bodies, multi-line signatures), secondary constructors and `init` blocks, enum constants with
 * bodies. Annotations are read with their arguments from the ORIGINAL source (the scrubber blanks strings).
 * Routes: Spring MVC/WebFlux annotations (`@RestController`, `@RequestMapping`, `@GetMapping` …, array
 * arguments as `["/a", "/b"]` or `arrayOf(..)`) and the Ktor routing DSL (see `kotlinRouteAnalyzer.ts`).
 *
 * NOT handled: local and anonymous classes / object expressions (their code is attributed to the enclosing
 * function), type resolution of any kind (overloads are merged, same-named types in different packages are
 * conflated by simple name, inherited properties are not resolved), call receivers that are lambda parameters
 * (`it`), results of arbitrary expressions, scope functions (`apply`/`let` change `this`), operator and infix
 * calls, `typealias` (ignored), `expect`/`actual` pairing, Kotlin script files (`.kts`) beyond the same
 * syntax, annotation processing and code generation (kapt, KSP, Lombok-like plugins), Kotlin Multiplatform
 * source-set resolution. Import graph: only explicit imports between scanned files are edges; same-package
 * references without an import are NOT edges (Kotlin allows them, but detecting them needs name resolution);
 * stdlib and third-party imports are ignored. Call graph: calls are resolved by name, same-file first, then
 * imported files, then dotted "ambiguous" edges; `x?.foo()` / `x!!.foo()` count as `x.foo()`; typed
 * parameters/properties/`val x = Foo()` locals resolve receivers; `for (r in repos)` over a typed collection
 * types `r`; lambdas, `it`, and extension calls on untyped values are not resolved.
 */

// ---------- model ----------

export interface KotlinAnnotation {
  /** Simple name without `@`, use-site target or package qualification. */
  name: string;
  /** Argument text between the parentheses, from the ORIGINAL source (string literals intact). */
  args: string;
  /** Same text from the scrubbed source: same length as `args`, strings/comments blanked. */
  argsScrubbed: string;
}

export interface KotlinImport {
  /** As written, e.g. `com.acme.Util`, `com.acme.*`. */
  name: string;
  alias: string | null;
  isWildcard: boolean;
}

export type KotlinVisibility = 'public' | 'protected' | 'private' | 'internal';
export type KotlinKind = 'class' | 'interface' | 'object' | 'enum' | 'annotation';

export interface KotlinProp {
  name: string;
  /** Declared type text, or the class name inferred from `= Foo(...)`; '' when unknown. */
  type: string;
  visibility: KotlinVisibility;
  isVar: boolean;
  isStatic: boolean;
  /** `val Foo.bar` — an extension property. */
  receiver: string | null;
}

export interface KotlinFun {
  name: string;
  /** Simple name of the extension receiver type (`fun Foo.bar()` -> `Foo`), else null. */
  receiver: string | null;
  /** Parameter names. */
  params: string[];
  /** Parameters as `name: Type, name: Type` (defaults removed) for type inference. */
  paramDecls: string;
  returnType: string;
  visibility: KotlinVisibility;
  isAbstract: boolean;
  isOverride: boolean;
  isStatic: boolean;
  isConstructor: boolean;
  /** Scrubbed body text; '' when there is none. */
  body: string;
  hasBody: boolean;
  annotations: KotlinAnnotation[];
}

export interface KotlinSuper {
  /** Simple name, generics and qualifiers stripped. */
  name: string;
  /** Written with constructor arguments (`Base(x)`): a class, not an interface. */
  isCall: boolean;
}

export interface KotlinType {
  name: string;
  kind: KotlinKind;
  modifiers: string[];
  visibility: KotlinVisibility;
  isAbstract: boolean;
  isSealed: boolean;
  isData: boolean;
  supers: KotlinSuper[];
  annotations: KotlinAnnotation[];
  props: KotlinProp[];
  funs: KotlinFun[];
  enumConstants: string[];
  /** Enclosing type's simple name for nested types, else null. */
  outer: string | null;
}

export interface KotlinFile {
  packageName: string | null;
  imports: KotlinImport[];
  /** All types, nested ones flattened (outer types come before their nested types). */
  types: KotlinType[];
  /** Top-level functions, extension functions included. */
  topFuns: KotlinFun[];
  topProps: KotlinProp[];
}

const MODS = new Set([
  'public', 'protected', 'private', 'internal', 'abstract', 'open', 'final', 'sealed', 'data', 'enum', 'annotation', 'inner', 'value',
  'inline', 'suspend', 'override', 'operator', 'infix', 'tailrec', 'external', 'const', 'lateinit', 'vararg', 'crossinline', 'noinline',
  'reified', 'expect', 'actual', 'fun', 'out', 'in',
]);
const IDENT = /`[^`\n]+`|[A-Za-z_][\w]*/y;

interface Ctx {
  text: string; // scrubbed
  orig: string;
  file: KotlinFile;
}

function skipWs(text: string, i: number, end = text.length): number {
  while (i < end && /\s/.test(text[i])) i++;
  return i;
}

function matchPair(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return text.length;
}

/** Index just past the `>` closing the `<` at openIdx (`->` is ignored). */
function skipAngles(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>' && s[i - 1] !== '-' && --depth === 0) return i + 1;
  }
  return s.length;
}

function removeGenerics(s: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') depth++;
    else if (c === '>' && s[i - 1] !== '-') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

function simpleName(raw: string): string {
  const t = removeGenerics(raw).replace(/[?*]/g, '').replace(/\b(?:out|in)\s+/g, '').trim();
  return t.split('.').pop()!.replace(/`/g, '').trim();
}

function readIdent(text: string, i: number): { name: string; end: number } | null {
  IDENT.lastIndex = i;
  const m = IDENT.exec(text);
  return m ? { name: m[0].replace(/`/g, ''), end: i + m[0].length } : null;
}

/** Removes `@Name` / `@a.b.Name(...)` / `@get:Name` annotations (scrubbed text), keeping everything else. */
function stripAnnotations(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '@') {
      let j = i + 1;
      while (j < s.length && /[\w.:]/.test(s[j])) j++;
      const k = skipWs(s, j);
      if (s[k] === '(') j = matchPair(s, k, '(', ')') + 1;
      i = Math.min(j, s.length);
      out += ' ';
      continue;
    }
    out += s[i++];
  }
  return out;
}

/**
 * End of an expression that starts at `i`: the first newline at bracket depth 0 that does not continue it
 * (operator at the end of the line, `.`/`?.`/`?:`/`&&`/`||`/`else` at the start of the next), `;`, or a closing
 * bracket of the enclosing scope.
 */
function exprEnd(text: string, i: number, end = text.length): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = text[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return j;
      depth--;
    } else if (depth === 0 && c === ';') return j;
    else if (depth === 0 && c === '\n') {
      let p = j - 1;
      while (p > i && /[ \t\r]/.test(text[p])) p--;
      if (p >= i && /[,+\-*/&|=.(:?<]/.test(text[p]) && !(text[p] === '>' )) continue;
      const nx = skipWs(text, j, end);
      const rest = text.slice(nx, nx + 6);
      if (/^(?:\.|\?\.|\?:|&&|\|\||\+|\*|\/|->|==|!=|else\b|catch\b|finally\b|\bby\b)/.test(rest)) continue;
      return j;
    }
  }
  return end;
}

/**
 * End of a type expression that starts at `i`, stopping at a body `{`, `=` (when `stopAtEq`), ` by ` (when
 * `stopAtBy`), `where`, or a newline that does not continue the signature.
 */
function typeEnd(text: string, i: number, end: number, stopAtEq: boolean, stopAtBy: boolean): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = text[j];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || (c === '>' && text[j - 1] !== '-')) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '{') return j;
    else if (depth === 0 && c === '=' && stopAtEq && text[j + 1] !== '=') return j;
    else if (depth === 0 && stopAtBy && /^\bby\b/.test(text.slice(j, j + 3)) && /\s/.test(text[j - 1] ?? ' ')) return j;
    else if (depth === 0 && /^where\b/.test(text.slice(j, j + 6)) && /\s/.test(text[j - 1] ?? ' ')) return j;
    else if (depth === 0 && c === '\n') {
      const nx = skipWs(text, j, end);
      if (text[nx] === '{' || (text[nx] === '=' && stopAtEq && text[nx + 1] !== '=')) continue;
      return j;
    }
  }
  return end;
}

function visibilityOf(mods: string[]): KotlinVisibility {
  if (mods.includes('private')) return 'private';
  if (mods.includes('protected')) return 'protected';
  if (mods.includes('internal')) return 'internal';
  return 'public';
}

// ---------- parsing ----------

function readAnnotation(ctx: Ctx, at: number): { anno: KotlinAnnotation | null; next: number } {
  const { text, orig } = ctx;
  let p = at + 1;
  let target = '';
  if (text[p] === '[') {
    // `@[A B]` — treat as a single opaque annotation group.
    const close = matchPair(text, p, '[', ']');
    return { anno: null, next: close + 1 };
  }
  const nameStart = p;
  while (p < text.length && /[\w.:]/.test(text[p])) p++;
  let qualified = text.slice(nameStart, p);
  const colon = qualified.indexOf(':');
  if (colon >= 0) {
    target = qualified.slice(0, colon);
    qualified = qualified.slice(colon + 1);
  }
  const q = p;
  const k = text[q] === '(' ? q : -1; // arguments must start right after the name
  let args = '';
  let argsScrubbed = '';
  let next = p;
  if (k >= 0) {
    const close = matchPair(text, k, '(', ')');
    args = orig.slice(k + 1, close);
    argsScrubbed = text.slice(k + 1, close);
    next = Math.min(close + 1, text.length);
  }
  if (target === 'file') return { anno: null, next };
  return { anno: { name: qualified.split('.').pop()!, args, argsScrubbed }, next };
}

/** Splits a constructor / function parameter list into `[annotations-stripped segment]` entries. */
function paramSegments(scrubbed: string): string[] {
  return splitTopLevel(stripAnnotations(scrubbed), ',').map((s) => s.trim()).filter(Boolean);
}

function typeOfSegment(seg: string): { mods: string[]; kw: string | null; name: string; type: string } | null {
  const m = /^((?:(?:public|private|protected|internal|vararg|noinline|crossinline|override|open|final|lateinit)\s+)*)(?:(val|var)\s+)?(`[^`]+`|[A-Za-z_]\w*)\s*(?::\s*([\s\S]*?))?(?:\s*=[\s\S]*)?$/.exec(seg);
  if (!m) return null;
  const type = (m[4] ?? '').trim();
  return { mods: m[1].trim().split(/\s+/).filter(Boolean), kw: m[2] ?? null, name: m[3].replace(/`/g, ''), type };
}

function inferredType(init: string): string {
  const m = /^\s*(?:[A-Za-z_]\w*\.)*([A-Z]\w*)\s*(?:<[^>()]*>)?\s*\(/.exec(init);
  return m ? m[1] : '';
}

function parseFun(ctx: Ctx, at: number, mods: string[], annotations: KotlinAnnotation[], owner: KotlinType | null, isStatic: boolean): { fn: KotlinFun | null; next: number } {
  const { text } = ctx;
  let i = skipWs(text, at);
  if (text[i] === '<') i = skipWs(text, skipAngles(text, i));
  // header up to the parameter list: `Receiver.name` or `name`
  let p = i;
  let depth = 0;
  for (; p < text.length; p++) {
    const c = text[p];
    if (c === '<') depth++;
    else if (c === '>' && text[p - 1] !== '-') depth = Math.max(0, depth - 1);
    else if (c === '(' && depth === 0) break;
    else if (c === '\n' || c === '{' || c === '=') return { fn: null, next: exprEnd(text, at) };
  }
  if (p >= text.length) return { fn: null, next: text.length };
  const header = text.slice(i, p).trim();
  let receiver: string | null = null;
  let name = header;
  let dot = -1;
  let d = 0;
  for (let k = 0; k < header.length; k++) {
    const c = header[k];
    if (c === '<' || c === '(') d++;
    else if ((c === '>' && header[k - 1] !== '-') || c === ')') d = Math.max(0, d - 1);
    else if (c === '.' && d === 0) dot = k;
  }
  if (dot >= 0) {
    receiver = simpleName(header.slice(0, dot));
    name = header.slice(dot + 1);
  }
  name = name.replace(/`/g, '').trim();
  if (!/^[\w ]+$/.test(name)) return { fn: null, next: exprEnd(text, p) };
  const close = matchPair(text, p, '(', ')');
  const segs = paramSegments(text.slice(p + 1, close))
    .map(typeOfSegment)
    .filter((x): x is NonNullable<ReturnType<typeof typeOfSegment>> => !!x);
  let j = skipWs(text, close + 1);
  let returnType = '';
  if (text[j] === ':') {
    const e = typeEnd(text, j + 1, text.length, true, false);
    returnType = text.slice(j + 1, e).trim().replace(/\s+/g, ' ');
    j = e;
  }
  j = skipWs(text, j);
  if (/^where\b/.test(text.slice(j, j + 6))) j = typeEnd(text, j + 5, text.length, true, false);
  j = skipWs(text, j);
  let body = '';
  let hasBody = false;
  let next = j;
  if (text[j] === '{') {
    const e = matchBrace(text, j);
    body = text.slice(j + 1, e);
    hasBody = true;
    next = Math.min(e + 1, text.length);
  } else if (text[j] === '=') {
    const e = exprEnd(text, j + 1);
    body = text.slice(j + 1, e);
    hasBody = true;
    next = e;
  } else next = close + 1;
  const isInterface = owner?.kind === 'interface';
  const fn: KotlinFun = {
    name,
    receiver,
    params: segs.map((s) => s.name),
    paramDecls: segs.map((s) => (s.type ? `${s.name}: ${s.type}` : s.name)).join(', '),
    returnType,
    visibility: visibilityOf(mods),
    isAbstract: mods.includes('abstract') || (isInterface && !hasBody),
    isOverride: mods.includes('override'),
    isStatic,
    isConstructor: false,
    body,
    hasBody,
    annotations,
  };
  return { fn, next };
}

function parseProp(ctx: Ctx, at: number, isVar: boolean, mods: string[], isStatic: boolean): { prop: KotlinProp | null; next: number } {
  const { text } = ctx;
  let i = skipWs(text, at);
  if (text[i] === '<') i = skipWs(text, skipAngles(text, i));
  if (text[i] === '(') return { prop: null, next: exprEnd(text, i) }; // destructuring
  // header: [Receiver.]name
  let p = i;
  let depth = 0;
  for (; p < text.length; p++) {
    const c = text[p];
    if (c === '<') depth++;
    else if (c === '>' && text[p - 1] !== '-') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ':' || c === '=' || c === '\n' || c === ';')) break;
    else if (depth === 0 && /^\sby\b/.test(text.slice(p, p + 4))) break;
  }
  const header = text.slice(i, p).trim();
  if (!header) return { prop: null, next: exprEnd(text, i) };
  let receiver: string | null = null;
  let name = header;
  const dot = header.lastIndexOf('.');
  if (dot >= 0) {
    receiver = simpleName(header.slice(0, dot));
    name = header.slice(dot + 1);
  }
  name = name.replace(/`/g, '').trim();
  let j = skipWs(text, p);
  let type = '';
  if (text[j] === ':') {
    const e = typeEnd(text, j + 1, text.length, true, true);
    type = text.slice(j + 1, e).trim().replace(/\s+/g, ' ');
    j = skipWs(text, e);
  }
  let init = '';
  let end = j;
  if (text[j] === '=') {
    end = exprEnd(text, j + 1);
    init = text.slice(j + 1, end);
  } else if (/^by\b/.test(text.slice(j, j + 3))) {
    end = exprEnd(text, j + 2);
    init = text.slice(j + 2, end);
  }
  // getter / setter accessors on the following lines
  for (let n = 0; n < 2; n++) {
    const a = skipWs(text, end);
    const m = /^(?:(?:private|protected|internal|public|inline|external)\s+)*(?:get|set)\b\s*(?=\(|\{|=|$|\n)/.exec(text.slice(a, a + 60));
    if (!m) break;
    let k = a + m[0].length;
    k = skipWs(text, k);
    if (text[k] === '(') k = skipWs(text, matchPair(text, k, '(', ')') + 1);
    if (text[k] === ':') k = typeEnd(text, k + 1, text.length, true, false);
    k = skipWs(text, k);
    if (text[k] === '{') end = Math.min(matchBrace(text, k) + 1, text.length);
    else if (text[k] === '=') end = exprEnd(text, k + 1);
    else end = k;
  }
  return { prop: { name, type: type || inferredType(init), visibility: visibilityOf(mods), isVar, isStatic, receiver }, next: Math.max(end, p) };
}

function parseSupers(text: string): KotlinSuper[] {
  const out: KotlinSuper[] = [];
  for (const raw of splitTopLevel(text, ',')) {
    const entry = raw.replace(/\s+by\s+[\s\S]*$/, '').trim();
    if (!entry) continue;
    const isCall = /\)\s*$/.test(entry) || /^[\w.<>?, *]+\s*\(/.test(entry);
    const head = entry.split('(')[0];
    const name = simpleName(head);
    if (name) out.push({ name, isCall: isCall && entry.includes('(') });
  }
  return out;
}

function parseClass(ctx: Ctx, at: number, keyword: string, mods: string[], annotations: KotlinAnnotation[], outer: KotlinType | null): number {
  const { text, orig } = ctx;
  let i = skipWs(text, at);
  const id = readIdent(text, i);
  if (!id) return exprEnd(text, at);
  const name = id.name;
  i = id.end;
  if (text[i] === '<') i = skipAngles(text, i);
  const type: KotlinType = {
    name,
    kind: keyword === 'interface' ? 'interface' : keyword === 'object' ? 'object' : mods.includes('enum') ? 'enum' : mods.includes('annotation') ? 'annotation' : 'class',
    modifiers: mods,
    visibility: visibilityOf(mods),
    isAbstract: mods.includes('abstract') || mods.includes('sealed') || keyword === 'interface',
    isSealed: mods.includes('sealed'),
    isData: mods.includes('data'),
    supers: [],
    annotations,
    props: [],
    funs: [],
    enumConstants: [],
    outer: outer ? outer.name : null,
  };
  ctx.file.types.push(type);
  // primary constructor, possibly with modifiers / annotations / `constructor`
  let j = skipWs(text, i);
  let ctorMods: string[] = [];
  for (;;) {
    if (text[j] === '@') {
      j = skipWs(text, readAnnotation(ctx, j).next);
      continue;
    }
    const w = /^(public|private|protected|internal|constructor)\b/.exec(text.slice(j, j + 12));
    if (!w) break;
    if (w[1] === 'constructor') {
      j = skipWs(text, j + w[1].length);
      break;
    }
    ctorMods.push(w[1]);
    j = skipWs(text, j + w[1].length);
  }
  if (text[j] === '(') {
    const close = matchPair(text, j, '(', ')');
    for (const seg of paramSegments(text.slice(j + 1, close))) {
      const t = typeOfSegment(seg);
      if (t && t.kw) type.props.push({ name: t.name, type: t.type, visibility: visibilityOf(t.mods), isVar: t.kw === 'var', isStatic: false, receiver: null });
    }
    j = skipWs(text, close + 1);
  }
  ctorMods = [];
  if (text[j] === ':') {
    const e = typeEnd(text, j + 1, text.length, false, false);
    type.supers = parseSupers(text.slice(j + 1, e));
    j = e;
  }
  j = skipWs(text, j);
  if (/^where\b/.test(text.slice(j, j + 6))) j = typeEnd(text, j + 5, text.length, false, false);
  j = skipWs(text, j);
  void orig;
  if (text[j] !== '{') return j;
  const close = matchBrace(text, j);
  scanScope(ctx, j + 1, close, type, false);
  return Math.min(close + 1, text.length);
}

function parseEnumConstants(ctx: Ctx, from: number, to: number, type: KotlinType): number {
  const { text } = ctx;
  let i = from;
  for (;;) {
    i = skipWs(text, i, to);
    while (text[i] === '@') i = skipWs(text, readAnnotation(ctx, i).next, to);
    const id = readIdent(text, i);
    if (!id || i >= to) return i;
    // An enum constant is an identifier followed by `,`, `;`, `(`, `{` or the end of the entries.
    let k = skipWs(text, id.end, to);
    if (!(k >= to || ',;({'.includes(text[k]) || text[k] === '\n' || text[k] === '}')) return i;
    type.enumConstants.push(id.name);
    if (text[k] === '(') k = skipWs(text, matchPair(text, k, '(', ')') + 1, to);
    if (text[k] === '{') k = skipWs(text, matchBrace(text, k) + 1, to);
    if (text[k] === ',') {
      i = k + 1;
      continue;
    }
    if (text[k] === ';') return k + 1;
    return k;
  }
}

function lineEndOf(text: string, i: number, end: number): number {
  const k = text.indexOf('\n', i);
  return k < 0 || k > end ? end : k;
}

function scanScope(ctx: Ctx, from: number, to: number, owner: KotlinType | null, inCompanion: boolean): void {
  const { text, file } = ctx;
  let i = from;
  const initBodies: string[] = [];
  if (owner && owner.kind === 'enum') i = parseEnumConstants(ctx, i, to, owner);
  while (i < to) {
    i = skipWs(text, i, to);
    while (i < to && text[i] === ';') i = skipWs(text, i + 1, to);
    if (i >= to) break;
    const start = i;
    const annotations: KotlinAnnotation[] = [];
    const mods: string[] = [];
    // annotations and modifiers
    for (;;) {
      i = skipWs(text, i, to);
      if (text[i] === '@') {
        const r = readAnnotation(ctx, i);
        if (r.anno) annotations.push(r.anno);
        i = r.next;
        continue;
      }
      const w = readIdent(text, i);
      if (w && MODS.has(w.name) && !(w.name === 'fun' && !/^fun\s+interface\b/.test(text.slice(i, i + 20)) && true && false)) {
        // `fun` is a modifier only in `fun interface`
        if (w.name === 'fun' && !/^fun\s+interface\b/.test(text.slice(i, i + 20))) break;
        // `in`/`out` are variance modifiers, not statement starters — never at declaration level
        if (w.name === 'in' || w.name === 'out') break;
        mods.push(w.name);
        i = w.end;
        continue;
      }
      break;
    }
    i = skipWs(text, i, to);
    const kw = readIdent(text, i);
    if (!kw) {
      i = Math.max(i + 1, exprEnd(text, i, to));
      continue;
    }
    const word = kw.name;
    const after = kw.end;
    if (word === 'package' && owner === null) {
      const e = lineEndOf(text, after, to);
      file.packageName = text.slice(after, e).trim() || null;
      i = e;
    } else if (word === 'import' && owner === null) {
      const e = lineEndOf(text, after, to);
      const raw = text.slice(after, e).trim();
      const m = /^([\w.`]+(?:\.\*)?)(?:\s+as\s+(\w+))?$/.exec(raw);
      if (m) file.imports.push({ name: m[1].replace(/`/g, ''), alias: m[2] ?? null, isWildcard: m[1].endsWith('.*') });
      i = e;
    } else if (word === 'typealias') {
      i = exprEnd(text, after, to);
    } else if (word === 'class' || word === 'interface') {
      i = parseClass(ctx, after, word, mods, annotations, owner);
    } else if (word === 'fun' && /^\s+interface\b/.test(text.slice(after, after + 20))) {
      i = parseClass(ctx, skipWs(text, after) + 'interface'.length, 'interface', mods, annotations, owner);
    } else if (word === 'object') {
      const nx = skipWs(text, after, to);
      if (readIdent(text, nx)) i = parseClass(ctx, after, 'object', mods, annotations, owner);
      else i = Math.max(i + 1, exprEnd(text, after, to)); // object expression
    } else if (word === 'companion') {
      const objKw = readIdent(text, skipWs(text, after, to));
      if (objKw?.name !== 'object') {
        i = exprEnd(text, after, to);
        continue;
      }
      let j = skipWs(text, objKw.end, to);
      const nm = readIdent(text, j);
      if (nm && nm.name !== 'object') j = skipWs(text, nm.end, to);
      if (text[j] === ':') j = typeEnd(text, j + 1, text.length, false, false);
      j = skipWs(text, j, to);
      if (text[j] === '{') {
        const close = matchBrace(text, j);
        if (owner) scanScope(ctx, j + 1, close, owner, true);
        i = Math.min(close + 1, text.length);
      } else i = j;
    } else if (word === 'fun') {
      const r = parseFun(ctx, after, mods, annotations, owner, inCompanion);
      if (r.fn) {
        if (owner) owner.funs.push(r.fn);
        else file.topFuns.push(r.fn);
      }
      i = Math.max(r.next, after);
    } else if (word === 'val' || word === 'var') {
      const r = parseProp(ctx, after, word === 'var', mods, inCompanion);
      if (r.prop) {
        if (owner && !r.prop.receiver) owner.props.push(r.prop);
        else if (!owner) file.topProps.push(r.prop);
      }
      i = Math.max(r.next, after);
    } else if (word === 'init' && owner) {
      const j = skipWs(text, after, to);
      if (text[j] === '{') {
        const close = matchBrace(text, j);
        initBodies.push(text.slice(j + 1, close));
        i = Math.min(close + 1, text.length);
      } else i = exprEnd(text, after, to);
    } else if (word === 'constructor' && owner) {
      const j = skipWs(text, after, to);
      if (text[j] !== '(') {
        i = exprEnd(text, after, to);
        continue;
      }
      const close = matchPair(text, j, '(', ')');
      let k = skipWs(text, close + 1, to);
      if (text[k] === ':') k = typeEnd(text, k + 1, text.length, false, false);
      k = skipWs(text, k, to);
      let body = '';
      let next = k;
      if (text[k] === '{') {
        const e = matchBrace(text, k);
        body = text.slice(k + 1, e);
        next = Math.min(e + 1, text.length);
      }
      const segs = paramSegments(text.slice(j + 1, close)).map(typeOfSegment).filter((x): x is NonNullable<ReturnType<typeof typeOfSegment>> => !!x);
      owner.funs.push({
        name: owner.name,
        receiver: null,
        params: segs.map((s) => s.name),
        paramDecls: segs.map((s) => (s.type ? `${s.name}: ${s.type}` : s.name)).join(', '),
        returnType: '',
        visibility: visibilityOf(mods),
        isAbstract: false,
        isOverride: false,
        isStatic: false,
        isConstructor: true,
        body,
        hasBody: true,
        annotations,
      });
      i = next;
    } else {
      // Unknown statement (script code, stray tokens): skip it.
      i = Math.max(start + 1, exprEnd(text, after, to));
    }
    if (i <= start) i = start + 1;
  }
  if (owner && initBodies.length) {
    owner.funs.push({
      name: 'init', receiver: null, params: [], paramDecls: '', returnType: '', visibility: 'private', isAbstract: false, isOverride: false,
      isStatic: false, isConstructor: true, body: initBodies.join('\n'), hasBody: true, annotations: [],
    });
  }
}

export function parseKotlin(source: string): KotlinFile {
  const file: KotlinFile = { packageName: null, imports: [], types: [], topFuns: [], topProps: [] };
  try {
    const text = scrub(source, 'kotlin');
    scanScope({ text, orig: source, file }, 0, text.length, null, false);
  } catch {
    // Malformed input: return whatever was recovered.
  }
  return file;
}

// ---------- classes ----------

function typeLabel(raw: string): string {
  const t = raw
    .replace(/\b(?:[a-z_]\w*\.)+(?=[A-Z])/g, '')
    .replace(/->/g, ' to ')
    .replace(/[?*]/g, '')
    .replace(/\b(?:out|in)\s+/g, '')
    .replace(/@\w+\s*/g, '')
    .replace(/\s*&\s*/g, ' ');
  return sanitizeType(t).replace(/\s*,\s*/g, ', ');
}

function vis(v: KotlinVisibility): string {
  return v === 'public' ? '+' : v === 'private' ? '-' : v === 'protected' ? '#' : '~';
}

function mermaidId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function funMember(m: KotlinFun): string {
  const ret = m.returnType ? ' ' + typeLabel(m.returnType) : '';
  return `${vis(m.visibility)}${m.name}(${m.params.join(', ')})${ret}${m.isStatic ? '$' : ''}${m.isAbstract ? '*' : ''}`;
}

export function analyzeKotlinClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const parsed = files.map((f) => parseKotlin(f.text));
  const kinds = new Map<string, KotlinKind>();
  for (const k of parsed) for (const t of k.types) if (!kinds.has(t.name)) kinds.set(t.name, t.kind);
  // extension functions are shown on the class they extend, when that class is scanned
  const extensions = new Map<string, KotlinFun[]>();
  for (const k of parsed) for (const fn of k.topFuns) if (fn.receiver && kinds.has(fn.receiver)) extensions.set(fn.receiver, [...(extensions.get(fn.receiver) ?? []), fn]);

  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();
  const seenRel = new Set<string>();
  for (const k of parsed) {
    for (const t of k.types) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      const stereotype: ExtractedClass['stereotype'] = t.kind === 'interface' || t.kind === 'annotation' ? 'interface' : t.kind === 'enum' ? 'enumeration' : t.isAbstract ? 'abstract' : null;
      const members: string[] = [...t.enumConstants];
      for (const p of t.props) members.push(`${vis(p.visibility)}${p.name}${p.type ? ' ' + typeLabel(p.type) : ''}${p.isStatic ? '$' : ''}`);
      for (const m of t.funs) if (!m.isConstructor) members.push(funMember(m));
      for (const m of extensions.get(t.name) ?? []) members.push(funMember(m));
      classes.push({ id: mermaidId(t.name), stereotype, members });
      const rel = (to: string, type: ExtractedRelationship['type']) => {
        const key = `${t.name}>${to}>${type}`;
        if (seenRel.has(key)) return;
        seenRel.add(key);
        relationships.push({ from: mermaidId(t.name), to: mermaidId(to), type });
      };
      for (const s of t.supers) {
        // `Base(x)` is a class; an interface extends interfaces; a plain name is an interface unless it is a scanned class.
        const superKind = kinds.get(s.name);
        const inherits = t.kind === 'interface' || s.isCall || (superKind !== undefined && superKind !== 'interface' && superKind !== 'annotation');
        rel(s.name, inherits ? 'inheritance' : 'realization');
      }
    }
  }
  return { classes, relationships };
}

// ---------- imports ----------

export function analyzeKotlinImports(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, kt: parseKotlin(f.text) }));
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const byQualified = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const { path, kt } of parsed) {
    const pkg = kt.packageName ?? '';
    const names = [...kt.types.filter((x) => x.outer === null).map((x) => x.name), ...kt.topFuns.map((x) => x.name), ...kt.topProps.map((x) => x.name)];
    for (const n of names) {
      const q = pkg ? `${pkg}.${n}` : n;
      if (!byQualified.has(q)) byQualified.set(q, path);
    }
    if (names.length) {
      const list = byPackage.get(pkg) ?? [];
      list.push(path);
      byPackage.set(pkg, list);
    }
  }
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    if (from === to) return;
    const k = `${from}=>${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind: 'import' });
  };
  for (const { path, kt } of parsed) {
    for (const imp of kt.imports) {
      let name = imp.name;
      if (imp.isWildcard) {
        name = name.slice(0, -2);
        // `a.b.*` links every scanned file in package a.b; `a.b.Type.*` links Type's file.
        const pkgFiles = byPackage.get(name);
        if (pkgFiles) {
          for (const target of pkgFiles) add(path, target);
          continue;
        }
      }
      // Drop trailing segments so nested types, companion members and object members resolve to the declaring file.
      const segs = name.split('.');
      for (let n = segs.length; n > 0; n--) {
        const target = byQualified.get(segs.slice(0, n).join('.'));
        if (target) {
          add(path, target);
          break;
        }
      }
    }
  }
  return { nodes, edges };
}

// ---------- calls ----------

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const parsedFiles = files.map((f) => ({ path: f.path, kt: parseKotlin(f.text) }));
  const allTypes = new Map<string, KotlinType>();
  const subtypes = new Map<string, Set<string>>();
  for (const { kt } of parsedFiles) {
    for (const t of kt.types) {
      if (!allTypes.has(t.name)) allTypes.set(t.name, t);
      for (const s of t.supers) {
        const set = subtypes.get(s.name) ?? new Set<string>();
        set.add(t.name);
        subtypes.set(s.name, set);
      }
    }
  }
  // A property typed as an interface / abstract class with exactly ONE scanned subtype is resolved to that subtype.
  const resolveType = (name: string, depth = 0): string => {
    const t = allTypes.get(name);
    if (!t || depth > 5) return name;
    if (t.kind === 'interface' || t.isAbstract) {
      const subs = subtypes.get(name);
      if (subs && subs.size === 1) return resolveType([...subs][0], depth + 1);
    }
    return name;
  };
  /** `x?.foo()` and `x!!.foo()` are `x.foo()` for the name-based resolver; `for (r in xs)` becomes the `for r in xs` it understands. */
  const normalise = (body: string) =>
    body
      .replace(/\?\./g, '.')
      .replace(/!!\./g, '.')
      .replace(/\bfor\s*\(\s*(?:val\s+)?([A-Za-z_]\w*)\s*(?::[^)]*?)?\s+in\s+([A-Za-z_]\w*)\s*\)/g, 'for $1 in $2 {');

  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const fieldTypes = new Map<string, Map<string, string>>();
  const declaredTypes = new Set<string>(allTypes.keys());
  const push = (path: string, owner: string | null, m: KotlinFun) => {
    fns.push({
      nodeId: `${path}::${owner ? owner + '.' : ''}${m.name}`,
      label: owner ? `${owner}.${m.name}` : m.name,
      shortName: m.name,
      className: owner,
      body: normalise(m.body),
      kind: owner ? 'method' : 'function',
      params: m.paramDecls,
      returns: m.returnType,
    });
  };
  for (const { path, kt } of parsedFiles) {
    for (const t of kt.types) {
      const ft = fieldTypes.get(t.name) ?? new Map<string, string>();
      for (const p of t.props) {
        // Plain (optionally nullable / qualified) type names only: `List<Foo>` is not a receiver type.
        const plain = p.type.replace(/\?$/, '').trim();
        if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(plain)) ft.set(p.name, resolveType(plain.split('.').pop()!));
      }
      fieldTypes.set(t.name, ft);
      supers.set(t.name, [...(supers.get(t.name) ?? []), ...t.supers.map((s) => s.name)]);
      for (const m of t.funs) {
        if (!m.hasBody && !m.isAbstract) continue;
        push(path, t.name, m);
      }
    }
    for (const m of kt.topFuns) {
      if (!m.hasBody) continue;
      // `fun Foo.bar()` is a method of Foo as far as callers are concerned
      push(path, m.receiver, m);
    }
  }
  return buildCallGraph(fns, { selfCall: '\\bthis\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: true, fieldTypes, supers, declaredTypes });
}

// ---------- analyzers ----------

export const kotlinImportGraphAnalyzer: CodeAnalyzer = {
  id: 'kotlin-import-graph',
  displayName: 'Import Graph (Kotlin)',
  supportedExtensions: ['.kt', '.kts'],
  analyze: analyzeKotlinImports,
};

export const kotlinCallGraphAnalyzer: CodeAnalyzer = {
  id: 'kotlin-call-graph',
  displayName: 'Call Graph (Kotlin)',
  supportedExtensions: ['.kt', '.kts'],
  analyze: analyzeCalls,
};

export { analyzeCalls as analyzeKotlinCalls };
