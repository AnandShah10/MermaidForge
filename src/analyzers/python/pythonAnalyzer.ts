import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { scrub, sanitizeType, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn, importedFilesFromGraph } from '../common/callGraphByName';

/**
 * Python analyzers. There is no bundled Python parser, so this is a
 * line/indentation-based reader run over text whose strings and comments
 * have been blanked (see common/scrubber.ts). It handles ordinary code:
 * classes (bases, annotated and plain class attributes, `self.x` attributes
 * assigned in `__init__`, methods with decorators), nested packages and
 * relative imports. It does NOT evaluate anything: dynamic imports
 * (`importlib`), `__all__` re-exports, metaclass magic, `exec`, conditional
 * definitions, and name resolution through aliases are not followed.
 */

interface PyDef {
  kind: 'class' | 'def';
  name: string;
  indent: number;
  line: number; // 0-based start line
  endLine: number; // exclusive
  /** Header text (joined across continuation lines) after the keyword+name, e.g. "(self, x) -> int:" or "(Base):". */
  header: string;
  decorators: string[];
  parent: PyDef | null;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 8 - (n % 8);
    else break;
  }
  return n;
}

/** Parses class/def structure (module level and class bodies; defs nested in defs are left inside their parent's body). */
export function parsePythonStructure(scrubbed: string): { defs: PyDef[]; lines: string[] } {
  const lines = scrubbed.split('\n');
  const defs: PyDef[] = [];
  const stack: PyDef[] = [];
  let pendingDecorators: string[] = [];

  const closeUntil = (indent: number, lineNo: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop()!.endLine = lineNo;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const ind = indentOf(raw);
    closeUntil(ind, i);

    const dec = /^\s*@([\w.]+)/.exec(raw);
    if (dec) {
      pendingDecorators.push(dec[1]);
      continue;
    }
    const m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(raw);
    if (!m) {
      pendingDecorators = [];
      continue;
    }
    // Join continuation lines until parentheses balance and the header ends with ':'.
    let header = raw.slice(raw.indexOf(m[2]) + m[2].length);
    let depth = 0;
    const count = (s: string) => {
      for (const c of s) {
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
      }
    };
    count(header);
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      header += ' ' + lines[j].trim();
      count(lines[j]);
    }
    const parent = stack.length ? stack[stack.length - 1] : null;
    const node: PyDef = {
      kind: m[1] as 'class' | 'def',
      name: m[2],
      indent: ind,
      line: i,
      endLine: lines.length,
      header: header.trim(),
      decorators: pendingDecorators,
      parent,
    };
    pendingDecorators = [];
    // Defs nested inside defs stay part of their parent's body and are not registered.
    if (!(parent && parent.kind === 'def')) defs.push(node);
    stack.push(node);
    i = j;
  }
  closeUntil(-1, lines.length);
  return { defs, lines };
}

// ---------- imports ----------

interface PyImport {
  level: number; // number of leading dots
  module: string; // dotted module path, may be ''
  names: string[]; // for "from x import a, b"
}

function parseImports(scrubbed: string): PyImport[] {
  const out: PyImport[] = [];
  // Join backslash and parenthesised continuations so a multi-line from-import is one statement.
  const joined = scrubbed.replace(/\\\n/g, ' ').replace(/\(([^()]*)\)/g, (m, inner: string) =>
    /^\s*[\w\s,.*]*$/.test(inner) ? '(' + inner.replace(/\s+/g, ' ') + ')' : m,
  );
  for (const line of joined.split('\n')) {
    let m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (m) {
      const names = m[3]
        .replace(/[()]/g, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s && s !== '*');
      out.push({ level: m[1].length, module: m[2], names });
      continue;
    }
    m = /^\s*import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[\w.]+$/.test(mod)) out.push({ level: 0, module: mod, names: [] });
      }
    }
  }
  return out;
}

function candidatesFor(dirParts: string[], modParts: string[]): string[] {
  const base = [...dirParts, ...modParts].join('/');
  const prefix = base ? base + '/' : '';
  return [base ? `${base}.py` : '', `${prefix}__init__.py`].filter(Boolean);
}

export function resolvePythonImport(fromPath: string, imp: PyImport, known: Set<string>, knownList: string[]): string[] {
  const modParts = imp.module ? imp.module.split('.') : [];
  const found = new Set<string>();
  const tryParts = (dirParts: string[], parts: string[], anywhere: boolean) => {
    for (const c of candidatesFor(dirParts, parts)) {
      if (known.has(c)) found.add(c);
      else if (anywhere) {
        // Absolute import: the package root is unknown, so match by path suffix.
        const hit = knownList.find((k) => k === c || k.endsWith('/' + c));
        if (hit) found.add(hit);
      }
    }
  };
  if (imp.level > 0) {
    let dir = posixPath.dirname(fromPath);
    for (let l = 1; l < imp.level; l++) dir = posixPath.dirname(dir);
    const dirParts = dir === '.' ? [] : dir.split('/');
    tryParts(dirParts, modParts, false);
    for (const n of imp.names) tryParts(dirParts, [...modParts, n], false);
  } else {
    if (modParts.length) tryParts([], modParts, true);
    for (const n of imp.names) if (modParts.length) tryParts([], [...modParts, n], true);
  }
  found.delete(fromPath);
  return [...found];
}

