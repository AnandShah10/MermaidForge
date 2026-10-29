import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn, importedFilesFromGraph } from '../common/callGraphByName';

/**
 * C / C++ analyzers over scrubbed text with brace matching — no compiler
 * front end, no preprocessor. Handles class/struct/union declarations
 * (inheritance with access specifiers, access-labelled members, inline and
 * out-of-line methods, constructors/destructors, pure virtuals), enums,
 * namespaces (flattened), `extern "C"` blocks and `#include "..."`.
 * NOT handled: macros that generate code or hide declarations, template
 * specialisation details (templates are read as their plain class), ADL
 * and overload resolution (same-named overloads are merged), conditional
 * compilation (`#if` branches are all read), and angle-bracket system
 * includes (always treated as external).
 */

export interface CppMethod {
  name: string;
  owner: string | null;
  access: string;
  params: string;
  ret: string;
  isStatic: boolean;
  isPureVirtual: boolean;
  body: string;
  /** True when a `{ ... }` body was present (even if empty). */
  hasBody: boolean;
}

export interface CppClass {
  name: string;
  kind: 'class' | 'struct' | 'union' | 'enum';
  bases: string[];
  fields: string[];
  methods: CppMethod[];
  enumerators: string[];
}

export interface CppFile {
  classes: CppClass[];
  /** Free functions and out-of-line `Class::method` definitions. */
  functions: CppMethod[];
}

const DECL_NOISE = /\b(?:virtual|static|inline|explicit|constexpr|consteval|constinit|friend|extern|mutable|noexcept|override|final|volatile|typename|template\s*<[^>]*>)\b/g;

function accessSymbol(a: string): string {
  return a === 'public' ? '+' : a === 'protected' ? '#' : '-';
}

function parseParams(raw: string): string {
  return splitTopLevel(raw, ',')
    .filter((p) => p !== 'void')
    .map((p) => {
      const noDefault = p.split('=')[0].trim();
      const m = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(noDefault);
      // A lone type with no parameter name ("int") yields the type itself.
      return m ? m[1] : noDefault;
    })
    .join(', ');
}

