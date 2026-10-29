import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub } from '../common/scrubber';
import { matchClose, splitArgs } from '../common/routeUtils';
import { buildCallGraph, DeclaredFn, importedFilesFromGraph } from '../common/callGraphByName';

/**
 * PHP analyzers over scrubbed text (comments, strings, heredocs and inline HTML blanked; `#[Attributes]` kept) with
 * brace matching — no PHP parser, no Composer autoload map, no type resolution.
 *
 * Handled: `namespace` (statement and braced form), `use` imports (plain, aliased, grouped `use A\{B, C as D}`;
 * `use function/const` ignored), class / abstract / final / readonly class, interface, trait and enum declarations
 * with `extends` / `implements` / trait `use`, backed enums and cases, properties (typed, untyped, `static`,
 * multi-declarator), constructor property promotion, methods (visibility, `static`, `abstract`, return types,
 * by-reference and variadic parameters), free functions, attributes with nested brackets (argument text is read
 * from the ORIGINAL source because the scrubber blanks strings).
 *
 * Import graph: an edge for every `use` that resolves to a scanned file (by declared namespace + class name), for
 * `extends` / `implements` / trait `use` written with a fully qualified name, an alias, a `use` import or no import
 * at all (same namespace), and for `require` / `include` of a literal path, `__DIR__ . '/x.php'` or
 * `dirname(__FILE__) . '/x.php'`. Composer PSR-4 mappings are not read, so a class is found only when its file
 * declares the matching namespace; references through `new Foo`, `Foo::bar()` or type hints are not edges.
 *
 * Call graph (name-based, approximate): `$this->m()`, `self::m()` / `static::m()`, `Foo::m()`, `$x->m()` when `$x`
 * is a typed parameter, a local initialised with `new Foo`, or a property (typed, promoted by the constructor, or
 * assigned `new Foo` in the class), calls through return types (`function open(): Repo`), subclass / interface
 * implementers as dotted edges, and plain function calls. NOT resolved: methods supplied by traits (a trait's
 * methods are nodes of the trait, not of the classes using it), `__call` / `__callStatic`, closures and callables
 * (`array_map([$this, 'x'])`), dynamic names (`$obj->$m()`), union types, facades and the service container.
 *
 * Routes: Laravel route files — `Route::get/post/put/patch/delete/options/any/match/redirect/view`, handlers as
 * `[Controller::class, 'm']`, `'Controller@m'`, `Controller::class` (invokable), closures, `->prefix()`,
 * `->controller()`, `->middleware()` / `->name()` / `->where()` chains, `->group(function () {...})` and
 * `Route::group([...], function () {...})` with an array `'prefix'`, nested groups, `Route::resource` /
 * `apiResource` / `resources` (expanded to the standard routes, honouring literal `only` / `except`), and the
 * Laravel convention that `routes/api.php` is served under `/api`. Attribute routes: Symfony `#[Route('/x', methods:
 * ['GET'])]` on classes (prefix) and methods, and verb attributes such as `#[Get('/x')]`. Doctrine-style `@Route("/x",
 * methods={"GET"})` docblocks are read too. NOT handled: other annotations, YAML/XML route files, route files pulled in with
 * `group(base_path('routes/x.php'))`, routes built in loops or from variables (shown as "(dynamic)"), Lumen/Slim
 * `$router->get()` style, `Route::fallback`, `Route::domain`, and prefixes set outside the route file
 * (bootstrap/app.php, RouteServiceProvider).
 */

// ---------- model ----------

export interface PhpAttribute {
  /** Simple name without namespace, e.g. `Route`. */
  name: string;
  /** Argument text between the parentheses, from the ORIGINAL source. */
  args: string;
  /** Same text from the scrubbed source (same length, strings blanked). */
  argsScrubbed: string;
}

export type PhpVisibility = 'public' | 'protected' | 'private';

export interface PhpParam {
  name: string;
  type: string;
  /** Visibility when the parameter is a promoted constructor property. */
  promoted: PhpVisibility | null;
}

export interface PhpProp {
  name: string;
  type: string;
  visibility: PhpVisibility;
  isStatic: boolean;
}

export interface PhpMethod {
  name: string;
  visibility: PhpVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  params: PhpParam[];
  returnType: string;
  /** Scrubbed body text, '' when there is none. */
  body: string;
  hasBody: boolean;
  attributes: PhpAttribute[];
}

