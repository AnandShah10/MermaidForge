import { SourceRange } from '../diagram/types';

/** Shared helpers for the line-oriented parsers added after the first generation. */

export function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

export function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

/** Removes one pair of surrounding double (or single) quotes, if present. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Splits on `sep` outside double quotes and outside (), [], {} nesting.
 * Quotes may contain the separator and bracket characters.
 */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    if (!inQuote) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (c === sep && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Strict decimal parse: returns null for '', 'abc', '1e', '0x10' and similar. */
export function parseNumber(raw: string): number | null {
  const t = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
