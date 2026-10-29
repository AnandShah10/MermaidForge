import {
  ClassDiagram,
  ClassDiagramNote,
  ClassEntry,
  ClassMember,
  ClassRelationType,
  ClassRelationship,
  ParseIssue,
  SourceRange,
} from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

// Longest-first so e.g. `<|--` is tried before `--`, `..|>` before `..>` before `..`.
const RELATION_TOKENS: Array<[string, ClassRelationType]> = [
  ['<|--', 'inheritance'],
  ['--|>', 'inheritance'],
  ['..|>', 'realization'],
  ['<|..', 'realization'],
  ['*--', 'composition'],
  ['--*', 'composition'],
  ['o--', 'aggregation'],
  ['--o', 'aggregation'],
  ['..>', 'dependency'],
  ['<..', 'dependency'],
  ['-->', 'association'],
  ['<--', 'association'],
  ['--', 'link'],
  ['..', 'dashedLink'],
];

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

function findRelation(text: string): { token: string; type: ClassRelationType; index: number } | null {
  let best: { token: string; type: ClassRelationType; index: number } | null = null;
  for (const [token, type] of RELATION_TOKENS) {
    const idx = text.indexOf(token);
    if (idx === -1) continue;
    if (!best || idx < best.index || (idx === best.index && token.length > best.token.length)) {
      best = { token, type, index: idx };
    }
  }
  return best;
}