export interface PhpType {
  name: string;
  kind: 'class' | 'interface' | 'trait' | 'enum';
  isAbstract: boolean;
  isFinal: boolean;
  namespace: string;
  /** Simple names. A class has at most one parent; an interface may extend several. */
  extends: string[];
  implements: string[];
  /** Names as written (maybe qualified), for the import graph. */
  extendsRaw: string[];
  implementsRaw: string[];
  traits: string[];
  traitsRaw: string[];
  attributes: PhpAttribute[];
  props: PhpProp[];
  methods: PhpMethod[];
  cases: string[];
  /** [start, end] of the body braces in the scrubbed text. */
  range: [number, number];
}

export interface PhpUse {
  /** Fully qualified name without a leading backslash. */
  fqcn: string;
  alias: string;
}

export interface PhpFunction {
  name: string;
  params: PhpParam[];
  returnType: string;
  body: string;
  namespace: string;
}

export interface PhpFile {
  /** Namespace in effect at the top of the file ('' if none). */
  namespace: string;
  uses: PhpUse[];
  types: PhpType[];
  functions: PhpFunction[];
  /** Literal require/include targets as written (before resolution), e.g. `./a.php` or `__DIR__:/a.php`. */
  requires: string[];
  /** Scrubbed and original text, same offsets. */
  scrubbed: string;
  source: string;
}

// ---------- parsing helpers ----------

const lastSegment = (name: string): string => name.replace(/^\\+/, '').split('\\').pop() ?? name;

/** Types as shown in a class diagram: namespaces dropped, `?`/unions kept in a Mermaid-safe form. */
function typeLabel(raw: string): string {
  const t = raw.replace(/\\?(?:[A-Za-z_]\w*\\)+(?=[A-Za-z_])/g, '').replace(/\?/g, '').replace(/\s*\|\s*/g, ' or ').replace(/\s*&\s*/g, ' and ');
  return sanitizeType(t).replace(/\s*,\s*/g, ', ');
}

