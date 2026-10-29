import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { unrollLoops } from '../common/loopUnroll';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { springFunctionalRoutes } from '../common/springFunctional';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';

/**
 * Java analyzers over scrubbed text with brace matching — no compiler front
 * end, no classpath, no annotation processing. Handled: package/imports
 * (static and wildcard), class / interface / enum / record / @interface
 * declarations (nested types are flattened by simple name), generics with
 * bounds, sealed/permits, annotations with nested parens (argument text is
 * read from the ORIGINAL source, since the scrubber blanks strings),
 * fields (multi-declarator, initialisers containing lambdas / anonymous
 * classes), methods and constructors (varargs, `final` params, throws,
 * multi-line signatures), static/instance initialiser blocks, interface
 * default/static/private methods, enums with constant bodies and members
 * after `;`, record components (as fields) and compact constructors.
 * Spring MVC/WebFlux and JAX-RS annotated routes are mapped to a route graph.
 * NOT handled: local and anonymous classes inside method bodies (their
 * code is attributed to the enclosing method), methods declared inside enum
 * constant bodies, type resolution of any kind (overloads are merged,
 * same-named types in different packages are conflated by simple name,
 * inherited fields are not resolved), call receivers that are locals,
 * parameters, method results or static-imported names, reflection, lambdas
 * as call targets, generated code (Lombok, MapStruct), and preprocessing
 * of any sort. Import graph: only explicit imports between scanned files
 * are edges; same-package references without an import are NOT edges (Java
 * allows them, but detecting them needs type resolution); JDK and
 * third-party imports are ignored. Routes: functional endpoints
 * (RouterFunction) are read for literal paths only (see springFunctional.ts); paths built from constants or concatenated with
 * non-literals (shown as "(dynamic)"), meta-annotations / composed
 * annotations, Spring Cloud Gateway, Feign clients and class-level
 * `@RequestMapping(method=...)` constraints are not supported.
 */

// ---------- model ----------

export interface JavaAnnotation {
  /** Simple name without `@` and without package qualification. */
  name: string;
  /** Argument text between the parentheses, from the ORIGINAL source (string literals intact). */
  args: string;
  /** Same text from the scrubbed source: same length as `args`, with strings/comments blanked. */
  argsScrubbed: string;
}

export interface JavaImport {
  /** As written, e.g. `java.util.List`, `com.acme.*`, `com.acme.Util.helper`. */
  name: string;
  isStatic: boolean;
  isWildcard: boolean;
}

export type JavaVisibility = 'public' | 'protected' | 'private' | 'package';

export interface JavaField {
  name: string;
  type: string;
  visibility: JavaVisibility;
  isStatic: boolean;
  isFinal: boolean;
  annotations: JavaAnnotation[];
}

export interface JavaMethod {
  name: string;
  /** Parameter names only (varargs and arrays reduced to the name). */
  params: string[];
  /** Parameters as `Type name, Type name`, for local type inference in the call graph. */
  paramDecls: string;
  returnType: string;
  visibility: JavaVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isDefault: boolean;
  isConstructor: boolean;
  /** Scrubbed body text (comments and strings blanked). */
  body: string;
  /** True when a `{ ... }` body was present (even if empty). */
  hasBody: boolean;
  annotations: JavaAnnotation[];
}

export interface JavaType {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'record' | 'annotation';
  modifiers: string[];
  visibility: JavaVisibility;
  isAbstract: boolean;
  /** Simple names, generics stripped. A class has at most one; an interface may extend several. */
  extends: string[];
  implements: string[];
  permits: string[];
  annotations: JavaAnnotation[];
  fields: JavaField[];
  methods: JavaMethod[];
  enumConstants: string[];
  /** Enclosing type's simple name for nested types, else null. */
  outer: string | null;
}

export interface JavaFile {
  packageName: string | null;
  imports: JavaImport[];
  /** All types, nested ones flattened (outer types come before their nested types). */
  types: JavaType[];
}

