import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';

/**
 * C# analyzers over scrubbed text with brace matching — no Roslyn, no
 * semantic model. Handles: `using` directives (plain, `static`, alias,
 * `global`), block-scoped and file-scoped namespaces (flattened, name kept),
 * class / struct / interface / enum / record / record struct (nested types
 * flattened by simple name, `partial` declarations merged by name, generics
 * with `where` constraints), attributes (also on separate lines; argument
 * text is read from the ORIGINAL source at the scrubbed offsets), fields,
 * properties (auto, expression-bodied, init / private set), methods
 * (expression-bodied included), constructors, primary constructors
 * (class/struct parameters become private fields, record parameters become
 * public properties), events, indexers, enum members, operators (names
 * only, not rendered). Local functions stay inside their parent's body.
 *
 * NOT handled: preprocessor conditionals (`#if` branches are all read),
 * source generators, semantic type resolution (no overload resolution,
 * no `var`/local-variable typing, no extension methods or LINQ calls, no
 * `base.Foo()`), same-named types in different namespaces (conflated by
 * simple name), property accessor bodies (not call-graph nodes),
 * `int a = 1, b = 2;` (only the first declarator of a field list is
 * initialised-aware; names after the first `=` are lost), top-level
 * statements other than the minimal-API patterns in the route analyzer,
 * and anything inside interpolation holes `$"{...}"` (scrubbed).
 *
 * Import graph: file A -> file B when A has `using N;` (or `using static
 * N.Type`, or an alias to N / N.Type) and B declares namespace N. EXACT
 * namespace match only — a `using N;` does not link to files declaring
 * `N.Child`. Fully-qualified type references in code are not followed.
 * `System.*` and namespaces not declared in the scanned files are ignored.
 * A `global using` is attributed to the file that declares it only.
 *
 * Class diagram: no semantic analysis, so a base is an interface when it is
 * a declared interface, or — when not scanned — matches /^I[A-Z]/ (a
 * naming-convention heuristic). The first non-interface base is
 * 'inheritance', every interface base is 'realization' (for interfaces
 * extending interfaces too). Unscanned supertypes still produce a
 * relationship line, like the C++/Python analyzers do. `protected internal`
 * renders as `#`, `private protected` as `-`, `internal` as `~`.
 *
 * Call graph: name-based via buildCallGraph. `this.Foo()` and bare `Foo()`
 * reach same-class methods, `Type.Foo()` reaches declared types, and
 * `_repo.Save()` resolves through the declared type of a field, property or
 * primary-constructor parameter (generics, `?` and `[]` stripped; dotted
 * type names skipped). An interface-typed field resolves to its implementer
 * only when exactly one scanned type implements it. Locals, `var`,
 * parameters, `base.Foo()`, extension methods, LINQ, delegates and DI
 * container lookups are NOT resolved.
 *
 * Routes (ASP.NET Core): attribute-routed controllers and minimal APIs
 * (see csharpRouteAnalyzer). Conventional routing (`MapControllerRoute`, `MapDefaultControllerRoute`,
 * `MapRoute`) is read for controllers without [Route]: every public action gets one route per pattern, with
 * `{controller}`/`{action}` filled in (defaults such as `=Index` do not add a shorter route). NOT supported: Razor Pages, area routing, API versioning
 * attributes, `[AcceptVerbs]`, actions inherited from a base controller,
 * route templates built from constants/interpolation (shown as source
 * text), and `app.MapGroup(..).MapGet(..)` chains without a variable.
 */

// ---------- model ----------

export type CSharpVisibility = 'public' | 'internal' | 'protected' | 'private' | 'protected internal' | 'private protected';
export type CSharpTypeKind = 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct';

export interface CSharpUsing {
  name: string;
  isStatic: boolean;
  isGlobal: boolean;
  alias: string | null;
}

export interface CSharpAttribute {
  name: string;
  /** Argument text between the outermost parentheses, from the original source ('' when none). */
  args: string;
}

export interface CSharpParam {
  name: string;
  type: string;
}

export interface CSharpField {
  name: string;
  type: string;
  visibility: CSharpVisibility;
  isStatic: boolean;
  isReadonly: boolean;
  isConst: boolean;
  /** True for a captured class/struct primary-constructor parameter. */
  fromPrimaryCtor?: boolean;
}

export interface CSharpProperty {
  name: string;
  type: string;
  visibility: CSharpVisibility;
  isStatic: boolean;
  kind: 'auto' | 'accessors' | 'expression' | 'positional';
  attributes: CSharpAttribute[];
}

export interface CSharpMethod {
  name: string;
  returnType: string;
  params: CSharpParam[];
  visibility: CSharpVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  isAsync: boolean;
  isConstructor: boolean;
  generics: string[];
  attributes: CSharpAttribute[];
  /** Scrubbed body text (inside the braces, or the expression of `=> expr;`). */
  body: string;
  /** True for a `{ }` body or an expression body (even if empty). */
  hasBody: boolean;
  owner: string | null;
  file?: string;
}

export interface CSharpEvent {
  name: string;
  type: string;
  visibility: CSharpVisibility;
}

export interface CSharpIndexer {
  type: string;
  params: CSharpParam[];
  visibility: CSharpVisibility;
}

export interface CSharpType {
  name: string;
  kind: CSharpTypeKind;
  namespace: string;
  visibility: CSharpVisibility;
  modifiers: string[];
  isStatic: boolean;
  isAbstract: boolean;
  isSealed: boolean;
  isPartial: boolean;
  generics: string[];
  /** Raw `where T : ...` clauses. */
  constraints: string;
  /** Base list by simple name, generics and namespaces stripped, in source order. */
  bases: string[];
  attributes: CSharpAttribute[];
  fields: CSharpField[];
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  constructors: CSharpMethod[];
  events: CSharpEvent[];
  indexers: CSharpIndexer[];
  operators: string[];
  enumMembers: string[];
  primaryParams: CSharpParam[];
  nestedIn: string | null;
  file?: string;
  files: string[];
}

