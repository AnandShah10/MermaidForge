import { posix as posixPath } from 'path';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { buildCallGraph, DeclaredFn } from '../common/callGraphByName';
import { matchBrace, scrub } from '../common/scrubber';

/**
 * Go analyzers: package import graph, type diagram (structs / interfaces /
 * defined types), and a name-based call graph. Like the Rust/C++ analyzers
 * this is a lexical, regex-and-brace-matching pass over text whose comments
 * and strings are blanked (common/scrubber.ts), NOT a type-checked parse.
 *
 * Documented limits:
 *  - Imports resolve by matching the import path's SUFFIX against scanned
 *    package directories (no go.mod / go.work / replace handling); standard
 *    library paths are recognised by their first segment and ignored. The
 *    root package ('.') can therefore not be matched. `_test.go` files are
 *    skipped. Vendored/internal-path rules are not enforced.
 *  - "Implements" edges are inferred from method NAMES only (a struct whose
 *    method set, including methods promoted through embedding, contains every
 *    method name of a scanned non-empty interface). Signatures, pointer vs
 *    value receivers and build tags are ignored.
 *  - Types with the same name in different packages get a package-prefixed
 *    id; methods and embeddings are attached by name (same directory first).
 *  - Calls: bare calls and receiver-method calls resolve within the same
 *    package; `pkg.Func()` resolves through the file's imports to free
 *    functions in the scanned package. Calls through interfaces, function
 *    values, embedded promotion and generics instantiation are not resolved.
 */

export interface GoImport {
  alias: string;
  path: string;
}
export interface GoField {
  name: string;
  type: string;
}
export interface GoMethodSig {
  name: string;
  params: string;
  ret: string;
}
export interface GoType {
  name: string;
  kind: 'struct' | 'interface' | 'other';
  fields: GoField[];
  /** Embedded types (struct) or embedded interfaces (interface), as written (maybe `pkg.Name`). */
  embeds: string[];
  /** Interface method signatures. */
  methods: GoMethodSig[];
}
export interface GoFunc {
  name: string;
  owner: string | null;
  recv: string | null;
  params: string;
  ret: string;
  body: string;
  hasBody: boolean;
}
export interface GoFile {
  pkg: string;
  imports: GoImport[];
  types: GoType[];
  funcs: GoFunc[];
}

// ---------- lexical helpers ----------

/** Blanks comments only (strings kept), same length as the input. Never throws. */
export function stripGoComments(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  const blank = (c: string) => (c === '\n' || c === '\r' ? c : ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') out.push(' '), i++;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      for (; i < j; i++) out.push(blank(text[i]));
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      const j = end < 0 ? n : end + 1;
      for (; i < j; i++) out.push(text[i]);
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      for (; i < j; i++) out.push(text[i]);
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open` (any of ( [ {), or -1. */
function matchClose(s: string, open: number): number {
  const o = s[open];
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** Index of the end of the statement starting at i: the next newline at bracket depth 0. */
function skipStatement(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === '\n' && depth === 0) return i;
  }
  return s.length;
}

/** Splits a block body at newlines / semicolons that sit at bracket depth 0. */
function splitEntries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if ((c === '\n' || c === ';') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Makes a Go type/param string safe inside a Mermaid class member line. */
function memberText(t: string, max = 48): string {
  let r = norm(t)
    .replace(/interface\s*\{\s*\}/g, 'any')
    .replace(/struct\s*\{[\s\S]*\}/g, 'struct')
    .replace(/<-/g, '')
    .replace(/[{};"`]/g, '');
  r = norm(r);
  return r.length > max ? r.slice(0, max - 1) + '…' : r;
}

/** Field types that are function types would be mis-read as methods by Mermaid; collapse them. */
function fieldTypeText(t: string): string {
  const r = memberText(t);
  return /^func\b/.test(r) ? 'func' : r;
}

