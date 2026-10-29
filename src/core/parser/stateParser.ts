import { ParseIssue, SourceRange, StateDiagram, StateDiagramNote, StateEntry, StateKind, StateTransition } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

const START_END_TOKEN = '[*]';

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/**
 * Parses `stateDiagram`/`stateDiagram-v2` Mermaid source into a structural
 * model: states (simple, composite, and choice/fork/join pseudostates),
 * transitions, and notes.
 *
 * Two deliberate scope boundaries, both because Mermaid's own semantics here
 * are genuinely more elaborate than a line-oriented parser can cleanly
 * represent without a real grammar:
 *
 *  - The `[*]` pseudostate IS scoped, the way Mermaid scopes it: as a
 *    transition source it is that scope's start, as a target its end, and
 *    each composite state (and each concurrent region of one, separated by a
 *    bare `--` line) has its own pair. Marker ids are `[*start]` / `[*end]`
 *    at the top level and `[*start]@Comp` / `[*end]@Comp` (`@Comp#2` for the
 *    second region, and so on) inside composites. All of them have kind
 *    'startOrEnd' and label `[*]`, and every id starts with `[`.
 *  - Concurrent regions inside a composite state are only modelled to the
 *    extent of giving each region its own `[*]` markers; states and
 *    transitions are still attributed to the composite as a whole, not to a
 *    region.
 */
