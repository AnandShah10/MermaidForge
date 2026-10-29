import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { resolveRelativeImport } from './importGraphAnalyzer';

const EXTENSION_TO_SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = posixPath.extname(filePath);
  return EXTENSION_TO_SCRIPT_KIND[ext] ?? ts.ScriptKind.TS;
}

interface DeclaredFunction {
  /** Globally unique node id: "<filePath>::<name>" for top-level functions, "<filePath>::<Class>.<method>" for methods. */
  nodeId: string;
  /** The bare name calls resolve by — for a method this is just the method name, matched only within the same class. */
  shortName: string;
  className: string | null;
  body: ts.Node;
  /** The function-like node (parameters + body) the declaration came from. */
  fnNode: ts.Node;
}

const WRAPPERS = new Set(['Promise', 'Awaited', 'Readonly', 'NonNullable', 'Required', 'Partial']);
const SEQUENCES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Iterable', 'IterableIterator', 'Generator']);
const MAPS = new Set(['Map', 'ReadonlyMap', 'WeakMap']);

/**
 * A type as one string: a class/interface name (`Repo`), `Repo[]` for something iterated for `Repo`s (arrays, sets,
 * iterables) and `Repo{}` for a map whose values are `Repo`s. Unions drop `null`/`undefined`, so `Repo | null` is
 * `Repo`; a union of several classes, tuples, functions and nested collections give null.
 */
