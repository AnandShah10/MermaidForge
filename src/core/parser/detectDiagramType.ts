import { DiagramKind } from '../diagram/types';

const HEADER_PATTERNS: Array<[RegExp, DiagramKind]> = [
  [/^\s*(graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i, 'flowchart'],
  [/^\s*(graph|flowchart)\b/i, 'flowchart'], // direction on next-ish token or omitted
  [/^\s*sequenceDiagram\b/i, 'sequenceDiagram'],
  [/^\s*classDiagram\b/i, 'classDiagram'],
  [/^\s*stateDiagram(-v2)?\b/i, 'stateDiagram'],
  [/^\s*erDiagram\b/i, 'erDiagram'],
  [/^\s*journey\b/i, 'journey'],
  [/^\s*gantt\b/i, 'gantt'],
  [/^\s*pie\b/i, 'pie'],
  [/^\s*mindmap\b/i, 'mindmap'],
  [/^\s*timeline\b/i, 'timeline'],
  [/^\s*gitGraph\b/i, 'gitGraph'],
  [/^\s*quadrantChart\b/i, 'quadrantChart'],
  [/^\s*requirementDiagram\b/i, 'requirementDiagram'],
  [/^\s*C4(Context|Container|Component|Dynamic|Deployment)?\b/i, 'c4'],
  [/^\s*architecture(-beta)?\b/i, 'architecture'],
  [/^\s*block(-beta)?\b/i, 'block'],
  [/^\s*packet(-beta)?\b/i, 'packet'],
  [/^\s*sankey(-beta)?\b/i, 'sankey'],
  [/^\s*xychart(-beta)?\b/i, 'xychart'],
];

/**
 * Strips a leading YAML frontmatter block (--- ... ---) used for Mermaid
 * config, and returns it separately so callers can preserve it verbatim.
 */
export function extractFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) {
    return { frontmatter: null, body: source };
  }
  return { frontmatter: match[0].replace(/\r?\n$/, ''), body: source.slice(match[0].length) };
}

export function detectDiagramType(source: string): DiagramKind {
  const { body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  let inDirective = false; // a multi-line `%%{ ... }%%` directive: its inner lines are not the header
  for (const rawLine of lines) {
    if (inDirective) {
      if (rawLine.includes('}%%')) inDirective = false;
      continue;
    }
    if (/^\s*%%\{/.test(rawLine) && !rawLine.includes('}%%')) {
      inDirective = true;
      continue;
    }
    const line = rawLine.replace(/%%.*$/, '').trim();
    if (line.length === 0) continue;
    for (const [pattern, kind] of HEADER_PATTERNS) {
      if (pattern.test(line)) {
        return kind;
      }
    }
    // First non-empty, non-comment line didn't match anything known.
    return 'unknown';
  }
  return 'unknown';
}