export function parseStateDiagram(source: string): StateDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const states = new Map<string, StateEntry>();
  const transitions: StateTransition[] = [];
  const notes: StateDiagramNote[] = [];
  const declarationOrder: StateDiagram['declarationOrder'] = [];
  const comments: StateDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  const compositeStack: string[] = [];
  let transitionCounter = 0;
  /** Concurrent-region counter per open composite (index-aligned with compositeStack). */
  const regionStack: number[] = [];
  let inNoteBlock: { target: string | null; lines: string[]; startLine: number } | null = null;

  function currentParent(): string | null {
    return compositeStack.length > 0 ? compositeStack[compositeStack.length - 1] : null;
  }

  /** Scope key for `[*]` markers: '' at the top level, `Comp` / `Comp#2` inside composites and their regions. */
  function currentScope(): string {
    if (compositeStack.length === 0) return '';
    const id = compositeStack[compositeStack.length - 1];
    const region = regionStack[regionStack.length - 1] ?? 1;
    return region > 1 ? `${id}#${region}` : id;
  }

  /** Resolves a transition endpoint: a plain id stays as is, `[*]` becomes this scope's start (as a source) or end (as a target). */
  function resolveEndpoint(raw: string, role: 'from' | 'to'): string {
    if (raw !== START_END_TOKEN) return raw;
    const scope = currentScope();
    return `[*${role === 'from' ? 'start' : 'end'}]${scope ? '@' + scope : ''}`;
  }

  function ensureState(id: string, lineIdx: number, kind: StateKind = 'simple'): StateEntry {
    if (id.startsWith('[*')) {
      let existing = states.get(id);
      if (!existing) {
        existing = { id, label: START_END_TOKEN, kind: 'startOrEnd', parentId: currentParent(), sourceRange: makeRange(lineIdx, 0, 0) };
        states.set(id, existing);
        declarationOrder.push({ kind: 'state', id });
      }
      return existing;
    }
    let s = states.get(id);
    if (!s) {
      s = { id, label: id, kind, parentId: currentParent(), sourceRange: makeRange(lineIdx, 0, 0) };
      states.set(id, s);
      declarationOrder.push({ kind: 'state', id });
    }
    return s;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();

    if (inNoteBlock) {
      if (/^end note$/i.test(trimmed)) {
        notes.push({ target: inNoteBlock.target, text: inNoteBlock.lines.join('\n'), sourceRange: makeRange(inNoteBlock.startLine, 0, trimmed.length) });
        declarationOrder.push({ kind: 'note', id: `note_${notes.length}` });
        inNoteBlock = null;
      } else {
        inNoteBlock.lines.push(rawLine);
      }
      continue;
    }

    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^stateDiagram(-v2)?\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "stateDiagram" or "stateDiagram-v2" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    if (/^direction\s+(TB|TD|BT|LR|RL)$/i.test(trimmed)) {
      continue; // acknowledged, not modeled — doesn't affect the graph itself
    }

    // Bare concurrency separator inside a composite state — see module comment.
    if (trimmed === '--') {
      if (regionStack.length > 0) regionStack[regionStack.length - 1]++;
      continue;
    }

    // Multi-line note: "note left of X" / "note right of X" with no trailing ":" text, closed by "end note".
    const noteBlockOpenMatch = /^note\s+(?:left of|right of)\s+([A-Za-z0-9_]+)\s*$/i.exec(trimmed);
    if (noteBlockOpenMatch) {
      ensureState(noteBlockOpenMatch[1], lineIdx);
      inNoteBlock = { target: noteBlockOpenMatch[1], lines: [], startLine: lineIdx };
      continue;
    }

    // Single-line note: "note left of X : text"
    const noteInlineMatch = /^note\s+(?:left of|right of)\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/i.exec(trimmed);
    if (noteInlineMatch) {
      ensureState(noteInlineMatch[1], lineIdx);
      notes.push({ target: noteInlineMatch[1], text: noteInlineMatch[2], sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'note', id: `note_${notes.length}` });
      continue;
    }

    // Composite state open, plain: "state Foo {"
    const compositeOpenMatch = /^state\s+([A-Za-z0-9_]+)\s*\{\s*$/.exec(trimmed);
    if (compositeOpenMatch) {
      const id = compositeOpenMatch[1];
      const existed = states.has(id);
      const entry = ensureState(id, lineIdx, 'composite');
      entry.kind = 'composite';
      if (existed) entry.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      declarationOrder.push({ kind: 'compositeStart', id });
      compositeStack.push(id);
      regionStack.push(1);
      continue;
    }

    // Composite state open, aliased: 'state "Long Name" as foo {'
    const compositeOpenAliasMatch = /^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_]+)\s*\{\s*$/.exec(trimmed);
    if (compositeOpenAliasMatch) {
      const [, longName, id] = compositeOpenAliasMatch;
      const entry = ensureState(id, lineIdx, 'composite');
      entry.kind = 'composite';
      entry.label = longName;
      entry.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      declarationOrder.push({ kind: 'compositeStart', id });
      compositeStack.push(id);
      regionStack.push(1);
      continue;
    }

    if (trimmed === '}') {
      const closed = compositeStack.pop();
      regionStack.pop();
      if (closed) {
        declarationOrder.push({ kind: 'compositeEnd', id: closed });
      } else {
        parseIssues.push({ message: '"}" with no matching composite state.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    // Pseudostate declaration: "state choice_state <<choice>>"
    const pseudoMatch = /^state\s+([A-Za-z0-9_]+)\s*<<(choice|fork|join)>>\s*$/.exec(trimmed);
    if (pseudoMatch) {
      const entry = ensureState(pseudoMatch[1], lineIdx, pseudoMatch[2] as StateKind);
      entry.kind = pseudoMatch[2] as StateKind;
      entry.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      continue;
    }

    // Aliased simple state, no body: 'state "Long Name" as foo'
    const aliasMatch = /^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_]+)\s*$/.exec(trimmed);
    if (aliasMatch) {
      const entry = ensureState(aliasMatch[2], lineIdx);
      entry.label = aliasMatch[1];
      entry.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      continue;
    }

    // Plain simple state declaration, no body: "state Foo"
    const simpleDeclMatch = /^state\s+([A-Za-z0-9_]+)\s*$/.exec(trimmed);
    if (simpleDeclMatch) {
      const entry = ensureState(simpleDeclMatch[1], lineIdx);
      entry.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      continue;
    }

    // Transition: "A --> B" or "A --> B : label", either side may be "[*]".
    const transitionMatch = /^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)\s*(?::\s*(.*))?$/.exec(trimmed);
    if (transitionMatch) {
      const [, rawFrom, rawTo, label] = transitionMatch;
      const fromRaw = resolveEndpoint(rawFrom, 'from');
      const toRaw = resolveEndpoint(rawTo, 'to');
      ensureState(fromRaw, lineIdx);
      ensureState(toRaw, lineIdx);
      const id = `t${++transitionCounter}`;
      transitions.push({ id, from: fromRaw, to: toRaw, label: label?.trim() || null, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'transition', id });
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (inNoteBlock) {
    parseIssues.push({ message: 'A "note" block was never closed with "end note".', severity: 'error', range: makeRange(inNoteBlock.startLine, 0, 0) });
  }
  if (compositeStack.length > 0) {
    for (const openId of compositeStack) {
      parseIssues.push({
        message: `Composite state "${openId}" was never closed with "}".`,
        severity: 'error',
        range: states.get(openId)?.sourceRange ?? makeRange(lines.length - 1, 0, 0),
      });
    }
  }
  if (!headerFound) {
    parseIssues.push({ message: 'No "stateDiagram" or "stateDiagram-v2" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return {
    kind: 'stateDiagram',
    states,
    transitions,
    notes,
    declarationOrder,
    comments,
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}