/** Splits a declaration header `ret Name(params) quals` into pieces; null when it isn't a function. */
function parseFunctionHeader(stmt: string): { qualifier: string | null; name: string; params: string; ret: string; pure: boolean; isStatic: boolean } | null {
  const s = stmt.replace(/\s+/g, ' ').trim();
  if (!s.includes('(')) return null;
  const open = s.indexOf('(');
  let depth = 0;
  let close = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const before = s.slice(0, open).trim();
  const after = s.slice(close + 1);
  // Reject function-pointer fields "(*fp)" and macro-ish junk.
  if (/^[\s(*&]*$/.test(before) || /\(\s*\*/.test(s.slice(open, open + 3))) return null;
  if (/^(?:if|for|while|switch|return|else|do|catch|sizeof|alignas|decltype|typedef|using)\b/.test(before)) return null;
  const nm = /((?:[A-Za-z_]\w*\s*(?:<[^<>]*>)?\s*::\s*)*(?:~\s*)?(?:operator\s*(?:\(\s*\)|\[\s*\]|[^\s(]+)|[A-Za-z_]\w*))\s*$/.exec(before);
  if (!nm) return null;
  const full = nm[1].replace(/\s+/g, '');
  const ret = before.slice(0, before.length - nm[1].length).replace(DECL_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const parts = full.split('::');
  const name = parts[parts.length - 1];
  const qualifier = parts.length > 1 ? parts[parts.length - 2].replace(/<.*$/, '') : null;
  return {
    qualifier,
    name,
    params: parseParams(s.slice(open + 1, close)),
    ret: sanitizeType(ret),
    pure: /=\s*0\s*$/.test(after.trim()),
    isStatic: /\bstatic\b/.test(before),
  };
}

function scanScope(text: string, start: number, end: number, file: CppFile, owner: CppClass | null, defaultAccess: string): void {
  let access = defaultAccess;
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end) break;

    // Preprocessor lines (kept in scrubbed text): skip to end of (continued) line.
    if (text[i] === '#') {
      let j = i;
      while (j < end && (text[j] !== '\n' || text[j - 1] === '\\')) j++;
      i = j + 1;
      continue;
    }
    // Access label
    const acc = /^(public|protected|private)\s*:(?!:)/.exec(text.slice(i, i + 20));
    if (acc && owner) {
      access = acc[1];
      i += acc[0].length;
      continue;
    }

    // Read one statement: up to `;` or through a balanced `{ ... }` block.
    let j = i;
    let paren = 0;
    let braceAt = -1;
    for (; j < end; j++) {
      const c = text[j];
      if (c === '(' || c === '[') paren++;
      else if (c === ')' || c === ']') paren--;
      else if (paren <= 0 && c === ';') break;
      else if (paren <= 0 && c === '{') {
        braceAt = j;
        break;
      }
    }
    const header = text.slice(i, j).trim();
    let stmtEnd = j + 1;
    let body = '';
    let bodyStart = -1;
    let bodyEnd = -1;
    if (braceAt >= 0) {
      bodyEnd = matchBrace(text, braceAt);
      bodyStart = braceAt + 1;
      body = text.slice(bodyStart, bodyEnd);
      stmtEnd = bodyEnd + 1;
      // After a class/struct/union/enum body, consume trailing declarators and `;` ("} name;").
      // Function bodies must NOT do this — the next token there is a new declaration.
      if (/^(?:template\s*<.*>\s*)?(?:typedef\s+)?(?:class|struct|union|enum)\b/.test(header.replace(/\s+/g, ' '))) {
        let k = stmtEnd;
        while (k < end && /[^;{}]/.test(text[k])) k++;
        if (text[k] === ';') stmtEnd = k + 1;
      }
    }
    const norm = header.replace(/\s+/g, ' ');

    // namespace / extern "C" blocks → flatten
    if (braceAt >= 0 && (/^(?:inline\s+)?namespace\b/.test(norm) || /^extern\s*(?:"[^"]*")?\s*$/.test(norm))) {
      scanScope(text, bodyStart, bodyEnd, file, owner, defaultAccess);
      i = stmtEnd;
      continue;
    }

    const clsM = /^(?:template\s*<.*>\s*)?(?:typedef\s+)?(class|struct|union|enum(?:\s+class|\s+struct)?)\s+(?:alignas\([^)]*\)\s*)?(?:\[\[[^\]]*\]\]\s*)?(?:[A-Z_]+_API\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::\s*([^{]*))?$/.exec(norm);
    if (clsM && braceAt >= 0 && !/\)/.test(norm.replace(/\(.*?\)/g, ''))) {
      const rawKind = clsM[1].startsWith('enum') ? 'enum' : (clsM[1] as 'class' | 'struct' | 'union');
      const cls: CppClass = { name: clsM[2], kind: rawKind, bases: [], fields: [], methods: [], enumerators: [] };
      if (rawKind === 'enum') {
        cls.enumerators = splitTopLevel(body, ',')
          .map((e) => /^([A-Za-z_]\w*)/.exec(e.trim())?.[1])
          .filter((e): e is string => !!e);
      } else {
        if (clsM[3]) {
          cls.bases = splitTopLevel(clsM[3], ',')
            .map((b) => b.replace(/\b(?:public|protected|private|virtual)\b/g, '').replace(/<.*$/, '').trim().split('::').pop()!.trim())
            .filter((b) => /^[A-Za-z_]\w*$/.test(b));
        }
        scanScope(text, bodyStart, bodyEnd, file, cls, rawKind === 'class' ? 'private' : 'public');
      }
      file.classes.push(cls);
      i = stmtEnd;
      continue;
    }

    // Forward declarations, using/typedef/static_assert/friend: ignore.
    if (!header || /^(?:template\s*<.*>\s*)?(?:class|struct|union|enum)\b[^({=]*$/.test(norm) || /^(?:using|typedef|static_assert|friend)\b/.test(norm)) {
      i = stmtEnd;
      continue;
    }

    const fn = parseFunctionHeader(header);
    const hasEq = /(^|[^=!<>])=(?!=)/.test(header.split('(')[0]);
    if (fn && !hasEq) {
      const ownerName = owner ? owner.name : fn.qualifier;
      const method: CppMethod = {
        name: fn.name,
        owner: ownerName,
        access: owner ? access : 'public',
        params: fn.params,
        ret: fn.name === ownerName || fn.name.startsWith('~') ? '' : fn.ret,
        isStatic: fn.isStatic,
        isPureVirtual: fn.pure,
        body,
        hasBody: braceAt >= 0,
      };
      if (owner) owner.methods.push(method);
      else if (braceAt >= 0) file.functions.push(method);
      // free declarations without a body (prototypes) are not nodes
    } else if (owner && owner.kind !== 'enum') {
      // Field(s): "Type name [= init]" / "Type a, b" / "Type name[N]"; bit-fields drop the width.
      const decl = header.replace(DECL_NOISE, ' ').replace(/\s+/g, ' ').trim();
      const noInit = decl.split(/(?<![=!<>])=(?!=)/)[0].trim();
      const declarators = splitTopLevel(noInit, ',');
      const first = declarators[0] ?? '';
      const fm = /^([\s\S]*?[\s*&>])([*&]*\s*[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?::\s*\d+)?$/.exec(first);
      if (fm && fm[1].trim()) {
        const type = fm[1].trim();
        const names = [fm[2].replace(/[*&\s]/g, ''), ...declarators.slice(1).map((d) => d.replace(/[*&\s]|\[.*\]/g, ''))];
        for (const n of names) if (/^[A-Za-z_]\w*$/.test(n)) owner.fields.push(`${accessSymbol(access)}${n} ${sanitizeType(type)}${/\bstatic\b/.test(header) ? '$' : ''}`);
      }
    }
    i = stmtEnd;
  }
}

export function parseCpp(source: string): CppFile {
  const text = scrub(source, 'cpp');
  const file: CppFile = { classes: [], functions: [] };
  scanScope(text, 0, text.length, file, null, 'public');
  return file;
}

// ---------- classes ----------

function methodMember(m: CppMethod): string {
  return `${accessSymbol(m.access)}${m.name}(${m.params})${m.ret ? ' ' + m.ret : ''}${m.isStatic ? '$' : ''}${m.isPureVirtual ? '*' : ''}`;
}

export function analyzeCppClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const classes: ExtractedClass[] = [];
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const parsed = parseCpp(f.text);
    for (const c of parsed.classes) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const isEnum = c.kind === 'enum';
      const abstract = c.methods.some((m) => m.isPureVirtual);
      const interfaceLike = abstract && c.fields.length === 0 && c.methods.every((m) => m.isPureVirtual || m.name.startsWith('~') || m.name === c.name);
      classes.push({
        id: c.name,
        stereotype: isEnum ? 'enumeration' : interfaceLike ? 'interface' : abstract ? 'abstract' : null,
        members: isEnum ? c.enumerators : [...c.fields, ...c.methods.map(methodMember)],
      });
      for (const b of c.bases) relationships.push({ from: c.name, to: b, type: 'inheritance' });
    }
  }
  return { classes, relationships };
}

// ---------- calls ----------

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const declaredTypes = new Set<string>();
  for (const f of files) {
    const parsed = parseCpp(f.text);
    const add = (m: CppMethod) => {
      if (!m.hasBody) return;
      fns.push({
        nodeId: `${f.path}::${m.owner ? m.owner + '.' : ''}${m.name}`,
        label: m.owner ? `${m.owner}.${m.name}` : m.name,
        shortName: m.name,
        className: m.owner,
        body: m.body,
        kind: m.owner ? 'method' : 'function',
        params: m.params,
        returns: m.ret,
      });
    };
    parsed.functions.forEach(add);
    for (const c of parsed.classes) declaredTypes.add(c.name);
    for (const c of parsed.classes) if (c.bases.length) supers.set(c.name, [...(supers.get(c.name) ?? []), ...c.bases.map((b) => b.replace(/<.*$/, '').split('::').pop()!.trim())]);
    parsed.classes.forEach((c) => c.methods.filter((m) => m.hasBody).forEach(add));
  }
  // `this->foo()` and bare sibling calls both reach same-class methods.
  // `#include "foo.h"` also makes the definitions in foo.cpp / foo.cc / foo.c (same directory and stem) visible.
  const imported = importedFilesFromGraph(analyzeCppIncludes(files));
  const byStem = new Map<string, string[]>();
  for (const f of files) {
    const stem = f.path.replace(/\.[^./]+$/, '');
    byStem.set(stem, [...(byStem.get(stem) ?? []), f.path]);
  }
  for (const set of imported.values()) for (const inc of [...set]) for (const sibling of byStem.get(inc.replace(/\.[^./]+$/, '')) ?? []) set.add(sibling);
  return buildCallGraph(fns, { selfCall: '\\bthis\\s*->\\s*([A-Za-z_]\\w*)\\s*\\(', qualifier: '::', bareCallsReachSiblings: true, importedFiles: imported, supers, declaredTypes });
}

