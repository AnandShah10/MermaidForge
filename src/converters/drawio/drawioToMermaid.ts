import { DrawioGraph } from './drawioParser';
import { ConversionError, ConversionResult, ConversionWarning } from '../converter';
import { parseDrawioXml } from './drawioParser';

/** Draw.io ids are often long GUID-like strings; sanitize to a short, Mermaid-safe, human-followable id. */
function sanitizeId(rawId: string, used: Set<string>, index: number): string {
  let base = rawId.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(base)) base = `n_${base}`;
  base = base.slice(0, 24) || `node`;
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  if (used.has(candidate)) candidate = `node_${index}`;
  used.add(candidate);
  return candidate;
}

function needsQuotes(label: string): boolean {
  return /[|"{}[\]()#;,\n]/.test(label);
}

function renderLabel(label: string): string {
  const singleLine = label.replace(/\n+/g, ' ').trim();
  if (!singleLine) return '';
  return needsQuotes(singleLine) ? `"${singleLine.replace(/"/g, '\\"')}"` : singleLine;
}

/**
 * Converts a parsed Draw.io graph into Mermaid flowchart source. This is a
 * structural best-effort translation, not a layout-preserving one: Draw.io
 * geometry (x/y/width/height) is intentionally not read, since Mermaid's own
 * layout engine decides positioning — carrying over Draw.io coordinates would
 * only produce a Mermaid diagram that fights its own renderer.
 */
export function drawioGraphToMermaid(graph: DrawioGraph): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();

  const vertices = graph.cells.filter((c) => c.isVertex);
  const edges = graph.cells.filter((c) => c.isEdge);

  vertices.forEach((cell, i) => {
    idMap.set(cell.id, sanitizeId(cell.id, usedIds, i));
  });

  const lines: string[] = ['flowchart TD'];
  let anonymousCounter = 0;

  for (const cell of vertices) {
    const id = idMap.get(cell.id)!;
    const label = renderLabel(cell.value) || id;
    lines.push(`  ${id}["${label.replace(/^"|"$/g, '')}"]`);
  }

  let skippedEdges = 0;
  for (const cell of edges) {
    if (!cell.source || !cell.target) {
      skippedEdges++;
      continue;
    }
    let sourceId = idMap.get(cell.source);
    let targetId = idMap.get(cell.target);
    if (!sourceId) {
      sourceId = `dangling_${anonymousCounter++}`;
      warnings.push({ message: `Edge referenced a shape (${cell.source}) that was not found as a vertex; inserted a placeholder node.`, severity: 'warning' });
    }
    if (!targetId) {
      targetId = `dangling_${anonymousCounter++}`;
      warnings.push({ message: `Edge referenced a shape (${cell.target}) that was not found as a vertex; inserted a placeholder node.`, severity: 'warning' });
    }
    const label = renderLabel(cell.value);
    lines.push(label ? `  ${sourceId} -->|${label}| ${targetId}` : `  ${sourceId} --> ${targetId}`);
  }

  if (skippedEdges > 0) {
    warnings.push({ message: `Skipped ${skippedEdges} connector(s) missing a source or target endpoint.`, severity: 'info' });
  }
  if (graph.extraPageCount > 0) {
    warnings.push({ message: `This file has ${graph.extraPageCount} additional page(s); only the first page was converted.`, severity: 'info' });
  }
  if (vertices.length === 0) {
    warnings.push({ message: 'No shapes were found — only connectors, if any, were converted.', severity: 'warning' });
  }

  return { ok: true, mermaid: lines.join('\n') + '\n', warnings };
}

/** End-to-end Draw.io XML source → Mermaid, matching the generic `Converter` shape. */
export function convertDrawioToMermaid(sourceXml: string): ConversionResult | ConversionError {
  const parsed = parseDrawioXml(sourceXml);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  return drawioGraphToMermaid(parsed.graph);
}