export interface CSharpFile {
  usings: CSharpUsing[];
  namespaces: string[];
  types: CSharpType[];
}

// ---------- low-level helpers ----------

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'abstract', 'virtual', 'override', 'sealed', 'readonly', 'partial',
  'async', 'extern', 'unsafe', 'new', 'const', 'volatile', 'required', 'file', 'implicit', 'explicit',
]);

const TYPE_RE = /^(class|struct|interface|enum|record(?:\s+(?:struct|class))?)\s+([A-Za-z_]\w*)/;

function matchBracket(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Ranges between `sep` at depth 0 over ()[]{} of already-scrubbed text. */
function splitRanges(s: string, sep: string, orig?: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  // Emptiness is judged on the original text when given: a lone string literal is all blanks once scrubbed.
  if ((orig ?? s).slice(start).trim()) out.push([start, s.length]);
  return out;
}

/** Splits original (unscrubbed) argument text on top-level commas, ignoring commas inside strings. */
function splitArgsOrig(orig: string): string[] {
  const s = scrub(orig, 'csharp');
  return splitRanges(s, ',', orig).map(([a, b]) => orig.slice(a, b).trim());
}

/** The value of a plain "..." or verbatim @"..." string literal; null for anything else. */
export function readStringLiteral(arg: string): string | null {
  const a = arg.trim();
  const v = /^@"((?:[^"]|"")*)"$/.exec(a);
  if (v) return v[1].replace(/""/g, '"');
  const p = /^"((?:[^"\\]|\\.)*)"$/.exec(a);
  if (p) return p[1].replace(/\\(.)/g, '$1');
  return null;
}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function lastSegment(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1];
}

function stripGenerics(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** Walks back from a trailing `>` to its `<`; returns the head and the type parameter names. */
function stripTrailingGenerics(pre: string): { head: string; generics: string[] } {
  const t = pre.trimEnd();
  if (!t.endsWith('>')) return { head: t, generics: [] };
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '>') depth++;
    else if (t[i] === '<') {
      depth--;
      if (depth === 0) return { head: t.slice(0, i).trimEnd(), generics: splitTopLevel(t.slice(i + 1, -1), ',').map((g) => g.replace(/^\s*(?:in|out)\s+/, '').trim()) };
    }
  }
  return { head: t, generics: [] };
}

function parseAttributeList(text: string, src: string, open: number, close: number, into: CSharpAttribute[]): void {
  const inner = text.slice(open + 1, close);
  for (const [a, b] of splitRanges(inner, ',')) {
    const orig = src.slice(open + 1 + a, open + 1 + b).trim();
    const m = /^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(orig);
    if (!m) continue;
    if (m[1] && /^(assembly|module)$/.test(m[1])) continue;
    let name = lastSegment(m[2]);
    if (name.length > 9 && name.endsWith('Attribute')) name = name.slice(0, -9);
    into.push({ name, args: (m[3] ?? '').trim() });
  }
}

function parseParams(raw: string): CSharpParam[] {
  const out: CSharpParam[] = [];
  for (const p0 of splitTopLevel(raw, ',')) {
    let p = p0.replace(/^(?:\[[^\]]*\]\s*)+/, '');
    p = p.split(/=(?![=>])/)[0].trim();
    p = p.replace(/^(?:(?:this|ref|out|in|params|scoped|readonly)\s+)+/, '');
    const m = /^([\s\S]*?)\s*([A-Za-z_]\w*)$/.exec(p);
    if (!m) continue;
    out.push({ name: m[2], type: m[1].trim() });
  }
  return out;
}

function visibilityOf(mods: Set<string>, dflt: CSharpVisibility): CSharpVisibility {
  if (mods.has('public')) return 'public';
  if (mods.has('protected') && mods.has('internal')) return 'protected internal';
  if (mods.has('private') && mods.has('protected')) return 'private protected';
  if (mods.has('protected')) return 'protected';
  if (mods.has('internal')) return 'internal';
  if (mods.has('private')) return 'private';
  return dflt;
}

function takeModifiers(h: string): { mods: Set<string>; rest: string } {
  const mods = new Set<string>();
  let rest = h.trim();
  for (;;) {
    const m = /^([a-z]+)\b\s*/.exec(rest);
    if (m && MODIFIERS.has(m[1]) && !(m[1] === 'new' && /^new\s*[(<]/.test(rest))) {
      mods.add(m[1]);
      rest = rest.slice(m[0].length);
      continue;
    }
    const r = /^ref\s+(?=struct\b|record\b)/.exec(rest);
    if (r) {
      rest = rest.slice(r[0].length);
      continue;
    }
    break;
  }
  return { mods, rest };
}

function newType(name: string, kind: CSharpTypeKind, ns: string, owner: CSharpType | null): CSharpType {
  return {
    name, kind, namespace: ns, visibility: 'internal', modifiers: [], isStatic: false, isAbstract: false, isSealed: false, isPartial: false,
    generics: [], constraints: '', bases: [], attributes: [], fields: [], properties: [], methods: [], constructors: [], events: [], indexers: [],
    operators: [], enumMembers: [], primaryParams: [], nestedIn: owner ? owner.name : null, files: [],
  };
}

// ---------- parser ----------

interface Ctx {
  text: string;
  src: string;
  file: CSharpFile;
}

interface Header {
  end: number;
  term: ';' | '{' | '=>' | '=' | 'eof';
}

function readHeader(t: string, i: number, end: number): Header {
  let depth = 0;
  for (let j = i; j < end; j++) {
    const c = t[j];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === ';') return { end: j, term: ';' };
      if (c === '{') return { end: j, term: '{' };
      if (c === '}') return { end: j, term: 'eof' };
      if (c === '=') {
        if (t[j + 1] === '>') return { end: j, term: '=>' };
        if (t[j + 1] === '=') {
          j++;
          continue;
        }
        if ('=!<>'.includes(t[j - 1] ?? ' ')) continue;
        return { end: j, term: '=' };
      }
    }
  }
  return { end, term: 'eof' };
}

