import { describe, it, expect } from 'vitest';
import { formatRange } from '../src/core/formatter/formatRange';
import { formatMermaid } from '../src/core/formatter/formatter';

const opts = { indentSize: 2 };

describe('formatRange', () => {
  const seq = ['sequenceDiagram', '   A->>B: hi', '  loop every day', '       B->>A: ok', '  end', '      A->>B: bye  '].join('\n');

  it('formats only the selected lines, with indentation computed from the whole diagram', () => {
    const r = formatRange(seq, 3, 3, opts);
    expect(r.scope).toBe('selection');
    const lines = r.text.split('\n');
    expect(lines[3]).toBe('    B->>A: ok'); // inside the loop => two levels
    expect(lines[1]).toBe('   A->>B: hi'); // untouched
    expect(lines[5]).toBe('      A->>B: bye  ');
  });

  it('a selection over everything equals whole-diagram formatting', () => {
    expect(formatRange(seq, 0, 5, opts).text).toBe(formatMermaid(seq, opts));
  });

  it('falls back to the whole diagram when formatting changes the line count (flowcharts)', () => {
    const flow = 'flowchart TD\n  A-->B\n  A-->C\n  B-->D';
    const whole = formatMermaid(flow, opts);
    const r = formatRange(flow, 1, 1, opts);
    if (whole.split('\n').length !== flow.split('\n').length) expect(r.scope).toBe('diagram');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('clamps out-of-range lines', () => {
    expect(() => formatRange(seq, -3, 99, opts)).not.toThrow();
  });
});