function analyzeImports(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const knownList = [...known];
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const imp of parseImports(scrub(f.text, 'python'))) {
      for (const target of resolvePythonImport(f.path, imp, known, knownList)) {
        const k = `${f.path}=>${target}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: f.path, to: target, kind: 'import' });
      }
    }
  }
  return { nodes, edges };
}

// ---------- classes ----------

function visibilityOf(name: string): string {
  if (name.startsWith('__') && !name.endsWith('__')) return '-';
  if (name.startsWith('_') && !name.startsWith('__')) return '#';
  return '+';
}

function paramNames(header: string): string {
  const open = header.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  let close = -1;
  for (let i = open; i < header.length; i++) {
    if ('([{'.includes(header[i])) depth++;
    else if (')]}'.includes(header[i])) {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return '';
  return splitTopLevel(header.slice(open + 1, close), ',')
    .map((p) => p.replace(/^\*+/, '').split(/[:=]/)[0].trim())
    .filter((p) => p && p !== 'self' && p !== 'cls' && p !== '/' && p !== '*')
    .join(', ');
}

function returnAnnotation(header: string): string {
  const arrow = header.indexOf('->');
  if (arrow < 0) return '';
  // Cut at the first ':' outside brackets (the end of the signature; a one-line body may follow it).
  let depth = 0;
  let end = header.length;
  for (let i = arrow + 2; i < header.length; i++) {
    const c = header[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ':' && depth === 0) {
      end = i;
      break;
    }
  }
  // String-literal (forward-reference) annotations are blanked by the scrubber and so come back empty.
  return sanitizeType(header.slice(arrow + 2, end));
}

export function analyzePythonClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const { defs, lines } = parsePythonStructure(scrub(f.text, 'python'));
    for (const cls of defs.filter((d) => d.kind === 'class')) {
      if (seen.has(cls.name)) continue;
      seen.add(cls.name);

      const baseSrc = /^\((.*)\)\s*:/.exec(cls.header);
      const bases = baseSrc
        ? splitTopLevel(baseSrc[1], ',')
            .filter((b) => !b.includes('=') && b !== 'object')
            .map((b) => b.replace(/\[.*$/, '').split('.').pop()!.trim())
            .filter((b) => /^[A-Za-z_]\w*$/.test(b))
        : [];

      let stereotype: ExtractedClass['stereotype'] = null;
      if (bases.some((b) => b === 'Protocol')) stereotype = 'interface';
      else if (bases.some((b) => /^(Enum|IntEnum|StrEnum|Flag|IntFlag)$/.test(b))) stereotype = 'enumeration';
      else if (bases.includes('ABC')) stereotype = 'abstract';

      const members: string[] = [];
      const addMember = (m: string) => {
        if (!members.includes(m)) members.push(m);
      };
      const bodyDefs = defs.filter((d) => d.parent === cls);

      // Class-level attributes: statements directly in the class body (indent of the first body line).
      let bodyIndent = -1;
      for (let i = cls.line + 1; i < cls.endLine; i++) {
        if (!lines[i].trim()) continue;
        if (bodyIndent < 0) bodyIndent = indentOf(lines[i]);
        if (indentOf(lines[i]) !== bodyIndent) continue;
        if (bodyDefs.some((d) => i >= d.line && i < d.endLine)) continue;
        const ann = /^\s*([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(lines[i]);
        const plain = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(lines[i]);
        if (stereotype === 'enumeration' && (plain || ann)) addMember((plain ?? ann)![1]);
        else if (ann) addMember(`${visibilityOf(ann[1])}${ann[1]} ${sanitizeType(ann[2])}`);
        else if (plain) addMember(`${visibilityOf(plain[1])}${plain[1]}`);
      }

      for (const d of bodyDefs.filter((x) => x.kind === 'def')) {
        const isStatic = d.decorators.some((x) => x === 'staticmethod' || x === 'classmethod');
        const isAbstract = d.decorators.some((x) => x.endsWith('abstractmethod'));
        const ret = returnAnnotation(d.header);
        addMember(`${visibilityOf(d.name)}${d.name}(${paramNames(d.header)})${ret ? ' ' + ret : ''}${isStatic ? '$' : ''}${isAbstract ? '*' : ''}`);
        if (isAbstract && stereotype === null) stereotype = 'abstract';
        if (d.name === '__init__') {
          for (let i = d.line + 1; i < d.endLine; i++) {
            const a = /\bself\.([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=(?!=)/.exec(lines[i]);
            if (a) addMember(`${visibilityOf(a[1])}${a[1]}${a[2] ? ' ' + sanitizeType(a[2]) : ''}`);
          }
        }
      }

      // Attribute lines first, then methods, for a readable class box.
      const attrs = members.filter((m) => !m.includes('('));
      const methods = members.filter((m) => m.includes('('));
      classes.push({ id: cls.name, stereotype, members: [...attrs, ...methods] });
      for (const b of bases) {
        if (b === 'ABC' || b === 'Protocol' || b === 'Enum' || b === 'IntEnum' || b === 'StrEnum' || b === 'Flag' || b === 'IntFlag') continue;
        relationships.push({ from: cls.name, to: b, type: 'inheritance' });
      }
    }
  }
  return { classes, relationships };
}

// ---------- call graph ----------

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const declaredTypes = new Set<string>();
  for (const f of files) {
    const { defs, lines } = parsePythonStructure(scrub(f.text, 'python'));
    for (const d of defs.filter((x) => x.kind === 'def')) {
      const cls = d.parent && d.parent.kind === 'class' ? d.parent.name : null;
      fns.push({
        nodeId: `${f.path}::${cls ? cls + '.' : ''}${d.name}`,
        label: cls ? `${cls}.${d.name}` : d.name,
        shortName: d.name,
        className: cls,
        // A one-line `def f(x): return g(x)` keeps its body on the header line.
        body: [/\)\s*(?:->[^:]+)?:\s*(\S.*)$/.exec(lines[d.line] ?? '')?.[1] ?? '', ...lines.slice(d.line + 1, d.endLine)].join('\n'),
        kind: cls ? 'method' : 'function',
        params: /\(([\s\S]*)\)/.exec(lines[d.line] ?? '')?.[1] ?? '',
        returns: /\)\s*->\s*([^:]+):/.exec(lines[d.line] ?? '')?.[1],
      });
    }
    for (const d of defs.filter((x) => x.kind === 'class')) {
      declaredTypes.add(d.name);
      const bases = /class\s+\w+\s*\(([^)]*)\)/.exec(lines[d.line] ?? '')?.[1];
      if (!bases) continue;
      const list = bases.split(',').map((x) => x.trim().replace(/\[.*$/, '')).filter((x) => /^[A-Za-z_][\w.]*$/.test(x)).map((x) => x.split('.').pop()!);
      if (list.length) supers.set(d.name, [...(supers.get(d.name) ?? []), ...list]);
    }
  }
  // `self.repo = Repo()` / `self.repo: Repo` anywhere in a class gives the field a type.
  const classNames = new Set(fns.map((f) => f.className).filter((c): c is string => !!c));
  const fieldTypes = new Map<string, Map<string, string>>();
  for (const fn of fns) {
    if (!fn.className) continue;
    const ft = fieldTypes.get(fn.className) ?? new Map<string, string>();
    for (const m of fn.body.matchAll(/\bself\.([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*)\s*)?=\s*([A-Za-z_]\w*)\s*\(|\bself\.([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/g)) {
      const name = m[1] ?? m[4];
      const type = [m[2], m[3], m[5]].find((t) => t && classNames.has(t));
      if (name && type && !ft.has(name)) ft.set(name, type);
    }
    // `self.repo = repo` where `repo` is a parameter annotated with a scanned class.
    const annotated = new Map<string, string>();
    for (const pm of (fn.params ?? '').matchAll(/\b([A-Za-z_]\w*)\s*:\s*(?:Optional\[)?\s*([A-Za-z_]\w*)/g)) if (classNames.has(pm[2])) annotated.set(pm[1], pm[2]);
    for (const m of fn.body.matchAll(/\bself\.([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*([A-Za-z_]\w*)\s*(?:$|\n|#)/gm)) {
      const type = annotated.get(m[2]);
      if (type && !ft.has(m[1])) ft.set(m[1], type);
    }
    fieldTypes.set(fn.className, ft);
  }
  return buildCallGraph(fns, { selfCall: '\\b(?:self|cls)\\.([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: false, importedFiles: importedFilesFromGraph(analyzeImports(files)), fieldTypes, supers, declaredTypes });
}

export const pythonImportGraphAnalyzer: CodeAnalyzer = {
  id: 'py-import-graph',
  displayName: 'Import Graph (Python)',
  supportedExtensions: ['.py'],
  analyze: analyzeImports,
};

export const pythonCallGraphAnalyzer: CodeAnalyzer = {
  id: 'py-call-graph',
  displayName: 'Call Graph (Python)',
  supportedExtensions: ['.py'],
  analyze: analyzeCalls,
};
