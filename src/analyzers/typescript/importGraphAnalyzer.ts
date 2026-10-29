import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';

const EXTENSION_TO_SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

const RESOLVABLE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = posixPath.extname(filePath);
  return EXTENSION_TO_SCRIPT_KIND[ext] ?? ts.ScriptKind.TS;
}

/**
 * Extracts every static import/re-export specifier and every top-level
 * `require(...)` call argument from a source file's AST. Deliberately
 * syntax-only (built from `ts.createSourceFile`, not a full `ts.Program`) —
 * a real type-checked Program needs a resolved `tsconfig.json`, which would
 * make this analyzer fail (or behave inconsistently) on any file outside a
 * fully-configured project. Module specifiers are strings regardless of
 * type information, so a syntax walk is all this needs.
 */
function extractModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) specifiers.push(spec.text);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // Dynamic import(...) call.
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

/** Resolves a relative import specifier against the known file set; returns null for external packages or anything unresolvable within it. */
export function resolveRelativeImport(fromFilePath: string, specifier: string, knownPaths: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null; // external package (npm, node built-in, path alias) — not part of the internal graph
  const fromDir = posixPath.dirname(fromFilePath);
  const joined = posixPath.normalize(posixPath.join(fromDir, specifier));
  for (const suffix of RESOLVABLE_SUFFIXES) {
    const candidate = joined + suffix;
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

function analyzeImportGraph(files: SourceFileInput[]): CodeGraph {
  const knownPaths = new Set(files.map((f) => f.path));
  const nodes: CodeGraph['nodes'] = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seenEdges = new Set<string>();

  for (const file of files) {
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKindFor(file.path));
    } catch {
      continue; // a genuinely unparseable file shouldn't take down the whole graph
    }
    const specifiers = extractModuleSpecifiers(sourceFile);
    for (const specifier of specifiers) {
      const resolved = resolveRelativeImport(file.path, specifier, knownPaths);
      if (!resolved || resolved === file.path) continue; // skip unresolved externals and (rare) self-imports
      const key = `${file.path}=>${resolved}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from: file.path, to: resolved, kind: 'import' });
    }
  }

  return { nodes, edges };
}

export const typeScriptImportGraphAnalyzer: CodeAnalyzer = {
  id: 'ts-import-graph',
  displayName: 'Import Graph (TypeScript/JavaScript)',
  supportedExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  analyze: analyzeImportGraph,
};