/** Index of the `;` ending an initializer/expression starting at `from` (balanced over ()[]{}), or `end`. */
function findSemi(t: string, from: number, end: number): number {
  let depth = 0;
  for (let j = from; j < end; j++) {
    const c = t[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return j;
      depth--;
    } else if (c === ';' && depth === 0) return j;
  }
  return end;
}

function parseBases(basesText: string): string[] {
  const out: string[] = [];
  for (const b of splitTopLevel(basesText, ',')) {
    const base = stripGenerics(b.replace(/\([\s\S]*$/, '')).replace(/^global::/, '').trim();
    if (/^[A-Za-z_][\w.]*$/.test(base)) out.push(lastSegment(base));
  }
  return out;
}

function parseEnumMembers(body: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(body, ',', false)) {
    const m = /^(?:\[[^\]]*\]\s*)*([A-Za-z_]\w*)/.exec(part.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

function scanScope(ctx: Ctx, start: number, end: number, owner: CSharpType | null, ns: string): void {
  const { text: t, src } = ctx;
  let curNs = ns;
  let i = start;
  while (i < end) {
    i = skipWs(t, i);
    if (i >= end) break;
    if (t[i] === '}' || t[i] === ';') {
      i++;
      continue;
    }
    const stmtStart = i;
    const attrs: CSharpAttribute[] = [];
    while (i < end && t[i] === '[') {
      const close = matchBracket(t, i);
      parseAttributeList(t, src, i, Math.min(close, end), attrs);
      i = skipWs(t, close + 1);
    }
    if (i >= end) break;

    // using directives (top level / namespace scope only)
    if (!owner && /^(?:global\s+)?using\b/.test(t.slice(i, i + 12))) {
      const semi = t.indexOf(';', i);
      if (semi >= 0 && semi < end) {
        const m = /^(global\s+)?using\s+(static\s+)?(?:([A-Za-z_]\w*)\s*=\s*)?([\w.:]+(?:<[^;]*>)?)\s*$/.exec(t.slice(i, semi));
        if (m) {
          ctx.file.usings.push({ name: m[4].replace(/^global::/, ''), isStatic: !!m[2], isGlobal: !!m[1], alias: m[3] ?? null });
          i = semi + 1;
          continue;
        }
      }
    }

    // namespaces
    const nsm = /^namespace\s+([\w.]+)\s*/.exec(t.slice(i, i + 300));
    if (nsm) {
      const full = curNs ? `${curNs}.${nsm[1]}` : nsm[1];
      const at = i + nsm[0].length;
      if (t[at] === ';') {
        curNs = full;
        ctx.file.namespaces.push(full);
        i = at + 1;
        continue;
      }
      if (t[at] === '{') {
        ctx.file.namespaces.push(full);
        const close = Math.min(matchBrace(t, at), end);
        scanScope(ctx, at + 1, close, null, full);
        i = close + 1;
        continue;
      }
    }

    const hdr = readHeader(t, i, end);
    const rawHeader = t.slice(i, hdr.end).replace(/\s+/g, ' ').trim();
    let next = hdr.end;
    let body = '';
    let hasBody = false;
    let bodyEndAfter = hdr.end;
    if (hdr.term === '{') {
      const close = Math.min(matchBrace(t, hdr.end), end);
      body = t.slice(hdr.end + 1, close);
      hasBody = true;
      next = close + 1;
      bodyEndAfter = next;
      const k = skipWs(t, next);
      if (t[k] === '=' && t[k + 1] !== '=' && t[k + 1] !== '>') next = findSemi(t, k + 1, end) + 1; // property initializer
    } else if (hdr.term === '=>') {
      const semi = findSemi(t, hdr.end + 2, end);
      body = t.slice(hdr.end + 2, semi);
      hasBody = true;
      next = semi + 1;
    } else if (hdr.term === '=') {
      next = findSemi(t, hdr.end + 1, end) + 1;
    } else if (hdr.term === ';') {
      next = hdr.end + 1;
    } else {
      next = Math.max(hdr.end, i + 1);
    }
    void bodyEndAfter;

    try {
      handleDeclaration(ctx, owner, curNs, rawHeader, attrs, hdr.term, body, hasBody, hdr.end, next, end);
    } catch {
      // malformed declaration: skip it
    }
    i = Math.max(next, stmtStart + 1, i + 1);
  }
}

function handleDeclaration(
  ctx: Ctx,
  owner: CSharpType | null,
  ns: string,
  rawHeader: string,
  attrs: CSharpAttribute[],
  term: Header['term'],
  body: string,
  hasBody: boolean,
  headerEnd: number,
  _next: number,
  scopeEnd: number,
): void {
  if (!rawHeader) return;
  const { mods, rest: h } = takeModifiers(rawHeader);
  const inInterface = owner?.kind === 'interface';

  const tm = TYPE_RE.exec(h);
  if (tm) {
    const kind = tm[1].replace(/\s+class$/, '').replace(/\s+/g, ' ') as CSharpTypeKind;
    const type = newType(tm[2], kind, ns, owner);
    type.modifiers = [...mods];
    type.isStatic = mods.has('static');
    type.isAbstract = mods.has('abstract');
    type.isSealed = mods.has('sealed');
    type.isPartial = mods.has('partial');
    type.visibility = visibilityOf(mods, owner ? (inInterface ? 'public' : 'private') : 'internal');
    type.attributes = attrs;
    let rest = h.slice(tm[0].length).trim();
    if (rest.startsWith('<')) {
      let depth = 0;
      let k = 0;
      for (; k < rest.length; k++) {
        if (rest[k] === '<') depth++;
        else if (rest[k] === '>' && --depth === 0) break;
      }
      type.generics = splitTopLevel(rest.slice(1, k), ',').map((g) => g.replace(/^\s*(?:in|out)\s+/, '').trim());
      rest = rest.slice(k + 1).trim();
    }
    let primary: CSharpParam[] = [];
    if (rest.startsWith('(')) {
      const close = matchParen(rest, 0);
      primary = parseParams(rest.slice(1, close));
      rest = rest.slice(close + 1).trim();
    }
    const wi = rest.search(/\bwhere\s+[A-Za-z_]\w*\s*:/);
    if (wi >= 0) {
      type.constraints = rest.slice(wi).trim();
      rest = rest.slice(0, wi).trim();
    }
    if (rest.startsWith(':') && kind !== 'enum') type.bases = parseBases(rest.slice(1));
    type.primaryParams = primary;
    ctx.file.types.push(type);

    if (term === '{') {
      const close = Math.min(matchBrace(ctx.text, headerEnd), scopeEnd);
      if (kind === 'enum') type.enumMembers = parseEnumMembers(body);
      else scanScope(ctx, headerEnd + 1, close, type, ns);
    }
    if (primary.length) {
      if (kind === 'record' || kind === 'record struct') {
        for (const p of primary) {
          if (!type.properties.some((x) => x.name === p.name)) type.properties.push({ name: p.name, type: p.type, visibility: 'public', isStatic: false, kind: 'positional', attributes: [] });
        }
      } else if (kind === 'class' || kind === 'struct') {
        for (const p of primary) {
          if (!type.fields.some((x) => x.name === p.name) && !type.properties.some((x) => x.name === p.name)) {
            type.fields.push({ name: p.name, type: p.type, visibility: 'private', isStatic: false, isReadonly: false, isConst: false, fromPrimaryCtor: true });
          }
        }
      }
      type.constructors.push({
        name: type.name, returnType: '', params: primary, visibility: 'public', isStatic: false, isAbstract: false, isVirtual: false, isOverride: false,
        isAsync: false, isConstructor: true, generics: [], attributes: [], body: '', hasBody: false, owner: type.name,
      });
    }
    return;
  }

  if (!owner) return; // free statements / top-level code are not type members
  if (/^delegate\b/.test(h)) return;
  const dflt: CSharpVisibility = inInterface ? 'public' : 'private';
  const vis = visibilityOf(mods, dflt);

  // events
  const em = /^event\s+([\s\S]+?)\s+([A-Za-z_]\w*)$/.exec(h);
  if (em) {
    owner.events.push({ name: em[2], type: em[1].trim(), visibility: vis });
    return;
  }

  // operators (conversion + symbolic): listed by name only
  const om = /\boperator\b\s*([^\s(]+|\w+)/.exec(h);
  if (om) {
    owner.operators.push(om[1]);
    return;
  }

  // indexers
  const im = /^([\s\S]*?)\bthis\s*\[([\s\S]*)\]\s*$/.exec(h);
  if (im) {
    owner.indexers.push({ type: im[1].trim(), params: parseParams(im[2]), visibility: vis });
    return;
  }

  // methods / constructors / destructors
  const pIdx = h.indexOf('(');
  if (pIdx >= 0) {
    const { head, generics } = stripTrailingGenerics(h.slice(0, pIdx));
    const nm = /(~?[A-Za-z_]\w*)$/.exec(head);
    if (nm) {
      const name = nm[1];
      let before = head.slice(0, head.length - name.length).trim();
      let explicitImpl = false;
      if (before.endsWith('.')) {
        before = before.replace(/\S+\.$/, '').trim();
        explicitImpl = true;
      }
      const close = matchParen(h, pIdx);
      const params = parseParams(h.slice(pIdx + 1, close));
      const isCtor = before === '' && name === owner.name;
      const isDtor = before === '' && name.startsWith('~');
      if (before === '' && !isCtor && !isDtor) return;
      const m: CSharpMethod = {
        name,
        returnType: before,
        params,
        visibility: explicitImpl ? 'private' : vis,
        isStatic: mods.has('static'),
        isAbstract: mods.has('abstract'),
        isVirtual: mods.has('virtual'),
        isOverride: mods.has('override'),
        isAsync: mods.has('async'),
        isConstructor: isCtor,
        generics,
        attributes: attrs,
        body,
        hasBody,
        owner: owner.name,
      };
      if (isCtor) owner.constructors.push(m);
      else owner.methods.push(m);
      return;
    }
    if (before0(h, pIdx) === '') {
      // tuple-typed field/property such as `(int, int) pos;` falls through below
    }
  }

  // properties and fields: "Type Name"
  let decl = h;
  let explicitProp = false;
  const first = splitTopLevel(decl, ',')[0] ?? decl;
  const pm = /^([\s\S]*?)\s*([A-Za-z_]\w*)$/.exec(first.trim());
  if (!pm || !pm[1]) return;
  let type = pm[1].trim();
  if (type.endsWith('.')) {
    type = type.replace(/\S+\.$/, '').trim();
    explicitProp = true;
  }
  if (!type) return;
  void decl;
  decl = '';
  if (term === '{' || term === '=>') {
    const accessors = /\b(?:get|set|init)\b/.test(body) && term === '{';
    owner.properties.push({
      name: pm[2],
      type,
      visibility: explicitProp ? 'private' : vis,
      isStatic: mods.has('static'),
      kind: term === '=>' ? 'expression' : /\b(?:get|set|init)\s*[{=]|\b(?:get|set|init)\s*=>/.test(body) ? 'accessors' : accessors ? 'auto' : 'auto',
      attributes: attrs,
    });
    return;
  }
  const names = [pm[2]];
  for (const extra of splitTopLevel(h, ',').slice(1)) {
    const en = /^([A-Za-z_]\w*)/.exec(extra.trim());
    if (en) names.push(en[1]);
  }
  for (const n of names) {
    owner.fields.push({
      name: n,
      type,
      visibility: vis,
      isStatic: mods.has('static') || mods.has('const'),
      isReadonly: mods.has('readonly'),
      isConst: mods.has('const'),
    });
  }
}

function before0(h: string, idx: number): string {
  return h.slice(0, idx).trim();
}

/** Parses one C# source text. Never throws; returns whatever was recognised. */
export function parseCSharp(source: string): CSharpFile {
  const file: CSharpFile = { usings: [], namespaces: [], types: [] };
  try {
    const text = scrub(source, 'csharp');
    scanScope({ text, src: source, file }, 0, text.length, null, '');
  } catch {
    // return the partial result
  }
  return file;
}

/** Merges same-named types (partial classes, and any same-simple-name conflation) into one. */
export function mergeCSharpTypes(types: CSharpType[]): CSharpType[] {
  const byName = new Map<string, CSharpType>();
  const uniq = <T>(arr: T[], key: (x: T) => string): T[] => {
    const seen = new Set<string>();
    return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
  };
  for (const t of types) {
    const cur = byName.get(t.name);
    if (!cur) {
      byName.set(t.name, { ...t, files: t.file ? [t.file] : [...t.files] });
      continue;
    }
    cur.bases = uniq([...cur.bases, ...t.bases], (b) => b);
    cur.attributes = [...cur.attributes, ...t.attributes];
    cur.fields = uniq([...cur.fields, ...t.fields], (f) => f.name);
    cur.properties = uniq([...cur.properties, ...t.properties], (p) => p.name);
    cur.methods = [...cur.methods, ...t.methods];
    cur.constructors = [...cur.constructors, ...t.constructors];
    cur.events = uniq([...cur.events, ...t.events], (e) => e.name);
    cur.indexers = [...cur.indexers, ...t.indexers];
    cur.operators = [...cur.operators, ...t.operators];
    cur.enumMembers = uniq([...cur.enumMembers, ...t.enumMembers], (e) => e);
    cur.primaryParams = cur.primaryParams.length ? cur.primaryParams : t.primaryParams;
    cur.isAbstract = cur.isAbstract || t.isAbstract;
    cur.isStatic = cur.isStatic || t.isStatic;
    cur.generics = cur.generics.length ? cur.generics : t.generics;
    cur.constraints = cur.constraints || t.constraints;
    if (t.file && !cur.files.includes(t.file)) cur.files.push(t.file);
  }
  return [...byName.values()];
}

interface Parsed {
  path: string;
  parsed: CSharpFile;
}

function parseAll(files: SourceFileInput[]): { perFile: Parsed[]; types: CSharpType[] } {
  const perFile: Parsed[] = [];
  const all: CSharpType[] = [];
  for (const f of files) {
    const parsed = parseCSharp(f.text);
    for (const ty of parsed.types) {
      ty.file = f.path;
      for (const m of [...ty.methods, ...ty.constructors]) m.file = f.path;
    }
    perFile.push({ path: f.path, parsed });
    all.push(...parsed.types);
  }
  return { perFile, types: mergeCSharpTypes(all) };
}

// ---------- import graph ----------

export function analyzeCSharpImports(files: SourceFileInput[]): CodeGraph {
  const { perFile } = parseAll(files);
  const nsToFiles = new Map<string, Set<string>>();
  for (const { path, parsed } of perFile) {
    for (const ns of parsed.namespaces) {
      const set = nsToFiles.get(ns) ?? new Set<string>();
      set.add(path);
      nsToFiles.set(ns, set);
    }
  }
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const { path, parsed } of perFile) {
    for (const u of parsed.usings) {
      const candidates = [u.name];
      if (u.isStatic || u.alias) candidates.push(u.name.split('.').slice(0, -1).join('.'));
      const target = candidates.find((c) => c && nsToFiles.has(c));
      if (!target) continue;
      for (const to of nsToFiles.get(target)!) {
        if (to === path) continue;
        const k = `${path}=>${to}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: path, to, label: target, kind: 'using' });
      }
    }
  }
  return { nodes, edges };
}

export const csharpImportGraphAnalyzer: CodeAnalyzer = {
  id: 'csharp-import-graph',
  displayName: 'Using Graph (C#)',
  supportedExtensions: ['.cs'],
  analyze: analyzeCSharpImports,
};

// ---------- class diagram ----------

function symbol(v: CSharpVisibility): string {
  switch (v) {
    case 'public':
      return '+';
    case 'protected':
    case 'protected internal':
      return '#';
    case 'internal':
      return '~';
    default:
      return '-';
  }
}

function memberType(t: string): string {
  return sanitizeType(t.replace(/,\s*/g, ', '));
}

function methodMember(m: CSharpMethod): string {
  const ps = m.params.map((p) => p.name).join(', ');
  const ret = m.isConstructor ? '' : m.returnType ? ' ' + memberType(m.returnType) : '';
  return `${symbol(m.visibility)}${m.name}(${ps})${ret}${m.isStatic ? '$' : ''}${m.isAbstract ? '*' : ''}`;
}

function isInterfaceBase(name: string, byName: Map<string, CSharpType>): boolean {
  const t = byName.get(name);
  if (t) return t.kind === 'interface';
  return /^I[A-Z]/.test(name);
}

export function analyzeCSharpClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  let types: CSharpType[] = [];
  try {
    types = parseAll(files).types;
  } catch {
    return { classes, relationships };
  }
  const byName = new Map(types.map((t) => [t.name, t]));
  const seenRel = new Set<string>();
  for (const t of types) {
    const members: string[] = [];
    if (t.kind === 'enum') members.push(...t.enumMembers);
    else {
      for (const f of t.fields) members.push(`${symbol(f.visibility)}${f.name} ${memberType(f.type)}${f.isStatic ? '$' : ''}`);
      for (const p of t.properties) members.push(`${symbol(p.visibility)}${p.name} ${memberType(p.type)}${p.isStatic ? '$' : ''}`);
      for (const e of t.events) members.push(`${symbol(e.visibility)}${e.name} ${memberType(e.type)}`);
      for (const c of t.constructors) members.push(methodMember(c));
      for (const m of t.methods) members.push(methodMember(m));
    }
    classes.push({
      id: t.name,
      stereotype: t.kind === 'interface' ? 'interface' : t.kind === 'enum' ? 'enumeration' : t.isAbstract ? 'abstract' : null,
      members,
    });
    let inheritedOne = false;
    for (const b of t.bases) {
      if (b === t.name) continue;
      const iface = isInterfaceBase(b, byName);
      const type: ExtractedRelationship['type'] = iface || inheritedOne || t.kind === 'struct' ? 'realization' : 'inheritance';
      if (!iface) inheritedOne = true;
      const k = `${t.name}>${b}>${type}`;
      if (seenRel.has(k)) continue;
      seenRel.add(k);
      relationships.push({ from: t.name, to: b, type });
    }
  }
  return { classes, relationships };
}

// ---------- call graph ----------

function simpleFieldType(raw: string): string | null {
  let t = stripGenerics(raw).replace(/\?/g, '').replace(/\[[\s,]*\]/g, '').replace(/\breadonly\b/, '').trim();
  if (!/^[A-Za-z_]\w*$/.test(t)) return null;
  return t;
}

function cleanBody(body: string): string {
  return body
    .replace(/\?\s*\./g, '.')
    .replace(/!\s*\./g, '.')
    .replace(/\b([A-Za-z_]\w*)\s*<[\w\s,.?[\]<>]*>\s*\(/g, '$1(');
}

function buildFieldTypes(types: CSharpType[]): Map<string, Map<string, string>> {
  const implementers = new Map<string, string[]>();
  for (const t of types) {
    if (t.kind === 'interface' || t.isAbstract) continue;
    for (const b of t.bases) implementers.set(b, [...(implementers.get(b) ?? []), t.name]);
  }
  const byName = new Map(types.map((t) => [t.name, t]));
  const resolve = (type: string): string => {
    if (byName.get(type)?.kind === 'interface') {
      const impls = implementers.get(type) ?? [];
      if (impls.length === 1) return impls[0];
    }
    return type;
  };
  const out = new Map<string, Map<string, string>>();
  for (const t of types) {
    const m = new Map<string, string>();
    const add = (name: string, rawType: string) => {
      const st = simpleFieldType(rawType);
      if (st) m.set(name, resolve(st));
    };
    t.fields.forEach((f) => add(f.name, f.type));
    t.properties.forEach((p) => add(p.name, p.type));
    t.primaryParams.forEach((p) => add(p.name, p.type));
    out.set(t.name, m);
  }
  return out;
}

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  let types: CSharpType[] = [];
  try {
    types = parseAll(files).types;
  } catch {
    return { nodes: [], edges: [] };
  }
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  for (const t of types) {
    supers.set(t.name, [...(supers.get(t.name) ?? []), ...t.bases.map((b) => b.replace(/<.*$/, '').split('.').pop()!.trim()).filter(Boolean)]);
    for (const m of [...t.constructors, ...t.methods]) {
      if (!m.hasBody) continue;
      fns.push({
        nodeId: `${m.file ?? t.files[0] ?? ''}::${t.name}.${m.name}`,
        label: `${t.name}.${m.name}`,
        shortName: m.name,
        className: t.name,
        body: cleanBody(m.body),
        kind: 'method',
        params: m.params.map((p) => `${p.type} ${p.name}`).join(', '),
        returns: m.returnType,
      });
    }
  }
  return buildCallGraph(fns, {
    selfCall: '\\bthis\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(',
    qualifier: '.',
    bareCallsReachSiblings: true,
    fieldTypes: buildFieldTypes(types),
    supers,
    declaredTypes: new Set(types.map((t) => t.name)),
  });
}

export const csharpCallGraphAnalyzer: CodeAnalyzer = {
  id: 'csharp-call-graph',
  displayName: 'Call Graph (C#)',
  supportedExtensions: ['.cs'],
  analyze: analyzeCalls,
};

// ---------- ASP.NET Core routes ----------

const HTTP_ATTRS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
  HttpHead: 'HEAD',
  HttpOptions: 'OPTIONS',
};

function joinPaths(...parts: string[]): string {
  const segs = parts.map((p) => p.replace(/^~?\/+|\/+$/g, '')).filter(Boolean);
  return '/' + segs.join('/');
}

/** Template argument of a Route/Http* attribute: positional string or `Template = "..."`; null when none. Non-literals come back as source text. */
function templateOf(attr: CSharpAttribute): string | null {
  for (const arg of splitArgsOrig(attr.args)) {
    const named = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(arg);
    if (named) {
      if (named[1] === 'Template') return readStringLiteral(named[2]) ?? named[2].slice(0, 40);
      continue;
    }
    return readStringLiteral(arg) ?? arg.slice(0, 40);
  }
  return null;
}

function controllerBase(name: string): string {
  return name.replace(/Controller$/, '').toLowerCase();
}

interface ConventionalRoute {
  pattern: string;
  defaultController: string | null;
  defaultAction: string | null;
}

/** `MapControllerRoute(name:, pattern:, defaults:)`, `MapDefaultControllerRoute()` and `routes.MapRoute(name, template)`. */
function conventionalRoutes(files: SourceFileInput[]): ConventionalRoute[] {
  const out: ConventionalRoute[] = [];
  for (const f of files) {
    const text = scrub(f.text, 'csharp');
    if (/\bMapDefaultControllerRoute\s*\(/.test(text)) out.push({ pattern: '{controller=Home}/{action=Index}/{id?}', defaultController: null, defaultAction: null });
    for (const m of text.matchAll(/\b(?:MapControllerRoute|MapRoute)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchParen(text, open);
      const args = splitArgsOrig(f.text.slice(open + 1, close));
      let pattern: string | null = null;
      let ctrl: string | null = null;
      let action: string | null = null;
      const positional: string[] = [];
      for (const a of args) {
        const named = /^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(a);
        if (named) {
          if (named[1] === 'pattern' || named[1] === 'template') pattern = readStringLiteral(named[2]);
          else if (named[1] === 'defaults') {
            ctrl = /\bcontroller\s*=\s*"([^"]*)"/.exec(named[2])?.[1] ?? null;
            action = /\baction\s*=\s*"([^"]*)"/.exec(named[2])?.[1] ?? null;
          }
        } else positional.push(a);
      }
      if (pattern === null && positional.length >= 2) pattern = readStringLiteral(positional[1]);
      if (pattern === null && positional.length === 1 && !args.some((a) => /^name\s*:/.test(a))) pattern = readStringLiteral(positional[0]);
      if (pattern !== null) out.push({ pattern, defaultController: ctrl, defaultAction: action });
    }
  }
  return out;
}

function analyzeRoutes(files: SourceFileInput[]): CodeGraph {
  const nodes: CodeGraph['nodes'] = [];
  const edges: CodeGraph['edges'] = [];
  try {
    const { types } = parseAll(files);
    const byName = new Map(types.map((t) => [t.name, t]));

    const isController = (t: CSharpType, depth = 0): boolean => {
      if (t.bases.some((b) => b === 'Controller' || b === 'ControllerBase')) return true;
      if (t.attributes.some((a) => a.name === 'ApiController' || a.name === 'Route')) return true;
      if (depth > 8) return false;
      return t.bases.some((b) => {
        const bt = byName.get(b);
        return !!bt && bt !== t && isController(bt, depth + 1);
      });
    };
    const classRoute = (t: CSharpType, depth = 0): CSharpAttribute | null => {
      const own = t.attributes.find((a) => a.name === 'Route');
      if (own) return own;
      if (depth > 8) return null;
      for (const b of t.bases) {
        const bt = byName.get(b);
        if (bt && bt !== t) {
          const r = classRoute(bt, depth + 1);
          if (r) return r;
        }
      }
      return null;
    };

    const conventional = conventionalRoutes(files);
    for (const t of types) {
      if (t.kind !== 'class' || !isController(t)) continue;
      const file = t.files[0] ?? '';
      const routerId = `${file}::${t.name}`;
      const ra = classRoute(t);
      const prefixRaw = ra ? templateOf(ra) ?? '' : '';
      const prefix = prefixRaw.replace(/\[controller\]/gi, controllerBase(t.name));
      let n = 0;
      for (const m of t.methods) {
        if (m.visibility !== 'public' || m.isStatic || m.attributes.some((a) => a.name === 'NonAction')) continue;
        const routeAttr = m.attributes.find((a) => a.name === 'Route');
        const verbs = m.attributes.filter((a) => HTTP_ATTRS[a.name]);
        // Conventional routing: no [Route] on the class or method, and the app maps `{controller}/{action}` patterns.
        if (conventional.length && !ra && !routeAttr && !t.attributes.some((a) => a.name === 'ApiController') && verbs.every((a) => templateOf(a) === null)) {
          const verb = verbs.length ? HTTP_ATTRS[verbs[0].name] : 'ANY';
          const ctrlName = t.name.replace(/Controller$/, '');
          for (const c of conventional) {
            if (!/\{controller[=}?:]/.test(c.pattern) && c.defaultController?.toLowerCase() !== ctrlName.toLowerCase()) continue;
            if (!/\{action[=}?:]/.test(c.pattern) && c.defaultAction?.toLowerCase() !== m.name.toLowerCase()) continue;
            const path = joinPaths(c.pattern.replace(/\{controller(?:=[^}]*)?\}/g, ctrlName).replace(/\{action(?:=[^}]*)?\}/g, m.name));
            const id = `${routerId}::route${n++}`;
            nodes.push({ id, label: `${verb} ${path}<br/>${t.name}.${m.name}`, kind: 'route' });
            edges.push({ from: routerId, to: id, kind: 'route' });
          }
          continue;
        }
        const targets: Array<{ verb: string; tpl: string | null }> = verbs.map((a) => ({ verb: HTTP_ATTRS[a.name], tpl: templateOf(a) ?? (routeAttr ? templateOf(routeAttr) : null) }));
        if (!verbs.length && routeAttr) targets.push({ verb: 'ANY', tpl: templateOf(routeAttr) });
        for (const { verb, tpl } of targets) {
          const tplFixed = (tpl ?? '').replace(/\[action\]/gi, m.name).replace(/\[controller\]/gi, controllerBase(t.name));
          const absolute = /^~?\//.test(tplFixed);
          const path = absolute ? joinPaths(tplFixed) : joinPaths(prefix, tplFixed);
          const id = `${routerId}::route${n++}`;
          nodes.push({ id, label: `${verb} ${path}<br/>${t.name}.${m.name}`, kind: 'route' });
          edges.push({ from: routerId, to: id, kind: 'route' });
        }
      }
      if (n > 0) nodes.unshift({ id: routerId, label: `controller ${t.name}<br/>${file}`, kind: 'router' });
    }
  } catch {
    // keep whatever was found
  }

  for (const f of files) {
    try {
      analyzeMinimal(f, nodes, edges);
    } catch {
      // ignore malformed file
    }
  }
  return { nodes, edges };
}

interface Holder {
  id: string;
  varName: string;
  kind: 'app' | 'router';
  parent: string | null;
  prefix: string;
}

function firstStringArg(orig: string, scrubbed: string, openParen: number): string {
  const close = matchParen(scrubbed, openParen);
  const args = splitArgsOrig(orig.slice(openParen + 1, close));
  if (!args.length) return '';
  return readStringLiteral(args[0]) ?? args[0].slice(0, 40);
}

function analyzeMinimal(f: SourceFileInput, nodes: CodeGraph['nodes'], edges: CodeGraph['edges']): void {
  const t = scrub(f.text, 'csharp');
  const holders = new Map<string, Holder>();
  const appRe = /\b(?:var|WebApplication)\s+([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\s*\.\s*Build\s*\(\s*\)|WebApplication\s*\.\s*Create\s*\(|WebApplication\s*\.\s*CreateBuilder\s*\([^;]*?\)\s*\.\s*Build\s*\(\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = appRe.exec(t))) holders.set(m[1], { id: `${f.path}::${m[1]}`, varName: m[1], kind: 'app', parent: null, prefix: '' });
  if (!holders.size) return;

  const groupRe = /\b(?:var|RouteGroupBuilder|IEndpointRouteBuilder)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.\s*MapGroup\s*\(/g;
  const groupDefs: Array<{ name: string; parent: string; open: number }> = [];
  while ((m = groupRe.exec(t))) groupDefs.push({ name: m[1], parent: m[2], open: m.index + m[0].length - 1 });
  // Resolve in passes so a group declared before its parent's group (or out of order) still links.
  for (let pass = 0; pass < 4; pass++) {
    for (const g of groupDefs) {
      if (holders.has(g.name) || !holders.has(g.parent)) continue;
      holders.set(g.name, { id: `${f.path}::${g.name}`, varName: g.name, kind: 'router', parent: g.parent, prefix: firstStringArg(f.text, t, g.open) });
    }
  }

  const fullPath = (h: Holder, rel: string): string => {
    const segs = [rel];
    let cur: Holder | undefined = h;
    let guard = 0;
    while (cur && cur.parent && guard++ < 20) {
      segs.unshift(cur.prefix);
      cur = holders.get(cur.parent);
    }
    return joinPaths(...segs);
  };

  const routeRe = /\b([A-Za-z_]\w*)\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(/g;
  const used = new Set<string>();
  const routeNodes: CodeGraph['nodes'] = [];
  const routeEdges: CodeGraph['edges'] = [];
  let n = 0;
  while ((m = routeRe.exec(t))) {
    const h = holders.get(m[1]);
    if (!h) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(t, open);
    const ranges = splitRanges(t.slice(open + 1, close), ',');
    if (!ranges.length) continue;
    const argOrig = (k: number) => (ranges[k] ? f.text.slice(open + 1 + ranges[k][0], open + 1 + ranges[k][1]).trim() : '');
    const argScr = (k: number) => (ranges[k] ? t.slice(open + 1 + ranges[k][0], open + 1 + ranges[k][1]).trim() : '');
    const p0 = argOrig(0);
    const path = readStringLiteral(p0) ?? p0.slice(0, 40);
    const hs = argScr(1);
    let handler = '(inline)';
    if (hs && !/^(?:async\b|static\b|delegate\b|\(|[A-Za-z_]\w*\s*=>)/.test(hs)) {
      const hm = /^[A-Za-z_][\w.]*/.exec(hs);
      handler = hm ? hm[0] : '(inline)';
    }
    const id = `${h.id}::route${n++}`;
    routeNodes.push({ id, label: `${m[2].toUpperCase()} ${fullPath(h, path)}<br/>${handler}`, kind: 'route' });
    routeEdges.push({ from: h.id, to: id, kind: 'route' });
    used.add(h.varName);
  }
  for (const h of holders.values()) {
    if (h.kind === 'router') {
      // groups that are used by routes (or have used descendants) are shown with their ancestors
      let cur: Holder | undefined = used.has(h.varName) ? h : undefined;
      void cur;
    }
  }
  // mark ancestors of used holders
  for (const name of [...used]) {
    let cur = holders.get(name);
    let guard = 0;
    while (cur?.parent && guard++ < 20) {
      used.add(cur.parent);
      cur = holders.get(cur.parent);
    }
  }
  // Groups that exist but have no routes are still shown when they have been declared under an app.
  for (const h of holders.values()) if (h.kind === 'router') used.add(h.varName);
  if (!routeNodes.length && ![...holders.values()].some((h) => h.kind === 'router')) return;
  for (const h of holders.values()) {
    if (!used.has(h.varName) && h.kind !== 'app') continue;
    nodes.push({ id: h.id, label: `${h.kind === 'app' ? 'app' : 'group'} ${h.varName}<br/>${f.path}`, kind: h.kind });
    if (h.parent) edges.push({ from: holders.get(h.parent)!.id, to: h.id, label: h.prefix || '/', kind: 'mount' });
  }
  nodes.push(...routeNodes);
  edges.push(...routeEdges);
}

export const csharpRouteAnalyzer: CodeAnalyzer = {
  id: 'aspnet-routes',
  displayName: 'ASP.NET Core Routes',
  supportedExtensions: ['.cs'],
  analyze: (files) => analyzeRoutes(unrollLoops(files, 'csharp')),
};
