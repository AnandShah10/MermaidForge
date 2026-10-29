import * as posixPath from 'path/posix';
import { CodeAnalyzer, CodeGraph, SourceFileInput } from '../analyzer';
import { ExtractedClass, ExtractedRelationship } from '../mermaidGenerator';
import { matchBrace, sanitizeType, scrub, splitTopLevel } from '../common/scrubber';
import { buildCallGraph, DeclaredFn, importedFilesFromGraph } from '../common/callGraphByName';

/**
 * Rust analyzers: a brace-matching item scanner over scrubbed text (no
 * bundled Rust parser). Handles structs (named, tuple, unit), enums,
 * traits (with supertraits), `impl Type` and `impl Trait for Type` blocks,
 * free functions, inline `mod name { }` blocks, `mod name;` declarations
 * and `use` trees. NOT handled: macro-generated items (`macro_rules!`
 * expansions, derive output), `cfg`-conditional duplicates, re-exports
 * (`pub use`) as separate edges, trait-method dispatch, generic bounds
 * beyond display, and `use` through external crates.
 */

export interface RustFn {
  name: string;
  /** Type (for impl/trait methods) or null for free functions. */
  owner: string | null;
  vis: string;
  params: string;
  /** Parameters with their types as written (`a: &Foo, b: u8`), `self` excluded; for type inference only. */
  typedParams: string;
  ret: string;
  body: string;
  hasBody: boolean;
  isStatic: boolean;
}

export interface RustItems {
  /** `rawFields` keep each field's type as written (`repo: Arc<Repo>`), for type inference. */
  structs: Array<{ name: string; fields: string[]; rawFields: string[] }>;
  enums: Array<{ name: string; variants: string[] }>;
  traits: Array<{ name: string; supers: string[]; methods: RustFn[] }>;
  impls: Array<{ type: string; trait: string | null; methods: RustFn[] }>;
  fns: RustFn[];
  modDecls: string[]; // `mod x;`
}