const MODS = new Set(['public', 'protected', 'private', 'static', 'abstract', 'final', 'default', 'synchronized', 'native', 'transient', 'volatile', 'strictfp', 'sealed', 'non-sealed']);
const IDENT = /[A-Za-z_$][\w$]*/y;

interface Ctx {
  text: string; // scrubbed
  orig: string;
  file: JavaFile;
}

function skipWs(text: string, i: number, end = text.length): number {
  while (i < end && /\s/.test(text[i])) i++;
  return i;
}

function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** Index just past the `>` closing the `<` at openIdx (angle depth only; `->` is ignored). */
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

/** Removes `@Name` / `@a.b.Name(...)` annotations (scrubbed text), keeping everything else. */
function stripAnnotations(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '@' && !/^@\s*interface\b/.test(s.slice(i, i + 14))) {
      let j = skipWs(s, i + 1);
      while (j < s.length && /[\w$.]/.test(s[j])) j++;
      const k = skipWs(s, j);
      if (s[k] === '(') j = matchParen(s, k) + 1;
      i = Math.min(j, s.length);
      out += ' ';
      continue;
    }
    out += s[i++];
  }
  return out;
}

function simpleName(raw: string): string {
  const t = removeGenerics(raw).replace(/\[\s*\]/g, '').trim();
  return t.split('.').pop()!.trim();
}

function parseParamList(raw: string): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const p of splitTopLevel(raw, ',')) {
    const cleaned = stripAnnotations(p).replace(/\bfinal\b/g, ' ').replace(/\s+/g, ' ').trim();
    const m = /^([\s\S]*?)([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)$/.exec(cleaned);
    if (!m || m[2] === 'this') continue;
    out.push({ name: m[2], type: (m[1] + m[3]).trim() });
  }
  return out;
}

function visibilityOf(mods: string[], ownerKind: JavaType['kind'] | null): JavaVisibility {
  if (mods.includes('public')) return 'public';
  if (mods.includes('private')) return 'private';
  if (mods.includes('protected')) return 'protected';
  return ownerKind === 'interface' || ownerKind === 'annotation' ? 'public' : 'package';
}

function readAnnotation(ctx: Ctx, at: number, end: number): { anno: JavaAnnotation; next: number } {
  const { text, orig } = ctx;
  let p = skipWs(text, at + 1, end);
  const nameStart = p;
  while (p < end && /[\w$.]/.test(text[p])) p++;
  const qualified = text.slice(nameStart, p);
  const q = skipWs(text, p, end);
  let args = '';
  let argsScrubbed = '';
  if (text[q] === '(') {
    const close = Math.min(matchParen(text, q), end);
    args = orig.slice(q + 1, close);
    argsScrubbed = text.slice(q + 1, close);
    p = close + 1;
  }
  return { anno: { name: qualified.split('.').pop() || qualified, args, argsScrubbed }, next: Math.max(p, at + 1) };
}

interface Prefix {
  pos: number;
  mods: string[];
  annos: JavaAnnotation[];
}

function readPrefix(ctx: Ctx, start: number, end: number): Prefix {
  const { text } = ctx;
  const mods: string[] = [];
  const annos: JavaAnnotation[] = [];
  let p = start;
  for (;;) {
    p = skipWs(text, p, end);
    if (p >= end) break;
    if (text[p] === '@' && !/^@\s*interface\b/.test(text.slice(p, p + 16))) {
      const r = readAnnotation(ctx, p, end);
      annos.push(r.anno);
      p = r.next;
      continue;
    }
    if (text.startsWith('non-sealed', p) && !/[\w$]/.test(text[p + 10] ?? '')) {
      mods.push('non-sealed');
      p += 10;
      continue;
    }
    IDENT.lastIndex = p;
    const m = IDENT.exec(text);
    if (m && MODS.has(m[0])) {
      mods.push(m[0]);
      p += m[0].length;
      continue;
    }
    break;
  }
  return { pos: p, mods, annos };
}