function skipWs(s: string, p: number, end: number): number {
  while (p < end && /\s/.test(s[p])) p++;
  return p;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function matchSquare(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Attributes of one `#[ ... ]` group: `#[A, B(1, 'x')]`. `at` is the index of `#`. */
function readAttributeGroup(s: string, o: string, at: number): { attrs: PhpAttribute[]; end: number } | null {
  const close = matchSquare(s, at + 1);
  if (close < 0) return null;
  const attrs: PhpAttribute[] = [];
  for (const [a, b] of splitArgs(s, s, at + 2, close)) {
    const seg = s.slice(a, b);
    const m = /^\s*\\?([A-Za-z_][\w\\]*)\s*(\(|$)/.exec(seg);
    if (!m) continue;
    const name = lastSegment(m[1]);
    let args = '';
    let argsScrubbed = '';
    if (m[2] === '(') {
      const open = a + seg.indexOf('(', m[0].length - 1);
      const end = matchClose(s, open);
      if (end > open) {
        args = o.slice(open + 1, end);
        argsScrubbed = s.slice(open + 1, end);
      }
    }
    attrs.push({ name, args, argsScrubbed });
  }
  return { attrs, end: close + 1 };
}


/**
 * Doctrine-style `@Route(...)` annotations in the docblock that directly precedes `pos` (Symfony < 5.2, SensioFrameworkExtra),
 * turned into the same shape as `#[Route(...)]`: `{..}` becomes `[..]` and named `key="v"` becomes `key: "v"`. Read from the
 * ORIGINAL text because scrubbing blanks comments. Only `@Route` is recognised; other annotations are ignored.
 */
function docRoutesBefore(source: string, pos: number): PhpAttribute[] {
  let q = pos - 1;
  // Skip whitespace and any `#[...]` groups between the docblock and the declaration.
  for (;;) {
    while (q >= 0 && /\s/.test(source[q])) q--;
    if (q >= 0 && source[q] === ']') {
      let depth = 0;
      let i = q;
      for (; i >= 0; i--) {
        if (source[i] === ']') depth++;
        else if (source[i] === '[' && --depth === 0) break;
      }
      if (i > 0 && source[i - 1] === '#') {
        q = i - 2;
        continue;
      }
    }
    break;
  }
  if (q < 1 || source[q] !== '/' || source[q - 1] !== '*') return [];
  const start = source.lastIndexOf('/**', q - 1);
  if (start < 0) return [];
  const body = source.slice(start + 3, q - 1).replace(/^[ \t]*\*(?!\/)/gm, ' ');
  const out: PhpAttribute[] = [];
  const re = /@(?:[\w\\]*\\)?Route\s*\(/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let depth = 1;
    let quote = '';
    let args = '';
    let scrubbed = '';
    let i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      const c = body[i];
      let o = c;
      if (quote) {
        if (c === '\\') {
          args += c + (body[i + 1] ?? '');
          scrubbed += '  ';
          i++;
          continue;
        }
        if (c === quote) quote = '';
        args += c;
        scrubbed += c === quote || c === '"' || c === "'" ? c : ' ';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '(') depth++;
      else if (c === ')') {
        if (--depth === 0) break;
      } else if (c === '{') o = '[';
      else if (c === '}') o = ']';
      else if (c === '=' && body[i + 1] !== '>' && body[i + 1] !== '=' && body[i - 1] !== '=' && body[i - 1] !== '!') o = ':';
      args += o;
      scrubbed += o;
    }
    if (depth === 0) out.push({ name: 'Route', args, argsScrubbed: scrubbed });
  }
  return out;
}

/** Attribute groups that directly precede position `pos` (skipping whitespace). */
function attributesBefore(s: string, o: string, pos: number): PhpAttribute[] {
  const out: PhpAttribute[] = [];
  let p = pos;
  for (;;) {
    let q = p - 1;
    while (q >= 0 && /\s/.test(s[q])) q--;
    if (q < 0 || s[q] !== ']') break;
    // Walk back to the `#[` that matches this `]`.
    let depth = 0;
    let open = -1;
    for (let i = q; i >= 0; i--) {
      if (s[i] === ']') depth++;
      else if (s[i] === '[' && --depth === 0) {
        open = i;
        break;
      }
    }
    if (open < 1 || s[open - 1] !== '#') break;
    const g = readAttributeGroup(s, o, open - 1);
    if (!g) break;
    out.unshift(...g.attrs);
    p = open - 1;
  }
  return out;
}

function parseParams(s: string, o: string, from: number, to: number): PhpParam[] {
  const out: PhpParam[] = [];
  for (const [a, b] of splitArgs(s, s, from, to)) {
    let seg = s.slice(a, b);
    // Drop attributes on parameters.
    for (let g = seg.indexOf('#['); g >= 0; g = seg.indexOf('#[')) {
      const end = matchSquare(seg, g + 1);
      if (end < 0) break;
      seg = seg.slice(0, g) + ' '.repeat(end + 1 - g) + seg.slice(end + 1);
    }
    const m = /^\s*((?:(?:public|protected|private|readonly)\s+)*)([^$=]*?)\s*(?:\.\.\.)?\s*&?\s*\$([A-Za-z_]\w*)/.exec(seg);
    if (!m) continue;
    const mods = m[1].trim().split(/\s+/).filter(Boolean);
    const vis = (mods.find((x) => x === 'public' || x === 'protected' || x === 'private') as PhpVisibility | undefined) ?? (mods.includes('readonly') ? 'public' : null);
    out.push({ name: m[3], type: m[2].replace(/\s+/g, ' ').trim(), promoted: vis });
  }
  void o;
  return out;
}

/** End (exclusive) of the member statement starting at `p`: after `;` or after a balanced `{...}` at depth 0. */
function statementEnd(s: string, p: number, end: number): number {
  let depth = 0;
  for (let i = p; i < end; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === '{') {
      const close = matchBrace(s, i);
      return Math.min(close + 1, end);
    } else if (c === ';' && depth === 0) return i + 1;
  }
  return end;
}

function parseMembers(s: string, o: string, from: number, to: number, t: PhpType): void {
  let p = from;
  while (p < to) {
    p = skipWs(s, p, to);
    if (p >= to) break;
    const attributes: PhpAttribute[] = docRoutesBefore(o, p);
    while (s.startsWith('#[', p)) {
      const g = readAttributeGroup(s, o, p);
      if (!g) break;
      attributes.push(...g.attrs);
      p = skipWs(s, g.end, to);
    }
    const modRe = /^(?:(public|protected|private|static|abstract|final|readonly|var)\b\s*)+/;
    const mm = modRe.exec(s.slice(p, p + 80));
    const mods = mm ? mm[0].trim().split(/\s+/) : [];
    if (mm) p = skipWs(s, p + mm[0].length, to);
    const rest = s.slice(p, Math.min(to, p + 200));
    const visibility: PhpVisibility = mods.includes('private') ? 'private' : mods.includes('protected') ? 'protected' : 'public';

    const fn = /^function\b\s*&?\s*([A-Za-z_]\w*)\s*\(/.exec(rest);
    if (fn) {
      const open = p + fn[0].length - 1;
      const close = matchClose(s, open);
      if (close < 0) break;
      const params = parseParams(s, o, open + 1, close);
      const after = s.slice(close + 1, close + 1 + 300);
      const rt = /^\s*:\s*([^{;]+?)\s*(?=[{;])/.exec(after);
      const bodyStart = s.slice(close + 1).search(/[{;]/);
      let hasBody = false;
      let body = '';
      let next = close + 1;
      if (bodyStart >= 0) {
        const at = close + 1 + bodyStart;
        if (s[at] === '{') {
          const e = matchBrace(s, at);
          hasBody = true;
          body = s.slice(at + 1, e);
          next = Math.min(e + 1, to);
        } else next = at + 1;
      }
      const isAbstract = mods.includes('abstract') || (t.kind === 'interface' && !hasBody);
      t.methods.push({ name: fn[1], visibility: t.kind === 'interface' ? 'public' : visibility, isStatic: mods.includes('static'), isAbstract, params, returnType: rt ? rt[1].trim() : '', body, hasBody, attributes });
      if (fn[1].toLowerCase() === '__construct') {
        for (const prm of params) if (prm.promoted) t.props.push({ name: prm.name, type: prm.type, visibility: prm.promoted, isStatic: false });
      }
      p = next;
      continue;
    }
    if (/^use\b/.test(rest)) {
      const e = statementEnd(s, p, to);
      const names = s.slice(p + 3, e).split('{')[0].replace(/;/g, '');
      const raw = o.slice(p + 3, p + 3 + names.length);
      for (const nm of raw.split(',')) {
        const clean = nm.trim();
        if (/^\\?[A-Za-z_][\w\\]*$/.test(clean)) {
          t.traitsRaw.push(clean.replace(/^\\/, ''));
          t.traits.push(lastSegment(clean));
        }
      }
      p = e;
      continue;
    }
    if (/^const\b/.test(rest)) {
      p = statementEnd(s, p, to);
      continue;
    }
    const cs = /^case\s+([A-Za-z_]\w*)/.exec(rest);
    if (cs && t.kind === 'enum') {
      t.cases.push(cs[1]);
      p = statementEnd(s, p, to);
      continue;
    }
    const pm = /^([^$;{}()=]*?)\s*\$([A-Za-z_]\w*)/.exec(rest);
    if (pm) {
      const e = statementEnd(s, p, to);
      const stmt = s.slice(p, e);
      const type = pm[1].replace(/\s+/g, ' ').trim();
      t.props.push({ name: pm[2], type, visibility, isStatic: mods.includes('static') });
      // Further declarators: `public $a, $b = 1;` (top-level commas followed by a variable).
      let depth = 0;
      for (let i = pm[0].length; i < stmt.length; i++) {
        const c = stmt[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) {
          const nx = /^\s*\$([A-Za-z_]\w*)/.exec(stmt.slice(i + 1));
          if (nx) t.props.push({ name: nx[1], type, visibility, isStatic: mods.includes('static') });
        }
      }
      p = e;
      continue;
    }
    p = statementEnd(s, p, to);
  }
}

function resolveRequirePath(text: string): string | null {
  return text.length ? text : null;
}

export function parsePhp(source: string): PhpFile {
  const s = scrub(source, 'php');
  const file: PhpFile = { namespace: '', uses: [], types: [], functions: [], requires: [], scrubbed: s, source };

  // Namespaces: `namespace A\B;` or `namespace A\B { ... }`; remember where each begins so a type gets the right one.
  const nsMarks: Array<{ at: number; ns: string }> = [];
  for (const m of s.matchAll(/(?<![\w$>:\\])namespace\s+([A-Za-z_][\w\\]*)\s*[;{]/g)) nsMarks.push({ at: m.index!, ns: m[1] });
  const nsAt = (pos: number): string => {
    let ns = '';
    for (const m of nsMarks) if (m.at <= pos) ns = m.ns;
    return ns;
  };
  file.namespace = nsMarks[0]?.ns ?? '';

  // `use` imports at file level (outside any type body: checked after types are found).
  const useRe = /(?<![\w$>:\\])use\s+(function\s+|const\s+)?(\\?[A-Za-z_][\w\\]*?)(\\\{[^}]*\})?\s*(?:as\s+([A-Za-z_]\w*))?\s*;/g;
  const useCandidates: Array<{ at: number; fn: boolean; base: string; group: string | null; alias: string | null }> = [];
  for (const m of s.matchAll(useRe)) useCandidates.push({ at: m.index!, fn: !!m[1], base: m[2], group: m[3] ?? null, alias: m[4] ?? null });

  // Types.
  const typeRe = /(?<![\w$>:\\])((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g;
  for (const m of s.matchAll(typeRe)) {
    const at = m.index!;
    if (/\bnew\s+(?:readonly\s+)?$/.test(s.slice(Math.max(0, at - 20), at))) continue;
    if (m[3] === 'extends' || m[3] === 'implements') continue;
    const braceAt = s.indexOf('{', at + m[0].length);
    if (braceAt < 0) continue;
    const header = s.slice(at + m[0].length, braceAt);
    if (/[;()]/.test(header.replace(/:\s*\w+/, ''))) continue; // not a declaration (`enum Foo` in a function call, etc.)
    const close = matchBrace(s, braceAt);
    const mods = m[1].trim().split(/\s+/).filter(Boolean);
    const list = (re: RegExp): string[] => {
      const h = re.exec(header);
      return h ? h[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
    };
    const ext = list(/\bextends\s+([\w\\,\s]+?)(?=\bimplements\b|$)/);
    const impl = list(/\bimplements\s+([\w\\,\s]+)$/);
    const t: PhpType = {
      name: m[3],
      kind: m[2] as PhpType['kind'],
      isAbstract: mods.includes('abstract'),
      isFinal: mods.includes('final'),
      namespace: nsAt(at),
      extends: ext.map(lastSegment),
      implements: impl.map(lastSegment),
      extendsRaw: ext.map((x) => x.replace(/^\\/, '')),
      implementsRaw: impl.map((x) => x.replace(/^\\/, '')),
      traits: [],
      traitsRaw: [],
      attributes: [...docRoutesBefore(source, at), ...attributesBefore(s, source, at)],
      props: [],
      methods: [],
      cases: [],
      range: [braceAt, close],
    };
    parseMembers(s, source, braceAt + 1, close, t);
    file.types.push(t);
  }
  const inType = (pos: number) => file.types.some((t) => pos > t.range[0] && pos < t.range[1]);

  for (const c of useCandidates) {
    if (c.fn || inType(c.at)) continue;
    const base = c.base.replace(/^\\/, '');
    if (c.group) {
      // `use A\{B, C as D}` — read the group from the original text (same offsets).
      const raw = source.slice(c.at, c.at + 400);
      const g = /\\\{([^}]*)\}/.exec(raw);
      if (!g) continue;
      for (const part of g[1].split(',')) {
        const pm = /^\s*([A-Za-z_][\w\\]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (!pm) continue;
        const fq = `${base}\\${pm[1]}`;
        file.uses.push({ fqcn: fq, alias: pm[2] ?? lastSegment(fq) });
      }
    } else file.uses.push({ fqcn: base, alias: c.alias ?? lastSegment(base) });
  }

  // Free functions: named `function` declarations outside every type body.
  for (const m of s.matchAll(/(?<![\w$>:\\])function\s+&?\s*([A-Za-z_]\w*)\s*\(/g)) {
    const at = m.index!;
    if (inType(at)) continue;
    const open = at + m[0].length - 1;
    const close = matchClose(s, open);
    if (close < 0) continue;
    const params = parseParams(s, source, open + 1, close);
    const rt = /^\s*:\s*([^{;]+?)\s*(?=[{;])/.exec(s.slice(close + 1, close + 300));
    const bi = s.indexOf('{', close);
    if (bi < 0) continue;
    const e = matchBrace(s, bi);
    file.functions.push({ name: m[1], params, returnType: rt ? rt[1].trim() : '', body: s.slice(bi + 1, e), namespace: nsAt(at) });
  }

  // require / include with a literal path.
  for (const m of s.matchAll(/(?<![\w$>:\\])(?:require|include)(?:_once)?\b\s*\(?\s*([^;]*?)\)?\s*;/g)) {
    const raw = source.slice(m.index!, m.index! + m[0].length);
    const am = /^(?:require|include)(?:_once)?\b\s*\(?\s*([\s\S]*?)\)?\s*;$/.exec(raw);
    if (!am) continue;
    const expr = am[1].trim();
    const lit = /^(['"])([^'"]*)\1$/.exec(expr);
    const dirLit = /^(?:__DIR__|dirname\s*\(\s*__FILE__\s*\))\s*\.\s*(['"])([^'"]*)\1$/.exec(expr);
    if (dirLit) file.requires.push(resolveRequirePath(`__DIR__:${dirLit[2]}`)!);
    else if (lit) file.requires.push(resolveRequirePath(lit[2])!);
  }
  return file;
}

// ---------- classes ----------

const vis = (v: PhpVisibility): string => (v === 'public' ? '+' : v === 'private' ? '-' : '#');
const mermaidId = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_');

function methodMember(m: PhpMethod): string {
  const ret = m.returnType ? ' ' + typeLabel(m.returnType) : '';
  return `${vis(m.visibility)}${m.name}(${m.params.map((p) => p.name).join(', ')})${ret}${m.isStatic ? '$' : ''}${m.isAbstract ? '*' : ''}`;
}

export function analyzePhpClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();
  const seenRel = new Set<string>();
  for (const f of files) {
    for (const t of parsePhp(f.text).types) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      const stereotype: ExtractedClass['stereotype'] = t.kind === 'interface' ? 'interface' : t.kind === 'enum' ? 'enumeration' : t.isAbstract ? 'abstract' : null;
      const members: string[] = [...t.cases];
      for (const p of t.props) members.push(`${vis(p.visibility)}${p.name}${p.type ? ' ' + typeLabel(p.type) : ''}${p.isStatic ? '$' : ''}`);
      for (const m of t.methods) members.push(methodMember(m));
      classes.push({ id: mermaidId(t.name), stereotype, members });
      const rel = (to: string, type: ExtractedRelationship['type']) => {
        const key = `${t.name}>${to}>${type}`;
        if (seenRel.has(key)) return;
        seenRel.add(key);
        relationships.push({ from: mermaidId(t.name), to: mermaidId(to), type });
      };
      for (const e of t.extends) rel(e, 'inheritance');
      for (const e of t.implements) rel(e, 'realization');
      // A trait is mixed in rather than inherited: drawn as a realization (dashed) edge to the trait.
      for (const e of t.traits) rel(e, 'realization');
    }
  }
  return { classes, relationships };
}

// ---------- imports ----------

export function analyzePhpImports(files: SourceFileInput[]): CodeGraph {
  const parsed = files.map((f) => ({ path: f.path, php: parsePhp(f.text) }));
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const known = new Set(files.map((f) => f.path));
  const byFqcn = new Map<string, string>();
  for (const { path, php } of parsed) {
    for (const t of php.types) {
      const q = t.namespace ? `${t.namespace}\\${t.name}` : t.name;
      if (!byFqcn.has(q.toLowerCase())) byFqcn.set(q.toLowerCase(), path);
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
  const SUFFIXES = ['', '.php', '.inc'];
  const resolvePath = (from: string, spec: string): string | null => {
    const dir = posixPath.dirname(from);
    const isDirRel = spec.startsWith('__DIR__:');
    const rel = isDirRel ? spec.slice(8) : spec;
    const candidates = [posixPath.normalize(posixPath.join(dir, rel))];
    if (!isDirRel) candidates.push(posixPath.normalize(rel.replace(/^\/+/, '')));
    for (const c of candidates) for (const sfx of SUFFIXES) if (known.has(c + sfx)) return c + sfx;
    return null;
  };
  for (const { path, php } of parsed) {
    const byAlias = new Map(php.uses.map((u) => [u.alias.toLowerCase(), u.fqcn]));
    for (const u of php.uses) {
      const target = byFqcn.get(u.fqcn.toLowerCase());
      if (target) add(path, target);
    }
    // Supertypes and traits: resolved through imports, the same namespace, or a fully qualified name.
    for (const t of php.types) {
      for (const raw of [...t.extendsRaw, ...t.implementsRaw, ...t.traitsRaw]) {
        let fq: string;
        if (raw.includes('\\')) {
          const first = raw.split('\\')[0].toLowerCase();
          fq = byAlias.has(first) ? `${byAlias.get(first)}\\${raw.split('\\').slice(1).join('\\')}` : raw;
        } else fq = byAlias.get(raw.toLowerCase()) ?? (t.namespace ? `${t.namespace}\\${raw}` : raw);
        const target = byFqcn.get(fq.toLowerCase());
        if (target) add(path, target);
      }
    }
    for (const spec of php.requires) {
      const target = resolvePath(path, spec);
      if (target) add(path, target);
    }
  }
  return { nodes, edges };
}

// ---------- calls ----------

/** `$x` -> `v_x` so a variable never shadows a function of the same name; `$this` -> `this`. Namespaces are dropped. */
function toResolverText(text: string): string {
  return text
    .replace(/\$this\b/g, 'this')
    .replace(/\$([A-Za-z_])/g, 'v_$1')
    .replace(/\\?(?:[A-Za-z_]\w*\\)+([A-Za-z_]\w*)/g, '$1');
}

function paramsText(params: PhpParam[]): string {
  return params.map((p) => `${p.type.replace(/^\?/, '').replace(/\\?(?:[A-Za-z_]\w*\\)+([A-Za-z_]\w*)/g, '$1')} v_${p.name}`.trim()).join(', ');
}

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const declaredTypes = new Set<string>();
  const fieldTypes = new Map<string, Map<string, string>>();
  const selfName = (ret: string, cls: string | null) => ret.replace(/\b(?:self|static)\b/g, cls ?? '$&').replace(/^\?/, '').replace(/\\?(?:[A-Za-z_]\w*\\)+([A-Za-z_]\w*)/g, '$1');
  for (const f of files) {
    const php = parsePhp(f.text);
    for (const t of php.types) {
      declaredTypes.add(t.name);
      supers.set(t.name, [...(supers.get(t.name) ?? []), ...t.extends, ...t.implements]);
      const ft = fieldTypes.get(t.name) ?? new Map<string, string>();
      for (const p of t.props) {
        const ty = p.type.replace(/^\?/, '').replace(/\\?(?:[A-Za-z_]\w*\\)+([A-Za-z_]\w*)/g, '$1');
        if (/^[A-Za-z_]\w*$/.test(ty)) ft.set(p.name, ty);
      }
      for (const m of t.methods) {
        for (const a of m.body.matchAll(/\$this->([A-Za-z_]\w*)\s*=\s*new\s+\\?(?:[A-Za-z_]\w*\\)*([A-Za-z_]\w*)/g)) if (!ft.has(a[1])) ft.set(a[1], a[2]);
      }
      fieldTypes.set(t.name, ft);
      for (const m of t.methods) {
        if (!m.hasBody) continue;
        fns.push({
          nodeId: `${f.path}::${t.name}.${m.name}`,
          label: `${t.name}.${m.name}`,
          shortName: m.name,
          className: t.name,
          body: toResolverText(m.body),
          kind: 'method',
          params: paramsText(m.params),
          returns: selfName(m.returnType, t.name),
        });
      }
    }
    for (const fn of php.functions) {
      fns.push({ nodeId: `${f.path}::${fn.name}`, label: fn.name, shortName: fn.name, className: null, body: toResolverText(fn.body), kind: 'function', params: paramsText(fn.params), returns: selfName(fn.returnType, null) });
    }
  }
  return buildCallGraph(fns, {
    selfCall: '\\b(?:this\\s*->|(?:self|static)\\s*::)\\s*([A-Za-z_]\\w*)\\s*\\(',
    qualifier: '::',
    bareCallsReachSiblings: false,
    importedFiles: importedFilesFromGraph(analyzePhpImports(files)),
    fieldTypes,
    supers,
    declaredTypes,
  });
}

// ---------- analyzers ----------

export const phpImportGraphAnalyzer: CodeAnalyzer = {
  id: 'php-import-graph',
  displayName: 'Import Graph (PHP)',
  supportedExtensions: ['.php'],
  analyze: analyzePhpImports,
};

export const phpCallGraphAnalyzer: CodeAnalyzer = {
  id: 'php-call-graph',
  displayName: 'Call Graph (PHP)',
  supportedExtensions: ['.php'],
  analyze: analyzeCalls,
};

export { analyzeCalls as analyzePhpCalls };