const STDLIB_ROOTS = new Set(
  'archive bufio bytes cmp compress container context crypto database debug embed encoding errors expvar flag fmt go hash html image index io iter log maps math mime net os path plugin reflect regexp runtime slices sort strconv strings structs sync syscall testing text time unicode unique unsafe'.split(' '),
);

export function isStdlibImport(path: string): boolean {
  const first = path.split('/')[0];
  return !first.includes('.') && STDLIB_ROOTS.has(first);
}

export function defaultImportAlias(path: string): string {
  const segs = path.split('/').filter(Boolean);
  let last = segs[segs.length - 1] ?? path;
  if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2];
  last = last.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return last;
}

// ---------- parsing ----------

function parseTypeSpec(s: string, i: number, out: GoType[]): number {
  const m = /^\s*([A-Za-z_]\w*)/.exec(s.slice(i, i + 200));
  if (!m) return skipStatement(s, i);
  const name = m[1];
  let j = i + m[0].length;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  // Type parameters `[K comparable, V any]` — but not an array type `[5]int`.
  if (s[j] === '[') {
    const close = matchClose(s, j);
    if (close > 0 && /^\s*[A-Za-z_]\w*\s+\S/.test(s.slice(j + 1, close))) {
      j = close + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    }
  }
  if (s[j] === '=') return skipStatement(s, j); // alias: not a new type
  const kw = /^(struct|interface)\b/.exec(s.slice(j, j + 12));
  if (kw) {
    let b = j + kw[0].length;
    while (b < s.length && /\s/.test(s[b])) b++;
    if (s[b] === '{') {
      const close = matchBrace(s, b);
      const body = s.slice(b + 1, close);
      const t: GoType = { name, kind: kw[1] as 'struct' | 'interface', fields: [], embeds: [], methods: [] };
      for (const entry of splitEntries(body)) {
        if (t.kind === 'struct') {
          const embedded = /^\*?([A-Za-z_][\w.]*)(?:\[[^\]]*\])?$/.exec(entry);
          if (embedded) {
            t.embeds.push(embedded[1]);
            continue;
          }
          const named = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+([\s\S]+)$/.exec(entry);
          if (named) for (const fname of named[1].split(',')) t.fields.push({ name: fname.trim(), type: named[2] });
        } else {
          const meth = /^([A-Za-z_]\w*)\s*\(/.exec(entry);
          if (meth) {
            const po = entry.indexOf('(');
            const pc = matchClose(entry, po);
            if (pc > 0) t.methods.push({ name: meth[1], params: entry.slice(po + 1, pc), ret: entry.slice(pc + 1) });
            continue;
          }
          const emb = /^([A-Za-z_][\w.]*)(?:\[[^\]]*\])?$/.exec(entry);
          if (emb) t.embeds.push(emb[1]);
        }
      }
      out.push(t);
      return close + 1;
    }
  }
  out.push({ name, kind: 'other', fields: [], embeds: [], methods: [] });
  return skipStatement(s, j);
}