function parseMemberLine(raw: string): ClassMember {
  const trimmed = raw.trim();
  const visMatch = /^([+\-#~])\s*/.exec(trimmed);
  const visibility = (visMatch?.[1] as ClassMember['visibility']) ?? null;
  const rest = visMatch ? trimmed.slice(visMatch[0].length) : trimmed;
  return { raw: trimmed, visibility, isMethod: rest.includes('(') };
}

/**
 * Parses `classDiagram` Mermaid source into a structural model: classes
 * (with stereotype and members), relationships (with cardinality/label), and
 * notes. Like the other structural parsers, this is a pragmatic line-oriented
 * parser, not a full grammar — generic type parameters (`~T~`) are kept as
 * part of the id/member text rather than modeled separately, and anything not
 * confidently understood is recorded as a ParseIssue rather than guessed at.
 */
export function parseClassDiagram(source: string): ClassDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const classes = new Map<string, ClassEntry>();
  const relationships: ClassRelationship[] = [];
  const notes: ClassDiagramNote[] = [];
  const declarationOrder: ClassDiagram['declarationOrder'] = [];
  const comments: ClassDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let openClassId: string | null = null;
  let relationshipCounter = 0;

  function ensureClass(id: string, lineIdx: number): ClassEntry {
    let c = classes.get(id);
    if (!c) {
      c = { id, stereotype: null, members: [], sourceRange: makeRange(lineIdx, 0, 0) };
      classes.set(id, c);
      declarationOrder.push({ kind: 'class', id });
    }
    return c;
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
      if (/^classDiagram\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "classDiagram" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    // Inside a "class Foo { ... }" body.
    if (openClassId) {
      if (trimmed === '}') {
        openClassId = null;
        continue;
      }
      const stereotypeMatch = /^<<(.+)>>$/.exec(trimmed);
      const cls = classes.get(openClassId)!;
      if (stereotypeMatch) {
        cls.stereotype = stereotypeMatch[1].trim();
      } else {
        cls.members.push(parseMemberLine(trimmed));
      }
      continue;
    }

    if (/^direction\s+(TB|TD|BT|LR|RL)$/i.test(trimmed)) {
      continue; // acknowledged, not modeled — doesn't affect the graph itself
    }

    // class Foo { ... (body opens; may close on the same or a later line)
    const classBlockMatch = /^class\s+([A-Za-z0-9_~]+)\s*\{\s*$/.exec(trimmed);
    if (classBlockMatch) {
      const id = classBlockMatch[1];
      ensureClass(id, lineIdx).sourceRange = makeRange(lineIdx, 0, trimmed.length);
      openClassId = id;
      continue;
    }

    // class Foo  (no body)
    const classSimpleMatch = /^class\s+([A-Za-z0-9_~]+)\s*$/.exec(trimmed);
    if (classSimpleMatch) {
      const id = classSimpleMatch[1];
      const existed = classes.has(id);
      const cls = ensureClass(id, lineIdx);
      if (existed) cls.sourceRange = makeRange(lineIdx, 0, trimmed.length);
      continue;
    }

    // class Foo["Display Label"]  — rare but seen; treat as a plain declaration, label not modeled separately.
    const classLabeledMatch = /^class\s+([A-Za-z0-9_~]+)\s*\[.*\]\s*$/.exec(trimmed);
    if (classLabeledMatch) {
      ensureClass(classLabeledMatch[1], lineIdx);
      continue;
    }

    // <<stereotype>> ClassName   (alternate stereotype syntax)
    const inlineStereotypeMatch = /^<<(.+)>>\s+([A-Za-z0-9_~]+)$/.exec(trimmed);
    if (inlineStereotypeMatch) {
      const cls = ensureClass(inlineStereotypeMatch[2], lineIdx);
      cls.stereotype = inlineStereotypeMatch[1].trim();
      continue;
    }

    // Member addition outside a body: "ClassName : +method()"
    const memberAddMatch = /^([A-Za-z0-9_~]+)\s*:\s*(.+)$/.exec(trimmed);
    if (memberAddMatch && !findRelation(trimmed)) {
      const cls = ensureClass(memberAddMatch[1], lineIdx);
      cls.members.push(parseMemberLine(memberAddMatch[2]));
      continue;
    }

    // note "text"  /  note for ClassName "text"
    const noteMatch = /^note\s+(?:for\s+([A-Za-z0-9_~]+)\s+)?"([^"]*)"$/i.exec(trimmed);
    if (noteMatch) {
      if (noteMatch[1]) ensureClass(noteMatch[1], lineIdx);
      notes.push({ target: noteMatch[1] ?? null, text: noteMatch[2], sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      declarationOrder.push({ kind: 'note', id: `note_${notes.length}` });
      continue;
    }

    // Relationship: ClassA "1" <|-- "many" ClassB : label
    const relation = findRelation(trimmed);
    if (relation) {
      const before = trimmed.slice(0, relation.index).trim();
      const after = trimmed.slice(relation.index + relation.token.length).trim();

      const beforeMatch = /^([A-Za-z0-9_~]+)\s*(?:"([^"]*)")?$/.exec(before);
      const colonIdx = after.indexOf(':');
      const afterMain = (colonIdx === -1 ? after : after.slice(0, colonIdx)).trim();
      const label = colonIdx === -1 ? null : after.slice(colonIdx + 1).trim();
      const afterMatch = /^(?:"([^"]*)")?\s*([A-Za-z0-9_~]+)$/.exec(afterMain);

      if (!beforeMatch || !afterMatch) {
        parseIssues.push({ message: `Could not parse relationship in: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }

      const fromId = beforeMatch[1];
      const fromCardinality = beforeMatch[2] ?? null;
      const toCardinality = afterMatch[1] ?? null;
      const toId = afterMatch[2];

      ensureClass(fromId, lineIdx);
      ensureClass(toId, lineIdx);

      const id = `r${++relationshipCounter}`;
      relationships.push({
        id,
        from: fromId,
        to: toId,
        type: relation.type,
        fromCardinality,
        toCardinality,
        label,
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      });
      declarationOrder.push({ kind: 'relationship', id });
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (openClassId) {
    parseIssues.push({
      message: `Class body for "${openClassId}" was never closed with "}".`,
      severity: 'error',
      range: classes.get(openClassId)?.sourceRange ?? makeRange(lines.length - 1, 0, 0),
    });
  }
  if (!headerFound) {
    parseIssues.push({ message: 'No "classDiagram" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return {
    kind: 'classDiagram',
    classes,
    relationships,
    notes,
    declarationOrder,
    comments,
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}
