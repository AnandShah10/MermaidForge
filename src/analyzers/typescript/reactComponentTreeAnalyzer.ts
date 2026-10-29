import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';

/**
 * React component tree: which components render which other components.
 * Syntax-only (TypeScript compiler API, no type checker), so:
 *
 *  Detected as a component: a function/arrow/function-expression whose name
 *  starts with an uppercase letter and whose body contains JSX or a
 *  `createElement`/`jsx` call (also when wrapped in `memo`/`forwardRef`/
 *  `React.memo`/`React.forwardRef`), and classes extending `Component`/
 *  `PureComponent` (also `React.`-qualified).
 *
 *  Edges: `<Child />` inside a component body links to the component named
 *  Child — resolved through that file's imports (default, named, aliased)
 *  when the import points inside the scanned files, otherwise by a unique
 *  name match, otherwise skipped. Third-party components (anything imported
 *  from a package) and member tags like `<Ctx.Provider>` are not nodes.
 *
 *  NOT detected: components passed as props or stored in variables/maps and
 *  rendered dynamically (`const C = pick(); <C/>`), lazy()/dynamic imports,
 *  HOC-produced components whose body is not visible, render props, and
 *  routing-table indirection.
 */

interface Comp {
  id: string;
  name: string;
  file: string;
  node: ts.Node;
}

const EXT_KIND: Record<string, ts.ScriptKind> = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };
const SUFFIXES = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText();
      if (/(^|\.)(createElement|jsx|jsxs|jsxDEV)$/.test(t)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function unwrapWrappers(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isCallExpression(cur) && /(^|\.)(memo|forwardRef|observer)$/.test(cur.expression.getText()) && cur.arguments.length > 0) {
    cur = cur.arguments[0];
  }
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
  return cur;
}

function resolveImport(from: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const joined = posixPath.normalize(posixPath.join(posixPath.dirname(from), spec));
  for (const s of SUFFIXES) if (known.has(joined + s)) return joined + s;
  return null;
}

function analyze(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const comps: Comp[] = [];
  const byFileName = new Map<string, Comp>(); // `${file}::${name}`
  const defaultExport = new Map<string, string>(); // file -> component name
  const parsed: Array<{ file: SourceFileInput; sf: ts.SourceFile }> = [];

  for (const file of files) {
    try {
      const ext = posixPath.extname(file.path);
      parsed.push({ file, sf: ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, EXT_KIND[ext] ?? ts.ScriptKind.TSX) });
    } catch {
      continue;
    }
  }

  const register = (file: string, name: string, node: ts.Node) => {
    const key = `${file}::${name}`;
    if (byFileName.has(key)) return;
    const c: Comp = { id: key, name, file, node };
    comps.push(c);
    byFileName.set(key, c);
  };

  const imports = new Map<string, Map<string, { spec: string; imported: string }>>(); // file -> local -> import

  for (const { file, sf } of parsed) {
    const imp = new Map<string, { spec: string; imported: string }>();
    imports.set(file.path, imp);
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        const spec = st.moduleSpecifier.text;
        if (st.importClause.name) imp.set(st.importClause.name.text, { spec, imported: 'default' });
        const nb = st.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imp.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
      }
    }

    const isUpper = (n: string) => /^[A-Z]/.test(n);
    const hasDefaultMod = (m: ts.NodeArray<ts.ModifierLike> | undefined) =>
      !!m?.some((x) => x.kind === ts.SyntaxKind.DefaultKeyword);

    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.body && containsJsx(st.body)) {
        const name = st.name?.text ?? (hasDefaultMod(st.modifiers) ? capitalize(posixPath.basename(file.path).replace(/\.\w+$/, '')) : null);
        if (name && isUpper(name)) {
          register(file.path, name, st.body);
          if (hasDefaultMod(st.modifiers)) defaultExport.set(file.path, name);
        }
      } else if (ts.isClassDeclaration(st)) {
        const extendsText = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText() ?? '';
        const name = st.name?.text;
        if (name && /(^|\.)(Pure)?Component$/.test(extendsText)) {
          register(file.path, name, st);
          if (hasDefaultMod(st.modifiers)) defaultExport.set(file.path, name);
        }
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer || !isUpper(d.name.text)) continue;
          const inner = unwrapWrappers(d.initializer);
          if ((ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && containsJsx(inner.body)) register(file.path, d.name.text, inner.body);
          else if (ts.isClassExpression(inner) && containsJsx(inner)) register(file.path, d.name.text, inner);
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const e = unwrapWrappers(st.expression);
        if (ts.isIdentifier(e)) defaultExport.set(file.path, e.text);
        else if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && containsJsx(e.body)) {
          const name = capitalize(posixPath.basename(file.path).replace(/\.\w+$/, ''));
          register(file.path, name, e.body);
          defaultExport.set(file.path, name);
        }
      }
    }
  }

  const byName = new Map<string, Comp[]>();
  for (const c of comps) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  const resolveChild = (fromFile: string, tag: string): Comp | null => {
    const imp = imports.get(fromFile)?.get(tag);
    if (imp) {
      const target = resolveImport(fromFile, imp.spec, known);
      if (target) {
        const name = imp.imported === 'default' ? defaultExport.get(target) : imp.imported;
        const c = name ? byFileName.get(`${target}::${name}`) : undefined;
        if (c) return c;
        return null;
      }
      return null; // external package component
    }
    const same = byFileName.get(`${fromFile}::${tag}`);
    if (same) return same;
    const candidates = byName.get(tag) ?? [];
    return candidates.length === 1 ? candidates[0] : null; // ambiguous or unknown → don't guess
  };

  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const c of comps) {
    const visit = (n: ts.Node) => {
      let tag: ts.JsxTagNameExpression | null = null;
      if (ts.isJsxSelfClosingElement(n)) tag = n.tagName;
      else if (ts.isJsxOpeningElement(n)) tag = n.tagName;
      if (tag && ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
        const child = resolveChild(c.file, tag.text);
        if (child && child.id !== c.id) {
          const k = `${c.id}=>${child.id}`;
          if (!seen.has(k)) {
            seen.add(k);
            edges.push({ from: c.id, to: child.id, kind: 'renders' });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(c.node);
  }

  // Label with the file when two components share a name.
  const dupNames = new Set([...byName.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
  return {
    nodes: comps.map((c) => ({ id: c.id, label: dupNames.has(c.name) ? `${c.name} (${c.file})` : c.name, kind: 'component' })),
    edges,
  };
}

function capitalize(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export const reactComponentTreeAnalyzer: CodeAnalyzer = {
  id: 'react-component-tree',
  displayName: 'React Component Tree',
  supportedExtensions: ['.tsx', '.jsx', '.ts', '.js'],
  analyze: analyze,
};
