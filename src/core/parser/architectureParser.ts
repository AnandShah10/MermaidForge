import { ArchitectureDiagram, ArchitectureEdge, ArchitectureNode, ArchitectureSide, ParseIssue } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, stripComment } from './parserUtils';

/**
 * Parses `architecture-beta`:
 *   group api(cloud)[API]
 *   service db(database)[Database] in api
 *   junction j1 in api
 *   db:L -- R:server              (sides: L R T B)
 *   db{group}:B --> T:server{group}
 *   a:R <--> L:b                  (arrowheads on either end)
 * Icon and label are optional. Ids are `[A-Za-z0-9_-]+`. Not modelled:
 * custom icon packs. References are NOT resolved here (the
 * linter does that), so a typo'd id still parses.
 */
const ID = '[A-Za-z0-9_-]+';
const DECL = new RegExp(`^(group|service)\\s+(${ID})(?:\\s*\\(([^)]*)\\))?(?:\\s*\\[([^\\]]*)\\])?(?:\\s+in\\s+(${ID}))?\\s*$`);
const JUNCTION = new RegExp(`^junction\\s+(${ID})(?:\\s+in\\s+(${ID}))?\\s*$`);
const EDGE = new RegExp(`^(${ID})(\\{group\\})?:([LRTB])\\s*(<)?(?:--|-\\[([^\\]]*)\\]-)(>)?\\s*([LRTB]):(${ID})(\\{group\\})?\\s*$`);

export function parseArchitectureDiagram(source: string): ArchitectureDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: ArchitectureDiagram['comments'] = [];
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      if (/^architecture(-beta)?\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected an "architecture-beta" header before diagram content.', severity: 'error', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = DECL.exec(trimmed))) {
      nodes.push({ type: m[1] as 'group' | 'service', id: m[2], icon: m[3]?.trim() || null, label: m[4]?.trim() ?? null, parent: m[5] ?? null, sourceRange: range });
    } else if ((m = JUNCTION.exec(trimmed))) {
      nodes.push({ type: 'junction', id: m[1], icon: null, label: null, parent: m[2] ?? null, sourceRange: range });
    } else if ((m = EDGE.exec(trimmed))) {
      edges.push({
        source: m[1],
        sourceGroup: !!m[2],
        sourceSide: m[3] as ArchitectureSide,
        arrowSource: !!m[4],
        label: m[5] !== undefined ? m[5].trim() || null : null,
        arrowTarget: !!m[6],
        targetSide: m[7] as ArchitectureSide,
        target: m[8],
        targetGroup: !!m[9],
        sourceRange: range,
      });
    } else if (/--/.test(trimmed) && /:/.test(trimmed)) {
      parseIssues.push({ message: `Malformed edge "${trimmed}" — expected "id:SIDE -- SIDE:id" with SIDE one of L, R, T, B.`, severity: 'error', range });
    } else {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
    }
  }

  if (!headerFound) parseIssues.push({ message: 'No "architecture-beta" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'architecture', nodes, edges, comments, frontmatter, parseIssues, sourceText: source };
}
