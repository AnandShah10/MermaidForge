import { describe, it, expect } from 'vitest';
import { parseErDiagram } from '../src/core/parser/erParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isErDiagram } from '../src/core/diagram/types';

describe('parseErDiagram', () => {
  it('parses a one-to-many relationship with a label', () => {
    const diagram = parseErDiagram('erDiagram\nCUSTOMER ||--o{ ORDER : places');
    expect(diagram.entities.size).toBe(2);
    expect(diagram.relationships).toHaveLength(1);
    expect(diagram.relationships[0]).toMatchObject({
      from: 'CUSTOMER',
      to: 'ORDER',
      leftCardinality: '||',
      rightCardinality: 'o{',
      identifying: true,
      label: 'places',
    });
  });

  it('distinguishes identifying (solid) vs non-identifying (dashed) relationships', () => {
    const diagram = parseErDiagram('erDiagram\nA ||--|| B : solid\nA ||..|| C : dashed');
    expect(diagram.relationships[0].identifying).toBe(true);
    expect(diagram.relationships[1].identifying).toBe(false);
  });

  it('parses an entity attribute body with types and keys', () => {
    const diagram = parseErDiagram(`erDiagram
CUSTOMER {
  string name
  string custNumber PK
  string sector "optional"
}`);
    const customer = diagram.entities.get('CUSTOMER')!;
    expect(customer.attributes).toHaveLength(3);
    expect(customer.attributes[0]).toMatchObject({ type: 'string', name: 'name', key: null });
    expect(customer.attributes[1]).toMatchObject({ type: 'string', name: 'custNumber', key: 'PK' });
    expect(customer.attributes[2]).toMatchObject({ type: 'string', name: 'sector', comment: 'optional' });
  });

  it('handles entity ids containing hyphens', () => {
    const diagram = parseErDiagram('erDiagram\nORDER ||--|{ LINE-ITEM : contains');
    expect(diagram.entities.has('LINE-ITEM')).toBe(true);
  });

  it('parses a bare entity declaration with no attributes or relationships', () => {
    const diagram = parseErDiagram('erDiagram\nA ||--|| B : rel\nSTANDALONE');
    expect(diagram.entities.has('STANDALONE')).toBe(true);
  });

  it('flags an unclosed entity body', () => {
    const diagram = parseErDiagram('erDiagram\nCUSTOMER {\nstring name');
    expect(diagram.parseIssues.some((i) => /never closed/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseErDiagram('erDiagram\n@@@ garbage @@@\nA ||--|| B : x')).not.toThrow();
  });
});

describe('parseMermaid routes erDiagram to the structural parser', () => {
  it('produces an ErDiagram, not the light fallback', () => {
    const diagram = parseMermaid('erDiagram\nCUSTOMER ||--o{ ORDER : places');
    expect(isErDiagram(diagram)).toBe(true);
    if (isErDiagram(diagram)) {
      expect(diagram.relationships).toHaveLength(1);
    }
  });
});
