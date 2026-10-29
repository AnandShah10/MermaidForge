import { ParseIssue, RequirementDiagram, RequirementElement, RequirementItem, RequirementKind, RequirementRelation } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, stripComment, unquote } from './parserUtils';
import { emptyStyling, parseStylingLine } from './styling';

/**
 * Parses `requirementDiagram`: requirement blocks of the six kinds
 * (`requirement`, `functionalRequirement`, `interfaceRequirement`,
 * `performanceRequirement`, `physicalRequirement`, `designConstraint`) with
 * `id` / `text` / `risk` / `verifymethod` fields, `element` blocks with
 * `type` / `docref`, and relationships in either direction:
 *   a - satisfies -> b        (source a, target b)
 *   b <- satisfies - a        (normalised to source a, target b)
 * Names and values may be double-quoted. Field VALUES are not validated here
 * (the linter checks risk / verifymethod / relation type), so unusual values
 * still parse. Styling statements (`classDef`, `class`, `style`, and the
 * `name:::cls` header shorthand) are modelled in `styling` with the CSS kept
 * as raw text, so the linter can check their references; `direction` is
 * acknowledged and ignored.
 * Blocks must open with `{` on the same line as the header and close with a
 * `}` on its own line; a block left open at end of input is reported.
 */
const REQ_KINDS: ReadonlySet<string> = new Set(['requirement', 'functionalRequirement', 'interfaceRequirement', 'performanceRequirement', 'physicalRequirement', 'designConstraint']);
const NAME = '("[^"]+"|[^\\s{}":]+(?::(?!::)[^\\s{}":]*)*)'; // may contain single colons, never the ":::" class shorthand
const BLOCK_START = new RegExp(`^(requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element)\\s+${NAME}((?::::[\\w-]+)*)\\s*\\{\\s*$`);
const REL_FWD = new RegExp(`^${NAME}\\s+-\\s+([A-Za-z]+)\\s+->\\s+${NAME}$`);
const REL_BACK = new RegExp(`^${NAME}\\s+<-\\s+([A-Za-z]+)\\s+-\\s+${NAME}$`);

export function parseRequirementDiagram(source: string): RequirementDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: RequirementDiagram['comments'] = [];
  const requirements: RequirementItem[] = [];
  const elements: RequirementElement[] = [];
  const relations: RequirementRelation[] = [];
  const styling = emptyStyling();
  let headerFound = false;
  let open: { type: 'req'; item: RequirementItem; line: number } | { type: 'el'; item: RequirementElement; line: number } | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      if (/^requirementDiagram\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "requirementDiagram" header before diagram content.', severity: 'error', range });
      continue;
    }

    if (open) {
      if (trimmed === '}') {
        open = null;
        continue;
      }
      const f = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!f) {
        parseIssues.push({ message: `Unrecognized line inside "${open.item.name}": "${trimmed}"`, severity: 'warning', range });
        continue;
      }
      const key = f[1].toLowerCase();
      const value = unquote(f[2]);
      if (open.type === 'req') {
        if (key === 'id') open.item.id = value;
        else if (key === 'text') open.item.text = value;
        else if (key === 'risk') open.item.risk = value;
        else if (key === 'verifymethod') open.item.verifyMethod = value;
        else parseIssues.push({ message: `Unknown requirement field "${f[1]}".`, severity: 'warning', range });
      } else if (key === 'type') open.item.type = value;
      else if (key === 'docref') open.item.docref = value;
      else parseIssues.push({ message: `Unknown element field "${f[1]}".`, severity: 'warning', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = BLOCK_START.exec(trimmed))) {
      const name = unquote(m[2]);
      const classes = m[3] ? m[3].split(':::').filter(Boolean) : [];
      if (m[1] === 'element') {
        const item: RequirementElement = { name, type: null, docref: null, classes, sourceRange: range };
        elements.push(item);
        open = { type: 'el', item, line: lineIdx };
      } else {
        const item: RequirementItem = { kind: m[1] as RequirementKind, name, id: null, text: null, risk: null, verifyMethod: null, classes, sourceRange: range };
        requirements.push(item);
        open = { type: 'req', item, line: lineIdx };
      }
    } else if ((m = REL_FWD.exec(trimmed))) {
      relations.push({ source: unquote(m[1]), target: unquote(m[3]), type: m[2], sourceRange: range });
    } else if ((m = REL_BACK.exec(trimmed))) {
      relations.push({ source: unquote(m[3]), target: unquote(m[1]), type: m[2], sourceRange: range });
    } else if (parseStylingLine(trimmed, range, styling)) {
      continue;
    } else if (/^direction\b/.test(trimmed)) {
      continue; // layout-only — acknowledged, not modelled
    } else if (REQ_KINDS.has(trimmed.split(/\s+/)[0]) || trimmed.startsWith('element')) {
      parseIssues.push({ message: `Block header must be "<kind> <name> {" on one line: "${trimmed}"`, severity: 'error', range });
    } else {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
    }
  }

  if (open) parseIssues.push({ message: `Block "${open.item.name}" is never closed with "}".`, severity: 'error', range: makeRange(open.line, 0, lines[open.line]?.length ?? 0) });
  if (!headerFound) parseIssues.push({ message: 'No "requirementDiagram" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'requirementDiagram', requirements, elements, relations, styling, comments, frontmatter, parseIssues, sourceText: source };
}