function parseFuncDecl(s: string, i: number, out: GoFunc[]): number {
  let j = i + 4;
  const ws = () => {
    while (j < s.length && /\s/.test(s[j])) j++;
  };
  ws();
  let owner: string | null = null;
  let recv: string | null = null;
  if (s[j] === '(') {
    const close = matchClose(s, j);
    if (close < 0) return skipStatement(s, i);
    const m = /^\s*(?:([A-Za-z_]\w*)\s+)?\*?\s*([A-Za-z_]\w*)/.exec(s.slice(j + 1, close));
    if (m) {
      recv = m[1] && m[1] !== '_' ? m[1] : null;
      owner = m[2];
    }
    j = close + 1;
    ws();
  }
  const nm = /^[A-Za-z_]\w*/.exec(s.slice(j, j + 200));
  if (!nm) return skipStatement(s, i);
  const name = nm[0];
  j += name.length;
  ws();
  if (s[j] === '[') {
    const close = matchClose(s, j);
    if (close < 0) return skipStatement(s, i);
    j = close + 1;
    ws();
  }
  if (s[j] !== '(') return skipStatement(s, i);
  const pclose = matchClose(s, j);
  if (pclose < 0) return skipStatement(s, i);
  const params = s.slice(j + 1, pclose);

  // Result type runs until the body `{` (skipping `interface{}` / `struct{}`), or the end of line for a bodyless decl.
  let k = pclose + 1;
  let depth = 0;
  let bodyOpen = -1;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === '{') {
      if (/(?:interface|struct)\s*$/.test(s.slice(Math.max(pclose, k - 12), k))) {
        const close = matchBrace(s, k);
        k = close;
        continue;
      }
      bodyOpen = k;
      break;
    } else if (c === '\n' && depth === 0) break;
  }
  const ret = norm(s.slice(pclose + 1, bodyOpen >= 0 ? bodyOpen : k));
  if (bodyOpen < 0) {
    out.push({ name, owner, recv, params, ret, body: '', hasBody: false });
    return k;
  }
  const end = matchBrace(s, bodyOpen);
  out.push({ name, owner, recv, params, ret, body: s.slice(bodyOpen, end + 1), hasBody: true });
  return end + 1;
}

export function parseGo(source: string): GoFile {
  const text = typeof source === 'string' ? source : '';
  const s = scrub(text, 'go');
  const code = stripGoComments(text);
  const out: GoFile = { pkg: '', imports: [], types: [], funcs: [] };
  const pm = /(?:^|\n)[ \t]*package[ \t]+([A-Za-z_]\w*)/.exec(s);
  if (pm) out.pkg = pm[1];

  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const kw = /^(import|type|func|var|const|package)\b/.exec(s.slice(i, i + 8));
    try {
      if (!kw) {
        i = skipStatement(s, i) + 1;
      } else if (kw[1] === 'import') {
        let j = i + 6;
        // Skip blanks in `code`, not `s`: a blanked string literal would otherwise be skipped too.
        while (j < n && (code[j] === ' ' || code[j] === '\t')) j++;
        const reLine = /^\s*(?:([A-Za-z_.][\w.]*)\s+)?"([^"\n]+)"/;
        if (s[j] === '(') {
          const close = matchClose(s, j);
          const end = close < 0 ? n : close;
          for (const line of code.slice(j + 1, end).split('\n')) {
            const m = reLine.exec(line);
            if (m) out.imports.push({ alias: m[1] ?? defaultImportAlias(m[2]), path: m[2] });
          }
          i = end + 1;
        } else {
          const eol = skipStatement(s, j);
          const m = reLine.exec(code.slice(j, eol));
          if (m) out.imports.push({ alias: m[1] ?? defaultImportAlias(m[2]), path: m[2] });
          i = eol + 1;
        }
      } else if (kw[1] === 'type') {
        let j = i + 4;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        if (s[j] === '(') {
          const close = matchClose(s, j);
          const end = close < 0 ? n : close;
          let p = j + 1;
          while (p < end) {
            while (p < end && /\s/.test(s[p])) p++;
            if (p >= end) break;
            p = Math.max(parseTypeSpec(s, p, out.types), p + 1);
          }
          i = end + 1;
        } else i = Math.max(parseTypeSpec(s, j, out.types), j + 1);
      } else if (kw[1] === 'func') {
        i = Math.max(parseFuncDecl(s, i, out.funcs), i + 4);
      } else {
        i = skipStatement(s, i + kw[1].length) + 1;
      }
    } catch {
      i = skipStatement(s, i) + 1;
    }
  }
  return out;
}

// ---------- helpers over many files ----------

const isTest = (p: string) => /_test\.go$/.test(p);
const dirOf = (p: string) => posixPath.dirname(p);
const exported = (name: string) => /^[A-Z]/.test(name);