function newType(name: string, kind: JavaType['kind'], pre: Prefix, outer: string | null): JavaType {
  return {
    name,
    kind,
    modifiers: pre.mods,
    visibility: visibilityOf(pre.mods, null),
    isAbstract: pre.mods.includes('abstract'),
    extends: [],
    implements: [],
    permits: [],
    annotations: pre.annos,
    fields: [],
    methods: [],
    enumConstants: [],
    outer,
  };
}

/** Parses enum constants; returns names and the index at which member declarations start. */
function parseEnumConstants(text: string, start: number, end: number): { names: string[]; next: number } {
  const names: string[] = [];
  let depth = 0;
  let chunkStart = start;
  let next = end;
  const flush = (to: number) => {
    const chunk = stripAnnotations(text.slice(chunkStart, to));
    const m = /^\s*([A-Za-z_$][\w$]*)/.exec(chunk);
    if (m) names.push(m[1]);
  };
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth <= 0 && c === ',') {
      flush(i);
      chunkStart = i + 1;
    } else if (depth <= 0 && c === ';') {
      flush(i);
      chunkStart = -1;
      next = i + 1;
      break;
    }
  }
  if (chunkStart >= 0) flush(end);
  return { names, next };
}

function scanScope(ctx: Ctx, start: number, end: number, owner: JavaType | null): void {
  const { text, file } = ctx;
  let i = start;
  while (i < end) {
    const before = i;
    i = skipWs(text, i, end);
    if (i >= end) break;
    if (text[i] === ';') {
      i++;
      continue;
    }

    if (!owner) {
      const pk = /^package\s+([\w$.\s]+?)\s*;/.exec(text.slice(i, i + 400));
      if (pk) {
        file.packageName = pk[1].replace(/\s+/g, '');
        i += pk[0].length;
        continue;
      }
      const im = /^import\s+(static\s+)?([\w$.\s*]+?)\s*;/.exec(text.slice(i, i + 600));
      if (im) {
        const name = im[2].replace(/\s+/g, '');
        file.imports.push({ name, isStatic: !!im[1], isWildcard: name.endsWith('.*') });
        i += im[0].length;
        continue;
      }
    }

    const pre = readPrefix(ctx, i, end);
    const p = pre.pos;
    if (p >= end) break;

    // Initialiser block: `{ ... }` or `static { ... }`.
    if (text[p] === '{') {
      i = matchBrace(text, p) + 1;
      continue;
    }

    // Type declaration?
    const rest = text.slice(p, p + 200);
    const kw = /^(?:(class|interface|enum)\b|@\s*(interface)\b|(record)\s+[A-Za-z_$][\w$]*\s*[(<])/.exec(rest);
    if (kw) {
      const kind: JavaType['kind'] = kw[2] ? 'annotation' : ((kw[1] ?? 'record') as JavaType['kind']);
      const kwLen = kw[2] ? /^@\s*interface/.exec(rest)![0].length : kw[1] ? kw[1].length : 'record'.length;
      const hdrStart = p + kwLen;
      let k = hdrStart;
      let paren = 0;
      for (; k < end; k++) {
        const c = text[k];
        if (c === '(') paren++;
        else if (c === ')') paren--;
        else if (paren <= 0 && (c === '{' || c === ';')) break;
      }
      if (k >= end || text[k] !== '{') {
        i = Math.max(k + 1, before + 1);
        continue;
      }
      const hdr = text.slice(hdrStart, k);
      const nm = /^\s*([A-Za-z_$][\w$]*)/.exec(hdr);
      if (!nm) {
        i = matchBrace(text, k) + 1;
        continue;
      }
      let restHdr = hdr.slice(nm[0].length);
      const lead = skipWs(restHdr, 0);
      if (restHdr[lead] === '<') restHdr = restHdr.slice(skipAngles(restHdr, lead));
      const type = newType(nm[1], kind, pre, owner ? owner.name : null);
      type.visibility = visibilityOf(pre.mods, owner ? owner.kind : null);
      if (kind === 'record') {
        const o = restHdr.indexOf('(');
        if (o >= 0) {
          const c = matchParen(restHdr, o);
          for (const prm of parseParamList(restHdr.slice(o + 1, c))) {
            type.fields.push({ name: prm.name, type: prm.type.replace(/\.\.\.$/, '[]'), visibility: 'private', isStatic: false, isFinal: true, annotations: [] });
          }
          restHdr = restHdr.slice(c + 1);
        }
      }
      const parts = removeGenerics(restHdr).split(/\b(extends|implements|permits)\b/);
      for (let x = 1; x < parts.length; x += 2) {
        const names = parts[x + 1]
          .split(',')
          .map((s) => simpleName(stripAnnotations(s)))
          .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        if (parts[x] === 'extends') type.extends.push(...names);
        else if (parts[x] === 'implements') type.implements.push(...names);
        else type.permits.push(...names);
      }
      file.types.push(type);
      const bodyEnd = matchBrace(text, k);
      let memberStart = k + 1;
      if (kind === 'enum') {
        const ec = parseEnumConstants(text, k + 1, bodyEnd);
        type.enumConstants = ec.names;
        memberStart = ec.next;
      }
      scanScope(ctx, memberStart, bodyEnd, type);
      i = bodyEnd + 1;
      continue;
    }

    // Member statement: up to `;` or a balanced `{}` body; initialisers skip their braces.
    let j = p;
    let paren = 0;
    let braceAt = -1;
    let eqAt = -1;
    for (; j < end; j++) {
      const c = text[j];
      if (c === '(' || c === '[') paren++;
      else if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
      else if (paren === 0) {
        if (c === ';') break;
        if (c === '=' && eqAt < 0) eqAt = j;
        else if (c === '{') {
          const isAnnoDefault = owner?.kind === 'annotation' && /\)\s*default\s*[^;{]*$/.test(text.slice(p, j));
          if (eqAt >= 0 || isAnnoDefault) {
            j = matchBrace(text, j);
            continue;
          }
          braceAt = j;
          break;
        }
      }
    }
    const raw = text.slice(p, Math.min(j, end));
    let stmtEnd = j + 1;
    let bodyEnd = -1;
    if (braceAt >= 0) {
      bodyEnd = matchBrace(text, braceAt);
      stmtEnd = bodyEnd + 1;
    }
    i = Math.max(stmtEnd, before + 1);
    if (!owner) continue; // stray top-level statements, module-info blocks, etc.

    const firstParen = raw.indexOf('(');
    const relEq = eqAt >= 0 ? eqAt - p : -1;
    const isMethod = firstParen >= 0 && (relEq < 0 || firstParen < relEq);

    if (isMethod) {
      const head = raw.slice(0, firstParen);
      const nm = /([A-Za-z_$][\w$]*)\s*$/.exec(head);
      if (!nm) continue;
      let typePart = head.slice(0, head.length - nm[0].length).trim();
      if (typePart.startsWith('<')) typePart = typePart.slice(skipAngles(typePart, 0)).trim();
      const isCtor = typePart === '' && nm[1] === owner.name;
      if (typePart === '' && !isCtor) continue;
      const close = matchParen(raw, firstParen);
      const hasBody = braceAt >= 0;
      const isIface = owner.kind === 'interface' || owner.kind === 'annotation';
      owner.methods.push({
        name: nm[1],
        params: parseParamList(raw.slice(firstParen + 1, close)).map((x) => x.name),
        paramDecls: parseParamList(raw.slice(firstParen + 1, close)).map((x) => `${x.type} ${x.name}`).join(', '),
        returnType: isCtor ? '' : typePart.replace(/\s+/g, ' '),
        visibility: visibilityOf(pre.mods, owner.kind),
        isStatic: pre.mods.includes('static'),
        isAbstract: pre.mods.includes('abstract') || (isIface && !hasBody && !pre.mods.includes('static')),
        isDefault: pre.mods.includes('default'),
        isConstructor: isCtor,
        body: hasBody ? text.slice(braceAt + 1, bodyEnd) : '',
        hasBody,
        annotations: pre.annos,
      });
      continue;
    }

    if (braceAt >= 0) continue; // compact record constructor, unknown block

    // Field(s): `Type a [= init], b[]`
    const declarators = splitTopLevel(raw, ',');
    const first = (declarators[0] ?? '').split(/=/)[0].replace(/\s+/g, ' ').trim();
    const fm = /^([\s\S]*?)([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)$/.exec(first);
    if (!fm || !fm[1].trim()) continue;
    const baseType = fm[1].trim();
    const isIface = owner.kind === 'interface' || owner.kind === 'annotation';
    const mk = (name: string, dims: string): JavaField => ({
      name,
      type: (baseType + dims.replace(/\s+/g, '')).trim(),
      visibility: visibilityOf(pre.mods, owner.kind),
      isStatic: pre.mods.includes('static') || isIface,
      isFinal: pre.mods.includes('final') || isIface,
      annotations: pre.annos,
    });
    owner.fields.push(mk(fm[2], fm[3]));
    for (const d of declarators.slice(1)) {
      const dm = /^([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)/.exec(d);
      if (dm) owner.fields.push(mk(dm[1], dm[2]));
    }
  }
}

export function parseJava(source: string): JavaFile {
  const file: JavaFile = { packageName: null, imports: [], types: [] };
  try {
    const text = scrub(source, 'java');
    scanScope({ text, orig: source, file }, 0, text.length, null);
  } catch {
    // Malformed input: return whatever was recovered.
  }
  return file;
}

// ---------- classes ----------

function typeLabel(raw: string): string {
  const t = raw
    .replace(/\b(?:[a-z_]\w*\.)+(?=[A-Z])/g, '')
    .replace(/\.\.\./g, '[]')
    .replace(/@\w+\s*/g, '')
    .replace(/\s*&\s*/g, ' ')
    .replace(/\?/g, 'Object');
  return sanitizeType(t).replace(/\s*,\s*/g, ', ');
}

function vis(v: JavaVisibility): string {
  return v === 'public' ? '+' : v === 'private' ? '-' : v === 'protected' ? '#' : '~';
}

function mermaidId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function methodMember(m: JavaMethod): string {
  const ret = m.returnType ? ' ' + typeLabel(m.returnType) : '';
  return `${vis(m.visibility)}${m.name}(${m.params.join(', ')})${ret}${m.isStatic ? '$' : ''}${m.isAbstract ? '*' : ''}`;
}

export function analyzeJavaClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();
  const seenRel = new Set<string>();
  for (const f of files) {
    for (const t of parseJava(f.text).types) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      const stereotype: ExtractedClass['stereotype'] = t.kind === 'interface' || t.kind === 'annotation' ? 'interface' : t.kind === 'enum' ? 'enumeration' : t.isAbstract ? 'abstract' : null;
      const members: string[] = [...t.enumConstants];
      for (const fld of t.fields) members.push(`${vis(fld.visibility)}${fld.name} ${typeLabel(fld.type)}${fld.isStatic ? '$' : ''}`);
      for (const m of t.methods) members.push(methodMember(m));
      classes.push({ id: mermaidId(t.name), stereotype, members });
      const rel = (to: string, type: ExtractedRelationship['type']) => {
        const key = `${t.name}>${to}>${type}`;
        if (seenRel.has(key)) return;
        seenRel.add(key);
        relationships.push({ from: mermaidId(t.name), to: mermaidId(to), type });
      };
      // External supertypes (JDK, third-party) are kept as declared; Mermaid renders them as empty classes, like the Python/C++ analyzers.
      for (const e of t.extends) rel(e, 'inheritance');
      for (const e of t.implements) rel(e, 'realization');
    }
  }
  return { classes, relationships };
}

// ---------- imports ----------

export function analyzeJavaImports(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, java: parseJava(f.text) }));
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const byQualified = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const { path, java } of parsed) {
    const pkg = java.packageName ?? '';
    for (const t of java.types.filter((x) => x.outer === null)) {
      const q = pkg ? `${pkg}.${t.name}` : t.name;
      if (!byQualified.has(q)) byQualified.set(q, path);
    }
    if (java.types.length) {
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
  for (const { path, java } of parsed) {
    for (const imp of java.imports) {
      let name = imp.name;
      if (imp.isWildcard) {
        name = name.slice(0, -2);
        // `a.b.*` links every scanned file in package a.b; `a.b.Type.*` / `import static a.b.Type.*` links Type's file.
        const pkgFiles = !imp.isStatic ? byPackage.get(name) : undefined;
        if (pkgFiles) {
          for (const target of pkgFiles) add(path, target);
          continue;
        }
      }
      // Drop trailing segments so nested types and static members resolve to their top-level type's file.
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
  const parsedFiles = files.map((f) => ({ path: f.path, java: parseJava(f.text) }));
  const allTypes = new Map<string, JavaType>();
  const subtypes = new Map<string, Set<string>>();
  for (const { java } of parsedFiles) {
    for (const t of java.types) {
      if (!allTypes.has(t.name)) allTypes.set(t.name, t);
      for (const s of [...t.extends, ...t.implements]) {
        const set = subtypes.get(s) ?? new Set<string>();
        set.add(t.name);
        subtypes.set(s, set);
      }
    }
  }
  // A field typed as an interface / abstract class with exactly ONE scanned subtype is resolved to that subtype (the usual Spring
  // controller -> service interface -> single impl layout). With several implementations the interface's own method nodes are used.
  const resolveType = (name: string, depth = 0): string => {
    const t = allTypes.get(name);
    if (!t || depth > 5) return name;
    if (t.kind === 'interface' || t.isAbstract) {
      const subs = subtypes.get(name);
      if (subs && subs.size === 1) return resolveType([...subs][0], depth + 1);
    }
    return name;
  };

  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const fieldTypes = new Map<string, Map<string, string>>();
  for (const { path, java } of parsedFiles) {
    for (const t of java.types) {
      const ft = fieldTypes.get(t.name) ?? new Map<string, string>();
      for (const fld of t.fields) {
        // Plain (optionally qualified) type names only: `List<Foo> foos` and `Foo[] arr` are not resolved.
        if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(fld.type)) ft.set(fld.name, resolveType(fld.type.split('.').pop()!));
      }
      fieldTypes.set(t.name, ft);
      supers.set(t.name, [...(supers.get(t.name) ?? []), ...t.extends, ...t.implements]);
      for (const m of t.methods) {
        if (!m.hasBody && !m.isAbstract) continue;
        fns.push({
          nodeId: `${path}::${t.name}.${m.name}`,
          label: `${t.name}.${m.name}`,
          shortName: m.name,
          className: t.name,
          body: m.body,
          kind: 'method',
          params: m.paramDecls,
          returns: m.returnType,
        });
      }
    }
  }
  return buildCallGraph(fns, { selfCall: '\\bthis\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: true, fieldTypes, supers, declaredTypes: new Set(allTypes.keys()) });
}

// ---------- routes ----------

const SPRING_VERBS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const HTTP_WORDS = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b/g;

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

/** Path strings of a mapping annotation (`value`/`path`, positional or named, single or `{...}` array). `''` when none given. */
function pathsOf(a: JavaAnnotation | undefined): string[] {
  if (!a) return [''];
  const segs = splitSegs(a.args, a.argsScrubbed, true);
  const seg = segs.find((s) => s.name === 'value' || s.name === 'path') ?? segs.find((s) => s.name === null);
  if (!seg) return [''];
  let o = seg.orig;
  let s = seg.scrubbed;
  const lead = s.length - s.trimStart().length;
  const trail = s.trimEnd().length;
  if (s[lead] === '{' && s[trail - 1] === '}') {
    o = o.slice(lead + 1, trail - 1);
    s = s.slice(lead + 1, trail - 1);
  }
  const paths: string[] = [];
  for (const el of splitSegs(o, s, false)) {
    if (/[^\s+]/.test(el.scrubbed)) {
      paths.push('(dynamic)');
      continue;
    }
    const strs = [...el.orig.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (strs.length) paths.push(strs.join(''));
  }
  return paths.length ? paths : [''];
}

function methodsOf(a: JavaAnnotation): string[] {
  const seg = splitSegs(a.args, a.argsScrubbed, true).find((s) => s.name === 'method');
  const found = seg ? [...new Set([...seg.scrubbed.matchAll(HTTP_WORDS)].map((m) => m[1]))] : [];
  return found.length ? found : ['ANY'];
}

function joinPath(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).filter(Boolean);
  return '/' + segs.join('/');
}

export function analyzeJavaRoutes(files: SourceFileInput[]): CodeGraph {
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
    for (const t of parseJava(f.text).types) {
      const has = (n: string) => t.annotations.find((a) => a.name === n);
      const spring = has('RestController') || has('Controller');
      const jaxrs = has('Path');
      if (!spring && !jaxrs) continue;
      const classMapping = has('RequestMapping');
      const prefixes = spring ? pathsOf(classMapping) : pathsOf(jaxrs);
      const shown = prefixes.filter((p) => p !== '').map((p) => joinPath(p));
      const routerId = uniq(`${f.path}::${t.name}`);
      nodes.push({ id: routerId, label: shown.length ? `${t.name}<br/>${shown.join(', ')}` : t.name, kind: 'router' });

      const addRoute = (verb: string, sub: string, m: JavaMethod) => {
        for (const prefix of prefixes) {
          const full = joinPath(prefix, sub);
          const id = uniq(`${f.path}::${t.name}.${m.name}::${verb} ${full}`);
          nodes.push({ id, label: `${verb} ${full}<br/>${t.name}.${m.name}`, kind: 'route' });
          edges.push({ from: routerId, to: id, kind: 'route' });
        }
      };

      for (const m of t.methods) {
        if (m.isConstructor) continue;
        if (spring) {
          for (const a of m.annotations) {
            const verb = SPRING_VERBS[a.name];
            if (verb) for (const p of pathsOf(a)) addRoute(verb, p, m);
            else if (a.name === 'RequestMapping') for (const v of methodsOf(a)) for (const p of pathsOf(a)) addRoute(v, p, m);
          }
        }
        if (jaxrs) {
          const verbs = m.annotations.map((a) => a.name).filter((n) => JAXRS_VERBS.has(n));
          const pathAnno = m.annotations.find((a) => a.name === 'Path');
          for (const v of verbs) for (const p of pathsOf(pathAnno)) addRoute(v, p, m);
        }
      }
    }
  }
  const fn = springFunctionalRoutes(files, 'java');
  return { nodes: [...nodes, ...fn.nodes], edges: [...edges, ...fn.edges] };
}

// ---------- analyzers ----------

export const javaImportGraphAnalyzer: CodeAnalyzer = {
  id: 'java-import-graph',
  displayName: 'Import Graph (Java)',
  supportedExtensions: ['.java'],
  analyze: analyzeJavaImports,
};

export const javaCallGraphAnalyzer: CodeAnalyzer = {
  id: 'java-call-graph',
  displayName: 'Call Graph (Java)',
  supportedExtensions: ['.java'],
  analyze: analyzeCalls,
};

export const javaRouteAnalyzer: CodeAnalyzer = {
  id: 'java-routes',
  displayName: 'Routes (Spring / JAX-RS)',
  supportedExtensions: ['.java'],
  analyze: (files) => analyzeJavaRoutes(unrollLoops(files, 'java')),
};

export { analyzeCalls as analyzeJavaCalls };