function visPrefix(v: string | undefined): string {
  if (!v) return '-';
  if (/^pub\s*\(/.test(v)) return '~';
  return '+';
}

function baseTypeName(t: string): string {
  const m = /([A-Za-z_]\w*)\s*(?:<.*)?$/.exec(t.replace(/^[&*]+\s*(?:mut\s+|const\s+)?/, '').replace(/^dyn\s+/, '').trim().replace(/<.*$/, ''));
  return m ? m[1] : t.trim();
}

function parseFn(header: string, body: string, owner: string | null, vis: string | undefined, hasBody = true): RustFn | null {
  const m = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*\(/.exec(header);
  if (!m) return null;
  const open = header.indexOf('(', m.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < header.length; i++) {
    if (header[i] === '(') depth++;
    else if (header[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const rawParams = splitTopLevel(header.slice(open + 1, close), ',');
  const hasSelf = rawParams.some((p) => /^(&\s*(?:'\w+\s*)?(?:mut\s+)?|mut\s+)?self\b/.test(p));
  const params = rawParams
    .filter((p) => !/^(&\s*(?:'\w+\s*)?(?:mut\s+)?|mut\s+)?self\b/.test(p))
    .map((p) => p.split(':')[0].replace(/\bmut\b/, '').trim())
    .filter(Boolean)
    .join(', ');
  const ret = /->\s*([^{;]+?)\s*(?:where\b[\s\S]*)?$/.exec(header.slice(close + 1));
  return {
    name: m[1],
    owner,
    vis: visPrefix(vis),
    params,
    typedParams: rawParams.filter((p) => !/^(&\s*(?:'\w+\s*)?(?:mut\s+)?|mut\s+)?self\b/.test(p)).join(', '),
    ret: ret ? sanitizeType(ret[1]) : '',
    body,
    hasBody,
    isStatic: owner !== null && !hasSelf,
  };
}

/** Walks a region of scrubbed text, collecting items. Inline modules are flattened. */
function scanItems(text: string, start: number, end: number, out: RustItems): void {
  let i = start;
  const skipWs = () => {
    while (i < end && /\s/.test(text[i])) i++;
  };
  while (i < end) {
    skipWs();
    if (i >= end) break;
    // Attributes #[...] / #![...]
    if (text[i] === '#' && (text[i + 1] === '[' || (text[i + 1] === '!' && text[i + 2] === '['))) {
      let d = 0;
      let j = text.indexOf('[', i);
      for (; j < end; j++) {
        if (text[j] === '[') d++;
        else if (text[j] === ']' && --d === 0) break;
      }
      i = j + 1;
      continue;
    }
    const rest = text.slice(i, Math.min(end, i + 400));
    const head =
      /^(pub(?:\s*\([^)]*\))?\s+)?(?:(?:default|unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*(struct|enum|trait|impl|fn|mod|union)\b\s*/.exec(rest);
    if (head) {
      const vis = head[1]?.trim();
      const kind = head[2];
      const afterKw = i + head[0].length;
      // Header runs to the first `{` or `;` at paren/bracket depth 0.
      let j = afterKw;
      let d = 0;
      for (; j < end; j++) {
        const c = text[j];
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') d--;
        else if (d === 0 && (c === '{' || c === ';')) break;
      }
      const header = text.slice(afterKw, j).trim();
      const hasBody = text[j] === '{';
      const bodyEnd = hasBody ? matchBrace(text, j) : j;
      const body = hasBody ? text.slice(j + 1, bodyEnd) : '';
      const bodyStart = j + 1;

      if (kind === 'mod') {
        const name = /^([A-Za-z_]\w*)/.exec(header)?.[1];
        if (name && !hasBody) out.modDecls.push(name);
        else if (hasBody) scanItems(text, bodyStart, bodyEnd, out);
      } else if (kind === 'struct' || kind === 'union') {
        const name = /^([A-Za-z_]\w*)/.exec(header)?.[1];
        if (name) {
          const fields: string[] = [];
          const rawFields: string[] = [];
          if (hasBody) {
            for (const f of splitTopLevel(body.replace(/#\[[^\]]*\]/g, ''), ',')) {
              const fm = /^(pub(?:\s*\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(f.trim());
              if (fm) {
                fields.push(`${visPrefix(fm[1]?.trim())}${fm[2]} ${sanitizeType(fm[3])}`);
                rawFields.push(`${fm[2]}: ${fm[3].trim()}`);
              }
            }
          } else {
            // tuple struct: struct Name(pub T, U);
            const tm = /^[A-Za-z_]\w*(?:<[^>]*>)?\s*\(([\s\S]*)\)/.exec(header);
            if (tm) {
              splitTopLevel(tm[1], ',').forEach((t, idx) => {
                const tv = /^(pub(?:\s*\([^)]*\))?\s+)?([\s\S]+)$/.exec(t.trim());
                if (tv) fields.push(`${visPrefix(tv[1]?.trim())}${idx} ${sanitizeType(tv[2])}`);
              });
            }
          }
          out.structs.push({ name, fields, rawFields });
        }
      } else if (kind === 'enum') {
        const name = /^([A-Za-z_]\w*)/.exec(header)?.[1];
        if (name) {
          const variants = splitTopLevel(body.replace(/#\[[^\]]*\]/g, ''), ',')
            .map((v) => /^([A-Za-z_]\w*)/.exec(v.trim())?.[1])
            .filter((v): v is string => !!v);
          out.enums.push({ name, variants });
        }
      } else if (kind === 'trait') {
        const m = /^([A-Za-z_]\w*)\s*(?:<[^{]*?>)?\s*(?::\s*([^{]+?))?\s*(?:where\b[\s\S]*)?$/.exec(header);
        if (m) {
          const supers = m[2] ? splitTopLevel(m[2], '+').map(baseTypeName).filter((s) => /^[A-Za-z_]\w*$/.test(s) && s !== 'Sized') : [];
          const methods: RustFn[] = [];
          collectMethods(text, bodyStart, bodyEnd, m[1], methods);
          out.traits.push({ name: m[1], supers, methods });
        }
      } else if (kind === 'impl') {
        const h = header.replace(/^<[^>]*(?:<[^>]*>[^>]*)*>\s*/, ''); // drop impl<T: Bound>
        const forM = /^([\s\S]+?)\s+for\s+([\s\S]+?)(?:\s+where\b[\s\S]*)?$/.exec(h);
        const target = forM ? forM[2] : h.replace(/\s+where\b[\s\S]*$/, '');
        const trait = forM ? forM[1] : null;
        const type = baseTypeName(target);
        // `impl Trait for ()`, `for &'static [u8]`, `for [T; N]` have no nominal type to draw a class for.
        if (!/^[A-Za-z_]\w*$/.test(type)) {
          i = hasBody ? bodyEnd + 1 : j + 1;
          continue;
        }
        const methods: RustFn[] = [];
        collectMethods(text, bodyStart, bodyEnd, type, methods);
        out.impls.push({ type, trait: trait ? baseTypeName(trait) : null, methods });
      } else if (kind === 'fn') {
        const fn = parseFn('fn ' + header, body, null, vis, hasBody);
        if (fn) out.fns.push(fn);
      }
      i = hasBody ? bodyEnd + 1 : j + 1;
      continue;
    }
    // Unknown item (use, const, static, type, macro, extern block ...): skip to `;` or a balanced block.
    let d = 0;
    let j = i;
    for (; j < end; j++) {
      const c = text[j];
      if (c === '(' || c === '[') d++;
      else if (c === ')' || c === ']') d--;
      else if (d <= 0 && c === ';') break;
      else if (d <= 0 && c === '{') {
        j = matchBrace(text, j);
        break;
      }
    }
    i = j + 1;
  }
}

function collectMethods(text: string, start: number, end: number, owner: string, out: RustFn[]): void {
  let i = start;
  while (i < end) {
    const rest = text.slice(i, Math.min(end, i + 400));
    const head = /^\s*(?:#\[[^\]]*\]\s*)*(pub(?:\s*\([^)]*\))?\s+)?(?:(?:default|unsafe|async|const|extern(?:\s+"[^"]*")?)\s+)*fn\b/.exec(rest);
    if (head) {
      let j = i + head[0].length;
      let d = 0;
      for (; j < end; j++) {
        const c = text[j];
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') d--;
        else if (d === 0 && (c === '{' || c === ';')) break;
      }
      const header = 'fn' + text.slice(i + head[0].length, j);
      const hasBody = text[j] === '{';
      const bodyEnd = hasBody ? matchBrace(text, j) : j;
      const fn = parseFn(header, hasBody ? text.slice(j + 1, bodyEnd) : '', owner, head[1]?.trim(), hasBody);
      if (fn) out.push(fn);
      i = hasBody ? bodyEnd + 1 : j + 1;
      continue;
    }
    // Skip any other member (assoc types/consts, nested blocks) to the next `;` or `}`.
    let d = 0;
    let j = i;
    for (; j < end; j++) {
      const c = text[j];
      if (c === '{') {
        j = matchBrace(text, j);
        break;
      }
      if (c === '(' || c === '[') d++;
      else if (c === ')' || c === ']') d--;
      else if (d <= 0 && c === ';') break;
    }
    i = j + 1;
  }
}

export function parseRust(source: string): RustItems {
  const text = scrub(source, 'rust');
  const out: RustItems = { structs: [], enums: [], traits: [], impls: [], fns: [], modDecls: [] };
  scanItems(text, 0, text.length, out);
  return out;
}

// ---------- classes ----------

function fnMember(f: RustFn): string {
  return `${f.vis}${f.name}(${f.params})${f.ret ? ' ' + f.ret : ''}${f.isStatic ? '$' : ''}`;
}

export function analyzeRustClasses(files: SourceFileInput[]): { classes: ExtractedClass[]; relationships: ExtractedRelationship[] } {
  const byId = new Map<string, ExtractedClass>();
  const relationships: ExtractedRelationship[] = [];
  const relSeen = new Set<string>();
  const addRel = (r: ExtractedRelationship) => {
    const k = `${r.from}|${r.to}|${r.type}`;
    if (!relSeen.has(k)) {
      relSeen.add(k);
      relationships.push(r);
    }
  };
  const get = (id: string, stereotype: ExtractedClass['stereotype'] = null): ExtractedClass => {
    let c = byId.get(id);
    if (!c) {
      c = { id, stereotype, members: [] };
      byId.set(id, c);
    } else if (stereotype && !c.stereotype) c.stereotype = stereotype;
    return c;
  };

  for (const f of files) {
    const items = parseRust(f.text);
    for (const s of items.structs) {
      const c = get(s.name);
      for (const m of s.fields) if (!c.members.includes(m)) c.members.push(m);
    }
    for (const e of items.enums) {
      const c = get(e.name, 'enumeration');
      for (const v of e.variants) if (!c.members.includes(v)) c.members.push(v);
    }
    for (const t of items.traits) {
      const c = get(t.name, 'interface');
      for (const m of t.methods) c.members.push(fnMember(m));
      for (const sup of t.supers) addRel({ from: t.name, to: sup, type: 'inheritance' });
    }
    for (const im of items.impls) {
      const c = get(im.type);
      if (im.trait) addRel({ from: im.type, to: im.trait, type: 'realization' });
      // Trait-impl methods are implied by the trait; only inherent methods add detail.
      if (!im.trait) for (const m of im.methods) c.members.push(fnMember(m));
    }
  }
  // Fields first, then methods.
  const classes = [...byId.values()].map((c) => ({
    ...c,
    members: [...c.members.filter((m) => !m.includes('(')), ...c.members.filter((m) => m.includes('('))],
  }));
  return { classes, relationships };
}

// ---------- calls ----------

function analyzeCalls(files: SourceFileInput[]): CodeGraph {
  const fns: DeclaredFn[] = [];
  const supers = new Map<string, string[]>();
  const declaredTypes = new Set<string>();
  for (const f of files) {
    const items = parseRust(f.text);
    for (const t of items.traits) declaredTypes.add(t.name);
    const add = (fn: RustFn) =>
      fns.push({
        nodeId: `${f.path}::${fn.owner ? fn.owner + '.' : ''}${fn.name}`,
        label: fn.owner ? `${fn.owner}.${fn.name}` : fn.name,
        shortName: fn.name,
        className: fn.owner,
        body: fn.body,
        kind: fn.owner ? 'method' : 'function',
        params: fn.typedParams,
        returns: fn.ret,
      });
    items.fns.forEach(add);
    for (const im of items.impls) if (im.trait) supers.set(im.type, [...(supers.get(im.type) ?? []), im.trait.replace(/<.*$/, '').split('::').pop()!.trim()]);
    items.impls.forEach((im) => im.methods.filter((m) => m.hasBody).forEach(add));
    items.traits.forEach((t) => t.methods.filter((m) => m.hasBody).forEach(add));
  }
  // Struct fields `repo: Repo` / `repo: Arc<Repo>` give `self.repo.save()` a type.
  const fieldTypes = new Map<string, Map<string, string>>();
  for (const f of files) {
    for (const st of parseRust(f.text).structs) {
      const ft = fieldTypes.get(st.name) ?? new Map<string, string>();
      for (const fld of st.rawFields) {
        const m = /^\s*([A-Za-z_]\w*)\s*:\s*(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?(?:(?:[A-Za-z_]\w*::)*(?:Box|Rc|Arc|RefCell|Mutex|RwLock)\s*<\s*)*(?:dyn\s+|impl\s+)?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)/.exec(fld);
        if (m) ft.set(m[1], m[2]);
      }
      fieldTypes.set(st.name, ft);
    }
  }
  return buildCallGraph(fns, { selfCall: '\\bself\\.([A-Za-z_]\\w*)\\s*\\(', qualifier: '::', bareCallsReachSiblings: false, importedFiles: importedFilesFromGraph(analyzeImports(files)), fieldTypes, supers, declaredTypes });
}

// ---------- imports (mod + use) ----------

/** Expands a `use` tree (`a::{b, c::d}`) into full `::`-joined paths. */
export function expandUseTree(tree: string): string[] {
  const t = tree.trim().replace(/\s+/g, '');
  const brace = t.indexOf('{');
  if (brace < 0) return [t.replace(/::\*$/, '').replace(/as[A-Za-z_]\w*$/, '').replace(/(^|::)self$/, '')];
  const prefix = t.slice(0, brace).replace(/::$/, '');
  let depth = 0;
  let close = -1;
  for (let i = brace; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  const inner = t.slice(brace + 1, close < 0 ? t.length : close);
  const results: string[] = [];
  for (const part of splitTopLevel(inner, ',', false)) {
    for (const sub of expandUseTree(part)) results.push(prefix ? (sub ? `${prefix}::${sub}` : prefix) : sub);
  }
  return results;
}

function crateRootFor(filePath: string, known: Set<string>): string | null {
  let dir = posixPath.dirname(filePath);
  for (;;) {
    for (const r of ['lib.rs', 'main.rs']) {
      const cand = dir === '.' ? r : `${dir}/${r}`;
      if (known.has(cand)) return dir;
    }
    if (dir === '.' || dir === '/' || dir === '') return null;
    dir = posixPath.dirname(dir);
  }
}

/** Directory holding the child modules of `filePath` (src/a.rs → src/a, src/a/mod.rs → src/a, main.rs/lib.rs → src). */
function moduleDirOf(filePath: string): string {
  const base = posixPath.basename(filePath);
  const dir = posixPath.dirname(filePath);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return posixPath.join(dir, base.replace(/\.rs$/, ''));
}

function joinPath(dir: string, name: string, ext: string): string {
  return posixPath.normalize(dir === '.' || dir === '' ? name + ext : `${dir}/${name}${ext}`);
}

function resolveModuleFile(dir: string, segment: string, known: Set<string>): string | null {
  for (const c of [joinPath(dir, segment, '.rs'), joinPath(dir, segment + '/mod', '.rs')]) if (known.has(c)) return c;
  return null;
}

/** The file that defines the module living in `dir` (dir/mod.rs, dir.rs, or the crate root file). */
function moduleFileForDir(dir: string, known: Set<string>): string | null {
  for (const c of [`${dir}/mod.rs`, `${dir}.rs`, `${dir}/lib.rs`, `${dir}/main.rs`]) if (known.has(posixPath.normalize(c))) return posixPath.normalize(c);
  return null;
}

function analyzeImports(files: SourceFileInput[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const nodes = files.map((f) => ({ id: f.path, label: f.path, kind: 'file' }));
  const edges: CodeGraph['edges'] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string | null, kind: string) => {
    if (!to || to === from) return;
    const k = `${from}=>${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind });
  };

  for (const f of files) {
    const text = scrub(f.text, 'rust');
    for (const name of parseRust(f.text).modDecls) add(f.path, resolveModuleFile(moduleDirOf(f.path), name, known), 'mod');

    const root = crateRootFor(f.path, known);
    const useRe = /(?:^|[;{}\s])use\s+([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(text))) {
      for (const full of expandUseTree(m[1])) {
        const segs = full.split('::').filter(Boolean);
        if (!segs.length) continue;
        let dir: string | null = null;
        let rest = segs;
        if (segs[0] === 'crate') {
          dir = root;
          rest = segs.slice(1);
        } else if (segs[0] === 'self') {
          dir = moduleDirOf(f.path);
          rest = segs.slice(1);
        } else if (segs[0] === 'super') {
          dir = posixPath.dirname(moduleDirOf(f.path));
          rest = segs.slice(1);
          while (rest[0] === 'super') {
            dir = posixPath.dirname(dir);
            rest = rest.slice(1);
          }
        } else {
          continue; // external crate or std — not part of the internal graph
        }
        if (dir === null) continue;
        // Walk as deep as files exist; trailing segments are items (types/functions), not modules.
        let cur: string = dir;
        // Paths that stop at an item (use crate::Foo, use super::Bar) point at the module that defines it.
        let target: string | null = moduleFileForDir(dir, known);
        for (const seg of rest) {
          const file = resolveModuleFile(cur, seg, known);
          if (!file) break;
          target = file;
          cur = moduleDirOf(file);
        }
        add(f.path, target, 'use');
      }
    }
  }
  return { nodes, edges };
}

export const rustImportGraphAnalyzer: CodeAnalyzer = {
  id: 'rs-import-graph',
  displayName: 'Module Graph (Rust)',
  supportedExtensions: ['.rs'],
  analyze: analyzeImports,
};

export const rustCallGraphAnalyzer: CodeAnalyzer = {
  id: 'rs-call-graph',
  displayName: 'Call Graph (Rust)',
  supportedExtensions: ['.rs'],
  analyze: analyzeCalls,
};
