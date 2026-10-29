import { SourceRange, StyleDirectives } from '../diagram/types';

/**
 * Shared parsing of the flowchart-style styling statements that requirement
 * and block diagrams accept:
 *   classDef name css
 *   class a,b name        (targets comma-separated)
 *   style id css
 * `css` is kept as raw text; it is never interpreted.
 */
export function emptyStyling(): StyleDirectives {
  return { classDefs: [], classAssignments: [], styles: [] };
}

/** Returns true when the line was a styling statement (and records it). */
export function parseStylingLine(trimmed: string, range: SourceRange, into: StyleDirectives): boolean {
  let m: RegExpExecArray | null;
  if ((m = /^classDef\s+([\w-]+)\s*(.*)$/.exec(trimmed))) {
    into.classDefs.push({ name: m[1], css: m[2].trim(), sourceRange: range });
    return true;
  }
  if ((m = /^class\s+(\S+)\s+([\w-]+)\s*$/.exec(trimmed))) {
    into.classAssignments.push({ targets: m[1].split(',').filter(Boolean), className: m[2], sourceRange: range });
    return true;
  }
  if ((m = /^style\s+(\S+)\s*(.*)$/.exec(trimmed))) {
    into.styles.push({ target: m[1], css: m[2].trim(), sourceRange: range });
    return true;
  }
  return false;
}
