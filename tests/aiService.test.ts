import { describe, it, expect } from 'vitest';
import { parseStructuredResponse } from '../src/ai/service';

describe('parseStructuredResponse', () => {
  it('parses strict JSON', () => {
    const raw = JSON.stringify({ action: 'generate', explanation: 'ok', mermaid: 'flowchart TD\nA-->B', warnings: [] });
    const result = parseStructuredResponse(raw);
    expect(result.mermaid).toBe('flowchart TD\nA-->B');
    expect(result.explanation).toBe('ok');
  });

  it('extracts JSON from a fenced code block', () => {
    const raw = '```json\n{"action":"modify","explanation":"changed it","mermaid":"flowchart TD\\nA-->B","warnings":[]}\n```';
    const result = parseStructuredResponse(raw);
    expect(result.action).toBe('modify');
    expect(result.mermaid).toBe('flowchart TD\nA-->B');
  });

  it('falls back to a fenced mermaid block when JSON parsing fails', () => {
    const raw = 'Here is your diagram:\n```mermaid\nflowchart TD\nA-->B\n```\nLet me know if you want changes.';
    const result = parseStructuredResponse(raw);
    expect(result.mermaid).toBe('flowchart TD\nA-->B');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('never throws on garbage input', () => {
    expect(() => parseStructuredResponse('not json, not fenced, just text')).not.toThrow();
    const result = parseStructuredResponse('not json, not fenced, just text');
    expect(result.mermaid).toBe('');
  });

  it('ignores non-string warnings entries defensively', () => {
    const raw = JSON.stringify({ action: 'x', explanation: 'e', mermaid: '', warnings: [1, 'ok', null] });
    const result = parseStructuredResponse(raw);
    expect(result.warnings).toEqual(['ok']);
  });
});