function tstr(t: ts.TypeNode | undefined): string | null {
  if (!t) return null;
  if (ts.isParenthesizedTypeNode(t)) return tstr(t.type);
  if (ts.isTypeOperatorNode(t)) return tstr(t.type); // readonly X[]
  if (ts.isArrayTypeNode(t)) {
    const e = tstr(t.elementType);
    return e && !/[[{]/.test(e) ? `${e}[]` : null;
  }
  if (ts.isUnionTypeNode(t)) {
    const kept = t.types.filter((x) => !(x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.UndefinedKeyword || x.kind === ts.SyntaxKind.VoidKeyword || x.kind === ts.SyntaxKind.NeverKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword)));
    return kept.length === 1 ? tstr(kept[0]) : null;
  }
  if (!ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName)) return null;
  const n = t.typeName.text;
  const args = t.typeArguments ?? [];
  if (WRAPPERS.has(n) && args.length === 1) return tstr(args[0]);
  if (SEQUENCES.has(n) && args.length === 1) {
    const e = tstr(args[0]);
    return e && !/[[{]/.test(e) ? `${e}[]` : null;
  }
  if ((MAPS.has(n) && args.length === 2) || (n === 'Record' && args.length === 2)) {
    const e = tstr(args[1]);
    return e && !/[[{]/.test(e) ? `${e}{}` : null;
  }
  return withArgs(n, args.map((a) => tstr(a)));
}
/** `Box` + [`Repo`] -> `Box<Repo>` when every argument is a plain name; otherwise just `Box` (the arguments are not tracked). */
function withArgs(name: string, args: Array<string | null>): string {
  if (args.length === 0 || args.some((a) => !a || /[[{<]/.test(a))) return name;
  return `${name}<${args.join(',')}>`;
}
/** `Box<Repo>` -> `Box`. */
const baseName = (t: string): string => t.replace(/<.*$/, '');
/** `Box<A,B>` -> [A, B]. */
const argsOf = (t: string): string[] => {
  const m = /<(.*)>$/.exec(t);
  return m ? m[1].split(',') : [];
};
/** Replaces the type parameters `params` by `args` inside a type string (`T[]` -> `Repo[]`). */
function subst(t: string, params: string[], args: string[]): string {
  if (params.length === 0 || args.length === 0) return t;
  const map = new Map(params.map((p, i) => [p, args[i]] as const));
  return t.replace(/[A-Za-z_$][\w$]*/g, (w) => (map.has(w) && map.get(w) ? map.get(w)! : w));
}
/** Plain class/interface name only (no collection suffix). */
function refName(t: ts.TypeNode | undefined): string | null {
  const r = tstr(t);
  return r && !/[[{]/.test(r) ? r : null;
}
const elemOf = (t: string | null | undefined): string | null => (t && /\[\]$/.test(t) ? t.slice(0, -2) : t && /\{\}$/.test(t) ? t.slice(0, -2) : null);
const plain = (t: string | null | undefined): string | null => (t && !/[[{]/.test(t) ? t : null);

/** `new Repo()` -> Repo, `new Map<string, Repo>()` -> Repo{}, `new Set<Repo>()` / `new Array<Repo>()` -> Repo[]. */
function typeOfNew(e: ts.NewExpression): string | null {
  if (!ts.isIdentifier(e.expression)) return null;
  const n = e.expression.text;
  const args = e.typeArguments ?? [];
  if (MAPS.has(n) && args.length === 2) {
    const v = refName(args[1]);
    return v ? `${v}{}` : null;
  }
  if ((n === 'Set' || n === 'Array') && args.length === 1) {
    const v = refName(args[0]);
    return v ? `${v}[]` : null;
  }
  return withArgs(n, args.map((a) => tstr(a)));
}

interface ClassInfo {
  file: string;
  name: string;
  /** names in `implements A, B` */
  implements: string[];
  /** `extends Base` (plain identifier only). */
  base: string | null;
  /** field/property name -> declared or initialised class name (`repo: Repo`, `repo = new Repo()`, `constructor(private repo: Repo)`). */
  fields: Map<string, string>;
  /** Names in `class Box<T, U>`. */
  typeParams: string[];
}

interface Binding {
  /** File the binding was imported from; null when the module is outside the scan (a package, an unresolved path). */
  target: string | null;
  /** Exported name, 'default', or '*' for the whole module (namespace import / `require('./x')`). */
  name: string;
}
interface FileInfo {
  path: string;
  sf: ts.SourceFile;
  imports: Map<string, Binding>;
  /** exportName -> local top-level function name */
  exports: Map<string, string>;
  reexports: Array<{ target: string; names: Map<string, string> | '*' }>;
}

/**
 * Extracts a call graph: which top-level functions and class methods call
 * which others, within the given file set. It has no type information, so
 * calls are resolved by name plus the import structure:
 *
 *  - A bare call `foo()` resolves, in order, to (1) a top-level function or
 *    arrow-function constant `foo` in the same file; (2) the function that
 *    `foo` is imported as: `import { foo }`, `import { x as foo }`,
 *    `import foo from` (default export), `const { foo } = require('./x')`, or
 *    `const foo = require('./x')` for a `module.exports = fn` module, followed
 *    through `export { .. } from` / `export * from` re-exports (barrel files);
 *    (3) only if neither applies (e.g. scripts sharing globals), every
 *    top-level function of that name in the scan. Edges from (3) are marked
 *    `ambiguous` when more than one function matches, so they can be drawn
 *    differently.
 *  - `ns.foo()` where `ns` is `import * as ns from './x'` or
 *    `const ns = require('./x')` resolves to `foo` exported by that module.
 *  - `this.foo()` inside a class method matches a method named `foo` only
 *    within the same class.
 *  - Any other call shape — `obj.foo()` on an arbitrary object, computed
 *    member calls (`obj[x]()`), package imports, path aliases from
 *    tsconfig, dynamic `import()` — is not resolved and does not produce an
 *    edge.
 *
 *  - `x.foo()` resolves when `x` is a parameter or local whose class is
 *    written down (`x: Foo`, `const x = new Foo()`, `const x: Foo`), or
 *    `this.x.foo()` / `this.x` of a field typed the same way (`repo: Repo`,
 *    `repo = new Repo()`, `constructor(private repo: Repo)`): the call goes to
 *    `Foo.foo`, looked up through `extends` chains. The class is the one in
 *    the same file, else the one the name is imported from, else the only
 *    scanned class of that name.
 *  - A parameter or local variable that has the same name as a function
 *    shadows it: `foo()` then calls the local value and produces no edge.
 *
 *  - A variable's type also comes from a call result when the callee is a
 *    scanned function or method with a declared return type (`Foo`,
 *    `Promise<Foo>`) or one that only ever returns `new Foo()`; `getRepo().save()`
 *    chains work the same way.
 *  - A receiver typed as an interface (or a class that lacks the method, such as
 *    an abstract one) gets dotted edges to every scanned class that
 *    `implements`/`extends` it and defines the method — possible targets, not
 *    certain ones.
 *
 * It is still not a type-checked analysis: types inferred through generics,
 * unions, destructuring or arrays are not resolved, and a variable reassigned
 * to another class keeps its first type.
 */
function analyzeCallGraph(files: SourceFileInput[]): CodeGraph {
  const declared = new Map<string, DeclaredFunction[]>(); // shortName -> every function/method with that name
  const nodes: CodeGraph['nodes'] = [];
  const known = new Set(files.map((f) => f.path));

  const classes = new Map<string, ClassInfo[]>(); // class name -> every scanned class with that name

  const shapes = new Map<string, Map<string, string>>(); // interface / object type alias -> field -> type
  const shapeParams = new Map<string, string[]>(); // generic interface -> its type parameter names
  const shapeBases = new Map<string, string[]>(); // interface -> interfaces it extends
  const returnTypes = new Map<string, string>(); // nodeId -> class the function is declared or seen to return

  /** Declared return type, else the class of every `return new X()` when they all agree. */
  function returnTypeOf(fnNode: ts.Node, body: ts.Node): string | null {
    const declaredType = ts.isFunctionLike(fnNode) ? tstr(fnNode.type) : null;
    if (declaredType) return declaredType;
    const seen = new Set<string>();
    let other = false;
    const walk = (n: ts.Node) => {
      if (n !== fnNode && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (ts.isReturnStatement(n)) {
        const e = n.expression && ts.isParenthesizedExpression(n.expression) ? n.expression.expression : n.expression;
        if (e && ts.isNewExpression(e) && ts.isIdentifier(e.expression)) seen.add(e.expression.text);
        else other = true;
      }
      ts.forEachChild(n, walk);
    };
    if (ts.isBlock(body)) walk(body);
    else if (ts.isNewExpression(body) && ts.isIdentifier(body.expression)) seen.add(body.expression.text);
    return !other && seen.size === 1 ? [...seen][0] : null;
  }

  function registerFunction(nodeId: string, shortName: string, className: string | null, body: ts.Node, label: string, kind: string, fnNode: ts.Node): void {
    nodes.push({ id: nodeId, label, kind });
    const rt = returnTypeOf(fnNode, body);
    if (rt) returnTypes.set(nodeId, rt);
    const list = declared.get(shortName) ?? [];
    list.push({ nodeId, shortName, className, body, fnNode });
    declared.set(shortName, list);
  }

  /**
   * Relative specifiers resolve normally. tsconfig-style aliases (`@/lib/x`, `~/lib/x`, `#lib/x`, `src/lib/x`) are
   * matched by path suffix and accepted only when exactly one scanned file fits; packages and anything
   * ambiguous stay unresolved (null).
   */
  const SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  const resolveSpec = (from: string, spec: string): string | null => {
    const rel = resolveRelativeImport(from, spec, known);
    if (rel || spec.startsWith('.')) return rel;
    const rest = spec.replace(/^(?:@\/|~\/|#\/?)/, '');
    if (rest === spec && !/^src\//.test(spec)) return null;
    const hits = new Set<string>();
    for (const suffix of SUFFIXES) {
      for (const f of known) if (f === rest + suffix || f.endsWith('/' + rest + suffix)) hits.add(f);
    }
    return hits.size === 1 ? [...hits][0] : null;
  };

  const infos = new Map<string, FileInfo>();
  const parsedFiles: Array<{ file: SourceFileInput; sourceFile: ts.SourceFile }> = [];
  for (const file of files) {
    try {
      const sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindFor(file.path));
      parsedFiles.push({ file, sourceFile });
      infos.set(file.path, { path: file.path, sf: sourceFile, imports: new Map(), exports: new Map(), reexports: [] });
    } catch {
      continue;
    }
  }

  // Pass 1: register every function/method declaration as a node.
  for (const { file, sourceFile } of parsedFiles) {
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        registerFunction(`${file.path}::${node.name.text}`, node.name.text, null, node.body, node.name.text, 'function', node);
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const body = node.initializer.body;
          if (body) registerFunction(`${file.path}::${node.name.text}`, node.name.text, null, body, node.name.text, 'function', node.initializer);
        }
      } else if ((ts.isInterfaceDeclaration(node) || (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))) && node.name) {
        // `interface Deps { repo: Repo }` / `type Deps = { repo: Repo }`: field types for `deps.repo.save()` and destructuring.
        const members = ts.isInterfaceDeclaration(node) ? node.members : (node.type as ts.TypeLiteralNode).members;
        const fieldsOf = shapes.get(node.name.text) ?? new Map<string, string>();
        for (const m of members) {
          if (ts.isPropertySignature(m) && ts.isIdentifier(m.name)) {
            const t = tstr(m.type);
            if (t) fieldsOf.set(m.name.text, t);
          }
        }
        shapes.set(node.name.text, fieldsOf);
        if (node.typeParameters?.length) shapeParams.set(node.name.text, node.typeParameters.map((tp) => tp.name.text));
        if (ts.isInterfaceDeclaration(node)) for (const h of node.heritageClauses ?? []) for (const t of h.types) if (ts.isIdentifier(t.expression)) shapeBases.set(node.name.text, [...(shapeBases.get(node.name.text) ?? []), t.expression.text]);
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const ci: ClassInfo = { file: file.path, name: className, implements: [], base: null, fields: new Map(), typeParams: (node.typeParameters ?? []).map((tp) => tp.name.text) };
        for (const h of node.heritageClauses ?? []) {
          if (h.token === ts.SyntaxKind.ExtendsKeyword && h.types[0] && ts.isIdentifier(h.types[0].expression)) ci.base = h.types[0].expression.text;
          if (h.token === ts.SyntaxKind.ImplementsKeyword) for (const t of h.types) if (ts.isIdentifier(t.expression)) ci.implements.push(t.expression.text);
        }
        const typeName = (t: ts.TypeNode | undefined, init: ts.Expression | undefined): string | null => {
          const r = tstr(t);
          if (r) return r;
          if (init && ts.isNewExpression(init)) return typeOfNew(init);
          return null;
        };
        for (const member of node.members) {
          if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
            const t = typeName(member.type, member.initializer);
            if (t) ci.fields.set(member.name.text, t);
          } else if (ts.isConstructorDeclaration(member)) {
            for (const prm of member.parameters) {
              if (ts.isIdentifier(prm.name) && ts.canHaveModifiers(prm) && ts.getModifiers(prm)?.length) {
                const t = typeName(prm.type, undefined);
                if (t) ci.fields.set(prm.name.text, t);
              }
            }
          }
        }
        classes.set(className, [...(classes.get(className) ?? []), ci]);
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.body) {
            registerFunction(`${file.path}::${className}.${member.name.text}`, member.name.text, className, member.body, `${className}.${member.name.text}`, 'method', member);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  // Pass 1b: module-level imports, requires, exports and re-exports.
  /** undefined: not a require call; null: a require of a module outside the scan. */
  const requireTarget = (path: string, e: ts.Expression | undefined): string | null | undefined => {
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'require') return undefined;
    const a = e.arguments[0];
    return a && ts.isStringLiteral(a) ? resolveSpec(path, a.text) : undefined;
  };
  const isExported = (n: ts.Node): boolean => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const isDefault = (n: ts.Node): boolean => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  for (const info of infos.values()) {
    for (const st of info.sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        // Bound even when the module is not scanned: an imported name is not a global, so it must not fall back to a same-named function elsewhere.
        const target = resolveSpec(info.path, st.moduleSpecifier.text);
        if (st.importClause.name) info.imports.set(st.importClause.name.text, { target, name: 'default' });
        const nb = st.importClause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) info.imports.set(nb.name.text, { target, name: '*' });
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) info.imports.set(el.name.text, { target, name: (el.propertyName ?? el.name).text });
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const t = requireTarget(info.path, d.initializer);
          if (t !== undefined && ts.isIdentifier(d.name)) info.imports.set(d.name.text, { target: t, name: '*' });
          else if (t !== undefined && ts.isObjectBindingPattern(d.name)) {
            for (const el of d.name.elements) if (ts.isIdentifier(el.name)) info.imports.set(el.name.text, { target: t, name: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text });
          } else if (d.initializer && ts.isPropertyAccessExpression(d.initializer) && ts.isIdentifier(d.name)) {
            const base = requireTarget(info.path, d.initializer.expression);
            if (base !== undefined) info.imports.set(d.name.text, { target: base, name: d.initializer.name.text });
          }
          if (isExported(st) && ts.isIdentifier(d.name)) info.exports.set(d.name.text, d.name.text);
        }
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        if (isExported(st)) info.exports.set(isDefault(st) ? 'default' : st.name.text, st.name.text);
      } else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
        info.exports.set('default', st.expression.text);
      } else if (ts.isExportDeclaration(st)) {
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        const target = spec ? resolveSpec(info.path, spec) : null;
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          if (!spec) for (const el of st.exportClause.elements) info.exports.set(el.name.text, (el.propertyName ?? el.name).text);
          else if (target) info.reexports.push({ target, names: new Map(st.exportClause.elements.map((el) => [el.name.text, (el.propertyName ?? el.name).text])) });
        } else if (!st.exportClause && target) info.reexports.push({ target, names: '*' });
      } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = st.expression.left.getText();
        const right = st.expression.right;
        if (left === 'module.exports' && ts.isIdentifier(right)) info.exports.set('default', right.text);
        else if (left === 'module.exports' && ts.isObjectLiteralExpression(right)) {
          for (const prop of right.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) info.exports.set(prop.name.text, prop.name.text);
            else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ts.isIdentifier(prop.initializer)) info.exports.set(prop.name.text, prop.initializer.text);
          }
        } else if (/^(?:module\.)?exports\.\w+$/.test(left) && ts.isIdentifier(right)) info.exports.set(left.split('.').pop()!, right.text);
      }
    }
  }

  /** The function a module exports under `exportName`, following re-exports a few hops. */
  const findExport = (file: string, exportName: string, depth = 0): DeclaredFunction | null => {
    const info = infos.get(file);
    if (!info || depth > 4) return null;
    const local = info.exports.get(exportName) ?? exportName;
    const direct = (declared.get(local) ?? []).find((d) => d.className === null && d.nodeId === `${file}::${local}`);
    if (direct) return direct;
    for (const re of info.reexports) {
      const original = re.names === '*' ? exportName : re.names.get(exportName);
      if (!original) continue;
      const hit = findExport(re.target, original, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  /** The scanned class `name` refers to from `fromFile`: same file, else the file it is imported from, else the only one. */
  const resolveClass = (fromFile: string, name: string): ClassInfo | null => {
    name = baseName(name);
    const all = classes.get(name) ?? [];
    if (all.length === 0) return null;
    const here = all.find((c) => c.file === fromFile);
    if (here) return here;
    const binding = infos.get(fromFile)?.imports.get(name);
    if (binding?.target) {
      const seen = new Set<string>();
      const walk = (file: string, depth: number): ClassInfo | null => {
        if (depth > 4 || seen.has(file)) return null;
        seen.add(file);
        const hit = all.find((c) => c.file === file);
        if (hit) return hit;
        for (const re of infos.get(file)?.reexports ?? []) {
          const r = walk(re.target, depth + 1);
          if (r) return r;
        }
        return null;
      };
      return walk(binding.target, 0);
    }
    return all.length === 1 ? all[0] : null;
  };
  /** `Class.method` looked up along the `extends` chain. */
  const findMethod = (cls: ClassInfo, method: string, depth = 0): DeclaredFunction | null => {
    const own = (declared.get(method) ?? []).find((d) => d.className === cls.name && d.nodeId.startsWith(`${cls.file}::`));
    if (own) return own;
    if (!cls.base || depth > 5) return null;
    const base = resolveClass(cls.file, cls.base);
    return base && base !== cls ? findMethod(base, method, depth + 1) : null;
  };

  const bindingNames = (n: ts.BindingName, out: string[]): void => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else for (const el of n.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
  };
  /** Parameters and local variables of a function: names that shadow functions, and the class each is known to hold. */
  interface TypeApi {
    /** Type of an expression under the current local types (see `typeOfExpr` in the per-function loop). */
    typeOf: (e: ts.Expression, types: Map<string, string>, shadow: Set<string>) => string | null;
    /** Declared type of `typeName.field` (class fields along `extends`, interface/object-type members). */
    fieldType: (typeName: string, field: string) => string | null;
  }
  const CALLBACK_METHODS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'flatMap']);
  const scopeOf = (fnNode: ts.Node, body: ts.Node, api: TypeApi): { shadow: Set<string>; types: Map<string, string> } => {
    const shadow = new Set<string>();
    const types = new Map<string, string>();
    const setType = (name: string, t: string | null | undefined) => {
      if (t && !types.has(name)) types.set(name, t);
    };
    const note = (name: ts.BindingName, type: ts.TypeNode | undefined, init: ts.Expression | undefined, isFn: boolean) => {
      const names: string[] = [];
      bindingNames(name, names);
      if (!isFn) for (const nm of names) shadow.add(nm);
      const base = tstr(type) ?? (init ? api.typeOf(init, types, shadow) : null);
      if (ts.isIdentifier(name)) setType(name.text, base);
      else if (ts.isObjectBindingPattern(name)) {
        // `const { repo } = this` / `({ repo }: Deps) =>`: the type of each picked field.
        const b = plain(base);
        if (b) {
          for (const el of name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            setType(el.name.text, api.fieldType(b, prop));
          }
        }
      } else if (ts.isArrayBindingPattern(name)) {
        const el = elemOf(base);
        if (el) for (const x of name.elements) if (ts.isBindingElement(x) && ts.isIdentifier(x.name)) setType(x.name.text, el);
      }
    };
    if (ts.isFunctionLike(fnNode)) for (const prm of fnNode.parameters) note(prm.name, prm.type, prm.initializer, false);
    const walk = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        const isFn = !!n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer));
        note(n.name, n.type, n.initializer, isFn);
      } else if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer) && n.initializer.declarations[0]) {
        // `for (const r of repos)` / `for (const [k, r] of repoMap)`
        const target = n.initializer.declarations[0].name;
        const coll = api.typeOf(n.expression, types, shadow);
        const el = elemOf(coll);
        if (el && ts.isIdentifier(target) && /\[\]$/.test(coll!)) setType(target.text, el);
        else if (el && ts.isArrayBindingPattern(target) && /\{\}$/.test(coll!)) {
          const v = target.elements[1];
          if (v && ts.isBindingElement(v) && ts.isIdentifier(v.name)) setType(v.name.text, el);
        }
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && CALLBACK_METHODS.has(n.expression.name.text)) {
        // `repos.forEach((r) => r.save())`: the callback's first parameter is an element.
        const el = elemOf(api.typeOf(n.expression.expression, types, shadow));
        const cb = n.arguments[0];
        if (el && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) setType(cb.parameters[0].name.text, el);
      } else if (ts.isCatchClause(n) && n.variableDeclaration) note(n.variableDeclaration.name, undefined, undefined, false);
      else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n !== fnNode) for (const prm of n.parameters) note(prm.name, prm.type, prm.initializer, false);
      ts.forEachChild(n, walk);
    };
    walk(body);
    return { shadow, types };
  };

  // Pass 2: within each declared function/method body, find calls to other declared functions.
  const edges: CodeGraph['edges'] = [];
  const seenEdges = new Map<string, CodeGraph['edges'][number]>();

  function addEdge(from: string, to: string, ambiguous = false): void {
    if (from === to) return; // skip direct self-recursion — a self-loop adds no readable information to a flowchart
    const key = `${from}=>${to}`;
    const prior = seenEdges.get(key);
    if (prior) {
      if (prior.kind === 'ambiguous' && !ambiguous) prior.kind = 'calls';
      return;
    }
    const edge = { from, to, kind: ambiguous ? 'ambiguous' : 'calls' };
    seenEdges.set(key, edge);
    edges.push(edge);
  }

  for (const list of declared.values()) {
    for (const fn of list) {
      const callerFile = fn.nodeId.slice(0, fn.nodeId.indexOf('::'));
      const info = infos.get(callerFile);
      const ownClass = fn.className ? resolveClass(callerFile, fn.className) : null;
      const fieldTypeOf = (field: string): string | undefined => {
        let cls: ClassInfo | null = ownClass;
        let fieldType: string | undefined;
        for (let depth = 0; cls && depth < 6 && !fieldType; depth++) {
          fieldType = cls.fields.get(field);
          cls = fieldType || !cls.base ? null : resolveClass(cls.file, cls.base);
        }
        return fieldType;
      };
      /** The declared function a call expression most plausibly invokes (for its return type), or null. */
      const targetOf = (call: ts.CallExpression, types: Map<string, string>, shadow: Set<string>): DeclaredFunction | null => {
        const callee = call.expression;
        if (ts.isIdentifier(callee)) {
          if (shadow.has(callee.text)) return null;
          const free = (declared.get(callee.text) ?? []).filter((c) => c.className === null);
          const own = free.filter((c) => c.nodeId === `${callerFile}::${callee.text}`);
          if (own.length) return own[0];
          const binding = info?.imports.get(callee.text);
          if (binding) return binding.target ? findExport(binding.target, binding.name === '*' ? 'default' : binding.name) : null;
          return free.length === 1 ? free[0] : null;
        }
        if (!ts.isPropertyAccessExpression(callee)) return null;
        const m = callee.name.text;
        if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) return ownClass ? findMethod(ownClass, m) : null;
        if (ts.isIdentifier(callee.expression)) {
          const recv = callee.expression.text;
          const typed = types.get(recv);
          if (typed && shadow.has(recv)) {
            const cls = resolveClass(callerFile, typed);
            return cls ? findMethod(cls, m) : null;
          }
          const binding = info?.imports.get(recv);
          return binding && binding.name === '*' && binding.target ? findExport(binding.target, m) : null;
        }
        if (ts.isPropertyAccessExpression(callee.expression) && callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const ft = fieldTypeOf(callee.expression.name.text);
          const cls = ft ? resolveClass(callerFile, ft) : null;
          return cls ? findMethod(cls, m) : null;
        }
        return null;
      };
      const fieldType = (typeName: string, field: string, depth = 0): string | null => {
        const cls = resolveClass(callerFile, typeName);
        let c: ClassInfo | null = cls;
        const targs = argsOf(typeName);
        for (let d = 0; c && d < 6; d++) {
          const t = c.fields.get(field);
          if (t) return d === 0 ? subst(t, c.typeParams, targs) : t;
          c = c.base ? resolveClass(c.file, c.base) : null;
        }
        const sh = shapes.get(baseName(typeName))?.get(field);
        if (sh) return subst(sh, shapeParams.get(baseName(typeName)) ?? [], targs);
        if (depth < 4) for (const base of shapeBases.get(typeName) ?? []) {
          const t = fieldType(base, field, depth + 1);
          if (t) return t;
        }
        return null;
      };
      /** Type of an expression: locals, `this`, field chains, element access, collection methods, `new`, `as` casts and call results. */
      const typeOfExpr = (e0: ts.Expression, types: Map<string, string>, shadow: Set<string>, depth = 0): string | null => {
        if (depth > 8) return null;
        let e = e0;
        while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
        const rec = (x: ts.Expression) => typeOfExpr(x, types, shadow, depth + 1);
        if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) return tstr(e.type) ?? rec(e.expression);
        if (ts.isNewExpression(e)) return typeOfNew(e);
        if (e.kind === ts.SyntaxKind.ThisKeyword) return fn.className;
        if (ts.isIdentifier(e)) return shadow.has(e.text) ? types.get(e.text) ?? null : null;
        if (ts.isPropertyAccessExpression(e)) {
          const base = plain(rec(e.expression));
          return base ? fieldType(base, e.name.text) : null;
        }
        if (ts.isElementAccessExpression(e)) return elemOf(rec(e.expression));
        if (ts.isArrayLiteralExpression(e)) {
          const kinds = new Set(e.elements.map((x) => plain(rec(x))));
          return kinds.size === 1 && [...kinds][0] ? `${[...kinds][0]}[]` : null;
        }
        if (ts.isCallExpression(e)) {
          const callee = e.expression;
          if (ts.isPropertyAccessExpression(callee)) {
            const recv = rec(callee.expression);
            const m = callee.name.text;
            if (recv && /\[\]$/.test(recv)) {
              if (m === 'find' || m === 'at' || m === 'pop' || m === 'shift') return elemOf(recv);
              if (['filter', 'slice', 'concat', 'sort', 'reverse'].includes(m)) return recv;
            }
            if (recv && /\{\}$/.test(recv)) {
              if (m === 'get') return elemOf(recv);
              if (m === 'values') return recv.slice(0, -2) + '[]';
            }
            const cls = plain(recv) ? resolveClass(callerFile, plain(recv)!) : null;
            const hit = cls ? findMethod(cls, m) : null;
            if (hit) {
              const rt = returnTypes.get(hit.nodeId) ?? null;
              return rt && cls && hit.className === cls.name ? subst(rt, cls.typeParams, argsOf(plain(recv)!)) : rt;
            }
          }
          const t = targetOf(e, types, shadow);
          return t ? returnTypes.get(t.nodeId) ?? null : null;
        }
        return null;
      };
      const scope = scopeOf(fn.fnNode, fn.body, { typeOf: (e, t, sh) => typeOfExpr(e, t, sh), fieldType: (t, f) => fieldType(t, f) });
      /**
       * `x.method()` where `x` has class or interface `typeName`. A class gives one exact edge. A name that is not a
       * scanned class, or a class that does not define the method (an interface, an abstract method), gives dotted
       * edges to every scanned class that implements or extends it and defines the method.
       */
      const callOnType = (typeName: string | null, method: string) => {
        if (!typeName || /[[{]/.test(typeName)) return;
        const cls = resolveClass(callerFile, typeName);
        const hit = cls ? findMethod(cls, method) : null;
        if (hit) return addEdge(fn.nodeId, hit.nodeId);
        const impls: DeclaredFunction[] = [];
        for (const list of classes.values()) {
          for (const c of list) {
            if (c.implements.includes(baseName(typeName)) || c.base === baseName(typeName)) {
              const m = findMethod(c, method);
              if (m) impls.push(m);
            }
          }
        }
        for (const m of impls) addEdge(fn.nodeId, m.nodeId, true);
      };
      function visitCalls(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee) && scope.shadow.has(callee.text)) {
            // a parameter or local variable named like a function: the call is to that value
          } else if (ts.isIdentifier(callee)) {
            const free = (declared.get(callee.text) ?? []).filter((c) => c.className === null);
            const own = free.filter((c) => c.nodeId === `${callerFile}::${callee.text}`);
            const binding = info?.imports.get(callee.text);
            if (own.length) {
              for (const c of own) addEdge(fn.nodeId, c.nodeId);
            } else if (binding) {
              const hit = binding.target ? findExport(binding.target, binding.name === '*' ? 'default' : binding.name) : null;
              if (hit) addEdge(fn.nodeId, hit.nodeId);
            } else {
              for (const c of free) addEdge(fn.nodeId, c.nodeId, free.length > 1);
            }
          } else if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && fn.className !== null) {
            // `this.foo()` — only match a method named `foo` on the same class.
            for (const candidate of declared.get(callee.name.text) ?? []) {
              if (candidate.className === fn.className) addEdge(fn.nodeId, candidate.nodeId);
            }
          } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
            const recv = callee.expression.text;
            const typed = scope.types.get(recv);
            if (typed && scope.shadow.has(recv)) {
              // `x.foo()` where `x` is a typed parameter or local.
              callOnType(typed, callee.name.text);
            } else {
              // `ns.foo()` through a namespace import / whole-module require.
              const binding = info?.imports.get(recv);
              if (binding && binding.name === '*' && binding.target) {
                const hit = findExport(binding.target, callee.name.text);
                if (hit) addEdge(fn.nodeId, hit.nodeId);
              }
            }
          } else if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isPropertyAccessExpression(callee.expression) &&
            callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ownClass
          ) {
            // `this.repo.save()` through a typed field (own class, then its `extends` chain).
            callOnType(fieldTypeOf(callee.expression.name.text) ?? null, callee.name.text);
          } else if (ts.isPropertyAccessExpression(callee)) {
            // `getRepo().save()` / `await this.repos.open().save()`: the receiver is a call whose return type is known.
            callOnType(plain(typeOfExpr(callee.expression, scope.types, scope.shadow)), callee.name.text);
          }
        }
        ts.forEachChild(node, visitCalls);
      }
      visitCalls(fn.body);
    }
  }

  return { nodes, edges };
}

export const typeScriptCallGraphAnalyzer: CodeAnalyzer = {
  id: 'ts-call-graph',
  displayName: 'Call Graph (TypeScript/JavaScript)',
  supportedExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  analyze: analyzeCallGraph,
};
