import { describe, it, expect } from 'vitest';
import { buildDiagramContext } from '../src/ai/contextBuilder';

describe('buildDiagramContext', () => {
  it('omits diagram source when sendSourceContext is false', () => {
    const ctx = buildDiagramContext({ diagramSource: 'flowchart TD\nA-->B', sendSourceContext: false, maxContextTokens: 4000 });
    expect(ctx.diagramSource).toBe('');
    expect(ctx.disclosureText).toMatch(/disabled/i);
  });

  it('includes diagram source when enabled, with a disclosure', () => {
    const ctx = buildDiagramContext({ diagramSource: 'flowchart TD\nA-->B', sendSourceContext: true, maxContextTokens: 4000 });
    expect(ctx.diagramSource).toContain('A-->B');
    expect(ctx.disclosureText).toMatch(/current diagram source/i);
  });

  it('truncates source that exceeds the token budget', () => {
    const bigSource = 'flowchart TD\n' + Array.from({ length: 5000 }, (_, i) => `N${i}-->N${i + 1}`).join('\n');
    const ctx = buildDiagramContext({ diagramSource: bigSource, sendSourceContext: true, maxContextTokens: 100 });
    expect(ctx.diagramSource.length).toBeLessThan(bigSource.length);
    expect(ctx.diagramSource).toContain('[truncated');
  });
});
