import * as ts from 'typescript';
import * as posixPath from 'path/posix';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { SourceFileInput } from '../analyzer';

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

function visibilityPrefix(modifiers: readonly ts.ModifierLike[] | undefined): string {
  if (!modifiers) return '+';
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return '-';
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return '#';
  return '+'; // public is TS's default when unmarked
}

function formatType(node: ts.TypeNode | undefined): string {
  if (!node) return '';
  return ` ${node.getText().replace(/\s+/g, ' ')}`;
}

/** Formats one class/interface member as a Mermaid classDiagram member line, e.g. "+getName() string" or "-count number". */
function formatMember(member: ts.ClassElement | ts.TypeElement): string | null {
  const modifiers = 'modifiers' in member ? (member.modifiers as readonly ts.ModifierLike[] | undefined) : undefined;
  const isStatic = modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
  const prefix = visibilityPrefix(modifiers);

  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    if (!member.name) return null;
    const name = member.name.getText();
    const params = member.parameters.map((p) => p.name.getText()).join(', ');
    const returnType = formatType(member.type);
    return `${prefix}${name}(${params})${returnType}${isStatic ? '$' : ''}`;
  }
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    if (!member.name) return null;
    const name = member.name.getText();
    const type = formatType(member.type);
    return `${prefix}${name}${type}${isStatic ? '$' : ''}`;
  }
  return null;
}

function heritageReferences(node: ts.ClassDeclaration | ts.InterfaceDeclaration): { extends: string[]; implements: string[] } {
  const extendsList: string[] = [];
  const implementsList: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    const names = clause.types.map((t) => t.expression.getText());
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) extendsList.push(...names);
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) implementsList.push(...names);
  }
  return { extends: extendsList, implements: implementsList };
}

/**
 * Extracts class and interface declarations (name, members, and
 * extends/implements relationships) from a set of TypeScript/JavaScript
 * source files, for rendering as a Mermaid classDiagram (see
 * `mermaidGenerator.ts`'s `classesToClassDiagram`).
 *
 * Deliberately syntax-only, like the import-graph analyzer — no type
 * checker, so this works on any file without needing a resolved
 * `tsconfig.json`, at the cost of not resolving what an `extends`/
 * `implements` name actually refers to when it isn't declared in the same
 * file set (those relationships are still emitted — Mermaid will just show
 * a class that has no member details, which is an honest reflection of "we
 * don't have that declaration" rather than a wrong guess). Namespaces,
 * decorators' effects, and mixins are not specially handled.
 */
export function analyzeClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seenIds = new Set<string>();

  function addClass(id: string, stereotype: 'interface' | null, members: string[]): void {
    if (seenIds.has(id)) return; // same name declared in two files (e.g. a re-exported barrel) — keep the first, don't duplicate
    seenIds.add(id);
    classes.push({ id, stereotype, members });
  }

  for (const file of files) {
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindFor(file.path));
    } catch {
      continue;
    }

    function visit(node: ts.Node): void {
      if (ts.isClassDeclaration(node) && node.name) {
        const id = node.name.text;
        const members = node.members.map(formatMember).filter((m): m is string => m !== null);
        addClass(id, null, members);
        const { extends: ext, implements: impl } = heritageReferences(node);
        for (const parent of ext) relationships.push({ from: id, to: parent, type: 'inheritance' });
        for (const iface of impl) relationships.push({ from: id, to: iface, type: 'realization' });
      } else if (ts.isInterfaceDeclaration(node)) {
        const id = node.name.text;
        const members = node.members.map(formatMember).filter((m): m is string => m !== null);
        addClass(id, 'interface', members);
        const { extends: ext } = heritageReferences(node);
        for (const parent of ext) relationships.push({ from: id, to: parent, type: 'inheritance' });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return { classes, relationships };
}
