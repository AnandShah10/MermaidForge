import { PacketDiagram, PacketField, ParseIssue } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, stripComment, unquote } from './parserUtils';

/**
 * Parses `packet` / `packet-beta`:
 *   title text
 *   0-15: "Source Port"     bit range
 *   106: "URG"              single bit
 *   +8: "Flags"             N bits starting right after the previous field
 * Overlaps and gaps are NOT parse errors (see the linter). A range whose end
 * is below its start is reported and skipped.
 */
export function parsePacketDiagram(source: string): PacketDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: PacketDiagram['comments'] = [];
  const fields: PacketField[] = [];
  let title: string | null = null;
  let headerFound = false;
  let nextBit = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      if (/^packet(-beta)?\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "packet-beta" header before diagram content.', severity: 'error', range });
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/i.exec(trimmed))) {
      title = unquote(m[1]);
    } else if ((m = /^(\+)?(\d+)(?:\s*-\s*(\d+))?\s*:\s*(.*)$/.exec(trimmed))) {
      const label = unquote(m[4]);
      let start: number;
      let end: number;
      if (m[1]) {
        const count = Number(m[2]);
        if (count < 1) {
          parseIssues.push({ message: `"+${m[2]}" must add at least one bit.`, severity: 'error', range });
          continue;
        }
        start = nextBit;
        end = nextBit + count - 1;
      } else {
        start = Number(m[2]);
        end = m[3] !== undefined ? Number(m[3]) : start;
      }
      if (end < start) {
        parseIssues.push({ message: `Bit range ${start}-${end} ends before it starts.`, severity: 'error', range });
        continue;
      }
      if (!label) parseIssues.push({ message: `Field ${start}-${end} has no label.`, severity: 'warning', range });
      fields.push({ start, end, label, sourceRange: range });
      nextBit = end + 1;
    } else {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
    }
  }

  if (!headerFound) parseIssues.push({ message: 'No "packet-beta" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'packet', title, fields, comments, frontmatter, parseIssues, sourceText: source };
}
