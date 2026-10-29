import {
  ParseIssue,
  SequenceArrow,
  SequenceBlock,
  SequenceBlockKind,
  SequenceDiagram,
  SequenceNote,
  SequenceNotePosition,
  SequenceParticipant,
  SourceRange,
} from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

// Longest-first so e.g. `-->>` is tried before `->>` before `-->` before `->`.
const ARROW_TOKENS: SequenceArrow[] = ['-->>', '->>', '--x', '-x', '--)', '-)', '-->', '->'];

const BLOCK_START_KEYWORDS: SequenceBlockKind[] = ['loop', 'alt', 'opt', 'par', 'critical', 'rect', 'break'];
// "else" (alt), "and" (par), "option" (critical) are separators inside an
// already-open block, not new nesting levels — we skip over them rather than
// modeling branches, since our goal here is a usable participant/message
// graph for linting, not a full branch-aware AST.
const BLOCK_SEPARATOR_KEYWORDS = ['else', 'and', 'option'];

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

function findArrow(text: string): { token: SequenceArrow; index: number } | null {
  let best: { token: SequenceArrow; index: number } | null = null;
  for (const token of ARROW_TOKENS) {
    const idx = text.indexOf(token);
    if (idx === -1) continue;
    if (!best || idx < best.index || (idx === best.index && token.length > best.token.length)) {
      best = { token, index: idx };
    }
  }
  return best;
}

/**
 * Parses `sequenceDiagram` Mermaid source into a structural model:
 * participants/actors, messages (with arrow style), notes, and block
 * boundaries (loop/alt/opt/par/critical/rect/break). Like the flowchart
 * parser, this is a pragmatic line-oriented parser, not a full grammar —
 * `else`/`and`/`option` separators inside a block are recognized (so `end`
 * matching stays correct) but not modeled as separate branches; anything not
 * confidently understood is recorded as a ParseIssue rather than guessed at.
 */
export function parseSequenceDiagram(source: string): SequenceDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const participants = new Map<string, SequenceParticipant>();
  const messages: SequenceDiagram['messages'] = [];
  const notes: SequenceNote[] = [];
  const blocks = new Map<string, SequenceBlock>();
  const declarationOrder: SequenceDiagram['declarationOrder'] = [];
  const comments: SequenceDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  const blockStack: string[] = [];
  let anonBlockCounter = 0;
  let messageCounter = 0;

  function ensureParticipant(id: string, lineIdx: number): SequenceParticipant {
    let p = participants.get(id);
    if (!p) {
      p = { id, label: id, kind: 'participant', sourceRange: makeRange(lineIdx, 0, 0) };
      participants.set(id, p);
      declarationOrder.push({ kind: 'participant', id });
    }
    return p;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^sequenceDiagram\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "sequenceDiagram" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    // participant / actor declaration, optionally aliased: "participant F as Foo Bar"
    const participantMatch = /^(participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i.exec(trimmed);
    if (participantMatch) {
      const id = participantMatch[2];
      const existing = participants.get(id);
      if (existing) {
        parseIssues.push({ message: `Participant "${id}" is declared more than once.`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      const p: SequenceParticipant = {
        id,
        label: participantMatch[3]?.trim() || id,
        kind: participantMatch[1].toLowerCase() === 'actor' ? 'actor' : 'participant',
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      };
      participants.set(id, p);
      if (!existing) declarationOrder.push({ kind: 'participant', id });
      continue;
    }

    // activate / deactivate — parsed and ignored structurally (no dedicated
    // model field yet); still consumes the line so it isn't reported as
    // "unrecognized".
    if (/^(activate|deactivate)\s+[A-Za-z0-9_]+$/i.exec(trimmed)) {
      continue;
    }

    // Note left of/right of/over A[,B]: text
    const noteMatch = /^[Nn]ote\s+(left of|right of|over)\s+([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)?)\s*:\s*(.*)$/.exec(trimmed);
    if (noteMatch) {
      const position = noteMatch[1] as SequenceNotePosition;
      const parts = noteMatch[2].split(',').map((s) => s.trim());
      for (const id of parts) ensureParticipant(id, lineIdx);
      notes.push({ position, participants: parts, text: noteMatch[3], sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'note', id: `note_${notes.length}` });
      continue;
    }

    // Block start: loop/alt/opt/par/critical/rect/break [label]
    const blockStartMatch = new RegExp(`^(${BLOCK_START_KEYWORDS.join('|')})\\b\\s*(.*)$`, 'i').exec(trimmed);
    if (blockStartMatch) {
      const kind = blockStartMatch[1].toLowerCase() as SequenceBlockKind;
      const label = blockStartMatch[2].trim();
      const id = `${kind}_${++anonBlockCounter}`;
      blocks.set(id, { id, kind, label, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'blockStart', id });
      blockStack.push(id);
      continue;
    }

    // Block separators (else/and/option) — stay inside the current block.
    if (new RegExp(`^(${BLOCK_SEPARATOR_KEYWORDS.join('|')})\\b`, 'i').test(trimmed)) {
      if (blockStack.length === 0) {
        parseIssues.push({ message: `"${trimmed.split(/\s+/)[0]}" used outside of a loop/alt/opt/par/critical block.`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    if (/^end$/i.test(trimmed)) {
      const closed = blockStack.pop();
      if (closed) {
        declarationOrder.push({ kind: 'blockEnd', id: closed });
      } else {
        parseIssues.push({ message: '"end" with no matching block (loop/alt/opt/par/critical/rect/break).', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    // Message: A->>B: text  (arrow token search handles all supported styles)
    const colonIdx = trimmed.indexOf(':');
    const arrowSearchText = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
    const arrowHit = findArrow(arrowSearchText);
    if (arrowHit) {
      const fromRaw = trimmed.slice(0, arrowHit.index).trim();
      const afterArrow = trimmed.slice(arrowHit.index + arrowHit.token.length);
      const colonIdx2 = afterArrow.indexOf(':');
      const toRaw = (colonIdx2 === -1 ? afterArrow : afterArrow.slice(0, colonIdx2)).trim();
      const text = colonIdx2 === -1 ? '' : afterArrow.slice(colonIdx2 + 1).trim();

      const fromMatch = /^[A-Za-z0-9_]+$/.exec(fromRaw);
      const toMatch = /^[A-Za-z0-9_]+$/.exec(toRaw);
      if (!fromMatch || !toMatch) {
        parseIssues.push({ message: `Could not parse message participants in: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      ensureParticipant(fromRaw, lineIdx);
      ensureParticipant(toRaw, lineIdx);
      const id = `m${++messageCounter}`;
      messages.push({ id, from: fromRaw, to: toRaw, text, arrow: arrowHit.token, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'message', id });
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (blockStack.length > 0) {
    for (const openId of blockStack) {
      const block = blocks.get(openId);
      parseIssues.push({
        message: `Block "${block?.kind ?? openId}" was never closed with "end".`,
        severity: 'error',
        range: block?.sourceRange ?? makeRange(lines.length - 1, 0, 0),
      });
    }
  }
  if (!headerFound) {
    parseIssues.push({ message: 'No "sequenceDiagram" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return {
    kind: 'sequenceDiagram',
    participants,
    messages,
    notes,
    blocks,
    declarationOrder,
    comments,
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}
