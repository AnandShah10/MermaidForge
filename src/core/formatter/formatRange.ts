import { FormatterOptions, formatMermaid } from './formatter';

export interface RangeFormatResult {
  text: string;
  /** `selection`: only the requested lines changed. `diagram`: the whole diagram was reformatted (see formatRange). */
  scope: 'selection' | 'diagram';
}

/**
 * Formats part of a diagram. Indentation depends on the lines above (a block opened earlier), so the whole diagram is
 * formatted first and then only the requested lines are taken from the result. That is possible whenever formatting
 * leaves the line count alone (every kind except flowcharts, whose formatter re-renders the model: it can merge or
 * split statements). For those the whole diagram is reformatted and `scope` says so, so callers can tell the user.
 * Lines are 0-based and inclusive.
 */
export function formatRange(source: string, startLine: number, endLine: number, options: FormatterOptions): RangeFormatResult {
  const original = source.replace(/\r\n/g, '\n').split('\n');
  const formatted = formatMermaid(source, options);
  const after = formatted.replace(/\r\n/g, '\n').split('\n');
  if (after.length !== original.length) return { text: formatted, scope: 'diagram' };
  const from = Math.max(0, Math.min(startLine, original.length - 1));
  const to = Math.max(from, Math.min(endLine, original.length - 1));
  const merged = [...original.slice(0, from), ...after.slice(from, to + 1), ...original.slice(to + 1)];
  return { text: merged.join('\n'), scope: 'selection' };
}
