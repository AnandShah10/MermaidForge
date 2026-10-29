/**
 * Label-aware identifier rename for text-based Mermaid diagrams.
 *
 * Replaces whole-token occurrences of an id while leaving label text alone.
 * What counts as "label text" depends on the diagram kind:
 *
 *  - everywhere: `"quoted strings"` and `%%` comments are never touched;
 *  - flowchart: the contents of `[..]`, `(..)`, `{..}` shapes and `|edge labels|`;
 *  - class / ER / state / sequence: everything after the first `:` on a line
 *    (relationship labels, member text, messages, notes) and, for sequence,
 *    after `as` in `participant X as Label`; class and ER also skip the lines
 *    of a `Name { ... }` member/attribute body.
 *
 * Boundary rule: an id may contain letters, digits, `_` and `-`, but a `-`
 * (or `=`/`.`/`>`) that starts or ends an arrow is NOT part of the id, so
 * `A-->B`, `A---B` and `A->>B` all rename correctly. An id that itself ends
 * in `-` followed by an arrow character cannot be told apart from an arrow;
 * such ids are unsupported.
 *
 * Flowchart edge text written inline (`A -- text --> B`, `A == text ==> B`,
 * `A -. text .-> B`) and `id>asymmetric]` shape text are recognised as labels.
 * Inline edge text is only recognised in its spaced form (`-- text -->`); the
 * unspaced `A--text-->B` cannot be told from ids and arrows, so an id equal to
 * a word inside it would be renamed too. The caller should show the
 * preview/undo the editor already provides. Cross-diagram references (`click`,
 * links) are only handled where noted.
 */
export type RenameKind = 'flowchart' | 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'sequenceDiagram';

const ID_CHAR = /[A-Za-z0-9_]/;

function boundaryBefore(s: string, i: number): boolean {
  const p = s[i - 1];
  if (p === undefined) return true;
  if (ID_CHAR.test(p)) return false;
  if (p === '-') return s[i - 2] === '-' || s[i - 2] === '=' || s[i - 2] === '.' || s[i - 2] === '>' || s[i - 2] === '<' || (s[i - 2] !== undefined && !ID_CHAR.test(s[i - 2]));
  return true;
}

function boundaryAfter(s: string, end: number): boolean {
  const n = s[end];
  if (n === undefined) return true;
  if (ID_CHAR.test(n)) return false;
  if (n === '-') {
    const n2 = s[end + 1];
    return n2 === '-' || n2 === '>' || n2 === '.' || n2 === '=' || n2 === 'x' || n2 === ')' || n2 === undefined || /\s/.test(n2);
  }
  return true;
}

function closerFor(c: string): string {
  return c === '[' ? ']' : c === '(' ? ')' : '}';
}

/** Index just past the bracket group opening at s[i], honouring quotes; s.length if unclosed. */
function skipGroup(s: string, i: number): number {
  const stack: string[] = [];
  let q = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') q = !q;
    if (q) continue;
    if ('[({'.includes(c)) stack.push(closerFor(c));
    else if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return j + 1;
    }
  }
  return s.length;
}

/** Opening of inline flowchart edge text: `-- `, `== ` or `-. ` followed by a non-arrow character. */
const EDGE_TEXT_OPEN = /^(--|==|-\.)\s+(?![-=.>xo]{1,3}(?:\s|$))\S/;

/** Index of the `]` that closes an asymmetric shape's text starting at `from`, honouring quotes; -1 if none. */
function closingBracket(s: string, from: number): number {
  let q = false;
  for (let j = from; j < s.length; j++) {
    if (s[j] === '"') q = !q;
    else if (!q && s[j] === ']') return j;
  }
  return -1;
}

interface LineOptions {
  skipBrackets: boolean;
  skipPipes: boolean;
  stopAtColon: boolean;
  stopAtAs: boolean;
}

