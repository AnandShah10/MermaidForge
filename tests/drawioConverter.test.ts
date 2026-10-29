import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'zlib';
import { parseDrawioXml } from '../src/converters/drawio/drawioParser';
import { convertDrawioToMermaid } from '../src/converters/drawio/drawioToMermaid';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isFlowchart } from '../src/core/diagram/types';

const SAMPLE_UNCOMPRESSED = `<mxfile host="app.diagrams.net">
  <diagram id="page1" name="Page-1">
    <mxGraphModel dx="800" dy="600">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="A1" value="Client" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="A2" value="API Server" vertex="1" parent="1">
          <mxGeometry x="200" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="A3" value="Database" vertex="1" parent="1">
          <mxGeometry x="360" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="E1" value="" edge="1" source="A1" target="A2" parent="1">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="E2" value="query" edge="1" source="A2" target="A3" parent="1">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

const UNCOMPRESSED_GRAPH_MODEL = `<mxGraphModel dx="800" dy="600"><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="A1" value="Client" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry" /></mxCell><mxCell id="A2" value="API Server" vertex="1" parent="1"><mxGeometry x="200" y="40" width="120" height="60" as="geometry" /></mxCell><mxCell id="E1" value="calls" edge="1" source="A1" target="A2" parent="1"><mxGeometry relative="1" as="geometry" /></mxCell></root></mxGraphModel>`;

/** Compresses XML exactly the way Draw.io's app does by default: URI-encode, raw-deflate, base64. */
function compressLikeDrawio(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml), 'utf8')).toString('base64');
}

const SAMPLE_COMPRESSED = `<mxfile host="app.diagrams.net">
  <diagram id="page1" name="Page-1">${compressLikeDrawio(UNCOMPRESSED_GRAPH_MODEL)}</diagram>
</mxfile>`;

const SAMPLE_CORRUPT = `<mxfile host="app.diagrams.net">
  <diagram id="page1" name="Page-1">this-is-not-valid-base64-deflate-data!!!</diagram>
</mxfile>`;

describe('parseDrawioXml', () => {
  it('parses vertices and edges from uncompressed XML', () => {
    const result = parseDrawioXml(SAMPLE_UNCOMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.cells.filter((c) => c.isVertex)).toHaveLength(3);
      expect(result.graph.cells.filter((c) => c.isEdge)).toHaveLength(2);
    }
  });

  it('excludes the two mxGraphModel boilerplate root cells', () => {
    const result = parseDrawioXml(SAMPLE_UNCOMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.cells.some((c) => c.id === '0' || c.id === '1')).toBe(false);
    }
  });

  it('decompresses and parses a Draw.io-compressed diagram (the app default save format)', () => {
    const result = parseDrawioXml(SAMPLE_COMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.cells.filter((c) => c.isVertex)).toHaveLength(2);
      expect(result.graph.cells.filter((c) => c.isEdge)).toHaveLength(1);
    }
  });

  it('produces identical vertex labels from the compressed and uncompressed forms of the same diagram', () => {
    const compressed = parseDrawioXml(SAMPLE_COMPRESSED);
    expect(compressed.ok).toBe(true);
    if (compressed.ok) {
      const labels = compressed.graph.cells.filter((c) => c.isVertex).map((c) => c.value).sort();
      expect(labels).toEqual(['API Server', 'Client']);
    }
  });

  it('rejects genuinely corrupt/undecodable content with a clear, actionable message', () => {
    const result = parseDrawioXml(SAMPLE_CORRUPT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/could not be read|compressed/i);
      expect(result.reason).toMatch(/uncompressed/i);
    }
  });

  it('rejects content that is not a Draw.io file', () => {
    const result = parseDrawioXml('<svg><rect/></svg>');
    expect(result.ok).toBe(false);
  });
});

describe('convertDrawioToMermaid', () => {
  it('produces valid, parseable Mermaid flowchart source', () => {
    const result = convertDrawioToMermaid(SAMPLE_UNCOMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mermaid).toMatch(/^flowchart TD/);
      const diagram = parseMermaid(result.mermaid);
      expect(isFlowchart(diagram)).toBe(true);
      if (isFlowchart(diagram)) {
        expect(diagram.nodes.size).toBe(3);
        expect(diagram.edges).toHaveLength(2);
        expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
      }
    }
  });

  it('preserves vertex labels', () => {
    const result = convertDrawioToMermaid(SAMPLE_UNCOMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mermaid).toContain('Client');
      expect(result.mermaid).toContain('API Server');
      expect(result.mermaid).toContain('Database');
    }
  });

  it('carries an edge label through as an edge label', () => {
    const result = convertDrawioToMermaid(SAMPLE_UNCOMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mermaid).toContain('|query|');
    }
  });

  it('converts a compressed diagram end-to-end into valid Mermaid', () => {
    const result = convertDrawioToMermaid(SAMPLE_COMPRESSED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const diagram = parseMermaid(result.mermaid);
      expect(isFlowchart(diagram)).toBe(true);
      if (isFlowchart(diagram)) {
        expect(diagram.nodes.size).toBe(2);
        expect(diagram.edges).toHaveLength(1);
      }
    }
  });

  it('propagates a clear error for genuinely corrupt input rather than guessing', () => {
    const result = convertDrawioToMermaid(SAMPLE_CORRUPT);
    expect(result.ok).toBe(false);
  });

  it('warns about, rather than silently drops, edges with missing endpoints', () => {
    const xml = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="A" value="Only Node" vertex="1" parent="1"/>
      <mxCell id="E" edge="1" source="A" target="Ghost" parent="1"/>
    </root></mxGraphModel></diagram></mxfile>`;
    const result = convertDrawioToMermaid(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => /not found/.test(w.message))).toBe(true);
    }
  });
});