// ---------- includes ----------

export function analyzeCppIncludes(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const list = [...known];
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  for (const f of files) {
    // Includes are read from the original text (the scrubber blanks the quoted path), skipping commented-out lines.
    const scrubbedLines = scrub(f.text, 'cpp').split('\n');
    const origLines = f.text.split('\n');
    for (let i = 0; i < origLines.length; i++) {
      if (!/^\s*#\s*include\b/.test(scrubbedLines[i] ?? '')) continue;
      const m = /^\s*#\s*include\s*"([^"]+)"/.exec(origLines[i]);
      if (!m) continue; // <system> includes are external
      const rel = posixPath.normalize(posixPath.join(posixPath.dirname(f.path), m[1]));
      const target = known.has(rel) ? rel : list.find((k) => k === m[1] || k.endsWith('/' + m[1]));
      if (!target || target === f.path) continue;
      const key = `${f.path}=>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: f.path, to: target, kind: 'include' });
    }
  }
  return { nodes, edges };
}

export const cppIncludeGraphAnalyzer: CodeAnalyzer = {
  id: 'cpp-include-graph',
  displayName: 'Include Graph (C/C++)',
  supportedExtensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  analyze: analyzeCppIncludes,
};

export const cppCallGraphAnalyzer: CodeAnalyzer = {
  id: 'cpp-call-graph',
  displayName: 'Call Graph (C/C++)',
  supportedExtensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  analyze: analyzeCalls,
};