function goFiles(files: SourceFileInput[]): SourceFileInput[] {
  return (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string' && /\.go$/.test(f.path) && !isTest(f.path));
}

/** Resolves an import path to a scanned package directory by longest path-suffix match. */
function resolveImportDir(importPath: string, dirs: string[]): string | null {
  if (isStdlibImport(importPath)) return null;
  let best: string | null = null;
  for (const d of dirs) {
    if (d === '.') continue;
    if (importPath === d || importPath.endsWith('/' + d)) if (best === null || d.length > best.length) best = d;
  }
  return best;
}

// ---------- imports ----------

function analyzeImports(input: SourceFileInput[]): CodeGraph {
  const files = goFiles(input);
  const dirs = [...new Set(files.map((f) => dirOf(f.path)))].sort();
  const nodes = dirs.map((d) => ({ id: d, label: d === '.' ? '(root package)' : d, kind: 'package' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const from = dirOf(f.path);
    let parsed: GoFile;
    try {
      parsed = parseGo(f.text);
    } catch {
      continue;
    }
    for (const imp of parsed.imports) {
      const to = resolveImportDir(imp.path, dirs);
      if (!to || to === from) continue;
      const k = `${from}=>${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from, to, kind: 'import' });
    }
  }
  return { nodes, edges };
}

// ---------- classes ----------

interface Declared {
  id: string;
  name: string;
  dir: string;
  pkg: string;
  type: GoType;
}

function sanitizeId(raw: string): string {
  const c = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(c) ? c : `t_${c}`;
}

export function analyzeGoClasses(input: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const files = goFiles(input);
  const parsedFiles: Array<{ f: SourceFileInput; go: GoFile }> = [];
  for (const f of files) {
    try {
      parsedFiles.push({ f, go: parseGo(f.text) });
    } catch {
      continue;
    }
  }

  // Declarations, merged per (dir, name) since a package spans several files.
  const declared: Declared[] = [];
  const byDirName = new Map<string, Declared>();
  const nameDirs = new Map<string, Set<string>>();
  for (const { f, go } of parsedFiles) {
    const dir = dirOf(f.path);
    for (const t of go.types) {
      const key = `${dir}\0${t.name}`;
      if (byDirName.has(key)) continue;
      const d: Declared = { id: t.name, name: t.name, dir, pkg: go.pkg, type: t };
      byDirName.set(key, d);
      declared.push(d);
      const set = nameDirs.get(t.name) ?? new Set<string>();
      set.add(dir);
      nameDirs.set(t.name, set);
    }
  }
  for (const d of declared) {
    if ((nameDirs.get(d.name)?.size ?? 0) > 1) d.id = sanitizeId(`${d.pkg || posixPath.basename(d.dir)}_${d.name}`);
  }
  // Ids can still clash after prefixing (same package name in two dirs); fall back to the dir path.
  const usedIds = new Set<string>();
  for (const d of declared) {
    if (usedIds.has(d.id)) d.id = sanitizeId(`${d.dir}_${d.name}`);
    usedIds.add(d.id);
  }

  const find = (name: string, fromDir: string, qualifier?: string): Declared | null => {
    let cands = declared.filter((d) => d.name === name);
    if (qualifier) {
      const q = cands.filter((d) => d.pkg === qualifier || posixPath.basename(d.dir) === qualifier);
      if (q.length) cands = q;
      else return null;
    }
    return cands.find((d) => d.dir === fromDir) ?? cands[0] ?? null;
  };
  const resolveEmbed = (raw: string, fromDir: string): Declared | null => {
    const dot = raw.lastIndexOf('.');
    return dot < 0 ? find(raw, fromDir) : find(raw.slice(dot + 1), fromDir, raw.slice(0, dot));
  };

  // Receiver methods grouped by owner declaration.
  const methodsOf = new Map<Declared, GoFunc[]>();
  for (const { f, go } of parsedFiles) {
    const dir = dirOf(f.path);
    for (const fn of go.funcs) {
      if (!fn.owner) continue;
      const d = byDirName.get(`${dir}\0${fn.owner}`);
      if (!d) continue;
      const list = methodsOf.get(d) ?? [];
      if (!list.some((m) => m.name === fn.name)) list.push(fn);
      methodsOf.set(d, list);
    }
  }

  const methodNameSet = (d: Declared, depth = 0, seen = new Set<Declared>()): Set<string> => {
    const names = new Set<string>();
    if (seen.has(d) || depth > 6) return names;
    seen.add(d);
    if (d.type.kind === 'interface') for (const m of d.type.methods) names.add(m.name);
    for (const m of methodsOf.get(d) ?? []) names.add(m.name);
    for (const e of d.type.embeds) {
      const ed = resolveEmbed(e, d.dir);
      if (ed) for (const nme of methodNameSet(ed, depth + 1, seen)) names.add(nme);
    }
    return names;
  };

  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const relSeen = new Set<string>();
  const addRel = (r: ExtractedRelationship) => {
    const k = `${r.from}|${r.to}|${r.type}`;
    if (r.from !== r.to && !relSeen.has(k)) {
      relSeen.add(k);
      relationships.push(r);
    }
  };

  for (const d of declared) {
    const t = d.type;
    const members: string[] = [];
    const vis = (n: string) => (exported(n) ? '+' : '-');
    if (t.kind === 'struct') {
      for (const fld of t.fields) members.push(`${vis(fld.name)}${fld.name} ${fieldTypeText(fld.type)}`.trim());
      // Embedded types that are scanned become inheritance arrows below; others (sync.Mutex, ...) show as fields.
      for (const e of t.embeds) if (!resolveEmbed(e, d.dir)) members.push(`+${memberText(e)}`);
    }
    if (t.kind === 'interface') {
      for (const m of t.methods) members.push(`${vis(m.name)}${m.name}(${memberText(m.params, 60)})${m.ret.trim() ? ' ' + memberText(m.ret) : ''}`);
    }
    for (const m of methodsOf.get(d) ?? []) {
      members.push(`${vis(m.name)}${m.name}(${memberText(m.params, 60)})${m.ret ? ' ' + memberText(m.ret) : ''}`);
    }
    // Fields first, then methods (same ordering as the other analyzers).
    const ordered = [...members.filter((m) => !m.includes('(')), ...members.filter((m) => m.includes('('))];
    classes.push({ id: d.id, stereotype: t.kind === 'interface' ? 'interface' : null, members: ordered });

    for (const e of t.embeds) {
      const target = resolveEmbed(e, d.dir);
      if (target) addRel({ from: d.id, to: target.id, type: 'inheritance' });
    }
  }

  // Name-based "implements": struct method set ⊇ interface method set.
  const interfaces = declared.filter((d) => d.type.kind === 'interface');
  for (const iface of interfaces) {
    const need = methodNameSet(iface);
    if (need.size === 0) continue;
    for (const d of declared) {
      if (d === iface || d.type.kind === 'interface') continue;
      const have = methodNameSet(d);
      if ([...need].every((nme) => have.has(nme))) addRel({ from: d.id, to: iface.id, type: 'realization' });
    }
  }
  return { classes, relationships };
}

// ---------- calls ----------

function analyzeCalls(input: SourceFileInput[]): CodeGraph {
  const files = goFiles(input);
  const dirs = [...new Set(files.map((f) => dirOf(f.path)))];
  const fns: DeclaredFn[] = [];
  const dirOfNode = new Map<string, string>();
  const freeByDirName = new Map<string, string>(); // `${dir}\0${name}` -> nodeId
  const perFile: Array<{ nodeId: string; dir: string; body: string; imports: GoImport[] }> = [];
  const fieldTypes = new Map<string, Map<string, string>>(); // struct -> field -> type (pointer/package stripped)
  const ifaces = new Map<string, string[]>(); // interface -> its method names

  for (const f of files) {
    let go: GoFile;
    try {
      go = parseGo(f.text);
    } catch {
      continue;
    }
    const dir = dirOf(f.path);
    for (const t of go.types) {
      if (t.kind === 'interface' && t.methods.length) ifaces.set(t.name, t.methods.map((m) => m.name));
      if (t.kind !== 'struct') continue;
      const ft = fieldTypes.get(t.name) ?? new Map<string, string>();
      for (const fld of t.fields) {
        const m = /^[*[\]]*(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)$/.exec(fld.type.trim());
        if (m) ft.set(fld.name, m[1]);
      }
      fieldTypes.set(t.name, ft);
    }
    for (const fn of go.funcs) {
      if (!fn.hasBody) continue;
      const nodeId = `${f.path}::${fn.owner ? fn.owner + '.' : ''}${fn.name}`;
      // buildCallGraph recognises `self.x()`; rewrite this method's receiver variable to it.
      const body = fn.recv ? fn.body.replace(new RegExp(`\\b${fn.recv}\\.`, 'g'), 'self.') : fn.body;
      fns.push({ nodeId, label: fn.owner ? `${fn.owner}.${fn.name}` : fn.name, shortName: fn.name, className: fn.owner, body, kind: fn.owner ? 'method' : 'function', params: fn.params, returns: fn.ret });
      dirOfNode.set(nodeId, dir);
      if (!fn.owner) freeByDirName.set(`${dir}\0${fn.name}`, nodeId);
      perFile.push({ nodeId, dir, body: fn.body, imports: go.imports });
    }
  }

  // Go satisfies interfaces structurally: a type implements an interface when it has a method of every name in it.
  const methodsOf = new Map<string, Set<string>>();
  for (const fn of fns) if (fn.className) methodsOf.set(fn.className, (methodsOf.get(fn.className) ?? new Set()).add(fn.shortName));
  const supers = new Map<string, string[]>();
  for (const [typeName, have] of methodsOf) {
    const list = [...ifaces].filter(([iname, ms]) => iname !== typeName && ms.every((m) => have.has(m))).map(([iname]) => iname);
    if (list.length) supers.set(typeName, list);
  }
  const base = buildCallGraph(fns, { selfCall: '\\bself\\.([A-Za-z_]\\w*)\\s*\\(', qualifier: '.', bareCallsReachSiblings: false, fieldTypes, supers, declaredTypes: new Set([...ifaces.keys(), ...methodsOf.keys()]) });
  // Go has no cross-package bare calls: keep only same-package edges from the name-based pass...
  const edges = base.edges.filter((e) => dirOfNode.get(e.from) === dirOfNode.get(e.to));
  const seen = new Set(edges.map((e) => `${e.from}=>${e.to}`));
  // ...then add `pkg.Func()` edges resolved through each file's imports.
  for (const pf of perFile) {
    const aliasDir = new Map<string, string>();
    for (const imp of pf.imports) {
      if (imp.alias === '_' || imp.alias === '.') continue;
      const d = resolveImportDir(imp.path, dirs);
      if (d) aliasDir.set(imp.alias, d);
    }
    if (aliasDir.size === 0) continue;
    const re = /(?<![\w.])([A-Za-z_]\w*)\.([A-Z]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pf.body))) {
      const d = aliasDir.get(m[1]);
      const target = d ? freeByDirName.get(`${d}\0${m[2]}`) : undefined;
      if (!target || target === pf.nodeId) continue;
      const k = `${pf.nodeId}=>${target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from: pf.nodeId, to: target, kind: 'calls' });
    }
  }
  return { nodes: base.nodes, edges };
}

export const goImportGraphAnalyzer: CodeAnalyzer = {
  id: 'go-import-graph',
  displayName: 'Package Graph (Go)',
  supportedExtensions: ['.go'],
  analyze: analyzeImports,
};

export const goCallGraphAnalyzer: CodeAnalyzer = {
  id: 'go-call-graph',
  displayName: 'Call Graph (Go)',
  supportedExtensions: ['.go'],
  analyze: analyzeCalls,
};