/** Replaces id tokens in a single line; returns the new line and how many replacements were made. */
export function renameInLine(line: string, oldId: string, newId: string, o: LineOptions): { text: string; count: number } {
  let out = '';
  let count = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '%' && line[i + 1] === '%') {
      out += line.slice(i);
      break;
    }
    if (c === '"') {
      const end = line.indexOf('"', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    if (o.stopAtColon && c === ':' && line[i + 1] !== ':') {
      out += line.slice(i);
      break;
    }
    if (o.skipBrackets && '[({'.includes(c)) {
      const stop = skipGroup(line, i);
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    if (o.skipBrackets && c === '>' && i > 0 && ID_CHAR.test(line[i - 1])) {
      // `id>asymmetric text]` — the text runs to the closing `]`.
      const end = closingBracket(line, i + 1);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (o.skipPipes && (c === '-' || c === '=') && (i === 0 || /\s/.test(line[i - 1]))) {
      // Inline edge text: `-- text -->`, `== text ==>`, `-. text .->`.
      const m = EDGE_TEXT_OPEN.exec(line.slice(i));
      if (m) {
        const close = (m[1] === '--' ? /\s(?:-->|---|--x|--o)/ : m[1] === '==' ? /\s(?:==>|===)/ : /\s(?:\.->|\.-)/).exec(line.slice(i + m[0].length - 1));
        if (close) {
          const stop = i + m[0].length - 1 + close.index + 1;
          out += line.slice(i, stop);
          i = stop;
          continue;
        }
      }
    }
    if (o.skipPipes && c === '|') {
      const end = line.indexOf('|', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    if (o.stopAtAs && /\s/.test(c) && /^\s+as\s/.test(line.slice(i))) {
      out += line.slice(i);
      break;
    }
    if (line.startsWith(oldId, i) && boundaryBefore(line, i) && boundaryAfter(line, i + oldId.length)) {
      out += newId;
      count++;
      i += oldId.length;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, count };
}

const MEMBER_BODY_OPEN = /^\s*(?:class\s+)?[A-Za-z0-9_.-]+(?:~[^~]*~)?\s*(?:"[^"]*"\s*)?\{\s*$/;

export function renameIdentifierInSource(source: string, kind: RenameKind, oldId: string, newId: string): { text: string; count: number } {
  const lines = source.split('\n');
  const opts: LineOptions =
    kind === 'flowchart'
      ? { skipBrackets: true, skipPipes: true, stopAtColon: false, stopAtAs: false }
      : { skipBrackets: false, skipPipes: false, stopAtColon: true, stopAtAs: kind === 'sequenceDiagram' };
  let total = 0;
  let inBody = false;
  // Frontmatter (--- ... ---) and the diagram header line are never rewritten.
  let protectedUntil = -1;
  let k = 0;
  while (k < lines.length && lines[k].trim() === '') k++;
  if (lines[k]?.trim() === '---') {
    let e = k + 1;
    while (e < lines.length && lines[e].trim() !== '---') e++;
    protectedUntil = e;
    k = e + 1;
  }
  while (k < lines.length && (lines[k].trim() === '' || lines[k].trim().startsWith('%%'))) k++;
  protectedUntil = Math.max(protectedUntil, k);
  const result = lines.map((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    const cr = raw.endsWith('\r') ? '\r' : '';
    if (idx <= protectedUntil) return raw;
    const trimmed = line.trim();
    if (inBody) {
      if (trimmed === '}') inBody = false;
      return raw;
    }
    if ((kind === 'classDiagram' || kind === 'erDiagram') && /^\s*namespace\b/.test(line) === false && MEMBER_BODY_OPEN.test(line)) {
      const r = renameInLine(line.replace(/\{\s*$/, ''), oldId, newId, opts);
      total += r.count;
      inBody = true;
      return r.text + line.slice(line.replace(/\{\s*$/, '').length) + cr;
    }
    if (kind === 'classDiagram' && /^\s*cssClass\s+"/.test(line)) {
      // cssClass "A,B" styleName : the quoted list holds class ids.
      const replaced = line.replace(/^(\s*cssClass\s+")([^"]*)(")/, (_m, a: string, ids: string, b: string) => {
        const list = ids.split(',').map((x) => {
          if (x.trim() === oldId) {
            total++;
            return x.replace(oldId, newId);
          }
          return x;
        });
        return a + list.join(',') + b;
      });
      return replaced + cr;
    }
    const r = renameInLine(line, oldId, newId, opts);
    total += r.count;
    return r.text + cr;
  });
  return { text: result.join('\n'), count: total };
}


/**
 * Removes every line that refers to `id` outside label text (declarations,
 * member lines, notes, relationships), plus the `{ ... }` body of a
 * declaration that has one. `cssClass "A,B" x` lines are edited instead of
 * dropped so other classes keep their style. Returns the new text and the
 * number of lines removed. Callers must only use this for ids that are
 * already known to have no relationships.
 */
export function removeIdentifierLines(source: string, kind: RenameKind, id: string): { text: string; removed: number } {
  const lines = source.split('\n');
  const opts: LineOptions =
    kind === 'flowchart'
      ? { skipBrackets: true, skipPipes: true, stopAtColon: false, stopAtAs: false }
      : { skipBrackets: false, skipPipes: false, stopAtColon: true, stopAtAs: kind === 'sequenceDiagram' };
  const SENTINEL = '\u0001';
  const drop = new Set<number>();
  const edited = new Map<number, string>();
  let protectedUntil = -1;
  let k = 0;
  while (k < lines.length && lines[k].trim() === '') k++;
  if (lines[k]?.trim() === '---') {
    let e = k + 1;
    while (e < lines.length && lines[e].trim() !== '---') e++;
    protectedUntil = e;
    k = e + 1;
  }
  while (k < lines.length && (lines[k].trim() === '' || lines[k].trim().startsWith('%%'))) k++;
  protectedUntil = Math.max(protectedUntil, k);

  let inBody = false;
  for (let idx = protectedUntil + 1; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\r$/, '');
    if (inBody) {
      if (line.trim() === '}') inBody = false;
      continue;
    }
    const opensBody = (kind === 'classDiagram' || kind === 'erDiagram') && !/^\s*namespace\b/.test(line) && MEMBER_BODY_OPEN.test(line);
    if (kind === 'classDiagram' && /^\s*cssClass\s+"/.test(line)) {
      const m = /^(\s*cssClass\s+")([^"]*)(".*)$/.exec(line);
      if (m) {
        const ids = m[2].split(',');
        if (ids.some((x) => x.trim() === id)) {
          const rest = ids.filter((x) => x.trim() !== id);
          if (rest.length === 0) drop.add(idx);
          else edited.set(idx, m[1] + rest.join(',') + m[3]);
        }
      }
      continue;
    }
    const head = opensBody ? line.replace(/\{\s*$/, '') : line;
    if (renameInLine(head, id, SENTINEL, opts).count > 0) {
      drop.add(idx);
      if (opensBody) {
        let j = idx + 1;
        while (j < lines.length && lines[j].trim() !== '}') drop.add(j++);
        if (j < lines.length) drop.add(j);
        idx = j;
      }
    }
  }
  const out = lines.flatMap((l, i) => (drop.has(i) ? [] : [edited.get(i) ?? l]));
  return { text: out.join('\n'), removed: drop.size };
}
