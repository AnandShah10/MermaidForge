import { ErAttribute, ErAttributeKey, ErDiagram, ErEntity, ErRelationship, ParseIssue, SourceRange } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/** Parses one attribute line inside an entity body: `<type> <name> [PK|FK|UK] ["comment"]`. Tolerant of lines that don't fully match — falls back to storing the raw text. */
function parseAttributeLine(raw: string): ErAttribute {
  const trimmed = raw.trim();
  const match = /^(\S+)\s+(\S+)(?:\s+(PK|FK|UK))?(?:\s+"([^"]*)")?$/.exec(trimmed);
  if (!match) {
    return { raw: trimmed, type: null, name: null, key: null, comment: null };
  }
  return {
    raw: trimmed,
    type: match[1],
    name: match[2],
    key: (match[3] as ErAttributeKey) ?? null,
    comment: match[4] ?? null,
  };
}

/**
 * Parses `erDiagram` Mermaid source into a structural model: entities (with
 * typed attributes and PK/FK/UK key markers) and relationships (with
 * crow's-foot cardinality tokens on each side, identifying vs. non-identifying
 * line style, and an optional label). Like the other structural parsers,
 * this is a pragmatic line-oriented parser — cardinality tokens are kept as
 * their raw two-character form rather than decoded into named cardinalities,
 * and anything not confidently understood is recorded as a ParseIssue.
 */
export function parseErDiagram(source: string): ErDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const entities = new Map<string, ErEntity>();
  const relationships: ErRelationship[] = [];
  const declarationOrder: ErDiagram['declarationOrder'] = [];
  const comments: ErDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let openEntityId: string | null = null;
  let relationshipCounter = 0;

  function ensureEntity(id: string, lineIdx: number): ErEntity {
    let e = entities.get(id);
    if (!e) {
      e = { id, attributes: [], sourceRange: makeRange(lineIdx, 0, 0) };
      entities.set(id, e);
      declarationOrder.push({ kind: 'entity', id });
    }
    return e;
  }

  // e.g. CUSTOMER ||--o{ ORDER : places   /   LINE-ITEM }|..|{ SHIPMENT : "ships via"
  const relationRegex = /^([A-Za-z0-9_-]+)\s+(\|o|\|\||}o|}\|)(--|\.\.)(o\||o\{|\|\{|\|\||o\|)\s+([A-Za-z0-9_-]+)\s*:\s*"?([^"]*?)"?$/;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^erDiagram\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected an "erDiagram" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    // Inside an entity body.
    if (openEntityId) {
      if (trimmed === '}') {
        openEntityId = null;
        continue;
      }
      entities.get(openEntityId)!.attributes.push(parseAttributeLine(trimmed));
      continue;
    }

    // ENTITY { ... (body opens)
    const bodyOpenMatch = /^([A-Za-z0-9_-]+)\s*\{\s*$/.exec(trimmed);
    if (bodyOpenMatch) {
      const id = bodyOpenMatch[1];
      ensureEntity(id, lineIdx).sourceRange = makeRange(lineIdx, 0, trimmed.length);
      openEntityId = id;
      continue;
    }

    // Relationship line.
    const relMatch = relationRegex.exec(trimmed);
    if (relMatch) {
      const [, fromId, leftCard, lineStyle, rightCard, toId, label] = relMatch;
      ensureEntity(fromId, lineIdx);
      ensureEntity(toId, lineIdx);
      const id = `r${++relationshipCounter}`;
      relationships.push({
        id,
        from: fromId,
        to: toId,
        leftCardinality: leftCard,
        rightCardinality: rightCard,
        identifying: lineStyle === '--',
        label: label.trim() || null,
        sourceRange: makeRange(lineIdx, 0, trimmed.length),
      });
      declarationOrder.push({ kind: 'relationship', id });
      continue;
    }

    // ENTITY (bare declaration, no attributes) — rare but valid.
    const bareMatch = /^([A-Za-z0-9_-]+)$/.exec(trimmed);
    if (bareMatch) {
      ensureEntity(bareMatch[1], lineIdx);
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (openEntityId) {
    parseIssues.push({
      message: `Entity body for "${openEntityId}" was never closed with "}".`,
      severity: 'error',
      range: entities.get(openEntityId)?.sourceRange ?? makeRange(lines.length - 1, 0, 0),
    });
  }
  if (!headerFound) {
    parseIssues.push({ message: 'No "erDiagram" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return {
    kind: 'erDiagram',
    entities,
    relationships,
    declarationOrder,
    comments,
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}
